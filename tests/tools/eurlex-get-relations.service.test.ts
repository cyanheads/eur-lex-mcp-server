/**
 * @fileoverview Relation paging and provisions through the actual CELLAR service and wire contract.
 * @module tests/tools/eurlex-get-relations.service.test
 */

import { createHash } from 'node:crypto';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { eurlex_get_relations } from '@/mcp-server/tools/definitions/eurlex-get-relations.tool.js';
import { initCellarSparqlService } from '@/services/cellar-sparql/cellar-sparql-service.js';
import { RELATION_TYPES } from '@/services/cellar-sparql/relation-traversal.js';
import { CELLAR, isResolutionQuery, requestedCelex } from '../fixtures/cellar-works.js';
import { readCommonMark } from '../helpers/commonmark.js';

afterEach(() => vi.unstubAllGlobals());

/** The actual CELLAR service, pointed at a stubbed endpoint with a 100-row ceiling. */
function initService() {
  initCellarSparqlService({} as AppConfig, {} as StorageService, {
    cellarSparqlEndpoint: 'http://cellar.test/sparql',
    eurLexContentBaseUrl: 'http://content.test',
    sparqlQueryTimeoutMs: 5000,
    maxSparqlResults: 100,
  });
}

it('walks actual-service multi-direction pages to exhaustion and preserves omitted/all equivalence', async () => {
  initService();
  const title = 'é漢😀"\\\r\n'.repeat(300);
  const bindings = (direction: string, count: number) =>
    Array.from({ length: count }, (_, i) => ({
      relatedWork: { type: 'uri', value: `http://example.test/shared-${i}` },
      direction: { type: 'literal', value: direction },
      relatedTitleMax: { type: 'literal', value: title },
    }));
  const arms = [bindings('incoming', 31), bindings('outgoing', 4)];
  const queries: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const query = new URLSearchParams(String(init.body)).get('query') ?? '';
      queries.push(query);
      const match = /LIMIT (\d+) OFFSET (\d+)/.exec(query);
      const rows =
        query.includes('cdm:work_cites_work') && match
          ? arms.flatMap((arm) => arm.slice(Number(match[2]), Number(match[2]) + Number(match[1])))
          : [];
      return new Response(
        JSON.stringify({
          head: { vars: ['relatedWork', 'direction', 'relatedTitleMax'] },
          results: { bindings: rows },
        }),
      );
    }),
  );
  const input = { work_uri: 'http://example.test/source' };
  const first = await runToolContract(eurlex_get_relations, input);
  const explicit = await runToolContract(eurlex_get_relations, {
    ...input,
    relation_types: [...RELATION_TYPES],
  });
  expect(explicit).toEqual(first);
  const keys: string[] = [];
  let offset = 0;
  let calls = 0;
  for (; calls < 40; calls++) {
    const result = await runToolContract(eurlex_get_relations, { ...input, offset });
    expect(result.isError).not.toBe(true);
    const page = result.structuredContent as {
      relations: { direction: string; related_work_uri: string; related_title: string }[];
      next_offset?: number;
      has_more: boolean;
      cap?: number;
    };
    for (const row of page.relations) {
      keys.push(`${row.direction}:${row.related_work_uri}`);
      expect(row.related_title).toBe(title);
      // content[] carries the title escaped; a CommonMark reader gets it back, CRLF as LF.
      expect(
        result.content.some(
          (block) =>
            block.type === 'text' &&
            readCommonMark(block.text).includes(title.replace(/\r\n/g, '\n')),
        ),
      ).toBe(true);
    }
    if (offset >= 4) expect(page.relations.every((row) => row.direction === 'incoming')).toBe(true);
    if (!page.has_more) break;
    if (page.next_offset === undefined) throw new Error('Missing continuation');
    // The default limit of 10 is the page: every arm serves it whole (#183).
    expect(page.cap).toBe(10);
    expect(page.next_offset).toBe(offset + 10);
    offset = page.next_offset;
  }
  // 31 incoming rows at 10 a page: the walk ends on its fourth call, at offset 30.
  expect(calls).toBe(3);
  expect(offset).toBe(30);
  expect(keys.toSorted()).toEqual(
    [
      ...Array.from({ length: 31 }, (_, i) => `incoming:http://example.test/shared-${i}`),
      ...Array.from({ length: 4 }, (_, i) => `outgoing:http://example.test/shared-${i}`),
    ].toSorted(),
  );
  expect(new Set(keys).size).toBe(35);
  expect(queries.every((query) => query.startsWith('PREFIX'))).toBe(true);
});

