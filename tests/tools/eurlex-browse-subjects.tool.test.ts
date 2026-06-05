/**
 * @fileoverview Tests for eurlex_browse_subjects tool.
 * @module tests/tools/eurlex-browse-subjects.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eurlex_browse_subjects } from '@/mcp-server/tools/definitions/eurlex-browse-subjects.tool.js';

// --- Service mock ---
const mockQuery = vi.fn();
vi.mock('@/services/cellar-sparql/cellar-sparql-service.js', () => ({
  getCellarSparqlService: () => ({ query: mockQuery }),
  CellarSparqlService: {
    bindingValue: (binding: Record<string, { value?: string }> | undefined, field: string) =>
      binding?.[field]?.value,
  },
}));

function makeConceptBinding(opts: {
  uri: string;
  label: string;
  code?: string;
  broaderLabel?: string;
}): Record<string, { type: string; value: string }> {
  const b: Record<string, { type: string; value: string }> = {
    concept: { type: 'uri', value: opts.uri },
    label: { type: 'literal', value: opts.label },
  };
  if (opts.code) b.code = { type: 'literal', value: opts.code };
  if (opts.broaderLabel) b.broaderLabel = { type: 'literal', value: opts.broaderLabel };
  return b;
}

describe('eurlex_browse_subjects', () => {
  beforeEach(() => mockQuery.mockReset());

  // --- Happy paths ---

  it('returns matching EuroVoc concepts', async () => {
    const ctx = createMockContext({ errors: eurlex_browse_subjects.errors });
    mockQuery.mockResolvedValue([
      makeConceptBinding({
        uri: 'http://eurovoc.europa.eu/2830',
        label: 'data protection',
        code: '2830',
        broaderLabel: 'information',
      }),
      makeConceptBinding({
        uri: 'http://eurovoc.europa.eu/5550',
        label: 'personal data',
        code: '5550',
      }),
    ]);

    const input = eurlex_browse_subjects.input.parse({ keyword: 'data' });
    const result = await eurlex_browse_subjects.handler(input, ctx);

    expect(result.total).toBe(2);
    expect(result.concepts[0]?.concept_uri).toBe('http://eurovoc.europa.eu/2830');
    expect(result.concepts[0]?.pref_label).toBe('data protection');
    expect(result.concepts[0]?.concept_code).toBe('2830');
    expect(result.concepts[0]?.broader_label).toBe('information');
    // Second concept: no broader label
    expect(result.concepts[1]?.broader_label).toBeUndefined();
  });

  it('passes keyword lowercased to SPARQL CONTAINS filter', async () => {
    const ctx = createMockContext({ errors: eurlex_browse_subjects.errors });
    mockQuery.mockResolvedValue([
      makeConceptBinding({ uri: 'http://eurovoc.europa.eu/1', label: 'Privacy' }),
    ]);

    const input = eurlex_browse_subjects.input.parse({ keyword: 'Privacy' });
    await eurlex_browse_subjects.handler(input, ctx);

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sparql).toContain('"privacy"');
  });

  it('passes language filter to SPARQL', async () => {
    const ctx = createMockContext({ errors: eurlex_browse_subjects.errors });
    mockQuery.mockResolvedValue([
      makeConceptBinding({ uri: 'http://eurovoc.europa.eu/1', label: 'vie privée' }),
    ]);

    const input = eurlex_browse_subjects.input.parse({ keyword: 'vie', language: 'fr' });
    await eurlex_browse_subjects.handler(input, ctx);

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sparql).toContain('"fr"');
  });

  it('respects limit parameter', async () => {
    const ctx = createMockContext({ errors: eurlex_browse_subjects.errors });
    mockQuery.mockResolvedValue([
      makeConceptBinding({ uri: 'http://eurovoc.europa.eu/1', label: 'agriculture' }),
    ]);

    const input = eurlex_browse_subjects.input.parse({ keyword: 'agri', limit: 5 });
    await eurlex_browse_subjects.handler(input, ctx);

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sparql).toContain('LIMIT 5');
  });

  // --- Error contract: no_concepts ---

  it('throws ctx.fail("no_concepts") when query returns no bindings', async () => {
    const ctx = createMockContext({ errors: eurlex_browse_subjects.errors });
    mockQuery.mockResolvedValue([]);

    const input = eurlex_browse_subjects.input.parse({ keyword: 'zznonexistentterm' });
    await expect(eurlex_browse_subjects.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_concepts' },
    });
  });

  // --- Format ---

  it('format renders concept URI, label, code, and broader label', () => {
    const output = {
      concepts: [
        {
          concept_uri: 'http://eurovoc.europa.eu/2830',
          pref_label: 'data protection',
          concept_code: '2830',
          broader_label: 'information',
        },
      ],
      total: 1,
    };
    const blocks = eurlex_browse_subjects.format!(output);
    expect(blocks[0]?.type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('http://eurovoc.europa.eu/2830');
    expect(text).toContain('data protection');
    expect(text).toContain('2830');
    expect(text).toContain('information');
  });
});
