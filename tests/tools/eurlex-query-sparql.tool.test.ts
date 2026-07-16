/**
 * @fileoverview Tests for eurlex_query_sparql tool.
 * @module tests/tools/eurlex-query-sparql.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eurlex_query_sparql } from '@/mcp-server/tools/definitions/eurlex-query-sparql.tool.js';

// --- Service mock ---
// The tool reads the projected SELECT variables (head.vars) via queryWithVars,
// which returns { variables, bindings, limitEnforced } so the projection survives
// an empty set and the LIMIT-ceiling decision is observable. maxResults mirrors
// the real service ceiling (MAX_SPARQL_RESULTS).
const mockQueryWithVars = vi.fn();
vi.mock('@/services/cellar-sparql/cellar-sparql-service.js', () => ({
  getCellarSparqlService: () => ({ queryWithVars: mockQueryWithVars, maxResults: 100 }),
}));

/** `n` binding rows shaped like a CELLAR `?work` projection. */
function workRows(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    work: { type: 'uri', value: `http://work/${i}` },
  }));
}

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

  it('format renders every row with no truncation note (#50)', () => {
    const output = { bindings: workRows(25), variables: ['work'], total: 25 };
    const blocks = eurlex_query_sparql.format!(output);
    const text = (blocks[0] as { text: string }).text;
    // The full page reaches content[] — including rows past the old 20-row cut.
    expect(text).toContain('http://work/0');
    expect(text).toContain('http://work/20');
    expect(text).toContain('http://work/24');
    // One table row per binding plus the header/separator rows. IRIs render in
    // angle brackets since #54 made the cells term-aware.
    expect(text.match(/\| <http:\/\/work\//g)).toHaveLength(25);
    // No truncation note — the text channel no longer drops rows.
    expect(text).not.toContain('Showing first');
  });

  // --- #54: content[] must carry the same SPARQL term data as structuredContent ---

  it('format marks IRI cells as IRIs, distinguishing them from literals', () => {
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
    const text = (eurlex_query_sparql.format!(output)[0] as { text: string }).text;

    expect(text).toContain('<http://publications.europa.eu/resource/cellar/gdpr>');
    expect(text).toContain('"32016R0679"');
  });

  it('format renders the datatype of a typed literal', () => {
    // The live CELLAR shape for cdm:work_date_document.
    const output = {
      bindings: [
        {
          date: {
            type: 'literal',
            datatype: 'http://www.w3.org/2001/XMLSchema#date',
            value: '2016-04-27',
          },
        },
      ],
      variables: ['date'],
      total: 1,
    };
    const text = (eurlex_query_sparql.format!(output)[0] as { text: string }).text;

    // The xsd: prefix this tool auto-injects — not a bare, type-less value.
    expect(text).toContain('"2016-04-27"^^xsd:date');
  });

  it('format renders a non-XSD datatype as a full IRI rather than inventing a prefix', () => {
    const output = {
      bindings: [
        {
          v: { type: 'literal', datatype: 'http://example.org/custom#kind', value: 'x' },
        },
      ],
      variables: ['v'],
      total: 1,
    };
    const text = (eurlex_query_sparql.format!(output)[0] as { text: string }).text;

    expect(text).toContain('"x"^^<http://example.org/custom#kind>');
  });

  it('format renders the language tag of a language-tagged literal', () => {
    // The live CELLAR shape for skos:prefLabel.
    const output = {
      bindings: [{ label: { type: 'literal', 'xml:lang': 'en', value: 'protection of privacy' } }],
      variables: ['label'],
      total: 1,
    };
    const text = (eurlex_query_sparql.format!(output)[0] as { text: string }).text;

    expect(text).toContain('"protection of privacy"@en');
  });

  it('format renders a plain literal, a bnode, and an unbound OPTIONAL distinctly', () => {
    const output = {
      bindings: [
        {
          plain: { type: 'literal', value: 'bare' },
          anon: { type: 'bnode', value: 'b0' },
          // `missing` is absent entirely — an unbound OPTIONAL has no key at all.
        },
      ],
      variables: ['plain', 'anon', 'missing'],
      total: 1,
    };
    const text = (eurlex_query_sparql.format!(output)[0] as { text: string }).text;

    expect(text).toContain('| "bare" | _:b0 |  |');
  });

  it('format escapes quotes and backslashes inside a lexical form', () => {
    const output = {
      bindings: [{ v: { type: 'literal', value: 'say "hi" \\ bye' } }],
      variables: ['v'],
      total: 1,
    };
    const text = (eurlex_query_sparql.format!(output)[0] as { text: string }).text;

    // Delimiters stay unambiguous — an embedded quote cannot close the literal.
    expect(text).toContain(String.raw`"say \"hi\" \\ bye"`);
  });

  it('format keeps every row when rendering term metadata (#50 parity preserved)', () => {
    const bindings = Array.from({ length: 30 }, (_, i) => ({
      d: {
        type: 'literal',
        datatype: 'http://www.w3.org/2001/XMLSchema#date',
        value: `2016-01-${i}`,
      },
    }));
    const output = { bindings, variables: ['d'], total: 30 };
    const text = (eurlex_query_sparql.format!(output)[0] as { text: string }).text;

    // Term-awareness must not come at the cost of the row set #50 restored.
    expect(text.match(/\^\^xsd:date/g)).toHaveLength(30);
  });

  // --- #52: disclose when the server's LIMIT ceiling capped the result ---

  it('discloses truncation when the ceiling fired and filled', async () => {
    const ctx = createMockContext({ errors: eurlex_query_sparql.errors });
    // No user LIMIT → the server appended one and it filled exactly.
    mockQueryWithVars.mockResolvedValue({
      variables: ['work'],
      bindings: workRows(100),
      limitEnforced: true,
    });

    const input = eurlex_query_sparql.input.parse({
      sparql_query: 'SELECT ?work WHERE { ?work cdm:resource_legal_id_celex ?celex . }',
    });
    const result = await eurlex_query_sparql.handler(input, ctx);

    expect(result.total).toBe(100);
    expect(getEnrichment(ctx)).toMatchObject({ truncated: true, shown: 100, cap: 100 });
  });

  it('does not disclose truncation when the ceiling fired but did not fill', async () => {
    const ctx = createMockContext({ errors: eurlex_query_sparql.errors });
    mockQueryWithVars.mockResolvedValue({
      variables: ['work'],
      bindings: workRows(76),
      limitEnforced: true,
    });

    const input = eurlex_query_sparql.input.parse({
      sparql_query: 'SELECT ?work WHERE { ?work cdm:work_date_document "2016-04-27"^^xsd:date . }',
    });
    await eurlex_query_sparql.handler(input, ctx);

    expect(getEnrichment(ctx).truncated).toBeUndefined();
  });

  it('does not disclose truncation when the caller own LIMIT returned a full page', async () => {
    // The ambiguity #52 exists to resolve: 100 rows, but the ceiling never fired,
    // so the caller's own LIMIT bound the result and nothing was truncated.
    const ctx = createMockContext({ errors: eurlex_query_sparql.errors });
    mockQueryWithVars.mockResolvedValue({
      variables: ['work'],
      bindings: workRows(100),
      limitEnforced: false,
    });

    const input = eurlex_query_sparql.input.parse({
      sparql_query: 'SELECT ?work WHERE { ?work cdm:resource_legal_id_celex ?celex . } LIMIT 100',
    });
    const result = await eurlex_query_sparql.handler(input, ctx);

    expect(result.total).toBe(100);
    expect(getEnrichment(ctx).truncated).toBeUndefined();
  });

  it('does not disclose truncation on an empty result set', async () => {
    const ctx = createMockContext({ errors: eurlex_query_sparql.errors });
    mockQueryWithVars.mockResolvedValue({
      variables: ['work'],
      bindings: [],
      limitEnforced: true,
    });

    const input = eurlex_query_sparql.input.parse({
      sparql_query: 'SELECT ?work WHERE { ?work cdm:resource_legal_id_celex ?celex . }',
    });
    await eurlex_query_sparql.handler(input, ctx);

    expect(getEnrichment(ctx).truncated).toBeUndefined();
  });

  it('does not disclose truncation when an uncapped outer query overshoots the ceiling', async () => {
    // enforceLimitInQuery rewrites only the FIRST LIMIT in the text, so a
    // subselect's limit can absorb the rewrite and leave the outer query
    // uncapped — returning more rows than the ceiling. Reporting `shown: 759,
    // cap: 100` there would contradict itself, so the count must match exactly.
    const ctx = createMockContext({ errors: eurlex_query_sparql.errors });
    mockQueryWithVars.mockResolvedValue({
      variables: ['work'],
      bindings: workRows(759),
      limitEnforced: true,
    });

    const input = eurlex_query_sparql.input.parse({
      sparql_query:
        'SELECT ?work ?c WHERE { { SELECT ?work WHERE { ?work cdm:resource_legal_id_celex ?x . } LIMIT 500 } ?work cdm:work_is_about_concept_eurovoc ?c . }',
    });
    await eurlex_query_sparql.handler(input, ctx);

    expect(getEnrichment(ctx).truncated).toBeUndefined();
  });
});
