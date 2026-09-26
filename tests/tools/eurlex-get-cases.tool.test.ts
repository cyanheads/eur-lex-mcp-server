/**
 * @fileoverview Tests for eurlex_get_cases tool.
 * @module tests/tools/eurlex-get-cases.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eurlex_get_cases } from '@/mcp-server/tools/definitions/eurlex-get-cases.tool.js';
import { escapeSparqlLiteral } from '@/services/cellar-sparql/eli-resolution.js';
import { canonicalWork, celexWorkRows, fixtureWork } from '../fixtures/cellar-works.js';

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
    ecli?: string;
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
  if (opts.ecli) b.ecli = { type: 'literal', value: opts.ecli };
  return b;
}

/** Every text block of a tool result's content[], joined. */
function contentText(result: { content: unknown[] }): string {
  return result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
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

/** Evaluate one atom of a generated CELEX filter against a CELEX value. */
function evaluateCelexAtom(atom: string, celex: string): boolean {
  const startsWith = /^STRSTARTS\(STR\(\?celexNumber\), "([^"]*)"\)$/.exec(atom);
  if (startsWith) return celex.startsWith(startsWith[1] ?? '');
  const contains = /^CONTAINS\(STR\(\?celexNumber\), "([^"]*)"\)$/.exec(atom);
  if (contains) return celex.includes(contains[1] ?? '');
  const lcaseContains = /^CONTAINS\(LCASE\(STR\(\?celexNumber\)\), LCASE\("([^"]*)"\)\)$/.exec(
    atom,
  );
  if (lcaseContains) return celex.toLowerCase().includes((lcaseContains[1] ?? '').toLowerCase());
  const regex = /^REGEX\(STR\(\?celexNumber\), "([^"]*)"\)$/.exec(atom);
  if (regex) return new RegExp(regex[1] ?? '').test(celex);
  const substr = /^SUBSTR\(STR\(\?celexNumber\), (\d+), (\d+)\) = "([^"]*)"$/.exec(atom);
  if (substr) {
    const start = Number(substr[1]) - 1;
    return celex.slice(start, start + Number(substr[2])) === substr[3];
  }
  throw new Error(`Unrecognized CELEX filter atom: ${atom}`);
}

/**
 * Whether a generated query's CELEX-string filters — the sector-6 bound, the
 * case_number match, and the court filter — admit a real CELEX value. Tests assert
 * which records a query can reach rather than the text it contains; the atom shapes
 * are those the tool emits (and emitted before), and any other shape throws, so a
 * filter this helper cannot read never passes silently. Resource-type filtering
 * (case_type, the derivative exclusion) is server-side and outside its scope.
 */
function admits(sparql: string, celex: string): boolean {
  const filters = sparql
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('FILTER(') && line.includes('STR(?celexNumber)'));
  if (filters.length === 0) throw new Error('No CELEX filter in the generated query');
  return filters.every((line) =>
    line
      .slice('FILTER('.length, -1)
      .split(' || ')
      .some((atom) => evaluateCelexAtom(atom, celex)),
  );
}

/** Every `?celexNumber bif:contains "…"` expression in a query. */
function indexExpressions(sparql: string): string[] {
  return [...sparql.matchAll(/\?celexNumber bif:contains "([^"]*)"/g)].map((m) => m[1] ?? '');
}

/**
 * Whether a query's CELEX index terms and CELEX filters both admit a CELEX, the
 * index modelled as CELLAR's: a term `'X*'` hits a literal when a word of it starts
 * with X, words split at every character outside `[0-9A-Z]`.
 */
function reaches(sparql: string, celex: string): boolean {
  const words = celex.split(/[^0-9A-Z]+/);
  const indexed = indexExpressions(sparql).every((expression) =>
    [...expression.matchAll(/'([0-9A-Z]+)\*'/g)].some(([, term]) =>
      words.some((word) => word.startsWith(term ?? '')),
    ),
  );
  return indexed && admits(sparql, celex);
}

/** Every record CELLAR holds under C-97/23 and T-97/23 (live, 2026-09-25). */
const C_97_23_PRIMARY = [
  '62023CJ0097',
  '62023CC0097',
  '62023CO0097',
  '62023CO0097(01)',
  '62023CO0097(02)',
];
const C_97_23_DERIVATIVE = ['62023CJ0097_RES', '62023CA0097', '62023CN0097'];
const T_97_23_RECORDS = ['62023TJ0097', '62023TJ0097_INF', '62023TA0097', '62023TN0097'];

