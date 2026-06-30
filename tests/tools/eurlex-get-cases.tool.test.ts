/**
 * @fileoverview Tests for eurlex_get_cases tool.
 * @module tests/tools/eurlex-get-cases.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eurlex_get_cases } from '@/mcp-server/tools/definitions/eurlex-get-cases.tool.js';

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
  opts: { workUri?: string; types?: string; date?: string; title?: string } = {},
): Record<string, { type: string; value: string }> {
  const b: Record<string, { type: string; value: string }> = {
    celex: { type: 'literal', value: celex },
    work: {
      type: 'uri',
      value: opts.workUri ?? `http://publications.europa.eu/resource/cellar/${celex}`,
    },
  };
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

  it('applies case_type=judgment filter (CJ substring)', async () => {
    const ctx = createMockContext({ errors: eurlex_get_cases.errors });
    mockQuery.mockResolvedValue([makeCaseBinding('62013CJ0131')]);

    const input = eurlex_get_cases.input.parse({ case_type: 'judgment' });
    await eurlex_get_cases.handler(input, ctx);

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sparql).toContain('"CJ"');
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

  // --- Dedup of multi-resource-type works (issue #14) ---

  it('groups by work and concatenates resource-types instead of SELECT DISTINCT', async () => {
    const ctx = createMockContext({ errors: eurlex_get_cases.errors });
    mockQuery.mockResolvedValue([makeCaseBinding('62013CJ0131')]);

    const input = eurlex_get_cases.input.parse({ keyword: 'google' });
    await eurlex_get_cases.handler(input, ctx);

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sparql).toContain('GROUP BY ?work');
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

  it('the limit bounds distinct works (cap applied after GROUP BY)', async () => {
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
    expect(sparql).toMatch(/GROUP BY \?work[\s\S]*LIMIT 2/);
    expect(result.total).toBe(2);
    expect(new Set(result.cases.map((c) => c.work_uri)).size).toBe(2);
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
});
