/**
 * @fileoverview Tests for eurlex_get_relations tool.
 * @module tests/tools/eurlex-get-relations.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eurlex_get_relations } from '@/mcp-server/tools/definitions/eurlex-get-relations.tool.js';
import { RELATION_TYPES } from '@/services/cellar-sparql/relation-traversal.js';
import {
  CELLAR,
  canonicalWork,
  celexWorkRows,
  isResolutionQuery,
  requestedCelex,
} from '../fixtures/cellar-works.js';

// --- Service mock ---
const mockQuery = vi.fn();
let mockMaxResults = 100;
// maxResults mirrors the real service ceiling (MAX_SPARQL_RESULTS); the handler
// clamps the per-direction cap to it.
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

const GDPR_WORK_URI =
  'http://publications.europa.eu/resource/cellar/3e485e15-d3d0-11e5-8cd4-01aa75ed71a1';
const DIRECTIVE_680_WORK_URI = 'http://publications.europa.eu/resource/cellar/directive-2016-680';
const CZECH_MEASURE_WORK_URI =
  'http://publications.europa.eu/resource/cellar/002d2e00-f978-11e4-a4c8-01aa75ed71a1';
const HUNGARIAN_MEASURE_WORK_URI =
  'http://publications.europa.eu/resource/cellar/7e87af3f-cf5d-4ac3-adc9-11e28cc1b196';

type Row = Record<string, { type: string; value: string }>;

function makeResolveBinding(workUri: string): Row {
  return { work: { type: 'uri', value: workUri } };
}

/** The resolve rows, each stamped with the CELEX the resolution query asked for. */
function resolveRowsFor(q: string, rows: Row[] = []): Row[] {
  const [celex = ''] = requestedCelex(q);
  return rows.map((row) => ({ celexNumber: { type: 'literal', value: celex }, ...row }));
}

function makeSourceCelexBinding(celex: string): Row {
  return { sourceCelex: { type: 'literal', value: celex } };
}

/**
 * A relation row as the per-type query projects it: `?relatedWork
 * (SAMPLE(?relatedCelex) AS ?relatedCelexSample) ?direction (MAX(STR(?relatedDate)) AS
 * ?relatedDateMax)` — no `?relationType` (the type is known from which query ran).
 * The CELEX therefore arrives under the aggregate alias `?relatedCelexSample`, the
 * only key the traversal reads.
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
  if (opts.relatedCelex) b.relatedCelexSample = { type: 'literal', value: opts.relatedCelex };
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
  sourceCelex?: Row[];
  cites?: Row[];
  amends?: Row[];
  amendedBy?: Row[];
  repeals?: Row[];
  repealedBy?: Row[];
  implicitlyRepeals?: Row[];
  implicitlyRepealedBy?: Row[];
  legalBasis?: Row[];
  consolidated?: Row[];
  nationalTransposition?: Row[];
}) {
  return async (q: string): Promise<Row[]> => {
    // Tolerate any unrecognized call shape (e.g. a stray no-arg call from the
    // test harness's async cleanup) — an unmatched query yields no rows.
    if (typeof q !== 'string') return [];
    if (isResolutionQuery(q)) return resolveRowsFor(q, handlers.resolve);
    if (q.includes('SELECT ?sourceCelex WHERE')) return handlers.sourceCelex ?? [];
    if (q.includes('cdm:work_cites_work')) return handlers.cites ?? [];
    if (q.includes('cdm:act_consolidated_based_on_resource_legal'))
      return handlers.consolidated ?? [];
    if (q.includes('cdm:measure_national_implementing_implements_resource_legal'))
      return handlers.nationalTransposition ?? [];
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

/** Every text block of a tool result's content[], joined. */
function contentText(result: { content: unknown[] }): string {
  return result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
}

