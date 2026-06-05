/**
 * @fileoverview Tests for eurlex://document/{celexNumber}/relations resource.
 * @module tests/resources/eurlex-document-relations.resource.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eurlex_document_relations_resource } from '@/mcp-server/resources/definitions/eurlex-document-relations.resource.js';

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
const CITES_PREDICATE = 'http://publications.europa.eu/ontology/cdm#work_cites_work';

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

describe('eurlex_document_relations_resource', () => {
  beforeEach(() => mockQuery.mockReset());

  // --- Happy path ---

  it('returns relation summary for a valid CELEX number', async () => {
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    mockQuery.mockResolvedValueOnce([makeResolveBinding(GDPR_WORK_URI)]).mockResolvedValueOnce([
      makeRelationBinding({
        relatedWork: 'http://publications.europa.eu/resource/cellar/amend-work',
        relationType: AMENDED_BY_PREDICATE,
        direction: 'incoming',
        relatedCelex: '32022R0000',
      }),
    ]);

    const params = eurlex_document_relations_resource.params.parse({ celexNumber: '32016R0679' });
    const result = await eurlex_document_relations_resource.handler(params, ctx);

    expect((result as Record<string, unknown>).celex_number).toBe('32016R0679');
    expect((result as Record<string, unknown>).work_uri).toBe(GDPR_WORK_URI);
    const relations = (result as Record<string, unknown>).relations as Array<
      Record<string, unknown>
    >;
    expect(relations).toHaveLength(1);
    expect(relations[0]?.relation_type).toBe('amended_by');
    expect(relations[0]?.direction).toBe('incoming');
    expect(relations[0]?.related_celex_number).toBe('32022R0000');
  });

  it('deduplicates identical relation bindings', async () => {
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    mockQuery.mockResolvedValueOnce([makeResolveBinding(GDPR_WORK_URI)]).mockResolvedValueOnce([
      makeRelationBinding({
        relatedWork: 'http://publications.europa.eu/resource/cellar/cited',
        relationType: CITES_PREDICATE,
        direction: 'outgoing',
      }),
      // Duplicate
      makeRelationBinding({
        relatedWork: 'http://publications.europa.eu/resource/cellar/cited',
        relationType: CITES_PREDICATE,
        direction: 'outgoing',
      }),
    ]);

    const params = eurlex_document_relations_resource.params.parse({ celexNumber: '32016R0679' });
    const result = await eurlex_document_relations_resource.handler(params, ctx);

    const relations = (result as Record<string, unknown>).relations as unknown[];
    expect(relations).toHaveLength(1);
  });

  it('returns empty relations array when relation query returns no bindings', async () => {
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    mockQuery.mockResolvedValueOnce([makeResolveBinding(GDPR_WORK_URI)]).mockResolvedValueOnce([]);

    const params = eurlex_document_relations_resource.params.parse({ celexNumber: '32016R0679' });
    const result = await eurlex_document_relations_resource.handler(params, ctx);

    const relations = (result as Record<string, unknown>).relations as unknown[];
    expect(relations).toHaveLength(0);
    expect((result as Record<string, unknown>).total).toBe(0);
  });

  // --- Error path: not found ---

  it('throws notFound when CELEX resolves to no work URI', async () => {
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    mockQuery.mockResolvedValueOnce([]);

    const params = eurlex_document_relations_resource.params.parse({ celexNumber: '99999X0000' });
    await expect(eurlex_document_relations_resource.handler(params, ctx)).rejects.toThrow(
      'No CELLAR work',
    );
  });
});
