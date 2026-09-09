/**
 * @fileoverview Tests for eurlex_search_documents tool.
 * @module tests/tools/eurlex-search-documents.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eurlex_search_documents } from '@/mcp-server/tools/definitions/eurlex-search-documents.tool.js';
import { escapeSparqlLiteral } from '@/services/cellar-sparql/eli-resolution.js';

const RESOURCE_TYPE_BASE = 'http://publications.europa.eu/resource/authority/resource-type/';

const EXPECTED_DOCUMENT_TYPE_FAMILIES = {
  REG: ['REG', 'REG_ADOPT_INTERNATION', 'REG_DEL', 'REG_FINANC', 'REG_IMPL'],
  DIR: ['DIR', 'DIR_DEL', 'DIR_IMPL'],
  DEC: ['DEC', 'DEC_ADOPT_INTERNATION', 'DEC_DEL', 'DEC_ENTSCHEID', 'DEC_FRAMW', 'DEC_IMPL'],
  TREATY: ['TREATY'],
  JUDG: ['JUDG'],
  OPIN_AG: ['OPIN_AG', 'VIEW_AG'],
  PROP: [
    'AMEND_PROP',
    'AMEND_PROP_DEC',
    'AMEND_PROP_DIR',
    'AMEND_PROP_REG',
    'JOINT_PROP_DEC',
    'JOINT_PROP_REG',
    'PROP_ACT',
    'PROP_DEC',
    'PROP_DEC_IMPL',
    'PROP_DEC_NO_ADDRESSEE',
    'PROP_DIR',
    'PROP_DRAFT',
    'PROP_JOINT_ACTION',
    'PROP_OPIN',
    'PROP_RECO',
    'PROP_REG',
    'PROP_REG_IMPL',
    'PROP_RES',
  ],
  REC: ['RECO', 'RECO_ADOPT_INTERNATION', 'RECO_DEC', 'RECO_RECO', 'RECO_REG'],
} as const;

// --- Service mock ---
const mockQuery = vi.fn();
let mockMaxResults = 100;
vi.mock('@/services/cellar-sparql/cellar-sparql-service.js', () => ({
  getCellarSparqlService: () => ({
    query: mockQuery,
    queryWithContinuation: mockQuery,
    maxResults: mockMaxResults,
  }),
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
  beforeEach(() => {
    mockQuery.mockReset();
    mockMaxResults = 100;
  });

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

    const input = eurlex_search_documents.input.parse({
      keyword: 'regulation',
      offset: 20,
      limit: 10,
    });
    const result = await eurlex_search_documents.handler(input, ctx);

    expect(result.offset).toBe(20);
    // The public page stays at 10 while one additional row proves continuation.
    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sparql).toContain('LIMIT 11');
    expect(sparql).toContain('OFFSET 20');
  });

  it.each(Object.entries(EXPECTED_DOCUMENT_TYPE_FAMILIES))(
    'applies the verified %s authority-type family with exact VALUES membership',
    async (documentType, expectedCodes) => {
      const ctx = createMockContext({ errors: eurlex_search_documents.errors });
      mockQuery.mockResolvedValue([makeDocBinding('32016L0680')]);

      const input = eurlex_search_documents.input.parse({ document_type: documentType });
      await eurlex_search_documents.handler(input, ctx);

      const sparql = mockQuery.mock.calls[0]?.[0] as string;
      const valuesBlock = /VALUES \?selectedType \{([^}]*)\}/.exec(sparql)?.[1] ?? '';
      const actualCodes = [...valuesBlock.matchAll(/resource-type\/([^>]+)>/g)].map(
        ([, code]) => code,
      );
      expect(actualCodes).toEqual(expectedCodes);
    },
  );

  it('keeps drafts and lookalike authority types outside finalized-act families', async () => {
    const ctx = createMockContext({ errors: eurlex_search_documents.errors });
    mockQuery.mockResolvedValue([makeDocBinding('32026R1844')]);

    await eurlex_search_documents.handler(
      eurlex_search_documents.input.parse({ document_type: 'REG' }),
      ctx,
    );

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sparql).not.toContain(`<${RESOURCE_TYPE_BASE}REG_DRAFT>`);
    expect(sparql).not.toContain(`<${RESOURCE_TYPE_BASE}REG_IMPL_DRAFT>`);
    expect(sparql).not.toContain(`<${RESOURCE_TYPE_BASE}DIRECTORY>`);
  });

  it('targets live RECO types instead of the unbound REC_SOFT code', async () => {
    const ctx = createMockContext({ errors: eurlex_search_documents.errors });
    mockQuery.mockResolvedValue([makeDocBinding('32026H1835')]);

    await eurlex_search_documents.handler(
      eurlex_search_documents.input.parse({ document_type: 'REC' }),
      ctx,
    );

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sparql).toContain(`<${RESOURCE_TYPE_BASE}RECO>`);
    expect(sparql).not.toContain(`<${RESOURCE_TYPE_BASE}REC_SOFT>`);
    expect(sparql).not.toContain(`<${RESOURCE_TYPE_BASE}RECO_DRAFT>`);
  });

  it('returns and renders a newly admitted sibling type with its human-readable label', async () => {
    const ctx = createMockContext({ errors: eurlex_search_documents.errors });
    mockQuery.mockResolvedValue([
      makeDocBinding('32011L0042', {
        types: `${RESOURCE_TYPE_BASE}DIR_IMPL`,
        title: 'Implementing directive example',
      }),
    ]);

    const result = await eurlex_search_documents.handler(
      eurlex_search_documents.input.parse({ document_type: 'DIR' }),
      ctx,
    );

    expect(result.documents[0]?.resource_type).toBe('Implementing Directive');
    const text = (eurlex_search_documents.format!(result)[0] as { text: string }).text;
    expect(text).toContain('**Type:** Implementing Directive');
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
      data: {
        reason: 'no_results',
        recovery: {
          hint: 'Broaden the search by removing filters, trying a shorter keyword, or expanding the date range.',
        },
      },
    });
  });

  it('returns an empty successful page when an offset is past the end of the result set', async () => {
    const ctx = createMockContext({ errors: eurlex_search_documents.errors });
    mockQuery.mockResolvedValue([]);

    const input = eurlex_search_documents.input.parse({ keyword: 'data', offset: 10_000 });
    const result = await eurlex_search_documents.handler(input, ctx);

    expect(result).toMatchObject({
      documents: [],
      total: 0,
      offset: 10_000,
      has_more: false,
      query_echo: { keyword: 'data', include_consolidated: false },
    });
    expect(result.next_offset).toBeUndefined();
    expect(getEnrichment(ctx).truncated).toBeUndefined();
    expect((eurlex_search_documents.format!(result)[0] as { text: string }).text).toContain(
      '**Has more:** false',
    );
    expect(mockQuery.mock.calls[0]?.[0]).toContain('OFFSET 10000');
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

  // --- #62: keyword CELEX arm escaping routes through the shared helper ---
  //
  // The former hand-rolled `keywordInput.toLowerCase().replace(/"/g, '\\"')` was a
  // quote-only pass with no backslash pass. A keyword ending in `\` then escaped
  // the closing quote of the CELEX arm's literal, the literal never terminated,
  // and Virtuoso's raw SP030 compiler error — carrying the internal query text and
  // PREFIX block — reached the client in place of this tool's own result. The
  // built query text is the discriminating assertion: a mocked query returns its
  // fixture whatever it is handed, so asserting on the result alone proves nothing.

  it('escapes a trailing backslash in the keyword CELEX arm (#62)', async () => {
    const ctx = createMockContext({ errors: eurlex_search_documents.errors });
    mockQuery.mockResolvedValue([makeDocBinding('32016R0679')]);

    const keyword = 'data\\';
    const input = eurlex_search_documents.input.parse({ keyword });
    await eurlex_search_documents.handler(input, ctx);

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    // The CELEX arm lowercases before escaping, so the helper sees the lowercased value.
    expect(sparql).toContain(
      `CONTAINS(LCASE(STR(?kwCelex)), "${escapeSparqlLiteral(keyword.toLowerCase())}")`,
    );
    // The unterminated form the quote-only pass produced is gone.
    expect(sparql).not.toContain(String.raw`"data\"))`);
    // The full-text arm strips the backslash independently, so the UNION still
    // matches on the sanitized phrase — a backslash keyword is a normal search,
    // not an error and not necessarily an empty result.
    expect(sparql).toContain(`bif:contains "'data'"`);
  });

  it('escapes an embedded quote-and-backslash sequence in the keyword (#62)', async () => {
    const ctx = createMockContext({ errors: eurlex_search_documents.errors });
    mockQuery.mockResolvedValue([makeDocBinding('32016R0679')]);

    const keyword = 'data\\" x';
    const input = eurlex_search_documents.input.parse({ keyword });
    await eurlex_search_documents.handler(input, ctx);

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sparql).toContain(
      `CONTAINS(LCASE(STR(?kwCelex)), "${escapeSparqlLiteral(keyword.toLowerCase())}")`,
    );
    // Every backslash and quote from the input is escaped, so the only unescaped
    // double quotes in the arm are the literal's own delimiters.
    expect(sparql).not.toContain(String.raw`"data\\" x"`);
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
    expect(sparql).toMatch(/GROUP BY \?celexNumber[\s\S]*LIMIT 3/);
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
    expect(() => eurlex_search_documents.input.parse({ keyword: 'data', limit: 101 })).toThrow();
    expect(() => eurlex_search_documents.input.parse({ keyword: 'data', offset: -1 })).toThrow();
  });

  // --- No-filter guard + whitespace-only keyword normalization (issue #25) ---

  it('rejects a whitespace-only keyword with no other filter (issue #25)', async () => {
    const ctx = createMockContext({ errors: eurlex_search_documents.errors });

    const input = eurlex_search_documents.input.parse({ keyword: '   ', limit: 3 });
    await expect(eurlex_search_documents.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'no_filters' },
    });
    // Fails fast — never issues the broad, unbounded query that timed out in the field report.
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('rejects a fully-empty request with no_filters (issue #25)', async () => {
    const ctx = createMockContext({ errors: eurlex_search_documents.errors });

    const input = eurlex_search_documents.input.parse({});
    await expect(eurlex_search_documents.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'no_filters' },
    });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('does not count include_consolidated as an effective filter (issue #25)', async () => {
    const ctx = createMockContext({ errors: eurlex_search_documents.errors });

    // include_consolidated broadens rather than narrows — on its own it must not
    // unlock an unbounded scan.
    const input = eurlex_search_documents.input.parse({ include_consolidated: true });
    await expect(eurlex_search_documents.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'no_filters' },
    });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('a whitespace-only keyword with another filter runs but is omitted from the echo (issue #25)', async () => {
    const ctx = createMockContext({ errors: eurlex_search_documents.errors });
    mockQuery.mockResolvedValue([makeDocBinding('32016R0679')]);

    const input = eurlex_search_documents.input.parse({ keyword: '   ', document_type: 'REG' });
    const result = await eurlex_search_documents.handler(input, ctx);

    // document_type is a real filter, so the query runs; the blank keyword adds no
    // clause and is absent from the echo (previously it echoed the raw whitespace).
    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sparql).not.toContain('bif:contains');
    expect(result.query_echo.keyword).toBeUndefined();
    expect(result.query_echo.document_type).toBe('REG');
  });

  it('echoes the trimmed keyword, not the raw padded value (issue #25)', async () => {
    const ctx = createMockContext({ errors: eurlex_search_documents.errors });
    mockQuery.mockResolvedValue([makeDocBinding('32016R0679')]);

    const input = eurlex_search_documents.input.parse({ keyword: '  data protection  ' });
    const result = await eurlex_search_documents.handler(input, ctx);

    expect(result.query_echo.keyword).toBe('data protection');
  });

  // --- Consolidated texts: include_consolidated filter + is_consolidated tag (issue #30) ---

  it('the default type-family join stays narrow and excludes CONS_TEXT (issues #30, #65)', async () => {
    const ctx = createMockContext({ errors: eurlex_search_documents.errors });
    mockQuery.mockResolvedValue([makeDocBinding('32014R0833')]);

    const input = eurlex_search_documents.input.parse({
      keyword: 'restrictive measures',
      document_type: 'REG',
    });
    await eurlex_search_documents.handler(input, ctx);

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sparql).toContain('VALUES ?selectedType {');
    expect(sparql).toContain('?work cdm:work_has_resource-type ?selectedType');
    expect(sparql).not.toContain('resource-type/CONS_TEXT');
  });

  it('include_consolidated admits only CONS_TEXT whose basic act is in the selected family (#66)', async () => {
    const ctx = createMockContext({ errors: eurlex_search_documents.errors });
    mockQuery.mockResolvedValue([makeDocBinding('02014R0833-20260424')]);

    const input = eurlex_search_documents.input.parse({
      keyword: 'restrictive measures',
      document_type: 'REG',
      include_consolidated: true,
    });
    const result = await eurlex_search_documents.handler(input, ctx);

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sparql).toContain('?work cdm:work_has_resource-type ?selectedType');
    expect(sparql).toContain(`?work cdm:work_has_resource-type <${RESOURCE_TYPE_BASE}CONS_TEXT>`);
    expect(sparql).toContain('cdm:act_consolidated_based_on_resource_legal ?basicAct');
    expect(sparql).toContain('?basicAct cdm:work_has_resource-type ?selectedType');
    // Live cross-family counterexample: 02007D0777-20150613 is based on the
    // DEC_ENTSCHEID work 32007D0777 but `consolidates` also reaches REG/REG_IMPL amendments.
    expect(sparql).not.toContain('cdm:act_consolidated_consolidates_resource_legal');
    // Live missing-duplicate counterexample: 02004R1356-20081127 has the correct
    // `based_on` edge to 32004R1356 without a matching `consolidates` edge.
    expect(sparql).not.toMatch(/based_on_resource_legal[\s\S]+consolidates_resource_legal/);

    expect(result.documents[0]).toMatchObject({
      celex_number: '02014R0833-20260424',
      is_consolidated: true,
    });
    const text = (eurlex_search_documents.format!(result)[0] as { text: string }).text;
    expect(text).toContain('### 02014R0833-20260424');
    expect(text).toContain('**Consolidated:** true');
  });

  it('include_consolidated adds no CONS_TEXT clause when document_type is omitted (issue #30)', async () => {
    const ctx = createMockContext({ errors: eurlex_search_documents.errors });
    mockQuery.mockResolvedValue([makeDocBinding('02014R0833-20260424')]);

    const input = eurlex_search_documents.input.parse({
      keyword: 'restrictive measures',
      include_consolidated: true,
    });
    await eurlex_search_documents.handler(input, ctx);

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    // No type filter at all — all types already return, so include_consolidated only
    // affects the row tag, not the query.
    expect(sparql).not.toContain('FILTER(?type =');
    expect(sparql).not.toContain('resource-type/CONS_TEXT');
  });

  it('tags a consolidated CELEX is_consolidated:true and a base act false (issue #30)', async () => {
    const ctx = createMockContext({ errors: eurlex_search_documents.errors });
    mockQuery.mockResolvedValue([
      makeDocBinding('02014R0833-20260424', { date: '2026-04-24' }),
      makeDocBinding('32014R0833', { date: '2014-07-31' }),
    ]);

    const input = eurlex_search_documents.input.parse({ keyword: '833/2014' });
    const result = await eurlex_search_documents.handler(input, ctx);

    expect(result.documents[0]?.celex_number).toBe('02014R0833-20260424');
    expect(result.documents[0]?.is_consolidated).toBe(true);
    expect(result.documents[1]?.celex_number).toBe('32014R0833');
    expect(result.documents[1]?.is_consolidated).toBe(false);
  });

  // --- #57: include_consolidated echoed in query_echo after the default is applied ---

  it('echoes the effective include_consolidated:false in query_echo and content[] on a default call (issue #57)', async () => {
    const ctx = createMockContext({ errors: eurlex_search_documents.errors });
    mockQuery.mockResolvedValue([makeDocBinding('32016R0679')]);

    const input = eurlex_search_documents.input.parse({ document_type: 'REG' });
    const result = await eurlex_search_documents.handler(input, ctx);

    // The false default still shapes which records can appear (consolidated texts
    // stay out), so it must be echoed even when the caller never supplied it —
    // pre-fix query_echo omits it entirely.
    expect(result.query_echo.include_consolidated).toBe(false);
    // structuredContent ↔ content[] parity: the flag surfaces in the filter summary.
    const text = (eurlex_search_documents.format!(result)[0] as { text: string }).text;
    expect(text).toContain('include_consolidated=false');
  });

  it('echoes include_consolidated:true in query_echo and content[] when the caller opts in (issue #57)', async () => {
    const ctx = createMockContext({ errors: eurlex_search_documents.errors });
    mockQuery.mockResolvedValue([makeDocBinding('02014R0833-20260424')]);

    // Mirrors the live-HTTP repro from #57: pre-fix this echoed only document_type
    // and date_from, dropping the include_consolidated the caller set.
    const input = eurlex_search_documents.input.parse({
      document_type: 'REG',
      include_consolidated: true,
      date_from: '2026-01-01',
      limit: 1,
    });
    const result = await eurlex_search_documents.handler(input, ctx);

    expect(result.query_echo.include_consolidated).toBe(true);
    expect(result.query_echo.document_type).toBe('REG');
    expect(result.query_echo.date_from).toBe('2026-01-01');
    const text = (eurlex_search_documents.format!(result)[0] as { text: string }).text;
    expect(text).toContain('include_consolidated=true');
  });

  // --- #72: proven continuation ---

  it('does not disclose continuation for an exactly-full final page', async () => {
    const ctx = createMockContext({ errors: eurlex_search_documents.errors });
    mockQuery.mockResolvedValue([makeDocBinding('32016R0679'), makeDocBinding('32022R0868')]);

    const input = eurlex_search_documents.input.parse({ keyword: 'data', limit: 2 });
    const result = await eurlex_search_documents.handler(input, ctx);

    expect(result.documents).toHaveLength(2);
    expect(result.has_more).toBe(false);
    expect(result.next_offset).toBeUndefined();
    expect(getEnrichment(ctx).truncated).toBeUndefined();
  });

  it('returns one-row continuation proof without exposing the sentinel row', async () => {
    const ctx = createMockContext({ errors: eurlex_search_documents.errors });
    mockQuery.mockResolvedValue([
      makeDocBinding('32016R0679'),
      makeDocBinding('32022R0868'),
      makeDocBinding('32024R0001'),
    ]);

    const input = eurlex_search_documents.input.parse({ keyword: 'data', limit: 2 });
    const result = await eurlex_search_documents.handler(input, ctx);

    expect(result.documents).toHaveLength(2);
    expect(result.has_more).toBe(true);
    expect(result.next_offset).toBe(2);
    expect(mockQuery.mock.calls[0]?.[0]).toContain('LIMIT 3');
    expect(getEnrichment(ctx)).toMatchObject({ truncated: true, shown: 2, cap: 2 });
    const text = (eurlex_search_documents.format!(result)[0] as { text: string }).text;
    expect(text).toContain('**Has more:** true');
    expect(text).toContain('**Next offset:** 2');
  });

  it('uses the service ceiling as the effective page size when it is lower than limit', async () => {
    const ctx = createMockContext({ errors: eurlex_search_documents.errors });
    mockMaxResults = 2;
    mockQuery.mockResolvedValue([
      makeDocBinding('32016R0679'),
      makeDocBinding('32022R0868'),
      makeDocBinding('32024R0001'),
    ]);

    const input = eurlex_search_documents.input.parse({ keyword: 'data', limit: 100 });
    const result = await eurlex_search_documents.handler(input, ctx);

    expect(result.documents).toHaveLength(2);
    expect(result.has_more).toBe(true);
    expect(result.next_offset).toBe(2);
    expect(mockQuery.mock.calls[0]?.[0]).toContain('LIMIT 3');
    expect(getEnrichment(ctx)).toMatchObject({ truncated: true, shown: 2, cap: 2 });
  });

  it('does not disclose continuation when the page is short of the limit', async () => {
    const ctx = createMockContext({ errors: eurlex_search_documents.errors });
    mockQuery.mockResolvedValue([makeDocBinding('32016R0679')]);

    const input = eurlex_search_documents.input.parse({ keyword: 'data', limit: 2 });
    const result = await eurlex_search_documents.handler(input, ctx);

    expect(result.has_more).toBe(false);
    expect(result.next_offset).toBeUndefined();
    expect(getEnrichment(ctx).truncated).toBeUndefined();
  });

  // --- Format ---

  it('format renders celex, date, type label, consolidated flag, and work_uri', () => {
    const output = {
      documents: [
        {
          work_uri: 'http://publications.europa.eu/resource/cellar/gdpr',
          celex_number: '32016R0679',
          is_consolidated: false,
          resource_type: 'Regulation',
          date: '2016-04-27',
          title: 'GDPR',
        },
      ],
      total: 1,
      offset: 0,
      has_more: false,
      query_echo: { keyword: 'gdpr', include_consolidated: false },
    };
    const blocks = eurlex_search_documents.format!(output);
    expect(blocks[0]?.type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('32016R0679');
    expect(text).toContain('2016-04-27');
    expect(text).toContain('Regulation');
    // The boolean VALUE reaches the text channel (format-parity), not just a guarded marker.
    expect(text).toContain('**Consolidated:** false');
    expect(text).toContain('http://publications.europa.eu/resource/cellar/gdpr');
    expect(text).toContain('keyword="gdpr"');
    expect(text).toContain('**Has more:** false');
  });

  it('format renders is_consolidated:true for a consolidated row', () => {
    const output = {
      documents: [
        {
          work_uri: 'http://publications.europa.eu/resource/cellar/cons',
          celex_number: '02014R0833-20260424',
          is_consolidated: true,
          resource_type: 'CONS_TEXT',
          date: '2026-04-24',
        },
      ],
      total: 1,
      offset: 0,
      has_more: false,
      query_echo: { include_consolidated: false },
    };
    const blocks = eurlex_search_documents.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('**Consolidated:** true');
  });

  it('format handles sparse documents (no type, date, or title)', () => {
    const output = {
      documents: [
        {
          work_uri: 'http://publications.europa.eu/resource/cellar/sparse',
          celex_number: '12345ABC',
          is_consolidated: false,
        },
      ],
      total: 1,
      offset: 0,
      has_more: false,
      query_echo: { include_consolidated: false },
    };
    const blocks = eurlex_search_documents.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('12345ABC');
  });

  // --- #60: control characters in eurovoc_concept must not reach the SPARQL IRI ---

  describe('control characters in eurovoc_concept (#60)', () => {
    const EUROVOC_URI = 'http://eurovoc.europa.eu/2828';

    /**
     * eurovoc_concept is interpolated into `<${…}> .` as a subject filter, so an
     * IRI-forbidden character builds a malformed IRI and leaks Virtuoso's compiler
     * error — with the internal query text attached — in place of the tool's own
     * error. Confirmed live for a newline and for `<`. The guard this replaced tested
     * only for `>`, `"` and a literal space; it omitted `<` entirely, so the opening
     * bracket that terminates the IRI early passed straight through.
     */
    it.each([
      ['a newline', `${EUROVOC_URI}\nX`],
      ['a tab', `${EUROVOC_URI}\tX`],
      ['a carriage return', `${EUROVOC_URI}\rX`],
      ['a space', `${EUROVOC_URI} X`],
      ['an opening angle bracket', `${EUROVOC_URI}<X`],
      ['a closing angle bracket', `${EUROVOC_URI}>X`],
      ['a double quote', `${EUROVOC_URI}"X`],
    ])('rejects a eurovoc_concept containing %s at the schema, before any query', (_label, uri) => {
      expect(() => eurlex_search_documents.input.parse({ eurovoc_concept: uri })).toThrow();
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('still accepts a legitimate eurovoc_concept, and "" for an omitted filter', () => {
      expect(() =>
        eurlex_search_documents.input.parse({ eurovoc_concept: EUROVOC_URI }),
      ).not.toThrow();
      expect(() => eurlex_search_documents.input.parse({ eurovoc_concept: '' })).not.toThrow();
    });
  });

  // --- #77: impossible calendar dates and inverted ranges ---

  describe('date-range validity (#77)', () => {
    it.each([
      ['an impossible month and day', '2026-99-99'],
      ['month 13', '2026-13-01'],
      ['day 00', '2026-01-00'],
      ['a leap day in a common year', '2023-02-29'],
    ])('rejects %s in date_from before any CELLAR request', async (_label, value) => {
      const ctx = createMockContext({ errors: eurlex_search_documents.errors });

      const input = eurlex_search_documents.input.parse({ date_from: value, limit: 1 });
      const err = await Promise.resolve(eurlex_search_documents.handler(input, ctx)).catch(
        (e: unknown) => e,
      );

      expect(err).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'invalid_date_range' },
      });
      // The message names the offending field and value, not a generic complaint.
      expect((err as { message: string }).message).toContain('date_from');
      expect((err as { message: string }).message).toContain(value);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('rejects an impossible date in date_to and names that field', async () => {
      const ctx = createMockContext({ errors: eurlex_search_documents.errors });

      const input = eurlex_search_documents.input.parse({ date_to: '2026-13-01', limit: 1 });
      const err = await Promise.resolve(eurlex_search_documents.handler(input, ctx)).catch(
        (e: unknown) => e,
      );

      expect(err).toMatchObject({ data: { reason: 'invalid_date_range' } });
      expect((err as { message: string }).message).toContain('date_to');
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('diagnoses a bad date as invalid_date_range, never as no_filters', async () => {
      const ctx = createMockContext({ errors: eurlex_search_documents.errors });

      // The date is the only filter supplied, so a check placed after the
      // no-filter gate would report the wrong cause: the caller did filter, the
      // filter was just invalid.
      const input = eurlex_search_documents.input.parse({ date_from: '2026-99-99' });
      const err = await Promise.resolve(eurlex_search_documents.handler(input, ctx)).catch(
        (e: unknown) => e,
      );

      expect((err as { data: { reason: string } }).data.reason).toBe('invalid_date_range');
      expect((err as { data: { reason: string } }).data.reason).not.toBe('no_filters');
    });

    it('accepts the leap day 2024-02-29 and builds its filter clause', async () => {
      const ctx = createMockContext({ errors: eurlex_search_documents.errors });
      mockQuery.mockResolvedValue([makeDocBinding('32016R0679')]);

      const input = eurlex_search_documents.input.parse({ date_from: '2024-02-29', limit: 1 });
      await eurlex_search_documents.handler(input, ctx);

      expect(mockQuery.mock.calls[0]?.[0] as string).toContain('"2024-02-29"^^xsd:date');
    });

    it('names the expected date shape when the schema rejects a malformed date', () => {
      // The shape gate fires before the handler, so its own message is the only
      // guidance the caller gets — a bare "Invalid string" leaves them guessing.
      const parsed = eurlex_search_documents.input.safeParse({ date_from: '2016-5-4', limit: 1 });
      expect(parsed.success).toBe(false);
      expect(JSON.stringify(parsed.error?.issues)).toContain(
        'date_from must be a calendar date in YYYY-MM-DD form, zero-padded (e.g. 2016-05-04).',
      );
    });

    it('rejects an inverted range and says so', async () => {
      const ctx = createMockContext({ errors: eurlex_search_documents.errors });

      const input = eurlex_search_documents.input.parse({
        date_from: '2020-12-31',
        date_to: '2020-01-01',
        limit: 1,
      });
      const err = await Promise.resolve(eurlex_search_documents.handler(input, ctx)).catch(
        (e: unknown) => e,
      );

      expect(err).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'invalid_date_range' },
      });
      expect((err as { message: string }).message).toContain('inverted');
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('accepts equal endpoints as a valid single-day range', async () => {
      const ctx = createMockContext({ errors: eurlex_search_documents.errors });
      mockQuery.mockResolvedValue([makeDocBinding('32016R0679')]);

      const input = eurlex_search_documents.input.parse({
        date_from: '2020-01-01',
        date_to: '2020-01-01',
        limit: 1,
      });
      await eurlex_search_documents.handler(input, ctx);

      const sparql = mockQuery.mock.calls[0]?.[0] as string;
      expect(sparql).toContain('FILTER(?date >= "2020-01-01"^^xsd:date)');
      expect(sparql).toContain('FILTER(?date <= "2020-01-01"^^xsd:date)');
    });

    it('leaves date_to alone as a valid single-bound filter', async () => {
      const ctx = createMockContext({ errors: eurlex_search_documents.errors });
      mockQuery.mockResolvedValue([makeDocBinding('32016R0679')]);

      const input = eurlex_search_documents.input.parse({ date_to: '2020-01-01', limit: 1 });
      const result = await eurlex_search_documents.handler(input, ctx);

      const sparql = mockQuery.mock.calls[0]?.[0] as string;
      expect(sparql).toContain('FILTER(?date <= "2020-01-01"^^xsd:date)');
      expect(sparql).not.toContain('FILTER(?date >= ');
      expect(result.query_echo.date_to).toBe('2020-01-01');
      expect(result.query_echo.date_from).toBeUndefined();
    });

    it('runs no calendar check on blank date fields, which stay out of the echo', async () => {
      const ctx = createMockContext({ errors: eurlex_search_documents.errors });
      mockQuery.mockResolvedValue([makeDocBinding('32016R0679')]);

      const input = eurlex_search_documents.input.parse({
        keyword: 'data protection',
        date_from: '',
        date_to: '',
      });
      const result = await eurlex_search_documents.handler(input, ctx);

      expect(mockQuery.mock.calls[0]?.[0] as string).not.toContain('xsd:date');
      expect(result.query_echo.date_from).toBeUndefined();
      expect(result.query_echo.date_to).toBeUndefined();
    });

    it.each([
      ['a year alone', '2016'],
      ['a single-digit month and day', '2026-2-9'],
      ['a leading-whitespace value', ' 2026-01-01'],
      ['a trailing-whitespace value', '2026-01-01 '],
    ])('still rejects %s at the schema, not the handler', (_label, value) => {
      expect(() => eurlex_search_documents.input.parse({ date_from: value })).toThrow();
      expect(() => eurlex_search_documents.input.parse({ date_to: value })).toThrow();
    });

    /**
     * Both public surfaces must carry the diagnosis: Claude Code reads
     * structuredContent, Claude Desktop reads content[]. Driving the definition
     * through the real handler factory is what proves the pair, rather than
     * inspecting the thrown error alone.
     */
    it('reaches the caller on both content[] and structuredContent.error', async () => {
      const result = await runToolContract(eurlex_search_documents, {
        date_from: '2026-99-99',
        limit: 1,
      });

      expect(result.isError).toBe(true);
      const structured = result.structuredContent as {
        error?: {
          code?: number;
          message?: string;
          data?: { reason?: string; recovery?: { hint?: string } };
        };
      };
      expect(structured.error?.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(structured.error?.data?.reason).toBe('invalid_date_range');
      expect(structured.error?.data?.recovery?.hint).toContain('YYYY-MM-DD');

      const text = result.content
        .map((block) => (block as { text?: string }).text ?? '')
        .join('\n');
      expect(text).toContain('2026-99-99');
      expect(text).toContain(structured.error?.data?.recovery?.hint as string);
    });
  });
});
