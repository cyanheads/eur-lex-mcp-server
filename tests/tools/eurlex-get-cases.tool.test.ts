/**
 * @fileoverview Tests for eurlex_get_cases tool.
 * @module tests/tools/eurlex-get-cases.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eurlex_get_cases } from '@/mcp-server/tools/definitions/eurlex-get-cases.tool.js';
import { escapeSparqlLiteral } from '@/services/cellar-sparql/eli-resolution.js';

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
 * Build a minimal SPARQL binding for a case-law result. Field names mirror the
 * GROUP BY projection the handler reads: `celex`, `types` (space-separated
 * resource-type URIs from GROUP_CONCAT), `docDate`, `docTitle`. Pass `types` a
 * space-joined list to simulate a multi-resource-type work (e.g. a corrigendum).
 */
function makeCaseBinding(
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
  // CELEX group. Present only when the case had a titled work (issue #21).
  if (opts.titledWork) b.titledWork = { type: 'uri', value: opts.titledWork };
  if (opts.types) b.types = { type: 'literal', value: opts.types };
  if (opts.date) b.docDate = { type: 'literal', value: opts.date };
  if (opts.title) b.docTitle = { type: 'literal', value: opts.title };
  return b;
}

describe('eurlex_get_cases', () => {
  beforeEach(() => mockQuery.mockReset());

  // --- Happy paths ---

  it('returns matching case law records', async () => {
    const ctx = createMockContext({ errors: eurlex_get_cases.errors });
    mockQuery.mockResolvedValue([
      makeCaseBinding('62013CJ0131', {
        date: '2014-05-13',
        title: 'Google Spain SL v AEPD',
        types: 'http://publications.europa.eu/resource/authority/resource-type/JUDG',
      }),
    ]);

    const input = eurlex_get_cases.input.parse({ keyword: 'google' });
    const result = await eurlex_get_cases.handler(input, ctx);

    expect(result.total).toBe(1);
    expect(result.cases[0]?.celex_number).toBe('62013CJ0131');
    expect(result.cases[0]?.title).toBe('Google Spain SL v AEPD');
    expect(result.cases[0]?.date).toBe('2014-05-13');
    // resource_type should be resolved to a human-readable label
    expect(result.cases[0]?.resource_type).toBe('Judgment');
  });

  it('includes sector 6 filter in SPARQL for all case searches', async () => {
    const ctx = createMockContext({ errors: eurlex_get_cases.errors });
    mockQuery.mockResolvedValue([makeCaseBinding('62013CJ0131')]);

    const input = eurlex_get_cases.input.parse({});
    await eurlex_get_cases.handler(input, ctx);

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    // All case law is in sector 6 — SPARQL must contain the sector filter
    expect(sparql).toContain('STRSTARTS(STR(?celexNumber), "6")');
  });

  it('applies court=CJEU filter', async () => {
    const ctx = createMockContext({ errors: eurlex_get_cases.errors });
    mockQuery.mockResolvedValue([makeCaseBinding('62013CJ0131')]);

    const input = eurlex_get_cases.input.parse({ court: 'CJEU' });
    await eurlex_get_cases.handler(input, ctx);

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sparql).toContain('"CJ"');
  });

  it('applies court=GC filter', async () => {
    const ctx = createMockContext({ errors: eurlex_get_cases.errors });
    mockQuery.mockResolvedValue([makeCaseBinding('62020TJ0001')]);

    const input = eurlex_get_cases.input.parse({ court: 'GC' });
    await eurlex_get_cases.handler(input, ctx);

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sparql).toContain('"TJ"');
  });

  // --- case_type filters by resource-type, not CELEX substring (issue #38) ---

  it('applies case_type=judgment as a required JUDG resource-type, not a CELEX substring (issue #38)', async () => {
    const ctx = createMockContext({ errors: eurlex_get_cases.errors });
    mockQuery.mockResolvedValue([
      makeCaseBinding('62013CJ0131', {
        types: 'http://publications.europa.eu/resource/authority/resource-type/JUDG',
      }),
    ]);

    const input = eurlex_get_cases.input.parse({ case_type: 'judgment' });
    await eurlex_get_cases.handler(input, ctx);

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    // The type filter is a required resource-type triple. Abstract (_RES → ABSTRACT_JUR)
    // and summary (_SUM → SUM_JUR) siblings carry the parent's "CJ" CELEX letters under a
    // distinct CELEX and slipped through the old CONTAINS(?celexNumber, "CJ") test.
    expect(sparql).toContain(
      '?work cdm:work_has_resource-type <http://publications.europa.eu/resource/authority/resource-type/JUDG> .',
    );
    // No court is set, so the CELEX-substring "CJ" test must be absent entirely.
    expect(sparql).not.toContain('CONTAINS(STR(?celexNumber), "CJ")');
  });

  it('applies case_type=order as a required ORDER resource-type (issue #38)', async () => {
    const ctx = createMockContext({ errors: eurlex_get_cases.errors });
    mockQuery.mockResolvedValue([
      makeCaseBinding('62025CO0850', {
        types: 'http://publications.europa.eu/resource/authority/resource-type/ORDER',
      }),
    ]);

    const input = eurlex_get_cases.input.parse({ case_type: 'order' });
    await eurlex_get_cases.handler(input, ctx);

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sparql).toContain(
      '?work cdm:work_has_resource-type <http://publications.europa.eu/resource/authority/resource-type/ORDER> .',
    );
    expect(sparql).not.toContain('CONTAINS(STR(?celexNumber), "CO")');
  });

  it('applies case_type=ag_opinion as a required OPIN_AG resource-type (issue #38)', async () => {
    const ctx = createMockContext({ errors: eurlex_get_cases.errors });
    mockQuery.mockResolvedValue([
      makeCaseBinding('62025CC0300', {
        types: 'http://publications.europa.eu/resource/authority/resource-type/OPIN_AG',
      }),
    ]);

    const input = eurlex_get_cases.input.parse({ case_type: 'ag_opinion' });
    await eurlex_get_cases.handler(input, ctx);

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sparql).toContain(
      '?work cdm:work_has_resource-type <http://publications.europa.eu/resource/authority/resource-type/OPIN_AG> .',
    );
    expect(sparql).not.toContain('CONTAINS(STR(?celexNumber), "CC")');
  });

  it('combines a court CELEX filter with a case_type resource-type triple as orthogonal axes', async () => {
    const ctx = createMockContext({ errors: eurlex_get_cases.errors });
    mockQuery.mockResolvedValue([
      makeCaseBinding('62013CJ0131', {
        types: 'http://publications.europa.eu/resource/authority/resource-type/JUDG',
      }),
    ]);

    const input = eurlex_get_cases.input.parse({ court: 'CJEU', case_type: 'judgment' });
    await eurlex_get_cases.handler(input, ctx);

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    // Court stays a CELEX-letter test (CJEU = CJ/CC/CO); case_type is the resource-type triple.
    expect(sparql).toContain('CONTAINS(STR(?celexNumber), "CJ")');
    expect(sparql).toContain(
      '?work cdm:work_has_resource-type <http://publications.europa.eu/resource/authority/resource-type/JUDG> .',
    );
  });

  it('applies offset and limit', async () => {
    const ctx = createMockContext({ errors: eurlex_get_cases.errors });
    mockQuery.mockResolvedValue([makeCaseBinding('62013CJ0131')]);

    const input = eurlex_get_cases.input.parse({ offset: 10, limit: 5 });
    const result = await eurlex_get_cases.handler(input, ctx);

    expect(result.offset).toBe(10);
    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sparql).toContain('LIMIT 5');
    expect(sparql).toContain('OFFSET 10');
  });

  // --- case_number conversion ---

  it('converts C-131/12 to CELEX fragment 2012CJ0131 in SPARQL', async () => {
    const ctx = createMockContext({ errors: eurlex_get_cases.errors });
    mockQuery.mockResolvedValue([makeCaseBinding('62012CJ0131')]);

    const input = eurlex_get_cases.input.parse({ case_number: 'C-131/12' });
    const result = await eurlex_get_cases.handler(input, ctx);

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    // Should search for the CELEX substring, not the raw case number
    expect(sparql).toContain('2012CJ0131');
    expect(sparql).not.toContain('131/12');
    expect(result.query_echo.celex_fragment).toBe('2012CJ0131');
    expect(result.query_echo.case_number).toBe('C-131/12');
  });

  it('converts T-22/20 to CELEX fragment 2020TJ0022 in SPARQL', async () => {
    const ctx = createMockContext({ errors: eurlex_get_cases.errors });
    mockQuery.mockResolvedValue([makeCaseBinding('62020TJ0022')]);

    const input = eurlex_get_cases.input.parse({ case_number: 'T-22/20' });
    await eurlex_get_cases.handler(input, ctx);

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sparql).toContain('2020TJ0022');
  });

  it('includes query_echo in the response', async () => {
    const ctx = createMockContext({ errors: eurlex_get_cases.errors });
    mockQuery.mockResolvedValue([makeCaseBinding('62013CJ0131')]);

    const input = eurlex_get_cases.input.parse({ keyword: 'google', court: 'CJEU' });
    const result = await eurlex_get_cases.handler(input, ctx);

    expect(result.query_echo.keyword).toBe('google');
    expect(result.query_echo.court).toBe('CJEU');
  });

  it('SPARQL uses expression_belongs_to_work path for title', async () => {
    const ctx = createMockContext({ errors: eurlex_get_cases.errors });
    mockQuery.mockResolvedValue([makeCaseBinding('62013CJ0131')]);

    const input = eurlex_get_cases.input.parse({ keyword: 'google' });
    await eurlex_get_cases.handler(input, ctx);

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sparql).toContain('cdm:expression_belongs_to_work');
    expect(sparql).toContain('cdm:expression_title');
    expect(sparql).not.toContain('cdm:work_title');
  });

  // --- Error contract: no_results ---

  it('throws ctx.fail("no_results") when query returns empty bindings', async () => {
    const ctx = createMockContext({ errors: eurlex_get_cases.errors });
    mockQuery.mockResolvedValue([]);

    const input = eurlex_get_cases.input.parse({ keyword: 'nonexistent-case-xyz' });
    await expect(eurlex_get_cases.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_results' },
    });
  });

  // --- Keyword full-text search (issue #17) ---

  it('matches the keyword against the title via the full-text index, not a scan (issue #17)', async () => {
    const ctx = createMockContext({ errors: eurlex_get_cases.errors });
    mockQuery.mockResolvedValue([
      makeCaseBinding('62013CJ0131', { title: 'Google Spain SL v AEPD' }),
    ]);

    const input = eurlex_get_cases.input.parse({ keyword: 'google spain' });
    await eurlex_get_cases.handler(input, ctx);

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    // Multi-word keyword single-quoted as a phrase for the Virtuoso FT index.
    expect(sparql).toContain(`bif:contains "'google spain'"`);
    expect(sparql).toContain('cdm:expression_title ?kwTitle');
    // The old full-scan filter over every candidate title must be gone (#17).
    expect(sparql).not.toContain('CONTAINS(LCASE(COALESCE(STR(?title)');
    // CELEX substring matching is preserved as a UNION arm.
    expect(sparql).toContain('cdm:resource_legal_id_celex ?kwCelex');
  });

  // --- #62: case_number and keyword escaping route through the shared helper ---
  //
  // Both sites hand-rolled a quote-only `.replace(/"/g, '\\"')` with no backslash
  // pass. A value ending in `\` then escaped the closing quote, the literal never
  // terminated, and Virtuoso's raw SP030 compiler error — carrying the internal
  // query text and PREFIX block — reached the client in place of this tool's own
  // no_results. Asserting only on the thrown error would pass against the
  // unescaped value too (a mocked query returns its fixture whatever it is
  // handed); the built query text is the discriminating part.

  it('escapes a trailing backslash in the case_number fallback (#62)', async () => {
    const ctx = createMockContext({ errors: eurlex_get_cases.errors });
    mockQuery.mockResolvedValue([]);

    // A non-standard format misses caseNumberToCelexFragment and takes the
    // substring-match fallback — the path that builds the literal.
    const caseNumber = 'ZZ\\';
    const input = eurlex_get_cases.input.parse({ case_number: caseNumber });
    await expect(eurlex_get_cases.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_results' },
    });

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sparql).toContain(`LCASE("${escapeSparqlLiteral(caseNumber)}")`);
    // The unterminated form the quote-only pass produced is gone.
    expect(sparql).not.toContain(String.raw`LCASE("ZZ\")`);
  });

  it('escapes a trailing backslash in the keyword CELEX arm (#62)', async () => {
    const ctx = createMockContext({ errors: eurlex_get_cases.errors });
    mockQuery.mockResolvedValue([]);

    const keyword = 'data\\';
    const input = eurlex_get_cases.input.parse({ keyword });
    await expect(eurlex_get_cases.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_results' },
    });

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    // The CELEX arm lowercases before escaping, so the helper sees the lowercased value.
    expect(sparql).toContain(
      `CONTAINS(LCASE(STR(?kwCelex)), "${escapeSparqlLiteral(keyword.toLowerCase())}")`,
    );
    expect(sparql).not.toContain(String.raw`"data\"))`);
  });

  /**
   * Escaping must stay the LAST step. Flipping it ahead of the `.trim()` is
   * observable: the escape turns a real trailing tab into the two non-whitespace
   * characters `\` + `t`, which a later trim can no longer strip, so a literal
   * `\t` would survive into the query where the trimmed value should be bare.
   * (The `.toLowerCase()` on the keyword arm above is order-inert by contrast —
   * the escape's output alphabet is case-invariant — so only trim can catch this.)
   */
  it('trims the case_number before escaping, not after (#62)', async () => {
    const ctx = createMockContext({ errors: eurlex_get_cases.errors });
    mockQuery.mockResolvedValue([]);

    const input = eurlex_get_cases.input.parse({ case_number: 'ZZ-1\t' });
    await expect(eurlex_get_cases.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_results' },
    });

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sparql).toContain('LCASE("ZZ-1")');
    // Escaping first would leave an escaped tab the trim could not remove.
    expect(sparql).not.toContain(String.raw`ZZ-1\t`);
  });

  // --- Dedup of multi-resource-type works (issue #14) ---

  it('collapses resource-types via GROUP_CONCAT rather than SELECT DISTINCT (issue #14)', async () => {
    const ctx = createMockContext({ errors: eurlex_get_cases.errors });
    mockQuery.mockResolvedValue([makeCaseBinding('62013CJ0131')]);

    const input = eurlex_get_cases.input.parse({ keyword: 'google' });
    await eurlex_get_cases.handler(input, ctx);

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sparql).toContain('GROUP_CONCAT(DISTINCT STR(?type)');
    expect(sparql).not.toContain('SELECT DISTINCT ?work ?celexNumber ?type');
  });

  it('a multi-resource-type case yields one row listing all type labels', async () => {
    const ctx = createMockContext({ errors: eurlex_get_cases.errors });
    // A corrigendum to a judgment carries multiple resource-types; GROUP_CONCAT
    // delivers them space-separated in a single binding.
    mockQuery.mockResolvedValue([
      makeCaseBinding('62013CJ0131R(01)', {
        date: '2014-05-13',
        types:
          'http://publications.europa.eu/resource/authority/resource-type/JUDG ' +
          'http://publications.europa.eu/resource/authority/resource-type/CORRIGENDUM',
      }),
    ]);

    const input = eurlex_get_cases.input.parse({ keyword: 'google' });
    const result = await eurlex_get_cases.handler(input, ctx);

    expect(result.total).toBe(1);
    expect(result.cases).toHaveLength(1);
    // Both types resolve, de-duplicate, sort, and join. JUDG maps to "Judgment";
    // CORRIGENDUM is unmapped and falls back to its raw code, sorting first (ASCII).
    expect(result.cases[0]?.resource_type).toBe('CORRIGENDUM, Judgment');
  });

  it('the limit bounds distinct cases (cap applied after GROUP BY CELEX)', async () => {
    const ctx = createMockContext({ errors: eurlex_get_cases.errors });
    mockQuery.mockResolvedValue([
      makeCaseBinding('62013CJ0131R(01)', {
        types:
          'http://publications.europa.eu/resource/authority/resource-type/JUDG ' +
          'http://publications.europa.eu/resource/authority/resource-type/CORRIGENDUM',
      }),
      makeCaseBinding('62020TJ0022R(01)', {
        types:
          'http://publications.europa.eu/resource/authority/resource-type/JUDG ' +
          'http://publications.europa.eu/resource/authority/resource-type/CORRIGENDUM',
      }),
    ]);

    const input = eurlex_get_cases.input.parse({ keyword: 'corrigendum', limit: 2 });
    const result = await eurlex_get_cases.handler(input, ctx);

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sparql).toMatch(/GROUP BY \?celexNumber[\s\S]*LIMIT 2/);
    expect(result.total).toBe(2);
    expect(new Set(result.cases.map((c) => c.work_uri)).size).toBe(2);
  });

  // --- Dedup of same-CELEX duplicate works (issue #21) ---

  it('groups by CELEX (not work) so N distinct cases fill a page of N (issue #21)', async () => {
    const ctx = createMockContext({ errors: eurlex_get_cases.errors });
    mockQuery.mockResolvedValue([makeCaseBinding('62012CJ0131', { title: 'Google Spain' })]);

    const input = eurlex_get_cases.input.parse({ case_number: 'C-131/12' });
    await eurlex_get_cases.handler(input, ctx);

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    // Two distinct work URIs can share one CELEX (a titled judgment + a
    // do_not_index member); grouping by ?work left both rows, so a page of N
    // surfaced fewer than N cases. Grouping by CELEX collapses them.
    expect(sparql).toContain('GROUP BY ?celexNumber');
    expect(sparql).not.toContain('GROUP BY ?work');
    // MAX keeps a bound title across the group; ?titledWork binds inside the title
    // OPTIONAL so the titled work URI can be preferred.
    expect(sparql).toContain('MAX(?title)');
    expect(sparql).toContain('MAX(?titledWork)');
    expect(sparql).toContain('BIND(?work AS ?titledWork)');
    // ?docDate uses SAMPLE, not MAX: a MAX over the ORDER BY DESC(?docDate) column
    // lets Virtuoso pick a date-index TOP-k plan that bypasses the date-range
    // upper-bound FILTER on bare date/court/type searches (no selective graph
    // pattern), surfacing globally-latest cases instead of in-range ones.
    expect(sparql).toContain('SAMPLE(?date)');
    expect(sparql).not.toContain('MAX(?date)');
  });

  it('keeps the titled work_uri over a bare same-CELEX duplicate (issue #21)', async () => {
    const ctx = createMockContext({ errors: eurlex_get_cases.errors });
    // One CELEX, collapsed by GROUP BY: MAX(?titledWork) carries the titled work's
    // URI while SAMPLE(?work) may be the bare do_not_index member. The handler must
    // surface the titled URI and the recovered title.
    mockQuery.mockResolvedValue([
      makeCaseBinding('62012CJ0131', {
        workUri: 'http://publications.europa.eu/resource/cellar/57f6959c-bare-member',
        titledWork: 'http://publications.europa.eu/resource/cellar/09eb0861-titled-judgment',
        title: 'Google Spain SL v AEPD',
        types: 'http://publications.europa.eu/resource/authority/resource-type/JUDG',
      }),
    ]);

    const input = eurlex_get_cases.input.parse({ case_number: 'C-131/12' });
    const result = await eurlex_get_cases.handler(input, ctx);

    expect(result.total).toBe(1);
    expect(result.cases[0]?.work_uri).toBe(
      'http://publications.europa.eu/resource/cellar/09eb0861-titled-judgment',
    );
    expect(result.cases[0]?.title).toBe('Google Spain SL v AEPD');
  });

  it('falls back to the sampled work_uri when no titled duplicate exists (issue #21)', async () => {
    const ctx = createMockContext({ errors: eurlex_get_cases.errors });
    // An older case with no English title: MAX(?titledWork) is unbound (absent from
    // the binding), so the handler uses SAMPLE(?work).
    mockQuery.mockResolvedValue([
      makeCaseBinding('61962CJ0025', {
        workUri: 'http://publications.europa.eu/resource/cellar/old-untitled-case',
      }),
    ]);

    const input = eurlex_get_cases.input.parse({ case_number: 'C-25/62' });
    const result = await eurlex_get_cases.handler(input, ctx);

    expect(result.cases[0]?.work_uri).toBe(
      'http://publications.europa.eu/resource/cellar/old-untitled-case',
    );
  });

  // --- Empty-string optional filters from form clients (issue #15) ---

  it('accepts "" for every constrained optional filter and runs unfiltered', async () => {
    const ctx = createMockContext({ errors: eurlex_get_cases.errors });
    mockQuery.mockResolvedValue([makeCaseBinding('62013CJ0131')]);

    const input = eurlex_get_cases.input.parse({
      keyword: 'google',
      court: '',
      case_type: '',
      date_from: '',
      date_to: '',
    });
    const result = await eurlex_get_cases.handler(input, ctx);

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    // No court/case_type/date clauses from blank filters (sector-6 filter remains).
    expect(sparql).not.toContain('"TJ"');
    expect(sparql).not.toContain('xsd:date');
    expect(result.query_echo.court).toBeUndefined();
    expect(result.query_echo.case_type).toBeUndefined();
    expect(result.query_echo.date_from).toBeUndefined();
    expect(result.query_echo.keyword).toBe('google');
  });

  it('keeps the format constraint for non-empty filter values', () => {
    expect(() => eurlex_get_cases.input.parse({ court: 'SUPREME' })).toThrow();
    expect(() => eurlex_get_cases.input.parse({ case_type: 'appeal' })).toThrow();
    expect(() => eurlex_get_cases.input.parse({ date_from: '2016' })).toThrow();
  });

  // --- Whitespace-only keyword normalization (issue #25) ---

  it('omits a whitespace-only keyword from the echo and browses on the sector-6 bound (issue #25)', async () => {
    const ctx = createMockContext({ errors: eurlex_get_cases.errors });
    mockQuery.mockResolvedValue([makeCaseBinding('62024TJ0591', { date: '2026-07-01' })]);

    const input = eurlex_get_cases.input.parse({ keyword: '   ', limit: 3 });
    const result = await eurlex_get_cases.handler(input, ctx);

    // get_cases always carries the sector-6 filter, so a bare browse of recent case
    // law is valid — no no-filter guard. The blank keyword adds no clause or echo key.
    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sparql).toContain('STRSTARTS(STR(?celexNumber), "6")');
    expect(sparql).not.toContain('bif:contains');
    expect(result.query_echo.keyword).toBeUndefined();
    expect(result.total).toBe(1);
  });

  it('echoes the trimmed keyword, not the raw padded value (issue #25)', async () => {
    const ctx = createMockContext({ errors: eurlex_get_cases.errors });
    mockQuery.mockResolvedValue([makeCaseBinding('62013CJ0131')]);

    const input = eurlex_get_cases.input.parse({ keyword: '  google  ' });
    const result = await eurlex_get_cases.handler(input, ctx);

    expect(result.query_echo.keyword).toBe('google');
  });

  // --- #28: truncation disclosure ---

  it('discloses truncation when the returned page fills the limit', async () => {
    const ctx = createMockContext({ errors: eurlex_get_cases.errors });
    mockQuery.mockResolvedValue([makeCaseBinding('62013CJ0131'), makeCaseBinding('62020TJ0022')]);

    const input = eurlex_get_cases.input.parse({ keyword: 'x', limit: 2 });
    await eurlex_get_cases.handler(input, ctx);

    const enriched = getEnrichment(ctx);
    expect(enriched.truncated).toBe(true);
    expect(enriched.shown).toBe(2);
    expect(enriched.cap).toBe(2);
  });

  it('does not disclose truncation when the page is short of the limit', async () => {
    const ctx = createMockContext({ errors: eurlex_get_cases.errors });
    mockQuery.mockResolvedValue([makeCaseBinding('62013CJ0131')]);

    const input = eurlex_get_cases.input.parse({ keyword: 'x', limit: 2 });
    await eurlex_get_cases.handler(input, ctx);

    expect(getEnrichment(ctx).truncated).toBeUndefined();
  });

  // --- #44: derivative sector-6 records excluded on the untyped/default path ---

  it('excludes derivative resource-types on the untyped/default path (issue #44)', async () => {
    const ctx = createMockContext({ errors: eurlex_get_cases.errors });
    mockQuery.mockResolvedValue([
      makeCaseBinding('62014CJ0362', {
        types: 'http://publications.europa.eu/resource/authority/resource-type/JUDG',
      }),
    ]);

    const input = eurlex_get_cases.input.parse({ keyword: 'schrems' });
    await eurlex_get_cases.handler(input, ctx);

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    // A single FILTER NOT EXISTS drops any work carrying a derivative case-law type,
    // so derivative notices/abstracts/summaries can't crowd primary cases off the page.
    expect(sparql).toContain('FILTER NOT EXISTS');
    expect(sparql).toContain('cdm:work_has_resource-type ?derivativeType');
    expect(sparql).toContain('resource-type/INFO_JUDICIAL');
    expect(sparql).toContain('resource-type/INFO_JUR>');
    expect(sparql).toContain('resource-type/ABSTRACT_JUR');
    expect(sparql).toContain('resource-type/SUM_JUR');
  });

  it('include_derivative:true re-admits derivative records with human-readable labels (issue #44)', async () => {
    const ctx = createMockContext({ errors: eurlex_get_cases.errors });
    mockQuery.mockResolvedValue([
      makeCaseBinding('62021CA0446', {
        types: 'http://publications.europa.eu/resource/authority/resource-type/INFO_JUDICIAL',
      }),
    ]);

    const input = eurlex_get_cases.input.parse({ keyword: 'schrems', include_derivative: true });
    const result = await eurlex_get_cases.handler(input, ctx);

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    // Opting in skips the exclusion entirely.
    expect(sparql).not.toContain('FILTER NOT EXISTS');
    // The re-admitted derivative row resolves its type to a label, not a raw code.
    expect(result.cases[0]?.celex_number).toBe('62021CA0446');
    expect(result.cases[0]?.resource_type).toBe('Judicial Information Notice');
  });

  it('a case_type filter needs no derivative exclusion — its resource-type triple already excludes them (issue #44)', async () => {
    const ctx = createMockContext({ errors: eurlex_get_cases.errors });
    mockQuery.mockResolvedValue([
      makeCaseBinding('62014CJ0362', {
        types: 'http://publications.europa.eu/resource/authority/resource-type/JUDG',
      }),
    ]);

    const input = eurlex_get_cases.input.parse({ keyword: 'schrems', case_type: 'judgment' });
    await eurlex_get_cases.handler(input, ctx);

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sparql).not.toContain('FILTER NOT EXISTS');
    expect(sparql).toContain(
      '?work cdm:work_has_resource-type <http://publications.europa.eu/resource/authority/resource-type/JUDG> .',
    );
  });

  it('keeps type-less older cases on the default path — the exclusion never drops them (issue #44)', async () => {
    const ctx = createMockContext({ errors: eurlex_get_cases.errors });
    // An older case with no resource-type binding at all (GROUP_CONCAT yields no types).
    mockQuery.mockResolvedValue([makeCaseBinding('61962CJ0026', { date: '1963-02-05' })]);

    const input = eurlex_get_cases.input.parse({ keyword: 'van gend' });
    const result = await eurlex_get_cases.handler(input, ctx);

    // The exclusion is a server-side FILTER NOT EXISTS (a type-less work carries none
    // of the derivative types, so recall is preserved), and the handler never
    // client-side-drops a type-less row: the case still surfaces.
    expect(result.total).toBe(1);
    expect(result.cases[0]?.celex_number).toBe('61962CJ0026');
    expect(result.cases[0]?.resource_type).toBeUndefined();
  });

  // --- Format ---

  it('format renders celex, date, type label, and title', () => {
    const output = {
      cases: [
        {
          work_uri: 'http://publications.europa.eu/resource/cellar/google-spain',
          celex_number: '62013CJ0131',
          date: '2014-05-13',
          title: 'Google Spain SL v AEPD',
          resource_type: 'Judgment',
        },
      ],
      total: 1,
      offset: 0,
      query_echo: { keyword: 'google' },
    };
    const blocks = eurlex_get_cases.format!(output);
    expect(blocks[0]?.type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('62013CJ0131');
    expect(text).toContain('Google Spain SL v AEPD');
    expect(text).toContain('2014-05-13');
    expect(text).toContain('Judgment');
    expect(text).toContain('keyword="google"');
  });

  it('format handles sparse case (no title or type)', () => {
    const output = {
      cases: [
        {
          work_uri: 'http://publications.europa.eu/resource/cellar/sparse-case',
          celex_number: '62020TJ0001',
        },
      ],
      total: 1,
      offset: 0,
      query_echo: {},
    };
    const blocks = eurlex_get_cases.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('62020TJ0001');
  });

  // --- #40: case title parsed into structured fields ---

  it('parses a #-delimited case title into structured fields, preserving the raw title', async () => {
    const ctx = createMockContext({ errors: eurlex_get_cases.errors });
    const rawTitle =
      'Judgment of the Court (Grand Chamber) of 10 February 2026.#WhatsApp Ireland Ltd v European Data Protection Board.#Appeal – Protection of natural persons – Regulation (EU) 2016/679.#Case C-97/23 P.';
    mockQuery.mockResolvedValue([
      makeCaseBinding('62023CJ0097', {
        date: '2026-02-10',
        title: rawTitle,
        types: 'http://publications.europa.eu/resource/authority/resource-type/JUDG',
      }),
    ]);

    const input = eurlex_get_cases.input.parse({ keyword: 'data protection' });
    const result = await eurlex_get_cases.handler(input, ctx);

    const c = result.cases[0];
    // Raw title preserved verbatim — nothing dropped (issue #40 is additive).
    expect(c?.title).toBe(rawTitle);
    // Parsed segments surfaced alongside it.
    expect(c?.display_title).toBe('WhatsApp Ireland Ltd v European Data Protection Board.');
    expect(c?.parties).toBe('WhatsApp Ireland Ltd v European Data Protection Board.');
    expect(c?.case_reference).toBe('Case C-97/23 P.');
    expect(c?.subject_matter).toContain('Protection of natural persons');
  });

  it('leaves structured title fields unset for a sparse AG-opinion title', async () => {
    const ctx = createMockContext({ errors: eurlex_get_cases.errors });
    const rawTitle = 'Opinion of Advocate General Kokott delivered on 2 July 2026.###';
    mockQuery.mockResolvedValue([
      makeCaseBinding('62025CC0383', {
        date: '2026-07-02',
        title: rawTitle,
        types: 'http://publications.europa.eu/resource/authority/resource-type/OPIN_AG',
      }),
    ]);

    const input = eurlex_get_cases.input.parse({ case_type: 'ag_opinion' });
    const result = await eurlex_get_cases.handler(input, ctx);

    const c = result.cases[0];
    expect(c?.title).toBe(rawTitle);
    // The parties/subject/reference segments are empty — none is fabricated.
    expect(c?.parties).toBeUndefined();
    expect(c?.subject_matter).toBeUndefined();
    expect(c?.case_reference).toBeUndefined();
    // The display title still resolves to the clean AG descriptor.
    expect(c?.display_title).toBe('Opinion of Advocate General Kokott delivered on 2 July 2026.');
  });

  it('keeps a plain (non-"#") title as-is with no structured fields', async () => {
    const ctx = createMockContext({ errors: eurlex_get_cases.errors });
    mockQuery.mockResolvedValue([
      makeCaseBinding('62013CJ0131', { title: 'Google Spain SL v AEPD' }),
    ]);

    const input = eurlex_get_cases.input.parse({ keyword: 'google' });
    const result = await eurlex_get_cases.handler(input, ctx);

    const c = result.cases[0];
    expect(c?.title).toBe('Google Spain SL v AEPD');
    expect(c?.display_title).toBeUndefined();
    expect(c?.parties).toBeUndefined();
    expect(c?.case_reference).toBeUndefined();
  });

  it('format renders the clean display title, subject matter, and case reference (issue #40)', () => {
    const output = {
      cases: [
        {
          work_uri: 'http://publications.europa.eu/resource/cellar/whatsapp',
          celex_number: '62023CJ0097',
          date: '2026-02-10',
          resource_type: 'Judgment',
          title:
            'Judgment of the Court of 10 February 2026.#WhatsApp Ireland Ltd v European Data Protection Board.#Appeal – Protection of natural persons.#Case C-97/23 P.',
          display_title: 'WhatsApp Ireland Ltd v European Data Protection Board.',
          parties: 'WhatsApp Ireland Ltd v European Data Protection Board.',
          subject_matter: 'Appeal – Protection of natural persons.',
          case_reference: 'Case C-97/23 P.',
        },
      ],
      total: 1,
      offset: 0,
      query_echo: { case_type: 'judgment' },
    };
    const blocks = eurlex_get_cases.format!(output);
    const text = (blocks[0] as { text: string }).text;
    // Heading uses the clean display title, not the raw "#"-delimited string.
    expect(text).toContain('62023CJ0097 — WhatsApp Ireland Ltd v European Data Protection Board.');
    const headingLine = text.split('\n').find((l) => l.startsWith('### '));
    expect(headingLine).not.toContain('#Appeal');
    expect(text).toContain('**Parties:** WhatsApp Ireland Ltd v European Data Protection Board.');
    expect(text).toContain('**Subject matter:** Appeal – Protection of natural persons.');
    expect(text).toContain('**Case reference:** Case C-97/23 P.');
    // The full raw title stays available as a labelled line (format parity).
    expect(text).toContain('**Full title:** Judgment of the Court of 10 February 2026.#WhatsApp');
  });
});
