/**
 * @fileoverview Tests for eurlex_search_documents tool.
 * @module tests/tools/eurlex-search-documents.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eurlex_search_documents } from '@/mcp-server/tools/definitions/eurlex-search-documents.tool.js';

// --- Service mock ---
const mockQuery = vi.fn();
vi.mock('@/services/cellar-sparql/cellar-sparql-service.js', () => ({
  getCellarSparqlService: () => ({ query: mockQuery }),
  CellarSparqlService: {
    bindingValue: (binding: Record<string, { value?: string }> | undefined, field: string) =>
      binding?.[field]?.value,
  },
}));

/** Build a minimal SPARQL binding for a document result. */
function makeDocBinding(
  celex: string,
  opts: { workUri?: string; type?: string; date?: string; title?: string } = {},
): Record<string, { type: string; value: string }> {
  const b: Record<string, { type: string; value: string }> = {
    celexNumber: { type: 'literal', value: celex },
    work: {
      type: 'uri',
      value: opts.workUri ?? `http://publications.europa.eu/resource/cellar/${celex}`,
    },
  };
  if (opts.type) b.type = { type: 'uri', value: opts.type };
  if (opts.date) b.date = { type: 'literal', value: opts.date };
  if (opts.title) b.title = { type: 'literal', value: opts.title };
  return b;
}

