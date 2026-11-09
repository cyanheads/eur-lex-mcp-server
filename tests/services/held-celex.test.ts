/**
 * @fileoverview Tests for the CELEX numbers CELLAR holds one numbering convention away
 * from a CELEX that names no work (#196): how a miss is read, the one query of exact
 * literals it sends, what the answer names, the not_found it builds, and the linear
 * cost of reading caller-sized text.
 * @module tests/services/held-celex.test
 */

import { serviceUnavailable, validationError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  celexMissError,
  findHeldCelex,
  readCelexMiss,
} from '@/services/cellar-sparql/held-celex.js';
import { bestCpuMs, CPU_TIMED_TEST_TIMEOUT_MS } from '../helpers/cpu-time.js';

type Row = Record<string, { type: string; value: string }>;

const CELLAR = 'http://publications.europa.eu/resource/cellar/';

/** The 99 `(nn)` siblings of `stem`. */
const siblings = (stem: string) =>
  Array.from({ length: 99 }, (_, i) => `${stem}(${String(i + 1).padStart(2, '0')})`);

/** CELEX numbers CELLAR holds outside sector 0, as read live on 2026-11-09. */
const HELD = new Set([
  '32014R0833',
  '32006R1907',
  '52026AG0012(01)',
  '52026AG0012(02)',
  '62009CJ0197',
  '32023R0138',
]);

/**
 * Base acts and the CELEX and date of each of their consolidated versions. The rows
 * of `32014R0833` and `32006R1907`, `01999D0010`'s two base acts, and `32000O0007`'s
 * mixed numbering follow CELLAR on 2026-11-09; the rest are trimmed to the versions
 * a case reads, plus a version dated after today.
 */
const CONSOLIDATIONS: Record<string, [celex: string, date: string][]> = {
  '32014R0833': [
    ['02014R0833-20260424', '2026-04-24'],
    ['02014R0833-20260724', '2026-07-24'],
    ['02014R0833-20270101', '2027-01-01'],
  ],
  '32006R1907': [
    ['02006R1907-20250101', '2025-01-01'],
    ['02006R1907-20251023', '2025-10-23'],
    ['02006R1907-20260622', '2026-06-22'],
  ],
  '31999D0010': [
    ['01999D0010-19991201', '1999-12-01'],
    ['01999D0010-20020901', '2002-09-01'],
  ],
  '41999D0010': [['01999D0010-20000922', '2000-09-22']],
  '32000O0007': [
    ['02000O0007-20050101', '2005-01-01'],
    ['02000X0776-20100101', '2010-01-01'],
    ['02000X0776-20150101', '2015-01-01'],
  ],
  '32001D0015(01)': [['02001D0913-20050101', '2005-01-01']],
  '32021D1442': [['02021D1442-20261201', '2026-12-01']],
};

/** The unescaped CELEX literals of the `VALUES` list on `variable`. */
function valuesOf(sparql: string, variable: string): string[] {
  const list = new RegExp(`VALUES \\?${variable} \\{([^}]*)\\}`).exec(sparql)?.[1] ?? '';
  return [...list.matchAll(/"((?:[^"\\]|\\.)*)"\^\^xsd:string/g)].map((m) => m[1] ?? '');
}

/**
 * Answers both queries as CELLAR evaluates them as written: the forms query with the
 * CELEX among its `VALUES` that some work carries; the base-act query with one row
 * per listed base act that has a consolidated version, each aggregate read from the
 * date bound and the `STRSTARTS` prefix the query carries, a version as
 * `date|CELEX`, `""` when none qualifies.
 */
