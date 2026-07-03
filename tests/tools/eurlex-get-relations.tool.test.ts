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

type Row = Record<string, { type: string; value: string }>;

function makeResolveBinding(workUri: string): Row {
  return { work: { type: 'uri', value: workUri } };
}

/**
 * A relation row as the per-type query projects it: `?relatedWork ?relatedCelex
 * ?direction` — no `?relationType` (the type is known from which query ran).
 */
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

/**
 * Route a mocked `svc.query` call to the resolve step or a per-relation-type
 * query by inspecting the query text. `amends` and `amended_by` share a
 * predicate and differ only by direction, so distinguish them by which side of
 * the triple binds the source work.
 */
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
    // Implicit repeal must be checked before explicit — same shared-predicate,
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

describe('eurlex_get_relations', () => {
  beforeEach(() => mockQuery.mockReset());

  // --- Happy path ---

  it('returns relations across requested types with correct type and direction', async () => {
    const ctx = createMockContext({ errors: eurlex_get_relations.errors });
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
        legalBasis: [
          makeRelationBinding({
            relatedWork: 'http://publications.europa.eu/resource/cellar/basis-work',
            direction: 'outgoing',
          }),
        ],
      }),
    );

    const input = eurlex_get_relations.input.parse({
      celex_number: '32016R0679',
      relation_types: ['amended_by', 'legal_basis'],
    });
    const result = await eurlex_get_relations.handler(input, ctx);

    expect(result.celex_number).toBe('32016R0679');
    expect(result.work_uri).toBe(GDPR_WORK_URI);
    expect(result.total).toBe(2);

    const amendedBy = result.relations.find((r) => r.relation_type === 'amended_by');
    expect(amendedBy?.direction).toBe('incoming');
    expect(amendedBy?.related_celex_number).toBe('32022R0000');

    const legalBasis = result.relations.find((r) => r.relation_type === 'legal_basis');
    expect(legalBasis?.direction).toBe('outgoing');
  });

  // --- #19: amended_by is the INCOMING side of the amends predicate ---

  it('amended_by queries incoming cdm:resource_legal_amends_resource_legal, not the zero-triple predicate', async () => {
    const ctx = createMockContext({ errors: eurlex_get_relations.errors });
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
      }),
    );

    const input = eurlex_get_relations.input.parse({
      celex_number: '32012R0528',
      relation_types: ['amended_by'],
    });
    const result = await eurlex_get_relations.handler(input, ctx);

    expect(result.total).toBe(1);
    expect(result.relations[0]?.relation_type).toBe('amended_by');
    expect(result.relations[0]?.direction).toBe('incoming');
    expect(result.relations[0]?.related_celex_number).toBe('32026R1165');

    // The relation query binds the amender on the incoming side of the *amends*
    // predicate — the dedicated amended_by predicate (zero triples) is gone.
    const relSparql = mockQuery.mock.calls
      .map((c) => c[0] as string)
      .find((q) => !q.includes('SELECT ?work WHERE'))!;
    expect(relSparql).toContain(
      `?relatedWork cdm:resource_legal_amends_resource_legal <${GDPR_WORK_URI}>`,
    );
    expect(relSparql).not.toContain('cdm:resource_legal_amended_by_resource_legal');
  });

  it('amends is outgoing-only — incoming amenders no longer leak under the amends label', async () => {
    const ctx = createMockContext({ errors: eurlex_get_relations.errors });
    mockQuery.mockImplementation(
      routeQuery({
        resolve: [makeResolveBinding(GDPR_WORK_URI)],
        amends: [
          makeRelationBinding({
            relatedWork: 'http://publications.europa.eu/resource/cellar/amended-work',
            direction: 'outgoing',
            relatedCelex: '32007L0047',
          }),
        ],
      }),
    );

    const input = eurlex_get_relations.input.parse({
      celex_number: '32012R0528',
      relation_types: ['amends'],
    });
    const result = await eurlex_get_relations.handler(input, ctx);

    expect(result.total).toBe(1);
    expect(result.relations.every((r) => r.direction === 'outgoing')).toBe(true);

    const relSparql = mockQuery.mock.calls
      .map((c) => c[0] as string)
      .find((q) => !q.includes('SELECT ?work WHERE'))!;
    expect(relSparql).toContain(
      `<${GDPR_WORK_URI}> cdm:resource_legal_amends_resource_legal ?relatedWork`,
    );
    // Outgoing-only: no incoming UNION arm for amends.
    expect(relSparql).not.toContain(
      `?relatedWork cdm:resource_legal_amends_resource_legal <${GDPR_WORK_URI}>`,
    );
  });

  // --- #19: consolidated_version is the INCOMING side of the consolidates predicate ---

  it('consolidated_version queries incoming cdm:act_consolidated_consolidates_resource_legal', async () => {
    const ctx = createMockContext({ errors: eurlex_get_relations.errors });
    mockQuery.mockImplementation(
      routeQuery({
        resolve: [makeResolveBinding(GDPR_WORK_URI)],
        consolidated: [
          makeRelationBinding({
            relatedWork: 'http://publications.europa.eu/resource/cellar/consolidated',
            direction: 'incoming',
            relatedCelex: '02012R0528-20240611',
          }),
        ],
      }),
    );

    const input = eurlex_get_relations.input.parse({
      celex_number: '32012R0528',
      relation_types: ['consolidated_version'],
    });
    const result = await eurlex_get_relations.handler(input, ctx);

    expect(result.total).toBe(1);
    expect(result.relations[0]?.relation_type).toBe('consolidated_version');
    expect(result.relations[0]?.related_celex_number).toBe('02012R0528-20240611');

    const relSparql = mockQuery.mock.calls
      .map((c) => c[0] as string)
      .find((q) => !q.includes('SELECT ?work WHERE'))!;
    expect(relSparql).toContain(
      `?relatedWork cdm:act_consolidated_consolidates_resource_legal <${GDPR_WORK_URI}>`,
    );
    expect(relSparql).not.toContain('cdm:resource_legal_has_consolidated_version');
  });

  // --- #31: repeal relations (explicit + implicit, both directions) ---

  it('repeals is outgoing on cdm:resource_legal_repeals_resource_legal (GDPR → 31995L0046)', async () => {
    const ctx = createMockContext({ errors: eurlex_get_relations.errors });
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
      }),
    );

    const input = eurlex_get_relations.input.parse({
      celex_number: '32016R0679',
      relation_types: ['repeals'],
    });
    const result = await eurlex_get_relations.handler(input, ctx);

    expect(result.total).toBe(1);
    expect(result.relations[0]?.relation_type).toBe('repeals');
    expect(result.relations[0]?.direction).toBe('outgoing');
    expect(result.relations[0]?.related_celex_number).toBe('31995L0046');

    const relSparql = mockQuery.mock.calls
      .map((c) => c[0] as string)
      .find((q) => !q.includes('SELECT ?work WHERE'))!;
    expect(relSparql).toContain(
      `<${GDPR_WORK_URI}> cdm:resource_legal_repeals_resource_legal ?relatedWork`,
    );
    expect(relSparql).not.toContain('cdm:resource_legal_implicitly_repeals_resource_legal');
  });

  it('repealed_by is the incoming side of cdm:resource_legal_repeals_resource_legal', async () => {
    const ctx = createMockContext({ errors: eurlex_get_relations.errors });
    mockQuery.mockImplementation(
      routeQuery({
        resolve: [makeResolveBinding(GDPR_WORK_URI)],
        repealedBy: [
          makeRelationBinding({
            relatedWork: 'http://publications.europa.eu/resource/cellar/repealer',
            direction: 'incoming',
            relatedCelex: '32030R9999',
          }),
        ],
      }),
    );

    const input = eurlex_get_relations.input.parse({
      celex_number: '31995L0046',
      relation_types: ['repealed_by'],
    });
    const result = await eurlex_get_relations.handler(input, ctx);

    expect(result.total).toBe(1);
    expect(result.relations[0]?.relation_type).toBe('repealed_by');
    expect(result.relations[0]?.direction).toBe('incoming');

    const relSparql = mockQuery.mock.calls
      .map((c) => c[0] as string)
      .find((q) => !q.includes('SELECT ?work WHERE'))!;
    expect(relSparql).toContain(
      `?relatedWork cdm:resource_legal_repeals_resource_legal <${GDPR_WORK_URI}>`,
    );
  });

  it('implicitly_repeals is outgoing on the implicit predicate (GDPR → 32003R1882)', async () => {
    const ctx = createMockContext({ errors: eurlex_get_relations.errors });
    mockQuery.mockImplementation(
      routeQuery({
        resolve: [makeResolveBinding(GDPR_WORK_URI)],
        implicitlyRepeals: [
          makeRelationBinding({
            relatedWork: 'http://publications.europa.eu/resource/cellar/implicit-target',
            direction: 'outgoing',
            relatedCelex: '32003R1882',
          }),
        ],
      }),
    );

    const input = eurlex_get_relations.input.parse({
      celex_number: '32016R0679',
      relation_types: ['implicitly_repeals'],
    });
    const result = await eurlex_get_relations.handler(input, ctx);

    expect(result.total).toBe(1);
    expect(result.relations[0]?.relation_type).toBe('implicitly_repeals');
    expect(result.relations[0]?.direction).toBe('outgoing');
    expect(result.relations[0]?.related_celex_number).toBe('32003R1882');

    const relSparql = mockQuery.mock.calls
      .map((c) => c[0] as string)
      .find((q) => !q.includes('SELECT ?work WHERE'))!;
    expect(relSparql).toContain(
      `<${GDPR_WORK_URI}> cdm:resource_legal_implicitly_repeals_resource_legal ?relatedWork`,
    );
  });

  it('implicitly_repealed_by is the incoming side of the implicit predicate', async () => {
    const ctx = createMockContext({ errors: eurlex_get_relations.errors });
    mockQuery.mockImplementation(
      routeQuery({
        resolve: [makeResolveBinding(GDPR_WORK_URI)],
        implicitlyRepealedBy: [
          makeRelationBinding({
            relatedWork: 'http://publications.europa.eu/resource/cellar/implicit-repealer',
            direction: 'incoming',
          }),
        ],
      }),
    );

    const input = eurlex_get_relations.input.parse({
      celex_number: '32016R0679',
      relation_types: ['implicitly_repealed_by'],
    });
    const result = await eurlex_get_relations.handler(input, ctx);

    expect(result.total).toBe(1);
    expect(result.relations[0]?.relation_type).toBe('implicitly_repealed_by');
    expect(result.relations[0]?.direction).toBe('incoming');

    const relSparql = mockQuery.mock.calls
      .map((c) => c[0] as string)
      .find((q) => !q.includes('SELECT ?work WHERE'))!;
    expect(relSparql).toContain(
      `?relatedWork cdm:resource_legal_implicitly_repeals_resource_legal <${GDPR_WORK_URI}>`,
    );
  });

  // --- #32: consolidated_version is filtered to genuine consolidations of the source act ---

  it('consolidated_version drops CELEX-less and cross-act rows when the source CELEX is known', async () => {
    const ctx = createMockContext({ errors: eurlex_get_relations.errors });
    mockQuery.mockImplementation(
      routeQuery({
        resolve: [makeResolveBinding(GDPR_WORK_URI)],
        // Mirrors the live CELLAR shape for GDPR: one genuine consolidation, one
        // cross-act consolidation of the repealed 1995 directive, one CELEX-less
        // CONS_TEXT member work.
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

    const input = eurlex_get_relations.input.parse({
      celex_number: '32016R0679',
      relation_types: ['consolidated_version'],
    });
    const result = await eurlex_get_relations.handler(input, ctx);

    expect(result.total).toBe(1);
    expect(result.relations[0]?.related_celex_number).toBe('02016R0679-20160504');
    expect(result.relations.map((r) => r.related_celex_number)).not.toContain(
      '01995L0046-20180525',
    );
  });

  it('consolidated_version keeps every genuine same-act consolidation', async () => {
    const ctx = createMockContext({ errors: eurlex_get_relations.errors });
    mockQuery.mockImplementation(
      routeQuery({
        resolve: [makeResolveBinding(GDPR_WORK_URI)],
        consolidated: [
          makeRelationBinding({
            relatedWork: 'http://publications.europa.eu/resource/cellar/cons-1',
            direction: 'incoming',
            relatedCelex: '02016R0679-20160504',
          }),
          makeRelationBinding({
            relatedWork: 'http://publications.europa.eu/resource/cellar/cons-2',
            direction: 'incoming',
            relatedCelex: '02016R0679-20250101',
          }),
        ],
      }),
    );

    const input = eurlex_get_relations.input.parse({
      celex_number: '32016R0679',
      relation_types: ['consolidated_version'],
    });
    const result = await eurlex_get_relations.handler(input, ctx);

    expect(result.total).toBe(2);
    expect(result.relations.map((r) => r.related_celex_number).sort()).toEqual([
      '02016R0679-20160504',
      '02016R0679-20250101',
    ]);
  });

  it('consolidated_version on the work_uri path keeps CELEX-bearing rows (cross-act included) and drops only CELEX-less', async () => {
    const ctx = createMockContext({ errors: eurlex_get_relations.errors });
    // work_uri-only: no source CELEX to match against, so the act-number filter
    // is skipped — only the CELEX-less drop applies.
    mockQuery.mockImplementation(
      routeQuery({
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

    const input = eurlex_get_relations.input.parse({
      work_uri: GDPR_WORK_URI,
      relation_types: ['consolidated_version'],
    });
    const result = await eurlex_get_relations.handler(input, ctx);

    expect(result.total).toBe(2);
    expect(result.relations.map((r) => r.related_celex_number).sort()).toEqual([
      '01995L0046-20180525',
      '02016R0679-20160504',
    ]);
  });

  it('the consolidated_version filter leaves other relation types untouched (CELEX-less amended_by survives)', async () => {
    const ctx = createMockContext({ errors: eurlex_get_relations.errors });
    mockQuery.mockImplementation(
      routeQuery({
        resolve: [makeResolveBinding(GDPR_WORK_URI)],
        amendedBy: [
          makeRelationBinding({
            relatedWork: 'http://publications.europa.eu/resource/cellar/celex-less-amender',
            direction: 'incoming',
          }),
        ],
        consolidated: [
          makeRelationBinding({
            relatedWork:
              'http://publications.europa.eu/resource/cellar/69c567aa-0ce3-4ba7-b13d-7142a9225a3c',
            direction: 'incoming',
          }),
        ],
      }),
    );

    const input = eurlex_get_relations.input.parse({
      celex_number: '32016R0679',
      relation_types: ['amended_by', 'consolidated_version'],
    });
    const result = await eurlex_get_relations.handler(input, ctx);

    // The CELEX-less consolidated row is dropped; the CELEX-less amended_by row is not.
    expect(result.relations.map((r) => r.relation_type)).toEqual(['amended_by']);
  });

  it('cites traverses both directions (citation graph is symmetric)', async () => {
    const ctx = createMockContext({ errors: eurlex_get_relations.errors });
    mockQuery.mockImplementation(
      routeQuery({
        resolve: [makeResolveBinding(GDPR_WORK_URI)],
        cites: [
          makeRelationBinding({
            relatedWork: 'http://publications.europa.eu/resource/cellar/cited',
            direction: 'outgoing',
          }),
          makeRelationBinding({
            relatedWork: 'http://publications.europa.eu/resource/cellar/citer',
            direction: 'incoming',
          }),
        ],
      }),
    );

    const input = eurlex_get_relations.input.parse({
      celex_number: '32016R0679',
      relation_types: ['cites'],
    });
    const result = await eurlex_get_relations.handler(input, ctx);

    expect(result.total).toBe(2);
    const directions = new Set(result.relations.map((r) => r.direction));
    expect(directions).toEqual(new Set(['outgoing', 'incoming']));

    const relSparql = mockQuery.mock.calls
      .map((c) => c[0] as string)
      .find((q) => !q.includes('SELECT ?work WHERE'))!;
    expect(relSparql).toContain(`<${GDPR_WORK_URI}> cdm:work_cites_work ?relatedWork`);
    expect(relSparql).toContain(`?relatedWork cdm:work_cites_work <${GDPR_WORK_URI}>`);
  });

  // --- #19: per-type queries so high-volume types don't starve rarer ones ---

  it('queries each requested type independently so a dense type cannot starve a sparse one', async () => {
    const ctx = createMockContext({ errors: eurlex_get_relations.errors });
    const manyCites = Array.from({ length: 100 }, (_, i) =>
      makeRelationBinding({
        relatedWork: `http://publications.europa.eu/resource/cellar/cited-${i}`,
        direction: 'incoming',
      }),
    );
    mockQuery.mockImplementation(
      routeQuery({
        resolve: [makeResolveBinding(GDPR_WORK_URI)],
        cites: manyCites,
        legalBasis: [
          makeRelationBinding({
            relatedWork: 'http://publications.europa.eu/resource/cellar/tfeu-16',
            direction: 'outgoing',
            relatedCelex: '12016E016',
          }),
        ],
      }),
    );

    const input = eurlex_get_relations.input.parse({
      celex_number: '32016R0679',
      relation_types: ['cites', 'legal_basis'],
    });
    const result = await eurlex_get_relations.handler(input, ctx);

    // The single legal_basis row survives alongside 100 cites — separate caps.
    expect(result.relations.some((r) => r.relation_type === 'legal_basis')).toBe(true);
    expect(result.relations.filter((r) => r.relation_type === 'cites')).toHaveLength(100);

    // Resolve + one query per requested type (no shared UNION).
    expect(mockQuery).toHaveBeenCalledTimes(3);
  });

  it('deduplicates identical relation rows within a type', async () => {
    const ctx = createMockContext({ errors: eurlex_get_relations.errors });
    mockQuery.mockImplementation(
      routeQuery({
        resolve: [makeResolveBinding(GDPR_WORK_URI)],
        amends: [
          makeRelationBinding({
            relatedWork: 'http://publications.europa.eu/resource/cellar/some-work',
            direction: 'outgoing',
          }),
          makeRelationBinding({
            relatedWork: 'http://publications.europa.eu/resource/cellar/some-work',
            direction: 'outgoing',
          }),
        ],
      }),
    );

    const input = eurlex_get_relations.input.parse({
      celex_number: '32016R0679',
      relation_types: ['amends'],
    });
    const result = await eurlex_get_relations.handler(input, ctx);

    expect(result.total).toBe(1);
  });

  it('filters to requested relation_types only', async () => {
    const ctx = createMockContext({ errors: eurlex_get_relations.errors });
    mockQuery.mockImplementation(
      routeQuery({
        resolve: [makeResolveBinding(GDPR_WORK_URI)],
        legalBasis: [
          makeRelationBinding({
            relatedWork: 'http://publications.europa.eu/resource/cellar/lb-work',
            direction: 'outgoing',
          }),
        ],
      }),
    );

    const input = eurlex_get_relations.input.parse({
      celex_number: '32016R0679',
      relation_types: ['legal_basis'],
    });
    await eurlex_get_relations.handler(input, ctx);

    // Only the legal_basis predicate is queried — no cites, no amends.
    const relCalls = mockQuery.mock.calls
      .map((c) => c[0] as string)
      .filter((q) => !q.includes('SELECT ?work WHERE'));
    expect(relCalls).toHaveLength(1);
    expect(relCalls[0]).toContain('cdm:resource_legal_based_on_resource_legal');
    expect(relCalls[0]).not.toContain('cdm:work_cites_work');
  });

  // --- work_uri alternative (issue #8) ---

  it('uses work_uri directly and skips the CELEX→work resolution', async () => {
    const ctx = createMockContext({ errors: eurlex_get_relations.errors });
    mockQuery.mockImplementation(
      routeQuery({
        amendedBy: [
          makeRelationBinding({
            relatedWork: 'http://publications.europa.eu/resource/cellar/amend-work',
            direction: 'incoming',
            relatedCelex: '32022R0000',
          }),
        ],
      }),
    );

    const input = eurlex_get_relations.input.parse({
      work_uri: GDPR_WORK_URI,
      relation_types: ['amended_by'],
    });
    const result = await eurlex_get_relations.handler(input, ctx);

    expect(result.work_uri).toBe(GDPR_WORK_URI);
    expect(result.celex_number).toBeUndefined();
    expect(result.total).toBe(1);
    expect(result.relations[0]?.relation_type).toBe('amended_by');

    // Single query: the per-type traversal binds <work_uri> directly — no resolve.
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const relSparql = mockQuery.mock.calls[0]?.[0] as string;
    expect(relSparql).toContain(`<${GDPR_WORK_URI}>`);
    expect(relSparql).not.toContain('SELECT ?work WHERE');
  });

  // --- Input guard: exactly one identifier (issue #8) ---

  it('throws ctx.fail("invalid_identifier_args") when neither celex_number nor work_uri is given', async () => {
    const ctx = createMockContext({ errors: eurlex_get_relations.errors });
    const input = eurlex_get_relations.input.parse({});
    await expect(eurlex_get_relations.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_identifier_args' },
    });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('throws ctx.fail("invalid_identifier_args") when both celex_number and work_uri are given', async () => {
    const ctx = createMockContext({ errors: eurlex_get_relations.errors });
    const input = eurlex_get_relations.input.parse({
      celex_number: '32016R0679',
      work_uri: GDPR_WORK_URI,
    });
    await expect(eurlex_get_relations.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_identifier_args' },
    });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('treats work_uri:"" as absent and routes to celex_number path (form-client regression)', async () => {
    const ctx = createMockContext({ errors: eurlex_get_relations.errors });
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

    const input = eurlex_get_relations.input.parse({
      celex_number: '32016R0679',
      work_uri: '',
      relation_types: ['amended_by'],
    });
    const result = await eurlex_get_relations.handler(input, ctx);

    expect(result.celex_number).toBe('32016R0679');
    expect(result.work_uri).toBe(GDPR_WORK_URI);
    expect(result.total).toBe(1);
    // CELEX resolve fired (call 0) + one relation query — work_uri:"" treated as absent.
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  // --- Error contract: not_found ---

  it('throws ctx.fail("not_found") when CELEX resolves to no work URI', async () => {
    const ctx = createMockContext({ errors: eurlex_get_relations.errors });
    mockQuery.mockImplementation(routeQuery({ resolve: [] }));

    const input = eurlex_get_relations.input.parse({ celex_number: '99999X0000' });
    await expect(eurlex_get_relations.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'not_found' },
    });
  });

  // --- Error contract: no_relations ---

  it('throws ctx.fail("no_relations") when every relation query returns empty', async () => {
    const ctx = createMockContext({ errors: eurlex_get_relations.errors });
    // resolve succeeds; all per-type queries return [].
    mockQuery.mockImplementation(routeQuery({ resolve: [makeResolveBinding(GDPR_WORK_URI)] }));

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