describe('eurlex_get_relations', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockMaxResults = 100;
  });

  it('rejects pagination values outside the public boundary', () => {
    expect(() =>
      eurlex_get_relations.input.parse({ celex_number: '32016R0679', limit: 101 }),
    ).toThrow();
    expect(() =>
      eurlex_get_relations.input.parse({ celex_number: '32016R0679', offset: -1 }),
    ).toThrow();
  });

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
      .find((q) => !isResolutionQuery(q))!;
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
      .find((q) => !isResolutionQuery(q))!;
    expect(relSparql).toContain(
      `<${GDPR_WORK_URI}> cdm:resource_legal_amends_resource_legal ?relatedWork`,
    );
    // Outgoing-only: no incoming UNION arm for amends.
    expect(relSparql).not.toContain(
      `?relatedWork cdm:resource_legal_amends_resource_legal <${GDPR_WORK_URI}>`,
    );
  });

  // --- #19/#109: consolidated_version is the INCOMING side of the based-on link ---

  it('consolidated_version queries incoming cdm:act_consolidated_based_on_resource_legal', async () => {
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
      .find((q) => !isResolutionQuery(q))!;
    expect(relSparql).toContain(
      `?relatedWork cdm:act_consolidated_based_on_resource_legal <${GDPR_WORK_URI}>`,
    );
    expect(relSparql).not.toContain('cdm:resource_legal_has_consolidated_version');
    expect(relSparql).not.toContain('act_consolidated_consolidates');
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
      .find((q) => !isResolutionQuery(q))!;
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
      .find((q) => !isResolutionQuery(q))!;
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
      .find((q) => !isResolutionQuery(q))!;
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
      .find((q) => !isResolutionQuery(q))!;
    expect(relSparql).toContain(
      `?relatedWork cdm:resource_legal_implicitly_repeals_resource_legal <${GDPR_WORK_URI}>`,
    );
  });

  // --- #32: consolidated_version keeps only fetchable (CELEX-bearing) consolidations ---

  it('consolidated_version drops CELEX-less rows', async () => {
    const ctx = createMockContext({ errors: eurlex_get_relations.errors });
    mockQuery.mockImplementation(
      routeQuery({
        resolve: [makeResolveBinding(GDPR_WORK_URI)],
        // One consolidation and one CELEX-less CONS_TEXT member work.
        consolidated: [
          makeRelationBinding({
            relatedWork: 'http://publications.europa.eu/resource/cellar/genuine',
            direction: 'incoming',
            relatedCelex: '02016R0679-20160504',
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

  it('follows the based-on link on the work_uri path without resolving source identity (#73, #109)', async () => {
    const ctx = createMockContext({ errors: eurlex_get_relations.errors });
    mockQuery.mockImplementation(
      routeQuery({
        sourceCelex: [makeSourceCelexBinding('32016R0679')],
        consolidated: [
          makeRelationBinding({
            relatedWork: 'http://publications.europa.eu/resource/cellar/genuine',
            direction: 'incoming',
            relatedCelex: '02016R0679-20160504',
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

    expect(result.total).toBe(1);
    expect(result.relations.map((r) => r.related_celex_number)).toEqual(['02016R0679-20160504']);

    const queries = mockQuery.mock.calls.map((call) => call[0] as string);
    // The link is specific to this act, so no CELEX identity is needed to filter it.
    expect(queries).not.toContainEqual(expect.stringContaining('SELECT ?sourceCelex WHERE'));
    const traversalSparql = queries.find((query) =>
      query.includes('cdm:act_consolidated_based_on_resource_legal'),
    )!;
    expect(traversalSparql).toContain(
      `?relatedWork cdm:act_consolidated_based_on_resource_legal <${GDPR_WORK_URI}>`,
    );
    expect(traversalSparql).not.toContain('REGEX');
  });

  // --- #56: national transposition measures ---

  it('returns the directive-matching Czech national transposition in both output channels (#56)', async () => {
    const ctx = createMockContext({ errors: eurlex_get_relations.errors });
    mockQuery.mockImplementation(
      routeQuery({
        resolve: [makeResolveBinding(DIRECTIVE_680_WORK_URI)],
        nationalTransposition: [
          makeRelationBinding({
            relatedWork: CZECH_MEASURE_WORK_URI,
            direction: 'incoming',
            relatedCelex: '72016L0680CZE_225030',
          }),
        ],
      }),
    );

    const input = eurlex_get_relations.input.parse({
      celex_number: '32016L0680',
      relation_types: ['national_transposition'],
    });
    const result = await eurlex_get_relations.handler(input, ctx);

    expect(result.relations).toEqual([
      {
        relation_type: 'national_transposition',
        direction: 'incoming',
        related_work_uri: CZECH_MEASURE_WORK_URI,
        related_celex_number: '72016L0680CZE_225030',
        related_member_state: 'CZE',
      },
    ]);
    expect(result.requested_relation_types).toEqual(['national_transposition']);
    expect(result.empty_relation_types).toEqual([]);

    const sparql = mockQuery.mock.calls
      .map((call) => call[0] as string)
      .find((query) =>
        query.includes('cdm:measure_national_implementing_implements_resource_legal'),
      )!;
    expect(sparql).toContain(
      `?relatedWork cdm:measure_national_implementing_implements_resource_legal <${DIRECTIVE_680_WORK_URI}>`,
    );
    expect(sparql).toContain('?relatedWork cdm:resource_legal_id_celex ?relatedCelex .');
    expect(sparql).toContain('REGEX(STR(?relatedCelex), "^72016L0680[A-Z]{3}")');
    expect(sparql.indexOf('REGEX')).toBeLessThan(sparql.indexOf('LIMIT'));

    const text = (eurlex_get_relations.format!(result)[0] as { text: string }).text;
    expect(text).toContain('national_transposition (incoming)');
    expect(text).toContain('72016L0680CZE_225030');
    expect(text).toContain(CZECH_MEASURE_WORK_URI);
  });

  it('returns equivalent national transposition relations for CELEX and work_uri inputs (#56, #73)', async () => {
    const ctx = createMockContext({ errors: eurlex_get_relations.errors });
    mockQuery.mockImplementation(
      routeQuery({
        resolve: [makeResolveBinding(DIRECTIVE_680_WORK_URI)],
        sourceCelex: [makeSourceCelexBinding('32016L0680')],
        nationalTransposition: [
          makeRelationBinding({
            relatedWork: CZECH_MEASURE_WORK_URI,
            direction: 'incoming',
            relatedCelex: '72016L0680CZE_225030',
          }),
        ],
      }),
    );

    const byCelex = await eurlex_get_relations.handler(
      eurlex_get_relations.input.parse({
        celex_number: '32016L0680',
        relation_types: ['national_transposition'],
      }),
      ctx,
    );
    const byWorkUri = await eurlex_get_relations.handler(
      eurlex_get_relations.input.parse({
        work_uri: DIRECTIVE_680_WORK_URI,
        relation_types: ['national_transposition'],
      }),
      ctx,
    );

    expect(byWorkUri.relations).toEqual(byCelex.relations);
    expect(
      mockQuery.mock.calls.some((call) =>
        (call[0] as string).includes('SELECT ?sourceCelex WHERE'),
      ),
    ).toBe(true);
  });

  it('drops a non-matching CELEX row client-side and pages the grouped query (#56)', async () => {
    const ctx = createMockContext({ errors: eurlex_get_relations.errors });
    mockQuery.mockImplementation(
      routeQuery({
        resolve: [makeResolveBinding(DIRECTIVE_680_WORK_URI)],
        nationalTransposition: [
          makeRelationBinding({
            relatedWork: HUNGARIAN_MEASURE_WORK_URI,
            direction: 'incoming',
            relatedCelex: '72016L0666HUN_194829',
          }),
          makeRelationBinding({
            relatedWork: HUNGARIAN_MEASURE_WORK_URI,
            direction: 'incoming',
            relatedCelex: '72016L0680HUN_194829',
          }),
          makeRelationBinding({
            relatedWork: HUNGARIAN_MEASURE_WORK_URI,
            direction: 'incoming',
            relatedCelex: '72016L0680HUN_194829',
          }),
        ],
      }),
    );

    const result = await eurlex_get_relations.handler(
      eurlex_get_relations.input.parse({
        celex_number: '32016L0680',
        relation_types: ['national_transposition'],
        offset: 10,
        limit: 10,
      }),
      ctx,
    );

    expect(result.relations).toEqual([
      {
        relation_type: 'national_transposition',
        direction: 'incoming',
        related_work_uri: HUNGARIAN_MEASURE_WORK_URI,
        related_celex_number: '72016L0680HUN_194829',
        related_member_state: 'HUN',
      },
    ]);
    const sparql = mockQuery.mock.calls
      .map((call) => call[0] as string)
      .find((query) =>
        query.includes('cdm:measure_national_implementing_implements_resource_legal'),
      )!;
    expect(sparql).toContain('GROUP BY ?relatedWork ?direction');
    expect(sparql).toContain('LIMIT 11');
    expect(sparql).toContain('OFFSET 10');
  });

  it('proves national transposition continuation without exposing its sentinel row (#56)', async () => {
    const ctx = createMockContext({ errors: eurlex_get_relations.errors });
    mockQuery.mockImplementation(
      routeQuery({
        resolve: [makeResolveBinding(DIRECTIVE_680_WORK_URI)],
        nationalTransposition: Array.from({ length: 3 }, (_, index) =>
          makeRelationBinding({
            relatedWork: `http://publications.europa.eu/resource/cellar/measure-${index}`,
            direction: 'incoming',
            relatedCelex: `72016L0680CZE_${225030 + index}`,
          }),
        ),
      }),
    );

    const result = await eurlex_get_relations.handler(
      eurlex_get_relations.input.parse({
        celex_number: '32016L0680',
        relation_types: ['national_transposition'],
        limit: 2,
      }),
      ctx,
    );

    expect(result.relations).toHaveLength(2);
    expect(result.has_more).toBe(true);
    expect(result.next_offset).toBe(2);
    expect(result.relations.map((relation) => relation.related_work_uri)).not.toContain(
      'http://publications.europa.eu/resource/cellar/measure-2',
    );
    expect(getEnrichment(ctx)).toMatchObject({ truncated: true, shown: 2, cap: 2 });
  });

  it('returns an empty national transposition first page with a widening notice (#56, #112)', async () => {
    const ctx = createMockContext({ errors: eurlex_get_relations.errors });
    mockQuery.mockImplementation(
      routeQuery({ resolve: [makeResolveBinding(DIRECTIVE_680_WORK_URI)] }),
    );

    const result = await eurlex_get_relations.handler(
      eurlex_get_relations.input.parse({
        celex_number: '32016L0680',
        relation_types: ['national_transposition'],
      }),
      ctx,
    );

    expect(result).toMatchObject({
      relations: [],
      total: 0,
      offset: 0,
      has_more: false,
      empty_relation_types: ['national_transposition'],
    });
    expect(getEnrichment(ctx).notice).toContain(
      'Try other relation_types or omit the filter to fetch all available relation types.',
    );
  });

  it('returns an exhausted national transposition page with exact empty-type state (#56)', async () => {
    const ctx = createMockContext({ errors: eurlex_get_relations.errors });
    mockQuery.mockImplementation(
      routeQuery({ resolve: [makeResolveBinding(DIRECTIVE_680_WORK_URI)] }),
    );

    const result = await eurlex_get_relations.handler(
      eurlex_get_relations.input.parse({
        celex_number: '32016L0680',
        relation_types: ['national_transposition'],
        offset: 20,
        limit: 10,
      }),
      ctx,
    );

    expect(result.relations).toEqual([]);
    expect(result.has_more).toBe(false);
    expect(result.next_offset).toBeUndefined();
    expect(result.requested_relation_types).toEqual(['national_transposition']);
    expect(result.empty_relation_types).toEqual(['national_transposition']);
  });

  it('rejects invalid national transposition pagination at the schema boundary (#56)', () => {
    expect(() =>
      eurlex_get_relations.input.parse({
        celex_number: '32016L0680',
        relation_types: ['national_transposition'],
        limit: 0,
      }),
    ).toThrow();
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

  // --- #45: consolidated_version truncation reflects post-filter rows; filter pushed to SPARQL ---

  it('pushes the consolidated_version validity filter into SPARQL — required CELEX, no act-core REGEX (#45, #109)', async () => {
    const ctx = createMockContext({ errors: eurlex_get_relations.errors });
    mockQuery.mockImplementation(
      routeQuery({
        resolve: [makeResolveBinding(GDPR_WORK_URI)],
        consolidated: [
          makeRelationBinding({
            relatedWork: 'http://publications.europa.eu/resource/cellar/genuine',
            direction: 'incoming',
            relatedCelex: '02016R0679-20160504',
          }),
        ],
      }),
    );

    const input = eurlex_get_relations.input.parse({
      celex_number: '32016R0679',
      relation_types: ['consolidated_version'],
    });
    await eurlex_get_relations.handler(input, ctx);

    const relSparql = mockQuery.mock.calls
      .map((c) => c[0] as string)
      .find((q) => q.includes('cdm:act_consolidated_based_on_resource_legal'))!;
    // The related CELEX is required (not OPTIONAL), so CELEX-less artifacts never
    // enter the page or the truncation count.
    expect(relSparql).toContain('?relatedWork cdm:resource_legal_id_celex ?relatedCelex .');
    expect(relSparql).not.toContain(
      'OPTIONAL { ?relatedWork cdm:resource_legal_id_celex ?relatedCelex . }',
    );
    // The based-on link reaches this act's consolidations alone, however numbered.
    expect(relSparql).not.toContain('REGEX');
  });

  it('requires the related CELEX with no act-core REGEX on the work_uri path (#45, #73, #109)', async () => {
    const ctx = createMockContext({ errors: eurlex_get_relations.errors });
    mockQuery.mockImplementation(
      routeQuery({
        sourceCelex: [makeSourceCelexBinding('32016R0679')],
        consolidated: [
          makeRelationBinding({
            relatedWork: 'http://publications.europa.eu/resource/cellar/genuine',
            direction: 'incoming',
            relatedCelex: '02016R0679-20160504',
          }),
        ],
      }),
    );

    const input = eurlex_get_relations.input.parse({
      work_uri: GDPR_WORK_URI,
      relation_types: ['consolidated_version'],
    });
    await eurlex_get_relations.handler(input, ctx);

    const relSparql = mockQuery.mock.calls
      .map((call) => call[0] as string)
      .find((query) => query.includes('cdm:act_consolidated_based_on_resource_legal'))!;
    expect(relSparql).toContain('?relatedWork cdm:resource_legal_id_celex ?relatedCelex .');
    expect(relSparql).not.toContain('REGEX');
  });

  it('leaves the CELEX OPTIONAL and adds no REGEX for non-consolidated relation types (issue #45)', async () => {
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
      celex_number: '32016R0679',
      relation_types: ['amended_by'],
    });
    await eurlex_get_relations.handler(input, ctx);

    const relSparql = mockQuery.mock.calls
      .map((c) => c[0] as string)
      .find((q) => !isResolutionQuery(q))!;
    expect(relSparql).toContain(
      'OPTIONAL { ?relatedWork cdm:resource_legal_id_celex ?relatedCelex . }',
    );
    expect(relSparql).not.toContain('REGEX');
  });

  it('does not set truncated when filtered consolidated_version artifacts fill the raw cap but valid rows are under it (issue #45)', async () => {
    const ctx = createMockContext({ errors: eurlex_get_relations.errors });
    // One consolidation and one CELEX-less CONS_TEXT member at limit 2. The raw page
    // fills the cap of 2, but only the CELEX-bearing row survives the filter — so no
    // additional valid rows exist beyond this page.
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
      limit: 2,
    });
    const result = await eurlex_get_relations.handler(input, ctx);

    expect(result.total).toBe(1);
    expect(result.relations[0]?.related_celex_number).toBe('02016R0679-20160504');
    // The filtered-out artifact must not raise a false truncation hint.
    expect(getEnrichment(ctx).truncated).toBeUndefined();
  });

  it('does not infer continuation when valid consolidated_version rows exactly fill the cap', async () => {
    const ctx = createMockContext({ errors: eurlex_get_relations.errors });
    // Two genuine same-act consolidations at a cap of 2 with no sentinel row: this
    // is an exactly-full final page, not proof that another page exists.
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
      limit: 2,
    });
    const result = await eurlex_get_relations.handler(input, ctx);

    expect(result.has_more).toBe(false);
    expect(result.next_offset).toBeUndefined();
    expect(getEnrichment(ctx).truncated).toBeUndefined();
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
      .find((q) => !isResolutionQuery(q))!;
    expect(relSparql).toContain(`<${GDPR_WORK_URI}> cdm:work_cites_work ?relatedWork`);
    expect(relSparql).toContain(`?relatedWork cdm:work_cites_work <${GDPR_WORK_URI}>`);
  });

  // --- #39: incoming edges ordered newest-first, per-direction caps, paging, truncation ---

  it('orders each relation query by document date DESC and pages with LIMIT + OFFSET', async () => {
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
      celex_number: '32016R0679',
      relation_types: ['amended_by'],
    });
    await eurlex_get_relations.handler(input, ctx);

    const relSparql = mockQuery.mock.calls
      .map((c) => c[0] as string)
      .find((q) => !isResolutionQuery(q))!;
    // Ordering fix: the newest related works land within the cap, not an arbitrary subset.
    expect(relSparql).toContain('ORDER BY DESC(?relatedDateMax)');
    expect(relSparql).toContain('cdm:work_date_document ?relatedDate');
    expect(relSparql).toContain('LIMIT 101');
    expect(relSparql).toContain('OFFSET 0');
  });

  it('splits the per-direction cap for the symmetric cites relation (one LIMIT per direction)', async () => {
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
    await eurlex_get_relations.handler(input, ctx);

    const citesSparql = mockQuery.mock.calls
      .map((c) => c[0] as string)
      .find((q) => q.includes('cdm:work_cites_work'))!;
    // Two independently-capped subqueries UNIONed — outgoing can't consume incoming's budget.
    expect(citesSparql).toContain('UNION');
    expect((citesSparql.match(/LIMIT /g) ?? []).length).toBe(2);
    expect((citesSparql.match(/OFFSET /g) ?? []).length).toBe(2);
  });

  it('orders the symmetric UNION so the sentinel row cannot displace a real relation', async () => {
    const ctx = createMockContext({ errors: eurlex_get_relations.errors });
    mockQuery.mockImplementation(
      routeQuery({
        resolve: [makeResolveBinding(GDPR_WORK_URI)],
        cites: [
          makeRelationBinding({
            relatedWork: 'http://publications.europa.eu/resource/cellar/cited',
            direction: 'outgoing',
          }),
        ],
      }),
    );

    await eurlex_get_relations.handler(
      eurlex_get_relations.input.parse({
        celex_number: '32016R0679',
        relation_types: ['cites'],
      }),
      ctx,
    );

    const citesSparql = mockQuery.mock.calls
      .map((c) => c[0] as string)
      .find((q) => q.includes('cdm:work_cites_work'))!;
    // The outer UNION projects ?relatedDateMax and orders on it, then on the work
    // URI (#100). Without that the union order is implementation-defined, and the
    // caller slices each direction to the cap after the fact — so an arbitrary
    // interleaving could keep the private continuation sentinel and drop a real
    // relation.
    expect(citesSparql).toContain(
      'SELECT ?relatedWork ?relatedCelexSample ?direction ?relatedDateMax (MAX(STR(?relatedTitle)) AS ?relatedTitleMax) WHERE {',
    );
    expect(
      citesSparql.trimEnd().endsWith('ORDER BY ?direction DESC(?relatedDateMax) ?relatedWork'),
    ).toBe(true);
  });

  it('passes offset through to the per-type queries and echoes it in the response', async () => {
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
      celex_number: '32016R0679',
      relation_types: ['amended_by'],
      offset: 25,
    });
    const result = await eurlex_get_relations.handler(input, ctx);

    expect(result.offset).toBe(25);
    const relSparql = mockQuery.mock.calls
      .map((c) => c[0] as string)
      .find((q) => !isResolutionQuery(q))!;
    expect(relSparql).toContain('OFFSET 25');
  });

  it('does not disclose continuation when a direction exactly fills its final page', async () => {
    const ctx = createMockContext({ errors: eurlex_get_relations.errors });
    // Two incoming amenders at a cap of 2 and no sentinel row: exact final page.
    mockQuery.mockImplementation(
      routeQuery({
        resolve: [makeResolveBinding(GDPR_WORK_URI)],
        amendedBy: [
          makeRelationBinding({
            relatedWork: 'http://publications.europa.eu/resource/cellar/amender-1',
            direction: 'incoming',
            relatedCelex: '32026R1165',
          }),
          makeRelationBinding({
            relatedWork: 'http://publications.europa.eu/resource/cellar/amender-2',
            direction: 'incoming',
            relatedCelex: '32026R1166',
          }),
        ],
      }),
    );

    const input = eurlex_get_relations.input.parse({
      celex_number: '32016R0679',
      relation_types: ['amended_by'],
      limit: 2,
    });
    const result = await eurlex_get_relations.handler(input, ctx);

    expect(result.relations).toHaveLength(2);
    expect(result.has_more).toBe(false);
    expect(result.next_offset).toBeUndefined();
    expect(getEnrichment(ctx).truncated).toBeUndefined();
  });

  it('proves continuation independently per direction without exposing sentinel rows', async () => {
    const ctx = createMockContext({ errors: eurlex_get_relations.errors });
    mockQuery.mockImplementation(
      routeQuery({
        resolve: [makeResolveBinding(GDPR_WORK_URI)],
        cites: [
          makeRelationBinding({
            relatedWork: 'http://publications.europa.eu/resource/cellar/outgoing-1',
            direction: 'outgoing',
          }),
          makeRelationBinding({
            relatedWork: 'http://publications.europa.eu/resource/cellar/outgoing-2',
            direction: 'outgoing',
          }),
          makeRelationBinding({
            relatedWork: 'http://publications.europa.eu/resource/cellar/incoming-1',
            direction: 'incoming',
          }),
          makeRelationBinding({
            relatedWork: 'http://publications.europa.eu/resource/cellar/incoming-2',
            direction: 'incoming',
          }),
          makeRelationBinding({
            relatedWork: 'http://publications.europa.eu/resource/cellar/incoming-sentinel',
            direction: 'incoming',
          }),
        ],
      }),
    );

    const input = eurlex_get_relations.input.parse({
      celex_number: '32016R0679',
      relation_types: ['cites'],
      limit: 2,
    });
    const result = await eurlex_get_relations.handler(input, ctx);

    expect(result.relations.filter((relation) => relation.direction === 'outgoing')).toHaveLength(
      2,
    );
    expect(result.relations.filter((relation) => relation.direction === 'incoming')).toHaveLength(
      2,
    );
    expect(result.relations.map((relation) => relation.related_work_uri)).not.toContain(
      'http://publications.europa.eu/resource/cellar/incoming-sentinel',
    );
    expect(result.has_more).toBe(true);
    expect(result.next_offset).toBe(2);
    expect(getEnrichment(ctx)).toMatchObject({ truncated: true, shown: 4, cap: 2 });

    const citesSparql = mockQuery.mock.calls
      .map((call) => call[0] as string)
      .find((query) => query.includes('cdm:work_cites_work'))!;
    expect(citesSparql.match(/LIMIT 3/g)).toHaveLength(2);
    const text = (eurlex_get_relations.format!(result)[0] as { text: string }).text;
    expect(text).toContain('**Has more:** true');
    expect(text).toContain('**Next offset:** 2');
  });

  it('uses the service ceiling as the effective page size and continuation offset', async () => {
    const ctx = createMockContext({ errors: eurlex_get_relations.errors });
    mockMaxResults = 2;
    mockQuery.mockImplementation(
      routeQuery({
        resolve: [makeResolveBinding(GDPR_WORK_URI)],
        amendedBy: [
          makeRelationBinding({
            relatedWork: 'http://publications.europa.eu/resource/cellar/amender-1',
            direction: 'incoming',
          }),
          makeRelationBinding({
            relatedWork: 'http://publications.europa.eu/resource/cellar/amender-2',
            direction: 'incoming',
          }),
          makeRelationBinding({
            relatedWork: 'http://publications.europa.eu/resource/cellar/amender-sentinel',
            direction: 'incoming',
          }),
        ],
      }),
    );

    const input = eurlex_get_relations.input.parse({
      celex_number: '32016R0679',
      relation_types: ['amended_by'],
      limit: 100,
    });
    const result = await eurlex_get_relations.handler(input, ctx);

    expect(result.relations).toHaveLength(2);
    expect(result.has_more).toBe(true);
    expect(result.next_offset).toBe(2);
    expect(getEnrichment(ctx)).toMatchObject({ truncated: true, shown: 2, cap: 2 });
  });

  it('does not disclose continuation when every direction is short of the cap', async () => {
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
      celex_number: '32016R0679',
      relation_types: ['amended_by'],
      limit: 2,
    });
    const result = await eurlex_get_relations.handler(input, ctx);

    expect(result.has_more).toBe(false);
    expect(result.next_offset).toBeUndefined();
    expect(getEnrichment(ctx).truncated).toBeUndefined();
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
      .filter((q) => !isResolutionQuery(q));
    expect(relCalls).toHaveLength(1);
    expect(relCalls[0]).toContain('cdm:resource_legal_based_on_resource_legal');
    expect(relCalls[0]).not.toContain('cdm:work_cites_work');
  });

  // --- #47: requested-but-empty relation types are made explicit ---

  it('echoes requested_relation_types and lists requested-but-empty types (issue #47)', async () => {
    const ctx = createMockContext({ errors: eurlex_get_relations.errors });
    // GDPR shape: repeals, legal_basis, consolidated_version return edges; amends,
    // amended_by, repealed_by are empty this call.
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
        legalBasis: [
          makeRelationBinding({
            relatedWork: 'http://publications.europa.eu/resource/cellar/tfeu-16',
            direction: 'outgoing',
            relatedCelex: '12016E016',
          }),
        ],
        consolidated: [
          makeRelationBinding({
            relatedWork: 'http://publications.europa.eu/resource/cellar/cons',
            direction: 'incoming',
            relatedCelex: '02016R0679-20160504',
          }),
        ],
      }),
    );

    const input = eurlex_get_relations.input.parse({
      celex_number: '32016R0679',
      relation_types: [
        'amends',
        'amended_by',
        'repeals',
        'repealed_by',
        'legal_basis',
        'consolidated_version',
      ],
    });
    const result = await eurlex_get_relations.handler(input, ctx);

    expect(result.requested_relation_types).toEqual([
      'amends',
      'amended_by',
      'repeals',
      'repealed_by',
      'legal_basis',
      'consolidated_version',
    ]);
    // Exactly the three requested types with zero rows, in requested order.
    expect(result.empty_relation_types).toEqual(['amends', 'amended_by', 'repealed_by']);
  });

  it('reports no empty types when every requested type returns edges (issue #47)', async () => {
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
      relation_types: ['repeals', 'legal_basis'],
    });
    const result = await eurlex_get_relations.handler(input, ctx);

    expect(result.requested_relation_types).toEqual(['repeals', 'legal_basis']);
    expect(result.empty_relation_types).toEqual([]);
  });

  it('echoes the full default type list in requested_relation_types when relation_types is omitted (issue #47)', async () => {
    const ctx = createMockContext({ errors: eurlex_get_relations.errors });
    // Only legal_basis returns an edge; every other default type is empty this call.
    mockQuery.mockImplementation(
      routeQuery({
        resolve: [makeResolveBinding(GDPR_WORK_URI)],
        legalBasis: [
          makeRelationBinding({
            relatedWork: 'http://publications.europa.eu/resource/cellar/tfeu-16',
            direction: 'outgoing',
            relatedCelex: '12016E016',
          }),
        ],
      }),
    );

    const input = eurlex_get_relations.input.parse({ celex_number: '32016R0679' });
    const result = await eurlex_get_relations.handler(input, ctx);

    expect(result.requested_relation_types).toEqual([...RELATION_TYPES]);
    expect(result.empty_relation_types).not.toContain('legal_basis');
    // Every default type except the one that returned an edge.
    expect(result.empty_relation_types).toHaveLength(RELATION_TYPES.length - 1);
  });

  // --- work_uri alternative (issue #8) ---

  it('uses work_uri directly and skips source identity for a type that does not need it', async () => {
    const ctx = createMockContext({ errors: eurlex_get_relations.errors });
    mockQuery.mockImplementation(
      routeQuery({
        sourceCelex: [makeSourceCelexBinding('32016R0679')],
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
    // Only consolidated_version and national_transposition consume the source
    // CELEX identity, so amended_by alone resolves none — and echoes none.
    expect(result.celex_number).toBeUndefined();
    expect(result.total).toBe(1);
    expect(result.relations[0]?.relation_type).toBe('amended_by');

    // The traversal alone: no CELEX→work lookup, and no source-identity lookup.
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls.map((call) => call[0] as string)).not.toContainEqual(
      expect.stringContaining('VALUES ?celexNumber'),
    );
    expect(mockQuery.mock.calls.map((call) => call[0] as string)).not.toContainEqual(
      expect.stringContaining('SELECT ?sourceCelex WHERE'),
    );
    const relSparql = mockQuery.mock.calls[0]?.[0] as string;
    expect(relSparql).toContain(`<${GDPR_WORK_URI}>`);
  });

  it('resolves and echoes the source CELEX when a constrained type needs it (#73)', async () => {
    const ctx = createMockContext({ errors: eurlex_get_relations.errors });
    mockQuery.mockImplementation(
      routeQuery({
        sourceCelex: [makeSourceCelexBinding('32016L0680')],
        nationalTransposition: [
          makeRelationBinding({
            relatedWork: CZECH_MEASURE_WORK_URI,
            direction: 'incoming',
            relatedCelex: '72016L0680CZE_225030',
          }),
        ],
      }),
    );

    const input = eurlex_get_relations.input.parse({
      work_uri: DIRECTIVE_680_WORK_URI,
      relation_types: ['national_transposition'],
    });
    const result = await eurlex_get_relations.handler(input, ctx);

    // Source identity + traversal; no CELEX→work lookup is needed.
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery.mock.calls.map((call) => call[0] as string)).toContainEqual(
      expect.stringContaining('SELECT ?sourceCelex WHERE'),
    );
    // The resolved identity reaches structuredContent…
    expect(result.celex_number).toBe('32016L0680');
    expect(result.work_uri).toBe(DIRECTIVE_680_WORK_URI);
    // …and the text channel, so both surfaces name the act the traversal matched.
    const text = (eurlex_get_relations.format!(result)[0] as { text: string }).text;
    expect(text).toContain('Relations for 32016L0680');
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

  it('bounds the CELEX the not_found message echoes (#135)', async () => {
    const ctx = createMockContext({ errors: eurlex_get_relations.errors });
    mockQuery.mockImplementation(routeQuery({ resolve: [] }));
    const celex = `32016R0679${'0'.repeat(50_000)}`;

    await expect(
      eurlex_get_relations.handler(eurlex_get_relations.input.parse({ celex_number: celex }), ctx),
    ).rejects.toMatchObject({
      data: { reason: 'not_found' },
      message: `No CELLAR work found for CELEX: ${celex.slice(0, 100)}…`,
    });
  });

  // --- Empty pages ---

  it('returns an empty first page listing every type as empty when every relation query returns empty', async () => {
    const ctx = createMockContext({ errors: eurlex_get_relations.errors });
    // resolve succeeds; all per-type queries return [].
    mockQuery.mockImplementation(routeQuery({ resolve: [makeResolveBinding(GDPR_WORK_URI)] }));

    const input = eurlex_get_relations.input.parse({ celex_number: '32016R0679' });
    const result = await eurlex_get_relations.handler(input, ctx);

    expect(result).toMatchObject({ relations: [], total: 0, offset: 0, has_more: false });
    expect(result.empty_relation_types).toEqual([...RELATION_TYPES]);
    expect(getEnrichment(ctx).notice).toContain('32016R0679');
  });

  it('returns an exhausted non-zero page with source and requested-type state intact', async () => {
    const ctx = createMockContext({ errors: eurlex_get_relations.errors });
    mockQuery.mockImplementation(routeQuery({ resolve: [makeResolveBinding(GDPR_WORK_URI)] }));

    const input = eurlex_get_relations.input.parse({
      celex_number: '32016R0679',
      relation_types: ['amended_by', 'legal_basis'],
      offset: 50,
      limit: 25,
    });
    const result = await eurlex_get_relations.handler(input, ctx);

    expect(result).toEqual({
      celex_number: '32016R0679',
      work_uri: GDPR_WORK_URI,
      relations: [],
      total: 0,
      offset: 50,
      has_more: false,
      requested_relation_types: ['amended_by', 'legal_basis'],
      empty_relation_types: ['amended_by', 'legal_basis'],
    });
    expect(result.next_offset).toBeUndefined();
    expect(getEnrichment(ctx).truncated).toBeUndefined();
    const text = (eurlex_get_relations.format!(result)[0] as { text: string }).text;
    expect(text).toContain('32016R0679');
    expect(text).toContain('offset 50');
    expect(text).toContain('**Has more:** false');
  });

  it('carries no notice on either surface for a page past the end (#112)', async () => {
    mockQuery.mockImplementation(routeQuery({ resolve: [makeResolveBinding(GDPR_WORK_URI)] }));

    const result = await runToolContract(eurlex_get_relations, {
      celex_number: '32016R0679',
      relation_types: ['amended_by', 'legal_basis'],
      offset: 50,
      limit: 25,
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      celex_number: '32016R0679',
      work_uri: GDPR_WORK_URI,
      relations: [],
      total: 0,
      offset: 50,
      has_more: false,
      requested_relation_types: ['amended_by', 'legal_basis'],
      empty_relation_types: ['amended_by', 'legal_basis'],
    });
    expect(contentText(result)).not.toMatch(/^> /m);
  });

  // --- Format ---

  it('format groups relations by type and direction, renders CELEX, work URI, and offset', () => {
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
      offset: 0,
      has_more: false,
      requested_relation_types: ['amended_by', 'legal_basis', 'repeals'],
      empty_relation_types: ['repeals'],
    };
    const blocks = eurlex_get_relations.format!(output);
    expect(blocks[0]?.type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('32016R0679');
    expect(text).toContain('32022R0000');
    expect(text).toContain('amended_by');
    expect(text).toContain('legal_basis');
    // The pagination offset reaches the text channel (format parity).
    expect(text).toContain('offset 0');
    // #47: requested + empty type coverage reaches the text channel too. 'repeals'
    // appears only in the requested/empty lists (not the relations), so its presence
    // proves both lists render.
    expect(text).toContain('**Requested types:**');
    expect(text).toContain('repeals');
    expect(text).toContain('**Empty types (this page):**');
    expect(text).toContain('**Has more:** false');
  });

  it('format renders "none" for empty_relation_types when every requested type returned edges (issue #47)', () => {
    const output = {
      celex_number: '32016R0679',
      work_uri: GDPR_WORK_URI,
      relations: [
        {
          relation_type: 'legal_basis',
          direction: 'outgoing',
          related_work_uri: 'http://publications.europa.eu/resource/cellar/basis',
        },
      ],
      total: 1,
      offset: 0,
      has_more: false,
      requested_relation_types: ['legal_basis'],
      empty_relation_types: [],
    };
    const text = (eurlex_get_relations.format!(output)[0] as { text: string }).text;
    expect(text).toContain('**Requested types:** legal_basis');
    expect(text).toContain('**Empty types (this page):** none');
  });

  // --- #60: control characters in work_uri must not reach the SPARQL IRI ---

  describe('control characters in work_uri (#60)', () => {
    /**
     * work_uri is interpolated straight into `<${workUri}>` when a relation arm is
     * built, so a value carrying an IRI-forbidden character produces a malformed IRI
     * and leaks Virtuoso's compiler error — with the internal query text attached —
     * in place of the tool's own error. Confirmed live for a tab and a newline. The
     * guard this replaced tested only for a literal space.
     */
    it.each([
      ['a newline', `${GDPR_WORK_URI}\nX`],
      ['a tab', `${GDPR_WORK_URI}\tX`],
      ['a carriage return', `${GDPR_WORK_URI}\rX`],
      ['a space', `${GDPR_WORK_URI} X`],
      ['an opening angle bracket', `${GDPR_WORK_URI}<X`],
      ['a closing angle bracket', `${GDPR_WORK_URI}>X`],
      ['a double quote', `${GDPR_WORK_URI}"X`],
    ])('rejects a work_uri containing %s at the schema, before any query', (_label, uri) => {
      expect(() => eurlex_get_relations.input.parse({ work_uri: uri })).toThrow();
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('still accepts a legitimate work_uri', () => {
      expect(() => eurlex_get_relations.input.parse({ work_uri: GDPR_WORK_URI })).not.toThrow();
    });
  });

  // --- #69: CELEX shape gate at the schema layer ---

  describe('CELEX shape validation (#69)', () => {
    it.each([
      ['a bare zero', '0'],
      ['a stray word', 'hello'],
      ['whitespace only', '   '],
    ])('rejects %s before any CELLAR request', (_label, value) => {
      expect(() => eurlex_get_relations.input.parse({ celex_number: value })).toThrow();
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it.each([
      ['sector 0, consolidated version', '02016R0679-20160504'],
      ['sector 1, treaty reference with slashes', '11957A/PRO/CJ/09'],
      ['sector 2, external relations', '22001D0815'],
      ['sector 3, regulation', '32016R0679'],
      ['sector 3, corrigendum marker', '32016R0679R(02)'],
      ['sector 4, complementary legislation', '42002D0234'],
      ['sector 5, preparatory act', '52016PC0001'],
      ['sector 6, case law', '62024CJ0629'],
      ['sector 7, national implementing measure', '72014L0056FIN_240353'],
      ['sector 8, national case law', '82003PT1111(51)'],
      ['sector 9, parliamentary question', '91980E001013'],
      ['sector C, OJ C series', 'C/2026/01104'],
      ['sector E, EFTA document', 'E2016C0186'],
    ])('accepts a real %s', (_label, celex) => {
      expect(() => eurlex_get_relations.input.parse({ celex_number: celex })).not.toThrow();
    });

    it('still routes celex_number "" to the handler and its identifier guard', async () => {
      const ctx = createMockContext({ errors: eurlex_get_relations.errors });

      // The blank-field convention survives the new pattern: "" is a union member,
      // so a form client's empty box reaches the handler's friendly guard rather
      // than a schema rejection.
      const input = eurlex_get_relations.input.parse({ celex_number: '' });
      await expect(eurlex_get_relations.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'invalid_identifier_args' },
      });
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  // --- CELEX input normalization ---

  describe('CELEX normalization', () => {
    it('trims surrounding whitespace before validating', () => {
      expect(eurlex_get_relations.input.parse({ celex_number: ' 32016R0679 ' }).celex_number).toBe(
        '32016R0679',
      );
    });

    it('uppercases a lowercase CELEX before validating', () => {
      expect(eurlex_get_relations.input.parse({ celex_number: '32016r0679' }).celex_number).toBe(
        '32016R0679',
      );
    });

    /**
     * A whitespace-only value is not the `''` union member, so it takes the regex
     * branch, trims to `''` there, and fails the six-character floor — a schema
     * rejection, not the handler's identifier guard.
     */
    it('still rejects a whitespace-only celex_number at the schema', () => {
      expect(() => eurlex_get_relations.input.parse({ celex_number: '   ' })).toThrow();
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('hands the handler the normalized CELEX', async () => {
      const ctx = createMockContext({ errors: eurlex_get_relations.errors });
      mockQuery.mockImplementation(
        routeQuery({
          resolve: [makeResolveBinding(GDPR_WORK_URI)],
          amendedBy: [
            makeRelationBinding({
              relatedWork: 'http://publications.europa.eu/resource/cellar/amender',
              direction: 'incoming',
              relatedCelex: '32022R0000',
            }),
          ],
        }),
      );

      const input = eurlex_get_relations.input.parse({
        celex_number: '   32016r0679   ',
        relation_types: ['amended_by'],
      });
      const result = await eurlex_get_relations.handler(input, ctx);

      expect(result.celex_number).toBe('32016R0679');
      expect(mockQuery.mock.calls[0]?.[0] as string).toContain(
        'VALUES ?celexNumber { "32016R0679"^^xsd:string }',
      );
    });
  });

  // --- #73: ambiguous source identity on the work_uri path ---

  describe('multi-CELEX source work (#73)', () => {
    const MULTI_CELEX_MEASURE_WORK_URI = HUNGARIAN_MEASURE_WORK_URI;

    it('requests a second CELEX row so an ambiguous identity is detectable', async () => {
      const ctx = createMockContext({ errors: eurlex_get_relations.errors });
      mockQuery.mockImplementation(
        routeQuery({
          sourceCelex: [makeSourceCelexBinding('32016L0680')],
          nationalTransposition: [
            makeRelationBinding({
              relatedWork: CZECH_MEASURE_WORK_URI,
              direction: 'incoming',
              relatedCelex: '72016L0680CZE_225030',
            }),
          ],
        }),
      );

      const input = eurlex_get_relations.input.parse({
        work_uri: DIRECTIVE_680_WORK_URI,
        relation_types: ['national_transposition'],
      });
      await eurlex_get_relations.handler(input, ctx);

      const sourceIdentitySparql = mockQuery.mock.calls
        .map((call) => call[0] as string)
        .find((query) => query.includes('SELECT ?sourceCelex WHERE'))!;
      expect(sourceIdentitySparql).toContain('LIMIT 2');
    });

    it('follows consolidated_version for an ambiguous work without resolving its identity (#109)', async () => {
      const ctx = createMockContext({ errors: eurlex_get_relations.errors });
      // A national implementing measure carries one CELEX per directive it
      // transposes; there is no principled basis for picking one of them.
      mockQuery.mockImplementation(
        routeQuery({
          sourceCelex: [
            makeSourceCelexBinding('72016L0680HUN_194829'),
            makeSourceCelexBinding('72016L0681HUN_194830'),
          ],
          consolidated: [
            makeRelationBinding({
              relatedWork: 'http://publications.europa.eu/resource/cellar/cons-a',
              direction: 'incoming',
              relatedCelex: '02016R0679-20160504',
            }),
            makeRelationBinding({
              relatedWork: 'http://publications.europa.eu/resource/cellar/celex-less',
              direction: 'incoming',
            }),
          ],
        }),
      );

      const input = eurlex_get_relations.input.parse({
        work_uri: MULTI_CELEX_MEASURE_WORK_URI,
        relation_types: ['consolidated_version'],
      });
      const result = await eurlex_get_relations.handler(input, ctx);

      const queries = mockQuery.mock.calls.map((call) => call[0] as string);
      // The based-on link needs no act identity, so the work's several CELEX values
      // are never read.
      expect(queries).not.toContainEqual(expect.stringContaining('SELECT ?sourceCelex WHERE'));
      const traversalSparql = queries.find((query) =>
        query.includes('cdm:act_consolidated_based_on_resource_legal'),
      )!;
      expect(traversalSparql).not.toContain('REGEX(STR(?relatedCelex)');
      // The related CELEX stays required, so CELEX-less consolidation artifacts
      // are still dropped.
      expect(traversalSparql).toContain('?relatedWork cdm:resource_legal_id_celex ?relatedCelex .');
      expect(result.relations.map((r) => r.related_celex_number)).toEqual(['02016R0679-20160504']);
    });

    it('returns no national_transposition rows for an ambiguous work', async () => {
      const ctx = createMockContext({ errors: eurlex_get_relations.errors });
      mockQuery.mockImplementation(
        routeQuery({
          sourceCelex: [
            makeSourceCelexBinding('72016L0680HUN_194829'),
            makeSourceCelexBinding('72016L0681HUN_194830'),
          ],
          nationalTransposition: [
            makeRelationBinding({
              relatedWork: CZECH_MEASURE_WORK_URI,
              direction: 'incoming',
              relatedCelex: '72016L0680CZE_225030',
            }),
          ],
        }),
      );

      const input = eurlex_get_relations.input.parse({
        work_uri: MULTI_CELEX_MEASURE_WORK_URI,
        relation_types: ['national_transposition'],
      });
      // Selecting measures with no determinate source act is exactly the
      // arbitrary binding the constraint exists to prevent, so the type is empty
      // and — being the only requested type — the page comes back empty.
      const result = await eurlex_get_relations.handler(input, ctx);
      expect(result).toMatchObject({
        relations: [],
        total: 0,
        empty_relation_types: ['national_transposition'],
      });
      expect(result).not.toHaveProperty('celex_number');

      // No pattern could select this act's measures, so no CELLAR round-trip is
      // spent on the type at all — previously a query filtered by "^$" was sent.
      expect(mockQuery.mock.calls.map((call) => call[0] as string)).not.toContainEqual(
        expect.stringContaining('cdm:measure_national_implementing_implements_resource_legal'),
      );
    });

    it('keeps a single-CELEX work unambiguous and still pushes its act core', async () => {
      const ctx = createMockContext({ errors: eurlex_get_relations.errors });
      // The same CELEX repeated across rows is one identity, not an ambiguity.
      mockQuery.mockImplementation(
        routeQuery({
          sourceCelex: [makeSourceCelexBinding('32016L0680'), makeSourceCelexBinding('32016L0680')],
          nationalTransposition: [
            makeRelationBinding({
              relatedWork: CZECH_MEASURE_WORK_URI,
              direction: 'incoming',
              relatedCelex: '72016L0680CZE_225030',
            }),
          ],
        }),
      );

      const input = eurlex_get_relations.input.parse({
        work_uri: DIRECTIVE_680_WORK_URI,
        relation_types: ['national_transposition'],
      });
      const result = await eurlex_get_relations.handler(input, ctx);

      const traversalSparql = mockQuery.mock.calls
        .map((call) => call[0] as string)
        .find((query) =>
          query.includes('cdm:measure_national_implementing_implements_resource_legal'),
        )!;
      expect(traversalSparql).toContain('REGEX(STR(?relatedCelex), "^72016L0680[A-Z]{3}")');
      expect(result.total).toBe(1);
    });
  });

  // --- #56: the same-act constraint is anchored past the act core ---

  describe('national transposition act-core anchoring (#56)', () => {
    it('anchors the sector-7 pattern on the member-state code', async () => {
      const ctx = createMockContext({ errors: eurlex_get_relations.errors });
      mockQuery.mockImplementation(
        routeQuery({
          resolve: [makeResolveBinding(DIRECTIVE_680_WORK_URI)],
          nationalTransposition: [
            makeRelationBinding({
              relatedWork: CZECH_MEASURE_WORK_URI,
              direction: 'incoming',
              relatedCelex: '72016L0680CZE_225030',
            }),
          ],
        }),
      );

      const input = eurlex_get_relations.input.parse({
        celex_number: '32016L0680',
        relation_types: ['national_transposition'],
      });
      await eurlex_get_relations.handler(input, ctx);

      const sparql = mockQuery.mock.calls
        .map((call) => call[0] as string)
        .find((query) =>
          query.includes('cdm:measure_national_implementing_implements_resource_legal'),
        )!;
      expect(sparql).toContain('REGEX(STR(?relatedCelex), "^72016L0680[A-Z]{3}")');
      // A left-anchored-only pattern is what the trailing [A-Z]{3} replaces.
      expect(sparql).not.toContain('REGEX(STR(?relatedCelex), "^72016L0680")');
    });

    it('drops a measure whose act number merely extends the source act core', async () => {
      const ctx = createMockContext({ errors: eurlex_get_relations.errors });
      // 32016L06801 is a different, longer act number that shares 32016L0680's
      // leading digits; its measures must not be reported as transposing 2016/680.
      mockQuery.mockImplementation(
        routeQuery({
          resolve: [makeResolveBinding(DIRECTIVE_680_WORK_URI)],
          nationalTransposition: [
            makeRelationBinding({
              relatedWork: CZECH_MEASURE_WORK_URI,
              direction: 'incoming',
              relatedCelex: '72016L0680CZE_225030',
            }),
            makeRelationBinding({
              relatedWork: 'http://publications.europa.eu/resource/cellar/other-act-measure',
              direction: 'incoming',
              relatedCelex: '72016L06801CZE_999999',
            }),
          ],
        }),
      );

      const input = eurlex_get_relations.input.parse({
        celex_number: '32016L0680',
        relation_types: ['national_transposition'],
      });
      const result = await eurlex_get_relations.handler(input, ctx);

      expect(result.relations.map((r) => r.related_celex_number)).toEqual(['72016L0680CZE_225030']);
      expect(result.relations.map((r) => r.related_work_uri)).not.toContain(
        'http://publications.europa.eu/resource/cellar/other-act-measure',
      );
    });
  });

  // --- #85: the member state of a national_transposition row ---

  describe('member state on national_transposition rows (#85)', () => {
    /** Measures of 2016/680 from several member states, as the traversal returns them. */
    const MEASURES = [
      { work: CZECH_MEASURE_WORK_URI, celex: '72016L0680CZE_202505539', state: 'CZE' },
      {
        work: 'http://publications.europa.eu/resource/cellar/fi-measure',
        celex: '72016L0680FIN_240353',
        state: 'FIN',
      },
      {
        work: 'http://publications.europa.eu/resource/cellar/uk-measure',
        celex: '72016L0680GBR_201812345',
        state: 'GBR',
      },
    ];
    const measureRows = MEASURES.map((m) =>
      makeRelationBinding({ relatedWork: m.work, direction: 'incoming', relatedCelex: m.celex }),
    );

    it('carries the alpha-3 segment after the act core on every row, in both channels', async () => {
      mockQuery.mockImplementation(
        routeQuery({
          resolve: [makeResolveBinding(DIRECTIVE_680_WORK_URI)],
          nationalTransposition: measureRows,
        }),
      );

      const result = await runToolContract(eurlex_get_relations, {
        celex_number: '32016L0680',
        relation_types: ['national_transposition'],
      });

      expect(result.isError).toBeFalsy();
      const structured = eurlex_get_relations.output.parse(result.structuredContent);
      expect(structured.relations).toEqual(
        MEASURES.map((m) => ({
          relation_type: 'national_transposition',
          direction: 'incoming',
          related_work_uri: m.work,
          related_celex_number: m.celex,
          related_member_state: m.state,
        })),
      );
      for (const r of structured.relations) {
        // The code is exactly the three letters after `2016L0680` in the row's CELEX.
        expect(r.related_member_state).toBe(r.related_celex_number?.slice(10, 13));
      }

      const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
      for (const m of MEASURES) {
        expect(text).toContain(`- ${m.celex} (${m.work}) — member state ${m.state}`);
      }
    });

    it('returns identical member states for the CELEX and work_uri inputs', async () => {
      const ctx = createMockContext({ errors: eurlex_get_relations.errors });
      mockQuery.mockImplementation(
        routeQuery({
          resolve: [makeResolveBinding(DIRECTIVE_680_WORK_URI)],
          sourceCelex: [makeSourceCelexBinding('32016L0680')],
          nationalTransposition: measureRows,
        }),
      );

      const byCelex = await eurlex_get_relations.handler(
        eurlex_get_relations.input.parse({
          celex_number: '32016L0680',
          relation_types: ['national_transposition'],
        }),
        ctx,
      );
      const byWorkUri = await eurlex_get_relations.handler(
        eurlex_get_relations.input.parse({
          work_uri: DIRECTIVE_680_WORK_URI,
          relation_types: ['national_transposition'],
        }),
        ctx,
      );

      expect(byWorkUri.relations.map((r) => r.related_member_state)).toEqual(['CZE', 'FIN', 'GBR']);
      expect(byWorkUri.relations).toEqual(byCelex.relations);
    });

    it('never attaches a member state to another relation type, even a sector-7 cites row', async () => {
      mockQuery.mockImplementation(
        routeQuery({
          resolve: [makeResolveBinding(DIRECTIVE_680_WORK_URI)],
          nationalTransposition: [measureRows[0]!],
          cites: [
            makeRelationBinding({
              relatedWork: 'http://publications.europa.eu/resource/cellar/citing-measure',
              direction: 'incoming',
              relatedCelex: '72016L0680DEU_000001',
            }),
          ],
          amendedBy: [
            makeRelationBinding({
              relatedWork: 'http://publications.europa.eu/resource/cellar/amender',
              direction: 'incoming',
              relatedCelex: '32022L0000',
            }),
          ],
        }),
      );

      const result = await runToolContract(eurlex_get_relations, {
        celex_number: '32016L0680',
        relation_types: ['national_transposition', 'cites', 'amended_by'],
      });
      const structured = eurlex_get_relations.output.parse(result.structuredContent);

      const others = structured.relations.filter(
        (r) => r.relation_type !== 'national_transposition',
      );
      expect(others.map((r) => r.relation_type).sort()).toEqual(['amended_by', 'cites']);
      for (const r of others) expect(r).not.toHaveProperty('related_member_state');

      const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
      expect(text.match(/member state/g)).toHaveLength(1);
      expect(text).toContain(
        '- 72016L0680DEU_000001 (http://publications.europa.eu/resource/cellar/citing-measure)\n',
      );
    });
  });

  // --- #92: typed exact CELEX triple ---

  describe('typed CELEX literal (#92)', () => {
    it('resolves the CELEX through a typed literal, not a STR() scan', async () => {
      const ctx = createMockContext({ errors: eurlex_get_relations.errors });
      mockQuery.mockImplementation(
        routeQuery({
          resolve: [makeResolveBinding(GDPR_WORK_URI)],
          consolidated: [
            makeRelationBinding({
              relatedWork: 'http://publications.europa.eu/resource/cellar/genuine',
              direction: 'incoming',
              relatedCelex: '02016R0679-20160504',
            }),
          ],
        }),
      );

      await eurlex_get_relations.handler(
        eurlex_get_relations.input.parse({
          celex_number: '32016R0679',
          relation_types: ['consolidated_version'],
        }),
        ctx,
      );

      const resolve = mockQuery.mock.calls.map((c) => c[0] as string).find(isResolutionQuery)!;
      expect(resolve).toContain('VALUES ?celexNumber { "32016R0679"^^xsd:string }');
      expect(resolve).toContain('?work cdm:resource_legal_id_celex ?celexNumber .');
      expect(mockQuery.mock.calls.map((c) => c[0] as string).join('\n')).not.toMatch(
        /STR\(\?\w+\)\s*=/,
      );
    });
  });

  // --- #97: a CELEX held by several works traverses its canonical work ---

  describe('CELEX held by several works (#97)', () => {
    const CITER = `${CELLAR}citer`;

    /** Resolve CELEX queries from the fixture works; only the canonical work is cited. */
    const fakeCellar = async (q: string): Promise<Row[]> => {
      if (typeof q !== 'string') return [];
      if (q.includes('cdm:work_cites_work')) {
        return q.includes(`<${canonicalWork('62022TJ0181')}>`)
          ? [makeRelationBinding({ relatedWork: CITER, direction: 'incoming' })]
          : [];
      }
      return celexWorkRows(q);
    };

    it('traverses the canonical work of 62022TJ0181 and reports it as work_uri', async () => {
      mockQuery.mockImplementation(fakeCellar);

      const result = await runToolContract(eurlex_get_relations, {
        celex_number: '62022TJ0181',
        relation_types: ['cites'],
      });

      expect(result.isError).toBeFalsy();
      const structured = eurlex_get_relations.output.parse(result.structuredContent);
      expect(structured.work_uri).toBe(canonicalWork('62022TJ0181'));
      expect(structured.relations.map((r) => r.related_work_uri)).toEqual([CITER]);
      const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
      expect(text).toContain(`**Work URI:** ${canonicalWork('62022TJ0181')}`);
    });

    it('keeps not_found for a CELEX that no work holds', async () => {
      mockQuery.mockImplementation(fakeCellar);

      await expect(
        eurlex_get_relations.handler(
          eurlex_get_relations.input.parse({ celex_number: '32099R9999' }),
          createMockContext({ errors: eurlex_get_relations.errors }),
        ),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound, data: { reason: 'not_found' } });
    });
  });

  // --- #100: relation pages are newest-first and stable ---

  describe('relation page order (#100)', () => {
    /** The cites query issued for page two (offset 25) of a limit-25 read. */
    const citesQuery = async () => {
      mockQuery.mockImplementation(routeQuery({ resolve: [makeResolveBinding(GDPR_WORK_URI)] }));
      await eurlex_get_relations.handler(
        eurlex_get_relations.input.parse({
          celex_number: '32016R0679',
          relation_types: ['cites'],
          limit: 25,
          offset: 25,
        }),
        createMockContext({ errors: eurlex_get_relations.errors }),
      );
      return mockQuery.mock.calls
        .map((c) => c[0] as string)
        .find((q) => q.includes('cdm:work_cites_work')) as string;
    };

    it('aggregates the related date as a string in both direction subqueries', async () => {
      const sparql = await citesQuery();
      expect(sparql.match(/\(MAX\(STR\(\?relatedDate\)\) AS \?relatedDateMax\)/g)).toHaveLength(2);
      expect(sparql).not.toContain('(MAX(?relatedDate)');
    });

    it('orders each direction newest-first with the work URI as tiebreak before paging', async () => {
      const sparql = await citesQuery();
      expect(
        sparql.match(/ORDER BY DESC\(\?relatedDateMax\) \?relatedWork LIMIT 26 OFFSET 25/g),
      ).toHaveLength(2);
    });

    it('orders the outer UNION by direction, date, then work URI', async () => {
      const sparql = await citesQuery();
      expect(
        sparql.trimEnd().endsWith('ORDER BY ?direction DESC(?relatedDateMax) ?relatedWork'),
      ).toBe(true);
    });

    it('keeps a related work with no date, after the dated ones', async () => {
      const dated = `${CELLAR}dated`;
      const undated = `${CELLAR}undated`;
      mockQuery.mockImplementation(
        routeQuery({
          resolve: [makeResolveBinding(GDPR_WORK_URI)],
          amendedBy: [
            {
              ...makeRelationBinding({ relatedWork: dated, direction: 'incoming' }),
              relatedDateMax: { type: 'literal', value: '2026-09-15' },
            },
            makeRelationBinding({ relatedWork: undated, direction: 'incoming' }),
          ],
        }),
      );

      const result = await eurlex_get_relations.handler(
        eurlex_get_relations.input.parse({
          celex_number: '32016R0679',
          relation_types: ['amended_by'],
        }),
        createMockContext({ errors: eurlex_get_relations.errors }),
      );

      expect(result.relations.map((r) => r.related_work_uri)).toEqual([dated, undated]);
      const sparql = mockQuery.mock.calls
        .map((c) => c[0] as string)
        .find((q) => q.includes('cdm:resource_legal_amends_resource_legal')) as string;
      expect(sparql).toContain('OPTIONAL { ?relatedWork cdm:work_date_document ?relatedDate . }');
    });
  });

  // --- #119: each relation row carries the related work's date and English title ---

  describe('related date and title (#119)', () => {
    const ENG = 'http://publications.europa.eu/resource/authority/language/ENG';

    /** The query issued for one relation type, on a limit-25 page at offset 25. */
    const relationQuery = async (type: 'cites' | 'amended_by', marker: string) => {
      mockQuery.mockImplementation(routeQuery({ resolve: [makeResolveBinding(GDPR_WORK_URI)] }));
      await eurlex_get_relations.handler(
        eurlex_get_relations.input.parse({
          celex_number: '32016R0679',
          relation_types: [type],
          limit: 25,
          offset: 25,
        }),
        createMockContext({ errors: eurlex_get_relations.errors }),
      );
      return mockQuery.mock.calls
        .map((c) => c[0] as string)
        .find((q) => q.includes(marker)) as string;
    };

    /** The title join: everything after the last per-direction subquery closes. */
    const afterPage = (sparql: string) =>
      sparql.slice(sparql.lastIndexOf('LIMIT 26 OFFSET 25 }') + 'LIMIT 26 OFFSET 25 }'.length);

    it.each([
      ['cites', 'cdm:work_cites_work', 2],
      ['amended_by', 'cdm:resource_legal_amends_resource_legal', 1],
    ] as const)(
      'joins the English title after paging in the %s query',
      async (type, marker, arms) => {
        const sparql = await relationQuery(type, marker);
        // The page is found first: each direction subquery is the unchanged paged form.
        expect(
          sparql.match(/ORDER BY DESC\(\?relatedDateMax\) \?relatedWork LIMIT 26 OFFSET 25 \}/g),
        ).toHaveLength(arms);
        // The title is joined once, outside the paged subqueries, so it touches the page's works alone.
        expect(sparql.match(/cdm:expression_title/g)).toHaveLength(1);
        const join = afterPage(sparql);
        expect(join).toContain('?relatedExpr cdm:expression_belongs_to_work ?relatedWork .');
        expect(join).toContain(`?relatedExpr cdm:expression_uses_language <${ENG}> .`);
        expect(join).toContain('?relatedExpr cdm:expression_title ?relatedTitle .');
        expect(sparql).toContain(
          'SELECT ?relatedWork ?relatedCelexSample ?direction ?relatedDateMax (MAX(STR(?relatedTitle)) AS ?relatedTitleMax) WHERE {',
        );
        expect(
          sparql
            .trimEnd()
            .endsWith(
              '} GROUP BY ?relatedWork ?relatedCelexSample ?direction ?relatedDateMax ORDER BY ?direction DESC(?relatedDateMax) ?relatedWork',
            ),
        ).toBe(true);
      },
    );

    it('returns each row’s date and English title in its ordered position, omitting either when absent', async () => {
      const titled = `${CELLAR}titled`;
      const untitled = `${CELLAR}untitled`;
      const undated = `${CELLAR}undated`;
      mockQuery.mockImplementation(
        routeQuery({
          resolve: [makeResolveBinding(GDPR_WORK_URI)],
          amendedBy: [
            {
              ...makeRelationBinding({
                relatedWork: titled,
                direction: 'incoming',
                relatedCelex: '32026R2099',
              }),
              relatedDateMax: { type: 'literal', value: '2026-09-21' },
              relatedTitleMax: {
                type: 'literal',
                value: 'Commission Implementing Regulation (EU) 2026/2099 of 21 September 2026',
              },
            },
            {
              ...makeRelationBinding({ relatedWork: untitled, direction: 'incoming' }),
              relatedDateMax: { type: 'literal', value: '2026-07-16' },
            },
            {
              ...makeRelationBinding({ relatedWork: undated, direction: 'incoming' }),
              relatedTitleMax: { type: 'literal', value: 'An undated act' },
            },
          ],
        }),
      );

      const result = await runToolContract(eurlex_get_relations, {
        celex_number: '32016R0679',
        relation_types: ['amended_by'],
      });

      const structured = eurlex_get_relations.output.parse(result.structuredContent);
      expect(structured.relations).toEqual([
        {
          relation_type: 'amended_by',
          direction: 'incoming',
          related_work_uri: titled,
          related_celex_number: '32026R2099',
          related_date: '2026-09-21',
          related_title: 'Commission Implementing Regulation (EU) 2026/2099 of 21 September 2026',
        },
        {
          relation_type: 'amended_by',
          direction: 'incoming',
          related_work_uri: untitled,
          related_date: '2026-07-16',
        },
        {
          relation_type: 'amended_by',
          direction: 'incoming',
          related_work_uri: undated,
          related_title: 'An undated act',
        },
      ]);

      const text = contentText(result);
      expect(text).toContain(
        `- 32026R2099 (${titled}) · 2026-09-21 · Commission Implementing Regulation (EU) 2026/2099 of 21 September 2026`,
      );
      expect(text).toContain(`- ${untitled} · 2026-07-16\n`);
      expect(text).toContain(`- ${undated} · An undated act\n`);
    });

    it('cuts a related date carrying a zone or time to its day, on both surfaces', async () => {
      mockQuery.mockImplementation(
        routeQuery({
          resolve: [makeResolveBinding(GDPR_WORK_URI)],
          amendedBy: [
            {
              ...makeRelationBinding({ relatedWork: `${CELLAR}zoned`, direction: 'incoming' }),
              relatedDateMax: { type: 'literal', value: '2026-09-21+02:00' },
            },
            {
              ...makeRelationBinding({ relatedWork: `${CELLAR}timed`, direction: 'incoming' }),
              relatedDateMax: { type: 'literal', value: '2026-07-16T00:00:00' },
            },
          ],
        }),
      );

      const result = await runToolContract(eurlex_get_relations, {
        celex_number: '32016R0679',
        relation_types: ['amended_by'],
      });

      const structured = eurlex_get_relations.output.parse(result.structuredContent);
      expect(structured.relations.map((r) => r.related_date)).toEqual(['2026-09-21', '2026-07-16']);
      const text = contentText(result);
      expect(text).toContain(`- ${CELLAR}zoned · 2026-09-21\n`);
      expect(text).not.toContain('+02:00');
      expect(text).not.toContain('T00:00:00');
    });

    it('carries the date after the member state on a national_transposition row', async () => {
      mockQuery.mockImplementation(
        routeQuery({
          resolve: [makeResolveBinding(DIRECTIVE_680_WORK_URI)],
          nationalTransposition: [
            {
              ...makeRelationBinding({
                relatedWork: CZECH_MEASURE_WORK_URI,
                direction: 'incoming',
                relatedCelex: '72016L0680CZE_225030',
              }),
              relatedDateMax: { type: 'literal', value: '2019-02-27' },
            },
          ],
        }),
      );

      const result = await runToolContract(eurlex_get_relations, {
        celex_number: '32016L0680',
        relation_types: ['national_transposition'],
      });

      const structured = eurlex_get_relations.output.parse(result.structuredContent);
      expect(structured.relations[0]).toMatchObject({
        related_member_state: 'CZE',
        related_date: '2019-02-27',
      });
      expect(structured.relations[0]).not.toHaveProperty('related_title');
      expect(contentText(result)).toContain(
        `- 72016L0680CZE_225030 (${CZECH_MEASURE_WORK_URI}) — member state CZE · 2019-02-27\n`,
      );
    });

    it('keeps the rows, order, has_more, and next_offset of a full page', async () => {
      const rows = [1, 2, 3].map((n) => ({
        ...makeRelationBinding({ relatedWork: `${CELLAR}amending-${n}`, direction: 'incoming' }),
        relatedDateMax: { type: 'literal', value: `2026-0${4 - n}-01` },
        relatedTitleMax: { type: 'literal', value: `Act ${n}` },
      }));
      mockQuery.mockImplementation(
        routeQuery({ resolve: [makeResolveBinding(GDPR_WORK_URI)], amendedBy: rows }),
      );

      const result = await eurlex_get_relations.handler(
        eurlex_get_relations.input.parse({
          celex_number: '32016R0679',
          relation_types: ['amended_by'],
          limit: 2,
        }),
        createMockContext({ errors: eurlex_get_relations.errors }),
      );

      expect(result.relations.map((r) => [r.related_work_uri, r.related_date])).toEqual([
        [`${CELLAR}amending-1`, '2026-03-01'],
        [`${CELLAR}amending-2`, '2026-02-01'],
      ]);
      expect(result).toMatchObject({ has_more: true, next_offset: 2 });
    });
  });

  // --- #112: an empty first page is an empty page, not an error ---

  describe('empty first page (#112)', () => {
    it('returns an empty page with a notice on both surfaces for a work with no edges of the requested types', async () => {
      mockQuery.mockImplementation(routeQuery({ resolve: [makeResolveBinding(GDPR_WORK_URI)] }));

      const result = await runToolContract(eurlex_get_relations, {
        celex_number: '32016R0679',
        relation_types: ['repeals', 'implicitly_repeals'],
      });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured).toMatchObject({
        celex_number: '32016R0679',
        work_uri: GDPR_WORK_URI,
        relations: [],
        total: 0,
        offset: 0,
        has_more: false,
        requested_relation_types: ['repeals', 'implicitly_repeals'],
        empty_relation_types: ['repeals', 'implicitly_repeals'],
      });
      expect(structured).not.toHaveProperty('next_offset');
      expect(structured).not.toHaveProperty('truncated');
      const notice = structured.notice as string;
      expect(notice).toContain('32016R0679');
      expect(notice).toContain(
        'Try other relation_types or omit the filter to fetch all available relation types.',
      );
      expect(notice).not.toContain('eurlex_get_document');

      const text = contentText(result);
      expect(text).toContain(`> ${notice}`);
      expect(text).toContain('**Has more:** false');
      expect(text).toContain('**Empty types (this page):** repeals, implicitly_repeals');
    });

    it('points an unchecked work URI at eurlex_get_document in the notice', async () => {
      mockQuery.mockImplementation(routeQuery({}));

      const workUri = `${CELLAR}zzqx-no-such-work`;
      const result = await runToolContract(eurlex_get_relations, {
        work_uri: workUri,
        relation_types: ['cites'],
      });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured).toMatchObject({
        work_uri: workUri,
        relations: [],
        total: 0,
        has_more: false,
        empty_relation_types: ['cites'],
      });
      expect(structured.notice).toContain(workUri);
      expect(structured.notice).toContain('eurlex_get_document');
      expect(contentText(result)).toContain(`> ${structured.notice as string}`);
    });

    it('bounds an oversized work URI echoed in the notice', async () => {
      mockQuery.mockImplementation(routeQuery({}));

      const workUri = `${CELLAR}${'z'.repeat(5000)}`;
      const result = await runToolContract(eurlex_get_relations, {
        work_uri: workUri,
        relation_types: ['cites'],
      });

      const notice = (result.structuredContent as { notice?: string }).notice ?? '';
      expect(notice).toContain(`Work ${workUri.slice(0, 100)}… has no CDM relations`);
      expect(notice).not.toContain(workUri.slice(0, 101));
      expect(notice.length).toBeLessThan(500);
      expect(contentText(result)).toContain(`> ${notice}`);
    });

    it('names the next offset in the notice of a page with more rows', async () => {
      mockQuery.mockImplementation(
        routeQuery({
          resolve: [makeResolveBinding(GDPR_WORK_URI)],
          amendedBy: [1, 2, 3].map((n) =>
            makeRelationBinding({ relatedWork: `${CELLAR}amending-${n}`, direction: 'incoming' }),
          ),
        }),
      );

      const result = await runToolContract(eurlex_get_relations, {
        celex_number: '32016R0679',
        relation_types: ['amended_by'],
        limit: 2,
      });

      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured).toMatchObject({ has_more: true, next_offset: 2, truncated: true });
      expect(structured.notice).toContain('offset=2');
      expect(contentText(result)).toContain(`> ${structured.notice as string}`);
    });
  });

  // --- #109: consolidated_version follows the based-on link ---

  describe('consolidated_version via the based-on link (#109)', () => {
    it.each([
      ['22006A0901(01)', '02006A0901(01)-20090301'],
      // Numbered differently from its act: the based-on link is the only tie.
      ['32000O0007', '02000X0776-20110201'],
    ])('%s lists its consolidated version %s', async (celex, consolidated) => {
      const sourceWork = `${CELLAR}source-${celex}`;
      mockQuery.mockImplementation(async (q: string) => {
        if (isResolutionQuery(q)) return resolveRowsFor(q, [makeResolveBinding(sourceWork)]);
        if (
          q.includes(`?relatedWork cdm:act_consolidated_based_on_resource_legal <${sourceWork}>`)
        ) {
          return [
            makeRelationBinding({
              relatedWork: `${CELLAR}consolidation`,
              direction: 'incoming',
              relatedCelex: consolidated,
            }),
          ];
        }
        return [];
      });

      const result = await runToolContract(eurlex_get_relations, {
        celex_number: celex,
        relation_types: ['consolidated_version'],
      });

      const structured = result.structuredContent as {
        relations: { relation_type: string; related_celex_number?: string }[];
      };
      expect(structured.relations).toEqual([
        expect.objectContaining({
          relation_type: 'consolidated_version',
          related_celex_number: consolidated,
        }),
      ]);
      expect(contentText(result)).toContain(consolidated);
      const relSparql = mockQuery.mock.calls
        .map((c) => c[0] as string)
        .find((q) => q.includes('?relatedWork cdm:act_consolidated')) as string;
      expect(relSparql).not.toContain('act_consolidated_consolidates');
      expect(relSparql).not.toContain('REGEX');
    });
  });
});
