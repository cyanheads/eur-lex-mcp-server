/**
 * @fileoverview Tests for Official Journal reference parsing and resolution: the
 * grammar `parseOjReference` reads, the issue and act-by-act queries, the
 * English-first page rule with its pre-1973 fallback, the date check, and the
 * several-acts-on-one-page outcome (#170).
 * @module tests/services/oj-reference.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import type { CellarSparqlService } from '@/services/cellar-sparql/cellar-sparql-service.js';
import {
  buildOjIssueQuery,
  type OjReference,
  type OjResolution,
  parseOjReference,
  resolveOjReference,
} from '@/services/cellar-sparql/oj-reference.js';
import type { SparqlBinding } from '@/services/cellar-sparql/types.js';
import { bestCpuMs, CPU_TIMED_TEST_TIMEOUT_MS } from '../helpers/cpu-time.js';

const ENG = 'http://publications.europa.eu/resource/authority/language/ENG';

describe('parseOjReference', () => {
  it.each<[string, OjReference]>([
    [
      'OJ L 281, 23.11.1995, p. 31',
      {
        kind: 'issue',
        issueIds: ['oj:JOL_1995_281_R'],
        firstPage: 31,
        publishedOn: '1995-11-23',
      },
    ],
    [
      'OJ L 281 of 23.11.1995, p. 31–50',
      {
        kind: 'issue',
        issueIds: ['oj:JOL_1995_281_R'],
        firstPage: 31,
        publishedOn: '1995-11-23',
      },
    ],
    [
      'OJ L 119, 4.5.2016, p. 1–88',
      { kind: 'issue', issueIds: ['oj:JOL_2016_119_R'], firstPage: 1, publishedOn: '2016-05-04' },
    ],
    [
      'OJ L 119, 4.5.2016, p. 1-88',
      { kind: 'issue', issueIds: ['oj:JOL_2016_119_R'], firstPage: 1, publishedOn: '2016-05-04' },
    ],
    [
      'OJ L 42I, 23.2.2022, p. 1',
      { kind: 'issue', issueIds: ['oj:JOL_2022_042_I'], firstPage: 1, publishedOn: '2022-02-23' },
    ],
    [
      'OJ C 326, 26.10.2012, p. 47',
      {
        kind: 'issue',
        issueIds: ['oj:JOC_2012_326_R'],
        firstPage: 47,
        publishedOn: '2012-10-26',
      },
    ],
    [
      'OJ C 77 E, 28.3.2002, p. 1',
      { kind: 'issue', issueIds: ['oj:JOC_2002_077_E'], firstPage: 1, publishedOn: '2002-03-28' },
    ],
    [
      'OJ 13, 21.2.1962, p. 204/62',
      {
        kind: 'issue',
        issueIds: ['oj:JOP_1962_013_R'],
        firstPage: 204,
        publishedOn: '1962-02-21',
      },
    ],
    [
      'OJ 13, 21.2.1962, p. 204–211',
      {
        kind: 'issue',
        issueIds: ['oj:JOP_1962_013_R'],
        firstPage: 204,
        publishedOn: '1962-02-21',
      },
    ],
    [
      'OJ 7, 30.4.1958, p. 1',
      {
        kind: 'issue',
        issueIds: ['oj:JOA_1958_007_R', 'oj:JOP_1958_007_R'],
        firstPage: 1,
        publishedOn: '1958-04-30',
      },
    ],
    [
      'OJ 4, 8.5.1953, p. 109',
      { kind: 'issue', issueIds: ['oj:JOA_1953_004_R'], firstPage: 109, publishedOn: '1953-05-08' },
    ],
    ['OJ 1995 L 281, p. 31', { kind: 'issue', issueIds: ['oj:JOL_1995_281_R'], firstPage: 31 }],
    ['OJ 1995 L 281/31', { kind: 'issue', issueIds: ['oj:JOL_1995_281_R'], firstPage: 31 }],
    [
      'OJ L, 2024/1689, 12.7.2024',
      { kind: 'act', actId: 'oj:L_202401689', publishedOn: '2024-07-12' },
    ],
    ['OJ L, 2024/1689', { kind: 'act', actId: 'oj:L_202401689' }],
    [
      'OJ C, C/2024/2664, 29.4.2024',
      { kind: 'act', actId: 'oj:C_202402664', publishedOn: '2024-04-29' },
    ],
    ['OJ C, C/2024/12', { kind: 'act', actId: 'oj:C_202400012' }],
  ])('parses %j', (text, expected) => {
    expect(parseOjReference(text)).toEqual(expected);
  });

  it.each([
    ['surrounding parentheses and a trailing period', '(OJ L 281, 23.11.1995, p. 31).'],
    ['lowercase', 'oj l 281, 23.11.1995, p. 31'],
    ['doubled spaces', 'OJ  L  281,  23.11.1995,  p.  31'],
    ['a line break and a non-breaking space', 'OJ L\n281, 23.11.1995, p. 31'],
    ['surrounding whitespace', '  OJ L 281, 23.11.1995, p. 31  '],
    ['no space after p.', 'OJ L 281, 23.11.1995, p.31'],
  ])('reads the issue reference with %s', (_label, text) => {
    expect(parseOjReference(text)).toEqual({
      kind: 'issue',
      issueIds: ['oj:JOL_1995_281_R'],
      firstPage: 31,
      publishedOn: '1995-11-23',
    });
  });

  it.each([
    ['no year or page', 'OJ L 281'],
    ['no year', 'OJ L 119/1'],
    ['no page', 'OJ L 281, 23.11.1995'],
    ['no date or year', 'OJ L 281, p. 31'],
    ['the EUR-Lex table-of-contents form', 'OJ:L:2016:119:TOC'],
    ['a special edition', 'OJ English Special Edition 1959-1962, p. 87'],
    ['a C number under L', 'OJ L, C/2024/2664, 29.4.2024'],
    ['an L number under C', 'OJ C, 2024/2664'],
    ['no series from 1968 on', 'OJ 281, 23.11.1995, p. 31'],
    ['a trailing word', 'OJ L 281, 23.11.1995, p. 31 et seq'],
    ['two pairs of parentheses', '((OJ L 281, 23.11.1995, p. 31))'],
    ['a CELEX', '32016R0679'],
    ['an ELI', 'http://data.europa.eu/eli/reg/2016/679/oj'],
    ['an ECLI', 'ECLI:EU:C:2014:317'],
    ['an act citation', 'Regulation (EU) 2016/679'],
    ['an act citation with its reference', 'Directive 95/46/EC (OJ L 281, 23.11.1995, p. 31)'],
    ['a citation without a year', 'Regulation No 17'],
    ['a case number', 'C-131/12'],
  ])('does not parse %s', (_label, text) => {
    expect(parseOjReference(text)).toBeUndefined();
  });
});

/*
 * The fake service below routes on each query's typed `oj:` identifier, so the
 * resolution tests already pin which issue or act a query names. This pins what
 * they cannot: one issue per query (a VALUES list times out upstream), the page
 * compared as an integer (CELLAR stores `0047` and `47`), and English pages read.
 */
