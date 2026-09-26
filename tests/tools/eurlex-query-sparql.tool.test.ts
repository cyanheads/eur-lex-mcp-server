/**
 * @fileoverview Tests for eurlex_query_sparql tool.
 * @module tests/tools/eurlex-query-sparql.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
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

/** Every text block of a tool result's content[], joined. */
function contentText(result: { content: unknown[] }): string {
  return result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
}

/** The text of the first content[] block format() renders for `output`. */
function formatText(output: {
  bindings: Record<string, unknown>[];
  variables: string[];
  total: number;
}): string {
  return (eurlex_query_sparql.format!(output)[0] as { text: string }).text;
}

/** The error a handler call rejects with; fails the test if it resolves. */
async function rejectionOf(run: () => unknown): Promise<Error & { code?: number; data?: unknown }> {
  try {
    await run();
  } catch (error) {
    return error as Error & { code?: number; data?: unknown };
  }
  throw new Error('Expected the handler to reject');
}

describe('eurlex_query_sparql', () => {
  beforeEach(() => {
    mockQueryWithVars.mockReset();
  });

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
    'DELETE DATA { <urn:s> <urn:p> <urn:o> }',
    'WITH <http://example.org/g> DELETE { ?s ?p ?o } WHERE { ?s ?p ?o }',
    'LOAD <http://example.org/data.rdf>',
    'CLEAR GRAPH <http://example.org/g>',
    'CREATE GRAPH <http://example.org/g>',
    'DROP GRAPH <http://example.org/g>',
    'COPY <http://example.org/a> TO <http://example.org/b>',
    'MOVE <http://example.org/a> TO <http://example.org/b>',
    'ADD <http://example.org/a> TO <http://example.org/b>',
  ])(
    'rejects a SPARQL Update as "not_read_only" without calling the service: %s',
    async (query) => {
      const ctx = createMockContext({ errors: eurlex_query_sparql.errors });

      const input = eurlex_query_sparql.input.parse({ sparql_query: query });
      await expect(eurlex_query_sparql.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'not_read_only' },
      });
      expect(mockQueryWithVars).not.toHaveBeenCalled();
    },
  );

  it('names an Update keyword with the right article (#115)', async () => {
    const ctx = createMockContext({ errors: eurlex_query_sparql.errors });

    const input = eurlex_query_sparql.input.parse({
      sparql_query: 'INSERT DATA { <urn:s> <urn:p> <urn:o> }',
    });
    const error = await rejectionOf(() => eurlex_query_sparql.handler(input, ctx));
    expect(error.message).toContain('an INSERT');
    expect(error.message).not.toContain('a INSERT');
  });

  // --- #115: read-only query forms other than SELECT are unsupported, not updates ---

  it.each([
    ['ASK WHERE { ?w cdm:resource_legal_id_celex "32016R0679"^^xsd:string }', 'an ASK query'],
    ['CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }', 'a CONSTRUCT query'],
    ['DESCRIBE <http://publications.europa.eu/resource/cellar/gdpr>', 'a DESCRIBE query'],
    ['SELCT ?w WHERE { ?w ?p ?o }', 'a SELCT query'],
    ['# only a prologue\nPREFIX ex: <http://example.org/ns#>', 'no query keyword'],
  ])(
    'rejects %j as "unsupported_query_form" without calling the service',
    async (query, phrase) => {
      const ctx = createMockContext({ errors: eurlex_query_sparql.errors });

      const input = eurlex_query_sparql.input.parse({ sparql_query: query });
      const error = await rejectionOf(() => eurlex_query_sparql.handler(input, ctx));
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: {
          reason: 'unsupported_query_form',
          recovery: { hint: expect.stringContaining('SELECT') },
        },
      });
      expect(error.message).toContain(phrase);
      expect(error.message).toContain('Rewrite it as SELECT');
      expect(mockQueryWithVars).not.toHaveBeenCalled();
    },
  );

  it('keeps ASK, CONSTRUCT, and DESCRIBE out of the not_read_only contract text (#115)', () => {
    const contract = eurlex_query_sparql.errors?.find((e) => e.reason === 'not_read_only');
    const text = `${contract?.when} ${contract?.recovery}`;
    for (const form of ['ASK', 'CONSTRUCT', 'DESCRIBE']) expect(text).not.toContain(form);
    expect(eurlex_query_sparql.errors?.map((e) => e.reason)).toContain('unsupported_query_form');
  });

  it('forwards the unsupported_query_form recovery to both surfaces (#115)', async () => {
    const recovery = eurlex_query_sparql.errors?.find(
      (e) => e.reason === 'unsupported_query_form',
    )?.recovery;

    const result = await runToolContract(eurlex_query_sparql, {
      sparql_query: 'ASK { ?w cdm:resource_legal_id_celex "32016R0679"^^xsd:string }',
    });

    expect(result.isError).toBe(true);
    const structured = result.structuredContent as {
      error?: { data?: { reason?: string; recovery?: { hint?: string } } };
    };
    expect(structured.error?.data?.reason).toBe('unsupported_query_form');
    expect(structured.error?.data?.recovery?.hint).toBe(recovery);
    expect(contentText(result)).toContain(recovery ?? '<missing>');
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
    expect(text).toContain(String.raw`"say \\"hi\\" \\\\ bye"`);
  });

  it('format makes only literal lexical content safe inside the GFM table layer', () => {
    const output = {
      bindings: [
        {
          iri: { type: 'uri', value: 'http://example.org/resource' },
          literal: {
            type: 'literal',
            value: 'a|b\r\n<tag>*bold*_under_`code` &copy; [link](url)',
          },
          typed: {
            type: 'literal',
            datatype: 'http://www.w3.org/2001/XMLSchema#string',
            value: 'say "hi" \\ bye',
          },
          lang: { type: 'literal', 'xml:lang': 'en', value: 'left|right\nnext' },
          blank: { type: 'bnode', value: 'node-1' },
          // `missing` stays unbound.
        },
      ],
      variables: ['iri', 'literal', 'typed', 'lang', 'blank', 'missing'],
      total: 1,
    };
    const before = structuredClone(output.bindings);

    const text = (eurlex_query_sparql.format!(output)[0] as { text: string }).text;
    const tableLines = text.split('\n').filter((line) => line.startsWith('| '));
    expect(tableLines).toHaveLength(3);
    const row = tableLines[2] ?? '';

    // Six cells plus the two table-edge delimiters; the lexical pipe is escaped.
    expect(row.match(/(?<!\\)\|/g)).toHaveLength(7);
    expect(row).toContain('"a\\|b\\\\r\\\\n\\<tag\\>\\*bold\\*\\_under\\_\\`code\\`');
    expect(row).toContain('\\&copy; \\[link\\](url)');
    expect(row).toContain(String.raw`"say \\"hi\\" \\\\ bye"^^xsd:string`);
    expect(row).toContain('"left\\|right\\\\nnext"@en');

    // The Markdown-safety layer never rewrites structural term syntax.
    expect(row).toContain('<http://example.org/resource>');
    expect(row).toContain('_:node-1');
    expect(row).toMatch(/\|\s*\|$/);
    expect(output.bindings).toEqual(before);
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

  it('does not disclose truncation when handed a count above the ceiling (defensive guard)', async () => {
    // Defense in depth: the service now bounds the outer result to the ceiling
    // regardless of subselect structure (#63), so a `limitEnforced` page can no
    // longer overshoot in practice. This asserts the tool's own guard holds even
    // if one ever did — an over-ceiling count must never emit the self-
    // contradicting pair `shown: 759, cap: 100`, which is why the disclosure
    // compares `===`, not `>=`.
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

  it('teaches the typed CELEX triple, not the STR() scan, in its sparql_query guidance (#92)', () => {
    const guidance = eurlex_query_sparql.input.shape.sparql_query.description ?? '';
    expect(guidance).toContain('?work cdm:resource_legal_id_celex "32016R0679"^^xsd:string');
    expect(guidance).not.toContain('FILTER(STR(?celex) = "…")');
  });

  it('warns that FILTER equality against an untyped literal has the same trap', () => {
    const guidance = eurlex_query_sparql.input.shape.sparql_query.description ?? '';
    expect(guidance).toContain('FILTER(?celex = "…")');
  });

  // --- #115: zero rows from an untyped triple-object literal carry a notice ---

  describe('untyped triple-object literal notice (#115)', () => {
    const UNTYPED = 'SELECT ?w WHERE { ?w cdm:resource_legal_id_celex "32016R0679" }';

    it('returns zero rows with a notice on both surfaces, sending the query unchanged', async () => {
      mockQueryWithVars.mockResolvedValue({ variables: ['w'], bindings: [] });

      const result = await runToolContract(eurlex_query_sparql, { sparql_query: UNTYPED });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured).toMatchObject({ bindings: [], total: 0 });
      const notice = structured.notice as string;
      expect(notice).toContain('"32016R0679"');
      expect(notice).toContain('^^xsd:string');
      expect(notice).toContain('^^xsd:anyURI');
      expect(notice).toContain('@en');
      expect(contentText(result)).toContain(`> ${notice}`);
      // Byte-identical: the literal is named, never auto-typed.
      expect(mockQueryWithVars).toHaveBeenCalledWith(UNTYPED, expect.anything(), undefined);
    });

    it('carries no notice for the typed form, which returns its row', async () => {
      const ctx = createMockContext({ errors: eurlex_query_sparql.errors });
      mockQueryWithVars.mockResolvedValue({ variables: ['w'], bindings: workRows(1) });

      const input = eurlex_query_sparql.input.parse({
        sparql_query: 'SELECT ?w WHERE { ?w cdm:resource_legal_id_celex "32016R0679"^^xsd:string }',
      });
      const result = await eurlex_query_sparql.handler(input, ctx);

      expect(result.total).toBe(1);
      expect(getEnrichment(ctx).notice).toBeUndefined();
    });

    it('carries no notice when an untyped-literal query returns rows', async () => {
      const ctx = createMockContext({ errors: eurlex_query_sparql.errors });
      mockQueryWithVars.mockResolvedValue({ variables: ['w'], bindings: workRows(2) });

      await eurlex_query_sparql.handler(
        eurlex_query_sparql.input.parse({ sparql_query: UNTYPED }),
        ctx,
      );

      expect(getEnrichment(ctx).notice).toBeUndefined();
    });

    it.each([
      ['a typed literal', 'SELECT ?w WHERE { ?w cdm:resource_legal_id_celex "x"^^xsd:string }'],
      ['a language-tagged literal', 'SELECT ?c WHERE { ?c skos:prefLabel "data protection"@en }'],
      ['an IRI object', 'SELECT ?w WHERE { ?w cdm:work_cites_work <http://example.org/w> }'],
      [
        'a bif:contains phrase',
        'SELECT ?t WHERE { ?e cdm:expression_title ?t . ?t bif:contains "\'data protection\'" }',
      ],
      ['a function argument', 'SELECT ?l WHERE { ?c skos:prefLabel ?l . FILTER(LANG(?l) = "en") }'],
      [
        'FILTER equality',
        'SELECT ?w WHERE { ?w cdm:resource_legal_id_celex ?c . FILTER(?c = "32016R0679") }',
      ],
      [
        'text inside a comment',
        'SELECT ?w WHERE {\n  # ?w cdm:resource_legal_id_celex "32016R0679"\n  ?w cdm:resource_legal_id_celex ?c\n}',
      ],
      ['text inside an IRI', "SELECT ?w WHERE { ?w cdm:work_cites_work <urn:a'32016R0679'> }"],
      [
        'text inside another literal',
        'SELECT ?w WHERE { ?w cdm:p "cdm:q \\"32016R0679\\""^^xsd:string }',
      ],
      [
        'VALUES data',
        'SELECT ?c WHERE { VALUES ?c { "32016R0679" } ?w cdm:resource_legal_id_celex ?c }',
      ],
    ])('carries no notice on zero rows for %s', async (_label, query) => {
      const ctx = createMockContext({ errors: eurlex_query_sparql.errors });
      mockQueryWithVars.mockResolvedValue({ variables: ['w'], bindings: [] });

      await eurlex_query_sparql.handler(
        eurlex_query_sparql.input.parse({ sparql_query: query }),
        ctx,
      );

      expect(getEnrichment(ctx).notice).toBeUndefined();
    });

    it.each([
      ['a variable predicate', 'SELECT ?w WHERE { ?w ?p "32016R0679" }'],
      ['a full IRI predicate', 'SELECT ?w WHERE { ?w <http://example.org/p> "32016R0679" }'],
      ['a property path', 'SELECT ?w WHERE { ?w cdm:a/cdm:b "32016R0679" }'],
      ['an object list', 'SELECT ?w WHERE { ?w cdm:p "a"^^xsd:string, "32016R0679" }'],
      ['a predicate list', 'SELECT ?w WHERE { ?w cdm:p ?x ; cdm:q "32016R0679" . }'],
      ['a long literal', 'SELECT ?w WHERE { ?w cdm:p """32016R0679""" }'],
      ['a single-quoted literal', "SELECT ?w WHERE { ?w cdm:p '32016R0679' }"],
    ])('names the literal for %s', async (_label, query) => {
      const ctx = createMockContext({ errors: eurlex_query_sparql.errors });
      mockQueryWithVars.mockResolvedValue({ variables: ['w'], bindings: [] });

      await eurlex_query_sparql.handler(
        eurlex_query_sparql.input.parse({ sparql_query: query }),
        ctx,
      );

      expect(getEnrichment(ctx).notice).toContain('"32016R0679"');
    });

    it('counts further untyped literals and bounds the echoed one', async () => {
      const ctx = createMockContext({ errors: eurlex_query_sparql.errors });
      mockQueryWithVars.mockResolvedValue({ variables: ['w'], bindings: [] });
      const long = 'x'.repeat(300);

      await eurlex_query_sparql.handler(
        eurlex_query_sparql.input.parse({
          sparql_query: `SELECT ?w WHERE { ?w cdm:p "${long}" ; cdm:q "b" ; cdm:r "c" }`,
        }),
        ctx,
      );

      const notice = getEnrichment(ctx).notice as string;
      expect(notice).toContain(`"${'x'.repeat(100)}…" and 2 more`);
      expect(notice).not.toContain('x'.repeat(101));
    });
  });

  // --- #115: an underscore between two letters or digits is left bare ---

  it('leaves an intraword underscore unescaped in an identifier literal', () => {
    const text = formatText({
      bindings: [
        {
          c: {
            type: 'literal',
            datatype: 'http://www.w3.org/2001/XMLSchema#string',
            value: '72022L2555ROU_202405184',
          },
        },
      ],
      variables: ['c'],
      total: 1,
    });

    expect(text).toContain('| "72022L2555ROU_202405184"^^xsd:string |');
  });

  it.each([
    ['_x_', String.raw`"\_x\_"`],
    ['a_ b', String.raw`"a\_ b"`],
    ['a _b', String.raw`"a \_b"`],
    ['a__b', String.raw`"a\_\_b"`],
    ['é_ü 1_2', '"é_ü 1_2"'],
  ])('escapes an underscore unless both neighbours are letters or digits: %j', (value, cell) => {
    const text = formatText({
      bindings: [{ v: { type: 'literal', value } }],
      variables: ['v'],
      total: 1,
    });

    expect(text).toContain(`| ${cell} |`);
  });
});
