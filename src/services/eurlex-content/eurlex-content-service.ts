/**
 * @fileoverview EurLexContentService — HTTP client for EU act full-text content.
 *
 * Sources content from the EU Publications Office CELLAR content-negotiation
 * resolver (`publications.europa.eu/resource/celex/{CELEX}`) — the same host the
 * metadata SPARQL pipeline already queries — rather than the legacy
 * `eur-lex.europa.eu` legal-content endpoint, which is now fronted by an AWS WAF
 * that returns a JavaScript bot-challenge stub instead of the act text (issue #16).
 *
 * Content negotiation:
 *  - `Accept`: HTML acts vary by document family — OJ legislation exposes
 *    `application/xhtml+xml`, CJEU judgments expose `text/html`, so the HTML path
 *    tries both. The XML path requests Formex 4 (`application/xml;type=fmx4`),
 *    which CELLAR serves directly for single-part acts and returns HTTP 300
 *    (Multiple Choices) for multi-part OJ acts — a small `<BIB.DOC>`/`<DOC>`
 *    notice header plus the `<ACT>` body split across sibling streams. The XML
 *    path follows those sibling references and concatenates the parts into one
 *    document (see {@link EurLexContentService.assembleFormexParts}). Acts CELLAR
 *    holds only as a zipped Formex package answer that variant with 404; the XML
 *    path then requests `application/zip;mtype=fmx4` and assembles the package's
 *    `<DOC>` manifest and the parts it names, in manifest order, into the same
 *    wrapper (#108, see `formex-package.ts`). Both assemblies are best-effort and
 *    fall back to unavailable (`multipart_incomplete`) if any part cannot be read.
 *  - `Accept-Language`: CELLAR requires an ISO 639-2/T (three-letter) code and
 *    400s on a missing one or on a bibliographic 639-2/B code (`ger`, `fre`);
 *    EUR-Lex two-letter codes are mapped before the request.
 *
 * Defense in depth: any response carrying an AWS WAF challenge signature is
 * refused (never surfaced as content) and raised as a ServiceUnavailable error,
 * so a challenge stub can never again be reported as `contentAvailable: true`.
 *
 * Served bodies are cached in process (#127, #129) — keyed by CELEX, requested
 * language, and format, one hour each, 16 million characters in all — so paging
 * a large act fetches and converts it once rather than on every page.
 * @module services/eurlex-content/eurlex-content-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { withRetry } from '@cyanheads/mcp-ts-core/utils';
import type { ServerConfig } from '@/config/server-config.js';
import { type ActHeading, parseDocumentStructure } from './act-structure.js';
import { readFormexPackage } from './formex-package.js';
import { htmlToMarkdown } from './html-to-markdown.js';

/**
 * Output formats a caller can request. `markdown` is not served by EUR-Lex — it is
 * rendered server-side from the HTML body (see {@link WireFormat}).
 */
export type ContentFormat = 'html' | 'xml' | 'markdown';

/**
 * Formats actually negotiated over the wire from CELLAR. `markdown` maps to `html`
 * (the act is fetched as HTML, then converted); it is never requested directly.
 */
type WireFormat = 'html' | 'xml';

/** Language codes supported by EUR-Lex (24 official EU languages). */
export const EURLEX_LANGUAGES = [
  'EN',
  'FR',
  'DE',
  'ES',
  'IT',
  'PL',
  'PT',
  'NL',
  'CS',
  'DA',
  'EL',
  'ET',
  'FI',
  'HU',
  'LT',
  'LV',
  'MT',
  'RO',
  'SK',
  'SL',
  'SV',
  'BG',
  'HR',
  'GA',
] as const;

export type EurLexLanguage = (typeof EURLEX_LANGUAGES)[number];

/** Why an ordinary content fetch completed without a usable body. */
export type ContentUnavailabilityReason =
  | 'no_representation'
  | 'upstream_failure'
  | 'multipart_incomplete';

/**
 * Map EUR-Lex two-letter language codes to the ISO 639-2/T (terminological,
 * three-letter) codes CELLAR's content-negotiation resolver accepts in
 * `Accept-Language`. CELLAR rejects bibliographic 639-2/B codes (`ger`, `fre`,
 * `dut`, …), so the terminological forms (`deu`, `fra`, `nld`, …) are used. Upper-
 * cased, each is also the code of CELLAR's language authority table (`FRA`), which
 * eurlex_get_document reads an expression title by.
 */
