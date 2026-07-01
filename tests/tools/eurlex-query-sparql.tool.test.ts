/**
 * @fileoverview Tests for eurlex_query_sparql tool.
 * @module tests/tools/eurlex-query-sparql.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eurlex_query_sparql } from '@/mcp-server/tools/definitions/eurlex-query-sparql.tool.js';

// --- Service mock ---
// The tool reads the projected SELECT variables (head.vars) via queryWithVars,
// which returns { variables, bindings } so the projection survives an empty set.
const mockQueryWithVars = vi.fn();
vi.mock('@/services/cellar-sparql/cellar-sparql-service.js', () => ({
  getCellarSparqlService: () => ({ queryWithVars: mockQueryWithVars }),
}));

describe('eurlex_query_sparql', () => {
  beforeEach(() => mockQueryWithVars.mockReset());

  // --- Happy paths ---

  it('returns bindings, variables, and total from a successful query', async () => {
    const ctx = createMockContext({ errors: eurlex_query_sparql.errors });
    mockQueryWithVars.mockResolvedValue({
      variables: ['work', 'celexNumber'],
      bindings: [
        {
          work: { type: 'uri', value: 'http://publications.europa.eu/resource/cellar/gdpr' },
          celexNumber: { type: 'literal', value: '32016R0679' },
        },
      ],
    });

    const input = eurlex_query_sparql.input.parse({
      sparql_query:
        'SELECT ?work ?celexNumber WHERE { ?work cdm:resource_legal_id_celex ?celexNumber . } LIMIT 1',
    });
    const result = await eurlex_query_sparql.handler(input, ctx);

    expect(result.total).toBe(1);
    expect(result.variables).toEqual(['work', 'celexNumber']);
    expect(result.bindings).toHaveLength(1);
  });

  // --- #23: projected variables survive an empty result set ---

  it('reports the projected SELECT variables even when the result set is empty', async () => {
    const ctx = createMockContext({ errors: eurlex_query_sparql.errors });
    // SPARQL 1.1 head.vars carries the projection regardless of binding count;
    // the old Object.keys(bindings[0]) approach dropped it on zero rows.
    mockQueryWithVars.mockResolvedValue({ variables: ['work', 'celex'], bindings: [] });

    const input = eurlex_query_sparql.input.parse({
      sparql_query:
        'SELECT ?work ?celex WHERE { ?work cdm:resource_legal_id_celex ?celex . FILTER(STR(?celex) = "NONEXISTENT") } LIMIT 5',
    });
    const result = await eurlex_query_sparql.handler(input, ctx);

    expect(result.total).toBe(0);
    expect(result.bindings).toHaveLength(0);
    expect(result.variables).toEqual(['work', 'celex']);
  });

  it('passes the query through to the service unchanged (service enforces LIMIT)', async () => {
    const ctx = createMockContext({ errors: eurlex_query_sparql.errors });
    mockQueryWithVars.mockResolvedValue({ variables: [], bindings: [] });

    const rawQuery = 'SELECT ?work WHERE { ?work cdm:resource_legal_id_celex ?celex . } LIMIT 200';
    const input = eurlex_query_sparql.input.parse({ sparql_query: rawQuery });
    await eurlex_query_sparql.handler(input, ctx);

    // Third arg is the per-call timeout: undefined here (no timeout_hint supplied).
    expect(mockQueryWithVars).toHaveBeenCalledWith(rawQuery, expect.anything(), undefined);
  });

  it('surfaces the projected variables from the service in query order', async () => {
    const ctx = createMockContext({ errors: eurlex_query_sparql.errors });
    mockQueryWithVars.mockResolvedValue({
      variables: ['work', 'celex', 'date'],
      bindings: [
        {
          work: { type: 'uri', value: 'http://publications.europa.eu/resource/cellar/gdpr' },
          celex: { type: 'literal', value: '32016R0679' },
          date: { type: 'literal', value: '2016-04-27' },
        },
      ],
    });

    const input = eurlex_query_sparql.input.parse({
      sparql_query:
        'SELECT ?work ?celex ?date WHERE { ?work cdm:resource_legal_id_celex ?celex . } LIMIT 1',
    });
    const result = await eurlex_query_sparql.handler(input, ctx);

    expect(result.variables).toEqual(['work', 'celex', 'date']);
    expect(result.total).toBe(1);
  });

  // --- Read-only guard (#9): reject non-SELECT queries before forwarding ---

  it('rejects DELETE WHERE locally with reason "not_read_only" and does not call the service', async () => {
    const ctx = createMockContext({ errors: eurlex_query_sparql.errors });

    const input = eurlex_query_sparql.input.parse({ sparql_query: 'DELETE WHERE { ?s ?p ?o }' });
    await expect(eurlex_query_sparql.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'not_read_only',
        recovery: { hint: expect.stringContaining('SELECT') },
      },
    });
    expect(mockQueryWithVars).not.toHaveBeenCalled();
  });

  it.each([
    'INSERT DATA { <urn:s> <urn:p> <urn:o> }',
    'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }',
    'DESCRIBE <http://publications.europa.eu/resource/cellar/gdpr>',
    'ASK WHERE { ?s ?p ?o }',
    'LOAD <http://example.org/data.rdf>',
    'DROP GRAPH <http://example.org/g>',
  ])('rejects non-SELECT form locally without calling the service: %s', async (query) => {
    const ctx = createMockContext({ errors: eurlex_query_sparql.errors });

    const input = eurlex_query_sparql.input.parse({ sparql_query: query });
    await expect(eurlex_query_sparql.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'not_read_only' },
    });
    expect(mockQueryWithVars).not.toHaveBeenCalled();
  });

  it('accepts a SELECT preceded by a leading comment and PREFIX declaration', async () => {
    const ctx = createMockContext({ errors: eurlex_query_sparql.errors });
    mockQueryWithVars.mockResolvedValue({
      variables: ['work'],
      bindings: [
        { work: { type: 'uri', value: 'http://publications.europa.eu/resource/cellar/gdpr' } },
      ],
    });

    const query =
      '# resolve GDPR\nPREFIX cdm: <http://publications.europa.eu/ontology/cdm#>\nSELECT ?work WHERE { ?work cdm:resource_legal_id_celex ?celex . } LIMIT 1';
    const input = eurlex_query_sparql.input.parse({ sparql_query: query });
    const result = await eurlex_query_sparql.handler(input, ctx);

    expect(result.total).toBe(1);
    expect(mockQueryWithVars).toHaveBeenCalledWith(query, expect.anything(), undefined);
  });

  // --- timeout_hint (#10): forwarded to the service as the per-call timeout ---

  it('forwards timeout_hint to the service as the per-call timeout', async () => {
    const ctx = createMockContext({ errors: eurlex_query_sparql.errors });
    mockQueryWithVars.mockResolvedValue({ variables: [], bindings: [] });

    const query = 'SELECT ?work WHERE { ?work cdm:resource_legal_id_celex ?celex . } LIMIT 1';
    const input = eurlex_query_sparql.input.parse({ sparql_query: query, timeout_hint: 5000 });
    await eurlex_query_sparql.handler(input, ctx);

    expect(mockQueryWithVars).toHaveBeenCalledWith(query, expect.anything(), 5000);
  });

  it('passes undefined as the per-call timeout when timeout_hint is absent', async () => {
    const ctx = createMockContext({ errors: eurlex_query_sparql.errors });
    mockQueryWithVars.mockResolvedValue({ variables: [], bindings: [] });

    const query = 'SELECT ?work WHERE { ?work cdm:resource_legal_id_celex ?celex . } LIMIT 1';
    const input = eurlex_query_sparql.input.parse({ sparql_query: query });
    await eurlex_query_sparql.handler(input, ctx);

    expect(mockQueryWithVars).toHaveBeenCalledWith(query, expect.anything(), undefined);
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