it('sends related_sectors through the actual service inside each arm and pages matching works only (#191)', async () => {
  initService();
  /** One direction's related works, newest first; `-` marks a work with no CELEX. */
  const works = (direction: string, sectors: string[]) =>
    sectors.map((sector, i) => ({
      work: `http://example.test/${direction}-${i}`,
      ...(sector === '-' ? {} : { celex: `${sector}2020R${String(i).padStart(4, '0')}` }),
    }));
  const arms: Record<string, { work: string; celex?: string }[]> = {
    outgoing: works('outgoing', ['3', '5', '-', '3']),
    incoming: works('incoming', ['6', '3', '-', '3', '5', '3']),
  };
  const queries: string[] = [];
  let identityLookups = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const query = new URLSearchParams(String(init.body)).get('query') ?? '';
      // An incoming arm reads the work's CELEX identity first (#199); it names none here.
      if (query.includes('SELECT ?sourceCelex WHERE')) identityLookups++;
      else queries.push(query);
      // CELLAR: each arm keeps the CELEX-bearing works its SUBSTR test lists, then pages.
      const bindings = query.includes('cdm:work_cites_work')
        ? query.split(' UNION ').flatMap((arm) => {
            const direction = arm.includes('BIND("incoming" AS ?direction)')
              ? 'incoming'
              : 'outgoing';
            const [, limit = '0', offset = '0'] = /LIMIT (\d+) OFFSET (\d+)/.exec(arm) ?? [];
            const listed =
              /SUBSTR\(STR\(\?relatedCelex\), 1, 1\) IN \(([^)]*)\)/.exec(arm)?.[1] ?? '';
            return (arms[direction] ?? [])
              .filter((w) => w.celex && listed.includes(`"${w.celex[0]}"`))
              .slice(Number(offset), Number(offset) + Number(limit))
              .map((w) => ({
                relatedWork: { type: 'uri', value: w.work },
                direction: { type: 'literal', value: direction },
                relatedCelexSample: { type: 'literal', value: w.celex },
              }));
          })
        : [];
      return new Response(JSON.stringify({ head: { vars: [] }, results: { bindings } }));
    }),
  );

  const keys: string[] = [];
  const hasMore: boolean[] = [];
  let offset: number | undefined = 0;
  while (offset !== undefined) {
    const result = await runToolContract(eurlex_get_relations, {
      work_uri: 'http://example.test/source',
      relation_types: ['cites'],
      related_sectors: ['3'],
      limit: 2,
      offset,
    });
    expect(result.isError).not.toBe(true);
    const page = eurlex_get_relations.output.parse(result.structuredContent);
    for (const row of page.relations) keys.push(`${row.direction}:${row.related_celex_number}`);
    hasMore.push(page.has_more);
    offset = page.next_offset;
  }

  // Two outgoing and three incoming sector-3 works at 2 a page: two pages.
  expect(hasMore).toEqual([true, false]);
  expect(keys.toSorted()).toEqual(
    [
      'outgoing:32020R0000',
      'outgoing:32020R0003',
      'incoming:32020R0001',
      'incoming:32020R0003',
      'incoming:32020R0005',
    ].toSorted(),
  );
  expect(queries).toHaveLength(2);
  expect(identityLookups).toBe(2);
  for (const query of queries) {
    expect(query.startsWith('PREFIX')).toBe(true);
    expect(query.split('FILTER(SUBSTR(STR(?relatedCelex), 1, 1) IN ("3"))')).toHaveLength(3);
  }
});