export const LANGUAGE_TO_ISO_639_2: Record<EurLexLanguage, string> = {
  EN: 'eng',
  FR: 'fra',
  DE: 'deu',
  ES: 'spa',
  IT: 'ita',
  PL: 'pol',
  PT: 'por',
  NL: 'nld',
  CS: 'ces',
  DA: 'dan',
  EL: 'ell',
  ET: 'est',
  FI: 'fin',
  HU: 'hun',
  LT: 'lit',
  LV: 'lav',
  MT: 'mlt',
  RO: 'ron',
  SK: 'slk',
  SL: 'slv',
  SV: 'swe',
  BG: 'bul',
  HR: 'hrv',
  GA: 'gle',
};

/**
 * `Accept` values tried per format, in order. HTML resolves to `application/xhtml+xml`
 * for OJ legislation and `text/html` for CJEU judgments; the first to return a body
 * wins. XML requests Formex 4 only.
 */
const ACCEPT_BY_FORMAT: Record<WireFormat, readonly string[]> = {
  html: ['application/xhtml+xml', 'text/html'],
  xml: ['application/xml;type=fmx4'],
};

/**
 * The zipped Formex package (#108): requested only after the Formex variant
 * answered 404, since acts CELLAR serves as XML or a 300 index never need it.
 */
const FORMEX_PACKAGE_ACCEPT = 'application/zip;mtype=fmx4';

