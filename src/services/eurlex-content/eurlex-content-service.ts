/**
 * @fileoverview EurLexContentService — HTTP client for the EUR-Lex REST content API.
 * Fetches full HTML or XML text of EU legal acts via the legal-content URL pattern.
 * Document content is NOT available via CELLAR work URI content negotiation (returns 400).
 * @module services/eurlex-content/eurlex-content-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { withRetry } from '@cyanheads/mcp-ts-core/utils';
import type { ServerConfig } from '@/config/server-config.js';

export type ContentFormat = 'html' | 'xml';

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
   * Build the EUR-Lex legal-content URL for a CELEX number.
   * Pattern: /legal-content/{LANG}/TXT/{FORMAT}/?uri=CELEX:{celex}
   */
  buildContentUrl(celexNumber: string, language: EurLexLanguage, format: ContentFormat): string {
    const fmt = format === 'xml' ? 'XML' : 'HTML';
    return `${this.baseUrl}/legal-content/${language}/TXT/${fmt}/?uri=CELEX:${celexNumber}`;
  }

  /**
   * Fetch the full text content of an EU act by CELEX number.
   * If the requested language is unavailable, falls back to English.
   * Returns `contentAvailable: false` with an empty string if both attempts fail.
   */
  async fetchContent(
    celexNumber: string,
    language: EurLexLanguage,
    format: ContentFormat,
    ctx: Context,
  ): Promise<FetchContentResult> {
    const primary = await this.tryFetch(celexNumber, language, format, ctx);
    if (primary !== null) {
      return { content: primary, language, format, contentAvailable: true };
    }

    // Language fallback: try English if primary language failed
    if (language !== 'EN') {
      const fallback = await this.tryFetch(celexNumber, 'EN', format, ctx);
      if (fallback !== null) {
        return {
          content: fallback,
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
   * Attempt to fetch content for a specific language. Returns null on non-200 or
   * empty/redirect response rather than throwing — callers handle fallback logic.
   */
  private async tryFetch(
    celexNumber: string,
    language: EurLexLanguage,
    format: ContentFormat,
    ctx: Context,
  ): Promise<string | null> {
    const url = this.buildContentUrl(celexNumber, language, format);

    return withRetry(
      async () => {
        const response = await fetch(url, {
          headers: { Accept: format === 'xml' ? 'application/xml' : 'text/html' },
          signal: AbortSignal.timeout(this.timeoutMs),
          redirect: 'follow',
        });

        if (response.status === 404 || response.status === 302 || !response.ok) {
          return null;
        }

        const text = await response.text();

        // Detect HTML error pages masquerading as success (e.g. rate-limit pages)
        if (format === 'xml' && /^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
          throw serviceUnavailable('EUR-Lex returned HTML instead of XML content.');
        }

        // Empty content means unavailable
        if (text.trim().length < 100) {
          return null;
        }

        return text;
      },
      {
        operation: 'EurLexContentService.tryFetch',
        baseDelayMs: 1000,
        maxRetries: 2,
        signal: ctx.signal,
      },
    ).catch(() => null); // Treat fetch failures as unavailable for language fallback
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