it('reads all of an edge’s provisions through the actual service, past its row ceiling (#168)', async () => {
  initService();
  const fd = 'http://publications.europa.eu/resource/authority/fd_370';
  const amended = 'http://example.test/32013R0575';
  // 755 designators on one edge, each recorded twice, as 32024R1623 amends 32013R0575.
  const locations = Array.from(
    { length: 755 },
    (_, i) => `{AR|${fd}/AR} ${i + 1} {PA|${fd}/PA} ${(i % 9) + 1}`,
  );
  const sent: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      if (new URL(url).hostname !== 'cellar.test') throw new Error(`Unexpected host: ${url}`);
      const query = new URLSearchParams(String(init.body)).get('query') ?? '';
      sent.push(query);
      const bindings = query.includes('?location')
        ? [...locations, ...locations].map((location) => ({
            relatedWork: { type: 'uri', value: amended },
            location: { type: 'literal', value: location },
          }))
        : query.includes('cdm:resource_legal_amends_resource_legal ?relatedWork')
          ? [
              {
                relatedWork: { type: 'uri', value: amended },
                direction: { type: 'literal', value: 'outgoing' },
                relatedCelexSample: { type: 'literal', value: '32013R0575' },
              },
            ]
          : [];
      return new Response(JSON.stringify({ head: { vars: [] }, results: { bindings } }));
    }),
  );

  const result = await runToolContract(eurlex_get_relations, {
    work_uri: 'http://example.test/32024R1623',
    relation_types: ['amends'],
  });

  const page = eurlex_get_relations.output.parse(result.structuredContent);
  const provisions = page.relations[0]?.provisions ?? [];
  expect(provisions).toHaveLength(755);
  expect(provisions).toContain('AR 43 PA 7');
  expect(provisions.some((p) => p.includes('{'))).toBe(false);
  const followUp = sent.find((query) => query.includes('?location')) ?? '';
  // The internal path leaves the LIMIT-less follow-up uncapped.
  expect(followUp).not.toMatch(/LIMIT/);
  expect(followUp.startsWith('PREFIX')).toBe(true);
  // Every provision rides the row, with nothing withheld and no notice (#183).
  expect(result.structuredContent).not.toHaveProperty('notice');
});

/**
 * The relation page, provisions follow-up, and per-member-state count queries a call
 * sends, through the actual service, sorted (the types run concurrently). CELEX
 * resolution and the held-CELEX lookup belong to their own modules and are left out.
 * Every page answers three rows per direction, so every annotated type sends its
 * follow-up; each CELEX resolves to `work-{CELEX}`.
 */
async function relationQueriesFor(input: Record<string, unknown>): Promise<string[]> {
  initService();
  const sent: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const query = new URLSearchParams(String(init.body)).get('query') ?? '';
      if (isResolutionQuery(query)) {
        const bindings = requestedCelex(query).map((value) => ({
          celexNumber: { type: 'literal', value },
          work: { type: 'uri', value: `${CELLAR}work-${value}` },
        }));
        return new Response(JSON.stringify({ head: { vars: [] }, results: { bindings } }));
      }
      sent.push(query);
      const directions = ['outgoing', 'incoming'].filter((d) =>
        query.includes(`BIND("${d}" AS ?direction)`),
      );
      const bindings = directions.flatMap((direction) =>
        [0, 1, 2].map((i) => ({
          relatedWork: { type: 'uri', value: `${CELLAR}row-${direction}-${i}` },
          direction: { type: 'literal', value: direction },
        })),
      );
      return new Response(JSON.stringify({ head: { vars: [] }, results: { bindings } }));
    }),
  );
  const result = await runToolContract(eurlex_get_relations, input);
  expect(result.isError).not.toBe(true);
  return sent.toSorted();
}

const OUTGOING_TYPES = RELATION_TYPES.filter((type) =>
  ['amends', 'repeals', 'implicitly_repeals', 'legal_basis', 'interprets', 'adopts'].includes(type),
);

it('sends the same relation queries as before the treaty version set outside its scope (#199)', async () => {
  const digest = (queries: string[]) =>
    createHash('sha256').update(queries.join('\n---\n')).digest('hex');
  /*
   * Captured from the build before #199. An act, a pre-Lisbon treaty article, and a
   * protocol read their own work alone, every type; so do the outgoing types of a
   * Lisbon treaty article.
   */
  const cases: Record<string, Record<string, unknown>> = {
    '32016R0679': { celex_number: '32016R0679' },
    '11997E083': { celex_number: '11997E083' },
    '12016E/PRO/04': { celex_number: '12016E/PRO/04' },
    '12016E102 outgoing': { celex_number: '12016E102', relation_types: OUTGOING_TYPES },
  };
  const before: Record<string, { count: number; sha256: string }> = {
    '32016R0679': {
      count: 26,
      sha256: '7a4770d421fe49a4137c9e5aab629ee8465b4ed2360cbc77d387206f2d8c4674',
    },
    '11997E083': {
      count: 26,
      sha256: '5b585bc407b3c386b4de8d616338087c231240392515b552b1e5305acd9b45bd',
    },
    '12016E/PRO/04': {
      count: 24,
      sha256: 'e170d86253560fcf9ef8e0b934b3d62e09603fe2165ff5cc1ae0c7cee1400fef',
    },
    '12016E102 outgoing': {
      count: 11,
      sha256: '391dad36d41e60f766e1c10e8d5232a827e524d36b56068e3e40c4eea924f8f3',
    },
  };
  const now: Record<string, { count: number; sha256: string }> = {};
  for (const [label, input] of Object.entries(cases)) {
    const queries = await relationQueriesFor(input);
    now[label] = { count: queries.length, sha256: digest(queries) };
  }
  expect(now).toEqual(before);
});

