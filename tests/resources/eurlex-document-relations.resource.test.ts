/**
 * @fileoverview Tests for eurlex://document/{celexNumber}/relations resource.
 * @module tests/resources/eurlex-document-relations.resource.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eurlex_document_relations_resource } from '@/mcp-server/resources/definitions/eurlex-document-relations.resource.js';
import { escapeSparqlLiteral } from '@/services/cellar-sparql/eli-resolution.js';
import {
  CELLAR,
  canonicalWork,
  celexWorkRows,
  isResolutionQuery,
  requestedCelex,
} from '../fixtures/cellar-works.js';

// --- Service mock ---
const mockQuery = vi.fn();
// maxResults mirrors the real service ceiling; the handler clamps the summary cap to it.
vi.mock('@/services/cellar-sparql/cellar-sparql-service.js', () => ({
  getCellarSparqlService: () => ({
    query: mockQuery,
    queryWithContinuation: mockQuery,
    maxResults: 100,
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

type Row = Record<string, { type: string; value: string }>;

function makeResolveBinding(workUri: string): Row {
  return { work: { type: 'uri', value: workUri } };
}

/** The resolve rows, each stamped with the CELEX the resolution query asked for. */
function resolveRowsFor(q: string, rows: Row[] = []): Row[] {
  const [celex = ''] = requestedCelex(q);
  return rows.map((row) => ({ celexNumber: { type: 'literal', value: celex }, ...row }));
}

