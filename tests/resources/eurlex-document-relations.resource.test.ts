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

type Row = Record<string, { type: string; value: string }>;

function makeResolveBinding(workUri: string): Row {
  return { work: { type: 'uri', value: workUri } };
}

function makeRelationBinding(opts: {
  relatedWork: string;
  direction: 'outgoing' | 'incoming';
  relatedCelex?: string;
}): Row {
  const b: Row = {
    relatedWork: { type: 'uri', value: opts.relatedWork },
    direction: { type: 'literal', value: opts.direction },
  };
  if (opts.relatedCelex) b.relatedCelex = { type: 'literal', value: opts.relatedCelex };
  return b;
}

/** Route a mocked `svc.query` call to the resolve step or a per-type relation query. */
function routeQuery(handlers: {
  resolve?: Row[];
  cites?: Row[];
  amends?: Row[];
  amendedBy?: Row[];
  repeals?: Row[];
  repealedBy?: Row[];
  implicitlyRepeals?: Row[];
  implicitlyRepealedBy?: Row[];
  legalBasis?: Row[];
  consolidated?: Row[];
}) {
  return async (q: string): Promise<Row[]> => {
    // Tolerate any unrecognized call shape (e.g. a stray no-arg call from the
    // test harness's async cleanup) — an unmatched query yields no rows.
    if (typeof q !== 'string') return [];
    if (q.includes('SELECT ?work WHERE')) return handlers.resolve ?? [];
    if (q.includes('cdm:work_cites_work')) return handlers.cites ?? [];
    if (q.includes('cdm:act_consolidated_consolidates_resource_legal'))
      return handlers.consolidated ?? [];
    if (q.includes('cdm:resource_legal_based_on_resource_legal')) return handlers.legalBasis ?? [];
    // Implicit repeal is checked before explicit — same shared-predicate,
    // direction-by-triple-side pattern as amends/amended_by.
    if (q.includes('cdm:resource_legal_implicitly_repeals_resource_legal')) {
      return q.includes('?relatedWork cdm:resource_legal_implicitly_repeals_resource_legal <')
        ? (handlers.implicitlyRepealedBy ?? [])
        : (handlers.implicitlyRepeals ?? []);
    }
    if (q.includes('cdm:resource_legal_repeals_resource_legal')) {
      return q.includes('?relatedWork cdm:resource_legal_repeals_resource_legal <')
        ? (handlers.repealedBy ?? [])
        : (handlers.repeals ?? []);
    }
    if (q.includes('cdm:resource_legal_amends_resource_legal')) {
      return q.includes('?relatedWork cdm:resource_legal_amends_resource_legal <')
        ? (handlers.amendedBy ?? [])
        : (handlers.amends ?? []);
    }
    return [];
  };
}