/** How long a served body stays cached (#127): CELLAR text per CELEX is effectively immutable. */
const BODY_CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * Most characters the body cache retains across all entries (#127). An engine
 * string holds one or two bytes per character, so this bounds the cached text at
 * 32 MB; an entry larger than the cap on its own is not stored.
 */
const BODY_CACHE_MAX_CHARS = 16_000_000;

/**
 * An available body as a call serves it: the text in the requested format, the
 * language it was served in, and for Markdown the heading list read once against
 * the HTML it was rendered from. The HTML itself is never kept.
 */
interface ServedBody {
  content: string;
  headings?: ActHeading[];
  language: EurLexLanguage;
  languageFallback?: string;
}

/**
 * Render a fetched wire body into the requested output format. `html`/`xml` pass
 * through verbatim; `markdown` is converted server-side from the HTML body, and its
 * headings are parsed then, while the HTML is at hand to tell an act's own
 * headings from the ones it quotes (#106) and to find a case-law body's section
 * headings, whose markup the conversion drops (#117). The CELEX picks the parser,
 * and it keys the cache entry, so a cached heading list is always that parser's.
 */
function renderBody(
  celexNumber: string,
  wire: string,
  format: ContentFormat,
  language: EurLexLanguage,
  languageFallback: string | undefined,
): ServedBody {
  const fallback = languageFallback ? { languageFallback } : {};
  if (format !== 'markdown') return { content: wire, language, ...fallback };
  const content = htmlToMarkdown(wire);
  const headings = parseDocumentStructure(celexNumber, content, 'markdown', language, wire);
  return { content, headings, language, ...fallback };
}

/** Characters an entry retains: its text, fallback note, and heading strings. */
function retainedChars(body: ServedBody): number {
  let chars = body.content.length + (body.languageFallback?.length ?? 0);
  for (const h of body.headings ?? []) {
    chars += h.label.length + h.number.length + (h.title?.length ?? 0);
  }
  return chars;
}

/**
 * In-process LRU of served bodies (#127, #129), shared by every caller: act text
 * is public and the same for each tenant, so this is not `ctx.state`. Entries
 * expire after {@link BODY_CACHE_TTL_MS}, and the least recently used are evicted
 * to keep retained characters within {@link BODY_CACHE_MAX_CHARS}. Only completed
 * calls store, and there is no in-flight sharing, so a cold fetch runs under its
 * own caller's signal alone.
 */
class BodyCache {
  private readonly entries = new Map<
    string,
    { body: ServedBody; chars: number; expiresAt: number }
  >();
  private retained = 0;

  get(key: string): ServedBody | undefined {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.remove(key);
    if (entry.expiresAt <= Date.now()) return;
    this.entries.set(key, entry);
    this.retained += entry.chars;
    return entry.body;
  }

  set(key: string, body: ServedBody): void {
    this.remove(key);
    const chars = retainedChars(body);
    if (chars > BODY_CACHE_MAX_CHARS) return;
    const now = Date.now();
    for (const [stale, entry] of this.entries) {
      if (entry.expiresAt <= now) this.remove(stale);
    }
    for (const oldest of this.entries.keys()) {
      if (this.retained + chars <= BODY_CACHE_MAX_CHARS) break;
      this.remove(oldest);
    }
    this.entries.set(key, { body, chars, expiresAt: now + BODY_CACHE_TTL_MS });
    this.retained += chars;
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.retained -= entry.chars;
  }
}

/** A call's result from a served body, its heading list copied so no caller shares the cached one. */
function servedResult(body: ServedBody, format: ContentFormat): FetchContentResult {
  return {
    content: body.content,
    contentAvailable: true,
    format,
    language: body.language,
    ...(body.languageFallback ? { languageFallback: body.languageFallback } : {}),
    ...(body.headings ? { headings: body.headings.map((h) => ({ ...h })) } : {}),
  };
}

/**
 * AWS WAF bot-challenge signatures. `awswaf` matches the challenge.js host
 * (`token.awswaf.com`), the cookie-domain list, and the `AwsWafIntegration`
 * calls; `gokuprops` matches the per-request challenge blob. Both are
 * WAF-specific and never appear in legitimate EU legal text. Matched
 * case-insensitively against the response head.
 */
const CHALLENGE_MARKERS = ['awswaf', 'gokuprops'];

/** Bodies shorter than this (after trimming) are treated as empty/unavailable. */
const MIN_CONTENT_LENGTH = 100;

/** True when a response body carries an AWS WAF bot-challenge signature. */
function isChallengeResponse(body: string): boolean {
  const head = body.slice(0, 4096).toLowerCase();
  return CHALLENGE_MARKERS.some((marker) => head.includes(marker));
}

/**
 * Trailing `DOC_<n>` sequence number of a CELLAR part URL — the multi-part
 * stream order. Returns `+∞` for a URL without one so unnumbered links sort last
 * while keeping their relative order.
 */
function docSequence(url: string): number {
  const match = url.match(/\/DOC[_-]?(\d+)/i);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

/**
 * Parse the sibling part URLs from a CELLAR "300 Multiple Choices" index body.
 * The index is an XHTML list where each part is an `<a href="…/DOC_N">` link, so
 * the `href` attributes pointing at `/resource/` streams are the part URLs. They
 * are de-duplicated and ordered by their `DOC_<n>` sequence.
 */
function extractFormexPartUrls(indexBody: string): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const match of indexBody.matchAll(/href="([^"]+)"/gi)) {
    const raw = match[1];
    if (!raw) continue;
    const url = raw.replace(/&amp;/g, '&');
    if (url.includes('/resource/') && !seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  return urls.sort((a, b) => docSequence(a) - docSequence(b));
}

/** Where an assembled act's parts came from, as the wrapper's comment states it. */
const FORMEX_SOURCE_NOTE = {
  streams:
    'multi-part Formex 4 streams (CELLAR returned HTTP 300 Multiple Choices). Each child is one part root, in stream order.',
  package:
    'a zipped Formex 4 package (application/zip;mtype=fmx4). The first child is the package manifest, followed by each part it names, in manifest order.',
} as const;

/**
 * Combine Formex part bodies into one well-formed XML document. A multi-part act
 * has no canonical single-file form — CELLAR serves the parts as independent
 * streams behind an HTTP 300 index, or as files in a zipped package (#108): a
 * `<DOC>` notice/manifest plus the `<ACT>` body and any `<ANNEX>` parts, each its
 * own document with its own prolog. Concatenating them verbatim would yield
 * multiple prologs and roots (not parseable), so each part's prolog is stripped
 * and the roots are wrapped in one synthetic container — preserving every part
 * verbatim and in order while keeping the result a single document the caller
 * can parse for structured processing.
 */
function combineFormexParts(
  parts: readonly string[],
  source: keyof typeof FORMEX_SOURCE_NOTE,
): string {
  const children = parts.map((part) => part.replace(/^\s*<\?xml[^>]*\?>\s*/i, '').trim());
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Assembled by eur-lex-mcp-server from ${FORMEX_SOURCE_NOTE[source]} -->
<formex-multipart parts="${parts.length}">
${children.join('\n')}
</formex-multipart>`;
}

/** The unrecoverable refusal of a WAF challenge in place of the act text (#16). */
function contentChallenge(celexNumber: string) {
  return serviceUnavailable(
    `The EU content endpoint returned a bot-challenge interstitial instead of the act text for CELEX ${celexNumber}.`,
    {
      celexNumber,
      reason: 'content_challenge',
      recovery: {
        hint: 'The content host is behind a WAF/bot challenge. Retry shortly; metadata remains reachable via content_mode "metadata_only". A persistent challenge means EURLEX_CONTENT_BASE_URL points at a WAF-protected host rather than the EU Publications Office CELLAR resolver.',
      },
    },
  );
}

/**
 * Outcome of a single content-negotiation attempt. `multipart` carries the CELLAR
 * "300 Multiple Choices" index body listing the sibling Formex part URLs — only
 * the `application/xml;type=fmx4` variant ever produces it. `package` carries the
 * raw bytes of a 2xx answer to the zipped-package variant, zip or not (#108).
 */
type FetchOutcome =
  | { kind: 'content'; text: string }
  | { kind: 'no_representation' }
  | { kind: 'upstream_failure' }
  | { kind: 'challenge' }
  | { kind: 'multipart'; body: string }
  | { kind: 'package'; bytes: Uint8Array };

type LanguageFetchOutcome =
  | { kind: 'content'; text: string }
  | { kind: 'unavailable'; reason: ContentUnavailabilityReason };

const UNAVAILABILITY_PRIORITY: Record<ContentUnavailabilityReason, number> = {
  no_representation: 0,
  upstream_failure: 1,
  multipart_incomplete: 2,
};

/** Keep the most specific/actionable cause observed across variants and fallback attempts. */
function combineUnavailabilityReasons(
  left: ContentUnavailabilityReason,
  right: ContentUnavailabilityReason,
): ContentUnavailabilityReason {
  return UNAVAILABILITY_PRIORITY[right] > UNAVAILABILITY_PRIORITY[left] ? right : left;
}

export interface FetchContentResult {
  content: string;
  contentAvailable: boolean;
  format: ContentFormat;
  /**
   * Headings of an available `markdown` body, parsed against the wire HTML it was
   * rendered from: the conversion drops the table layout that tells an act's own
   * headings from the ones it quotes (#106) and the markup that marks a case-law
   * body's sections (#117), and that HTML is not kept (#127).
   */
  headings?: ActHeading[];
  language: EurLexLanguage;
  /** Set when a language fallback occurred. */
  languageFallback?: string;
  /** Set when contentAvailable is false. */
  unavailabilityReason?: ContentUnavailabilityReason;
}

export class EurLexContentService {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly cache = new BodyCache();

  constructor(_config: AppConfig, _storage: StorageService, serverConfig: ServerConfig) {
    this.baseUrl = serverConfig.eurLexContentBaseUrl.replace(/\/$/, '');
    this.timeoutMs = serverConfig.sparqlQueryTimeoutMs;
  }

  /**
   * Build the CELLAR content-negotiation URL for a CELEX number.
   * Pattern: /resource/celex/{CELEX} (format + language come from request headers).
   */
  buildContentUrl(celexNumber: string): string {
    return `${this.baseUrl}/resource/celex/${encodeURIComponent(celexNumber)}`;
  }

  /**
   * Fetch the full text content of an EU act by CELEX number.
   * If the requested language is unavailable, falls back to English.
   * Returns `contentAvailable: false` with an empty string and a classified
   * unavailability reason if both attempts fail ordinarily.
   *
   * An available body is cached by CELEX, requested language, and format (#127,
   * #129), so paging it costs one fetch and one conversion; the same string is
   * served each time, so offsets measured on one page hold on the next.
   *
   * Throws ServiceUnavailable if the content host returns an AWS WAF bot-challenge
   * stub — a challenge is never reported as available content.
   */
  async fetchContent(
    celexNumber: string,
    language: EurLexLanguage,
    format: ContentFormat,
    ctx: Context,
  ): Promise<FetchContentResult> {
    const key = `${celexNumber}|${language}|${format}`;
    const cached = this.cache.get(key);
    if (cached) return servedResult(cached, format);

    // `markdown` is rendered from the HTML body, so it is fetched as HTML; the
    // returned `format` still reports `markdown` and `renderBody` converts.
    const wireFormat: WireFormat = format === 'markdown' ? 'html' : format;
    const serve = (text: string, served: EurLexLanguage, languageFallback?: string) => {
      const body = renderBody(celexNumber, text, format, served, languageFallback);
      if (!ctx.signal.aborted) this.cache.set(key, body);
      return servedResult(body, format);
    };

    const primary = await this.fetchForLanguage(celexNumber, language, wireFormat, ctx);
    if (primary.kind === 'content') return serve(primary.text, language);

    // Language fallback: try English if primary language failed.
    if (language !== 'EN') {
      const fallback = await this.fetchForLanguage(celexNumber, 'EN', wireFormat, ctx);
      if (fallback.kind === 'content') {
        return serve(
          fallback.text,
          'EN',
          `Requested language ${language} unavailable; returned English content.`,
        );
      }
      return {
        content: '',
        language,
        format,
        contentAvailable: false,
        unavailabilityReason: combineUnavailabilityReasons(primary.reason, fallback.reason),
      };
    }

    return {
      content: '',
      language,
      format,
      contentAvailable: false,
      unavailabilityReason: primary.reason,
    };
  }

  /**
   * Resolve content for one language by trying each `Accept` variant for the
   * format, then, for xml whose Formex variant answered 404, the zipped package
   * (#108). Returns the first non-empty body, or a classified unavailable result
   * when none of the variants yield content (so the caller can fall back to
   * English). Throws when a primary variant — the package request included —
   * returns a bot-challenge stub.
   */
  private async fetchForLanguage(
    celexNumber: string,
    language: EurLexLanguage,
    format: WireFormat,
    ctx: Context,
  ): Promise<LanguageFetchOutcome> {
    const isoLanguage = LANGUAGE_TO_ISO_639_2[language];

    const url = this.buildContentUrl(celexNumber);
    let reason: ContentUnavailabilityReason = 'no_representation';
    for (const accept of ACCEPT_BY_FORMAT[format]) {
      const outcome = await this.fetchUrl(url, accept, isoLanguage, ctx);
      if (outcome.kind === 'challenge') throw contentChallenge(celexNumber);
      // A 300 (multi-part Formex, xml path only): follow the sibling part
      // references and assemble the full act. Assembly is best-effort — on
      // failure falls through so the variant loop ends as unavailable, never a
      // throw.
      if (outcome.kind === 'multipart') {
        const assembled = await this.assembleFormexParts(outcome.body, accept, isoLanguage, ctx);
        if (assembled !== null) return { kind: 'content', text: assembled };
        reason = combineUnavailabilityReasons(reason, 'multipart_incomplete');
        continue;
      }
      if (outcome.kind === 'content') return outcome;
      if (outcome.kind === 'upstream_failure') {
        reason = combineUnavailabilityReasons(reason, 'upstream_failure');
      }
    }
    if (format !== 'xml' || reason !== 'no_representation') return { kind: 'unavailable', reason };

    // Every Formex variant answered 404: the act may exist only as a zipped
    // package (#108). Its assembly is best-effort like the 300 path's.
    const outcome = await this.fetchUrl(url, FORMEX_PACKAGE_ACCEPT, isoLanguage, ctx);
    switch (outcome.kind) {
      case 'challenge':
        throw contentChallenge(celexNumber);
      case 'package': {
        const parts = readFormexPackage(outcome.bytes);
        return parts
          ? { kind: 'content', text: combineFormexParts(parts, 'package') }
          : { kind: 'unavailable', reason: 'multipart_incomplete' };
      }
      case 'no_representation':
      case 'upstream_failure':
        return { kind: 'unavailable', reason: outcome.kind };
      default:
        // A 300 index answering the package request: a representation, not one to read.
        return { kind: 'unavailable', reason: 'multipart_incomplete' };
    }
  }

  /**
   * Single content-negotiation GET for one URL / `Accept` / `Accept-Language`.
   * A 300 (Multiple Choices — multi-part Formex, xml path only) resolves to
   * `multipart` carrying the index body. A 2xx answer to the zipped-package
   * variant resolves to `package` carrying its bytes, read as bytes rather than
   * text, unless its head carries a WAF challenge (#108). A 404 or short body
   * resolves to `no_representation`; other non-2xx and exhausted network failures
   * resolve to `upstream_failure`, so callers can try the next variant or
   * language. A WAF challenge body resolves to `challenge`. The inner function
   * only throws on a `fetch` rejection, so `withRetry` retries transient network
   * errors but never a 300, 404, or challenge. Each attempt's fetch is bound to
   * the caller's signal, and a rejection after it aborted is rethrown rather than
   * degraded, so cancellation surfaces as `RequestCancelled`.
   */
  private fetchUrl(
    url: string,
    accept: string,
    isoLanguage: string,
    ctx: Context,
  ): Promise<FetchOutcome> {
    return withRetry(
      async ({ signal }): Promise<FetchOutcome> => {
        const response = await fetch(url, {
          headers: { Accept: accept, 'Accept-Language': isoLanguage },
          signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
          redirect: 'follow',
        });

        if (accept === FORMEX_PACKAGE_ACCEPT && response.ok) {
          const bytes = new Uint8Array(await response.arrayBuffer());
          const head = new TextDecoder().decode(bytes.subarray(0, 4096));
          return isChallengeResponse(head) ? { kind: 'challenge' } : { kind: 'package', bytes };
        }
        const text = await response.text();
        if (isChallengeResponse(text)) return { kind: 'challenge' };
        if (response.status === 300) return { kind: 'multipart', body: text };
        if (response.status === 404) return { kind: 'no_representation' };
        if (!response.ok) return { kind: 'upstream_failure' };

        if (text.trim().length < MIN_CONTENT_LENGTH) return { kind: 'no_representation' };
        return { kind: 'content', text };
      },
      {
        operation: 'EurLexContentService.fetchUrl',
        baseDelayMs: 1000,
        maxRetries: 2,
        signal: ctx.signal,
      },
    ).catch((error: unknown): FetchOutcome => {
      if (ctx.signal.aborted) throw error;
      return { kind: 'upstream_failure' };
    });
  }

  /**
   * Reconstruct a multi-part Formex act from a CELLAR "300 Multiple Choices"
   * index. Discovers the sibling part URLs, fetches each with the same Formex
   * `Accept`/`Accept-Language` used for the act, and concatenates them in stream
   * order. Best-effort: no discoverable parts, or any part that does not return a
   * body, yields `null` so the caller falls back to `contentAvailable: false`.
   * Never throws — a challenge or error mid-assembly is treated as failure, not
   * surfaced (unlike the primary fetch, which throws on a challenge).
   */
  private async assembleFormexParts(
    indexBody: string,
    accept: string,
    isoLanguage: string,
    ctx: Context,
  ): Promise<string | null> {
    const partUrls = extractFormexPartUrls(indexBody);
    if (partUrls.length === 0) return null;

    const outcomes = await Promise.all(
      partUrls.map((partUrl) => this.fetchUrl(partUrl, accept, isoLanguage, ctx)),
    );
    const parts: string[] = [];
    for (const outcome of outcomes) {
      if (outcome.kind !== 'content') return null;
      parts.push(outcome.text);
    }
    return combineFormexParts(parts, 'streams');
  }
}

// --- Init/accessor pattern ---

let _service: EurLexContentService | undefined;

export function initEurLexContentService(
  config: AppConfig,
  storage: StorageService,
  serverConfig: ServerConfig,
): void {
  _service = new EurLexContentService(config, storage, serverConfig);
}

export function getEurLexContentService(): EurLexContentService {
  if (!_service) {
    throw new Error(
      'EurLexContentService not initialized — call initEurLexContentService() in setup()',
    );
  }
  return _service;
}
