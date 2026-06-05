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

function makeCaseBinding(
  celex: string,
  opts: { workUri?: string; type?: string; date?: string; title?: string } = {},
): Record<string, { type: string; value: string }> {
  const b: Record<string, { type: string; value: string }> = {
    celexNumber: { type: 'literal', value: celex },
    work: {
      type: 'uri',
      value: opts.workUri ?? `http://publications.europa.eu/resource/cellar/${celex}`,
    },
  };
  if (opts.type) b.type = { type: 'uri', value: opts.type };
  if (opts.date) b.date = { type: 'literal', value: opts.date };
  if (opts.title) b.title = { type: 'literal', value: opts.title };
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
      }),
    ]);

    const input = eurlex_get_cases.input.parse({ keyword: 'google' });
    const result = await eurlex_get_cases.handler(input, ctx);

    expect(result.total).toBe(1);
    expect(result.cases[0]?.celex_number).toBe('62013CJ0131');
    expect(result.cases[0]?.title).toBe('Google Spain SL v AEPD');
    expect(result.cases[0]?.date).toBe('2014-05-13');
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

  // --- Format ---

  it('format renders celex, date, and title', () => {
    const output = {
      cases: [
        {
          work_uri: 'http://publications.europa.eu/resource/cellar/google-spain',
          celex_number: '62013CJ0131',
          date: '2014-05-13',
          title: 'Google Spain SL v AEPD',
        },
      ],
      total: 1,
      offset: 0,
    };
    const blocks = eurlex_get_cases.format!(output);
    expect(blocks[0]?.type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('62013CJ0131');
    expect(text).toContain('Google Spain SL v AEPD');
    expect(text).toContain('2014-05-13');
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
    };
    const blocks = eurlex_get_cases.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('62020TJ0001');
  });
});