describe('buildOjIssueQuery', () => {
  it('names one issue and compares English first pages as integers', () => {
    const query = buildOjIssueQuery('oj:JOL_1995_281_R', 31);

    expect(query).toContain('FILTER(xsd:integer(?page) = 31)');
    expect(query).toContain(`cdm:expression_uses_language <${ENG}>`);
    expect(query).not.toContain('VALUES');
  });
});

/** A grouped issue row, as the issue query returns it. */
function issueRow(
  published: string | undefined,
  englishPaged: boolean,
  celex?: string,
  english?: boolean,
): SparqlBinding {
  const literal = (value: string) => ({ type: 'literal', value });
  return {
    ...(published ? { published: literal(published) } : {}),
    englishPaged: literal(englishPaged ? '1' : '0'),
    ...(celex ? { celex: literal(celex), english: literal(english ? '1' : '0') } : {}),
  };
}

/** A fake service answering each issue or act identifier with its own rows. */
function fakeService(byId: Record<string, SparqlBinding[]>) {
  const query = vi.fn(async (q: string) => {
    const id = /"(oj:[^"]+)"\^\^xsd:string/.exec(q)?.[1] ?? '';
    return byId[id] ?? [];
  });
  return { svc: { query } as unknown as Pick<CellarSparqlService, 'query'>, query };
}