async function fakeCellar(sparql: string): Promise<Row[]> {
  if (sparql.includes('VALUES ?heldCelex')) {
    return valuesOf(sparql, 'heldCelex')
      .filter((celex) => HELD.has(celex))
      .map((celex) => ({ heldCelex: { type: 'literal', value: celex } }));
  }
  /** The date bound of the aggregate projected as `alias`, the last one before it. */
  const bound = (alias: string) => {
    const end = sparql.indexOf(`AS ?${alias})`);
    if (end === -1) return;
    const bounds = [...sparql.slice(0, end).matchAll(/STR\(\?consolidationDate\) <= "([^"]*)"/g)];
    return bounds.at(-1)?.[1];
  };
  const newest = (versions: [string, string][], date: string | undefined) => {
    if (date === undefined) return;
    return (
      versions
        .filter(([, d]) => d <= date)
        .map(([celex, d]) => `${d}|${celex}`)
        .sort()
        .at(-1) ?? ''
    );
  };
  const prefix = /STRSTARTS\(STR\(\?consolidationCelex\), "([^"]*)"\)/.exec(sparql)?.[1];
  return valuesOf(sparql, 'baseCelex').flatMap((baseCelex) => {
    const versions = CONSOLIDATIONS[baseCelex];
    if (!versions) return [];
    const row: Row = {
      baseCelex: { type: 'literal', value: baseCelex },
      baseWorkUri: { type: 'literal', value: `${CELLAR}${baseCelex}` },
      carriesCore: {
        type: 'literal',
        value: versions.some(([celex]) => prefix && celex.startsWith(prefix)) ? '1' : '0',
      },
    };
    for (const alias of ['current', 'inEffect']) {
      const value = newest(versions, bound(alias));
      if (value !== undefined) row[alias] = { type: 'literal', value };
    }
    return [row];
  });
}

const query = vi.fn(fakeCellar);
const svc = { query };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-09T12:00:00Z'));
  query.mockClear();
  query.mockImplementation(fakeCellar);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('readCelexMiss', () => {
  it.each([
    [
      'a consolidated CELEX with no date, under the base sectors whose type codes hold R',
      '02014R0833',
      { kind: 'consolidated', core: '02014R0833', bases: ['12014R0833', '32014R0833'] },
    ],
    [
      'a dated consolidated CELEX, its date read as ISO 8601',
      '02006R1907-20260101',
      {
        kind: 'consolidated',
        core: '02006R1907',
        bases: ['12006R1907', '32006R1907'],
        date: '2026-01-01',
      },
    ],
    [
      'a consolidated CELEX with a (nn) ordinal in its core',
      '02006A0901(01)-20090301',
      {
        kind: 'consolidated',
        core: '02006A0901(01)',
        bases: [
          '12006A0901(01)',
          '22006A0901(01)',
          '32006A0901(01)',
          '42006A0901(01)',
          'E2006A0901(01)',
        ],
        date: '2009-03-01',
      },
    ],
    [
      'a consolidated CELEX whose type only sector 5 holds',
      '02019XG0101',
      { kind: 'consolidated', core: '02019XG0101', bases: ['52019XG0101'] },
    ],
  ])('reads %s', (_label, celex, reading) => {
    expect(readCelexMiss(celex)).toEqual(reading);
  });

  it.each([
    ['a CELEX with no (nn): its 99 siblings', '52026AG0012', siblings('52026AG0012')],
    ['a CELEX with a (nn): the CELEX without it', '62009CJ0197(01)', ['62009CJ0197']],
    [
      'a three-digit number: the siblings and the number zero-padded',
      '32023R138',
      [...siblings('32023R138'), '32023R0138'],
    ],
    [
      'a one-digit number with a (nn): the CELEX without it and the padded number',
      '32023R1(02)',
      ['32023R1', '32023R0001(02)'],
    ],
    ['the first year a CELEX carries', '31951R0001', siblings('31951R0001')],
    ['next year', '32027R0001', siblings('32027R0001')],
    ['sector E', 'E2003C0097', siblings('E2003C0097')],
  ])('reads %s', (_label, celex, forms) => {
    expect(readCelexMiss(celex)).toEqual({ kind: 'act', forms });
  });

  it.each([
    ['a year past next year', '043443136'],
    ['a consolidated CELEX dated past next year', '02099R9999'],
    ['a dated consolidated CELEX past next year', '02099R9999-20260101'],
    ['a year before 1951', '31950R0001'],
    ['the year after next', '32028R0001'],
    ['a type code its sector lacks', '32016ZZ0679'],
    ['a sector-0 type code no consolidation carries', '02000Z0001'],
    ['a date no calendar has', '02014R0833-20261399'],
    ['a date outside sector 0', '32014R0833-20260101'],
    ['a five-digit number', '32016R06790'],
    ['a corrigendum suffix', '32016R0679R(02)'],
    ['a national-measure suffix', '72014L0056FIN_240353'],
    ['a sector-C CELEX', 'C2024/01469'],
    ['a treaty reference', '11957A/PRO/CJ/09'],
    ['no type letters', '320160679'],
  ])('sends no query for %s', async (_label, celex) => {
    expect(readCelexMiss(celex)).toBeUndefined();
    await expect(findHeldCelex(svc, celex, createMockContext())).resolves.toEqual({ kind: 'none' });
    expect(query).not.toHaveBeenCalled();
  });
});

