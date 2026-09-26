/**
 * @fileoverview Tests for eurlex_search_documents tool.
 * @module tests/tools/eurlex-search-documents.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eurlex_search_documents } from '@/mcp-server/tools/definitions/eurlex-search-documents.tool.js';
import { canonicalWork, celexWorkRows, fixtureWork } from '../fixtures/cellar-works.js';

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

/** Every text block of a tool result's content[], joined. */
function contentText(result: { content: unknown[] }): string {
  return result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
}

/** The grouped search queries issued, without the page's follow-up work resolution. */
function searchQueries(): string[] {
  return mockQuery.mock.calls
    .map((c) => c[0] as string)
    .filter((q) => q.includes('GROUP BY ?celexNumber'));
}

/** `sparql` with every balanced `FILTER EXISTS { … }` block cut out: the patterns it joins. */
function withoutFilterExists(sparql: string): string {
  let rest = sparql;
  for (let start = rest.indexOf('FILTER EXISTS {'); start !== -1; ) {
    let depth = 0;
    let end = rest.indexOf('{', start);
    for (; end < rest.length; end++) {
      if (rest[end] === '{') depth++;
      else if (rest[end] === '}' && --depth === 0) break;
    }
    rest = rest.slice(0, start) + rest.slice(end + 1);
    start = rest.indexOf('FILTER EXISTS {');
  }
  return rest;
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

  it('returns an empty first page with a broadening notice when query returns empty bindings', async () => {
    const ctx = createMockContext({ errors: eurlex_search_documents.errors });
    mockQuery.mockResolvedValue([]);

    const input = eurlex_search_documents.input.parse({ keyword: 'nonexistent-term-xyz' });
    const result = await eurlex_search_documents.handler(input, ctx);

    expect(result).toMatchObject({ documents: [], total: 0, offset: 0, has_more: false });
    expect(result.next_offset).toBeUndefined();
    expect(getEnrichment(ctx).notice).toContain(
      'Broaden the search by removing filters, trying a shorter keyword, or expanding the date range.',
    );
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

  it('carries no notice on either surface for a page past the end (#112)', async () => {
    mockQuery.mockResolvedValue([]);

    const result = await runToolContract(eurlex_search_documents, {
      keyword: 'data',
      offset: 10_000,
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      documents: [],
      total: 0,
      offset: 10_000,
      has_more: false,
      query_echo: { keyword: 'data' },
    });
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(result.structuredContent).not.toHaveProperty('next_offset');
    expect(contentText(result)).not.toMatch(/^> /m);
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

  it('throws invalid_author_institution for an author that sanitizes to empty (no queryable institution)', async () => {
    const ctx = createMockContext({ errors: eurlex_search_documents.errors });

    const input = eurlex_search_documents.input.parse({ author_institution: '!!!' });
    await expect(eurlex_search_documents.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_author_institution' },
    });
    // Degenerate author short-circuits before hitting CELLAR.
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('an impossible author yields an empty page when the constrained query returns no rows', async () => {
    const ctx = createMockContext({ errors: eurlex_search_documents.errors });
    mockQuery.mockResolvedValue([]);

    const input = eurlex_search_documents.input.parse({
      author_institution: 'zzzxxy-no-such-eu-author',
    });
    const result = await eurlex_search_documents.handler(input, ctx);

    expect(result).toMatchObject({ documents: [], total: 0, has_more: false });
    expect(getEnrichment(ctx).notice).toContain('author_institution=zzzxxy-no-such-eu-author');
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

  it('matches a partial CELEX in a UNION arm on the CELEX full-text index (issues #17, #105, #123)', async () => {
    const ctx = createMockContext({ errors: eurlex_search_documents.errors });
    // The exact-CELEX lookup finds no work carrying the fragment whole.
    mockQuery.mockImplementation(async (q: string) =>
      q.includes('GROUP BY ?celexNumber') ? [makeDocBinding('32016R0679')] : [],
    );

    const input = eurlex_search_documents.input.parse({ keyword: '2016R0679' });
    await eurlex_search_documents.handler(input, ctx);

    const [sparql] = searchQueries();
    // The CELEX arm re-binds the celex inside the UNION branch — a bare FILTER on
    // the outer ?celexNumber would evaluate out of scope there and match nothing.
    expect(sparql).toContain('UNION');
    expect(sparql).toContain('cdm:resource_legal_id_celex ?kwCelex');
    expect(sparql).toContain(`?kwCelex bif:contains "'02016R0679*' OR '12016R0679*'`);
    expect(sparql).toContain('FILTER(CONTAINS(STR(?kwCelex), "2016R0679"))');
    expect(sparql).not.toContain('CONTAINS(LCASE(STR(?kwCelex))');
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

  it('rejects a keyword that sanitizes to empty as invalid_keyword, sending nothing (issues #17, #105)', async () => {
    const ctx = createMockContext({ errors: eurlex_search_documents.errors });
    mockQuery.mockResolvedValue([makeDocBinding('32016R0679')]);

    const input = eurlex_search_documents.input.parse({ keyword: '()' });
    // An all-punctuation keyword has no full-text phrase and no digit a CELEX could
    // hold, so no document can match it: the input is at fault, not the corpus.
    await expect(eurlex_search_documents.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_keyword' },
    });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  // --- #62: a keyword's quote or backslash never reaches a SPARQL literal ---
  //
  // The former hand-rolled `keywordInput.toLowerCase().replace(/"/g, '\\"')` was a
  // quote-only pass with no backslash pass. A keyword ending in `\` then escaped
  // the closing quote of the CELEX arm's literal, the literal never terminated,
  // and Virtuoso's raw SP030 compiler error — carrying the internal query text and
  // PREFIX block — reached the client in place of this tool's own result. Since
  // #105 a keyword holding a character no CELEX contains builds no CELEX arm at
  // all, and the full-text arm strips punctuation, so no raw input survives. The
  // built query text is the discriminating assertion: a mocked query returns its
  // fixture whatever it is handed, so asserting on the result alone proves nothing.

  it('keeps a trailing backslash out of the query (#62)', async () => {
    const ctx = createMockContext({ errors: eurlex_search_documents.errors });
    mockQuery.mockResolvedValue([makeDocBinding('32016R0679')]);

    const keyword = 'data\\';
    const input = eurlex_search_documents.input.parse({ keyword });
    await eurlex_search_documents.handler(input, ctx);

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sparql).not.toContain('?kwCelex');
    expect(sparql).not.toContain('data\\');
    // The full-text arm strips the backslash, so a backslash keyword is a normal
    // title search, not an error and not necessarily an empty result.
    expect(sparql).toContain(`bif:contains "'data'"`);
  });

  it('keeps an embedded quote-and-backslash sequence out of the query (#62)', async () => {
    const ctx = createMockContext({ errors: eurlex_search_documents.errors });
    mockQuery.mockResolvedValue([makeDocBinding('32016R0679')]);

    const keyword = '2016\\" x';
    const input = eurlex_search_documents.input.parse({ keyword });
    await eurlex_search_documents.handler(input, ctx);

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sparql).not.toContain('?kwCelex');
    expect(sparql).not.toContain('2016\\"');
    expect(sparql).toContain(`bif:contains "'2016 x'"`);
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
    // CORRIGENDUM carries a curated label (#86); BUDGET has none, so it still falls
    // back to its raw authority code, and the two forms coexist on one row.
    expect(result.documents[0]?.resource_type).toBe('BUDGET, Corrigendum');
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

  it('orders the page by date, then CELEX, so documents sharing a date keep one order (#102)', async () => {
    const ctx = createMockContext({ errors: eurlex_search_documents.errors });
    mockQuery.mockResolvedValue([makeDocBinding('32024R0900', { date: '2024-03-29' })]);

    await eurlex_search_documents.handler(
      eurlex_search_documents.input.parse({
        date_from: '2024-03-01',
        date_to: '2024-03-31',
        offset: 20,
      }),
      ctx,
    );

    const [sparql] = searchQueries();
    // The tiebreak is the GROUP BY key: Virtuoso does not sort on the projected
    // SAMPLE alias ?celex, so ordering by it leaves same-date rows unordered. The
    // date range pages first (#105), so the page keys and the rows share the order.
    expect(sparql).toMatch(
      /\} GROUP BY \?celexNumber ORDER BY DESC\(\?pageDate\) \?celexNumber LIMIT 21 OFFSET 20\n/,
    );
    expect(sparql).toMatch(/\} GROUP BY \?celexNumber ORDER BY DESC\(\?docDate\) \?celexNumber$/);
    expect(sparql).not.toMatch(/ORDER BY[^\n]*\?celex\b/);
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

  // --- in_force filter (#82) ---

  describe('in_force filter (#82)', () => {
    it('in_force:true binds the in-force property and filters on it', async () => {
      const ctx = createMockContext({ errors: eurlex_search_documents.errors });
      mockQuery.mockResolvedValue([makeDocBinding('32016R0679')]);

      const input = eurlex_search_documents.input.parse({
        document_type: 'REG',
        in_force: true,
      });
      const result = await eurlex_search_documents.handler(input, ctx);

      const sparql = mockQuery.mock.calls[0]?.[0] as string;
      // The property is OPTIONAL-bound, so a work that never carries it leaves
      // ?inForce unbound and the FILTER drops it — the positive filter's semantics.
      expect(sparql).toContain('OPTIONAL { ?work cdm:resource_legal_in-force ?inForce . }');
      expect(sparql).toContain('FILTER(?inForce = true)');
      expect(result.query_echo.in_force).toBe(true);
    });

    it('in_force:true alone is an effective filter and reaches CELLAR', async () => {
      const ctx = createMockContext({ errors: eurlex_search_documents.errors });
      mockQuery.mockResolvedValue([makeDocBinding('32016R0679')]);

      const input = eurlex_search_documents.input.parse({ in_force: true });
      await eurlex_search_documents.handler(input, ctx);

      // The search itself, then the page's work resolution (#97).
      expect(searchQueries()).toHaveLength(1);
    });

    it('omitting in_force builds neither the binding nor the filter', async () => {
      const ctx = createMockContext({ errors: eurlex_search_documents.errors });
      mockQuery.mockResolvedValue([makeDocBinding('32016R0679')]);

      const input = eurlex_search_documents.input.parse({ document_type: 'REG' });
      const result = await eurlex_search_documents.handler(input, ctx);

      const sparql = mockQuery.mock.calls[0]?.[0] as string;
      expect(sparql).not.toContain('cdm:resource_legal_in-force');
      expect(sparql).not.toContain('?inForce');
      expect(result.query_echo.in_force).toBeUndefined();
    });

    it('in_force:false applies the negative filter, mirroring the positive one', async () => {
      const ctx = createMockContext({ errors: eurlex_search_documents.errors });
      mockQuery.mockResolvedValue([makeDocBinding('32016R0679')]);

      const input = eurlex_search_documents.input.parse({
        document_type: 'REG',
        in_force: false,
      });
      const result = await eurlex_search_documents.handler(input, ctx);

      const sparql = mockQuery.mock.calls[0]?.[0] as string;
      // CELLAR can express the negative — the bound value serialises as an
      // xsd:integer 0/1 and the comparison coerces — so `false` must build the
      // same binding-plus-FILTER pair `true` does, not an empty clause.
      expect(sparql).toContain('OPTIONAL { ?work cdm:resource_legal_in-force ?inForce . }');
      expect(sparql).toContain('FILTER(?inForce = false)');
      expect(result.query_echo.in_force).toBe(false);
    });

    /**
     * The discriminating assertion for #82. The echo alone proves nothing: it
     * copied any defined value whether or not the value shaped the query, so a
     * `query_echo.in_force === false` assertion passed against the unfixed code.
     * Comparing the two generated queries is what catches a filter that is
     * accepted, echoed, and then silently dropped — pre-fix the two strings are
     * byte-identical.
     */
    it('in_force:false builds a different query than omitting in_force (#82)', async () => {
      const ctx = createMockContext({ errors: eurlex_search_documents.errors });
      mockQuery.mockResolvedValue([makeDocBinding('32016R0679')]);

      const base = { document_type: 'REG', date_from: '2024-06-01', date_to: '2024-12-31' };
      await eurlex_search_documents.handler(eurlex_search_documents.input.parse(base), ctx);
      await eurlex_search_documents.handler(
        eurlex_search_documents.input.parse({ ...base, in_force: false }),
        ctx,
      );

      const [withoutFlag, withFalse] = searchQueries();
      expect(withFalse).not.toBe(withoutFlag);
      expect(withoutFlag).not.toContain('?inForce');
      expect(withFalse).toContain('FILTER(?inForce = false)');
    });

    it('in_force:false alone is an effective filter, not a no_filters rejection (#82)', async () => {
      const ctx = createMockContext({ errors: eurlex_search_documents.errors });
      mockQuery.mockResolvedValue([makeDocBinding('31995L0046')]);

      const input = eurlex_search_documents.input.parse({ in_force: false });
      const result = await eurlex_search_documents.handler(input, ctx);

      // A standalone in-force filter is bounded — the property is carried by a
      // small slice of the corpus, not by all 2.7M works — so it narrows enough
      // to stand on its own, exactly as `in_force: true` already does.
      expect(searchQueries()).toHaveLength(1);
      expect(searchQueries()[0]).toContain('FILTER(?inForce = false)');
      expect(result.query_echo.in_force).toBe(false);
    });

    it('carries in_force:false onto content[] as well as structuredContent (#82)', async () => {
      const ctx = createMockContext({ errors: eurlex_search_documents.errors });
      mockQuery.mockResolvedValue([makeDocBinding('31995L0046', { date: '1995-10-24' })]);

      const input = eurlex_search_documents.input.parse({
        document_type: 'DIR',
        in_force: false,
      });
      const result = await eurlex_search_documents.handler(input, ctx);

      const text = (eurlex_search_documents.format!(result)[0] as { text: string }).text;
      expect(text).toContain('in_force=false');
    });

    /**
     * Widening the effective-filter gate from `=== true` to `!== undefined` is
     * exactly the change that can accidentally unlock the unbounded corpus scan,
     * because an omitted optional boolean is `undefined` rather than absent from
     * the parsed input. These pin the other side of the gate.
     */
    it('leaves the no-filter path closed after the gate is widened (#82)', async () => {
      const ctx = createMockContext({ errors: eurlex_search_documents.errors });

      const input = eurlex_search_documents.input.parse({});
      expect(input.in_force).toBeUndefined();
      await expect(eurlex_search_documents.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'no_filters' },
      });
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('still rejects a broadening-flags-only request after the gate is widened (#82)', async () => {
      const ctx = createMockContext({ errors: eurlex_search_documents.errors });

      const input = eurlex_search_documents.input.parse({
        include_consolidated: true,
        include_corrigenda: true,
      });
      await expect(eurlex_search_documents.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'no_filters' },
      });
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  // --- Corrigenda excluded by default behind include_corrigenda (#83) ---

  describe('corrigenda exclusion (#83)', () => {
    const CORRIGENDUM_URI = `${RESOURCE_TYPE_BASE}CORRIGENDUM`;

    it('excludes CORRIGENDUM works from the default result set', async () => {
      const ctx = createMockContext({ errors: eurlex_search_documents.errors });
      mockQuery.mockResolvedValue([makeDocBinding('32024R1689')]);

      const input = eurlex_search_documents.input.parse({
        document_type: 'REG',
        date_from: '2024-06-01',
        date_to: '2024-12-31',
      });
      const result = await eurlex_search_documents.handler(input, ctx);

      const sparql = mockQuery.mock.calls[0]?.[0] as string;
      // A corrigendum is co-typed CORRIGENDUM plus a base type, so it satisfies
      // every document_type family and — carrying a recent work date — sorts
      // ahead of the acts it corrects. Without the exclusion it crowds primary
      // acts off the page.
      expect(sparql).toContain(
        `FILTER NOT EXISTS { ?work cdm:work_has_resource-type <${CORRIGENDUM_URI}> . }`,
      );
      expect(result.query_echo.include_corrigenda).toBe(false);
    });

    it('include_corrigenda:true drops the exclusion and re-admits the rows', async () => {
      const ctx = createMockContext({ errors: eurlex_search_documents.errors });
      mockQuery.mockResolvedValue([
        makeDocBinding('32024R2764R(01)', {
          date: '2025-11-19',
          types: `${RESOURCE_TYPE_BASE}REG_IMPL ${CORRIGENDUM_URI}`,
        }),
      ]);

      const input = eurlex_search_documents.input.parse({
        document_type: 'REG',
        include_corrigenda: true,
      });
      const result = await eurlex_search_documents.handler(input, ctx);

      const sparql = mockQuery.mock.calls[0]?.[0] as string;
      expect(sparql).not.toContain('FILTER NOT EXISTS');
      expect(result.documents[0]?.celex_number).toBe('32024R2764R(01)');
      expect(result.query_echo.include_corrigenda).toBe(true);
    });

    /**
     * Depth past the first level: a corrigendum is a genuinely co-typed work, so
     * the tag must come from membership in the GROUP_CONCAT type list rather than
     * from a single-valued type, and the row must still render every label it
     * carries (#86 governs which strings those are).
     */
    it('tags a co-typed corrigendum row is_corrigendum:true and keeps both labels', async () => {
      const ctx = createMockContext({ errors: eurlex_search_documents.errors });
      mockQuery.mockResolvedValue([
        makeDocBinding('32024R2764R(01)', {
          date: '2025-11-19',
          types: `${RESOURCE_TYPE_BASE}REG_IMPL ${CORRIGENDUM_URI}`,
        }),
      ]);

      const input = eurlex_search_documents.input.parse({
        document_type: 'REG',
        include_corrigenda: true,
      });
      const result = await eurlex_search_documents.handler(input, ctx);

      expect(result.documents[0]?.is_corrigendum).toBe(true);
      expect(result.documents[0]?.resource_type).toBe('Corrigendum, Implementing Regulation');
      const text = (eurlex_search_documents.format!(result)[0] as { text: string }).text;
      expect(text).toContain('**Corrigendum:** true');
      expect(text).toContain('**Type:** Corrigendum, Implementing Regulation');
    });

    it('tags a primary act is_corrigendum:false on both surfaces', async () => {
      const ctx = createMockContext({ errors: eurlex_search_documents.errors });
      mockQuery.mockResolvedValue([
        makeDocBinding('32016R0679', {
          date: '2016-04-27',
          types: `${RESOURCE_TYPE_BASE}REG`,
        }),
      ]);

      const input = eurlex_search_documents.input.parse({ document_type: 'REG' });
      const result = await eurlex_search_documents.handler(input, ctx);

      expect(result.documents[0]?.is_corrigendum).toBe(false);
      const text = (eurlex_search_documents.format!(result)[0] as { text: string }).text;
      expect(text).toContain('**Corrigendum:** false');
    });

    it('tags a row carrying no resource-type at all is_corrigendum:false', async () => {
      const ctx = createMockContext({ errors: eurlex_search_documents.errors });
      // Older works reach the projection with ?types unbound — the tag must be a
      // definite false, never undefined, so the boolean is always on the wire.
      mockQuery.mockResolvedValue([makeDocBinding('31958R0001')]);

      const input = eurlex_search_documents.input.parse({ document_type: 'REG' });
      const result = await eurlex_search_documents.handler(input, ctx);

      expect(result.documents[0]?.is_corrigendum).toBe(false);
      expect(result.documents[0]?.resource_type).toBeUndefined();
    });

    it('matches the corrigendum type exactly, not as a URI substring', async () => {
      const ctx = createMockContext({ errors: eurlex_search_documents.errors });
      // Guards the tag against a `String.includes` implementation: a longer code
      // that merely starts with the corrigendum code is a different type.
      mockQuery.mockResolvedValue([
        makeDocBinding('32024R1689', { types: `${CORRIGENDUM_URI}_UNRELATED` }),
      ]);

      const input = eurlex_search_documents.input.parse({ document_type: 'REG' });
      const result = await eurlex_search_documents.handler(input, ctx);

      expect(result.documents[0]?.is_corrigendum).toBe(false);
    });

    it('echoes include_corrigenda on content[] as well as structuredContent', async () => {
      const ctx = createMockContext({ errors: eurlex_search_documents.errors });
      mockQuery.mockResolvedValue([makeDocBinding('32016R0679')]);

      const input = eurlex_search_documents.input.parse({ document_type: 'REG' });
      const result = await eurlex_search_documents.handler(input, ctx);

      const text = (eurlex_search_documents.format!(result)[0] as { text: string }).text;
      expect(text).toContain('include_corrigenda=false');
    });

    it('does not count include_corrigenda as an effective narrowing filter', async () => {
      const ctx = createMockContext({ errors: eurlex_search_documents.errors });

      const input = eurlex_search_documents.input.parse({ include_corrigenda: true });
      await expect(eurlex_search_documents.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'no_filters' },
      });
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('keeps the exclusion on an empty page and an offset past the end', async () => {
      const ctx = createMockContext({ errors: eurlex_search_documents.errors });
      mockQuery.mockResolvedValue([]);

      const input = eurlex_search_documents.input.parse({
        document_type: 'REG',
        offset: 10_000,
      });
      const result = await eurlex_search_documents.handler(input, ctx);

      expect(result.documents).toEqual([]);
      expect(result.query_echo.include_corrigenda).toBe(false);
      expect(mockQuery.mock.calls[0]?.[0] as string).toContain('FILTER NOT EXISTS');
    });

    it('bounds the page by distinct documents when corrigenda are re-admitted', async () => {
      const ctx = createMockContext({ errors: eurlex_search_documents.errors });
      mockQuery.mockResolvedValue([
        makeDocBinding('32025R2605R(01)', { types: `${RESOURCE_TYPE_BASE}REG ${CORRIGENDUM_URI}` }),
        makeDocBinding('32025R2143R(01)', { types: `${RESOURCE_TYPE_BASE}REG ${CORRIGENDUM_URI}` }),
        makeDocBinding('32025R1900R(01)', { types: `${RESOURCE_TYPE_BASE}REG ${CORRIGENDUM_URI}` }),
      ]);

      const input = eurlex_search_documents.input.parse({
        document_type: 'REG',
        include_corrigenda: true,
        limit: 2,
      });
      const result = await eurlex_search_documents.handler(input, ctx);

      expect(result.documents).toHaveLength(2);
      expect(result.has_more).toBe(true);
      expect(result.documents.every((d) => d.is_corrigendum)).toBe(true);
      expect(getEnrichment(ctx)).toMatchObject({ truncated: true, shown: 2, cap: 2 });
    });
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

  it('tags a consolidated CELEX outside the -YYYYMMDD act-number shape is_consolidated:true (#109)', async () => {
    const ctx = createMockContext({ errors: eurlex_search_documents.errors });
    mockQuery.mockResolvedValue([
      makeDocBinding('02006A0901(01)-20090301', { date: '2009-03-01' }),
      makeDocBinding('02003T0000-20040501', { date: '2004-05-01' }),
      makeDocBinding('22006A0901(01)', { date: '2006-09-01' }),
    ]);

    const input = eurlex_search_documents.input.parse({ keyword: 'schengen' });
    const result = await eurlex_search_documents.handler(input, ctx);

    expect(result.documents.map((d) => [d.celex_number, d.is_consolidated])).toEqual([
      ['02006A0901(01)-20090301', true],
      ['02003T0000-20040501', true],
      ['22006A0901(01)', false],
    ]);
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
          is_corrigendum: false,
          resource_type: 'Regulation',
          date: '2016-04-27',
          title: 'GDPR',
        },
      ],
      total: 1,
      offset: 0,
      has_more: false,
      query_echo: { keyword: 'gdpr', include_consolidated: false, include_corrigenda: false },
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
          is_corrigendum: false,
          resource_type: 'Consolidated Text',
          date: '2026-04-24',
        },
      ],
      total: 1,
      offset: 0,
      has_more: false,
      query_echo: { include_consolidated: false, include_corrigenda: false },
    };
    const blocks = eurlex_search_documents.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('**Consolidated:** true');
    expect(text).toContain('**Corrigendum:** false');
  });

  it('format handles sparse documents (no type, date, or title)', () => {
    const output = {
      documents: [
        {
          work_uri: 'http://publications.europa.eu/resource/cellar/sparse',
          celex_number: '12345ABC',
          is_consolidated: false,
          is_corrigendum: false,
        },
      ],
      total: 1,
      offset: 0,
      has_more: false,
      query_echo: { include_consolidated: false, include_corrigenda: false },
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
      // The rest of the IRIREF exclusion set, each confirmed live to leak SP030 (#140).
      ['a brace', `${EUROVOC_URI}{X}`],
      ['a pipe', `${EUROVOC_URI}|X`],
      ['U+0001', `${EUROVOC_URI}\x01X`],
      // Unicode whitespace outside U+0000–U+0020, which only the \s half of the guard catches.
      ['a no-break space', `${EUROVOC_URI} X`],
      ['a line separator', `${EUROVOC_URI} X`],
    ])(
      'rejects a eurovoc_concept containing %s at the schema, before any query',
      async (_label, uri) => {
        mockQuery.mockResolvedValue([]);
        const result = await runToolContract(eurlex_search_documents, { eurovoc_concept: uri });
        expect(result.isError).toBe(true);
        expect(contentText(result)).toContain('control characters');
        expect(contentText(result)).toContain('{ } | ^');
        expect(mockQuery).not.toHaveBeenCalled();
      },
    );

    /**
     * `cdm:work_is_about_concept_eurovoc` binds only `http://eurovoc.europa.eu/`
     * concepts (#11), so a URI from any other namespace — another authority table,
     * an ELI, a CELLAR work, a lookalike host — can match no work, and neither can the
     * bare namespace. Each is rejected with a message naming the namespace rather than
     * answered with an empty page.
     */
    it.each([
      ['a lookalike host', 'http://eurovoc.europa.eu.evil/2828'],
      ['the host without a path', 'http://eurovoc.europa.eu'],
      ['the namespace without a concept', 'https://eurovoc.europa.eu/'],
      ['an ELI', 'http://data.europa.eu/eli/reg/2016/679/oj'],
      [
        'a CELLAR work URI',
        'http://publications.europa.eu/resource/cellar/3e485e15-11bd-11e6-ba9a-01aa75ed71a1',
      ],
      [
        'another authority concept',
        'http://publications.europa.eu/resource/authority/subject-matter/PRIV',
      ],
    ])('rejects %s as eurovoc_concept, naming the EuroVoc namespace', async (_label, uri) => {
      mockQuery.mockResolvedValue([]);
      const result = await runToolContract(eurlex_search_documents, { eurovoc_concept: uri });
      expect(result.isError).toBe(true);
      expect(contentText(result)).toContain('http://eurovoc.europa.eu/');
      expect(mockQuery).not.toHaveBeenCalled();
    });

    /**
     * Scheme and host are case-insensitive, and every EuroVoc object in CELLAR sits
     * under `http://eurovoc.europa.eu/`, so the https form and an upper-case host name
     * the same concept. Each is matched and echoed as the http form.
     */
    it.each([
      ['the https form', 'https://eurovoc.europa.eu/2828'],
      ['an upper-case host', 'http://EUROVOC.europa.eu/2828'],
      ['an upper-case https scheme and host', 'HTTPS://Eurovoc.Europa.EU/2828'],
    ])('reads %s as the canonical http EuroVoc URI', async (_label, uri) => {
      mockQuery.mockResolvedValue([]);
      const result = await runToolContract(eurlex_search_documents, { eurovoc_concept: uri });
      expect(result.isError).toBeFalsy();
      const queries = searchQueries();
      expect(queries.length).toBeGreaterThan(0);
      for (const q of queries) {
        expect(q).toContain(`cdm:work_is_about_concept_eurovoc <${EUROVOC_URI}> .`);
      }
      for (const [q] of mockQuery.mock.calls) expect(q).not.toContain(uri);
      const echo = (result.structuredContent as { query_echo?: { eurovoc_concept?: string } })
        .query_echo;
      expect(echo?.eurovoc_concept).toBe(EUROVOC_URI);
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

  // --- #97: a row's work_uri is its CELEX's canonical work ---

  describe('row work_uri for a CELEX held by several works (#97)', () => {
    const DC713_TWIN = fixtureWork('51988DC0713', 0);

    it('resolves the 51988DC0713 row to its canonical work through one VALUES query', async () => {
      mockQuery.mockImplementation(async (q: string) =>
        q.includes('GROUP BY ?celexNumber')
          ? [
              makeDocBinding('51988DC0713', { workUri: DC713_TWIN, titledWork: DC713_TWIN }),
              makeDocBinding('32016R0679'),
            ]
          : celexWorkRows(q),
      );

      const result = await runToolContract(eurlex_search_documents, {
        document_type: 'PROP',
        limit: 2,
      });

      const structured = eurlex_search_documents.output.parse(result.structuredContent);
      expect(structured.documents.map((d) => d.work_uri)).toEqual([
        canonicalWork('51988DC0713'),
        canonicalWork('32016R0679'),
      ]);
      const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
      expect(text).toContain(`**Work URI:** ${canonicalWork('51988DC0713')}`);
      expect(text).not.toContain(DC713_TWIN);
      const resolution = mockQuery.mock.calls
        .map((c) => c[0] as string)
        .filter((q) => q.includes('owl#sameAs'));
      expect(resolution).toHaveLength(1);
      expect(resolution[0]).toContain(
        'VALUES ?celexNumber { "51988DC0713"^^xsd:string "32016R0679"^^xsd:string }',
      );
    });

    it('sends no resolution query for an empty page past the end', async () => {
      mockQuery.mockResolvedValue([]);

      const input = eurlex_search_documents.input.parse({ keyword: 'data', offset: 500 });
      const result = await eurlex_search_documents.handler(
        input,
        createMockContext({ errors: eurlex_search_documents.errors }),
      );

      expect(result.documents).toEqual([]);
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });
  });

  // --- #112: an empty first page is an empty page, not an error ---

  describe('empty first page (#112)', () => {
    it('returns an empty page with a notice on both surfaces', async () => {
      mockQuery.mockResolvedValue([]);

      const result = await runToolContract(eurlex_search_documents, {
        keyword: 'zzqxunmatchablephrase',
      });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured).toMatchObject({
        documents: [],
        total: 0,
        offset: 0,
        has_more: false,
        query_echo: {
          keyword: 'zzqxunmatchablephrase',
          include_consolidated: false,
          include_corrigenda: false,
        },
      });
      expect(structured).not.toHaveProperty('next_offset');
      expect(structured).not.toHaveProperty('truncated');
      const notice = structured.notice as string;
      expect(notice).toContain('keyword=zzqxunmatchablephrase');
      expect(notice).toContain(
        'Broaden the search by removing filters, trying a shorter keyword, or expanding the date range.',
      );

      const text = contentText(result);
      expect(text).toContain(`> ${notice}`);
      expect(text).toContain('**Has more:** false');
      expect(text).not.toContain('**Next offset:**');
    });

    it('rejects an author with no letters or digits as invalid_author_institution', async () => {
      const result = await runToolContract(eurlex_search_documents, { author_institution: '!!!' });

      expect(result.isError).toBe(true);
      const structured = result.structuredContent as {
        error?: { code?: number; data?: { reason?: string; recovery?: { hint?: string } } };
      };
      expect(structured.error?.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(structured.error?.data?.reason).toBe('invalid_author_institution');
      const hint = structured.error?.data?.recovery?.hint as string;
      expect(hint.length).toBeGreaterThan(0);
      expect(contentText(result)).toContain(hint);
      // Rejected before any CELLAR request.
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('returns an empty page for a well-formed author that matches no institution', async () => {
      mockQuery.mockResolvedValue([]);

      const result = await runToolContract(eurlex_search_documents, {
        author_institution: 'zzqx agency',
      });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured).toMatchObject({
        documents: [],
        total: 0,
        has_more: false,
        query_echo: { author_institution: 'zzqx agency' },
      });
      expect(structured.notice).toContain('author_institution=zzqx agency');
      expect(contentText(result)).toContain(`> ${structured.notice as string}`);
      expect(searchQueries()[0]).toContain(`bif:contains "'zzqx agency'"`);
    });

    it.each(['-', '()', '!!!', '/_-'])(
      'rejects the keyword %j, which holds no letters or digits, as invalid_keyword on both surfaces',
      async (keyword) => {
        const result = await runToolContract(eurlex_search_documents, {
          keyword,
          document_type: 'REG',
          date_from: '2024-01-01',
        });

        // The other filters are not silently answered with an empty page.
        expect(result.isError).toBe(true);
        const structured = result.structuredContent as {
          error?: { code?: number; data?: { reason?: string; recovery?: { hint?: string } } };
        };
        expect(structured.error?.code).toBe(JsonRpcErrorCode.ValidationError);
        expect(structured.error?.data?.reason).toBe('invalid_keyword');
        const hint = structured.error?.data?.recovery?.hint as string;
        expect(hint).toContain('omit keyword');
        expect(contentText(result)).toContain(hint);
        expect(mockQuery).not.toHaveBeenCalled();
      },
    );

    it('bounds the keyword and author echoed in the notice of an empty first page', async () => {
      mockQuery.mockResolvedValue([]);
      const keyword = `zz${'q'.repeat(4998)}`;
      const author = `yy${'x'.repeat(4998)}`;

      const result = await runToolContract(eurlex_search_documents, {
        keyword,
        author_institution: author,
      });

      const notice = (result.structuredContent as { notice?: string }).notice ?? '';
      expect(notice).toContain(`keyword=${keyword.slice(0, 100)}…`);
      expect(notice).toContain(`author_institution=${author.slice(0, 100)}…`);
      expect(notice).not.toContain(keyword.slice(0, 101));
      expect(notice.length).toBeLessThan(600);
      expect(contentText(result)).toContain(`> ${notice}`);
      // query_echo still carries the whole value; only the prose is bounded.
      expect(result.structuredContent).toMatchObject({
        query_echo: { keyword, author_institution: author },
      });
    });

    it('bounds the keyword quoted in the invalid_keyword message', async () => {
      const result = await runToolContract(eurlex_search_documents, { keyword: '-'.repeat(5000) });

      expect(result.isError).toBe(true);
      const text = contentText(result);
      expect(text).toContain(`${'-'.repeat(100)}…`);
      expect(text).not.toContain('-'.repeat(101));
    });

    it('names the next offset in the notice of a page with more rows', async () => {
      mockQuery.mockResolvedValue([
        makeDocBinding('32016R0679'),
        makeDocBinding('32022R0868'),
        makeDocBinding('32024R0001'),
      ]);

      const result = await runToolContract(eurlex_search_documents, {
        keyword: 'data',
        offset: 4,
        limit: 2,
      });

      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured).toMatchObject({ has_more: true, next_offset: 6, truncated: true });
      expect(structured.notice).toContain('offset=6');
      expect(contentText(result)).toContain(`> ${structured.notice as string}`);
    });

    it('carries no notice on an exactly full final page', async () => {
      mockQuery.mockResolvedValue([makeDocBinding('32016R0679'), makeDocBinding('32022R0868')]);

      const result = await runToolContract(eurlex_search_documents, { keyword: 'data', limit: 2 });

      expect(result.structuredContent).toMatchObject({ total: 2, has_more: false });
      expect(result.structuredContent).not.toHaveProperty('notice');
      expect(contentText(result)).not.toMatch(/^> /m);
    });
  });

  // --- #105: behavior the page-first form and the keyword arm selection keep ---

  describe('characterization kept through #105', () => {
    /** Answer the grouped search with `rows`, and every other query (the exact-CELEX lookup, work resolution) with nothing. */
    function answerSearch(rows: Record<string, { type: string; value: string }>[]): void {
      mockQuery.mockImplementation(async (q: string) =>
        q.includes('GROUP BY ?celexNumber') ? rows : [],
      );
    }

    it('keeps the flat form, paged at the outer level, for a search with no date bound', async () => {
      answerSearch([makeDocBinding('32016R0679', { date: '2016-04-27' })]);

      await eurlex_search_documents.handler(
        eurlex_search_documents.input.parse({ document_type: 'REG', offset: 20 }),
        createMockContext({ errors: eurlex_search_documents.errors }),
      );

      const [sparql] = searchQueries();
      expect(sparql).not.toContain('?pageDate');
      expect(sparql).toContain('(SAMPLE(?date) AS ?docDate)');
      expect(sparql).toMatch(/ORDER BY DESC\(\?docDate\) \?celexNumber LIMIT 21 OFFSET 20$/);
    });

    it('matches a partial CELEX keyword through the CELEX full-text index alongside the title', async () => {
      answerSearch([makeDocBinding('02016R0679-20160504'), makeDocBinding('32016R0679')]);

      const result = await eurlex_search_documents.handler(
        eurlex_search_documents.input.parse({ keyword: '2016R0679' }),
        createMockContext({ errors: eurlex_search_documents.errors }),
      );

      const [sparql] = searchQueries();
      expect(sparql).toContain(`?kwTitle bif:contains "'2016R0679'"`);
      expect(sparql).toContain('?work cdm:resource_legal_id_celex ?kwCelex .');
      expect(sparql).toContain(`'E2016R0679*'" .`);
      expect(sparql).toContain('FILTER(CONTAINS(STR(?kwCelex), "2016R0679"))');
      expect(result.documents.map((d) => d.celex_number)).toEqual([
        '02016R0679-20160504',
        '32016R0679',
      ]);
    });
  });

  // --- #105: date-bounded searches page first; the CELEX arm follows the keyword ---

  describe('page-first date-bounded search (#105)', () => {
    const PAGE_SUBQUERY = '{\n    SELECT ?celexNumber (SAMPLE(?date) AS ?pageDate) WHERE {';

    /** Split a page-first query into its page subquery and the outer query around it. */
    function splitPageFirst(sparql: string): { inner: string; outer: string } {
      const start = sparql.indexOf(PAGE_SUBQUERY);
      if (start === -1) throw new Error('No page subquery in the generated query');
      const close = /LIMIT \d+ OFFSET \d+\n {2}\}/.exec(sparql.slice(start));
      if (!close) throw new Error('Unterminated page subquery');
      const end = start + close.index + close[0].length;
      return { inner: sparql.slice(start, end), outer: sparql.slice(0, start) + sparql.slice(end) };
    }

    async function searchQuery(input: Record<string, unknown>): Promise<string> {
      mockQuery.mockImplementation(async (q: string) =>
        q.includes('GROUP BY ?celexNumber')
          ? [makeDocBinding('32024R0001', { date: '2024-03-15' })]
          : [],
      );
      await eurlex_search_documents.handler(
        eurlex_search_documents.input.parse(input),
        createMockContext({ errors: eurlex_search_documents.errors }),
      );
      const [sparql] = searchQueries();
      if (!sparql) throw new Error('No search query was sent');
      return sparql;
    }

    it.each([
      ['both bounds', { date_from: '2024-03-01', date_to: '2024-03-31' }],
      ['a single day', { date_from: '1988-12-09', date_to: '1988-12-09' }],
      ['date_from alone', { date_from: '2024-03-01' }],
      ['date_to alone', { date_to: '2019-06-30' }],
    ])('pages in a subquery and aggregates the page alone, with %s', async (_label, dates) => {
      const sparql = await searchQuery({ ...dates, offset: 20 });
      const { inner, outer } = splitPageFirst(sparql);

      expect(inner).toMatch(
        /\} GROUP BY \?celexNumber ORDER BY DESC\(\?pageDate\) \?celexNumber LIMIT 21 OFFSET 20\n {2}\}$/,
      );
      expect(outer).toMatch(/\} GROUP BY \?celexNumber ORDER BY DESC\(\?docDate\) \?celexNumber$/);
      expect(outer).not.toMatch(/\bLIMIT\b|\bOFFSET\b/);
      expect(outer).toContain('(SAMPLE(?pageDate) AS ?docDate)');
      expect(sparql).not.toMatch(/MAX\(\?(?:date|pageDate)\)/);
    });

    it('gathers types and titles in the outer query only', async () => {
      const { inner, outer } = splitPageFirst(
        await searchQuery({ date_from: '2024-03-01', date_to: '2024-03-31' }),
      );

      for (const optional of [
        'OPTIONAL { ?work cdm:work_has_resource-type ?type . }',
        '?expr cdm:expression_title ?title .',
      ]) {
        expect(inner).not.toContain(optional);
        expect(outer).toContain(optional);
      }
      for (const aggregate of [
        '(MAX(?titledWork) AS ?titledWork)',
        '(SAMPLE(?work) AS ?work)',
        '(GROUP_CONCAT(DISTINCT STR(?type); SEPARATOR=" ") AS ?types)',
        '(MAX(?title) AS ?docTitle)',
      ]) {
        expect(outer).toContain(aggregate);
      }
    });

    it('matches every filter at both levels, testing keyword and author on the page’s works alone', async () => {
      const { inner, outer } = splitPageFirst(
        await searchQuery({
          keyword: 'privacy',
          document_type: 'REG',
          include_consolidated: true,
          eurovoc_concept: 'http://eurovoc.europa.eu/2828',
          author_institution: 'Council',
          in_force: true,
          date_from: '2024-01-01',
          date_to: '2024-12-31',
        }),
      );

      for (const part of [inner, outer]) {
        expect(part).toContain(`VALUES ?selectedType { <${RESOURCE_TYPE_BASE}REG>`);
        expect(part).toContain(`?work cdm:work_has_resource-type <${RESOURCE_TYPE_BASE}CONS_TEXT>`);
        expect(part).toContain(
          '?work cdm:work_is_about_concept_eurovoc <http://eurovoc.europa.eu/2828> .',
        );
        expect(part).toContain(`?agentLabel bif:contains "'Council'" .`);
        expect(part).toContain(`?kwTitle bif:contains "'privacy'"`);
        expect(part).toContain('OPTIONAL { ?work cdm:resource_legal_in-force ?inForce . }');
        expect(part).toContain('FILTER(?inForce = true)');
        expect(part).toContain('FILTER(?date >= "2024-01-01"^^xsd:date)');
        expect(part).toContain('FILTER(?date <= "2024-12-31"^^xsd:date)');
        expect(part).toContain(
          `FILTER NOT EXISTS { ?work cdm:work_has_resource-type <${RESOURCE_TYPE_BASE}CORRIGENDUM> . }`,
        );
      }
      expect(inner).not.toContain('FILTER EXISTS');
      expect(outer).toMatch(/FILTER EXISTS \{\s*\?work cdm:work_created_by_agent \?agent/);
      expect(outer).toMatch(/FILTER EXISTS \{\s*\{\s*\?kwExpr cdm:expression_title \?kwTitle/);
      // Outside those tests the outer query never joins the author or the keyword again.
      const outerJoins = withoutFilterExists(outer);
      for (const joined of [
        'cdm:work_created_by_agent',
        '?agentLabel bif:contains',
        '?kwTitle bif:contains',
        '?kwExpr',
      ]) {
        expect(outerJoins).not.toContain(joined);
      }
    });

    it('tests a whole-CELEX keyword on the page’s works alone, never joining it in the outer query', async () => {
      mockQuery.mockImplementation(async (q: string) => {
        if (q.includes('GROUP BY ?celexNumber')) return [makeDocBinding('32016R0679')];
        return q.includes('VALUES ?kwCelex {')
          ? [{ kwCelex: { type: 'literal', value: '32016R0679' } }]
          : [];
      });
      await eurlex_search_documents.handler(
        eurlex_search_documents.input.parse({ keyword: '32016R0679', date_from: '2016-01-01' }),
        createMockContext({ errors: eurlex_search_documents.errors }),
      );
      const { inner, outer } = splitPageFirst(searchQueries()[0] ?? '');

      expect(inner).toContain('?work cdm:resource_legal_id_celex ?kwCelex .');
      expect(outer).toMatch(
        /FILTER EXISTS \{[\s\S]*\?work cdm:resource_legal_id_celex \?kwCelex \./,
      );
      const outerJoins = withoutFilterExists(outer);
      expect(outerJoins).not.toContain('?kwCelex');
      expect(outerJoins).not.toContain('?kwBase');
    });

    it('tests a partial-CELEX keyword in the page subquery and the outer FILTER EXISTS alone (#123)', async () => {
      const { inner, outer } = splitPageFirst(
        await searchQuery({ keyword: '2016R0679', date_from: '2016-01-01' }),
      );

      for (const part of [inner, outer]) {
        expect(part).toContain(`?kwCelex bif:contains "'02016R0679*' OR '12016R0679*'`);
        expect(part).toContain('FILTER(CONTAINS(STR(?kwCelex), "2016R0679"))');
        expect(part).not.toContain('CONTAINS(LCASE(STR(?kwCelex))');
      }
      expect(inner).not.toContain('FILTER EXISTS');
      expect(outer).toMatch(/FILTER EXISTS \{[\s\S]*\?kwCelex bif:contains/);
      expect(withoutFilterExists(outer)).not.toContain('?kwCelex');
    });

    it('proves continuation from the page subquery’s extra row, on both surfaces', async () => {
      mockQuery.mockImplementation(async (q: string) =>
        q.includes('GROUP BY ?celexNumber')
          ? [
              makeDocBinding('32024R0200', { date: '2024-03-20' }),
              makeDocBinding('32024R0100', { date: '2024-03-10' }),
              makeDocBinding('32024R0050', { date: '2024-03-05' }),
            ]
          : [],
      );

      const result = await runToolContract(eurlex_search_documents, {
        date_from: '2024-03-01',
        date_to: '2024-03-31',
        limit: 2,
        offset: 4,
      });

      expect(splitPageFirst(searchQueries()[0] ?? '').inner).toContain('LIMIT 3 OFFSET 4');
      const structured = eurlex_search_documents.output.parse(result.structuredContent);
      expect(structured.documents.map((d) => [d.celex_number, d.date])).toEqual([
        ['32024R0200', '2024-03-20'],
        ['32024R0100', '2024-03-10'],
      ]);
      expect(structured).toMatchObject({ total: 2, offset: 4, has_more: true, next_offset: 6 });
      const text = contentText(result);
      expect(text).toContain('**Has more:** true');
      expect(text).toContain('**Next offset:** 6');
      expect(text).not.toContain('32024R0050');
    });

    it('clamps the page subquery to the service ceiling', async () => {
      mockMaxResults = 2;
      const { inner, outer } = splitPageFirst(
        await searchQuery({ date_from: '2024-03-01', limit: 100 }),
      );

      expect(inner).toContain('LIMIT 3 OFFSET 0');
      expect(outer).not.toMatch(/\bLIMIT\b/);
    });

    it('returns an empty page with a notice on an empty first page, and a silent empty page past the end', async () => {
      mockQuery.mockResolvedValue([]);
      const dates = { date_from: '2024-03-01', date_to: '2024-03-31' };

      const first = await runToolContract(eurlex_search_documents, dates);
      expect(first.structuredContent).toMatchObject({ documents: [], total: 0, has_more: false });
      const notice = (first.structuredContent as { notice?: string }).notice ?? '';
      expect(notice).toContain('date_from=2024-03-01');
      expect(contentText(first)).toContain(`> ${notice}`);
      expect(mockQuery.mock.calls[0]?.[0]).toContain('?pageDate');

      const past = await runToolContract(eurlex_search_documents, { ...dates, offset: 400 });
      expect(past.structuredContent).toMatchObject({ documents: [], total: 0, has_more: false });
      expect(past.structuredContent).not.toHaveProperty('notice');
      expect(past.structuredContent).not.toHaveProperty('next_offset');
    });
  });

  describe('keyword CELEX arm by keyword shape (#105)', () => {
    /** Queries other than the grouped search and the page's work resolution: the exact-CELEX lookup. */
    function lookupQueries(): string[] {
      return mockQuery.mock.calls
        .map((c) => c[0] as string)
        .filter((q) => !q.includes('GROUP BY ?celexNumber') && !q.includes('owl#sameAs'));
    }

    /** Answer the family lookup with each CELEX in `carried` it asks about, the search with `rows`. */
    function answer(carried: string[], rows = [makeDocBinding('32016R0679')]): void {
      mockQuery.mockImplementation(async (q: string) => {
        if (q.includes('GROUP BY ?celexNumber')) return rows;
        if (q.includes('owl#sameAs')) return [];
        return carried
          .filter((c) => q.includes(`"${c}"^^xsd:string`))
          .map((c) => ({ kwCelex: { type: 'literal', value: c } }));
      });
    }

    async function run(input: Record<string, unknown>): Promise<string> {
      await eurlex_search_documents.handler(
        eurlex_search_documents.input.parse(input),
        createMockContext({ errors: eurlex_search_documents.errors }),
      );
      const [sparql] = searchQueries();
      if (!sparql) throw new Error('No search query was sent');
      return sparql;
    }

    it.each(['privacy', 'data protection', 'Regulation', 'FRA'])(
      'drops the CELEX arm for the digit-free keyword %j and sends no lookup',
      async (keyword) => {
        answer([]);
        const sparql = await run({ keyword });

        expect(sparql).not.toContain('?kwCelex');
        expect(sparql).not.toContain('CONTAINS(');
        expect(sparql).not.toContain('UNION');
        expect(sparql).toContain('?kwTitle bif:contains');
        expect(lookupQueries()).toEqual([]);
      },
    );

    it.each(['GDPR 2016/679', '2016.679', 'Regulation (EU) 2016/679'])(
      'drops the CELEX arm for %j, which holds a character no CELEX contains',
      async (keyword) => {
        answer([]);
        const sparql = await run({ keyword });

        expect(sparql).not.toContain('?kwCelex');
        expect(sparql).not.toContain('resource_legal_id_celex "');
        expect(lookupQueries()).toEqual([]);
      },
    );

    it('matches a whole CELEX as the exact typed literal plus the works correcting it', async () => {
      answer(['32016R0679']);
      const sparql = await run({ keyword: '32016R0679' });

      expect(lookupQueries()).toEqual([
        expect.stringContaining('?kwWork cdm:resource_legal_id_celex ?kwCelex .'),
      ]);
      expect(sparql).toContain('VALUES ?kwCelex { "32016R0679"^^xsd:string }');
      expect(sparql).toContain('?work cdm:resource_legal_id_celex ?kwCelex . }');
      expect(sparql).toContain('?kwBase cdm:resource_legal_id_celex "32016R0679"^^xsd:string .');
      expect(sparql).toContain('?work cdm:resource_legal_corrects_resource_legal ?kwBase .');
      expect(sparql).toContain(`?kwTitle bif:contains "'32016R0679'"`);
      expect(sparql).not.toContain('CONTAINS(LCASE(STR(?kwCelex))');
      // Corrigenda stay excluded by default, however they entered the match.
      expect(sparql).toContain(
        `FILTER NOT EXISTS { ?work cdm:work_has_resource-type <${RESOURCE_TYPE_BASE}CORRIGENDUM> . }`,
      );
    });

    it('looks a lowercase whole CELEX up in the uppercase form CELLAR stores', async () => {
      answer(['32016R0679']);
      const sparql = await run({ keyword: '32016r0679', include_corrigenda: true });

      expect(lookupQueries()[0]).toContain('"32016R0679"^^xsd:string');
      expect(sparql).toContain('?work cdm:resource_legal_corrects_resource_legal ?kwBase .');
      expect(sparql).not.toContain('CORRIGENDUM');
    });

    it.each([
      ['02016R0679', `"'02016R0679*'"`],
      ['72014L0056', `"'72014L0056*'"`],
      ['2016R0679', `"'02016R0679*' OR '12016R0679*' OR`],
    ])(
      'takes the partial arm for %j, which no work carries whole (#123)',
      async (keyword, terms) => {
        answer([]);
        const sparql = await run({ keyword });

        expect(lookupQueries()).toHaveLength(1);
        expect(sparql).toContain(`?kwCelex bif:contains ${terms}`);
        expect(sparql).toContain(`FILTER(CONTAINS(STR(?kwCelex), "${keyword}"))`);
        expect(sparql).not.toContain('CONTAINS(LCASE(STR(?kwCelex))');
        expect(sparql).not.toContain('resource_legal_corrects_resource_legal');
      },
    );

    it('completes a type-first fragment with every sector, year, and type code, sending no lookup (#123)', async () => {
      answer([]);
      const sparql = await run({ keyword: 'R0679' });

      expect(lookupQueries()).toEqual([]);
      expect(sparql).toContain(`?kwCelex bif:contains "'01951R0679*' OR '01952R0679*'`);
      expect(sparql).toContain(`'32016R0679*'`);
      expect(sparql).toContain('FILTER(CONTAINS(STR(?kwCelex), "R0679"))');
      expect(sparql).not.toContain('CONTAINS(LCASE(STR(?kwCelex))');
    });

    it('matches titles only for a digit keyword that completes to no CELEX start (#123)', async () => {
      answer([]);
      const sparql = await run({ keyword: '0679' });

      expect(lookupQueries()).toEqual([]);
      expect(sparql).not.toContain('?kwCelex');
      expect(sparql).not.toContain('UNION');
      expect(sparql).toContain(`?kwTitle bif:contains "'0679'"`);
    });

    it('answers a fragment whose digits are no year with the title matches, not an error (#123)', async () => {
      answer([], [makeDocBinding('32016R0679', { title: 'A title naming 9999R0679' })]);
      const result = await runToolContract(eurlex_search_documents, { keyword: '9999R0679' });

      expect(result.isError).toBeFalsy();
      const [sparql] = searchQueries();
      expect(sparql).not.toContain('?kwCelex');
      expect(sparql).toContain(`?kwTitle bif:contains "'9999R0679'"`);
      const structured = eurlex_search_documents.output.parse(result.structuredContent);
      expect(structured.documents.map((d) => d.celex_number)).toEqual(['32016R0679']);
    });

    it('runs the lookup after input validation, so a bad date sends nothing', async () => {
      answer(['32016R0679']);
      await expect(
        eurlex_search_documents.handler(
          eurlex_search_documents.input.parse({ keyword: '32016R0679', date_from: '2026-02-30' }),
          createMockContext({ errors: eurlex_search_documents.errors }),
        ),
      ).rejects.toMatchObject({ data: { reason: 'invalid_date_range' } });
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('propagates a cancelled lookup instead of searching without it', async () => {
      const abort = new DOMException('The operation was aborted.', 'AbortError');
      mockQuery.mockImplementation(async (q: string) => {
        if (q.includes('GROUP BY ?celexNumber')) return [makeDocBinding('32016R0679')];
        throw abort;
      });

      await expect(
        eurlex_search_documents.handler(
          eurlex_search_documents.input.parse({ keyword: '32016R0679' }),
          createMockContext({ errors: eurlex_search_documents.errors }),
        ),
      ).rejects.toBe(abort);
      expect(searchQueries()).toEqual([]);
    });

    it('reaches the numbered, corrigendum, and record siblings of a whole CELEX by exact literals', async () => {
      const family = ['32016R0679', '32016R0679R(01)', '32016R0679R(02)', '32016R0679R(03)'];
      answer(family, [
        makeDocBinding('32016R0679R(03)', {
          date: '2021-05-05',
          types: `${RESOURCE_TYPE_BASE}CORRIGENDUM ${RESOURCE_TYPE_BASE}REG`,
        }),
        makeDocBinding('32016R0679', { date: '2016-04-27', title: 'General Data Protection' }),
      ]);

      const result = await runToolContract(eurlex_search_documents, {
        keyword: '32016R0679',
        include_corrigenda: true,
      });

      // One lookup asks CELLAR which members of the bounded family exist.
      const [lookup] = lookupQueries();
      expect(lookupQueries()).toHaveLength(1);
      for (const member of [
        '32016R0679',
        '32016R0679(01)',
        '32016R0679(20)',
        '32016R0679R(01)',
        '32016R0679R(20)',
        '32016R0679_INF',
        '32016R0679_RES',
        '32016R0679_SUM',
        '32016R0679_EXT',
        '32016R0679(01)_INF',
        '32016R0679(20)_EXT',
      ]) {
        expect(lookup).toContain(`"${member}"^^xsd:string`);
      }
      expect(lookup?.match(/\^\^xsd:string/g)).toHaveLength(125);
      expect(lookup).not.toContain('(21)');
      // The search joins only the members CELLAR carries, and never scans.
      const [sparql] = searchQueries();
      expect(sparql).toContain(
        'VALUES ?kwCelex { "32016R0679"^^xsd:string "32016R0679R(01)"^^xsd:string "32016R0679R(02)"^^xsd:string "32016R0679R(03)"^^xsd:string }',
      );
      expect(sparql).not.toContain('"32016R0679(01)"');
      expect(sparql).not.toContain('CONTAINS(LCASE(STR(?kwCelex))');

      const structured = eurlex_search_documents.output.parse(result.structuredContent);
      expect(structured.documents.map((d) => [d.celex_number, d.is_corrigendum])).toEqual([
        ['32016R0679R(03)', true],
        ['32016R0679', false],
      ]);
      expect(contentText(result)).toContain('### 32016R0679R(03)');
    });

    it('takes the partial arm when CELLAR carries siblings of the keyword but not the keyword itself', async () => {
      answer(['52002XC0903(01)', '52002XC0903(02)']);
      const sparql = await run({ keyword: '52002XC0903' });

      expect(lookupQueries()).toHaveLength(1);
      expect(sparql).toContain(`?kwCelex bif:contains "'52002XC0903*'"`);
      expect(sparql).toContain('FILTER(CONTAINS(STR(?kwCelex), "52002XC0903"))');
      expect(sparql).not.toContain('VALUES ?kwCelex');
    });

    it.each(['C/2025/01697', '32016R0679R(01)', '62020TJ0259_RES', '02016R0679-20160504'])(
      'takes the exact arm for the whole CELEX %j, whose punctuation every CELEX may hold',
      async (keyword) => {
        answer([keyword]);
        const sparql = await run({ keyword });

        expect(lookupQueries()).toHaveLength(1);
        expect(sparql).toContain(`VALUES ?kwCelex { "${keyword}"^^xsd:string }`);
        expect(sparql).not.toContain('CONTAINS(LCASE(STR(?kwCelex))');
      },
    );

    it('states the whole-CELEX sibling and digit-free behavior in the keyword description', () => {
      const description = eurlex_search_documents.input.shape.keyword.description ?? '';
      expect(description).toContain('whole CELEX');
      expect(description).toContain('corrigenda');
      expect(description).toMatch(/\(01\)/);
      expect(description).toMatch(/no digit/i);
      expect(description).toMatch(/no letter or digit/i);
      // #123: a partial CELEX is completed from its start; a mid-number fragment is not.
      expect(description).toContain('partial CELEX');
      expect(description).toMatch(/016R0679[^.]*titles only/);
      // #137: an OJ C year/number fragment is indexed; one with a short number scans.
      expect(description).toMatch(/2024\/01469[^;]*matches every CELEX holding it/);
      expect(description).toMatch(/2017\/111[^;]*tests every CELEX/);
    });
  });
});