// --- #199: a Lisbon treaty article or text reads all four of its versions ---

const INTERPRETS = 'cdm:case-law_interpretes_resource_legal';
const CITES = 'cdm:work_cites_work';
const BASED_ON = 'cdm:resource_legal_based_on_resource_legal';

/** The four versions of TFEU Article 102, the Charter's Article 47, and their texts, as CELLAR holds them. */
const TREATY_WORKS: Record<string, string> = Object.fromEntries(
  [
    ...['2008', '2010', '2012', '2016'].flatMap((year) => [`1${year}E102`, `1${year}E/TXT`]),
    ...['2007', '2010', '2012', '2016'].flatMap((year) => [`1${year}P047`, `1${year}P/TXT`]),
    '32016R0679',
  ].map((celex) => [celex, `${CELLAR}w-${celex.replace('/', '-')}`]),
);
const work = (celex: string) => TREATY_WORKS[celex] ?? '';

/** One edge `related predicate target` CELLAR records, with the related work's facts and the edge's designators. */
interface Edge {
  celex?: string;
  date?: string;
  locations?: string[];
  predicate: string;
  related: string;
  target: string;
}

/** The IRIs of a `VALUES ?var { … }` block, or of the one `<iri>` a pattern names. */
const valuesOf = (text: string, variable: string) =>
  [
    ...(new RegExp(`VALUES \\?${variable} \\{ ([^}]*) \\}`).exec(text)?.[1] ?? '').matchAll(
      /<([^>]+)>/g,
    ),
  ].map((m) => m[1] ?? '');

/**
 * CELLAR over a fixed graph of incoming edges: resolves CELEX and work identities,
 * answers a relation page from the edges whose target the arm names — one work in
 * `<…>`, or the version works of its `VALUES` block — grouped per related work,
 * newest first, then paged; and answers the provisions follow-up from the designators
 * of the edges between its keyed works and the targets it names. Records every
 * request body as sent and the largest number in flight at once.
 */