describe('findHeldCelex', () => {
  it('sends one query of exact typed literals, with no prefix or substring scan of CELEX literals', async () => {
    await findHeldCelex(svc, '52026AG0012', createMockContext());
    expect(query).toHaveBeenCalledTimes(1);
    const [sparql = ''] = query.mock.calls[0] ?? [];
    expect(valuesOf(sparql, 'heldCelex')).toEqual(siblings('52026AG0012'));
    expect(sparql).toContain('?heldWork cdm:resource_legal_id_celex ?heldCelex .');
    expect(sparql).not.toMatch(/FILTER|CONTAINS|STRSTARTS|REGEX|bif:contains/);
  });

  it.each([
    ['52026AG0012', ['52026AG0012(01)', '52026AG0012(02)']],
    ['62009CJ0197(01)', ['62009CJ0197']],
    ['32023R138', ['32023R0138']],
  ])('names the forms CELLAR holds one convention away from %s', async (celex, held) => {
    const result = await findHeldCelex(svc, celex, createMockContext());
    expect(result).toEqual({
      kind: 'held',
      celex: held,
      named: [celex, ...held],
      sentence: `CELLAR holds ${new Intl.ListFormat('en').format(held)}.`,
    });
  });

  it.each([['52026AG9999'], ['62009CJ9999(01)'], ['31958R999'], ['32023R0987']])(
    'finds nothing for %s, whose forms CELLAR does not hold',
    async (celex) => {
      await expect(findHeldCelex(svc, celex, createMockContext())).resolves.toEqual({
        kind: 'none',
      });
      expect(query).toHaveBeenCalledTimes(1);
    },
  );

  it('reads a base act’s versions only through its own consolidations, bounded on today and the core', async () => {
    await findHeldCelex(svc, '02014R0833', createMockContext());
    const [sparql = ''] = query.mock.calls[0] ?? [];
    expect(valuesOf(sparql, 'baseCelex')).toEqual(['12014R0833', '32014R0833']);
    expect(sparql).toContain(
      '?consolidation cdm:act_consolidated_based_on_resource_legal ?baseWork ;',
    );
    expect(sparql).toContain('STR(?consolidationDate) <= "2026-11-09"');
    expect(sparql).toContain('STRSTARTS(STR(?consolidationCelex), "02014R0833-")');
    expect(sparql).not.toContain('AS ?inEffect');
    expect(sparql).toContain('GROUP BY ?baseCelex');
    // Equality on a STR() of a variable scans; no comparison here is one.
    expect(sparql).not.toMatch(/STR\(\?\w+\)\s*=/);
  });

  it('names the current version of a consolidated CELEX with no date, never one dated after today', async () => {
    const result = await findHeldCelex(svc, '02014R0833', createMockContext());
    expect(result).toEqual({
      kind: 'held',
      celex: ['02014R0833-20260724'],
      named: ['02014R0833', '02014R0833-20260724', '32014R0833'],
      sentence: 'CELLAR holds 02014R0833-20260724, the current consolidated version of 32014R0833.',
      current: {
        celex: '02014R0833-20260724',
        asOf: '2026-07-24',
        base: { celex: '32014R0833', workUri: `${CELLAR}32014R0833` },
      },
    });
  });

  it('names the version in effect on the date a consolidated CELEX carries, then the current one', async () => {
    const result = await findHeldCelex(svc, '02006R1907-20260101', createMockContext());
    const [sparql = ''] = query.mock.calls[0] ?? [];
    expect(sparql).toContain('STR(?consolidationDate) <= "2026-01-01"');
    expect(result).toEqual({
      kind: 'held',
      celex: ['02006R1907-20251023', '02006R1907-20260622'],
      named: ['02006R1907-20260101', '02006R1907-20251023', '02006R1907-20260622', '32006R1907'],
      sentence:
        'CELLAR holds 02006R1907-20251023, the consolidated version of 32006R1907 in effect on 2026-01-01, and 02006R1907-20260622, its current one.',
      current: {
        celex: '02006R1907-20260622',
        asOf: '2026-06-22',
        base: { celex: '32006R1907', workUri: `${CELLAR}32006R1907` },
      },
    });
  });

  it('names one version once when the one in effect on the date is the current one', async () => {
    const result = await findHeldCelex(svc, '02006R1907-20261001', createMockContext());
    expect(result).toMatchObject({
      celex: ['02006R1907-20260622'],
      sentence:
        'CELLAR holds 02006R1907-20260622, the consolidated version of 32006R1907 in effect on 2026-10-01 and its current one.',
    });
  });

  it('names only the current version when none was in effect on the date', async () => {
    const result = await findHeldCelex(svc, '02006R1907-19900101', createMockContext());
    expect(result).toMatchObject({
      celex: ['02006R1907-20260622'],
      sentence: 'CELLAR holds 02006R1907-20260622, the current consolidated version of 32006R1907.',
    });
  });

  it('names a version in effect on a future date, with no current one to serve', async () => {
    const result = await findHeldCelex(svc, '02021D1442-20270101', createMockContext());
    expect(result).toEqual({
      kind: 'held',
      celex: ['02021D1442-20261201'],
      named: ['02021D1442-20270101', '02021D1442-20261201', '32021D1442'],
      sentence:
        'CELLAR holds 02021D1442-20261201, the consolidated version of 32021D1442 in effect on 2027-01-01.',
    });
  });

  it('finds nothing for an act whose only versions are dated after today and after the date asked', async () => {
    await expect(findHeldCelex(svc, '02021D1442', createMockContext())).resolves.toEqual({
      kind: 'none',
    });
  });

  it('names each base act whose versions carry the core, and offers none to serve', async () => {
    const result = await findHeldCelex(svc, '01999D0010', createMockContext());
    expect(result).toEqual({
      kind: 'held',
      celex: ['01999D0010-20020901', '01999D0010-20000922'],
      named: [
        '01999D0010',
        '01999D0010-20020901',
        '01999D0010-20000922',
        '31999D0010',
        '41999D0010',
      ],
      sentence:
        'CELLAR holds 01999D0010-20020901, the current consolidated version of 31999D0010; and 01999D0010-20000922, the current consolidated version of 41999D0010.',
    });
  });

  it('reads the versions of several base acts on a date, each by its own', async () => {
    const result = await findHeldCelex(svc, '01999D0010-20010101', createMockContext());
    expect(result).toMatchObject({
      celex: ['01999D0010-19991201', '01999D0010-20020901', '01999D0010-20000922'],
      sentence:
        'CELLAR holds 01999D0010-19991201, the consolidated version of 31999D0010 in effect on 2001-01-01, and 01999D0010-20020901, its current one; and 01999D0010-20000922, the consolidated version of 41999D0010 in effect on 2001-01-01 and its current one.',
    });
  });

  it('serves the current version of a base act whose versions are numbered differently, when one carries the core', async () => {
    const result = await findHeldCelex(svc, '02000O0007', createMockContext());
    expect(result).toMatchObject({
      celex: ['02000X0776-20150101'],
      current: { celex: '02000X0776-20150101', base: { celex: '32000O0007' } },
    });
  });

  it.each([
    ['a base act none of whose versions carries the core', '02001D0015(01)'],
    ['a core no base act carries', '02000X0776-20200101'],
    ['an act CELLAR does not hold', '02026R9999'],
    ['a dated act CELLAR does not hold', '02026R9999-20260101'],
  ])('finds nothing for %s', async (_label, celex) => {
    await expect(findHeldCelex(svc, celex, createMockContext())).resolves.toEqual({
      kind: 'none',
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('leaves the forms unchecked, saying so, when CELLAR does not answer in time', async () => {
    query.mockRejectedValueOnce(
      serviceUnavailable('CELLAR SPARQL queries for this request ran past the time budget', {
        reason: 'sparql_timeout',
        retryable: true,
      }),
    );
    await expect(findHeldCelex(svc, '52026AG0012', createMockContext())).resolves.toEqual({
      kind: 'unchecked',
      sentence:
        'CELLAR did not answer whether it holds a CELEX one numbering convention away; call again to check.',
    });
  });

  it('propagates a query CELLAR rejects', async () => {
    const rejected = validationError('CELLAR SPARQL error: Virtuoso 37000 Error SP030', {
      reason: 'sparql_error',
    });
    query.mockRejectedValueOnce(rejected);
    await expect(findHeldCelex(svc, '52026AG0012', createMockContext())).rejects.toBe(rejected);
  });

  it('propagates the caller’s cancellation rather than reading it as an unanswered lookup', async () => {
    const controller = new AbortController();
    controller.abort();
    const cancelled = serviceUnavailable('aborted mid-request', { reason: 'sparql_timeout' });
    query.mockRejectedValueOnce(cancelled);
    await expect(
      findHeldCelex(svc, '52026AG0012', createMockContext({ signal: controller.signal })),
    ).rejects.toBe(cancelled);
  });
});

describe('celexMissError', () => {
  const message = 'No CELLAR work found for CELEX: 52026AG0012';

  it('keeps the message as given, with no data or literals, when nothing is held', () => {
    expect(celexMissError(message, { kind: 'none' })).toEqual({ message, data: {}, options: {} });
  });

  it('names each held CELEX in the message and held_celex, every CELEX named a literal', () => {
    expect(
      celexMissError(message, {
        kind: 'held',
        celex: ['52026AG0012(01)', '52026AG0012(02)'],
        named: ['52026AG0012', '52026AG0012(01)', '52026AG0012(02)'],
        sentence: 'CELLAR holds 52026AG0012(01) and 52026AG0012(02).',
      }),
    ).toEqual({
      message: `${message}. CELLAR holds 52026AG0012(01) and 52026AG0012(02).`,
      data: { held_celex: ['52026AG0012(01)', '52026AG0012(02)'] },
      options: { literals: ['52026AG0012', '52026AG0012(01)', '52026AG0012(02)'] },
    });
  });

  it('says the forms went unchecked, with no held_celex', () => {
    expect(celexMissError(message, { kind: 'unchecked', sentence: 'Unchecked.' })).toEqual({
      message: `${message}. Unchecked.`,
      data: {},
      options: {},
    });
  });
});

/**
 * readCelexMiss runs on every CELEX miss, and a CELEX input has no length cap. Each
 * shape is timed in thread CPU at every doubling from 5k to 320k characters, per call
 * over a batch at the small sizes, bounded at each size before the next runs, with
 * the full 64× span held under 256×: the two line-break shapes, and runs in each
 * position the pattern reads — the year, the type letters, the number, a repeated
 * `(nn)`, a repeated opener with no closer, and the date.
 */
describe('readCelexMiss runs in linear time', () => {
  const SIZES = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000];
  const shapes: [string, (n: number) => string][] = [
    ['one long line ending in a break', (n) => `${'§1 x'.repeat(n / 4)}\ny`],
    ['breaks throughout', (n) => '  \r\n'.repeat(n / 4)],
    ['a digit run as the year', (n) => `3${'2'.repeat(n)}`],
    ['a letter run as the type', (n) => `32014${'R'.repeat(n)}0833`],
    ['a digit run as the number', (n) => `32014R${'0'.repeat(n)}`],
    ['repeated ordinals', (n) => `52026AG0012${'(01)'.repeat(n / 4)}`],
    ['a repeated opener with no closer', (n) => `0${'2014R0833('.repeat(n / 10)}`],
    ['a digit run as the date', (n) => `02014R0833-${'2'.repeat(n)}`],
  ];
  it.each(shapes)(
    '%s',
    async (_label, shape) => {
      const timings: number[] = [];
      for (const size of SIZES) {
        const text = shape(size);
        const batch = (SIZES.at(-1) ?? size) / size;
        const cpu =
          (await bestCpuMs(() => {
            for (let i = 0; i < batch; i++) readCelexMiss(text);
          })) / batch;
        expect(cpu, `${size} characters: ${cpu.toFixed(4)} ms CPU per call`).toBeLessThan(50);
        timings.push(cpu);
      }
      const [first = 0] = timings;
      const last = timings.at(-1) ?? 0;
      expect(last / Math.max(first, 0.001), JSON.stringify(timings)).toBeLessThan(256);
    },
    CPU_TIMED_TEST_TIMEOUT_MS,
  );
});