/** The act-by-act work `oj:L_202401689`, as the act query returns it. */
const AI_ACT = {
  'oj:L_202401689': [
    {
      celex: { type: 'literal', value: '32024R1689' },
      published: { type: 'literal', value: '2024-07-12' },
    },
  ],
};

describe('resolveOjReference', () => {
  it.each<[string, string, Record<string, SparqlBinding[]>, OjResolution]>([
    [
      'resolves the one act starting on the page',
      'OJ L 281, 23.11.1995, p. 31',
      { 'oj:JOL_1995_281_R': [issueRow('1995-11-23', true, '31995L0046', true)] },
      { kind: 'one', celex: '31995L0046' },
    ],
    [
      // OJ L 127, 23.5.2018: p. 2 starts 32016R0679R(02) in English, 32017R0821R(01) in Italian.
      'reads the page on the English edition when the issue has English pages',
      'OJ L 127, 23.5.2018, p. 2',
      {
        'oj:JOL_2018_127_R': [
          issueRow('2018-05-23', true, '32017R0821R(01)', false),
          issueRow('2018-05-23', true, '32016R0679R(02)', true),
        ],
      },
      { kind: 'one', celex: '32016R0679R(02)' },
    ],
    [
      'is a miss when the page starts an act only outside the English edition',
      'OJ L 127, 23.5.2018, p. 3',
      { 'oj:JOL_2018_127_R': [issueRow('2018-05-23', true, '32016R0679R(02)', false)] },
      { kind: 'no_act_on_page' },
    ],
    [
      'reads every language when no English manifestation of the issue carries a page',
      'OJ 13, 21.2.1962, p. 204/62',
      { 'oj:JOP_1962_013_R': [issueRow('1962-02-21', false, '31962R0017', false)] },
      { kind: 'one', celex: '31962R0017' },
    ],
    [
      'names every act starting on the page, in CELEX order',
      'OJ L 12, 17.1.2018, p. 1',
      {
        'oj:JOL_2018_012_R': [
          issueRow('2018-01-17', true, '22018X0117(02)', true),
          issueRow('2018-01-17', true, '22018X0117(01)', true),
        ],
      },
      { kind: 'several', celex: ['22018X0117(01)', '22018X0117(02)'] },
    ],
    [
      'reports the issue’s own date when the cited date differs',
      'OJ L 281, 23.11.1996, p. 31',
      { 'oj:JOL_1996_281_R': [issueRow('1996-10-31', true)] },
      { kind: 'other_date', publishedOn: '1996-10-31' },
    ],
    [
      'is a miss on the date when the issue records none',
      'OJ L 281, 23.11.1995, p. 31',
      { 'oj:JOL_1995_281_R': [issueRow(undefined, true, '31995L0046', true)] },
      { kind: 'other_date', publishedOn: undefined },
    ],
    [
      'checks no date on a year-first reference',
      'OJ 1995 L 281/31',
      { 'oj:JOL_1995_281_R': [issueRow('1995-11-23', true, '31995L0046', true)] },
      { kind: 'one', celex: '31995L0046' },
    ],
    [
      'is a miss when no act starts on the page',
      'OJ L 281, 23.11.1995, p. 35',
      { 'oj:JOL_1995_281_R': [issueRow('1995-11-23', true)] },
      { kind: 'no_act_on_page' },
    ],
    [
      'is a miss when CELLAR holds no such issue',
      'OJ L 999, 1.1.2018, p. 1',
      {},
      { kind: 'not_held' },
    ],
    [
      'queries both 1958 journals and keeps the one of the cited date',
      'OJ 7, 30.4.1958, p. 1',
      {
        'oj:JOA_1958_007_R': [issueRow('1958-02-10', false, '31958A0001', false)],
        'oj:JOP_1958_007_R': [issueRow('1958-04-30', false, '31958R0007', false)],
      },
      { kind: 'one', celex: '31958R0007' },
    ],
    [
      'names no date when neither 1958 journal was published on the cited one',
      'OJ 7, 30.4.1958, p. 1',
      {
        'oj:JOA_1958_007_R': [issueRow('1958-02-10', false)],
        'oj:JOP_1958_007_R': [issueRow('1958-05-02', false)],
      },
      { kind: 'other_date', publishedOn: undefined },
    ],
    [
      'resolves a dated act-by-act reference',
      'OJ L, 2024/1689, 12.7.2024',
      AI_ACT,
      { kind: 'one', celex: '32024R1689' },
    ],
    [
      'resolves an undated act-by-act reference',
      'OJ L, 2024/1689',
      AI_ACT,
      { kind: 'one', celex: '32024R1689' },
    ],
    [
      'reports the act’s own date when the cited date differs',
      'OJ L, 2024/1689, 13.7.2024',
      AI_ACT,
      { kind: 'other_date', publishedOn: '2024-07-12' },
    ],
    [
      'is a miss when no act carries the act-by-act number',
      'OJ C, C/2024/99999',
      {},
      { kind: 'not_held' },
    ],
  ])('%s', async (_label, text, byId, expected) => {
    const reference = parseOjReference(text);
    if (!reference) throw new Error(`not a reference: ${text}`);
    const { svc, query } = fakeService(byId);

    await expect(resolveOjReference(svc, reference, createMockContext())).resolves.toEqual(
      expected,
    );
    // One query per candidate issue (both 1958 journals), or one for an act-by-act number.
    expect(query).toHaveBeenCalledTimes(reference.kind === 'issue' ? reference.issueIds.length : 1);
  });
});

