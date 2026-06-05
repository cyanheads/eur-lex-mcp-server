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

  it('auto-detects ELI URI format', async () => {
    const ctx = createMockContext({ errors: eurlex_lookup_celex.errors });
    mockQuery.mockResolvedValue([makeBinding('32016R0679')]);

    const input = eurlex_lookup_celex.input.parse({
      identifier: 'http://data.europa.eu/eli/reg/2016/679/oj',
      identifier_type: 'auto',
    });
    const result = await eurlex_lookup_celex.handler(input, ctx);

    expect(result.found).toBe(true);
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

    // This string matches neither CELEX, ELI, nor OJ patterns
    const input = eurlex_lookup_celex.input.parse({
      identifier: 'completely-unrecognized-identifier-string',
      identifier_type: 'auto',
    });
    await expect(eurlex_lookup_celex.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'ambiguous_identifier' },
    });
    // Should not have called the SPARQL service
    expect(mockQuery).not.toHaveBeenCalled();
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
