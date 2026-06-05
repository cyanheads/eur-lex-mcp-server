/**
 * @fileoverview Tests for eurlex_get_relations tool.
 * @module tests/tools/eurlex-get-relations.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eurlex_get_relations } from '@/mcp-server/tools/definitions/eurlex-get-relations.tool.js';

// --- Service mock ---
const mockQuery = vi.fn();
vi.mock('@/services/cellar-sparql/cellar-sparql-service.js', () => ({
  getCellarSparqlService: () => ({ query: mockQuery }),
  CellarSparqlService: {
    bindingValue: (binding: Record<string, { value?: string }> | undefined, field: string) =>
      binding?.[field]?.value,
  },
}));

const GDPR_WORK_URI =
  'http://publications.europa.eu/resource/cellar/3e485e15-d3d0-11e5-8cd4-01aa75ed71a1';
const AMENDED_BY_PREDICATE =
  'http://publications.europa.eu/ontology/cdm#resource_legal_amended_by_resource_legal';
const AMENDS_PREDICATE =
  'http://publications.europa.eu/ontology/cdm#resource_legal_amends_resource_legal';
const LEGAL_BASIS_PREDICATE =
  'http://publications.europa.eu/ontology/cdm#resource_legal_based_on_resource_legal';

function makeResolveBinding(workUri: string): Record<string, { type: string; value: string }> {
  return { work: { type: 'uri', value: workUri } };
}

function makeRelationBinding(opts: {
  relatedWork: string;
  relationType: string;
  direction: string;
  relatedCelex?: string;
}): Record<string, { type: string; value: string }> {
  const b: Record<string, { type: string; value: string }> = {
    relatedWork: { type: 'uri', value: opts.relatedWork },
    relationType: { type: 'uri', value: opts.relationType },
    direction: { type: 'literal', value: opts.direction },
  };
  if (opts.relatedCelex) {
    b.relatedCelex = { type: 'literal', value: opts.relatedCelex };
  }
  return b;
}

describe('eurlex_get_relations', () => {
  beforeEach(() => mockQuery.mockReset());

  // --- Happy path ---

  it('returns relations for a valid CELEX number', async () => {
    const ctx = createMockContext({ errors: eurlex_get_relations.errors });

    // First call: resolve CELEX → work URI
    mockQuery
      .mockResolvedValueOnce([makeResolveBinding(GDPR_WORK_URI)])
      // Second call: fetch relations
      .mockResolvedValueOnce([
        makeRelationBinding({
          relatedWork: 'http://publications.europa.eu/resource/cellar/amend-work',
          relationType: AMENDED_BY_PREDICATE,
          direction: 'incoming',
          relatedCelex: '32022R0000',
        }),
        makeRelationBinding({
          relatedWork: 'http://publications.europa.eu/resource/cellar/basis-work',
          relationType: LEGAL_BASIS_PREDICATE,
          direction: 'outgoing',
        }),
      ]);

    const input = eurlex_get_relations.input.parse({ celex_number: '32016R0679' });
    const result = await eurlex_get_relations.handler(input, ctx);

    expect(result.celex_number).toBe('32016R0679');
    expect(result.work_uri).toBe(GDPR_WORK_URI);
    expect(result.total).toBe(2);
    const amendedByRel = result.relations.find((r) => r.relation_type === 'amended_by');
    expect(amendedByRel).toBeDefined();
    expect(amendedByRel?.related_celex_number).toBe('32022R0000');
    expect(amendedByRel?.direction).toBe('incoming');
  });

  it('deduplicates identical relation bindings', async () => {
    const ctx = createMockContext({ errors: eurlex_get_relations.errors });
    mockQuery.mockResolvedValueOnce([makeResolveBinding(GDPR_WORK_URI)]).mockResolvedValueOnce([
      makeRelationBinding({
        relatedWork: 'http://publications.europa.eu/resource/cellar/some-work',
        relationType: AMENDS_PREDICATE,
        direction: 'outgoing',
      }),
      // Duplicate — same key
      makeRelationBinding({
        relatedWork: 'http://publications.europa.eu/resource/cellar/some-work',
        relationType: AMENDS_PREDICATE,
        direction: 'outgoing',
      }),
    ]);

    const input = eurlex_get_relations.input.parse({ celex_number: '32016R0679' });
    const result = await eurlex_get_relations.handler(input, ctx);

    expect(result.total).toBe(1);
  });

  it('filters to requested relation_types only', async () => {
    const ctx = createMockContext({ errors: eurlex_get_relations.errors });
    mockQuery.mockResolvedValueOnce([makeResolveBinding(GDPR_WORK_URI)]).mockResolvedValueOnce([
      makeRelationBinding({
        relatedWork: 'http://publications.europa.eu/resource/cellar/lb-work',
        relationType: LEGAL_BASIS_PREDICATE,
        direction: 'outgoing',
      }),
    ]);

    const input = eurlex_get_relations.input.parse({
      celex_number: '32016R0679',
      relation_types: ['legal_basis'],
    });
    await eurlex_get_relations.handler(input, ctx);

    // The second SPARQL call should only include the legal_basis predicate
    const relSparql = mockQuery.mock.calls[1]?.[0] as string;
    expect(relSparql).toContain('cdm:resource_legal_based_on_resource_legal');
    expect(relSparql).not.toContain('cdm:work_cites_work');
  });

  // --- Error contract: not_found ---

  it('throws ctx.fail("not_found") when CELEX resolves to no work URI', async () => {
    const ctx = createMockContext({ errors: eurlex_get_relations.errors });
    // Resolve step returns empty
    mockQuery.mockResolvedValueOnce([]);

    const input = eurlex_get_relations.input.parse({ celex_number: '99999X0000' });
    await expect(eurlex_get_relations.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'not_found' },
    });
  });

  // --- Error contract: no_relations ---

  it('throws ctx.fail("no_relations") when relation query returns empty bindings', async () => {
    const ctx = createMockContext({ errors: eurlex_get_relations.errors });
    mockQuery.mockResolvedValueOnce([makeResolveBinding(GDPR_WORK_URI)]).mockResolvedValueOnce([]); // No relations

    const input = eurlex_get_relations.input.parse({ celex_number: '32016R0679' });
    await expect(eurlex_get_relations.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_relations' },
    });
  });

  // --- Format ---

  it('format groups relations by type and direction, renders CELEX and work URI', () => {
    const output = {
      celex_number: '32016R0679',
      work_uri: GDPR_WORK_URI,
      relations: [
        {
          relation_type: 'amended_by',
          direction: 'incoming',
          related_work_uri: 'http://publications.europa.eu/resource/cellar/amend',
          related_celex_number: '32022R0000',
        },
        {
          relation_type: 'legal_basis',
          direction: 'outgoing',
          related_work_uri: 'http://publications.europa.eu/resource/cellar/basis',
        },
      ],
      total: 2,
    };
    const blocks = eurlex_get_relations.format!(output);
    expect(blocks[0]?.type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('32016R0679');
    expect(text).toContain('32022R0000');
    expect(text).toContain('amended_by');
    expect(text).toContain('legal_basis');
  });
});
