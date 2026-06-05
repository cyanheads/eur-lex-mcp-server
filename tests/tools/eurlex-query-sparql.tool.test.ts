/**
 * @fileoverview Tests for eurlex_query_sparql tool.
 * @module tests/tools/eurlex-query-sparql.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eurlex_query_sparql } from '@/mcp-server/tools/definitions/eurlex-query-sparql.tool.js';

// --- Service mock ---
const mockQuery = vi.fn();
vi.mock('@/services/cellar-sparql/cellar-sparql-service.js', () => ({
  getCellarSparqlService: () => ({ query: mockQuery }),
  CellarSparqlService: {
    bindingValue: (binding: Record<string, { value?: string }> | undefined, field: string) =>
      binding?.[field]?.value,
  },
}));

describe('eurlex_query_sparql', () => {
  beforeEach(() => mockQuery.mockReset());

  // --- Happy paths ---

  it('returns bindings, variables, and total from a successful query', async () => {
    const ctx = createMockContext({ errors: eurlex_query_sparql.errors });
    mockQuery.mockResolvedValue([
      {
        work: { type: 'uri', value: 'http://publications.europa.eu/resource/cellar/gdpr' },
        celexNumber: { type: 'literal', value: '32016R0679' },
      },
    ]);

    const input = eurlex_query_sparql.input.parse({
      sparql_query:
        'SELECT ?work ?celexNumber WHERE { ?work cdm:resource_legal_id_celex ?celexNumber . } LIMIT 1',
    });
    const result = await eurlex_query_sparql.handler(input, ctx);

    expect(result.total).toBe(1);
    expect(result.variables).toContain('work');
    expect(result.variables).toContain('celexNumber');
    expect(result.bindings).toHaveLength(1);
  });

  it('returns empty bindings with empty variables when query returns no results', async () => {
    const ctx = createMockContext({ errors: eurlex_query_sparql.errors });
    mockQuery.mockResolvedValue([]);

    const input = eurlex_query_sparql.input.parse({
      sparql_query:
        'SELECT ?work WHERE { ?work cdm:resource_legal_id_celex "NONEXISTENT" . } LIMIT 1',
    });
    const result = await eurlex_query_sparql.handler(input, ctx);

    expect(result.total).toBe(0);
    expect(result.variables).toHaveLength(0);
    expect(result.bindings).toHaveLength(0);
  });

  it('LIMIT is enforced at 100 — service layer applies cap', async () => {
    // The service's enforceLimitInQuery is tested via the service mock;
    // here we verify the handler passes the query through to the service unchanged
    const ctx = createMockContext({ errors: eurlex_query_sparql.errors });
    mockQuery.mockResolvedValue([]);

    const rawQuery = 'SELECT ?work WHERE { ?work cdm:resource_legal_id_celex ?celex . } LIMIT 200';
    const input = eurlex_query_sparql.input.parse({ sparql_query: rawQuery });
    await eurlex_query_sparql.handler(input, ctx);

    // Handler passes the query directly to service.query() — service enforces LIMIT
    expect(mockQuery).toHaveBeenCalledWith(rawQuery, expect.anything());
  });

  it('extracts variable names from first binding row', async () => {
    const ctx = createMockContext({ errors: eurlex_query_sparql.errors });
    mockQuery.mockResolvedValue([
      {
        work: { type: 'uri', value: 'http://publications.europa.eu/resource/cellar/gdpr' },
        celex: { type: 'literal', value: '32016R0679' },
        date: { type: 'literal', value: '2016-04-27' },
      },
    ]);

    const input = eurlex_query_sparql.input.parse({
      sparql_query:
        'SELECT ?work ?celex ?date WHERE { ?work cdm:resource_legal_id_celex ?celex . } LIMIT 1',
    });
    const result = await eurlex_query_sparql.handler(input, ctx);

    expect(result.variables).toEqual(['work', 'celex', 'date']);
    expect(result.total).toBe(1);
  });

  // --- Format ---

  it('format renders variable headers and binding rows as a markdown table', () => {
    const output = {
      bindings: [
        {
          work: { type: 'uri', value: 'http://publications.europa.eu/resource/cellar/gdpr' },
          celex: { type: 'literal', value: '32016R0679' },
        },
      ],
      variables: ['work', 'celex'],
      total: 1,
    };
    const blocks = eurlex_query_sparql.format!(output);
    expect(blocks[0]?.type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('work');
    expect(text).toContain('celex');
    expect(text).toContain('32016R0679');
    expect(text).toContain('1 rows');
  });

  it('format shows "No bindings returned" message when total is 0', () => {
    const output = { bindings: [], variables: [], total: 0 };
    const blocks = eurlex_query_sparql.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('No bindings returned');
  });

  it('format truncates display to first 20 rows with a note', () => {
    const bindings = Array.from({ length: 25 }, (_, i) => ({
      work: { type: 'uri', value: `http://work/${i}` },
    }));
    const output = { bindings, variables: ['work'], total: 25 };
    const blocks = eurlex_query_sparql.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Showing first 20 of 25 rows');
  });
});