describe('eurlex_get_cases', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockMaxResults = 100;
  });

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
    expect(admits(sparql, '62013CJ0131')).toBe(true);
    expect(admits(sparql, '62020TJ0001')).toBe(false);
  });

  it('applies court=GC filter', async () => {
    const ctx = createMockContext({ errors: eurlex_get_cases.errors });
    mockQuery.mockResolvedValue([makeCaseBinding('62020TJ0001')]);

    const input = eurlex_get_cases.input.parse({ court: 'GC' });
    await eurlex_get_cases.handler(input, ctx);

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    expect(admits(sparql, '62020TJ0001')).toBe(true);
    expect(admits(sparql, '62013CJ0131')).toBe(false);
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
    // Court stays a CELEX-letter test (the court letter C); case_type is the resource-type triple.
    expect(admits(sparql, '62013CJ0131')).toBe(true);
    expect(admits(sparql, '62020TJ0022')).toBe(false);
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
    expect(sparql).toContain('LIMIT 6');
    expect(sparql).toContain('OFFSET 10');
  });

  // --- case_number conversion ---

  it('converts C-131/12 to a CELEX match reaching 62012CJ0131 (#2)', async () => {
    const ctx = createMockContext({ errors: eurlex_get_cases.errors });
    mockQuery.mockResolvedValue([makeCaseBinding('62012CJ0131')]);

    const input = eurlex_get_cases.input.parse({ case_number: 'C-131/12' });
    const result = await eurlex_get_cases.handler(input, ctx);

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    // Should search the CELEX layout (year first), not the raw case number
    expect(admits(sparql, '62012CJ0131')).toBe(true);
    expect(sparql).not.toContain('131/12');
    expect(result.query_echo.celex_fragment).toBe('2012C*0131');
    expect(result.query_echo.case_number).toBe('C-131/12');
  });

  it('converts T-22/20 to a CELEX match reaching 62020TJ0022 (#2)', async () => {
    const ctx = createMockContext({ errors: eurlex_get_cases.errors });
    mockQuery.mockResolvedValue([makeCaseBinding('62020TJ0022')]);

    const input = eurlex_get_cases.input.parse({ case_number: 'T-22/20' });
    await eurlex_get_cases.handler(input, ctx);

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    expect(admits(sparql, '62020TJ0022')).toBe(true);
    expect(admits(sparql, '62020CJ0022')).toBe(false);
  });

  it('converts C-25/62 to a CELEX match reaching 61962CJ0025 (#2)', async () => {
    const ctx = createMockContext({ errors: eurlex_get_cases.errors });
    mockQuery.mockResolvedValue([makeCaseBinding('61962CJ0025')]);

    const input = eurlex_get_cases.input.parse({ case_number: 'C-25/62' });
    await eurlex_get_cases.handler(input, ctx);

    expect(admits(mockQuery.mock.calls[0]?.[0] as string, '61962CJ0025')).toBe(true);
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

  // --- Empty pages ---

  it('returns an empty first page with a broadening notice when query returns empty bindings', async () => {
    const ctx = createMockContext({ errors: eurlex_get_cases.errors });
    mockQuery.mockResolvedValue([]);

    const input = eurlex_get_cases.input.parse({ keyword: 'nonexistent-case-xyz' });
    const result = await eurlex_get_cases.handler(input, ctx);

    expect(result).toMatchObject({ cases: [], total: 0, offset: 0, has_more: false });
    expect(result.next_offset).toBeUndefined();
    expect(getEnrichment(ctx).notice).toContain('keyword=nonexistent-case-xyz');
  });

  it('returns an empty successful page when a non-zero offset is exhausted', async () => {
    const ctx = createMockContext({ errors: eurlex_get_cases.errors });
    mockQuery.mockResolvedValue([]);

    const input = eurlex_get_cases.input.parse({ keyword: 'google', offset: 200, limit: 20 });
    const result = await eurlex_get_cases.handler(input, ctx);

    expect(result).toMatchObject({
      cases: [],
      total: 0,
      offset: 200,
      has_more: false,
      query_echo: { keyword: 'google', include_derivative: false },
    });
    expect(result.next_offset).toBeUndefined();
    expect(getEnrichment(ctx).truncated).toBeUndefined();
    expect((eurlex_get_cases.format!(result)[0] as { text: string }).text).toContain(
      '**Has more:** false',
    );
  });

  it('carries no notice on either surface for a page past the end (#112)', async () => {
    mockQuery.mockResolvedValue([]);

    const result = await runToolContract(eurlex_get_cases, {
      keyword: 'google',
      offset: 200,
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      cases: [],
      total: 0,
      offset: 200,
      has_more: false,
      query_echo: { keyword: 'google', include_derivative: false },
    });
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(result.structuredContent).not.toHaveProperty('next_offset');
    expect(contentText(result)).not.toMatch(/^> /m);
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
    // A digit-free keyword is in no CELEX, so no CELEX arm is built (#105).
    expect(sparql).not.toContain('?kwCelex');
  });

  // --- #62: case_number and keyword escaping route through the shared helper ---
  //
  // Both sites hand-rolled a quote-only `.replace(/"/g, '\\"')` with no backslash
  // pass. A value ending in `\` then escaped the closing quote, the literal never
  // terminated, and Virtuoso's raw SP030 compiler error — carrying the internal
  // query text and PREFIX block — reached the client in place of this tool's own
  // empty result. Asserting only on the returned page would pass against the
  // unescaped value too (a mocked query returns its fixture whatever it is
  // handed); the built query text is the discriminating part.

  /**
   * A backslash is not a CELEX character, so since #81 a trailing-backslash
   * case_number is rejected as invalid_case_number before any query is built —
   * no literal reaches CELLAR at all, which closes the #62 leak more tightly than
   * escaping did. The CELEX-character fallback that remains still routes its
   * literal through escapeSparqlLiteral (asserted in the #81 fallback tests).
   */
  it('rejects a trailing-backslash case_number before any CELLAR request (#62, #81)', async () => {
    const ctx = createMockContext({ errors: eurlex_get_cases.errors });

    const input = eurlex_get_cases.input.parse({ case_number: 'ZZ\\' });
    await expect(eurlex_get_cases.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_case_number' },
    });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('keeps a trailing backslash in the keyword out of the query (#62, #105)', async () => {
    const ctx = createMockContext({ errors: eurlex_get_cases.errors });
    mockQuery.mockResolvedValue([]);

    const keyword = 'data\\';
    const input = eurlex_get_cases.input.parse({ keyword });
    await expect(eurlex_get_cases.handler(input, ctx)).resolves.toMatchObject({ total: 0 });

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    // A backslash is in no CELEX, so no CELEX arm carries the raw value, and the
    // full-text arm strips it.
    expect(sparql).not.toContain('?kwCelex');
    expect(sparql).not.toContain('data\\');
    expect(sparql).toContain(`bif:contains "'data'"`);
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

    // A CELEX-character value with a trailing tab still takes the substring
    // scan (#81, #134), so the trim-then-escape order stays observable there.
    const input = eurlex_get_cases.input.parse({ case_number: '0097\t' });
    await expect(eurlex_get_cases.handler(input, ctx)).resolves.toMatchObject({ total: 0 });

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sparql).toContain('LCASE("0097")');
    // Escaping first would leave an escaped tab the trim could not remove.
    expect(sparql).not.toContain(String.raw`0097\t`);
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
    // Both types resolve, de-duplicate, sort, and join: JUDG maps to "Judgment"
    // and CORRIGENDUM to "Corrigendum" (#86), which still sorts first.
    expect(result.cases[0]?.resource_type).toBe('Corrigendum, Judgment');
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
    expect(sparql).toMatch(/GROUP BY \?celexNumber[\s\S]*LIMIT 3/);
    expect(result.total).toBe(2);
    expect(new Set(result.cases.map((c) => c.work_uri)).size).toBe(2);
  });

  it('orders the page by date, then CELEX, so records sharing a date keep one order (#102)', async () => {
    const ctx = createMockContext({ errors: eurlex_get_cases.errors });
    mockQuery.mockResolvedValue([makeCaseBinding('62024TJ0459', { date: '2026-09-16' })]);

    await eurlex_get_cases.handler(eurlex_get_cases.input.parse({ court: 'GC', offset: 20 }), ctx);

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    // The tiebreak is the GROUP BY key: Virtuoso does not sort on the projected
    // SAMPLE alias ?celex, so ordering by it leaves same-date rows unordered.
    expect(sparql).toMatch(
      /\} GROUP BY \?celexNumber ORDER BY DESC\(\?docDate\) \?celexNumber LIMIT 21 OFFSET 20$/,
    );
    expect(sparql).not.toMatch(/ORDER BY[^\n]*\?celex\b/);
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
    expect(() => eurlex_get_cases.input.parse({ limit: 101 })).toThrow();
    expect(() => eurlex_get_cases.input.parse({ offset: -1 })).toThrow();
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

  // --- #72: proven continuation ---

  it('does not disclose continuation for an exactly-full final page', async () => {
    const ctx = createMockContext({ errors: eurlex_get_cases.errors });
    mockQuery.mockResolvedValue([makeCaseBinding('62013CJ0131'), makeCaseBinding('62020TJ0022')]);

    const input = eurlex_get_cases.input.parse({ keyword: 'x', limit: 2 });
    const result = await eurlex_get_cases.handler(input, ctx);

    expect(result.cases).toHaveLength(2);
    expect(result.has_more).toBe(false);
    expect(result.next_offset).toBeUndefined();
    expect(getEnrichment(ctx).truncated).toBeUndefined();
  });

  it('returns one-row continuation proof without exposing the sentinel row', async () => {
    const ctx = createMockContext({ errors: eurlex_get_cases.errors });
    mockQuery.mockResolvedValue([
      makeCaseBinding('62013CJ0131'),
      makeCaseBinding('62020TJ0022'),
      makeCaseBinding('62024CJ0001'),
    ]);

    const input = eurlex_get_cases.input.parse({ keyword: 'x', limit: 2 });
    const result = await eurlex_get_cases.handler(input, ctx);

    expect(result.cases).toHaveLength(2);
    expect(result.has_more).toBe(true);
    expect(result.next_offset).toBe(2);
    expect(mockQuery.mock.calls[0]?.[0]).toContain('LIMIT 3');
    expect(getEnrichment(ctx)).toMatchObject({ truncated: true, shown: 2, cap: 2 });
    const text = (eurlex_get_cases.format!(result)[0] as { text: string }).text;
    expect(text).toContain('**Has more:** true');
    expect(text).toContain('**Next offset:** 2');
  });

  it('uses the service ceiling as the effective page size when it is lower than limit', async () => {
    const ctx = createMockContext({ errors: eurlex_get_cases.errors });
    mockMaxResults = 2;
    mockQuery.mockResolvedValue([
      makeCaseBinding('62013CJ0131'),
      makeCaseBinding('62020TJ0022'),
      makeCaseBinding('62024CJ0001'),
    ]);

    const input = eurlex_get_cases.input.parse({ keyword: 'x', limit: 100 });
    const result = await eurlex_get_cases.handler(input, ctx);

    expect(result.cases).toHaveLength(2);
    expect(result.has_more).toBe(true);
    expect(result.next_offset).toBe(2);
    expect(mockQuery.mock.calls[0]?.[0]).toContain('LIMIT 3');
    expect(getEnrichment(ctx)).toMatchObject({ truncated: true, shown: 2, cap: 2 });
  });

  it('does not disclose continuation when the page is short of the limit', async () => {
    const ctx = createMockContext({ errors: eurlex_get_cases.errors });
    mockQuery.mockResolvedValue([makeCaseBinding('62013CJ0131')]);

    const input = eurlex_get_cases.input.parse({ keyword: 'x', limit: 2 });
    const result = await eurlex_get_cases.handler(input, ctx);

    expect(result.has_more).toBe(false);
    expect(result.next_offset).toBeUndefined();
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

  // --- #55: standalone corrigenda excluded on the untyped/default path ---

  it('excludes standalone CORRIGENDUM works on the untyped/default path (issue #55)', async () => {
    const ctx = createMockContext({ errors: eurlex_get_cases.errors });
    mockQuery.mockResolvedValue([
      makeCaseBinding('62014CJ0362', {
        types: 'http://publications.europa.eu/resource/authority/resource-type/JUDG',
      }),
    ]);

    const input = eurlex_get_cases.input.parse({ keyword: 'corrigendum' });
    await eurlex_get_cases.handler(input, ctx);

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    // A standalone corrigendum (CELEX …R(nn)) is a derivative correction record, not a
    // primary case, so the default FILTER NOT EXISTS must drop the CORRIGENDUM type
    // alongside the notice/abstract/summary types — it is absent from the list pre-fix.
    expect(sparql).toContain('FILTER NOT EXISTS');
    expect(sparql).toContain('resource-type/CORRIGENDUM');
  });

  it('include_derivative:true re-admits a standalone corrigendum with resolved labels (issue #55)', async () => {
    const ctx = createMockContext({ errors: eurlex_get_cases.errors });
    // A sector-6 corrigendum carries CORRIGENDUM alongside INFO_JUDICIAL (the live shape).
    mockQuery.mockResolvedValue([
      makeCaseBinding('62026TN0267R(01)', {
        date: '2026-07-13',
        types:
          'http://publications.europa.eu/resource/authority/resource-type/CORRIGENDUM ' +
          'http://publications.europa.eu/resource/authority/resource-type/INFO_JUDICIAL',
      }),
    ]);

    const input = eurlex_get_cases.input.parse({
      keyword: 'corrigendum',
      include_derivative: true,
    });
    const result = await eurlex_get_cases.handler(input, ctx);

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    // Opting in skips the exclusion entirely, so the corrigendum is returned with both
    // type labels resolved — CORRIGENDUM among them since #86 (it still sorts first).
    expect(sparql).not.toContain('FILTER NOT EXISTS');
    expect(result.cases[0]?.celex_number).toBe('62026TN0267R(01)');
    expect(result.cases[0]?.resource_type).toBe('Corrigendum, Judicial Information Notice');
  });

  // --- #57: include_derivative echoed in query_echo after the default is applied ---

  it('echoes the effective include_derivative:false in query_echo and content[] on a default call (issue #57)', async () => {
    const ctx = createMockContext({ errors: eurlex_get_cases.errors });
    mockQuery.mockResolvedValue([makeCaseBinding('62013CJ0131')]);

    const input = eurlex_get_cases.input.parse({ keyword: 'google' });
    const result = await eurlex_get_cases.handler(input, ctx);

    // The false default still shapes which records can appear, so it must be echoed
    // even though the caller never supplied it — pre-fix query_echo omits it entirely.
    expect(result.query_echo.include_derivative).toBe(false);
    // structuredContent ↔ content[] parity: the flag surfaces in the filter summary.
    const text = (eurlex_get_cases.format!(result)[0] as { text: string }).text;
    expect(text).toContain('include_derivative=false');
  });

  it('echoes include_derivative:true in query_echo and content[] when the caller opts in (issue #57)', async () => {
    const ctx = createMockContext({ errors: eurlex_get_cases.errors });
    mockQuery.mockResolvedValue([makeCaseBinding('62026TN0267R(01)')]);

    // Mirrors the live-HTTP repro from #57: pre-fix this echoed only `keyword`.
    const input = eurlex_get_cases.input.parse({
      keyword: 'Corrigendum',
      include_derivative: true,
      limit: 1,
    });
    const result = await eurlex_get_cases.handler(input, ctx);

    expect(result.query_echo.include_derivative).toBe(true);
    expect(result.query_echo.keyword).toBe('Corrigendum');
    const text = (eurlex_get_cases.format!(result)[0] as { text: string }).text;
    expect(text).toContain('include_derivative=true');
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
      has_more: false,
      query_echo: { keyword: 'google', include_derivative: false },
    };
    const blocks = eurlex_get_cases.format!(output);
    expect(blocks[0]?.type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('62013CJ0131');
    expect(text).toContain('Google Spain SL v AEPD');
    expect(text).toContain('2014-05-13');
    expect(text).toContain('Judgment');
    expect(text).toContain('keyword="google"');
    expect(text).toContain('**Has more:** false');
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
      has_more: false,
      query_echo: { include_derivative: false },
    };
    const blocks = eurlex_get_cases.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('62020TJ0001');
  });

  // --- #40: case title parsed into structured fields ---

  it('parses a #-delimited case title into structured fields, dropping the raw title on a complete parse', async () => {
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
    // Every segment landed in a field and the title is dated as the row is (#116).
    expect(c).not.toHaveProperty('title');
    expect(c?.formation).toBe('Grand Chamber');
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
    // The descriptor is the only segment, and it parses: the raw title adds nothing.
    expect(c).not.toHaveProperty('title');
    expect(c?.advocate_general).toBe('Kokott');
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
      has_more: false,
      query_echo: { case_type: 'judgment', include_derivative: false },
    };
    const blocks = eurlex_get_cases.format!(output);
    const text = (blocks[0] as { text: string }).text;
    // Heading uses the clean display title, not the raw "#"-delimited string.
    expect(text).toContain('62023CJ0097 — WhatsApp Ireland Ltd v European Data Protection Board.');
    const headingLine = text.split('\n').find((l) => l.startsWith('### '));
    expect(headingLine).not.toContain('#Appeal');
    // The parties are the heading, so no Parties line repeats them (#116).
    expect(text).not.toContain('**Parties:**');
    expect(text).toContain('**Subject matter:** Appeal – Protection of natural persons.');
    expect(text).toContain('**Case reference:** Case C-97/23 P.');
    // The full raw title stays available as a labelled line (format parity).
    expect(text).toContain('**Full title:** Judgment of the Court of 10 February 2026.#WhatsApp');
  });

  // --- #116: formation, referring court, AG; raw title only when unparsed ---

  describe('parsed case fields and the complete-parse title rule (#116)', () => {
    const JUDG = 'http://publications.europa.eu/resource/authority/resource-type/JUDG';
    const OPIN_AG = 'http://publications.europa.eu/resource/authority/resource-type/OPIN_AG';
    const PARTIES =
      'Google Spain SL and Google Inc. v Agencia Española de Protección de Datos (AEPD) and Mario Costeja González.';
    const SUBJECT =
      'Personal data — Protection of individuals with regard to the processing of such data — Directive 95/46/EC — Articles 7 and 8.';
    const TAIL = `#${PARTIES}#Request for a preliminary ruling from the Audiencia Nacional.#${SUBJECT}#Case C‑131/12.`;
    const USDAW =
      'Advocate General’s Opinion - 5 February 2015#USDAW and Wilson#Case C-80/14#Advocate General: Wahl';
    const SPACENET =
      'Judgment of the Court (Grand Chamber) of 20 September 2022.#Bundesrepublik Deutschland v SpaceNet AG.#Requests for a preliminary ruling from the Bundesverwaltungsgericht.#Reference for a preliminary ruling – Processing of personal data.#Joined Cases C-793/19 and C-794/19.';
    const PLAIN = 'Opinion of Advocate General Cruz Villalón delivered on 8 September 2015.';
    const EXTRACTS =
      'Judgment of the General Court (Eighth Chamber) of 15 September 2016 (Extracts).#Italian Republic v European Commission.#Rules on languages — Notices of open competition.#Cases T-353/14 and T-17/15.';

    /** The C-131/12 page as CELLAR returns it: the judgment and the AG opinion. */
    const googleSpainPage = () => [
      makeCaseBinding('62012CJ0131', {
        date: '2014-05-13',
        ecli: 'ECLI:EU:C:2014:317',
        types: JUDG,
        title: `Judgment of the Court (Grand Chamber), 13 May 2014.${TAIL}`,
      }),
      makeCaseBinding('62012CC0131', {
        date: '2013-06-25',
        ecli: 'ECLI:EU:C:2013:424',
        types: OPIN_AG,
        title: `Opinion of Advocate General Jääskinen delivered on 25 June 2013.${TAIL}`,
      }),
    ];

    it('returns the C-131/12 judgment row as parsed fields with no raw title, on both surfaces', async () => {
      mockQuery.mockImplementation(async (q: string) =>
        q.includes('GROUP BY ?celexNumber') ? googleSpainPage() : celexWorkRows(q),
      );

      const result = await runToolContract(eurlex_get_cases, { case_number: 'C-131/12' });

      expect(result.isError).toBeFalsy();
      const structured = eurlex_get_cases.output.parse(result.structuredContent);
      const [judgment, opinion] = structured.cases;
      const { work_uri: _workUri, ...judgmentFields } = judgment ?? { work_uri: '' };
      expect(judgmentFields).toEqual({
        celex_number: '62012CJ0131',
        ecli: 'ECLI:EU:C:2014:317',
        resource_type: 'Judgment',
        date: '2014-05-13',
        formation: 'Grand Chamber',
        display_title: PARTIES,
        parties: PARTIES,
        referring_court: 'Audiencia Nacional',
        subject_matter: SUBJECT,
        case_reference: 'Case C‑131/12.',
      });
      expect(opinion).toMatchObject({
        advocate_general: 'Jääskinen',
        referring_court: 'Audiencia Nacional',
      });
      expect(opinion).not.toHaveProperty('title');
      expect(opinion).not.toHaveProperty('formation');

      const text = contentText(result);
      expect(text).toContain(`### 62012CJ0131 — ${PARTIES}`);
      expect(text).toContain('**Formation:** Grand Chamber');
      expect(text).toContain('**Advocate General:** Jääskinen');
      expect(text).toContain('**Referring court:** Audiencia Nacional');
      expect(text).toContain(`**Subject matter:** ${SUBJECT}`);
      expect(text).not.toContain('**Full title:**');
      expect(text).not.toContain('**Parties:**');
    });

    it.each([
      ['a leading segment of no known shape', '62014CC0080', '2015-02-05', USDAW],
      ['a leading date that differs from the row date', '62019CJ0793', '2022-10-27', SPACENET],
      ['a title with no "#"', '62014CC0489', '2015-09-08', PLAIN],
      ['a judgment published by extracts', '62014TJ0353', '2016-09-15', EXTRACTS],
    ])('keeps the raw title on both surfaces for %s', async (_label, celex, date, title) => {
      mockQuery.mockImplementation(async (q: string) =>
        q.includes('GROUP BY ?celexNumber')
          ? [makeCaseBinding(celex, { date, title })]
          : celexWorkRows(q),
      );

      const result = await runToolContract(eurlex_get_cases, { keyword: 'test' });

      const structured = eurlex_get_cases.output.parse(result.structuredContent);
      expect(structured.cases[0]?.title).toBe(title);
      expect(contentText(result)).toContain(`**Full title:** ${title}`);
    });

    it('reads a joined-case reference and keeps the keyword segment as subject matter', async () => {
      mockQuery.mockResolvedValue([
        makeCaseBinding('62019CJ0793', { date: '2022-09-20', title: SPACENET, types: JUDG }),
      ]);

      const result = await eurlex_get_cases.handler(
        eurlex_get_cases.input.parse({ keyword: 'SpaceNet' }),
        createMockContext({ errors: eurlex_get_cases.errors }),
      );

      expect(result.cases[0]).toMatchObject({
        case_reference: 'Joined Cases C-793/19 and C-794/19.',
        referring_court: 'Bundesverwaltungsgericht',
        subject_matter: 'Reference for a preliminary ruling – Processing of personal data.',
      });
      expect(result.cases[0]).not.toHaveProperty('title');
    });

    it('keeps the Parties line when the heading is not the parties', () => {
      const blocks = eurlex_get_cases.format!({
        cases: [
          {
            work_uri: 'http://publications.europa.eu/resource/cellar/usdaw',
            celex_number: '62014CC0080',
            title: USDAW,
            parties: 'USDAW and Wilson',
          },
        ],
        total: 1,
        offset: 0,
        has_more: false,
        query_echo: { include_derivative: false },
      });
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain(`### 62014CC0080 — ${USDAW}`);
      expect(text).toContain('**Parties:** USDAW and Wilson');
    });

    it('adds formation, referring_court, and advocate_general as the only new optional row fields', () => {
      const row = eurlex_get_cases.output.shape.cases.element;
      expect(Object.keys(row.shape).sort()).toEqual(
        [
          'advocate_general',
          'case_reference',
          'celex_number',
          'date',
          'display_title',
          'ecli',
          'formation',
          'parties',
          'referring_court',
          'resource_type',
          'subject_matter',
          'title',
          'work_uri',
        ].sort(),
      );
      for (const field of ['formation', 'referring_court', 'advocate_general', 'title'] as const) {
        expect(row.shape[field].safeParse(undefined).success).toBe(true);
      }
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
      const ctx = createMockContext({ errors: eurlex_get_cases.errors });

      const input = eurlex_get_cases.input.parse({ date_from: value, limit: 1 });
      const err = await Promise.resolve(eurlex_get_cases.handler(input, ctx)).catch(
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
      const ctx = createMockContext({ errors: eurlex_get_cases.errors });

      const input = eurlex_get_cases.input.parse({ date_to: '2026-13-01', limit: 1 });
      const err = await Promise.resolve(eurlex_get_cases.handler(input, ctx)).catch(
        (e: unknown) => e,
      );

      expect(err).toMatchObject({ data: { reason: 'invalid_date_range' } });
      expect((err as { message: string }).message).toContain('date_to');
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('accepts the leap day 2024-02-29 and builds its filter clause', async () => {
      const ctx = createMockContext({ errors: eurlex_get_cases.errors });
      mockQuery.mockResolvedValue([makeCaseBinding('62024CJ0629')]);

      const input = eurlex_get_cases.input.parse({ date_from: '2024-02-29', limit: 1 });
      await eurlex_get_cases.handler(input, ctx);

      expect(mockQuery.mock.calls[0]?.[0] as string).toContain('"2024-02-29"^^xsd:date');
    });

    it('names the expected date shape when the schema rejects a malformed date', () => {
      // The shape gate fires before the handler, so its own message is the only
      // guidance the caller gets — a bare "Invalid string" leaves them guessing.
      const parsed = eurlex_get_cases.input.safeParse({ date_to: '2016-5-4', limit: 1 });
      expect(parsed.success).toBe(false);
      expect(JSON.stringify(parsed.error?.issues)).toContain(
        'date_to must be a calendar date in YYYY-MM-DD form, zero-padded (e.g. 2016-05-04).',
      );
    });

    it('rejects an inverted range and says so', async () => {
      const ctx = createMockContext({ errors: eurlex_get_cases.errors });

      const input = eurlex_get_cases.input.parse({
        date_from: '2020-12-31',
        date_to: '2020-01-01',
        limit: 1,
      });
      const err = await Promise.resolve(eurlex_get_cases.handler(input, ctx)).catch(
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
      const ctx = createMockContext({ errors: eurlex_get_cases.errors });
      mockQuery.mockResolvedValue([makeCaseBinding('62024CJ0629')]);

      const input = eurlex_get_cases.input.parse({
        date_from: '2020-01-01',
        date_to: '2020-01-01',
        limit: 1,
      });
      await eurlex_get_cases.handler(input, ctx);

      const sparql = mockQuery.mock.calls[0]?.[0] as string;
      expect(sparql).toContain('FILTER(?date >= "2020-01-01"^^xsd:date)');
      expect(sparql).toContain('FILTER(?date <= "2020-01-01"^^xsd:date)');
    });

    it('leaves date_to alone as a valid single-bound filter', async () => {
      const ctx = createMockContext({ errors: eurlex_get_cases.errors });
      mockQuery.mockResolvedValue([makeCaseBinding('62024CJ0629')]);

      const input = eurlex_get_cases.input.parse({ date_to: '2020-01-01', limit: 1 });
      const result = await eurlex_get_cases.handler(input, ctx);

      const sparql = mockQuery.mock.calls[0]?.[0] as string;
      expect(sparql).toContain('FILTER(?date <= "2020-01-01"^^xsd:date)');
      expect(sparql).not.toContain('FILTER(?date >= ');
      expect(result.query_echo.date_to).toBe('2020-01-01');
      expect(result.query_echo.date_from).toBeUndefined();
    });

    it('runs no calendar check on blank date fields, which stay out of the echo', async () => {
      const ctx = createMockContext({ errors: eurlex_get_cases.errors });
      mockQuery.mockResolvedValue([makeCaseBinding('62024CJ0629')]);

      const input = eurlex_get_cases.input.parse({
        keyword: 'competition',
        date_from: '',
        date_to: '',
      });
      const result = await eurlex_get_cases.handler(input, ctx);

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
      expect(() => eurlex_get_cases.input.parse({ date_from: value })).toThrow();
      expect(() => eurlex_get_cases.input.parse({ date_to: value })).toThrow();
    });

    /**
     * Both public surfaces must carry the diagnosis: Claude Code reads
     * structuredContent, Claude Desktop reads content[]. Driving the definition
     * through the real handler factory is what proves the pair, rather than
     * inspecting the thrown error alone.
     */
    it('reaches the caller on both content[] and structuredContent.error', async () => {
      const result = await runToolContract(eurlex_get_cases, { date_from: '2026-99-99', limit: 1 });

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

  // --- #81: case_number reaches every record the court files under that number ---

  describe('case_number matching (#81)', () => {
    async function queryFor(input: Record<string, unknown>): Promise<{
      sparql: string;
      result: Awaited<ReturnType<typeof eurlex_get_cases.handler>>;
    }> {
      const ctx = createMockContext({ errors: eurlex_get_cases.errors });
      mockQuery.mockResolvedValue([makeCaseBinding('62023CJ0097')]);
      const result = await eurlex_get_cases.handler(eurlex_get_cases.input.parse(input), ctx);
      return { sparql: mockQuery.mock.calls[0]?.[0] as string, result };
    }

    it('reaches the judgment, AG opinion, and every order filed under C-97/23', async () => {
      const { sparql, result } = await queryFor({ case_number: 'C-97/23' });

      for (const celex of C_97_23_PRIMARY) expect(admits(sparql, celex), celex).toBe(true);
      // The derivative exclusion stays on by default; notice letters are not even
      // admitted by the CELEX match unless include_derivative opens that path.
      expect(admits(sparql, '62023CA0097')).toBe(false);
      expect(admits(sparql, '62023CN0097')).toBe(false);
      expect(sparql).toContain('FILTER NOT EXISTS');
      for (const celex of T_97_23_RECORDS) expect(admits(sparql, celex), celex).toBe(false);
      expect(result.query_echo.celex_fragment).toBe('2023C*0097');
    });

    it('adds the notices and abstracts under include_derivative', async () => {
      const { sparql } = await queryFor({ case_number: 'C-97/23', include_derivative: true });

      for (const celex of [...C_97_23_PRIMARY, ...C_97_23_DERIVATIVE]) {
        expect(admits(sparql, celex), celex).toBe(true);
      }
      expect(sparql).not.toContain('FILTER NOT EXISTS');
      for (const celex of T_97_23_RECORDS) expect(admits(sparql, celex), celex).toBe(false);
    });

    it.each([
      ['order', 'ORDER'],
      ['ag_opinion', 'OPIN_AG'],
      ['judgment', 'JUDG'],
    ])(
      'keeps case_type %s narrowing by resource type alongside the widened match',
      async (caseType, typeCode) => {
        const { sparql } = await queryFor({ case_number: 'C-97/23', case_type: caseType });

        // The CELEX match no longer pins the judgment letters, so case_type can reach
        // the orders and opinions; the resource-type triple does the narrowing.
        for (const celex of C_97_23_PRIMARY) expect(admits(sparql, celex), celex).toBe(true);
        expect(sparql).toContain(
          `?work cdm:work_has_resource-type <http://publications.europa.eu/resource/authority/resource-type/${typeCode}> .`,
        );
      },
    );

    it.each([
      ['General Court', 'T-97/23', '2023T*0097', ['62023TJ0097', '62023TJ0097_INF']],
      ['Civil Service Tribunal', 'F-12/05', '2005F*0012', ['62005FJ0012', '62005FO0012']],
    ])('reaches %s records for %s', async (_label, caseNumber, fragment, reached) => {
      const { sparql, result } = await queryFor({ case_number: caseNumber });

      for (const celex of reached) expect(admits(sparql, celex), celex).toBe(true);
      expect(result.query_echo.celex_fragment).toBe(fragment);
    });

    it('keeps the General Court letter set to the types that court files', async () => {
      const { sparql } = await queryFor({ case_number: 'T-643/24' });

      expect(admits(sparql, '62024TC0643')).toBe(true);
      expect(admits(sparql, '62024TT0643')).toBe(true);
      // CP/CS/CD are Court of Justice letters; the General Court files none of them.
      expect(admits(sparql, '62024TP0643')).toBe(false);
      expect(admits(sparql, '62024CJ0643')).toBe(false);
    });

    it('does not reach numbered Opinions or Rulings whose CELEX collides with a case number', async () => {
      const { sparql } = await queryFor({ case_number: 'C-2/13' });

      expect(admits(sparql, '62013CJ0002')).toBe(true);
      // Opinion 2/13 is 62013CV0002 — a different proceeding, numbered "Opinion 2/13".
      for (const letter of ['V', 'U', 'G', 'X']) {
        expect(admits(sparql, `62013C${letter}0002`), letter).toBe(false);
      }
    });

    it.each([
      ['a trailing appeal suffix', 'C-97/23 P'],
      ['the full case_reference form', 'Case C-97/23 P.'],
      ['a lowercase prefix', 'c-97/23'],
      ['a four-digit year', 'C-97/2023'],
      ['a suffix with no space', 'C-97/23P'],
      ['a non-breaking hyphen (U+2011)', 'Case C‑97/23 P.'],
      ['a hyphen (U+2010)', 'C‐97/23'],
      ['a figure dash (U+2012)', 'C‒97/23'],
      ['an en dash (U+2013)', 'C–97/23'],
      ['an em dash (U+2014)', 'C—97/23'],
      ['a horizontal bar (U+2015)', 'C―97/23'],
      ['a minus sign (U+2212)', 'C−97/23'],
    ])('parses %s', async (_label, caseNumber) => {
      const { sparql, result } = await queryFor({ case_number: caseNumber });

      expect(result.query_echo.celex_fragment).toBe('2023C*0097');
      expect(result.query_echo.case_number).toBe(caseNumber);
      expect(admits(sparql, '62023CO0097(02)')).toBe(true);
    });

    it.each([
      'P',
      'R',
      'R II',
      'PPU',
      'RENV',
      'DEP',
      'P-DEP',
      'REC',
      'P-R',
      'AJ',
      'REV',
      'SA',
      'RX',
      'OP',
      'INT',
      'INTP',
      'TO',
    ])('accepts and ignores the procedural suffix %s', async (suffix) => {
      const { result } = await queryFor({ case_number: `T-125/03 ${suffix}` });
      expect(result.query_echo.celex_fragment).toBe('2003T*0125');
    });

    it.each(['P', 'R II', 'P-DEP', 'P-R', 'INTP'])(
      'accepts the procedural suffix %s followed by a trailing "."',
      async (suffix) => {
        const { result } = await queryFor({ case_number: `Case T-125/03 ${suffix}.` });
        expect(result.query_echo.celex_fragment).toBe('2003T*0125');
      },
    );

    it.each([
      ['Case 26/62.', '1962C*0026', '61962CJ0026'],
      ['Case 133-73.', '1973C*0133', '61973CJ0133'],
      ['26/1962', '1962C*0026', '61962CJ0026'],
      ['53/53', '1953C*0053', '61953CJ0053'],
      ['1/88', '1988C*0001', '61988CO0001'],
    ])(
      'reads the prefix-less %s as a Court of Justice case',
      async (caseNumber, fragment, celex) => {
        const { sparql, result } = await queryFor({ case_number: caseNumber });

        expect(result.query_echo.celex_fragment).toBe(fragment);
        expect(admits(sparql, celex)).toBe(true);
      },
    );

    it.each([
      ['a prefix-less number with a post-1988 year', '97/23'],
      ['a prefix-less number dated 1989', '1/89'],
      ['a prefix-less number dated 1952', '1/52'],
      ['a prefix-less four-digit year outside the range', 'Case 26/1989.'],
      ['a space in place of the prefix hyphen', 'C 97-23 x/y'],
      ['a plural joined-case reference', 'Cases T-683/22 to T-688/22'],
      ['two joined cases', 'C-131/12 and C-132/12'],
      ['a comma-separated pair', 'C-131/12, C-132/12'],
      ['a range under one prefix', 'T-683/22 to T-688/22'],
      ['a second number without its prefix', 'C-131/12 and 132/12'],
      ['two joined appeals', 'C-97/23 P and C-98/23 P'],
      ['a joined pre-1989 pair', 'Case 26/62 and 27/62.'],
      ['a joined pre-1989 pair written with hyphens', 'Case 133-73 and 134-73.'],
      ['a trailing backslash', 'ZZ\\'],
      ['a hyphenated non-case string', 'ZZ-1'],
      ['whitespace inside a CELEX-like string', '2023 CJ 0097'],
    ])(
      'rejects %s with invalid_case_number before any CELLAR request',
      async (_label, caseNumber) => {
        const ctx = createMockContext({ errors: eurlex_get_cases.errors });

        const input = eurlex_get_cases.input.parse({ case_number: caseNumber });
        const err = await Promise.resolve(eurlex_get_cases.handler(input, ctx)).catch(
          (e: unknown) => e,
        );

        expect(err).toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          data: { reason: 'invalid_case_number' },
        });
        expect((err as { message: string }).message).toContain(caseNumber);
        expect(mockQuery).not.toHaveBeenCalled();
      },
    );

    it('asks for the court prefix when an unprefixed year is outside 1953–1988', async () => {
      const ctx = createMockContext({ errors: eurlex_get_cases.errors });

      const input = eurlex_get_cases.input.parse({ case_number: '97/23' });
      const err = await Promise.resolve(eurlex_get_cases.handler(input, ctx)).catch(
        (e: unknown) => e,
      );

      expect((err as { message: string }).message).toMatch(/C-, T-, or F- prefix/);
    });

    it('says a joined-case value names more than one case, and to pass one per call', async () => {
      const result = await runToolContract(eurlex_get_cases, {
        case_number: 'C-131/12 and C-132/12',
      });

      expect(result.isError).toBe(true);
      const structured = result.structuredContent as {
        error?: { message?: string; data?: { reason?: string; recovery?: { hint?: string } } };
      };
      expect(structured.error?.data?.reason).toBe('invalid_case_number');
      expect(structured.error?.message).toMatch(/more than one case/);
      expect(structured.error?.data?.recovery?.hint).toMatch(/one case number per call/);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('carries the accepted format to content[] and structuredContent.error', async () => {
      const result = await runToolContract(eurlex_get_cases, { case_number: '97/23' });

      expect(result.isError).toBe(true);
      const structured = result.structuredContent as {
        error?: { code?: number; data?: { reason?: string; recovery?: { hint?: string } } };
      };
      expect(structured.error?.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(structured.error?.data?.reason).toBe('invalid_case_number');
      const hint = structured.error?.data?.recovery?.hint ?? '';
      expect(hint).toContain('C-{number}/{year}');
      const text = result.content
        .map((block) => (block as { text?: string }).text ?? '')
        .join('\n');
      expect(text).toContain('97/23');
      expect(text).toContain(hint);
    });

    /**
     * Characterization: a value made only of CELEX characters whose opening could sit
     * anywhere in a sector-6 CELEX keeps the escaped, case-insensitive substring scan
     * of every CELEX literal (#134). The FILTER line is asserted whole so any drift in
     * the scan is caught; `C0097` is also the tail of `62023CC0097`, so a prefix term
     * `'C0097*'` would lose that record.
     */
    it.each([
      '12CJ0131',
      '013CJ0131',
      '0131',
      '2013C',
      'J0131',
      'C0097',
      'RES',
      'cj',
      '32016R0679',
      '(01)',
      '_RES',
    ])(
      'keeps the CELEX substring scan byte-identical for %s, whose opening could sit anywhere in a CELEX',
      async (caseNumber) => {
        const { sparql, result } = await queryFor({ case_number: caseNumber });

        expect(sparql).toContain(
          `FILTER(CONTAINS(LCASE(STR(?celexNumber)), LCASE("${escapeSparqlLiteral(caseNumber)}")))`,
        );
        expect(sparql).not.toContain('?celexNumber bif:contains');
        expect(result.query_echo.celex_fragment).toBeUndefined();
        expect(result.query_echo.case_number).toBe(caseNumber);
      },
    );

    it('keeps HEAD-parseable three-digit years reaching what they reached before', async () => {
      // "C-131/012" parsed before #81 and matched the CELEX substring "12CJ0131".
      const { sparql } = await queryFor({ case_number: 'C-131/012' });
      expect(admits(sparql, '62012CJ0131')).toBe(true);
    });

    /**
     * The parser runs over caller-sized text, so its cost must stay linear. Each
     * adversarial shape is timed at 80k characters (best of five) against an
     * absolute ceiling a linear parse clears by orders of magnitude and a
     * quadratic one (billions of steps at this size) cannot. No small-input ratio:
     * its sub-millisecond denominator turns one scheduler stall into a failure.
     */
    describe('parser cost on adversarial input', () => {
      async function bestOfFive(caseNumber: string): Promise<number> {
        let best = Number.POSITIVE_INFINITY;
        for (let i = 0; i < 5; i++) {
          mockQuery.mockResolvedValue([makeCaseBinding('62023CJ0097')]);
          const ctx = createMockContext({ errors: eurlex_get_cases.errors });
          const input = eurlex_get_cases.input.parse({ case_number: caseNumber });
          const start = performance.now();
          await Promise.resolve(eurlex_get_cases.handler(input, ctx)).catch(() => undefined);
          best = Math.min(best, performance.now() - start);
        }
        return best;
      }

      it.each([
        ['a repeated prefix', (n: number) => 'Case C-'.repeat(Math.ceil(n / 7)).slice(0, n)],
        ['digits with no year', (n: number) => `C-${'1'.repeat(n)}`],
        ['a prefix-less number with no year', (n: number) => '1'.repeat(n)],
        ['a long suffix', (n: number) => `C-97/23 ${'P'.repeat(n)}`],
        ['repeated hyphen-number pairs', (n: number) => '1-'.repeat(Math.ceil(n / 2)).slice(0, n)],
        ['a "Case" lead-in with a long run of spaces', (n: number) => `Case${' '.repeat(n)}x`],
        ['a digit run before a one-digit year', (n: number) => `${'1'.repeat(n)}/1`],
        ['a digit run after the year', (n: number) => `C-97/23 ${'1'.repeat(n)}`],
        [
          'alternating digits and spaces after the year',
          (n: number) => `C-97/23 ${'1 '.repeat(Math.ceil(n / 2))}`,
        ],
      ])('stays linear for %s', async (_label, build) => {
        expect(await bestOfFive(build(80_000))).toBeLessThan(250);
      });
    });
  });

  // --- #91: the court filter keys on the CELEX court letter ---

  describe('court filter (#91)', () => {
    async function courtQuery(input: Record<string, unknown>): Promise<string> {
      const ctx = createMockContext({ errors: eurlex_get_cases.errors });
      mockQuery.mockResolvedValue([makeCaseBinding('62024TC0643')]);
      await eurlex_get_cases.handler(eurlex_get_cases.input.parse(input), ctx);
      // The grouped search, past a CELEX keyword's exact-match lookup (#105).
      return mockQuery.mock.calls
        .map((c) => c[0] as string)
        .find((q) => q.includes('GROUP BY ?celexNumber')) as string;
    }

    const COURT_OF_JUSTICE = [
      '62013CV0002',
      '62023CC0097',
      '62019CP0001',
      '62020CS0003',
      '62015CX0001',
      '62023CN0097',
    ];
    const GENERAL_COURT = [
      '62024TC0643',
      '62024TC0589',
      '62021TT0001',
      '62023TJ0097',
      '62023TA0097',
    ];
    const CIVIL_SERVICE_TRIBUNAL = ['62005FJ0012', '62010FO0001'];

    it('CJEU reaches every Court of Justice record and no General Court or Tribunal record', async () => {
      const sparql = await courtQuery({ court: 'CJEU' });

      for (const celex of COURT_OF_JUSTICE) expect(admits(sparql, celex), celex).toBe(true);
      for (const celex of [...GENERAL_COURT, ...CIVIL_SERVICE_TRIBUNAL]) {
        expect(admits(sparql, celex), celex).toBe(false);
      }
    });

    it('GC reaches every General Court record and no Court of Justice or Tribunal record', async () => {
      const sparql = await courtQuery({ court: 'GC' });

      for (const celex of GENERAL_COURT) expect(admits(sparql, celex), celex).toBe(true);
      for (const celex of [...COURT_OF_JUSTICE, ...CIVIL_SERVICE_TRIBUNAL]) {
        expect(admits(sparql, celex), celex).toBe(false);
      }
    });

    it('GC with case_type ag_opinion reaches the General Court AG opinions', async () => {
      const sparql = await courtQuery({ court: 'GC', case_type: 'ag_opinion' });

      expect(admits(sparql, '62024TC0643')).toBe(true);
      expect(sparql).toContain(
        '?work cdm:work_has_resource-type <http://publications.europa.eu/resource/authority/resource-type/OPIN_AG> .',
      );
    });

    it('CJEU with a CELEX keyword reaches Opinion 2/13', async () => {
      const sparql = await courtQuery({ court: 'CJEU', keyword: '62013CV0002' });
      expect(admits(sparql, '62013CV0002')).toBe(true);
    });

    it('a case number and a court compose: C-97/23 under GC reaches nothing', async () => {
      const sparql = await courtQuery({ court: 'GC', case_number: 'C-97/23' });
      for (const celex of [...C_97_23_PRIMARY, ...T_97_23_RECORDS]) {
        expect(admits(sparql, celex), celex).toBe(false);
      }
    });

    it('states the court letter each value selects', () => {
      const description = eurlex_get_cases.input.shape.court.description ?? '';
      expect(description).toContain('CJEU (C)');
      expect(description).toContain('GC (T)');
    });
  });

  // --- #84: each row carries its ECLI ---

  describe('ECLI per row (#84)', () => {
    it('binds the ECLI inside the grouped query, with no extra round trip', async () => {
      const ctx = createMockContext({ errors: eurlex_get_cases.errors });
      mockQuery.mockResolvedValue([makeCaseBinding('62023CJ0097', { ecli: 'ECLI:EU:C:2026:81' })]);

      await eurlex_get_cases.handler(eurlex_get_cases.input.parse({ case_number: 'C-97/23' }), ctx);

      // The search, then the page's work resolution (#97) — nothing for the ECLI.
      expect(mockQuery).toHaveBeenCalledTimes(2);
      expect(mockQuery.mock.calls[1]?.[0] as string).not.toContain('case-law_ecli');
      const sparql = mockQuery.mock.calls[0]?.[0] as string;
      expect(sparql).toMatch(
        /OPTIONAL \{ \?work cdm:case-law_ecli \?caseEcli \. \}[\s\S]*\} GROUP BY \?celexNumber /,
      );
      expect(sparql).toContain('(MAX(?caseEcli) AS ?ecli)');
    });

    it('returns each primary record’s ECLI and omits it on a notice row, on both surfaces', async () => {
      mockQuery.mockResolvedValue([
        makeCaseBinding('62023CJ0097', {
          ecli: 'ECLI:EU:C:2026:81',
          types: 'http://publications.europa.eu/resource/authority/resource-type/JUDG',
        }),
        makeCaseBinding('62023CO0097(01)', {
          ecli: 'ECLI:EU:C:2023:609',
          types: 'http://publications.europa.eu/resource/authority/resource-type/ORDER',
        }),
        makeCaseBinding('62023CN0097', {
          types: 'http://publications.europa.eu/resource/authority/resource-type/INFO_JUDICIAL',
        }),
      ]);

      const result = await runToolContract(eurlex_get_cases, {
        case_number: 'C-97/23',
        include_derivative: true,
      });

      expect(result.isError).toBeFalsy();
      const structured = eurlex_get_cases.output.parse(result.structuredContent);
      expect(structured.cases.map((c) => [c.celex_number, c.ecli])).toEqual([
        ['62023CJ0097', 'ECLI:EU:C:2026:81'],
        ['62023CO0097(01)', 'ECLI:EU:C:2023:609'],
        ['62023CN0097', undefined],
      ]);
      expect('ecli' in (structured.cases[2] ?? {})).toBe(false);

      const text = result.content
        .map((block) => (block as { text?: string }).text ?? '')
        .join('\n');
      expect(text).toContain('**ECLI:** ECLI:EU:C:2026:81');
      expect(text).toContain('**ECLI:** ECLI:EU:C:2023:609');
      const noticeSection = text.slice(text.indexOf('### 62023CN0097'));
      expect(noticeSection).not.toContain('**ECLI:**');
    });
  });

  // --- #97: a row's work_uri is its CELEX's canonical work ---

  describe('row work_uri for a CELEX held by several works (#97)', () => {
    const T181_COPY = fixtureWork('62022TJ0181', 0);
    const T181_ALIAS = fixtureWork('62022TJ0181', 2);
    const C131_COPY = fixtureWork('62012CJ0131', 0);

    /** The grouped page as CELLAR returns it, then the fixture works on resolution. */
    const fakeCellar = (page: Record<string, { type: string; value: string }>[]) =>
      mockQuery.mockImplementation(async (q: string) =>
        q.includes('GROUP BY ?celexNumber') ? page : celexWorkRows(q),
      );

    it('resolves the T-181/22 row to the canonical work, not the _EXT alias MAX(?titledWork) picks', async () => {
      fakeCellar([
        makeCaseBinding('62022TJ0181', {
          workUri: T181_COPY,
          titledWork: T181_ALIAS,
          title: 'Judgment#Parties#Case T-181/22.',
        }),
      ]);

      const result = await runToolContract(eurlex_get_cases, { case_number: 'T-181/22' });

      const structured = eurlex_get_cases.output.parse(result.structuredContent);
      expect(structured.cases[0]?.work_uri).toBe(canonicalWork('62022TJ0181'));
      const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
      expect(text).toContain(`**Work URI:** ${canonicalWork('62022TJ0181')}`);
      expect(text).not.toContain(T181_ALIAS);
    });

    it('resolves a whole page through one follow-up VALUES query', async () => {
      fakeCellar([
        makeCaseBinding('62022TJ0181', { workUri: T181_COPY, titledWork: T181_ALIAS }),
        makeCaseBinding('62012CJ0131', { workUri: C131_COPY }),
      ]);

      const input = eurlex_get_cases.input.parse({ keyword: 'test', limit: 2 });
      const result = await eurlex_get_cases.handler(
        input,
        createMockContext({ errors: eurlex_get_cases.errors }),
      );

      expect(result.cases.map((c) => c.work_uri)).toEqual([
        canonicalWork('62022TJ0181'),
        canonicalWork('62012CJ0131'),
      ]);
      const resolution = mockQuery.mock.calls
        .map((c) => c[0] as string)
        .filter((q) => q.includes('owl#sameAs'));
      expect(resolution).toHaveLength(1);
      expect(resolution[0]).toContain(
        'VALUES ?celexNumber { "62022TJ0181"^^xsd:string "62012CJ0131"^^xsd:string }',
      );
    });

    it('sends no resolution query for an empty page past the end', async () => {
      fakeCellar([]);

      const input = eurlex_get_cases.input.parse({ keyword: 'test', offset: 500 });
      const result = await eurlex_get_cases.handler(
        input,
        createMockContext({ errors: eurlex_get_cases.errors }),
      );

      expect(result.cases).toEqual([]);
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });
  });

  // --- #98: a date-bounded search pages its CELEX keys before aggregating ---

  describe('page-first date-bounded search (#98)', () => {
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
      mockQuery.mockResolvedValue([makeCaseBinding('62023TJ0097', { date: '2024-03-15' })]);
      await eurlex_get_cases.handler(
        eurlex_get_cases.input.parse(input),
        createMockContext({ errors: eurlex_get_cases.errors }),
      );
      return mockQuery.mock.calls[0]?.[0] as string;
    }

    it.each([
      ['both bounds', { date_from: '2024-03-01', date_to: '2024-03-31' }],
      ['date_from alone', { date_from: '2024-03-01' }],
      ['date_to alone', { date_to: '2019-06-30' }],
    ])('pages in a subquery and aggregates the page alone, with %s', async (_label, dates) => {
      const sparql = await searchQuery({ ...dates, offset: 20 });
      const { inner, outer } = splitPageFirst(sparql);

      // The page keys take the same total order the rows do, and carry the LIMIT.
      expect(inner).toMatch(
        /\} GROUP BY \?celexNumber ORDER BY DESC\(\?pageDate\) \?celexNumber LIMIT 21 OFFSET 20\n {2}\}$/,
      );
      expect(outer).toMatch(/\} GROUP BY \?celexNumber ORDER BY DESC\(\?docDate\) \?celexNumber$/);
      expect(outer).not.toMatch(/\bLIMIT\b|\bOFFSET\b/);
      // The row date is the date the case was paged on; neither level takes a MAX
      // over the ordered date (the Virtuoso TOP-k plan that drops the upper bound).
      expect(outer).toContain('(SAMPLE(?pageDate) AS ?docDate)');
      expect(sparql).not.toMatch(/MAX\(\?(?:date|pageDate)\)/);
    });

    it('keeps the flat form, paged at the outer level, for a search with no date bound', async () => {
      const sparql = await searchQuery({ court: 'GC', offset: 20 });

      expect(sparql).not.toContain('?pageDate');
      expect(sparql).toContain('(SAMPLE(?date) AS ?docDate)');
      expect(sparql).toMatch(/ORDER BY DESC\(\?docDate\) \?celexNumber LIMIT 21 OFFSET 20$/);
    });

    it('gathers types, ECLI, and titles in the outer query only', async () => {
      const { inner, outer } = splitPageFirst(
        await searchQuery({ date_from: '2024-03-01', date_to: '2024-03-31' }),
      );

      for (const optional of [
        'OPTIONAL { ?work cdm:work_has_resource-type ?type . }',
        'OPTIONAL { ?work cdm:case-law_ecli ?caseEcli . }',
        '?expr cdm:expression_title ?title .',
      ]) {
        expect(inner).not.toContain(optional);
        expect(outer).toContain(optional);
      }
      for (const aggregate of [
        '(MAX(?titledWork) AS ?titledWork)',
        '(SAMPLE(?work) AS ?work)',
        '(MAX(?caseEcli) AS ?ecli)',
        '(MAX(?title) AS ?docTitle)',
      ]) {
        expect(outer).toContain(aggregate);
      }
    });

    it('matches every filter at both levels, so each CELEX groups the works it did before', async () => {
      const { inner, outer } = splitPageFirst(
        await searchQuery({
          case_number: 'T-97/23',
          court: 'GC',
          case_type: 'judgment',
          keyword: 'Bayer',
          date_from: '2024-01-01',
          date_to: '2024-12-31',
        }),
      );

      for (const part of [inner, outer]) {
        expect(part).toContain(
          '?work cdm:work_has_resource-type <http://publications.europa.eu/resource/authority/resource-type/JUDG> .',
        );
        expect(part).toContain('FILTER(?date >= "2024-01-01"^^xsd:date)');
        expect(part).toContain('FILTER(?date <= "2024-12-31"^^xsd:date)');
        expect(part).toContain(`?kwTitle bif:contains "'Bayer'"`);
        expect(admits(part, '62023TJ0097')).toBe(true);
        expect(admits(part, '62023CJ0097')).toBe(false);
      }
      // The inner query joins the keyword to find the page; the outer one only tests
      // it on the page's works.
      expect(inner).not.toContain('FILTER EXISTS');
      expect(outer).toMatch(/FILTER EXISTS \{\s*\{\s*\?kwExpr cdm:expression_title \?kwTitle/);
      // Outside that test the outer query never joins the keyword again.
      const outerJoins = withoutFilterExists(outer);
      expect(outerJoins).not.toContain('?kwTitle bif:contains');
      expect(outerJoins).not.toContain('?kwExpr');
    });

    it('keeps the derivative exclusion at both levels, and drops it at both under include_derivative', async () => {
      const excluded = splitPageFirst(await searchQuery({ date_from: '2026-09-01' }));
      expect(excluded.inner).toContain('FILTER NOT EXISTS');
      expect(excluded.outer).toContain('FILTER NOT EXISTS');

      mockQuery.mockReset();
      const included = splitPageFirst(
        await searchQuery({ date_from: '2026-09-01', include_derivative: true }),
      );
      expect(included.inner).not.toContain('FILTER NOT EXISTS');
      expect(included.outer).not.toContain('FILTER NOT EXISTS');
    });

    it('proves continuation from the page subquery’s extra row, on both surfaces', async () => {
      mockQuery.mockResolvedValue([
        makeCaseBinding('62024CJ0200', { date: '2024-03-20' }),
        makeCaseBinding('62024CJ0100', { date: '2024-03-10' }),
        makeCaseBinding('62024CJ0050', { date: '2024-03-05' }),
      ]);

      const result = await runToolContract(eurlex_get_cases, {
        date_from: '2024-03-01',
        date_to: '2024-03-31',
        limit: 2,
        offset: 4,
      });

      expect(splitPageFirst(mockQuery.mock.calls[0]?.[0] as string).inner).toContain(
        'LIMIT 3 OFFSET 4',
      );
      const structured = eurlex_get_cases.output.parse(result.structuredContent);
      expect(structured.cases.map((c) => [c.celex_number, c.date])).toEqual([
        ['62024CJ0200', '2024-03-20'],
        ['62024CJ0100', '2024-03-10'],
      ]);
      expect(structured).toMatchObject({ total: 2, offset: 4, has_more: true, next_offset: 6 });
      const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
      expect(text).toContain('**Has more:** true');
      expect(text).toContain('**Next offset:** 6');
      expect(text).not.toContain('62024CJ0050');
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

      const firstCtx = createMockContext({ errors: eurlex_get_cases.errors });
      const first = await eurlex_get_cases.handler(eurlex_get_cases.input.parse(dates), firstCtx);
      expect(first).toMatchObject({ cases: [], total: 0, offset: 0, has_more: false });
      expect(first.next_offset).toBeUndefined();
      expect(getEnrichment(firstCtx).notice).toContain('date_from=2024-03-01');

      const past = await eurlex_get_cases.handler(
        eurlex_get_cases.input.parse({ ...dates, offset: 400 }),
        createMockContext({ errors: eurlex_get_cases.errors }),
      );
      expect(past).toMatchObject({ cases: [], total: 0, has_more: false });
      expect(past.next_offset).toBeUndefined();
    });
  });

  // --- #112: an empty first page is an empty page, not an error ---

  describe('empty first page (#112)', () => {
    it('returns an empty page with a notice on both surfaces', async () => {
      mockQuery.mockResolvedValue([]);

      const result = await runToolContract(eurlex_get_cases, { keyword: 'zzqxunmatchablephrase' });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured).toMatchObject({
        cases: [],
        total: 0,
        offset: 0,
        has_more: false,
        query_echo: { keyword: 'zzqxunmatchablephrase', include_derivative: false },
      });
      expect(structured).not.toHaveProperty('next_offset');
      expect(structured).not.toHaveProperty('truncated');
      const notice = structured.notice as string;
      expect(notice).toContain('keyword=zzqxunmatchablephrase');
      expect(notice).toContain(
        'Try a different keyword, broader date range, or remove the court/case_type filter.',
      );

      const text = contentText(result);
      expect(text).toContain(`> ${notice}`);
      expect(text).toContain('**Has more:** false');
      expect(text).not.toContain('**Next offset:**');
    });

    it('returns an empty page from the page-first date-bounded form', async () => {
      mockQuery.mockResolvedValue([]);

      const result = await runToolContract(eurlex_get_cases, {
        case_number: 'C-9999/24',
        date_from: '2024-03-01',
      });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured).toMatchObject({
        cases: [],
        total: 0,
        has_more: false,
        query_echo: { case_number: 'C-9999/24', celex_fragment: '2024C*9999' },
      });
      expect(structured.notice).toContain('celex_fragment=2024C*9999');
      expect(contentText(result)).toContain(`> ${structured.notice as string}`);
      // The date bound selects the page-first subquery form (#98).
      expect(mockQuery.mock.calls[0]?.[0]).toContain('?pageDate');
    });

    it('names the next offset in the notice of a page with more rows', async () => {
      mockQuery.mockResolvedValue([
        makeCaseBinding('62024CJ0001'),
        makeCaseBinding('62024CJ0002'),
        makeCaseBinding('62024CJ0003'),
      ]);

      const result = await runToolContract(eurlex_get_cases, { keyword: 'data', limit: 2 });

      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured).toMatchObject({ has_more: true, next_offset: 2, truncated: true });
      expect(structured.notice).toContain('offset=2');
      expect(contentText(result)).toContain(`> ${structured.notice as string}`);
    });

    it('bounds the keyword and case number echoed in the notice of an empty first page', async () => {
      mockQuery.mockResolvedValue([]);
      const keyword = `zz${'q'.repeat(4998)}`;
      const caseNumber = `ZZ${'Q'.repeat(4998)}`;

      const result = await runToolContract(eurlex_get_cases, {
        keyword,
        case_number: caseNumber,
      });

      const notice = (result.structuredContent as { notice?: string }).notice ?? '';
      expect(notice).toContain(`keyword=${keyword.slice(0, 100)}…`);
      expect(notice).toContain(`case_number=${caseNumber.slice(0, 100)}…`);
      expect(notice).not.toContain(keyword.slice(0, 101));
      expect(notice.length).toBeLessThan(600);
      expect(contentText(result)).toContain(`> ${notice}`);
      expect(result.structuredContent).toMatchObject({
        query_echo: { keyword, case_number: caseNumber },
      });
    });

    it('bounds the case number quoted in the invalid_case_number message', async () => {
      const result = await runToolContract(eurlex_get_cases, { case_number: '?'.repeat(5000) });

      expect(result.isError).toBe(true);
      const text = contentText(result);
      expect(text).toContain(`${'?'.repeat(100)}…`);
      expect(text).not.toContain('?'.repeat(101));
    });
  });

  // --- A keyword no title or CELEX can hold is an input error, not an empty page ---

  describe('invalid keyword', () => {
    it.each(['-', '()', '!!!', '/_-'])(
      'rejects the keyword %j, which holds no letters or digits, as invalid_keyword on both surfaces',
      async (keyword) => {
        const result = await runToolContract(eurlex_get_cases, { keyword, court: 'CJEU' });

        // The court filter is not silently answered with an empty page.
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

    it('bounds the keyword quoted in the invalid_keyword message', async () => {
      const result = await runToolContract(eurlex_get_cases, { keyword: '-'.repeat(5000) });

      expect(result.isError).toBe(true);
      const text = contentText(result);
      expect(text).toContain(`${'-'.repeat(100)}…`);
      expect(text).not.toContain('-'.repeat(101));
    });

    it('checks the keyword after the dates, so a bad date is named first', async () => {
      await expect(
        eurlex_get_cases.handler(
          eurlex_get_cases.input.parse({ keyword: '-', date_from: '2026-02-30' }),
          createMockContext({ errors: eurlex_get_cases.errors }),
        ),
      ).rejects.toMatchObject({ data: { reason: 'invalid_date_range' } });
    });
  });

  // --- #105: the CELEX arm of the keyword follows the keyword's shape ---

  describe('keyword CELEX arm by keyword shape (#105)', () => {
    /** The grouped search queries sent, without the lookup or work resolution. */
    function searchQueries(): string[] {
      return mockQuery.mock.calls
        .map((c) => c[0] as string)
        .filter((q) => q.includes('GROUP BY ?celexNumber'));
    }

    function lookupQueries(): string[] {
      return mockQuery.mock.calls
        .map((c) => c[0] as string)
        .filter((q) => !q.includes('GROUP BY ?celexNumber') && !q.includes('owl#sameAs'));
    }

    /** Answer the family lookup with each CELEX in `carried` it asks about, the search with `rows`. */
    function answer(carried: string[], rows = [makeCaseBinding('62013CJ0131')]): void {
      mockQuery.mockImplementation(async (q: string) => {
        if (q.includes('GROUP BY ?celexNumber')) return rows;
        if (q.includes('owl#sameAs')) return [];
        return carried
          .filter((c) => q.includes(`"${c}"^^xsd:string`))
          .map((c) => ({ kwCelex: { type: 'literal', value: c } }));
      });
    }

    async function run(input: Record<string, unknown>): Promise<string> {
      await eurlex_get_cases.handler(
        eurlex_get_cases.input.parse(input),
        createMockContext({ errors: eurlex_get_cases.errors }),
      );
      const [sparql] = searchQueries();
      if (!sparql) throw new Error('No search query was sent');
      return sparql;
    }

    it('drops the CELEX arm for a digit-free keyword and sends no lookup', async () => {
      answer([]);
      const sparql = await run({ keyword: 'google spain' });

      expect(sparql).toContain(`?kwTitle bif:contains "'google spain'"`);
      expect(sparql).not.toContain('?kwCelex');
      expect(sparql).not.toContain('UNION');
      expect(lookupQueries()).toEqual([]);
    });

    it('matches a whole CELEX as the exact typed literal plus the works correcting it', async () => {
      answer(['62013CV0002']);
      const sparql = await run({ keyword: '62013CV0002', court: 'CJEU' });

      expect(lookupQueries()).toHaveLength(1);
      expect(sparql).toContain('VALUES ?kwCelex { "62013CV0002"^^xsd:string }');
      expect(sparql).toContain('?work cdm:resource_legal_id_celex ?kwCelex . }');
      expect(sparql).toContain('?work cdm:resource_legal_corrects_resource_legal ?kwBase .');
      expect(sparql).not.toContain('CONTAINS(LCASE(STR(?kwCelex))');
      expect(admits(sparql, '62013CV0002')).toBe(true);
    });

    it('reaches the numbered orders filed under a whole-CELEX order, on both surfaces', async () => {
      // Live CELLAR (2026-09-25): 62023CO0097 and its (01)/(02) siblings, all ORDER.
      answer(
        ['62023CO0097', '62023CO0097(01)', '62023CO0097(02)'],
        [
          makeCaseBinding('62023CO0097(02)', { date: '2024-03-12' }),
          makeCaseBinding('62023CO0097(01)', { date: '2023-11-07' }),
          makeCaseBinding('62023CO0097', { date: '2023-06-28' }),
        ],
      );

      const result = await runToolContract(eurlex_get_cases, { keyword: '62023CO0097' });

      const [lookup] = lookupQueries();
      for (const member of ['62023CO0097(01)', '62023CO0097(20)', '62023CO0097_RES']) {
        expect(lookup).toContain(`"${member}"^^xsd:string`);
      }
      const [sparql] = searchQueries();
      expect(sparql).toContain(
        'VALUES ?kwCelex { "62023CO0097"^^xsd:string "62023CO0097(01)"^^xsd:string "62023CO0097(02)"^^xsd:string }',
      );
      expect(sparql).not.toContain('CONTAINS(LCASE(STR(?kwCelex))');
      const structured = eurlex_get_cases.output.parse(result.structuredContent);
      expect(structured.cases.map((c) => c.celex_number)).toEqual([
        '62023CO0097(02)',
        '62023CO0097(01)',
        '62023CO0097',
      ]);
      expect(contentText(result)).toContain('### 62023CO0097(01)');
    });

    it('keeps derivative siblings out by default and admits them under include_derivative', async () => {
      const family = ['62023CJ0097', '62023CJ0097_RES', '62023CJ0097_SUM', '62023CJ0097_INF'];
      answer(family);
      const excluded = await run({ keyword: '62023CJ0097' });

      // The derivative record's CELEX reaches the search, and the derivative-type
      // exclusion that applies to every row drops it there.
      expect(excluded).toContain('"62023CJ0097_RES"^^xsd:string');
      expect(excluded).toMatch(
        /FILTER NOT EXISTS \{ \?work cdm:work_has_resource-type \?derivativeType \. VALUES \?derivativeType \{[^}]*ABSTRACT_JUR[^}]*SUM_JUR[^}]*\}/,
      );
      expect(excluded).toContain('resource-type/INFO_JUR>');

      mockQuery.mockReset();
      answer(family);
      const included = await run({ keyword: '62023CJ0097', include_derivative: true });
      expect(included).toContain('"62023CJ0097_RES"^^xsd:string');
      expect(included).not.toContain('FILTER NOT EXISTS');
    });

    it('takes the partial arm on the CELEX full-text index for a fragment no work carries whole (#123)', async () => {
      answer([]);
      const sparql = await run({ keyword: '2014CJ0362' });

      expect(lookupQueries()).toHaveLength(1);
      expect(sparql).toContain(
        `?kwCelex bif:contains "${['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', 'E'].map((s) => `'${s}2014CJ0362*'`).join(' OR ')}" .`,
      );
      expect(sparql).toContain('FILTER(CONTAINS(STR(?kwCelex), "2014CJ0362"))');
      expect(sparql).not.toContain('CONTAINS(LCASE(STR(?kwCelex))');
    });

    it('completes a court-letter fragment with every sector, year, and type code (#123)', async () => {
      answer([]);
      const sparql = await run({ keyword: 'CJ0362' });

      // CELEX-shaped, so CELLAR is asked first whether a work carries it whole.
      expect(lookupQueries()).toHaveLength(1);
      expect(sparql).toContain(`'62014CJ0362*'`);
      expect(sparql).toContain('FILTER(CONTAINS(STR(?kwCelex), "CJ0362"))');
      expect(sparql).not.toContain('CONTAINS(LCASE(STR(?kwCelex))');
    });

    it('matches titles only for a fragment opening mid-number (#123)', async () => {
      answer([]);
      const sparql = await run({ keyword: '0362' });

      expect(sparql).not.toContain('?kwCelex');
      expect(sparql).toContain(`?kwTitle bif:contains "'0362'"`);
    });

    it('tests the partial arm in the page subquery and in the FILTER EXISTS alone (#123)', async () => {
      answer([]);
      const sparql = await run({ keyword: '2014CJ0362', date_from: '2014-01-01' });

      const subquery = sparql.indexOf('SELECT ?celexNumber (SAMPLE(?date) AS ?pageDate)');
      const exists = sparql.indexOf('FILTER EXISTS');
      const pageEnd = sparql.indexOf('LIMIT 21 OFFSET 0');
      expect(subquery).toBeGreaterThan(-1);
      expect(exists).toBeGreaterThan(pageEnd);
      for (const part of [sparql.slice(subquery, pageEnd), sparql.slice(exists)]) {
        expect(part).toContain(`?kwCelex bif:contains "'02014CJ0362*'`);
        expect(part).toContain('FILTER(CONTAINS(STR(?kwCelex), "2014CJ0362"))');
      }
      const outer = sparql.slice(0, subquery) + sparql.slice(pageEnd);
      expect(withoutFilterExists(outer)).not.toContain('?kwCelex');
      expect(sparql).not.toContain('CONTAINS(LCASE(STR(?kwCelex))');
    });

    it.each(['62020TJ0259_RES', '62017TN0161R(01)', '62025TO0653(01)'])(
      'takes the exact arm for the whole CELEX %j, whose punctuation every CELEX may hold',
      async (keyword) => {
        answer([keyword]);
        const sparql = await run({ keyword, include_derivative: true });

        expect(lookupQueries()).toHaveLength(1);
        expect(sparql).toContain(`VALUES ?kwCelex { "${keyword}"^^xsd:string }`);
        expect(sparql).not.toContain('CONTAINS(LCASE(STR(?kwCelex))');
      },
    );

    it('tests the exact arm on the page’s works alone in the date-bounded form', async () => {
      answer(['62013CJ0131']);
      const sparql = await run({ keyword: '62013CJ0131', date_from: '2014-01-01' });

      const subquery = sparql.indexOf('SELECT ?celexNumber (SAMPLE(?date) AS ?pageDate)');
      const exists = sparql.indexOf('FILTER EXISTS');
      expect(subquery).toBeGreaterThan(-1);
      expect(exists).toBeGreaterThan(subquery);
      expect(sparql.slice(exists)).toContain('VALUES ?kwCelex { "62013CJ0131"^^xsd:string }');
      // The subquery joins the keyword to find the page; outside the subquery and
      // the FILTER EXISTS test, nothing joins it again.
      const pageEnd = sparql.indexOf('LIMIT 21 OFFSET 0');
      const outer = sparql.slice(0, subquery) + sparql.slice(pageEnd);
      const outerJoins = withoutFilterExists(outer);
      for (const joined of ['?kwCelex', '?kwBase', '?kwTitle', '?kwExpr']) {
        expect(outerJoins).not.toContain(joined);
      }
    });

    it('states the whole-CELEX sibling and digit-free behavior in the keyword description', () => {
      const description = eurlex_get_cases.input.shape.keyword.description ?? '';
      expect(description).toContain('whole CELEX');
      expect(description).toMatch(/\(01\)/);
      expect(description).toContain('include_derivative');
      expect(description).toMatch(/no digit/i);
      expect(description).toMatch(/no letter or digit/i);
      expect(description).toContain('case_number');
      expect(description).toMatch(/013CJ0131[^.]*titles only/);
    });
  });

  // --- #134: a case_number that parses as no case number narrows through the CELEX index ---

  describe('case_number CELEX substring from the full-text index (#134)', () => {
    /** Years 1951 through next year, one sector-6 term each. */
    const YEARS_FROM_1951 = new Date().getUTCFullYear() + 1 - 1951 + 1;

    /** The grouped search the handler sends for `input`. */
    async function searchFor(input: Record<string, unknown>): Promise<string> {
      mockQuery.mockResolvedValue([makeCaseBinding('62013CJ0131')]);
      await eurlex_get_cases.handler(
        eurlex_get_cases.input.parse(input),
        createMockContext({ errors: eurlex_get_cases.errors }),
      );
      const search = mockQuery.mock.calls
        .map((c) => c[0] as string)
        .find((q) => q.includes('GROUP BY ?celexNumber'));
      if (!search) throw new Error('No search query was sent');
      return search;
    }

    /** Sector-6 CELEX from live CELLAR (2026-09-25), off-pattern ones included. */
    const SECTOR_6_CELEX = [
      '62013CJ0131',
      '62012CJ0131',
      '62012CC0131',
      '62024CJ0131_SUM',
      '62014CJ0362',
      '62021CO0121',
      '62021CO0121(01)',
      '62021CO0121(01)_SUM',
      '62021CO0121_1',
      '62021CO0121_SUM',
      '62022CO0121_INF',
      '61986CO0121(02)',
      '62023CO0097',
      '62023CC0097',
      '62023CJ0097_RES',
      '62017TN0161R(01)',
      '62014CN00016',
      '62011CN347',
      '62013CV0002',
      '61962CJ0026',
    ];

    it.each([
      '62014CJ0362',
      '2013CJ0131',
      'CJ0131',
      'CO0121',
      '62021co0121',
      '62021CO0121(01)',
      '2021CO0121_1',
      'CO0121(01)_SUM',
      '2023CJ0097_RES',
      '2017TN0161R',
      '62014CN0001',
      'CN347',
    ])(
      'reaches through the index exactly the CELEX the substring scan reached for %s',
      async (caseNumber) => {
        const sparql = await searchFor({ case_number: caseNumber, include_derivative: true });

        expect(indexExpressions(sparql)).toHaveLength(1);
        expect(sparql).not.toContain('LCASE(STR(?celexNumber))');
        for (const celex of SECTOR_6_CELEX) {
          expect(reaches(sparql, celex), celex).toBe(
            celex.toLowerCase().includes(caseNumber.toLowerCase()),
          );
        }
      },
    );

    it('matches a whole CELEX from its one index term, with no lookup query', async () => {
      const sparql = await searchFor({ case_number: '62014CJ0362' });

      expect(sparql).toContain(`?celexNumber bif:contains "'62014CJ0362*'" .`);
      expect(sparql).toContain('FILTER(CONTAINS(STR(?celexNumber), "62014CJ0362"))');
      // The search and the page's work resolution (#97); no family lookup.
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    it('completes a year-and-letters opening to sector 6 alone', async () => {
      const sparql = await searchFor({ case_number: '2013CJ0131' });

      expect(indexExpressions(sparql)).toEqual([`'62013CJ0131*'`]);
      expect(sparql).toContain('FILTER(CONTAINS(STR(?celexNumber), "2013CJ0131"))');
    });

    it('completes a letters-and-number opening with every sector-6 year from 1951', async () => {
      const sparql = await searchFor({ case_number: 'CJ0131' });

      const terms = indexExpressions(sparql)[0]?.split(' OR ') ?? [];
      expect(terms).toHaveLength(YEARS_FROM_1951);
      expect(terms[0]).toBe(`'61951CJ0131*'`);
      expect(terms).toContain(`'62013CJ0131*'`);
      expect(terms.every((term) => term.startsWith(`'6`))).toBe(true);
    });

    it('uppercases the value and stops the term at the first character outside [0-9A-Z]', async () => {
      const sparql = await searchFor({ case_number: '62023co0097(01)' });

      expect(indexExpressions(sparql)).toEqual([`'62023CO0097*'`]);
      expect(sparql).toContain('FILTER(CONTAINS(STR(?celexNumber), "62023CO0097(01)"))');
    });

    /**
     * An indexed opening the keyword route gives no sector-6 term keeps the scan: a
     * year past next year, letters no type code ends in, and letters only other
     * sectors' codes end in (`XC` is a sector-5 code). No sector-6 CELEX holds any of
     * them, so the scan answers what an index route would, without guessing.
     */
    it.each(['9999CJ0131', 'QQ0131', 'XC0131'])(
      'keeps the substring scan for %s, which completes to no sector-6 CELEX start',
      async (caseNumber) => {
        const sparql = await searchFor({ case_number: caseNumber });

        expect(indexExpressions(sparql)).toEqual([]);
        expect(sparql).toContain(
          `FILTER(CONTAINS(LCASE(STR(?celexNumber)), LCASE("${caseNumber}")))`,
        );
      },
    );

    it('narrows the page subquery and the outer query alike in the date-bounded form', async () => {
      const sparql = await searchFor({ case_number: 'CJ0131', date_from: '2000-01-01' });

      const subquery = sparql.indexOf('SELECT ?celexNumber (SAMPLE(?date) AS ?pageDate)');
      const pageEnd = sparql.indexOf('LIMIT 21 OFFSET 0');
      expect(subquery).toBeGreaterThan(-1);
      for (const part of [sparql.slice(subquery, pageEnd), sparql.slice(pageEnd)]) {
        expect(indexExpressions(part)).toHaveLength(1);
        expect(part).toContain('FILTER(CONTAINS(STR(?celexNumber), "CJ0131"))');
      }
    });

    /**
     * The injection guarantee: a value reaches the index only after the CELEX-character
     * gate, and its terms come from its leading `[0-9A-Z]` run alone, so every index
     * expression is a list of quoted `[0-9A-Z]` prefix terms and the confirming literal
     * holds only CELEX characters. A value carrying a quote or an operator is rejected
     * before any query is built.
     */
    it.each(["2013CJ0131' OR 'x", '2013CJ0131"', 'CJ0131*', '62014CJ0362 AND 1', 'CJ0131\\'])(
      'rejects %j before building any query',
      async (caseNumber) => {
        await expect(
          eurlex_get_cases.handler(
            eurlex_get_cases.input.parse({ case_number: caseNumber }),
            createMockContext({ errors: eurlex_get_cases.errors }),
          ),
        ).rejects.toMatchObject({ data: { reason: 'invalid_case_number' } });
        expect(mockQuery).not.toHaveBeenCalled();
      },
    );

    it('builds index expressions only from quoted [0-9A-Z] terms over randomized values', async () => {
      const alphabet = '0123456789ABCJOTNRcjo()_6';
      let seed = 134;
      const next = () => {
        seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
        return seed;
      };
      let indexed = 0;
      for (let i = 0; i < 300; i++) {
        mockQuery.mockReset();
        const length = 1 + (next() % 16);
        const caseNumber = Array.from({ length }, () => alphabet[next() % alphabet.length]).join(
          '',
        );
        const sparql = await searchFor({ case_number: caseNumber });
        const expressions = indexExpressions(sparql);
        indexed += expressions.length;
        expect(expressions.length, caseNumber).toBeLessThanOrEqual(1);
        for (const expression of expressions) {
          expect(expression, caseNumber).toMatch(/^'[0-9A-Z]+\*'(?: OR '[0-9A-Z]+\*')*$/);
        }
        for (const [, literal] of sparql.matchAll(
          /FILTER\(CONTAINS\(STR\(\?celexNumber\), "((?:[^"\\]|\\.)*)"\)\)/g,
        )) {
          expect(literal, caseNumber).toMatch(/^[0-9A-Z()_]+$/);
        }
        expect(sparql.match(/bif:contains/g)?.length ?? 0, caseNumber).toBe(expressions.length);
      }
      // The alphabet reaches both routes.
      expect(indexed).toBeGreaterThan(0);
      expect(indexed).toBeLessThan(300);
    });

    it('names the indexed openings and the slow scan in the case_number description', () => {
      const description = eurlex_get_cases.input.shape.case_number.description ?? '';
      expect(description).toContain('CELEX index');
      expect(description).toMatch(/2013CJ0131[^.]*CJ0131/);
      expect(description).toMatch(/12CJ0131[^.]*tests every CELEX/);
    });
  });

  // --- #138: a parsed case_number narrows through the CELEX index, REGEX confirming ---

  describe('parsed case_number through the CELEX full-text index (#138)', () => {
    /** The grouped search the handler sends for `input`. */
    async function searchFor(input: Record<string, unknown>): Promise<string> {
      mockQuery.mockReset();
      mockQuery.mockResolvedValue([makeCaseBinding('62014CJ0443')]);
      await eurlex_get_cases.handler(
        eurlex_get_cases.input.parse(input),
        createMockContext({ errors: eurlex_get_cases.errors }),
      );
      const search = mockQuery.mock.calls
        .map((c) => c[0] as string)
        .find((q) => q.includes('GROUP BY ?celexNumber'));
      if (!search) throw new Error('No search query was sent');
      return search;
    }

    const terms = (prefix: string, letters: string, number: string) =>
      [...letters].map((letter) => `'${prefix}${letter}${number}*'`).join(' OR ');

    it.each([
      ['C-443/14', {}, terms('62014C', 'JOCPSTD', '0443'), '2014C[JOCPSTD]0443'],
      ['82/85', {}, terms('61985C', 'JOCPSTD', '0082'), '1985C[JOCPSTD]0082'],
      [
        'C-131/12',
        { include_derivative: true },
        terms('62012C', 'JOCPSTDABN', '0131'),
        '2012C[JOCPSTDABN]0131',
      ],
      [
        'C-131/12',
        { include_derivative: true, case_type: 'judgment' },
        terms('62012C', 'JOCPSTD', '0131'),
        '2012C[JOCPSTD]0131',
      ],
      ['T-97/23 P', {}, terms('62023T', 'JOCT', '0097'), '2023T[JOCT]0097'],
      [
        'F-12/05',
        { include_derivative: true },
        terms('62005F', 'JOABN', '0012'),
        '2005F[JOABN]0012',
      ],
    ])(
      'narrows %s %j with one prefix term per admitted document letter, keeping the REGEX',
      async (caseNumber, options, expression, pattern) => {
        const sparql = await searchFor({ case_number: caseNumber, ...options });

        expect(indexExpressions(sparql)).toEqual([expression]);
        expect(sparql).toContain(`FILTER(REGEX(STR(?celexNumber), "${pattern}"))`);
        expect(sparql).not.toContain('LCASE(STR(?celexNumber))');
      },
    );

    /**
     * Parity with the REGEX alone over live sector-6 CELEX (2026-09-25), siblings,
     * corrigenda, suffixed records, and off-pattern values included: `admits` reads
     * only the FILTER lines, so it is the match the tool made before the index terms.
     */
    const LIVE_SECTOR_6 = [
      '62014CJ0443',
      '62014CC0443',
      '61985CO0082',
      '61985CO0082(01)',
      '62012CJ0131',
      '62012CC0131',
      '62012CA0131',
      '62012CN0131',
      '62024CJ0131_SUM',
      '62013CJ0131',
      ...C_97_23_PRIMARY,
      ...C_97_23_DERIVATIVE,
      ...T_97_23_RECORDS,
      '62021CO0121',
      '62021CO0121(01)',
      '62021CO0121(01)_SUM',
      '62021CO0121_1',
      '62021CO0121_SUM',
      '62022CO0121_INF',
      '62017TN0161R(01)',
      '62014CN00016',
      '62011CN347',
      '62013CV0002',
      '61962CJ0026',
    ];

    it.each([
      ['C-443/14', false],
      ['82/85', false],
      ['C-131/12', true],
      ['C-131/12', false],
      ['C-97/23', true],
      ['T-97/23', true],
      ['C-121/21', true],
      ['T-161/17', true],
      ['C-1/14', true],
      ['C-347/11', true],
      ['C-2/13', false],
    ])(
      'reaches through the index exactly the CELEX the REGEX admits for %s (include_derivative %s)',
      async (caseNumber, includeDerivative) => {
        const sparql = await searchFor({
          case_number: caseNumber,
          include_derivative: includeDerivative,
        });

        expect(indexExpressions(sparql)).toHaveLength(1);
        for (const celex of LIVE_SECTOR_6) {
          expect(reaches(sparql, celex), celex).toBe(admits(sparql, celex));
        }
      },
    );

    it('reaches the corrigendum, suffixed records, and five-digit number the REGEX reaches', async () => {
      const sparql = await searchFor({ case_number: 'C-121/21', include_derivative: true });
      for (const celex of ['62021CO0121(01)_SUM', '62021CO0121_1', '62021CO0121_SUM']) {
        expect(reaches(sparql, celex), celex).toBe(true);
      }
      expect(
        reaches(
          await searchFor({ case_number: 'T-161/17', include_derivative: true }),
          '62017TN0161R(01)',
        ),
      ).toBe(true);
      expect(
        reaches(
          await searchFor({ case_number: 'C-1/14', include_derivative: true }),
          '62014CN00016',
        ),
      ).toBe(true);
    });

    it('keeps the REGEX alone for a year written with fewer than four digits', async () => {
      const sparql = await searchFor({ case_number: 'C-131/012' });

      expect(indexExpressions(sparql)).toEqual([]);
      expect(sparql).toContain('FILTER(REGEX(STR(?celexNumber), "12C[JOCPSTD]0131"))');
    });

    it('narrows the page subquery and the outer query alike in the date-bounded form', async () => {
      const sparql = await searchFor({ case_number: 'C-443/14', date_from: '2015-01-01' });

      const subquery = sparql.indexOf('SELECT ?celexNumber (SAMPLE(?date) AS ?pageDate)');
      const pageEnd = sparql.indexOf('LIMIT 21 OFFSET 0');
      expect(subquery).toBeGreaterThan(-1);
      for (const part of [sparql.slice(subquery, pageEnd), sparql.slice(pageEnd)]) {
        expect(indexExpressions(part)).toEqual([terms('62014C', 'JOCPSTD', '0443')]);
        expect(part).toContain('FILTER(REGEX(STR(?celexNumber), "2014C[JOCPSTD]0443"))');
      }
    });

    /**
     * The injection guarantee: the terms come from the parsed digits, the court
     * letter, and the document-letter table, never from caller text. Text after the
     * year is ignored as a procedural suffix, so a payload there parses and must stay
     * out of the query.
     */
    it.each([
      "C-443/14' OR 'x",
      'C-443/14 P" } ; DROP',
      "Case C-443/14 *' AND 'Z",
      'C-443/14\\',
      'c-443/14 x"y',
    ])('keeps the text after the year of %j out of the query', async (caseNumber) => {
      const sparql = await searchFor({ case_number: caseNumber });

      expect(indexExpressions(sparql)).toEqual([terms('62014C', 'JOCPSTD', '0443')]);
      expect(sparql).toContain('FILTER(REGEX(STR(?celexNumber), "2014C[JOCPSTD]0443"))');
      const suffix = caseNumber.slice(caseNumber.indexOf('/14') + 3);
      expect(sparql).not.toContain(suffix);
    });

    it('builds index expressions only from quoted [0-9A-Z] terms over randomized suffixes', async () => {
      const alphabet = `ABCPRTjo()'"*\\ {}.;\n\tORAND-_`;
      let seed = 138;
      const next = () => {
        seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
        return seed;
      };
      for (let i = 0; i < 200; i++) {
        const length = 1 + (next() % 16);
        const suffix = Array.from({ length }, () => alphabet[next() % alphabet.length]).join('');
        const sparql = await searchFor({ case_number: `C-${1 + (next() % 999)}/14${suffix}` });
        const expressions = indexExpressions(sparql);
        expect(expressions, suffix).toHaveLength(1);
        expect(expressions[0], suffix).toMatch(
          /^'62014C[JOCPSTD]\d{4}\*'(?: OR '62014C[JOCPSTD]\d{4}\*'){6}$/,
        );
        expect(sparql.match(/bif:contains/g)?.length, suffix).toBe(1);
      }
    });
  });
});