/**
 * The parser runs on caller-sized text. Each shape is timed in thread CPU at every
 * doubling from 5k to 320k characters, bounded at each size before the next runs,
 * with the full 64× span held under 256×: a repeated opener with no closer,
 * overlapping prefixes, a whitespace run the normalizer collapses, and the two
 * line-break shapes.
 */
describe('parseOjReference runs in linear time', () => {
  const SIZES = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000];
  const shapes: [string, (n: number) => string][] = [
    ['one long line ending in a break', (n) => `${'§1 x'.repeat(n / 4)}\ny`],
    ['breaks throughout', (n) => '  \r\n'.repeat(n / 4)],
    ['a repeated OJ opener', (n) => 'OJ '.repeat(n / 3)],
    ['overlapping issue prefixes', (n) => 'OJ L 1 '.repeat(n / 7)],
    ['an issue reference with no page', (n) => `OJ L 281, 23.11.1995, p. ${' '.repeat(n)}`],
    ['an act-by-act opener run', (n) => `OJ L, ${'2024/'.repeat(n / 5)}`],
    ['an unclosed parenthesis', (n) => `(OJ L 281, 23.11.1995, p. 31${'1'.repeat(n)}`],
  ];
  it.each(shapes)(
    '%s',
    async (_label, shape) => {
      const timings: number[] = [];
      for (const size of SIZES) {
        const text = shape(size);
        const cpu = await bestCpuMs(() => parseOjReference(text));
        expect(cpu, `${size} characters: ${cpu.toFixed(3)} ms CPU`).toBeLessThan(100);
        timings.push(cpu);
      }
      const [first = 0] = timings;
      const last = timings.at(-1) ?? 0;
      expect(last / Math.max(first, 0.01), JSON.stringify(timings)).toBeLessThan(256);
    },
    CPU_TIMED_TEST_TIMEOUT_MS,
  );
});