/**
 * A relation row as the per-type query projects it — the CELEX arrives under the
 * aggregate alias `?relatedCelexSample`, the only key the traversal reads.
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
  nationalTransposition?: Row[];
}) {
  return async (q: string): Promise<Row[]> => {
    // Tolerate any unrecognized call shape (e.g. a stray no-arg call from the
    // test harness's async cleanup) — an unmatched query yields no rows.
    if (typeof q !== 'string') return [];
    if (isResolutionQuery(q)) return resolveRowsFor(q, handlers.resolve);
    if (q.includes('cdm:work_cites_work')) return handlers.cites ?? [];
    if (q.includes('cdm:act_consolidated_based_on_resource_legal'))
      return handlers.consolidated ?? [];
    if (q.includes('cdm:measure_national_implementing_implements_resource_legal'))
      return handlers.nationalTransposition ?? [];
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
  beforeEach(() => {
    mockQuery.mockReset();
  });

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

    const params = eurlex_document_relations_resource.params!.parse({ celexNumber: '32016R0679' });
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
    // #39: a lightly-related act does not fill the summary cap.
    expect((result as Record<string, unknown>).truncated).toBe(false);
    expect((result as Record<string, unknown>).continuation).toBeUndefined();
  });

  // --- #71: the summary exposes continuation only with exact proof ---

  it('does not disclose continuation for an exactly-full final summary page', async () => {
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    // 25 incoming amenders = the public summary cap, with no 26th sentinel row.
    const manyAmenders = Array.from({ length: 25 }, (_, i) =>
      makeRelationBinding({
        relatedWork: `http://publications.europa.eu/resource/cellar/amender-${i}`,
        direction: 'incoming',
        relatedCelex: `3202${i % 10}R${1000 + i}`,
      }),
    );
    mockQuery.mockImplementation(
      routeQuery({ resolve: [makeResolveBinding(GDPR_WORK_URI)], amendedBy: manyAmenders }),
    );

    const params = eurlex_document_relations_resource.params!.parse({ celexNumber: '32016R0679' });
    const result = (await eurlex_document_relations_resource.handler(params, ctx)) as Record<
      string,
      unknown
    >;

    expect(result.truncated).toBe(false);
    expect(result.continuation).toBeUndefined();
    // Incoming edges are ordered newest-first so the summary keeps the most recent.
    const relSparql = mockQuery.mock.calls
      .map((c) => c[0] as string)
      .find((q) => !isResolutionQuery(q))!;
    expect(relSparql).toContain('ORDER BY DESC(?relatedDateMax)');
    expect(relSparql).toContain('LIMIT 26');
  });

  it('caps the summary and adds machine-readable expanded-traversal guidance when proven', async () => {
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const manyAmenders = Array.from({ length: 26 }, (_, i) =>
      makeRelationBinding({
        relatedWork: `http://publications.europa.eu/resource/cellar/amender-${i}`,
        direction: 'incoming',
        relatedCelex: `3202${i % 10}R${1000 + i}`,
      }),
    );
    mockQuery.mockImplementation(
      routeQuery({ resolve: [makeResolveBinding(GDPR_WORK_URI)], amendedBy: manyAmenders }),
    );

    const params = eurlex_document_relations_resource.params!.parse({ celexNumber: '32016R0679' });
    const result = (await eurlex_document_relations_resource.handler(params, ctx)) as Record<
      string,
      unknown
    >;

    expect(result.truncated).toBe(true);
    expect(result.relations).toHaveLength(25);
    expect(result.continuation).toEqual({
      kind: 'expanded_traversal',
      tool: 'eurlex_get_relations',
      input: { celex_number: '32016R0679' },
    });
    expect(JSON.stringify(result.continuation)).not.toContain('offset');
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

    const params = eurlex_document_relations_resource.params!.parse({ celexNumber: '32012R0528' });
    const result = await eurlex_document_relations_resource.handler(params, ctx);

    const relations = (result as Record<string, unknown>).relations as Array<
      Record<string, unknown>
    >;
    const types = relations.map((r) => r.relation_type);
    expect(types).toContain('amended_by');
    expect(types).toContain('consolidated_version');
  });

  it('surfaces the directive-matching national transposition measure (#56)', async () => {
    const ctx = createMockContext({ tenantId: 'test-tenant' });
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

    const params = eurlex_document_relations_resource.params!.parse({
      celexNumber: '32016L0680',
    });
    const result = (await eurlex_document_relations_resource.handler(params, ctx)) as Record<
      string,
      unknown
    >;

    expect(result.relations).toContainEqual({
      relation_type: 'national_transposition',
      direction: 'incoming',
      related_work_uri: CZECH_MEASURE_WORK_URI,
      related_celex_number: '72016L0680CZE_225030',
      related_member_state: 'CZE',
    });
    const sparql = mockQuery.mock.calls
      .map((call) => call[0] as string)
      .find((query) =>
        query.includes('cdm:measure_national_implementing_implements_resource_legal'),
      )!;
    expect(sparql).toContain('REGEX(STR(?relatedCelex), "^72016L0680[A-Z]{3}")');
  });

  // --- #85: national_transposition rows carry the member state ---

  it('carries related_member_state on national_transposition rows and on no other type (#85)', async () => {
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    mockQuery.mockImplementation(
      routeQuery({
        resolve: [makeResolveBinding(DIRECTIVE_680_WORK_URI)],
        nationalTransposition: [
          makeRelationBinding({
            relatedWork: CZECH_MEASURE_WORK_URI,
            direction: 'incoming',
            relatedCelex: '72016L0680CZE_202505539',
          }),
          makeRelationBinding({
            relatedWork: 'http://publications.europa.eu/resource/cellar/uk-measure',
            direction: 'incoming',
            relatedCelex: '72016L0680GBR_201812345',
          }),
        ],
        // A citing work that is itself a sector-7 measure: still no member state.
        cites: [
          makeRelationBinding({
            relatedWork: 'http://publications.europa.eu/resource/cellar/citing-measure',
            direction: 'incoming',
            relatedCelex: '72016L0680DEU_000001',
          }),
        ],
      }),
    );

    const params = eurlex_document_relations_resource.params!.parse({ celexNumber: '32016L0680' });
    const result = (await eurlex_document_relations_resource.handler(params, ctx)) as Record<
      string,
      unknown
    >;
    const relations = result.relations as Array<Record<string, unknown>>;

    expect(relations).toContainEqual({
      relation_type: 'national_transposition',
      direction: 'incoming',
      related_work_uri: CZECH_MEASURE_WORK_URI,
      related_celex_number: '72016L0680CZE_202505539',
      related_member_state: 'CZE',
    });
    expect(
      relations.find((r) => r.related_celex_number === '72016L0680GBR_201812345')
        ?.related_member_state,
    ).toBe('GBR');
    const cite = relations.find((r) => r.relation_type === 'cites');
    expect(cite).toBeDefined();
    expect(cite).not.toHaveProperty('related_member_state');
  });

  // --- #92: typed exact CELEX triple ---

  it('resolves the CELEX through a typed literal, not a STR() scan (#92)', async () => {
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    mockQuery.mockImplementation(routeQuery({ resolve: [makeResolveBinding(GDPR_WORK_URI)] }));

    const params = eurlex_document_relations_resource.params!.parse({ celexNumber: '32016R0679' });
    await eurlex_document_relations_resource.handler(params, ctx);

    const resolve = mockQuery.mock.calls
      .map((c) => c[0] as string)
      .filter((q) => q.includes('"32016R0679"'));
    expect(resolve).toHaveLength(1);
    expect(resolve[0]).toContain('VALUES ?celexNumber { "32016R0679"^^xsd:string }');
    expect(resolve[0]).toContain('?work cdm:resource_legal_id_celex ?celexNumber .');
    expect(resolve[0]).not.toMatch(/STR\(\?\w+\)\s*=/);
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

    const params = eurlex_document_relations_resource.params!.parse({ celexNumber: '32016R0679' });
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

  // --- #32/#109: the resource inherits the consolidated_version CELEX requirement ---

  it('keeps CELEX-bearing consolidated_version rows and drops CELEX-less ones', async () => {
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
            relatedWork:
              'http://publications.europa.eu/resource/cellar/69c567aa-0ce3-4ba7-b13d-7142a9225a3c',
            direction: 'incoming',
          }),
        ],
      }),
    );

    const params = eurlex_document_relations_resource.params!.parse({ celexNumber: '32016R0679' });
    const result = await eurlex_document_relations_resource.handler(params, ctx);

    const relations = (result as Record<string, unknown>).relations as Array<
      Record<string, unknown>
    >;
    const consolidated = relations.filter((r) => r.relation_type === 'consolidated_version');
    expect(consolidated).toHaveLength(1);
    expect(consolidated[0]?.related_celex_number).toBe('02016R0679-20160504');
  });

  // --- #45: filtered consolidated_version artifacts must not set the summary's truncated flag ---

  it('does not set truncated when filtered consolidated_version artifacts fill the summary cap but valid rows are under it (issue #45)', async () => {
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    // 25 raw consolidated rows = the SUMMARY_PER_TYPE_LIMIT: one CELEX-bearing
    // consolidation plus 24 CELEX-less CONS_TEXT members. The raw page fills the cap,
    // but only the genuine row survives the filter — the resource must not flag truncation.
    const consolidatedRaw = [
      makeRelationBinding({
        relatedWork: 'http://publications.europa.eu/resource/cellar/genuine',
        direction: 'incoming',
        relatedCelex: '02016R0679-20160504',
      }),
      ...Array.from({ length: 24 }, (_, i) =>
        makeRelationBinding({
          relatedWork: `http://publications.europa.eu/resource/cellar/artifact-${i}`,
          direction: 'incoming',
        }),
      ),
    ];
    mockQuery.mockImplementation(
      routeQuery({ resolve: [makeResolveBinding(GDPR_WORK_URI)], consolidated: consolidatedRaw }),
    );

    const params = eurlex_document_relations_resource.params!.parse({ celexNumber: '32016R0679' });
    const result = (await eurlex_document_relations_resource.handler(params, ctx)) as Record<
      string,
      unknown
    >;

    const relations = result.relations as Array<Record<string, unknown>>;
    const consolidated = relations.filter((r) => r.relation_type === 'consolidated_version');
    expect(consolidated).toHaveLength(1);
    expect(consolidated[0]?.related_celex_number).toBe('02016R0679-20160504');
    // The 24 filtered-out artifacts must not raise the summary's truncation flag.
    expect(result.truncated).toBe(false);
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

    const params = eurlex_document_relations_resource.params!.parse({ celexNumber: '32016R0679' });
    const result = await eurlex_document_relations_resource.handler(params, ctx);

    const relations = (result as Record<string, unknown>).relations as unknown[];
    expect(relations).toHaveLength(1);
  });

  it('returns empty relations array when every relation query returns no bindings', async () => {
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    mockQuery.mockImplementation(routeQuery({ resolve: [makeResolveBinding(GDPR_WORK_URI)] }));

    const params = eurlex_document_relations_resource.params!.parse({ celexNumber: '32016R0679' });
    const result = await eurlex_document_relations_resource.handler(params, ctx);

    const relations = (result as Record<string, unknown>).relations as unknown[];
    expect(relations).toHaveLength(0);
    expect((result as Record<string, unknown>).total).toBe(0);
  });

  // --- Error path: not found ---

  it('throws notFound when CELEX resolves to no work URI', async () => {
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    mockQuery.mockImplementation(routeQuery({ resolve: [] }));

    const params = eurlex_document_relations_resource.params!.parse({ celexNumber: '99999X0000' });
    await expect(eurlex_document_relations_resource.handler(params, ctx)).rejects.toThrow(
      'No CELLAR work',
    );
  });

  // --- #61: SPARQL literal escaping routes through the shared helper ---
  //
  // This resource built its resolve query the same hand-rolled, quote-only way
  // eurlex://document/{celexNumber} did: no backslash pass, so a CELEX ending in
  // `\` escaped the closing quote, the literal never terminated, and Virtuoso's
  // raw SP030 error — internal query text attached — replaced the not_found.

  it('escapes a trailing backslash in the resolve query so the literal terminates (#61)', async () => {
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    mockQuery.mockImplementation(routeQuery({ resolve: [] }));

    const celexNumber = '32016R0679\\';
    // The CELEX shape gate refuses the backslash outright, so no query is built
    // from it; escaping below is the second line of defense behind that gate.
    expect(() => eurlex_document_relations_resource.params!.parse({ celexNumber })).toThrow();
    // The resource's own declared error, not a leaked backend compiler error.
    await expect(eurlex_document_relations_resource.handler({ celexNumber }, ctx)).rejects.toThrow(
      'No CELLAR work',
    );

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sparql).toContain(
      `VALUES ?celexNumber { "${escapeSparqlLiteral(celexNumber)}"^^xsd:string }`,
    );
    // The unterminated form the quote-only pass produced is gone.
    expect(sparql).not.toContain(String.raw`"32016R0679\"^^`);
  });

  it('leaves an ordinary CELEX byte-identical through the shared helper (#61)', async () => {
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    mockQuery.mockImplementation(routeQuery({ resolve: [makeResolveBinding(GDPR_WORK_URI)] }));

    const params = eurlex_document_relations_resource.params!.parse({ celexNumber: '32016R0679' });
    await eurlex_document_relations_resource.handler(params, ctx);

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    // No regression for the overwhelmingly common input: escaping is a no-op.
    expect(sparql).toContain('VALUES ?celexNumber { "32016R0679"^^xsd:string }');
  });

  // --- #69: CELEX shape gate on the path parameter ---

  describe('CELEX shape validation (#69)', () => {
    it.each([
      ['a bare zero', '0'],
      ['a stray word', 'hello'],
      ['whitespace only', '   '],
      ['an empty path segment', ''],
      ['a value with an embedded newline', '32016R0679\nGDPR'],
    ])('rejects %s before any CELLAR request', (_label, value) => {
      expect(() =>
        eurlex_document_relations_resource.params!.parse({ celexNumber: value }),
      ).toThrow();
      expect(mockQuery).not.toHaveBeenCalled();
    });

    /**
     * Slash-bearing CELEX values (11957A/PRO/CJ/09, C/2026/01104) are deliberately
     * absent: the SDK expands `{celexNumber}` to `([^/]+)`, so
     * `eurlex://document/11957A/PRO/CJ/09/relations` can never match this template
     * regardless of what the schema accepts. Those values stay on the
     * eurlex_get_relations tool's table, which is the reachable surface for them.
     */
    it.each([
      ['sector 0, consolidated version', '02016R0679-20160504'],
      ['sector 3, regulation', '32016R0679'],
      ['sector 3, corrigendum marker', '32016R0679R(02)'],
      ['sector 6, case law', '62024CJ0629'],
      ['sector 7, national implementing measure', '72014L0056FIN_240353'],
      ['sector E, EFTA document', 'E2016C0186'],
    ])('accepts a real %s', (_label, celex) => {
      expect(() =>
        eurlex_document_relations_resource.params!.parse({ celexNumber: celex }),
      ).not.toThrow();
    });
  });

  // --- CELEX input normalization on the path parameter ---

  describe('CELEX normalization', () => {
    it('trims surrounding whitespace before validating', () => {
      expect(
        eurlex_document_relations_resource.params!.parse({ celexNumber: '   32016R0679   ' })
          .celexNumber,
      ).toBe('32016R0679');
    });

    it('uppercases a lowercase CELEX before validating', () => {
      expect(
        eurlex_document_relations_resource.params!.parse({ celexNumber: '32016r0679' }).celexNumber,
      ).toBe('32016R0679');
    });

    it('still rejects a whitespace-only value, which trims to empty', () => {
      expect(() =>
        eurlex_document_relations_resource.params!.parse({ celexNumber: '   ' }),
      ).toThrow();
    });

    it('hands the handler the normalized CELEX', async () => {
      const ctx = createMockContext({ tenantId: 'test-tenant' });
      mockQuery.mockImplementation(routeQuery({ resolve: [makeResolveBinding(GDPR_WORK_URI)] }));

      const params = eurlex_document_relations_resource.params!.parse({
        celexNumber: ' 32016r0679 ',
      });
      const result = await eurlex_document_relations_resource.handler(params, ctx);

      expect(mockQuery.mock.calls[0]?.[0] as string).toContain(
        'VALUES ?celexNumber { "32016R0679"^^xsd:string }',
      );
      expect(result).toMatchObject({ celex_number: '32016R0679' });
    });
  });

  // --- #97: a CELEX held by several works summarizes its canonical work ---

  it('summarizes the canonical work of 62022TJ0181 (#97)', async () => {
    const citer = `${CELLAR}citer`;
    mockQuery.mockImplementation(async (q: string) => {
      if (typeof q !== 'string') return [];
      if (q.includes('cdm:work_cites_work')) {
        return q.includes(`<${canonicalWork('62022TJ0181')}>`)
          ? [makeRelationBinding({ relatedWork: citer, direction: 'incoming' })]
          : [];
      }
      if (q.includes('cdm:resource_legal_id_celex "') || q.includes('owl#sameAs')) {
        return celexWorkRows(q);
      }
      return [];
    });

    const params = eurlex_document_relations_resource.params!.parse({ celexNumber: '62022TJ0181' });
    const result = (await eurlex_document_relations_resource.handler(
      params,
      createMockContext({ tenantId: 'test-tenant' }),
    )) as Record<string, unknown>;

    expect(result.work_uri).toBe(canonicalWork('62022TJ0181'));
    expect(result.relations).toEqual([
      { relation_type: 'cites', direction: 'incoming', related_work_uri: citer },
    ]);
  });

  // --- #119: rows carry the related work's date and English title ---

  it('carries related_date and related_title on each row, omitting either when absent (#119)', async () => {
    const titled = `${CELLAR}titled`;
    const bare = `${CELLAR}bare`;
    mockQuery.mockImplementation(
      routeQuery({
        resolve: [makeResolveBinding(GDPR_WORK_URI)],
        cites: [
          {
            ...makeRelationBinding({
              relatedWork: titled,
              direction: 'incoming',
              relatedCelex: '62024CJ0001',
            }),
            relatedDateMax: { type: 'literal', value: '2026-09-01' },
            relatedTitleMax: {
              type: 'literal',
              value: 'Judgment of the Court of 1 September 2026.',
            },
          },
          makeRelationBinding({ relatedWork: bare, direction: 'incoming' }),
        ],
      }),
    );

    const params = eurlex_document_relations_resource.params!.parse({ celexNumber: '32016R0679' });
    const result = (await eurlex_document_relations_resource.handler(
      params,
      createMockContext({ tenantId: 'test-tenant' }),
    )) as { relations: Record<string, string>[] };

    expect(result.relations).toEqual([
      {
        relation_type: 'cites',
        direction: 'incoming',
        related_work_uri: titled,
        related_celex_number: '62024CJ0001',
        related_date: '2026-09-01',
        related_title: 'Judgment of the Court of 1 September 2026.',
      },
      { relation_type: 'cites', direction: 'incoming', related_work_uri: bare },
    ]);
    const cites = mockQuery.mock.calls
      .map((c) => c[0] as string)
      .find((q) => q.includes('cdm:work_cites_work')) as string;
    expect(cites).toContain('(MAX(STR(?relatedTitle)) AS ?relatedTitleMax)');
  });

  // --- #100: the summary is newest-first and identical on every read ---

  it('orders every summary query by string date, then work URI, at both levels (#100)', async () => {
    mockQuery.mockImplementation(routeQuery({ resolve: [makeResolveBinding(GDPR_WORK_URI)] }));

    const params = eurlex_document_relations_resource.params!.parse({ celexNumber: '32016R0679' });
    await eurlex_document_relations_resource.handler(
      params,
      createMockContext({ tenantId: 'test-tenant' }),
    );

    const relationQueries = mockQuery.mock.calls
      .map((c) => c[0] as string)
      .filter((q) => q.includes('?relatedWork'));
    expect(relationQueries.length).toBeGreaterThan(0);
    for (const q of relationQueries) {
      expect(q).toContain('(MAX(STR(?relatedDate)) AS ?relatedDateMax)');
      expect(q).toContain('ORDER BY DESC(?relatedDateMax) ?relatedWork LIMIT 26 OFFSET 0');
    }
    const cites = relationQueries.find((q) => q.includes('cdm:work_cites_work')) as string;
    expect(cites.trimEnd().endsWith('ORDER BY ?direction DESC(?relatedDateMax) ?relatedWork')).toBe(
      true,
    );
  });
});