function treatyCellar(edges: Edge[], options: { failFollowUp?: number } = {}) {
  initService();
  const bodies: string[] = [];
  const queries: string[] = [];
  const stats = { inFlight: 0, maxInFlight: 0, followUps: 0 };
  const respond = (bindings: object[]) =>
    new Response(JSON.stringify({ head: { vars: [] }, results: { bindings } }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = String(init.body);
      bodies.push(body);
      const query = new URLSearchParams(body).get('query') ?? '';
      queries.push(query);
      stats.inFlight++;
      stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
      // Yield before answering, so requests sent together are all in flight at once.
      await new Promise((resolve) => setTimeout(resolve, 0));
      stats.inFlight--;
      if (isResolutionQuery(query)) {
        return respond(
          requestedCelex(query).flatMap((celex) =>
            TREATY_WORKS[celex]
              ? [
                  {
                    celexNumber: { type: 'literal', value: celex },
                    work: { type: 'uri', value: TREATY_WORKS[celex] },
                  },
                ]
              : [],
          ),
        );
      }
      if (query.includes('SELECT ?sourceCelex WHERE')) {
        const source = /<([^>]+)> cdm:resource_legal_id_celex \?sourceCelex/.exec(query)?.[1];
        const celex = Object.entries(TREATY_WORKS).find(([, uri]) => uri === source)?.[0];
        return respond(celex ? [{ sourceCelex: { type: 'literal', value: celex } }] : []);
      }
      if (query.includes('?location')) {
        stats.followUps++;
        if (options.failFollowUp === stats.followUps) {
          return new Response('Virtuoso 37000 Error SP030: rejected', { status: 400 });
        }
        const keys = valuesOf(query, 'relatedWork');
        const property = /annotatedProperty> (cdm:[\w-]+)/.exec(query)?.[1];
        const named = /annotatedTarget> <([^>]+)>/.exec(query)?.[1];
        const targets = named ? [named] : (/annotatedTarget> \?(\w+)/.exec(query)?.[1] ?? '');
        const targetSet = new Set(Array.isArray(targets) ? targets : valuesOf(query, targets));
        return respond(
          edges
            .filter(
              (e) =>
                e.predicate === property && keys.includes(e.related) && targetSet.has(e.target),
            )
            .flatMap((e) =>
              (e.locations ?? []).map((location) => ({
                relatedWork: { type: 'uri', value: e.related },
                location: { type: 'literal', value: location },
              })),
            ),
        );
      }
      if (!query.includes('?relatedDateMax')) return respond([]);
      return respond(
        query.split(' UNION ').flatMap((arm) => {
          if (!arm.includes('BIND("incoming" AS ?direction)')) return [];
          const predicate = /\?relatedWork (cdm:[\w-]+) /.exec(arm)?.[1];
          const named = /\?relatedWork cdm:[\w-]+ <([^>]+)>/.exec(arm)?.[1];
          const targets = new Set(
            named
              ? [named]
              : valuesOf(arm, /\?relatedWork cdm:[\w-]+ \?(\w+)/.exec(arm)?.[1] ?? ''),
          );
          const [, limit = '0', offset = '0'] = /LIMIT (\d+) OFFSET (\d+)/.exec(arm) ?? [];
          const sectors = /SUBSTR\(STR\(\?relatedCelex\), 1, 1\) IN \(([^)]*)\)/.exec(arm)?.[1];
          const groups = new Map<string, Edge[]>();
          for (const e of edges) {
            if (e.predicate !== predicate || !targets.has(e.target)) continue;
            if (sectors !== undefined && !sectors.includes(`"${e.celex?.[0]}"`)) continue;
            groups.set(e.related, [...(groups.get(e.related) ?? []), e]);
          }
          return [...groups]
            .map(([related, group]) => ({ related, group, date: group[0]?.date ?? '' }))
            .sort((a, b) => b.date.localeCompare(a.date) || a.related.localeCompare(b.related))
            .slice(Number(offset), Number(offset) + Number(limit))
            .map(({ related, group, date }) => ({
              relatedWork: { type: 'uri', value: related },
              direction: { type: 'literal', value: 'incoming' },
              ...(group[0]?.celex
                ? { relatedCelexSample: { type: 'literal', value: group[0].celex } }
                : {}),
              ...(date ? { relatedDateMax: { type: 'literal', value: date } } : {}),
              // CELLAR concatenates the group's targets in no set order.
              ...(arm.includes('AS ?recordedAgainst')
                ? {
                    recordedAgainst: {
                      type: 'literal',
                      value: [...new Set(group.map((e) => e.target))].toReversed().join(' '),
                    },
                  }
                : {}),
            }));
        }),
      );
    }),
  );
  return { bodies, queries, stats };
}

/** A ruling recorded as interpreting `targets`, with designators on each edge. */
const ruling = (
  celex: string,
  date: string,
  targets: string[],
  predicate = INTERPRETS,
  locations: Record<string, string[]> = {},
): Edge[] =>
  targets.map((target) => ({
    related: `${CELLAR}r-${celex}`,
    celex,
    date,
    predicate,
    target: work(target),
    locations: locations[target] ?? [],
  }));

const TFEU_102 = ['12008E102', '12010E102', '12012E102', '12016E102'];

const TFEU_102_RULINGS: Edge[] = [
  ...ruling('62024CJ0245', '2025-12-18', ['12008E102'], INTERPRETS, { '12008E102': ['L2LA'] }),
  ...ruling('62009CA0437', '2011-03-02', ['12010E102']),
  ...ruling('62008CJ0052', '2010-06-01', ['12008E102', '12010E102'], INTERPRETS, {
    '12008E102': ['P1'],
    '12010E102': ['L2LB'],
  }),
];

type Page = {
  has_more: boolean;
  next_offset?: number;
  notice?: string;
  relations: {
    direction: string;
    provisions?: string[];
    recorded_against?: string[];
    related_celex_number?: string;
    relation_type: string;
  }[];
};

const text = (result: { content: unknown[] }) =>
  readCommonMark(result.content.map((b) => (b as { text?: string }).text ?? '').join('\n'));