describe('eurlex_document_relations_resource', () => {
  beforeEach(() => mockQuery.mockReset());

  // --- Happy path ---

  it('returns relation summary for a valid CELEX number', async () => {
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    mockQuery.mockImplementation(
      routeQuery({
        resolve: [makeResolveBinding(GDPR_WORK_URI)],
        amendedBy: [
          makeRelationBinding({
            relatedWork: 'http://publications.europa.eu/resource/cellar/amend-work',
            direction: 'incoming',
            relatedCelex: '32022R0000',
          }),
        ],
      }),
    );

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

  // --- #19: amendment + consolidation relations now surface on the resource ---

  it('surfaces amended_by and consolidated_version (previously zero-triple predicates)', async () => {
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    mockQuery.mockImplementation(
      routeQuery({
        resolve: [makeResolveBinding(GDPR_WORK_URI)],
        amendedBy: [
          makeRelationBinding({
            relatedWork: 'http://publications.europa.eu/resource/cellar/amender',
            direction: 'incoming',
            relatedCelex: '32026R1165',
          }),
        ],
        consolidated: [
          makeRelationBinding({
            relatedWork: 'http://publications.europa.eu/resource/cellar/consolidated',
            direction: 'incoming',
            relatedCelex: '02012R0528-20240611',
          }),
        ],
      }),
    );

    const params = eurlex_document_relations_resource.params.parse({ celexNumber: '32012R0528' });
    const result = await eurlex_document_relations_resource.handler(params, ctx);

    const relations = (result as Record<string, unknown>).relations as Array<
      Record<string, unknown>
    >;
    const types = relations.map((r) => r.relation_type);
    expect(types).toContain('amended_by');
    expect(types).toContain('consolidated_version');
  });

  // --- #31: repeal relations surface through the resource's shared traversal ---

  it('surfaces repeals and implicitly_repeals (GDPR → 31995L0046, 32003R1882)', async () => {
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    mockQuery.mockImplementation(
      routeQuery({
        resolve: [makeResolveBinding(GDPR_WORK_URI)],
        repeals: [
          makeRelationBinding({
            relatedWork: 'http://publications.europa.eu/resource/cellar/dp-directive',
            direction: 'outgoing',
            relatedCelex: '31995L0046',
          }),
        ],
        implicitlyRepeals: [
          makeRelationBinding({
            relatedWork: 'http://publications.europa.eu/resource/cellar/implicit-target',
            direction: 'outgoing',
            relatedCelex: '32003R1882',
          }),
        ],
      }),
    );

    const params = eurlex_document_relations_resource.params.parse({ celexNumber: '32016R0679' });
    const result = await eurlex_document_relations_resource.handler(params, ctx);

    const relations = (result as Record<string, unknown>).relations as Array<
      Record<string, unknown>
    >;
    const repeals = relations.find((r) => r.relation_type === 'repeals');
    expect(repeals?.direction).toBe('outgoing');
    expect(repeals?.related_celex_number).toBe('31995L0046');
    const implicit = relations.find((r) => r.relation_type === 'implicitly_repeals');
    expect(implicit?.related_celex_number).toBe('32003R1882');
  });

  // --- #32: the resource inherits the consolidated_version act-number filter ---

  it('filters consolidated_version to the genuine same-act consolidation (drops cross-act + CELEX-less)', async () => {
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    mockQuery.mockImplementation(
      routeQuery({
        resolve: [makeResolveBinding(GDPR_WORK_URI)],
        consolidated: [
          makeRelationBinding({
            relatedWork: 'http://publications.europa.eu/resource/cellar/genuine',
            direction: 'incoming',
            relatedCelex: '02016R0679-20160504',
          }),
          makeRelationBinding({
            relatedWork: 'http://publications.europa.eu/resource/cellar/cross-act',
            direction: 'incoming',
            relatedCelex: '01995L0046-20180525',
          }),
          makeRelationBinding({
            relatedWork:
              'http://publications.europa.eu/resource/cellar/69c567aa-0ce3-4ba7-b13d-7142a9225a3c',
            direction: 'incoming',
          }),
        ],
      }),
    );

    const params = eurlex_document_relations_resource.params.parse({ celexNumber: '32016R0679' });
    const result = await eurlex_document_relations_resource.handler(params, ctx);

    const relations = (result as Record<string, unknown>).relations as Array<
      Record<string, unknown>
    >;
    const consolidated = relations.filter((r) => r.relation_type === 'consolidated_version');
    expect(consolidated).toHaveLength(1);
    expect(consolidated[0]?.related_celex_number).toBe('02016R0679-20160504');
  });

  it('deduplicates identical relation rows', async () => {
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    mockQuery.mockImplementation(
      routeQuery({
        resolve: [makeResolveBinding(GDPR_WORK_URI)],
        cites: [
          makeRelationBinding({
            relatedWork: 'http://publications.europa.eu/resource/cellar/cited',
            direction: 'outgoing',
          }),
          makeRelationBinding({
            relatedWork: 'http://publications.europa.eu/resource/cellar/cited',
            direction: 'outgoing',
          }),
        ],
      }),
    );

    const params = eurlex_document_relations_resource.params.parse({ celexNumber: '32016R0679' });
    const result = await eurlex_document_relations_resource.handler(params, ctx);

    const relations = (result as Record<string, unknown>).relations as unknown[];
    expect(relations).toHaveLength(1);
  });

  it('returns empty relations array when every relation query returns no bindings', async () => {
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    mockQuery.mockImplementation(routeQuery({ resolve: [makeResolveBinding(GDPR_WORK_URI)] }));

    const params = eurlex_document_relations_resource.params.parse({ celexNumber: '32016R0679' });
    const result = await eurlex_document_relations_resource.handler(params, ctx);

    const relations = (result as Record<string, unknown>).relations as unknown[];
    expect(relations).toHaveLength(0);
    expect((result as Record<string, unknown>).total).toBe(0);
  });

  // --- Error path: not found ---

  it('throws notFound when CELEX resolves to no work URI', async () => {
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    mockQuery.mockImplementation(routeQuery({ resolve: [] }));

    const params = eurlex_document_relations_resource.params.parse({ celexNumber: '99999X0000' });
    await expect(eurlex_document_relations_resource.handler(params, ctx)).rejects.toThrow(
      'No CELLAR work',
    );
  });
});