describe('eurlex_search_documents', () => {
  beforeEach(() => mockQuery.mockReset());

  // --- Happy paths ---

  it('returns matched documents on success', async () => {
    const ctx = createMockContext({ errors: eurlex_search_documents.errors });
    mockQuery.mockResolvedValue([
      makeDocBinding('32016R0679', {
        date: '2016-04-27',
        title: 'General Data Protection Regulation',
        type: 'http://publications.europa.eu/resource/authority/resource-type/REG',
      }),
      makeDocBinding('32022R0868', { date: '2022-05-30' }),
    ]);

    const input = eurlex_search_documents.input.parse({ keyword: 'data', limit: 20 });
    const result = await eurlex_search_documents.handler(input, ctx);

    expect(result.total).toBe(2);
    expect(result.offset).toBe(0);
    expect(result.documents[0]?.celex_number).toBe('32016R0679');
    expect(result.documents[0]?.title).toBe('General Data Protection Regulation');
    expect(result.documents[0]?.date).toBe('2016-04-27');
    // resource_type should be resolved to a human-readable label
    expect(result.documents[0]?.resource_type).toBe('Regulation');
    // Sparse row: no type/date/title
    expect(result.documents[1]?.resource_type).toBeUndefined();
  });

  it('passes offset and limit to query', async () => {
    const ctx = createMockContext({ errors: eurlex_search_documents.errors });
    mockQuery.mockResolvedValue([makeDocBinding('32016R0679')]);

    const input = eurlex_search_documents.input.parse({ offset: 20, limit: 10 });
    const result = await eurlex_search_documents.handler(input, ctx);

    expect(result.offset).toBe(20);
    // SPARQL query string should contain OFFSET 20 and LIMIT 10
    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sparql).toContain('LIMIT 10');
    expect(sparql).toContain('OFFSET 20');
  });

  it('applies document_type filter to SPARQL', async () => {
    const ctx = createMockContext({ errors: eurlex_search_documents.errors });
    mockQuery.mockResolvedValue([makeDocBinding('32016L0680')]);

    const input = eurlex_search_documents.input.parse({ document_type: 'DIR' });
    await eurlex_search_documents.handler(input, ctx);

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sparql).toContain('http://publications.europa.eu/resource/authority/resource-type/DIR');
  });

  it('applies date_from and date_to filters', async () => {
    const ctx = createMockContext({ errors: eurlex_search_documents.errors });
    mockQuery.mockResolvedValue([makeDocBinding('32016R0679')]);

    const input = eurlex_search_documents.input.parse({
      date_from: '2016-01-01',
      date_to: '2016-12-31',
    });
    await eurlex_search_documents.handler(input, ctx);

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sparql).toContain('"2016-01-01"^^xsd:date');
    expect(sparql).toContain('"2016-12-31"^^xsd:date');
  });

  // --- Error contract paths ---

  it('throws ctx.fail("no_results") when query returns empty bindings', async () => {
    const ctx = createMockContext({ errors: eurlex_search_documents.errors });
    mockQuery.mockResolvedValue([]);

    const input = eurlex_search_documents.input.parse({ keyword: 'nonexistent-term-xyz' });
    await expect(eurlex_search_documents.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_results' },
    });
  });

  it('includes query_echo in the response', async () => {
    const ctx = createMockContext({ errors: eurlex_search_documents.errors });
    mockQuery.mockResolvedValue([makeDocBinding('32016R0679')]);

    const input = eurlex_search_documents.input.parse({
      keyword: 'privacy',
      document_type: 'REG',
      date_from: '2020-01-01',
    });
    const result = await eurlex_search_documents.handler(input, ctx);

    expect(result.query_echo.keyword).toBe('privacy');
    expect(result.query_echo.document_type).toBe('REG');
    expect(result.query_echo.date_from).toBe('2020-01-01');
    expect(result.query_echo.date_to).toBeUndefined();
  });

  it('SPARQL uses expression_belongs_to_work path for title', async () => {
    const ctx = createMockContext({ errors: eurlex_search_documents.errors });
    mockQuery.mockResolvedValue([makeDocBinding('32016R0679')]);

    const input = eurlex_search_documents.input.parse({ keyword: 'regulation' });
    await eurlex_search_documents.handler(input, ctx);

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sparql).toContain('cdm:expression_belongs_to_work');
    expect(sparql).toContain('cdm:expression_title');
    // Old broken path must not be present
    expect(sparql).not.toContain('cdm:work_title');
  });

  it('applies eurovoc_concept filter to SPARQL when provided', async () => {
    const ctx = createMockContext({ errors: eurlex_search_documents.errors });
    mockQuery.mockResolvedValue([makeDocBinding('32016R0679')]);

    const input = eurlex_search_documents.input.parse({
      eurovoc_concept: 'http://eurovoc.europa.eu/2828',
    });
    await eurlex_search_documents.handler(input, ctx);

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sparql).toContain('http://eurovoc.europa.eu/2828');
    expect(sparql).toContain('cdm:work_is_about_concept_eurovoc');
  });

  // --- Author institution filter (issue #6) ---

  it('author_institution is a REQUIRED constraint, not an OPTIONAL binding', async () => {
    const ctx = createMockContext({ errors: eurlex_search_documents.errors });
    mockQuery.mockResolvedValue([makeDocBinding('32016R0679')]);

    const input = eurlex_search_documents.input.parse({
      author_institution: 'European Parliament',
    });
    await eurlex_search_documents.handler(input, ctx);

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    // Constrains selection via corporate-body prefLabel + the full-text index.
    expect(sparql).toContain('?work cdm:work_created_by_agent ?agent');
    expect(sparql).toContain('skos:prefLabel');
    expect(sparql).toContain(`bif:contains "'European Parliament'"`);
    // The bug was an OPTIONAL author block over a predicate CELLAR doesn't expose.
    expect(sparql).not.toMatch(/OPTIONAL\s*\{[^}]*work_created_by_agent/);
    expect(sparql).not.toContain('cdm:corporate-body_label');
  });

  it('sanitizes author_institution so it cannot break out of the full-text phrase', async () => {
    const ctx = createMockContext({ errors: eurlex_search_documents.errors });
    mockQuery.mockResolvedValue([makeDocBinding('32016R0679')]);

    const input = eurlex_search_documents.input.parse({
      author_institution: 'European "Parliament"; DROP',
    });
    await eurlex_search_documents.handler(input, ctx);

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    // Punctuation (quotes, semicolons) stripped, whitespace collapsed.
    expect(sparql).toContain(`bif:contains "'European Parliament DROP'"`);
    expect(sparql).not.toContain('"Parliament"');
  });

  it('throws no_results for an author that sanitizes to empty (no queryable institution)', async () => {
    const ctx = createMockContext({ errors: eurlex_search_documents.errors });

    const input = eurlex_search_documents.input.parse({ author_institution: '!!!' });
    await expect(eurlex_search_documents.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_results' },
    });
    // Degenerate author short-circuits before hitting CELLAR.
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('an impossible author yields no_results when the constrained query returns no rows', async () => {
    const ctx = createMockContext({ errors: eurlex_search_documents.errors });
    mockQuery.mockResolvedValue([]);

    const input = eurlex_search_documents.input.parse({
      author_institution: 'zzzxxy-no-such-eu-author',
    });
    await expect(eurlex_search_documents.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_results' },
    });
  });

  // --- Format ---

  it('format renders celex, date, type label, and work_uri', () => {
    const output = {
      documents: [
        {
          work_uri: 'http://publications.europa.eu/resource/cellar/gdpr',
          celex_number: '32016R0679',
          resource_type: 'Regulation',
          date: '2016-04-27',
          title: 'GDPR',
        },
      ],
      total: 1,
      offset: 0,
      query_echo: { keyword: 'gdpr' },
    };
    const blocks = eurlex_search_documents.format!(output);
    expect(blocks[0]?.type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('32016R0679');
    expect(text).toContain('2016-04-27');
    expect(text).toContain('Regulation');
    expect(text).toContain('http://publications.europa.eu/resource/cellar/gdpr');
    expect(text).toContain('keyword="gdpr"');
  });

  it('format handles sparse documents (no type, date, or title)', () => {
    const output = {
      documents: [
        {
          work_uri: 'http://publications.europa.eu/resource/cellar/sparse',
          celex_number: '12345ABC',
        },
      ],
      total: 1,
      offset: 0,
      query_echo: {},
    };
    const blocks = eurlex_search_documents.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('12345ABC');
  });
});
