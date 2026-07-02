/**
 * @fileoverview Tests for EurLexContentService — CELLAR content negotiation,
 * ISO 639-2/T language mapping, HTML→Formex variant fallback, English fallback,
 * AWS WAF bot-challenge detection (issue #16), and multi-part Formex 4 assembly
 * (issue #18). `fetch` is stubbed; no test touches the live network. The
 * challenge case reads the committed stub fixture; the multi-part fixtures mirror
 * the real CELLAR 300 index and Formex part shapes.
 * @module tests/services/eurlex-content-service.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import { EurLexContentService } from '@/services/eurlex-content/eurlex-content-service.js';
import { AWS_WAF_CHALLENGE_HTML } from '../fixtures/aws-waf-challenge.js';
import { ACT_XHTML } from '../fixtures/eurlex-act-html.js';
import {
  FORMEX_DOC_1,
  FORMEX_DOC_2,
  FORMEX_MULTIPART_INDEX_300,
  FORMEX_PART_URL_DOC_1,
  FORMEX_PART_URL_DOC_2,
  FORMEX_SINGLE_PART_ACT,
} from '../fixtures/eurlex-formex-multipart.js';

/** A representative (non-stub) xhtml act body — well over the empty-body floor. */
const GDPR_XHTML =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<html xmlns="http://www.w3.org/1999/xhtml"><body>' +
  '<p>REGULATION (EU) 2016/679 OF THE EUROPEAN PARLIAMENT AND OF THE COUNCIL</p>' +
  '<p>on the protection of natural persons with regard to the processing of personal data</p>' +
  '<p>Article 1 — Subject-matter and objectives</p></body></html>';

function makeService(): EurLexContentService {
  const serverConfig = {
    cellarSparqlEndpoint: 'http://publications.europa.eu/webapi/rdf/sparql',
    eurLexContentBaseUrl: 'http://publications.europa.eu',
    sparqlQueryTimeoutMs: 5_000,
    maxSparqlResults: 100,
  } satisfies ServerConfig;
  return new EurLexContentService({} as AppConfig, {} as StorageService, serverConfig);
}

/** Read the `Accept` / `Accept-Language` headers off a recorded fetch call. */
function headersOf(call: unknown[] | undefined): Record<string, string> {
  return (call?.[1] as { headers?: Record<string, string> } | undefined)?.headers ?? {};
}

/**
 * A mock `fetch` for the multi-part path: the CELEX URL yields the given 300
 * index, each part URL matched by a key substring yields that factory's response,
 * and any other URL 404s. Factories build a fresh `Response` per call so bodies
 * are never read twice.
 */
function routeMultipart(
  parts: Record<string, () => Response>,
  index: string = FORMEX_MULTIPART_INDEX_300,
): (url: string) => Promise<Response> {
  return (url: string) => {
    if (url.includes('/resource/celex/')) {
      return Promise.resolve(new Response(index, { status: 300 }));
    }
    for (const [marker, make] of Object.entries(parts)) {
      if (url.includes(marker)) return Promise.resolve(make());
    }
    return Promise.resolve(new Response('not found', { status: 404 }));
  };
}

