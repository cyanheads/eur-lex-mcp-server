/**
 * @fileoverview Tests for the act citation facts (#169): the citation query (#173)
 * and the reader that turns its aggregates into the ELI, the Official Journal
 * reference, typed dates of effect, and transposition deadlines.
 * @module tests/services/act-citation.test
 */

import { describe, expect, it } from 'vitest';
import {
  actCitationQuery,
  formatOjReference,
  type OjFacts,
  readActCitation,
} from '@/services/cellar-sparql/act-citation.js';
import { encodedComment } from '../fixtures/cellar-consolidations.js';
import { bestCpuMs, CPU_TIMED_TEST_TIMEOUT_MS } from '../helpers/cpu-time.js';

const COLLECTION = 'http://publications.europa.eu/resource/authority/document-collection/';
const FD_335 = 'http://publications.europa.eu/resource/authority/fd_335/';
const SERVED = 'http://publications.europa.eu/resource/cellar/served';
const ACT = 'http://publications.europa.eu/resource/cellar/act';

const issue = (date: string, collection: string, number: string, issueClass = 'R') => ({
  date,
  collection: `${COLLECTION}${collection}`,
  number,
  class: issueClass,
});
const facts = (over: Partial<OjFacts>): OjFacts => ({
  englishPages: [],
  originalPages: [],
  ...over,
});
const literal = (value: string) => ({ type: 'literal', value });

describe('formatOjReference', () => {
  it.each<[string, OjFacts, string | undefined]>([
    [
      'an OJ L issue with an English page range',
      facts({ issue: issue('2016-05-04', 'OJ-L', '119'), englishPages: ['0001|0088'] }),
      'OJ L 119, 4.5.2016, p. 1–88',
    ],
    [
      'a single page',
      facts({ issue: issue('2018-05-23', 'OJ-L', '127'), englishPages: ['0006|0006'] }),
      'OJ L 127, 23.5.2018, p. 6',
    ],
    [
      'a page_first with no page_last',
      facts({ issue: issue('2018-05-23', 'OJ-L', '127'), englishPages: ['0006|'] }),
      'OJ L 127, 23.5.2018, p. 6',
    ],
    [
      'an issue class other than R after the number',
      facts({ issue: issue('2016-12-09', 'OJ-L', '336', 'I'), englishPages: ['0001|0010'] }),
      'OJ L 336I, 9.12.2016, p. 1–10',
    ],
    [
      'an OJ C issue',
      facts({ issue: issue('2012-10-26', 'OJ-C', '326'), englishPages: ['0047|0390'] }),
      'OJ C 326, 26.10.2012, p. 47–390',
    ],
    [
      'the pre-1968 journal (OJ-P) carries no series letter, and pages fall back before 1973',
      facts({ issue: issue('1962-02-21', 'OJ-P', '013'), originalPages: ['0204|0211'] }),
      'OJ 13, 21.2.1962, p. 204–211',
    ],
    [
      'the 1952–1958 journal (OJ-A) carries no series letter either',
      facts({ issue: issue('1957-03-01', 'OJ-A', '31'), originalPages: ['0010|0012'] }),
      'OJ 31, 1.3.1957, p. 10–12',
    ],
    [
      'English pages win over the original-language ones before 1973',
      facts({
        issue: issue('1972-03-27', 'OJ-L', '73'),
        englishPages: ['0003|0004'],
        originalPages: ['0009|0010'],
      }),
      'OJ L 73, 27.3.1972, p. 3–4',
    ],
    [
      'from 1973 the original-language pages are never cited',
      facts({ issue: issue('2018-05-23', 'OJ-L', '127'), originalPages: ['0009|0009'] }),
      'OJ L 127, 23.5.2018',
    ],
    [
      'the widest range over several manifestations, compared as numbers',
      facts({ issue: issue('2016-05-04', 'OJ-L', '119'), englishPages: ['0009|0010', '10|0100'] }),
      'OJ L 119, 4.5.2016, p. 9–100',
    ],
    [
      // CELLAR records the Treaty of Nice (12001C) on page `s1`; it is OJ C 80, p. 1.
      'a non-numeric page is no page, so the range is omitted',
      facts({ issue: issue('2001-03-10', 'OJ-C', '80'), englishPages: ['s1|s1'] }),
      'OJ C 80, 10.3.2001',
    ],
    [
      'only the numeric pages of several manifestations make the range',
      facts({
        issue: issue('1991-12-31', 'OJ-C', '337'),
        englishPages: ['0A01|', '0003|0004', '0005|s9'],
      }),
      'OJ C 337, 31.12.1991, p. 3–5',
    ],
    [
      'an act-by-act OJ L publication',
      facts({
        act: { collection: `${COLLECTION}OJ-L`, date: '2024-07-12', year: '2024', number: '1689' },
      }),
      'OJ L, 2024/1689, 12.7.2024',
    ],
    [
      'an act-by-act OJ C publication names the series in the number',
      facts({
        act: { collection: `${COLLECTION}OJ-C`, date: '2024-04-29', year: '2024', number: '2664' },
      }),
      'OJ C, C/2024/2664, 29.4.2024',
    ],
    ['no publication', facts({}), undefined],
  ])('%s', (_label, input, expected) => {
    expect(formatOjReference(input)).toBe(expected);
  });
});

