/**
 * @fileoverview eurlex_get_document paging through the real content service and
 * its body cache (#127, #129): one upstream request per act, language, and
 * format, the same body — and so the same offsets — on every page. CELLAR SPARQL
 * is mocked and `fetch` is stubbed; no test touches the live network.
 * @module tests/tools/eurlex-get-document.cache.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eurlex_get_document } from '@/mcp-server/tools/definitions/eurlex-get-document.tool.js';
import { initEurLexContentService } from '@/services/eurlex-content/eurlex-content-service.js';
import { htmlToMarkdown } from '@/services/eurlex-content/html-to-markdown.js';
import { isResolutionQuery, resolutionRows } from '../fixtures/cellar-works.js';
import { AMENDING_HTML } from '../fixtures/eurlex-amending-act.js';

const mockSparqlQuery = vi.fn();

vi.mock('@/services/cellar-sparql/cellar-sparql-service.js', () => ({
  getCellarSparqlService: () => ({ query: mockSparqlQuery }),
  CellarSparqlService: {
    bindingValue: (binding: Record<string, { value?: string }> | undefined, field: string) =>
      binding?.[field]?.value,
    parseBoolean: () => undefined,
  },
}));

const CELEX = '32015R2120';
const MARKDOWN = htmlToMarkdown(AMENDING_HTML);

describe('eurlex_get_document paging through the body cache (#127, #129)', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockSparqlQuery.mockReset();
    mockSparqlQuery.mockImplementation(async (q: string) =>
      isResolutionQuery(q) ? resolutionRows(q) : [],
    );
    mockFetch.mockReset();
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response(AMENDING_HTML, { status: 200 })),
    );
    vi.stubGlobal('fetch', mockFetch);
    // A fresh service per test, so each starts with an empty cache.
    initEurLexContentService({} as AppConfig, {} as StorageService, {
      cellarSparqlEndpoint: 'http://publications.europa.eu/webapi/rdf/sparql',
      eurLexContentBaseUrl: 'http://publications.europa.eu',
      sparqlQueryTimeoutMs: 5_000,
      maxSparqlResults: 100,
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const call = async (args: Record<string, unknown>) => {
    const response = await runToolContract(eurlex_get_document, { celex_number: CELEX, ...args });
    const text = response.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    return { response, text, result: eurlex_get_document.output.parse(response.structuredContent) };
  };

  it('pages a Markdown body with one request, the same total, outline, and text on each call', async () => {
    const outline = await call({ format: 'markdown', outline: true });
    const first = await call({ format: 'markdown', limit: 400 });
    const second = await call({ format: 'markdown', offset: 400, limit: 400 });
    const again = await call({ format: 'markdown', outline: true });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(first.result.content_chars_total).toBe(MARKDOWN.length);
    expect(second.result.content_chars_total).toBe(MARKDOWN.length);
    expect(first.result.content).toBe(MARKDOWN.slice(0, 400));
    expect(second.result.content).toBe(MARKDOWN.slice(400, 800));
    expect(first.result.has_more).toBe(true);
    expect(first.text).toContain('continue with content_mode="paged" and offset=400');
    expect(second.text).toContain(MARKDOWN.slice(400, 800));
    expect(again.result.outline).toEqual(outline.result.outline);
    expect(again.text).toBe(outline.text);
    // The quoted headings stay out of the cached outline (#106).
    expect(outline.result.outline?.map((h) => h.label)).toEqual([
      'Recitals 1–2',
      'Article 1',
      'Article 2',
      'Article 3',
      'ANNEX',
    ]);
  });

  it.each(['html', 'xml'] as const)('pages an %s body with one request', async (format) => {
    const first = await call({ format, limit: 300 });
    const second = await call({ format, offset: 300, limit: 300 });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(second.result.content_chars_total).toBe(first.result.content_chars_total);
    expect(second.result.content).toBe(AMENDING_HTML.slice(300, 600));
  });

  it('reads an offset past the end from the cache as an empty window', async () => {
    await call({ format: 'markdown' });
    const past = await call({ format: 'markdown', offset: MARKDOWN.length + 10 });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(past.result.content).toBeUndefined();
    expect(past.result.content_offset).toBe(MARKDOWN.length);
    expect(past.result.has_more).toBe(false);
    expect(past.text).toContain('past the end of the');
  });

  it('refetches after an unavailable body, reporting the reason on both surfaces', async () => {
    mockFetch.mockImplementation(() => Promise.resolve(new Response('gone', { status: 404 })));
    const missing = await call({ format: 'markdown' });
    expect(missing.result.content_status).toBe('unavailable');
    expect(missing.result.content_unavailability_reason).toBe('no_representation');
    expect(missing.text).toContain('**Content unavailable because:** no_representation');
    const requests = mockFetch.mock.calls.length;

    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response(AMENDING_HTML, { status: 200 })),
    );
    const found = await call({ format: 'markdown' });
    expect(found.result.content_status).toBe('available');
    expect(mockFetch.mock.calls.length).toBe(requests + 1);
  });

  it('makes no request for invalid input', async () => {
    expect(() => eurlex_get_document.input.parse({ celex_number: CELEX, offset: -1 })).toThrow();
    expect(() => eurlex_get_document.input.parse({ celex_number: CELEX, limit: 0 })).toThrow();
    const input = eurlex_get_document.input.parse({ format: 'markdown' });
    await expect(
      eurlex_get_document.handler(input, createMockContext({ errors: eurlex_get_document.errors })),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'invalid_identifier_args',
        recovery: { hint: 'Provide exactly one of celex_number, eli_uri, or work_uri.' },
      },
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