it('reads interpreted_by on every version of TFEU Article 102 as one arm, each row naming the versions its edge targets (#199)', async () => {
  const pages: Page['relations'][] = [];
  for (const celex of TFEU_102) {
    const cellar = treatyCellar(TFEU_102_RULINGS);
    const result = await runToolContract(eurlex_get_relations, {
      celex_number: celex,
      relation_types: ['interpreted_by'],
    });
    expect(result.isError).not.toBe(true);
    const page = result.structuredContent as Page;
    pages.push(page.relations);
    // The version CELEX resolve in the one resolution request the CELEX path sends.
    const resolutions = cellar.queries.filter(isResolutionQuery);
    expect(resolutions).toHaveLength(1);
    expect(requestedCelex(resolutions[0] ?? '').toSorted()).toEqual(TFEU_102);
    expect(page.relations.map((r) => [r.related_celex_number, r.recorded_against])).toEqual([
      ['62024CJ0245', ['12008E102']],
      ['62009CA0437', ['12010E102']],
      ['62008CJ0052', ['12008E102', '12010E102']],
    ]);
    // Each edge's designators come from the version it targets.
    expect(page.relations.map((r) => r.provisions)).toEqual([['L2LA'], undefined, ['L2LB', 'P1']]);
    const rendered = text(result);
    expect(rendered).toContain('recorded against: 12008E102, 12010E102');
    expect(rendered).toContain('recorded against: 12010E102');
  }
  expect(new Set(pages.map((p) => JSON.stringify(p))).size).toBe(1);
});

it('returns the same treaty rows for a work_uri as for its celex_number (#199)', async () => {
  treatyCellar(TFEU_102_RULINGS);
  const byCelex = await runToolContract(eurlex_get_relations, {
    celex_number: '12016E102',
    relation_types: ['interpreted_by'],
  });
  const cellar = treatyCellar(TFEU_102_RULINGS);
  const byWork = await runToolContract(eurlex_get_relations, {
    work_uri: work('12016E102'),
    relation_types: ['interpreted_by'],
  });
  expect((byWork.structuredContent as Page).relations).toEqual(
    (byCelex.structuredContent as Page).relations,
  );
  expect((byWork.structuredContent as Page).relations).toHaveLength(3);
  expect(cellar.queries.filter((q) => q.includes('SELECT ?sourceCelex WHERE'))).toHaveLength(1);
});

it('walks a treaty article across a page boundary with a work recorded against two versions once (#199)', async () => {
  const edges = [
    ...ruling('62025CJ0001', '2025-05-01', ['12016E102']),
    ...ruling('62024CJ0002', '2024-05-01', ['12008E102', '12012E102']),
    ...ruling('62023CJ0003', '2023-05-01', ['12010E102']),
    ...ruling('62022CJ0004', '2022-05-01', ['12008E102']),
    ...ruling('62021CJ0005', '2021-05-01', ['12008E102']),
  ];
  const seen: string[] = [];
  const hasMore: boolean[] = [];
  let offset: number | undefined = 0;
  while (offset !== undefined) {
    treatyCellar(edges);
    const result = await runToolContract(eurlex_get_relations, {
      celex_number: '12016E102',
      relation_types: ['interpreted_by'],
      limit: 2,
      offset,
    });
    const page = result.structuredContent as Page;
    for (const row of page.relations)
      seen.push(`${row.related_celex_number}:${row.recorded_against}`);
    hasMore.push(page.has_more);
    if (page.has_more) expect(text(result)).toContain(`offset=${page.next_offset}`);
    offset = page.next_offset;
  }
  expect(hasMore).toEqual([true, true, false]);
  expect(seen).toEqual([
    '62025CJ0001:12016E102',
    '62024CJ0002:12008E102,12012E102',
    '62023CJ0003:12010E102',
    '62022CJ0004:12008E102',
    '62021CJ0005:12008E102',
  ]);
});

it('reads a symmetric type’s incoming arm across the versions and its outgoing arm from the source alone (#199)', async () => {
  const cellar = treatyCellar([
    ...ruling('32022R2065', '2022-10-19', ['12007P047', '12016P047'], CITES),
    ...ruling('62019CJ0001', '2021-01-01', ['12010P047'], CITES),
  ]);
  const result = await runToolContract(eurlex_get_relations, {
    celex_number: '12016P047',
    relation_types: ['cites'],
  });
  const page = result.structuredContent as Page;
  expect(page.relations.map((r) => [r.related_celex_number, r.recorded_against])).toEqual([
    ['32022R2065', ['12007P047', '12016P047']],
    ['62019CJ0001', ['12010P047']],
  ]);
  const [query = ''] = cellar.queries.filter((q) => q.includes(CITES));
  const [outgoing = '', incoming = ''] = query.split(' UNION ');
  expect(outgoing).toContain(`<${work('12016P047')}> ${CITES} ?relatedWork .`);
  expect(outgoing).not.toContain('VALUES');
  expect(outgoing).not.toContain('GROUP_CONCAT');
  expect(incoming).toContain('GROUP_CONCAT(DISTINCT STR(?versionWork)');
  for (const celex of ['12007P047', '12010P047', '12012P047', '12016P047']) {
    expect(incoming).toContain(`<${work(celex)}>`);
  }
});