describe('readActCitation', () => {
  it('reads every fact from the aggregates CELLAR returns', () => {
    expect(
      readActCitation({
        eli: literal('http://data.europa.eu/eli/dir/2019/1937/oj'),
        datesOfEffect: literal(
          `2019-12-16|{EV|${FD_335}EV}|${encodedComment('{DATPUB} +20 {V} {ART} 28')}`,
        ),
        transposition: literal('2023-12-17 2021-12-17'),
        ojIssue: literal(`2019-11-26|${COLLECTION}OJ-L|305|R`),
        ojAct: literal('|||'),
        ojEnglishPages: literal('0017|0056'),
      }),
    ).toEqual({
      eli: 'http://data.europa.eu/eli/dir/2019/1937/oj',
      oj_reference: 'OJ L 305, 26.11.2019, p. 17–56',
      dates_of_effect: [{ date: '2019-12-16', type: 'entry_into_force', provision: 'Article 28' }],
      transposition_deadlines: ['2021-12-17', '2023-12-17'],
    });
  });

  it('returns no fact for the empty composites of an act that records none', () => {
    expect(
      readActCitation({
        datesOfEffect: literal('||'),
        transposition: literal(''),
        ojIssue: literal('|||'),
        ojAct: literal('|||'),
        ojEnglishPages: literal('|'),
        ojOriginalPages: literal('|'),
      }),
    ).toEqual({});
    expect(readActCitation(undefined)).toEqual({});
  });

  it('maps every fd_335 type, sorts by date then type, and keeps an unmapped or missing type out', () => {
    const codes = ['EV', 'MA', 'MA/PART', 'MA/PROV', 'PE', 'PE/PART'];
    const items = [
      ...codes.map((c) => `2020-01-01|{${c}|${FD_335}${encodeURIComponent(c)}}|`),
      `2019-06-01|{V|${FD_335}V}|`,
      // A code named like an Object.prototype member is not a type either.
      `2017-01-01|{constructor|${FD_335}x}|`,
      '2021-03-01||',
      // The same date and type twice reads as one entry.
      `2018-01-01|{EV|${FD_335}EV}|`,
      `2018-01-01|{EV|${FD_335}EV}|`,
    ];
    expect(readActCitation({ datesOfEffect: literal(items.reverse().join(' ')) })).toEqual({
      dates_of_effect: [
        { date: '2017-01-01' },
        { date: '2018-01-01', type: 'entry_into_force' },
        { date: '2019-06-01' },
        { date: '2020-01-01', type: 'entry_into_force' },
        { date: '2020-01-01', type: 'application' },
        { date: '2020-01-01', type: 'partial_application' },
        { date: '2020-01-01', type: 'provisional_application' },
        { date: '2020-01-01', type: 'takes_effect' },
        { date: '2020-01-01', type: 'takes_partial_effect' },
        { date: '2021-03-01' },
      ],
    });
  });

  it('prefers the act-by-act publication over an issue', () => {
    expect(
      readActCitation({
        ojIssue: literal(`2024-07-12|${COLLECTION}OJ-L|999|R`),
        ojAct: literal(`2024-07-12|${COLLECTION}OJ-L|2024|1689`),
      }).oj_reference,
    ).toBe('OJ L, 2024/1689, 12.7.2024');
  });
});

/** One `date|type|comment` item of the `?datesOfEffect` aggregate, as CELLAR returns it. */
const effectItem = (date: string, code: string, comment?: string) =>
  `${date}|{${code}|${FD_335}${encodeURIComponent(code)}}|${comment === undefined ? '' : encodedComment(comment)}`;
