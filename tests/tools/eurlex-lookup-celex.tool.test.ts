/**
 * @fileoverview Tests for eurlex_lookup_celex tool.
 * @module tests/tools/eurlex-lookup-celex.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eurlex_lookup_celex } from '@/mcp-server/tools/definitions/eurlex-lookup-celex.tool.js';

// --- Service mock ---
const mockQuery = vi.fn();
vi.mock('@/services/cellar-sparql/cellar-sparql-service.js', () => ({
  getCellarSparqlService: () => ({ query: mockQuery }),
  CellarSparqlService: {
    bindingValue: (binding: Record<string, { value?: string }> | undefined, field: string) =>
      binding?.[field]?.value,
  },
}));

function makeBinding(
  celex: string,
  opts: { workUri?: string; type?: string; date?: string } = {},
): Record<string, { type: string; value: string }> {
  return {
    celexNumber: { type: 'literal', value: celex },
    work: {
      type: 'uri',
      value: opts.workUri ?? `http://publications.europa.eu/resource/cellar/${celex}`,
    },
    ...(opts.type ? { type: { type: 'uri', value: opts.type } } : {}),
    ...(opts.date ? { date: { type: 'literal', value: opts.date } } : {}),
  };
}

describe('eurlex_lookup_celex', () => {
  beforeEach(() => mockQuery.mockReset());

  // --- Happy paths ---

  it('resolves a CELEX number to a work', async () => {
    const ctx = createMockContext({ errors: eurlex_lookup_celex.errors });
    mockQuery.mockResolvedValue([
      makeBinding('32016R0679', {
        type: 'http://publications.europa.eu/resource/authority/resource-type/REG',
        date: '2016-04-27',
      }),
    ]);

    const input = eurlex_lookup_celex.input.parse({ identifier: '32016R0679' });
    const result = await eurlex_lookup_celex.handler(input, ctx);

    expect(result.found).toBe(true);
    expect(result.celex_number).toBe('32016R0679');
    expect(result.date).toBe('2016-04-27');
  });

  it('auto-detects CELEX format when identifier_type is "auto"', async () => {
    const ctx = createMockContext({ errors: eurlex_lookup_celex.errors });
    mockQuery.mockResolvedValue([makeBinding('32016R0679')]);

    const input = eurlex_lookup_celex.input.parse({
      identifier: '32016R0679',
      identifier_type: 'auto',
    });
    const result = await eurlex_lookup_celex.handler(input, ctx);

    expect(result.found).toBe(true);
    // Auto-detected as celex; SPARQL should filter by exact CELEX string
    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sparql).toContain('32016R0679');
  });

  it('resolves an ELI URI to the same work and CELEX as the CELEX lookup', async () => {
    const ctx = createMockContext({ errors: eurlex_lookup_celex.errors });
    const gdprWork =
      'http://publications.europa.eu/resource/cellar/3e485e15-11bd-11e6-ba9a-01aa75ed71a1';
    mockQuery.mockResolvedValue([
      makeBinding('32016R0679', {
        workUri: gdprWork,
        type: 'http://publications.europa.eu/resource/authority/resource-type/REG',
        date: '2016-04-27',
      }),
    ]);

    const input = eurlex_lookup_celex.input.parse({
      identifier: 'http://data.europa.eu/eli/reg/2016/679/oj',
      identifier_type: 'auto',
    });
    const result = await eurlex_lookup_celex.handler(input, ctx);

    // Auto-detected as ELI; resolves to GDPR's canonical work + CELEX.
    expect(result.found).toBe(true);
    expect(result.work_uri).toBe(gdprWork);
    expect(result.celex_number).toBe('32016R0679');

    // ELI branch exact-matches cdm:resource_legal_eli as an xsd:anyURI literal,
    // not the old broken work-URI substring scan.
    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sparql).toContain('cdm:resource_legal_eli');
    expect(sparql).toContain('"http://data.europa.eu/eli/reg/2016/679/oj"^^xsd:anyURI');
    expect(sparql).not.toContain('CONTAINS(STR(?work)');
  });

  it('resolves a bare work-level ELI by retrying with /oj, one-to-one to the same work', async () => {
    const ctx = createMockContext({ errors: eurlex_lookup_celex.errors });
    const gdprWork =
      'http://publications.europa.eu/resource/cellar/3e485e15-11bd-11e6-ba9a-01aa75ed71a1';
    // CELLAR stores only the /oj manifestation literal: the bare work-level ELI
    // misses (first call), the /oj retry resolves the single work (second call).
    mockQuery.mockResolvedValueOnce([]).mockResolvedValueOnce([
      makeBinding('32016R0679', {
        workUri: gdprWork,
        type: 'http://publications.europa.eu/resource/authority/resource-type/REG',
        date: '2016-04-27',
      }),
    ]);

    const input = eurlex_lookup_celex.input.parse({
      identifier: 'http://data.europa.eu/eli/reg/2016/679',
      identifier_type: 'auto',
    });
    const result = await eurlex_lookup_celex.handler(input, ctx);

    // Resolves to GDPR's canonical work + CELEX via the /oj normalization.
    expect(result.found).toBe(true);
    expect(result.work_uri).toBe(gdprWork);
    expect(result.celex_number).toBe('32016R0679');

    // Exactly two queries: bare exact-match (miss), then the /oj retry.
    expect(mockQuery).toHaveBeenCalledTimes(2);
    const firstSparql = mockQuery.mock.calls[0]?.[0] as string;
    const retrySparql = mockQuery.mock.calls[1]?.[0] as string;
    expect(firstSparql).toContain('"http://data.europa.eu/eli/reg/2016/679"^^xsd:anyURI');
    // The retry is an exact-match on the specific /oj literal — the same
    // one-to-one mechanism as a direct ELI lookup, never a substring scan.
    expect(retrySparql).toContain('"http://data.europa.eu/eli/reg/2016/679/oj"^^xsd:anyURI');
    expect(retrySparql).toContain('cdm:resource_legal_eli');
    expect(retrySparql).not.toContain('CONTAINS');
  });

  it('handles sparse binding (no type or date)', async () => {
    const ctx = createMockContext({ errors: eurlex_lookup_celex.errors });
    mockQuery.mockResolvedValue([makeBinding('32016R0679')]);

    const input = eurlex_lookup_celex.input.parse({ identifier: '32016R0679' });
    const result = await eurlex_lookup_celex.handler(input, ctx);

    expect(result.found).toBe(true);
    expect(result.resource_type).toBeUndefined();
    expect(result.date).toBeUndefined();
  });

  // --- Error contract: ambiguous_identifier ---

  it('throws ctx.fail("ambiguous_identifier") for unrecognized format with auto-detection', async () => {
    const ctx = createMockContext({ errors: eurlex_lookup_celex.errors });

    // This string matches neither CELEX nor ELI patterns
    const input = eurlex_lookup_celex.input.parse({
      identifier: 'completely-unrecognized-identifier-string',
      identifier_type: 'auto',
    });
    await expect(eurlex_lookup_celex.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'ambiguous_identifier' },
    });
    // Should not have called the SPARQL service
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('no longer advertises the "oj" identifier_type — the enum rejects it', () => {
    expect(() =>
      eurlex_lookup_celex.input.parse({ identifier: 'OJ L 119', identifier_type: 'oj' }),
    ).toThrow();
  });

  // --- Error contract: not_found ---

  it('throws ctx.fail("not_found") when SPARQL returns no bindings', async () => {
    const ctx = createMockContext({ errors: eurlex_lookup_celex.errors });
    mockQuery.mockResolvedValue([]);

    const input = eurlex_lookup_celex.input.parse({ identifier: '32099X0000' });
    await expect(eurlex_lookup_celex.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'not_found' },
    });
  });

  it('throws ctx.fail("not_found") for an ELI that resolves to no work', async () => {
    const ctx = createMockContext({ errors: eurlex_lookup_celex.errors });
    mockQuery.mockResolvedValue([]);

    const input = eurlex_lookup_celex.input.parse({
      identifier: 'http://data.europa.eu/eli/reg/9999/99999/oj',
      identifier_type: 'eli',
    });
    await expect(eurlex_lookup_celex.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'not_found' },
    });
  });

  it('does not retry a manifestation-suffixed ELI — never falls back to the original act', async () => {
    const ctx = createMockContext({ errors: eurlex_lookup_celex.errors });
    mockQuery.mockResolvedValue([]);

    // A consolidated-version ELI (/YYYY-MM-DD) is not bare work-level: if it
    // misses, the lookup must NOT silently resolve the original /oj act instead.
    const input = eurlex_lookup_celex.input.parse({
      identifier: 'http://data.europa.eu/eli/reg/2016/679/2018-05-25',
      identifier_type: 'eli',
    });
    await expect(eurlex_lookup_celex.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'not_found' },
    });
    // Single query — the /oj retry never fired for a manifestation-suffixed ELI.
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('still returns not_found when a bare work-level ELI has no matching act', async () => {
    const ctx = createMockContext({ errors: eurlex_lookup_celex.errors });
    mockQuery.mockResolvedValue([]);

    const input = eurlex_lookup_celex.input.parse({
      identifier: 'http://data.europa.eu/eli/reg/9999/99999',
      identifier_type: 'eli',
    });
    await expect(eurlex_lookup_celex.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'not_found' },
    });
    // The /oj retry fired (bare work-level) but also missed — never fabricates a match.
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  // --- Format ---

  it('format renders found, celex, work_uri, type, and date', () => {
    const output = {
      found: true,
      work_uri: 'http://publications.europa.eu/resource/cellar/gdpr',
      celex_number: '32016R0679',
      resource_type: 'http://publications.europa.eu/resource/authority/resource-type/REG',
      date: '2016-04-27',
    };
    const blocks = eurlex_lookup_celex.format!(output);
    expect(blocks[0]?.type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('32016R0679');
    expect(text).toContain('2016-04-27');
    expect(text).toContain('REG');
  });

  it('format renders found flag with sparse output (no optional fields)', () => {
    const output = { found: true };
    const blocks = eurlex_lookup_celex.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('**Found:** true');
  });
});
