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
 *    (multiple manifestation streams) for multi-part OJ acts — treated as
 *    unavailable rather than reconstructed.
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

/** Outcome of a single content-negotiation attempt. */
type FetchOutcome = { kind: 'content'; text: string } | { kind: 'none' } | { kind: 'challenge' };

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

    for (const accept of ACCEPT_BY_FORMAT[format]) {
      const outcome = await this.fetchVariant(celexNumber, accept, isoLanguage, ctx);
      if (outcome.kind === 'challenge') {
        throw serviceUnavailable(
          `The EU content endpoint returned a bot-challenge interstitial instead of the act text for CELEX ${celexNumber}.`,
          {
            celexNumber,
            reason: 'content_challenge',
            recovery: {
              hint:
                'The content host is behind a WAF/bot challenge. Retry shortly; metadata remains ' +
                'reachable via content_mode "metadata_only". A persistent challenge means ' +
                'EURLEX_CONTENT_BASE_URL points at a WAF-protected host rather than the EU ' +
                'Publications Office CELLAR resolver.',
            },
          },
        );
      }
      if (outcome.kind === 'content') return outcome.text;
    }
    return null;
  }

  /**
   * Single content-negotiation request for one `Accept`/`Accept-Language` pair.
   * Non-2xx responses (404 = no datastream of that type, 300 = multi-part Formex,
   * 4xx/5xx) and network failures resolve to `none` so callers can try the next
   * variant or language. A WAF challenge body resolves to `challenge`. The inner
   * function only throws on a `fetch` rejection, so `withRetry` retries transient
   * network errors but never a 404 or a challenge.
   */
  private fetchVariant(
    celexNumber: string,
    accept: string,
    isoLanguage: string,
    ctx: Context,
  ): Promise<FetchOutcome> {
    const url = this.buildContentUrl(celexNumber);

    return withRetry(
      async (): Promise<FetchOutcome> => {
        const response = await fetch(url, {
          headers: { Accept: accept, 'Accept-Language': isoLanguage },
          signal: AbortSignal.timeout(this.timeoutMs),
          redirect: 'follow',
        });

        if (!response.ok) return { kind: 'none' };

        const text = await response.text();
        if (isChallengeResponse(text)) return { kind: 'challenge' };
        if (text.trim().length < MIN_CONTENT_LENGTH) return { kind: 'none' };
        return { kind: 'content', text };
      },
      {
        operation: 'EurLexContentService.fetchVariant',
        baseDelayMs: 1000,
        maxRetries: 2,
        signal: ctx.signal,
      },
    ).catch((): FetchOutcome => ({ kind: 'none' }));
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