it('names the versions an empty first page read (#199)', async () => {
  treatyCellar([]);
  const result = await runToolContract(eurlex_get_relations, {
    celex_number: '12016E102',
    relation_types: ['basis_for'],
  });
  const page = result.structuredContent as Page & { notice?: string };
  expect(page.relations).toEqual([]);
  expect(page.notice).toContain('12008E102, 12010E102, 12012E102, and 12016E102');
  expect(text(result)).toContain('12008E102, 12010E102, 12012E102, and 12016E102');
});

it('reads interpreted_by of one article of a whole treaty text from that article’s versions, with no provision filter (#199)', async () => {
  const edges = [
    ...ruling('62024CJ0100', '2025-01-01', ['12016P047']),
    ...ruling('62015CJ0200', '2016-01-01', ['12007P047', '12010P047']),
    // A ruling on the whole text, which records no provision: not one on Article 47.
    ...ruling('62019CJ0300', '2020-01-01', ['12007P/TXT']),
  ];
  const rows = async (input: Record<string, unknown>) => {
    const cellar = treatyCellar(edges);
    const result = await runToolContract(eurlex_get_relations, {
      relation_types: ['interpreted_by'],
      ...input,
    });
    expect(cellar.queries.filter(isResolutionQuery)).toHaveLength(1);
    expect(cellar.queries.some((q) => q.includes('FILTER EXISTS'))).toBe(false);
    return result;
  };
  const byArticle = await rows({ celex_number: '12016P047' });
  for (const textCelex of ['12016P/TXT', '12007P/TXT']) {
    const result = await rows({ celex_number: textCelex, article: '47' });
    const page = result.structuredContent as Page & { article?: string; notice?: string };
    expect(page.relations).toEqual((byArticle.structuredContent as Page).relations);
    expect(page.relations.map((r) => r.recorded_against)).toEqual([
      ['12016P047'],
      ['12007P047', '12010P047'],
    ]);
    expect(page.article).toBe('47');
    expect(page.notice).toBeUndefined();
    expect(text(result)).not.toContain('recorded provision');
  }
  for (const article of ['400', '6a']) {
    const cellar = treatyCellar(edges);
    const result = await runToolContract(eurlex_get_relations, {
      celex_number: '12016P/TXT',
      relation_types: ['interpreted_by'],
      article,
    });
    const page = result.structuredContent as Page & { notice?: string };
    expect(page.relations).toEqual([]);
    expect(page.notice).toContain(`Article ${article}`);
    expect(text(result)).toContain(`Article ${article}`);
    expect(cellar.queries.some((q) => q.includes(INTERPRETS))).toBe(false);
  }
});

it('applies no provision filter when article names the article a treaty CELEX already is, and none otherwise (#199)', async () => {
  for (const article of ['102', 'Article 102', '0102']) {
    const cellar = treatyCellar(TFEU_102_RULINGS);
    const result = await runToolContract(eurlex_get_relations, {
      celex_number: '12008E102',
      relation_types: ['interpreted_by'],
      article,
    });
    const page = result.structuredContent as Page & { notice?: string };
    expect(page.relations.map((r) => r.related_celex_number)).toEqual([
      '62024CJ0245',
      '62009CA0437',
      '62008CJ0052',
    ]);
    expect(page.notice).toBeUndefined();
    expect(cellar.queries.some((q) => q.includes('FILTER EXISTS'))).toBe(false);
  }
  const cellar = treatyCellar(TFEU_102_RULINGS);
  const result = await runToolContract(eurlex_get_relations, {
    celex_number: '12008E102',
    relation_types: ['interpreted_by'],
    article: '17',
  });
  const page = result.structuredContent as Page & { notice?: string };
  expect(page.relations).toEqual([]);
  expect(page.notice).toContain('12008E102 already names Article 102');
  expect(page.notice).toContain('12008E/TXT');
  expect(text(result)).toContain('12008E102 already names Article 102');
  expect(cellar.queries.some((q) => q.includes(INTERPRETS))).toBe(false);
});

