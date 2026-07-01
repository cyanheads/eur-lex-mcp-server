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

/**
 * Build a minimal SPARQL binding for a document result. Field names mirror the
 * GROUP BY projection the handler reads: `celex`, `types` (space-separated
 * resource-type URIs from GROUP_CONCAT), `docDate`, `docTitle`. Pass `types` a
 * space-joined list to simulate a multi-resource-type work (e.g. a corrigendum).
 */
function makeDocBinding(
  celex: string,
  opts: {
    workUri?: string;
    titledWork?: string;
    types?: string;
    date?: string;
    title?: string;
  } = {},
): Record<string, { type: string; value: string }> {
  const b: Record<string, { type: string; value: string }> = {
    celex: { type: 'literal', value: celex },
    work: {
      type: 'uri',
      value: opts.workUri ?? `http://publications.europa.eu/resource/cellar/${celex}`,
    },
  };
  // Mirrors MAX(?titledWork): the work URI that carried an English title in the
  // CELEX group. Present only when the document had a titled work (issue #24).
  if (opts.titledWork) b.titledWork = { type: 'uri', value: opts.titledWork };
  if (opts.types) b.types = { type: 'literal', value: opts.types };
  if (opts.date) b.docDate = { type: 'literal', value: opts.date };
  if (opts.title) b.docTitle = { type: 'literal', value: opts.title };
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
        types: 'http://publications.europa.eu/resource/authority/resource-type/REG',
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

  // --- Keyword full-text search (issue #17) ---

  it('matches the keyword against the title via the full-text index, not a scan (issue #17)', async () => {
    const ctx = createMockContext({ errors: eurlex_search_documents.errors });
    mockQuery.mockResolvedValue([makeDocBinding('32016R0679')]);

    const input = eurlex_search_documents.input.parse({ keyword: 'data protection' });
    await eurlex_search_documents.handler(input, ctx);

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    // A multi-word keyword is single-quoted as a phrase for the Virtuoso FT index.
    expect(sparql).toContain(`bif:contains "'data protection'"`);
    expect(sparql).toContain('cdm:expression_title ?kwTitle');
    // The old full-scan filter over every candidate title must be gone (#17).
    expect(sparql).not.toContain('CONTAINS(LCASE(COALESCE(STR(?title)');
  });

  it('keeps exact-substring CELEX matching as a UNION arm (issue #17)', async () => {
    const ctx = createMockContext({ errors: eurlex_search_documents.errors });
    mockQuery.mockResolvedValue([makeDocBinding('32016R0679')]);

    const input = eurlex_search_documents.input.parse({ keyword: '32016R0679' });
    await eurlex_search_documents.handler(input, ctx);

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    // The CELEX arm re-binds the celex inside the UNION branch — a bare FILTER on
    // the outer ?celexNumber would evaluate out of scope there and match nothing.
    expect(sparql).toContain('UNION');
    expect(sparql).toContain('cdm:resource_legal_id_celex ?kwCelex');
    expect(sparql).toContain('CONTAINS(LCASE(STR(?kwCelex)), "32016r0679")');
  });

  it('sanitizes the keyword so it cannot break out of the full-text phrase (issue #17)', async () => {
    const ctx = createMockContext({ errors: eurlex_search_documents.errors });
    mockQuery.mockResolvedValue([makeDocBinding('32016R0679')]);

    const input = eurlex_search_documents.input.parse({ keyword: 'data "protection"; DROP' });
    await eurlex_search_documents.handler(input, ctx);

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    // Punctuation stripped, whitespace collapsed in the full-text phrase.
    expect(sparql).toContain(`bif:contains "'data protection DROP'"`);
  });

  it('drops the full-text arm when the keyword sanitizes to empty, keeping CELEX matching (issue #17)', async () => {
    const ctx = createMockContext({ errors: eurlex_search_documents.errors });
    mockQuery.mockResolvedValue([makeDocBinding('32016R0679')]);

    const input = eurlex_search_documents.input.parse({ keyword: '()' });
    await eurlex_search_documents.handler(input, ctx);

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    // An all-punctuation keyword has no FT phrase — no bif:contains, no UNION — but
    // the CELEX substring match still runs so the query stays well-formed.
    expect(sparql).not.toContain('bif:contains');
    expect(sparql).toContain('cdm:resource_legal_id_celex ?kwCelex');
  });

  // --- Dedup of multi-resource-type works (issue #14) ---

  it('collapses resource-types via GROUP_CONCAT rather than SELECT DISTINCT (issue #14)', async () => {
    const ctx = createMockContext({ errors: eurlex_search_documents.errors });
    mockQuery.mockResolvedValue([makeDocBinding('32016R0679')]);

    const input = eurlex_search_documents.input.parse({ keyword: 'data' });
    await eurlex_search_documents.handler(input, ctx);

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sparql).toContain('GROUP_CONCAT(DISTINCT STR(?type)');
    // The old shape — DISTINCT over a projected ?type — could not collapse a work
    // that differs only by resource-type. It must be gone.
    expect(sparql).not.toContain('SELECT DISTINCT ?work ?celexNumber ?type');
  });

  it('a multi-resource-type work yields one row listing all type labels', async () => {
    const ctx = createMockContext({ errors: eurlex_search_documents.errors });
    // A corrigendum carries several resource-types; GROUP_CONCAT delivers them
    // space-separated in a single binding (one row per work, not a cross-product).
    mockQuery.mockResolvedValue([
      makeDocBinding('32015B0367R(01)', {
        date: '2015-06-09',
        types:
          'http://publications.europa.eu/resource/authority/resource-type/BUDGET ' +
          'http://publications.europa.eu/resource/authority/resource-type/CORRIGENDUM',
      }),
    ]);

    const input = eurlex_search_documents.input.parse({ keyword: 'budget' });
    const result = await eurlex_search_documents.handler(input, ctx);

    expect(result.total).toBe(1);
    expect(result.documents).toHaveLength(1);
    // Both types resolve, de-duplicate, sort, and join — neither is silently dropped.
    // BUDGET and CORRIGENDUM aren't in the curated label map, so each falls back to
    // its raw authority code (the pre-existing single-type behavior).
    expect(result.documents[0]?.resource_type).toBe('BUDGET, CORRIGENDUM');
  });

  it('the limit bounds distinct documents (cap applied after GROUP BY CELEX)', async () => {
    const ctx = createMockContext({ errors: eurlex_search_documents.errors });
    // Two multi-type works. Pre-fix these would cross-product into 4 rows and a
    // limit of 2 would return a partial page; grouped, each document is one row.
    mockQuery.mockResolvedValue([
      makeDocBinding('32025R2605R(01)', {
        types:
          'http://publications.europa.eu/resource/authority/resource-type/REG ' +
          'http://publications.europa.eu/resource/authority/resource-type/CORRIGENDUM',
      }),
      makeDocBinding('32025R2143R(01)', {
        types:
          'http://publications.europa.eu/resource/authority/resource-type/REG ' +
          'http://publications.europa.eu/resource/authority/resource-type/CORRIGENDUM',
      }),
    ]);

    const input = eurlex_search_documents.input.parse({ keyword: 'corrigendum', limit: 2 });
    const result = await eurlex_search_documents.handler(input, ctx);

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    // GROUP BY precedes LIMIT, so the cap bounds documents rather than raw rows.
    expect(sparql).toMatch(/GROUP BY \?celexNumber[\s\S]*LIMIT 2/);
    expect(result.total).toBe(2);
    const uris = result.documents.map((d) => d.work_uri);
    expect(new Set(uris).size).toBe(2);
  });

  // --- Dedup of same-CELEX duplicate works (issue #24) ---

  it('groups by CELEX (not work) so N distinct documents fill a page of N (issue #24)', async () => {
    const ctx = createMockContext({ errors: eurlex_search_documents.errors });
    mockQuery.mockResolvedValue([makeDocBinding('32016R0679', { title: 'GDPR' })]);

    const input = eurlex_search_documents.input.parse({ keyword: 'data' });
    await eurlex_search_documents.handler(input, ctx);

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    // Two distinct work URIs can share one CELEX (a titled work + a do_not_index
    // member, or parallel manifestations); grouping by ?work left both rows and
    // each wasted a limit slot. Grouping by CELEX collapses them.
    expect(sparql).toContain('GROUP BY ?celexNumber');
    expect(sparql).not.toContain('GROUP BY ?work');
    // MAX keeps a bound title across the group; ?titledWork binds inside the title
    // OPTIONAL so the titled work URI can be preferred.
    expect(sparql).toContain('MAX(?title)');
    expect(sparql).toContain('MAX(?titledWork)');
    expect(sparql).toContain('BIND(?work AS ?titledWork)');
    // ?docDate uses SAMPLE, not MAX: a MAX over the ORDER BY DESC(?docDate) column
    // lets Virtuoso pick a date-index TOP-k plan that bypasses the date-range
    // upper-bound FILTER on bare date/type searches (no selective graph pattern),
    // surfacing globally-latest documents instead of in-range ones.
    expect(sparql).toContain('SAMPLE(?date)');
    expect(sparql).not.toContain('MAX(?date)');
  });

  it('keeps the titled work_uri over a bare same-CELEX duplicate (issue #24)', async () => {
    const ctx = createMockContext({ errors: eurlex_search_documents.errors });
    // One CELEX, collapsed by GROUP BY: MAX(?titledWork) carries the titled work's
    // URI while SAMPLE(?work) may be the bare member. The handler must surface the
    // titled URI and the recovered title.
    mockQuery.mockResolvedValue([
      makeDocBinding('32016R0679', {
        workUri: 'http://publications.europa.eu/resource/cellar/bare-member',
        titledWork: 'http://publications.europa.eu/resource/cellar/titled-work',
        title: 'General Data Protection Regulation',
        types: 'http://publications.europa.eu/resource/authority/resource-type/REG',
      }),
    ]);

    const input = eurlex_search_documents.input.parse({ keyword: 'data protection' });
    const result = await eurlex_search_documents.handler(input, ctx);

    expect(result.total).toBe(1);
    expect(result.documents[0]?.work_uri).toBe(
      'http://publications.europa.eu/resource/cellar/titled-work',
    );
    expect(result.documents[0]?.title).toBe('General Data Protection Regulation');
  });

  it('falls back to the sampled work_uri when no titled duplicate exists (issue #24)', async () => {
    const ctx = createMockContext({ errors: eurlex_search_documents.errors });
    // An older work with no English title: MAX(?titledWork) is unbound (absent from
    // the binding), so the handler uses SAMPLE(?work).
    mockQuery.mockResolvedValue([
      makeDocBinding('31958R0001', {
        workUri: 'http://publications.europa.eu/resource/cellar/old-untitled-work',
      }),
    ]);

    const input = eurlex_search_documents.input.parse({ keyword: 'regulation' });
    const result = await eurlex_search_documents.handler(input, ctx);

    expect(result.documents[0]?.work_uri).toBe(
      'http://publications.europa.eu/resource/cellar/old-untitled-work',
    );
  });

  // --- Empty-string optional filters from form clients (issue #15) ---

  it('accepts "" for every constrained optional filter and runs unfiltered', async () => {
    const ctx = createMockContext({ errors: eurlex_search_documents.errors });
    mockQuery.mockResolvedValue([makeDocBinding('32016R0679')]);

    // The shape a form client sends when optional fields are left blank — must not
    // throw -32602.
    const input = eurlex_search_documents.input.parse({
      keyword: 'data protection',
      document_type: '',
      date_from: '',
      date_to: '',
      eurovoc_concept: '',
    });
    const result = await eurlex_search_documents.handler(input, ctx);

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    // Blank filters contribute no clauses.
    expect(sparql).not.toContain('FILTER(?type =');
    expect(sparql).not.toContain('xsd:date');
    expect(sparql).not.toContain('cdm:work_is_about_concept_eurovoc');
    // Blank filters are absent from the echo; the real keyword survives.
    expect(result.query_echo.document_type).toBeUndefined();
    expect(result.query_echo.date_from).toBeUndefined();
    expect(result.query_echo.date_to).toBeUndefined();
    expect(result.query_echo.eurovoc_concept).toBeUndefined();
    expect(result.query_echo.keyword).toBe('data protection');
  });

  it('a real eurovoc_concept and document_type still filter', async () => {
    const ctx = createMockContext({ errors: eurlex_search_documents.errors });
    mockQuery.mockResolvedValue([makeDocBinding('32016R0679')]);

    const input = eurlex_search_documents.input.parse({
      eurovoc_concept: 'http://eurovoc.europa.eu/2828',
      document_type: 'REG',
    });
    await eurlex_search_documents.handler(input, ctx);

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sparql).toContain('cdm:work_is_about_concept_eurovoc <http://eurovoc.europa.eu/2828>');
    expect(sparql).toContain('resource-type/REG');
  });

  it('keeps the format constraint for non-empty filter values', () => {
    // "" is accepted, but a non-empty value must still satisfy its constraint.
    expect(() => eurlex_search_documents.input.parse({ eurovoc_concept: 'not-a-uri' })).toThrow();
    expect(() => eurlex_search_documents.input.parse({ date_from: '2016' })).toThrow();
    expect(() => eurlex_search_documents.input.parse({ document_type: 'NOPE' })).toThrow();
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
