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
 *    document (see {@link EurLexContentService.assembleFormexParts}); assembly is
 *    best-effort and falls back to unavailable if any part cannot be fetched.
 *  - `Accept-Language`: CELLAR requires an ISO 639-2/T (three-letter) code and
 *    400s on a missing one or on a bibliographic 639-2/B code (`ger`, `fre`);
 *    EUR-Lex two-letter codes are mapped before the request.
 *
 * Defense in depth: any response carrying an AWS WAF challenge signature is
 * refused (never surfaced as content) and raised as a ServiceUnavailable error,
 * so a challenge stub can never again be reported as `contentAvailable: true`.
 * @module services/eurlex-content/eurlex-content-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { withRetry } from '@cyanheads/mcp-ts-core/utils';
import type { ServerConfig } from '@/config/server-config.js';
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
export type EurLexLanguage =
  | 'EN'
  | 'FR'
  | 'DE'
  | 'ES'
  | 'IT'
  | 'PL'
  | 'PT'
  | 'NL'
  | 'CS'
  | 'DA'
  | 'EL'
  | 'ET'
  | 'FI'
  | 'HU'
  | 'LT'
  | 'LV'
  | 'MT'
  | 'RO'
  | 'SK'
  | 'SL'
  | 'SV'
  | 'BG'
  | 'HR'
  | 'GA';

/**
 * Map EUR-Lex two-letter language codes to the ISO 639-2/T (terminological,
 * three-letter) codes CELLAR's content-negotiation resolver accepts in
 * `Accept-Language`. CELLAR rejects bibliographic 639-2/B codes (`ger`, `fre`,
 * `dut`, …), so the terminological forms (`deu`, `fra`, `nld`, …) are used.
 */
const LANGUAGE_TO_ISO_639_2: Record<EurLexLanguage, string> = {
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
 * Render a fetched wire body into the requested output format. `html`/`xml` pass
 * through verbatim; `markdown` is converted server-side from the HTML body.
 */
function renderContent(body: string, format: ContentFormat): string {
  return format === 'markdown' ? htmlToMarkdown(body) : body;
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

/**
 * Combine fetched Formex part bodies into one well-formed XML document. A
 * multi-part act has no canonical single-file form — CELLAR serves the parts as
 * independent streams (a `<BIB.DOC>`/`<DOC>` notice header plus the `<ACT>`
 * body), each its own document with its own prolog. Concatenating them verbatim
 * would yield multiple prologs and roots (not parseable), so each part's prolog
 * is stripped and the roots are wrapped in one synthetic container — preserving
 * every part verbatim and in order while keeping the result a single document the
 * caller can parse for structured processing.
 */
function combineFormexParts(parts: readonly string[]): string {
  const children = parts.map((part) => part.replace(/^\s*<\?xml[^>]*\?>\s*/i, '').trim());
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Assembled by eur-lex-mcp-server from multi-part Formex 4 streams (CELLAR returned HTTP 300 Multiple Choices). Each child is one part root, in stream order. -->
<formex-multipart parts="${parts.length}">
${children.join('\n')}
</formex-multipart>`;
}

/**
 * Outcome of a single content-negotiation attempt. `multipart` carries the CELLAR
 * "300 Multiple Choices" index body listing the sibling Formex part URLs — only
 * the `application/xml;type=fmx4` variant ever produces it.
 */
type FetchOutcome =
  | { kind: 'content'; text: string }
  | { kind: 'none' }
  | { kind: 'challenge' }
  | { kind: 'multipart'; body: string };

export interface FetchContentResult {
  content: string;
  contentAvailable: boolean;
  format: ContentFormat;
  language: EurLexLanguage;
  /** Set when a language fallback occurred. */
  languageFallback?: string;
}

export class EurLexContentService {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

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
   * Returns `contentAvailable: false` with an empty string if both attempts fail.
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
    // `markdown` is rendered from the HTML body, so it is fetched as HTML; the
    // returned `format` still reports `markdown` and `renderContent` converts.
    const wireFormat: WireFormat = format === 'markdown' ? 'html' : format;

    const primary = await this.fetchForLanguage(celexNumber, language, wireFormat, ctx);
    if (primary !== null) {
      return { content: renderContent(primary, format), language, format, contentAvailable: true };
    }

    // Language fallback: try English if primary language failed.
    if (language !== 'EN') {
      const fallback = await this.fetchForLanguage(celexNumber, 'EN', wireFormat, ctx);
      if (fallback !== null) {
        return {
          content: renderContent(fallback, format),
          language: 'EN',
          format,
          contentAvailable: true,
          languageFallback: `Requested language ${language} unavailable; returned English content.`,
        };
      }
    }

    return { content: '', language, format, contentAvailable: false };
  }

  /**
   * Resolve content for one language by trying each `Accept` variant for the
   * format. Returns the first non-empty body, or null when none of the variants
   * yield content (so the caller can fall back to English). Throws when a variant
   * returns a bot-challenge stub.
   */
  private async fetchForLanguage(
    celexNumber: string,
    language: EurLexLanguage,
    format: WireFormat,
    ctx: Context,
  ): Promise<string | null> {
    const isoLanguage = LANGUAGE_TO_ISO_639_2[language];
    if (!isoLanguage) return null;

    const url = this.buildContentUrl(celexNumber);
    for (const accept of ACCEPT_BY_FORMAT[format]) {
      const outcome = await this.fetchUrl(url, accept, isoLanguage, ctx);
      if (outcome.kind === 'challenge') {
        throw serviceUnavailable(
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
      // A 300 (multi-part Formex, xml path only): follow the sibling part
      // references and assemble the full act. Assembly is best-effort — on
      // failure fall through so the variant loop ends in `null` (unavailable),
      // never a throw.
      if (outcome.kind === 'multipart') {
        const assembled = await this.assembleFormexParts(outcome.body, accept, isoLanguage, ctx);
        if (assembled !== null) return assembled;
        continue;
      }
      if (outcome.kind === 'content') return outcome.text;
    }
    return null;
  }

  /**
   * Single content-negotiation GET for one URL / `Accept` / `Accept-Language`.
   * A 300 (Multiple Choices — multi-part Formex, xml path only) resolves to
   * `multipart` carrying the index body; other non-2xx (404 = no datastream of
   * that type, 4xx/5xx) and network failures resolve to `none` so callers can
   * try the next variant or language; a WAF challenge body resolves to
   * `challenge`. The inner function only throws on a `fetch` rejection, so
   * `withRetry` retries transient network errors but never a 300, 404, or a
   * challenge.
   */
  private fetchUrl(
    url: string,
    accept: string,
    isoLanguage: string,
    ctx: Context,
  ): Promise<FetchOutcome> {
    return withRetry(
      async (): Promise<FetchOutcome> => {
        const response = await fetch(url, {
          headers: { Accept: accept, 'Accept-Language': isoLanguage },
          signal: AbortSignal.timeout(this.timeoutMs),
          redirect: 'follow',
        });

        if (response.status === 300) return { kind: 'multipart', body: await response.text() };
        if (!response.ok) return { kind: 'none' };

        const text = await response.text();
        if (isChallengeResponse(text)) return { kind: 'challenge' };
        if (text.trim().length < MIN_CONTENT_LENGTH) return { kind: 'none' };
        return { kind: 'content', text };
      },
      {
        operation: 'EurLexContentService.fetchUrl',
        baseDelayMs: 1000,
        maxRetries: 2,
        signal: ctx.signal,
      },
    ).catch((): FetchOutcome => ({ kind: 'none' }));
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
    return combineFormexParts(parts);
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