it('reads basis_for and related_sectors on a treaty article across its versions (#199)', async () => {
  const cellar = treatyCellar([
    ...ruling('32016R0679', '2016-04-27', ['12012E102'], BASED_ON),
    ...ruling('52020IP0001', '2020-01-01', ['12016E102'], BASED_ON),
    ...ruling('32022L2555', '2022-12-14', ['12016E102', '12010E102'], BASED_ON),
  ]);
  const result = await runToolContract(eurlex_get_relations, {
    celex_number: '12008E102',
    relation_types: ['basis_for'],
    related_sectors: ['3'],
  });
  const page = result.structuredContent as Page;
  expect(page.relations.map((r) => [r.related_celex_number, r.recorded_against])).toEqual([
    ['32022L2555', ['12010E102', '12016E102']],
    ['32016R0679', ['12012E102']],
  ]);
  const [query = ''] = cellar.queries.filter((q) => q.includes(BASED_ON));
  expect(query).toContain('FILTER(SUBSTR(STR(?relatedCelex), 1, 1) IN ("3"))');
});

it('carries the version set into a window-end continuation (#199)', async () => {
  // 10,000 rulings, so the page at offset 9,990 ends at the last row CELLAR sorts.
  treatyCellar(
    Array.from({ length: 10_000 }, (_, i) =>
      ruling(`62000CJ${String(i).padStart(5, '0')}`, '2000-01-01', [
        i % 2 ? '12008E102' : '12016E102',
      ]),
    ).flat(),
  );
  const result = await runToolContract(eurlex_get_relations, {
    celex_number: '12016E102',
    relation_types: ['interpreted_by'],
    offset: 9990,
    limit: 10,
  });
  const page = result.structuredContent as Page & { notice?: string };
  const continuation =
    /interpreted_by \(incoming\): (SELECT .*)$/.exec(page.notice ?? '')?.[1] ?? '';
  expect(continuation).toContain('SELECT DISTINCT ?work ?celex ?date');
  for (const celex of TFEU_102) expect(continuation).toContain(`<${work(celex)}>`);
});

/** `count` rulings on one act, each recorded with three designators, under keys as long as CELLAR's. */
function heavyEdges(count: number, targets: string[]): Edge[] {
  return Array.from({ length: count }, (_, i) =>
    targets.map((target) => ({
      related: `${CELLAR}${String(i).padStart(8, '0')}-11bd-11e6-ba9a-01aa75ed71a1`,
      celex: `62020CJ${String(i).padStart(4, '0')}`,
      date: `2020-01-01`,
      predicate: INTERPRETS,
      target: work(target),
      locations: [`A${i}P1`, `A${i}P2`, `A${i}P3`],
    })),
  ).flat();
}

it('keeps every provisions follow-up within CELLAR’s 8,192-byte body limit at limit 100, run concurrently (#199)', async () => {
  for (const [celex, targets] of [
    ['32016R0679', ['32016R0679']],
    ['12016E102', TFEU_102],
  ] as const) {
    const cellar = treatyCellar(heavyEdges(100, [...targets]));
    const result = await runToolContract(eurlex_get_relations, {
      celex_number: celex,
      relation_types: ['interpreted_by'],
      limit: 100,
    });
    const page = result.structuredContent as Page;
    expect(page.relations).toHaveLength(100);
    expect(page.relations.every((r) => r.provisions?.length === 3)).toBe(true);
    expect(page.notice).toBeUndefined();
    expect(Math.max(...cellar.bodies.map((b) => b.length))).toBeLessThanOrEqual(8192);
    expect(cellar.stats.followUps).toBeGreaterThan(1);
    // The page's follow-ups go out together, not one after another.
    expect(cellar.stats.maxInFlight).toBe(cellar.stats.followUps);
  }
});

it('lists a type without provisions when one of its follow-up requests fails (#199)', async () => {
  treatyCellar(heavyEdges(100, ['32016R0679']), { failFollowUp: 2 });
  const result = await runToolContract(eurlex_get_relations, {
    celex_number: '32016R0679',
    relation_types: ['interpreted_by'],
    limit: 100,
  });
  const page = result.structuredContent as Page & { notice?: string };
  expect(page.relations).toHaveLength(100);
  expect(page.relations.some((r) => r.provisions)).toBe(false);
  expect(page.notice).toContain('CELLAR did not return the provisions of interpreted_by');
  expect(text(result)).toContain('CELLAR did not return the provisions of interpreted_by');
});