/** The dates of effect read from `items`. */
const datesOf = (...items: string[]) =>
  readActCitation({ datesOfEffect: literal(items.join(' ')) }).dates_of_effect;

describe('dates of effect: the provision and partial scope a comment names (#181)', () => {
  it.each<[string, string | undefined]>([
    ['{DATPUB} +20 {V} {ART} 113', 'Article 113'],
    ['{MA/PART} {V} {ART} 113(a)', 'Article 113(a)'],
    // CELLAR's numbering is kept: in an agreement 23.2 can be chapter 23, article 2.
    ['{DATPUB} +20 {V} {ART} 93.1', 'Article 93.1'],
    ['{V} {ART} 33.2(a)(ii)', 'Article 33.2(a)(ii)'],
    ['{V} {ART} 9.3.1', 'Article 9.3.1'],
    ['{V} {ART} 6a', 'Article 6a'],
    ['{V} {ART} 59(ga)', 'Article 59(ga)'],
    ['DEB/MANDAT {V} {ARTUNIQUE}', 'Sole article'],
    ['{V} {ANN}', 'Annex'],
    ['{V} {ANN} II', 'Annex II'],
    ['{DEB/CAMP} {V} {ANN} 2', 'Annex 2'],
    ['{DATPUB} + 1 {V} {PT} 3', 'Point 3'],
    ['{DATPUB}  +20  {V}   {ART}   113 ', 'Article 113'],
    // No single provision of the act: none is invented.
    ['{DATNOT}', undefined],
    ['{EXERC} 2012', undefined],
    ['{V} {TEXTE}', undefined],
    ['{V} {ART} 1 {ET} 2', undefined],
    ['{V} {ART} 1 {ET} {ANN}', undefined],
    ['{V} {373R1560}', undefined],
    [
      '{V} {ART} 4 {ET} {32005D1212(01)|http://publications.europa.eu/resource/celex/32005D1212%2801%29}',
      undefined,
    ],
    ['{V} {ART} 3 {JO} +2', undefined],
    ['{V} {ART} 9P1', undefined],
    ['{V} {ART} 2 {MA}', undefined],
    ['{V} {ART} 2 1', undefined],
    ['{V} {ART}', undefined],
    ['{V} {ART} II', undefined],
    ['{V} {ART} 1-2', undefined],
    ['{V} {ART} 16;', undefined],
    ['{V} {ART} 17.2.', undefined],
    ['{V} {ART} 1(abcde)', undefined],
    ['{V} {ART} 1(a', undefined],
    ['{V} {ART} 1(a)b', undefined],
    ['{V} {ART} 1()', undefined],
    ['{V} {ANN} 2x3', undefined],
    ['{V} {ARTUNIQUE} 2', undefined],
    ['{V} {CONSID}', undefined],
    ['{V} {ART} 33 {;} {V} {JO} {L} 189/98 {P} 44', undefined],
    ['{V} {V} 2.2', undefined],
    // Two see codes, each naming a whole clause: no single provision.
    ['{V} {ART} 2 {V} {ART} 3', undefined],
    // Codes are matched only as {CODE|uri} tokens, never as free text.
    ['V ART 2', undefined],
  ])('%s → %s', (comment, provision) => {
    expect(datesOf(effectItem('2020-01-01', 'EV', comment))).toEqual([
      { date: '2020-01-01', type: 'entry_into_force', ...(provision ? { provision } : {}) },
    ]);
  });

  it.each<[string, string, string]>([
    ['MA', '{MA/PART} {V} {ART} 113(a)', 'partial_application'],
    ['MA', '{V} {ART} 113', 'application'],
    // Only an application date turns partial; the comment never crosses categories.
    ['EV', '{MA/PART} {V} {ART} 2', 'entry_into_force'],
    ['MA/PROV', '{MA/PART} {V} {ART} 2', 'provisional_application'],
    ['PE', '{PE/PART} {V} {ART} 2', 'takes_effect'],
    ['MA', '{PE/PART} {V} {ART} 2', 'application'],
    ['MA/PART', '{V} {ART} 2', 'partial_application'],
    ['MA', 'MA/PART {V} {ART} 2', 'application'],
  ])('a %s date commented "%s" is %s', (code, comment, type) => {
    expect(datesOf(effectItem('2020-01-01', code, comment))?.[0]?.type).toBe(type);
  });

  it('decodes the comment, whose spaces and | the encoding hides from the item separators', () => {
    expect(datesOf(effectItem('2020-01-01', 'EV', 'DATς + 1 {V} {ART} 2'))).toEqual([
      { date: '2020-01-01', type: 'entry_into_force', provision: 'Article 2' },
    ]);
  });

  it('lists one entry per date, type, and provision', () => {
    expect(
      datesOf(
        effectItem('2020-01-01', 'MA', '{V} {ART} 10'),
        effectItem('2020-01-01', 'MA', '{V} {ART} 2'),
        // Another basis, the same provision: still one entry.
        effectItem('2020-01-01', 'MA', '{DATPUB} +3 {V} {ART} 2'),
        effectItem('2020-01-01', 'MA', '{V} {TEXTE}'),
        effectItem('2020-01-01', 'MA', '{MA/PART} {V} {ART} 2'),
        effectItem('2020-01-01', 'EV', '{DATPUB} +20 {V} {ART} 10'),
        '2020-01-01||',
      ),
    ).toEqual([
      { date: '2020-01-01', type: 'entry_into_force', provision: 'Article 10' },
      { date: '2020-01-01', type: 'application', provision: 'Article 2' },
      { date: '2020-01-01', type: 'application', provision: 'Article 10' },
      { date: '2020-01-01', type: 'application' },
      { date: '2020-01-01', type: 'partial_application', provision: 'Article 2' },
      { date: '2020-01-01' },
    ]);
  });

  it('32024R1689: the AI Act’s five dates, three of them partial', () => {
    expect(
      datesOf(
        effectItem('2027-08-02', 'MA', '{MA/PART} {V} {ART} 113(c)'),
        effectItem('2024-08-01', 'EV', '{DATPUB} +20 {V} {ART} 113'),
        effectItem('2025-08-02', 'MA', '{MA/PART} {V} {ART} 113(b)'),
        effectItem('2026-08-02', 'MA', '{V} {ART} 113'),
        effectItem('2025-02-02', 'MA', '{MA/PART} {V} {ART} 113(a)'),
      ),
    ).toEqual([
      { date: '2024-08-01', type: 'entry_into_force', provision: 'Article 113' },
      { date: '2025-02-02', type: 'partial_application', provision: 'Article 113(a)' },
      { date: '2025-08-02', type: 'partial_application', provision: 'Article 113(b)' },
      { date: '2026-08-02', type: 'application', provision: 'Article 113' },
      { date: '2027-08-02', type: 'partial_application', provision: 'Article 113(c)' },
    ]);
  });
});