describe('EurLexContentService', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches HTML via CELLAR content negotiation (xhtml + 3-letter language)', async () => {
    mockFetch.mockResolvedValue(new Response(GDPR_XHTML, { status: 200 }));

    const result = await makeService().fetchContent(
      '32016R0679',
      'EN',
      'html',
      createMockContext(),
    );

    expect(result.contentAvailable).toBe(true);
    expect(result.content).toContain('personal data');
    expect(result.language).toBe('EN');
    expect(result.format).toBe('html');

    // The request targets the CELLAR resolver, not the WAF-protected legal-content endpoint.
    expect(mockFetch.mock.calls[0]?.[0]).toBe(
      'http://publications.europa.eu/resource/celex/32016R0679',
    );
    expect(headersOf(mockFetch.mock.calls[0]).Accept).toBe('application/xhtml+xml');
    expect(headersOf(mockFetch.mock.calls[0])['Accept-Language']).toBe('eng');
  });

  it('maps the EUR-Lex 2-letter code to its ISO 639-2/T form (DE → deu)', async () => {
    mockFetch.mockResolvedValue(new Response(GDPR_XHTML, { status: 200 }));

    await makeService().fetchContent('32016R0679', 'DE', 'html', createMockContext());

    expect(headersOf(mockFetch.mock.calls[0])['Accept-Language']).toBe('deu');
  });

  it('falls back from xhtml to text/html when no xhtml manifestation exists (court cases)', async () => {
    mockFetch.mockImplementation((_url: string, init: { headers: Record<string, string> }) =>
      Promise.resolve(
        init.headers.Accept === 'application/xhtml+xml'
          ? new Response('not found', { status: 404 })
          : new Response(`<HTML>${'j'.repeat(300)} JUDGMENT OF THE COURT</HTML>`, { status: 200 }),
      ),
    );

    const result = await makeService().fetchContent(
      '62024CJ0629',
      'EN',
      'html',
      createMockContext(),
    );

    expect(result.contentAvailable).toBe(true);
    expect(result.content).toContain('JUDGMENT OF THE COURT');
    expect(headersOf(mockFetch.mock.calls[0]).Accept).toBe('application/xhtml+xml');
    expect(headersOf(mockFetch.mock.calls[1]).Accept).toBe('text/html');
  });

  it('falls back to English when the requested language has no content', async () => {
    mockFetch.mockImplementation((_url: string, init: { headers: Record<string, string> }) =>
      Promise.resolve(
        init.headers['Accept-Language'] === 'fra'
          ? new Response('not found', { status: 404 })
          : new Response(GDPR_XHTML, { status: 200 }),
      ),
    );

    const result = await makeService().fetchContent(
      '32016R0679',
      'FR',
      'html',
      createMockContext(),
    );

    expect(result.contentAvailable).toBe(true);
    expect(result.language).toBe('EN');
    expect(result.languageFallback).toContain('FR');
  });

  it('reports content unavailable (not an error) when no manifestation exists in any language', async () => {
    mockFetch.mockResolvedValue(new Response('Resource not found.', { status: 404 }));

    const result = await makeService().fetchContent(
      '39999R9999',
      'EN',
      'html',
      createMockContext(),
    );

    expect(result.contentAvailable).toBe(false);
    expect(result.content).toBe('');
  });

  // --- Multi-part Formex 4 assembly for the xml format (issue #18) ---

  describe('multi-part Formex 4 assembly (xml, issue #18)', () => {
    it('follows a 300 index and assembles the sibling parts into the full act', async () => {
      mockFetch.mockImplementation(
        routeMultipart({
          '/DOC_1': () => new Response(FORMEX_DOC_1, { status: 200 }),
          '/DOC_2': () => new Response(FORMEX_DOC_2, { status: 200 }),
        }),
      );

      const result = await makeService().fetchContent(
        '32016R0679',
        'EN',
        'xml',
        createMockContext(),
      );

      expect(result.contentAvailable).toBe(true);
      expect(result.format).toBe('xml');
      // The Formex variant was negotiated on the initial (CELEX) request.
      expect(headersOf(mockFetch.mock.calls[0]).Accept).toBe('application/xml;type=fmx4');

      // The assembled body carries BOTH the DOC_1 notice header and the DOC_2 act
      // body — not just the <BIB.DOC> shell the single fetch used to return.
      const content = result.content;
      expect(content).toContain('<BIB.DOC>');
      expect(content).toContain('<ENACTING.TERMS>');
      expect(content).toContain('<ARTICLE IDENTIFIER="001">');
      expect(content).toContain('Subject-matter and objectives');

      // Wrapped as one well-formed document: a single prolog + one synthetic root,
      // parts in stream order (DOC_1 header before DOC_2 body).
      expect(content.startsWith('<?xml version="1.0"')).toBe(true);
      expect(content.match(/<\?xml/g)).toHaveLength(1);
      expect(content).toContain('<formex-multipart parts="2">');
      expect(content.indexOf('<BIB.DOC>')).toBeLessThan(content.indexOf('<ENACTING.TERMS>'));
    });

    it('orders parts by DOC sequence even when the index lists them out of order', async () => {
      // A 300 index that lists DOC_2 before DOC_1 — assembly must still emit the
      // notice header (DOC_1) before the act body (DOC_2).
      const reversedIndex =
        `<html><body> List of URI's:<ul>` +
        `<li title="item"><a href="${FORMEX_PART_URL_DOC_2}">DOC_2</a></li>` +
        `<li title="item"><a href="${FORMEX_PART_URL_DOC_1}">DOC_1</a></li>` +
        `</ul></body></html>`;
      mockFetch.mockImplementation(
        routeMultipart(
          {
            '/DOC_1': () => new Response(FORMEX_DOC_1, { status: 200 }),
            '/DOC_2': () => new Response(FORMEX_DOC_2, { status: 200 }),
          },
          reversedIndex,
        ),
      );

      const result = await makeService().fetchContent(
        '32016R0679',
        'EN',
        'xml',
        createMockContext(),
      );

      expect(result.contentAvailable).toBe(true);
      expect(result.content.indexOf('<BIB.DOC>')).toBeLessThan(
        result.content.indexOf('<ENACTING.TERMS>'),
      );
    });

    it('returns a single-part Formex act unchanged (200, no 300, no wrapper)', async () => {
      mockFetch.mockResolvedValue(new Response(FORMEX_SINGLE_PART_ACT, { status: 200 }));

      const result = await makeService().fetchContent(
        '32019R2065',
        'EN',
        'xml',
        createMockContext(),
      );

      expect(result.contentAvailable).toBe(true);
      expect(result.content).toBe(FORMEX_SINGLE_PART_ACT);
      expect(result.content).not.toContain('<formex-multipart');
      expect(headersOf(mockFetch.mock.calls[0]).Accept).toBe('application/xml;type=fmx4');
    });

    it('falls back to content_available: false (no throw) when a sibling part fails', async () => {
      mockFetch.mockImplementation(
        routeMultipart({
          '/DOC_1': () => new Response(FORMEX_DOC_1, { status: 200 }),
          '/DOC_2': () => new Response('gone', { status: 404 }),
        }),
      );

      const result = await makeService().fetchContent(
        '32016R0679',
        'EN',
        'xml',
        createMockContext(),
      );

      expect(result.contentAvailable).toBe(false);
      expect(result.content).toBe('');
    });

    it('falls back to content_available: false when a 300 lists no discoverable parts', async () => {
      // A 300 body with no <a href> part links — assembly finds nothing to fetch.
      mockFetch.mockResolvedValue(
        new Response('<html><title>300 Multiple-Choice Response</title></html>', { status: 300 }),
      );

      const result = await makeService().fetchContent(
        '32016R0679',
        'EN',
        'xml',
        createMockContext(),
      );

      expect(result.contentAvailable).toBe(false);
      expect(headersOf(mockFetch.mock.calls[0]).Accept).toBe('application/xml;type=fmx4');
    });
  });

  // --- Markdown: fetch HTML over the wire, convert server-side (issue #13) ---

  it('fetches HTML and returns server-converted Markdown when format is "markdown"', async () => {
    mockFetch.mockResolvedValue(new Response(ACT_XHTML, { status: 200 }));

    const result = await makeService().fetchContent(
      '32016R0679',
      'EN',
      'markdown',
      createMockContext(),
    );

    expect(result.contentAvailable).toBe(true);
    expect(result.format).toBe('markdown');
    // Markdown is derived from HTML — the wire request negotiates xhtml, never a markdown media type.
    expect(headersOf(mockFetch.mock.calls[0]).Accept).toBe('application/xhtml+xml');
    // Recital flattened to inline-marked text; genuine data table → GFM; no raw HTML.
    expect(result.content).toContain('(1) The protection of natural persons');
    expect(result.content).toMatch(/\|\s*CN code\s*\|\s*Description\s*\|/);
    expect(result.content).not.toMatch(/<table|<td|<div/i);
  });

  it('renders Markdown from the English fallback body when the requested language is unavailable', async () => {
    mockFetch.mockImplementation((_url: string, init: { headers: Record<string, string> }) =>
      Promise.resolve(
        init.headers['Accept-Language'] === 'fra'
          ? new Response('not found', { status: 404 })
          : new Response(ACT_XHTML, { status: 200 }),
      ),
    );

    const result = await makeService().fetchContent(
      '32016R0679',
      'FR',
      'markdown',
      createMockContext(),
    );

    expect(result.contentAvailable).toBe(true);
    expect(result.language).toBe('EN');
    expect(result.format).toBe('markdown');
    expect(result.languageFallback).toContain('FR');
    expect(result.content).toContain('(1) The protection of natural persons');
  });

  // --- The bug: an AWS WAF challenge must NEVER be reported as content (issue #16) ---

  it('detects the AWS WAF challenge stub and raises content_unavailable instead of returning it', async () => {
    mockFetch.mockResolvedValue(new Response(AWS_WAF_CHALLENGE_HTML, { status: 200 }));

    await expect(
      makeService().fetchContent('32016R0679', 'EN', 'html', createMockContext()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'content_challenge' },
    });
  });

  it('refuses the challenge even when served with a 2xx status (the original passthrough bug)', async () => {
    // The legacy endpoint returned the stub with HTTP 202, which is `response.ok`,
    // so it slipped past the old length check and was surfaced as the act text.
    mockFetch.mockResolvedValue(new Response(AWS_WAF_CHALLENGE_HTML, { status: 202 }));

    await expect(
      makeService().fetchContent('32016R0679', 'EN', 'html', createMockContext()),
    ).rejects.toThrow(/bot-challenge/i);
  });
});
