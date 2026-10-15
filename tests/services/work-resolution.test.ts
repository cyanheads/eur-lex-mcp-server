/**
 * @fileoverview Tests for CELEX → CELLAR work resolution (#97): the canonical-work
 * rule, its order independence and fallback, the batched `VALUES` query, and the
 * per-work columns read beside it (#146).
 * @module tests/services/work-resolution.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import {
  canonicalAliasPattern,
  pickResolvedWork,
  resolveCelexWorkRows,
  resolveCelexWorks,
  resolvedWorkRow,
} from '@/services/cellar-sparql/work-resolution.js';
import {
  CASE_LAW_WORKS,
  CELEX_WORKS,
  CELLAR,
  canonicalWork,
  caseWorkRows,
  celexWorkRows,
  type FixtureCaseWork,
  fixtureWork,
} from '../fixtures/cellar-works.js';

type Row = Record<string, { type: string; value: string }>;

const work = (uri: string, canonical = false): Row => ({
  work: { type: 'uri', value: uri },
  ...(canonical ? { canonicalAlias: { type: 'uri', value: 'alias' } } : {}),
});

describe('canonicalAliasPattern', () => {
  it('builds the alias IRI with ENCODE_FOR_URI inside the filter, for a literal or a variable', () => {
    expect(canonicalAliasPattern('?celexNumber')).toContain(
      'FILTER(?canonicalAlias = IRI(CONCAT("http://publications.europa.eu/resource/celex/", ENCODE_FOR_URI(STR(?celexNumber)))))',
    );
    expect(canonicalAliasPattern('"62015TO0235(01)"^^xsd:string')).toContain(
      'ENCODE_FOR_URI(STR("62015TO0235(01)"^^xsd:string))',
    );
  });

  it('is an OPTIONAL, so works without the alias still return', () => {
    expect(canonicalAliasPattern('?c').trimStart().startsWith('OPTIONAL {')).toBe(true);
  });
});

describe('pickResolvedWork', () => {
  it('prefers the work carrying the alias wherever it sits in the rows', () => {
    const rows = [work(`${CELLAR}aaa`), work(`${CELLAR}zzz`, true), work(`${CELLAR}mmm`)];
    expect(pickResolvedWork(rows)).toBe(`${CELLAR}zzz`);
    expect(pickResolvedWork([...rows].reverse())).toBe(`${CELLAR}zzz`);
  });

  it('falls back to the lowest work URI when no work carries the alias', () => {
    expect(pickResolvedWork([work(`${CELLAR}c`), work(`${CELLAR}a`), work(`${CELLAR}b`)])).toBe(
      `${CELLAR}a`,
    );
  });

  it('returns undefined for no rows, and resolvedWorkRow null', () => {
    expect(pickResolvedWork([])).toBeUndefined();
    expect(resolvedWorkRow([])).toBeNull();
  });

  it('returns the first row of the resolved work, keeping its other columns', () => {
    const typed = (uri: string, type: string, canonical = false): Row => ({
      ...work(uri, canonical),
      type: { type: 'uri', value: type },
    });
    const row = resolvedWorkRow([
      typed(`${CELLAR}copy`, 'JUDG'),
      typed(`${CELLAR}main`, 'JUDG', true),
      typed(`${CELLAR}main`, 'JUDG_EXTRACT', true),
    ]);
    expect(row?.work?.value).toBe(`${CELLAR}main`);
    expect(row?.type?.value).toBe('JUDG');
  });
});

describe('resolveCelexWorks', () => {
  const ctx = createMockContext();

  it('resolves every CELEX of a page in one VALUES query', async () => {
    const query = vi.fn(async (q: string) => celexWorkRows(q));
    const celex = ['62022TJ0181', '62012CJ0131', '51988DC0713', '62015TO0235(01)', '32016R0679'];

    const resolved = await resolveCelexWorks({ query }, celex, ctx);

    expect(query).toHaveBeenCalledTimes(1);
    expect(Object.fromEntries(resolved)).toEqual(
      Object.fromEntries(celex.map((c) => [c, canonicalWork(c)])),
    );
    const sparql = query.mock.calls[0]?.[0] as string;
    expect(sparql).toContain(
      'VALUES ?celexNumber { "62022TJ0181"^^xsd:string "62012CJ0131"^^xsd:string "51988DC0713"^^xsd:string "62015TO0235(01)"^^xsd:string "32016R0679"^^xsd:string }',
    );
    expect(sparql).toContain('?work cdm:resource_legal_id_celex ?celexNumber .');
    expect(sparql).not.toContain('LIMIT');
  });

  it('never resolves to a copy or alias of a multi-work CELEX', async () => {
    const query = vi.fn(async (q: string) => celexWorkRows(q));
    const resolved = await resolveCelexWorks({ query }, ['62022TJ0181'], ctx);

    expect(resolved.get('62022TJ0181')).not.toBe(fixtureWork('62022TJ0181', 0));
    expect(resolved.get('62022TJ0181')).not.toBe(fixtureWork('62022TJ0181', 2));
    expect(CELEX_WORKS['62022TJ0181']).toHaveLength(3);
  });

  /** A query that matches nothing, recording what it was sent. */
  const emptyQuery = () => vi.fn(async (_q: string): Promise<Row[]> => []);

  it('sends one literal per distinct CELEX', async () => {
    const query = emptyQuery();
    await resolveCelexWorks({ query }, ['32016R0679', '32016R0679'], ctx);
    expect(query.mock.calls[0]?.[0].match(/\^\^xsd:string/g)).toHaveLength(1);
  });

  it('sends no query for an empty list', async () => {
    const query = emptyQuery();
    expect((await resolveCelexWorks({ query }, [], ctx)).size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it('leaves a CELEX no work holds out of the map', async () => {
    const query = vi.fn(async (q: string) => celexWorkRows(q));
    const resolved = await resolveCelexWorks({ query }, ['32016R0679', '32099R9999'], ctx);
    expect([...resolved.keys()]).toEqual(['32016R0679']);
  });

  it('escapes a CELEX into its literal', async () => {
    const query = emptyQuery();
    await resolveCelexWorks({ query }, ['32016R0679"x'], ctx);
    expect(query.mock.calls[0]?.[0]).toContain(String.raw`"32016R0679\"x"^^xsd:string`);
  });

  it('sends the same query, byte for byte, as before per-work columns existed', async () => {
    const query = emptyQuery();
    await resolveCelexWorks({ query }, ['62012CJ0131', '62015TO0235(01)'], ctx);
    expect(query.mock.calls[0]?.[0]).toBe(`
SELECT ?celexNumber ?work ?canonicalAlias WHERE {
  VALUES ?celexNumber { "62012CJ0131"^^xsd:string "62015TO0235(01)"^^xsd:string }
  ?work cdm:resource_legal_id_celex ?celexNumber .
  OPTIONAL {
    ?work <http://www.w3.org/2002/07/owl#sameAs> ?canonicalAlias .
    FILTER(?canonicalAlias = IRI(CONCAT("http://publications.europa.eu/resource/celex/", ENCODE_FOR_URI(STR(?celexNumber)))))
  }
}`);
  });
});

describe('resolveCelexWorkRows', () => {
  const ctx = createMockContext();
  const COLUMNS = {
    variables: ['?type', '?title'],
    patterns: [
      'OPTIONAL { ?work cdm:work_has_resource-type ?type . }',
      'OPTIONAL {\n    ?expr cdm:expression_belongs_to_work ?work .\n    ?expr cdm:expression_title ?title .\n  }',
    ],
  };

  it('projects the per-work columns and appends their patterns after the alias match', async () => {
    const query = vi.fn(async (q: string) => caseWorkRows(q));
    await resolveCelexWorkRows({ query }, ['62018CJ0311'], ctx, COLUMNS);

    const sparql = query.mock.calls[0]?.[0] as string;
    expect(sparql).toMatch(
      /^\nSELECT \?celexNumber \?work \?canonicalAlias \?type \?title WHERE \{/,
    );
    expect(sparql).toMatch(
      /owl#sameAs[\s\S]*\n {2}\}\n {2}OPTIONAL \{ \?work cdm:work_has_resource-type \?type \. \}\n {2}OPTIONAL \{\n {4}\?expr cdm:expression_belongs_to_work \?work \.\n {4}\?expr cdm:expression_title \?title \.\n {2}\}\n\}$/,
    );
    expect(sparql).not.toMatch(/GROUP BY|LIMIT/);
  });

  it('returns the resolved work with its own rows and every row of the CELEX', async () => {
    const query = vi.fn(async (q: string) => caseWorkRows(q));
    const resolved = await resolveCelexWorkRows(
      { query },
      ['62018TJ0207', '62019CC0470', '32099R9999'],
      ctx,
      COLUMNS,
    );

    expect([...resolved.keys()].sort()).toEqual(['62018TJ0207', '62019CC0470']);
    for (const [celex, entry] of resolved) {
      const works = CASE_LAW_WORKS[celex] ?? [];
      const main = works.find((w) => w.canonical);
      expect(entry.work).toBe(main?.uri);
      expect(new Set(entry.workRows.map((b) => b.work?.value))).toEqual(new Set([main?.uri]));
      expect(new Set(entry.celexRows.map((b) => b.work?.value))).toEqual(
        new Set(works.map((w) => w.uri)),
      );
    }
    const plastics = resolved.get('62018TJ0207');
    expect(plastics?.workRows.map((b) => b.type?.value.split('/').pop())).toEqual(['JUDG']);
    expect(plastics?.celexRows.map((b) => b.type?.value.split('/').pop()).sort()).toEqual([
      'JUDG',
      'JUDG_EXTRACT',
    ]);
  });

  it('keeps every row of a work that carries several values of a column', async () => {
    const registry: Record<string, FixtureCaseWork[]> = {
      '62020CJ0001': [
        { uri: `${CELLAR}copy`, canonical: false, types: ['JUDG'], titles: ['Copy'] },
        {
          uri: `${CELLAR}main`,
          canonical: true,
          types: ['JUDG', 'CORRIGENDUM'],
          titles: ['First', 'Second'],
        },
      ],
    };
    const query = vi.fn(async (q: string) => caseWorkRows(q, registry));
    const entry = (await resolveCelexWorkRows({ query }, ['62020CJ0001'], ctx, COLUMNS)).get(
      '62020CJ0001',
    );

    expect(entry?.work).toBe(`${CELLAR}main`);
    expect(entry?.workRows).toHaveLength(4);
    expect(entry?.celexRows).toHaveLength(5);
  });

  it('sends no query for an empty list', async () => {
    const query = vi.fn(async (_q: string): Promise<Row[]> => []);
    expect((await resolveCelexWorkRows({ query }, [], ctx, COLUMNS)).size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });
});