describe('actCitationQuery', () => {
  /** The query's projection and its WHERE clause. */
  const parts = (query: string) => {
    const where = query.indexOf('WHERE {');
    return { select: query.slice(0, where), patterns: query.slice(where) };
  };

  it('types each entry-into-force date inside that date’s OPTIONAL, from the act', () => {
    expect(actCitationQuery(SERVED, ACT, '32016R0679')).toMatch(
      new RegExp(
        `OPTIONAL \\{\\s*<${ACT}> cdm:resource_legal_date_entry-into-force \\?entryIntoForceDate \\.\\s*OPTIONAL \\{[^{}]*annotatedTarget> \\?entryIntoForceDate ;[^{}]*type_of_date> \\?effectType \\.`,
      ),
    );
  });

  it('reads each typed date’s comment inside its axiom’s OPTIONAL and appends it encoded (#181)', () => {
    const query = actCitationQuery(SERVED, ACT, '32016R0679');
    expect(query).toMatch(
      /type_of_date> \?effectType \.\s*OPTIONAL \{ \?effectAxiom <http:\/\/publications\.europa\.eu\/ontology\/annotation#comment_on_date> \?effectComment \. \}\s*\}\s*\}/,
    );
    expect(query).toContain(
      'CONCAT(STR(?entryIntoForceDate), "|", COALESCE(STR(?effectType), ""), "|", COALESCE(ENCODE_FOR_URI(STR(?effectComment)), ""))',
    );
  });

  it('is one aggregate-only SELECT with no GROUP BY or LIMIT, so it returns one row (#173)', () => {
    const query = actCitationQuery(SERVED, ACT, '31962R0017');
    const { select, patterns } = parts(query);
    expect(query.trim().startsWith('SELECT')).toBe(true);
    expect(query.trim().endsWith('}')).toBe(true);
    expect(query).not.toContain('GROUP BY');
    expect(query).not.toContain('LIMIT');
    // Every projected column is an aggregate.
    expect(
      select
        .replace(/^\s*SELECT/, '')
        .replace(/\((?:MIN|GROUP_CONCAT)\(.*\) AS \?\w+\)/g, '')
        .trim(),
    ).toBe('');
    // The ELI is the served work's; every other fact the act's.
    expect(patterns).toContain(`<${SERVED}> cdm:resource_legal_eli ?eliValue`);
    expect(patterns.split(`<${SERVED}>`)).toHaveLength(2);
  });

  it.each([
    ['31962R0017', true],
    ['11957E/TXT', true],
    ['31972R0001', true],
    [undefined, true],
    ['31973R0001', false],
    ['32016R0679', false],
  ])('%s joins the original-language pages: %s', (celex, joined) => {
    const { patterns, select } = parts(actCitationQuery(SERVED, ACT, celex));
    expect(patterns.includes('?ojOriginalFirst')).toBe(joined);
    // The projection never names a variable the patterns leave out.
    expect(select.includes('?ojOriginalFirst')).toBe(joined);
  });
});

/**
 * Upstream-sized aggregates the reader scans: a GROUP_CONCAT of page pairs or dates
 * is bounded only by what CELLAR returns. Each shape grows by doubling from 5k to
 * 320k characters; each size is checked before the next runs, and the full span
 * must stay far below quadratic (64× input, ratio < 256).
 */
describe('readActCitation scales linearly', () => {
  const shapes: [string, (n: number) => Record<string, { type: string; value: string }>][] = [
    [
      'page pairs on one long line ending in a break',
      (n) => ({
        ojIssue: literal(`2016-05-04|${COLLECTION}OJ-L|119|R`),
        ojEnglishPages: literal(`${'§1 x'.repeat(n / 4)}\ny`),
      }),
    ],
    [
      'page pairs of breaks throughout',
      (n) => ({
        ojIssue: literal(`2016-05-04|${COLLECTION}OJ-L|119|R`),
        ojEnglishPages: literal('  \r\n'.repeat(n / 4)),
      }),
    ],
    [
      'zero-padded numeric pages',
      (n) => ({
        ojIssue: literal(`2016-05-04|${COLLECTION}OJ-L|119|R`),
        ojEnglishPages: literal(`${'0'.repeat(n)}1|${'0'.repeat(n)}`),
      }),
    ],
    [
      'dates of effect on one long line ending in a break',
      (n) => ({ datesOfEffect: literal(`${'§1 x'.repeat(n / 4)}\ny`) }),
    ],
    [
      'dates of effect of repeated openers with no closer',
      (n) => ({ datesOfEffect: literal(`2020-01-01|{${'{'.repeat(n)}`) }),
    ],
    // #181: the comment is decoded, its tokens reduced, and its tail read as a provision.
    ...(
      [
        [
          'a comment on one long line ending in a break',
          (n) => `{V} {ART} ${'§1 x'.repeat(n / 4)}\ny`,
        ],
        ['a comment of breaks throughout', (n) => `{V} {ART} ${'  \r\n'.repeat(n / 4)}`],
        ['a comment of token openers with no closer', (n) => '{V|'.repeat(n / 3)],
        [
          'a comment of one token opener with a long unclosed tail',
          (n) => `{a|${'b|'.repeat(n / 2)}`,
        ],
        ['a comment of repeated see codes', (n) => '{V} '.repeat(n / 4)],
        ['a provision number of dotted parts', (n) => `{V} {ART} ${'1.'.repeat(n / 2)}1`],
        ['a provision number of subdivisions', (n) => `{V} {ART} 1${'(a)'.repeat(n / 3)}`],
        ['a provision number of one long digit run', (n) => `{V} {ART} ${'1'.repeat(n)}`],
      ] as [string, (n: number) => string][]
    ).map(([label, comment]): (typeof shapes)[number] => [
      label,
      (n) => ({ datesOfEffect: literal(effectItem('2020-01-01', 'MA', comment(n))) }),
    ]),
  ];

  it.each(shapes)(
    '%s',
    async (_label, build) => {
      const sizes = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000];
      const times: number[] = [];
      for (const n of sizes) {
        const binding = build(n);
        const t = await bestCpuMs(() => readActCitation(binding));
        expect(t, `${t.toFixed(3)} ms at ${n}`).toBeLessThan(250);
        times.push(t);
      }
      const ratio = (times.at(-1) as number) / Math.max(times[0] as number, 0.01);
      expect(ratio, times.map((t) => t.toFixed(3)).join(', ')).toBeLessThan(256);
    },
    CPU_TIMED_TEST_TIMEOUT_MS,
  );
});
