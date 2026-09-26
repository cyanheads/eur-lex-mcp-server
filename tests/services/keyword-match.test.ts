/**
 * @fileoverview Tests for the keyword graph pattern's partial-CELEX arm: the route a
 * fragment takes (full-text prefix terms, substring scan, or titles only), parity of
 * the index route with the substring scan over live CELEX values, and the guarantee
 * that nothing a caller types reaches the `bif:contains` expression outside a
 * `[0-9A-Z]` run.
 * @module tests/services/keyword-match.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CELEX_TYPE_CODES,
  type CelexFragmentRoute,
  celexFragmentRoute,
  keywordMatchPattern,
} from '@/services/cellar-sparql/keyword-match.js';

type Sector = keyof typeof CELEX_TYPE_CODES;
const SECTORS: Sector[] = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', 'E'];

/** Years 1951 through 2027, next year under the fixed clock. */
const YEARS = 2027 - 1951 + 1;

/** Every `?kwCelex bif:contains "…"` expression in a pattern. */
function celexFullTextExpressions(pattern: string): string[] {
  return [...pattern.matchAll(/\?kwCelex bif:contains "([^"]*)"/g)].map((m) => m[1] ?? '');
}

/** Every confirming or scanning substring literal of the partial arm. */
function confirmingLiterals(pattern: string): string[] {
  return [...pattern.matchAll(/FILTER\(CONTAINS\(STR\(\?kwCelex\), "((?:[^"\\]|\\.)*)"\)\)/g)].map(
    (m) => m[1] ?? '',
  );
}

/** A full-text expression made only of quoted `[0-9A-Z]` prefix terms joined by OR. */
const SAFE_EXPRESSION = /^'[0-9A-Z]+\*'(?: OR '[0-9A-Z]+\*')*$/;

/** The index route's terms, failing the test on any other route. */
function indexTerms(keyword: string): string[] {
  const route = celexFragmentRoute(keyword);
  if (route.kind !== 'index') throw new Error(`${keyword} took the ${route.kind} route`);
  return route.terms;
}

/** Type codes of `sector` ending in `letters`. */
function codesEndingIn(sector: Sector, letters: string): string[] {
  return CELEX_TYPE_CODES[sector].filter((code) => code.endsWith(letters));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-25T12:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('CELEX_TYPE_CODES', () => {
  it('pins every sector type code CELLAR held on 2026-09-25', () => {
    const split = (codes: string) => codes.split(' ');
    expect(CELEX_TYPE_CODES).toEqual({
      '0': split('A B C D E F G H J L M ME N O P Q R S T W X XC XG Y'),
      '1': split(
        'A AN AR B BN C D DNA DNB E EN F G H HN I IN J JN K KN L LN LR M MA MB MC MD ME MF MG MH MI MJ MK ML MM MN MO MP MQ MR MS N NN P R S SA SAFI SAN SP SPN SPR T TN TR U V VN W X XA XB XC',
      ),
      '2': split('A D P X XC'),
      '3': split('A B C D E F G H J K L M O Q R S X Y'),
      '4': split('A D X Y Z'),
      '5': split(
        'AA AB AC AE AG AK AP AR AS AT BC BP DC DMA DP DSA EC FC GC HB IE IG IP IR JC KG M PC SA SC TA XA XB XC XE XG XK XP XR XX',
      ),
      '6': split('CA CB CC CD CG CJ CN CO CP CS CT CU CV CX FA FB FJ FN FO TA TB TC TJ TN TO TT'),
      '7': split('D F L R'),
      '8': split(
        'AT BE BG CH CY CZ DE DK EE EL ES ET FI FR HR HU IE IS IT LT LU LV MT NL NO PL PT RO SE SI SK SL UK XI XX',
      ),
      '9': split('E H O'),
      C: [],
      E: split('A C G J P X'),
    });
    expect(Object.keys(CELEX_TYPE_CODES)).toEqual(SECTORS);
    expect(Object.values(CELEX_TYPE_CODES).flat()).toHaveLength(232);
  });
});

describe('celexFragmentRoute (#123)', () => {
  it.each([
    ['02016R0679', '02016R0679'],
    ['32016R9999', '32016R9999'],
    ['20160504', '20160504'],
    ['02016R0679-20160504', '02016R0679'],
  ])('uses the run itself for %s, which opens with five digits', (keyword, run) => {
    expect(celexFragmentRoute(keyword)).toEqual({ kind: 'index', terms: [run] });
  });

  it('reads C or E and a year both as a sector and year and as type letters and a number', () => {
    const terms = indexTerms('C2017');
    expect(terms[0]).toBe('C2017');
    // 51973PC2017 holds C2017 as type letters and number.
    expect(terms).toContain('51973PC2017');
    const codesEndingInC = SECTORS.flatMap((s) => codesEndingIn(s, 'C'));
    expect(terms).toHaveLength(1 + codesEndingInC.length * YEARS);

    expect(indexTerms('E1952')).toContain('52009AE1952');
    expect(indexTerms('E2003C0097')[0]).toBe('E2003C0097');
  });

  it.each([
    ['C0097', '51975AC0097'],
    ['C0123', '61977CC0123'],
    ['E0124', '92011E0124'],
    ['E0124', '81991DE0124'],
  ])('reads %s, whose digits are no year, as type letters and a number', (keyword, term) => {
    const terms = indexTerms(keyword);
    expect(terms).toContain(term);
    expect(terms).not.toContain(keyword);
  });

  it.each(['2016R0679', '2014CJ0362', '2026R19', '2027R0001', '1951R0001'])(
    'puts each of the 12 sectors before %s, which opens with a year and a letter',
    (keyword) => {
      expect(celexFragmentRoute(keyword)).toEqual({
        kind: 'index',
        terms: SECTORS.map((s) => `${s}${keyword}`),
      });
    },
  );

  it.each(['0679R', '0680DEU', '9999R0679', '2028R0001', '1950R0001'])(
    'matches titles only for %s, whose four digits before a letter are no year',
    (keyword) => {
      expect(celexFragmentRoute(keyword)).toEqual({ kind: 'titles' });
    },
  );

  it.each([
    ['R0679', 'R'],
    ['CJ0362', 'CJ'],
    ['J0131', 'J'],
    ['N0123', 'N'],
    ['R0065', 'R'],
    ['PC0123', 'PC'],
  ])(
    'completes %s with every sector, year, and type code ending in its letters',
    (keyword, letters) => {
      const tail = keyword.slice(letters.length);
      const expected = SECTORS.flatMap((sector) =>
        codesEndingIn(sector, letters).flatMap((code) =>
          Array.from({ length: YEARS }, (_, i) => `${sector}${1951 + i}${code}${tail}`),
        ),
      );
      expect(expected.length).toBeGreaterThan(0);
      expect(celexFragmentRoute(keyword)).toEqual({ kind: 'index', terms: expected });
    },
  );

  it('reaches the type code whose tail the letters are', () => {
    expect(indexTerms('J0131')).toContain('62013CJ0131');
    expect(indexTerms('J0131')).toContain('61951TJ0131');
    expect(indexTerms('R0065')).toContain('52001AR0065');
    expect(indexTerms('N0123')).toContain('62014CN0123');
    // Sector 6 alone has a type code ending in CJ.
    expect(indexTerms('CJ0362').every((term) => /^6\d{4}CJ0362$/.test(term))).toBe(true);
  });

  it.each(['QQ0131', 'ZZ1', 'XCJ0362'])(
    'scans for %s, whose letters no type code ends in',
    (keyword) => {
      expect(celexFragmentRoute(keyword)).toEqual({ kind: 'scan' });
    },
  );

  it.each(['R(01)', 'ROU_202405', 'C/2024/0146', 'R_1'])(
    'scans for %s, whose letters no digit follows',
    (keyword) => {
      expect(celexFragmentRoute(keyword)).toEqual({ kind: 'scan' });
    },
  );

  it.each(['2024/01469', '2017/111', '2024/'])(
    'scans for %s, a year followed by the / only C-sector CELEX hold',
    (keyword) => {
      expect(celexFragmentRoute(keyword)).toEqual({ kind: 'scan' });
    },
  );

  it.each(['9999/01469', '1950/111'])(
    'matches titles only for %s, whose four digits before a / are no year',
    (keyword) => {
      expect(celexFragmentRoute(keyword)).toEqual({ kind: 'titles' });
    },
  );

  it.each(['016R0679', '0679', '2016', '20R0679', '(01)', '-20160504', ''])(
    'matches titles only for %j, which opens mid-year or mid-number',
    (keyword) => {
      expect(celexFragmentRoute(keyword)).toEqual({ kind: 'titles' });
    },
  );

  it('follows the clock for the last year', () => {
    vi.setSystemTime(new Date('2031-01-01T00:00:00Z'));
    const terms = indexTerms('R0679');
    expect(terms).toContain('32032R0679');
    expect(terms).not.toContain('32033R0679');
    expect(celexFragmentRoute('2032R0001').kind).toBe('index');
    expect(celexFragmentRoute('2033R0001').kind).toBe('titles');
    expect(indexTerms('C2032')[0]).toBe('C2032');
  });

  it('takes the leading run only, stopping at the first character outside [0-9A-Z]', () => {
    expect(indexTerms('2016R0679(01)')).toEqual(SECTORS.map((s) => `${s}2016R0679`));
    expect(indexTerms('2016R0679_INF')).toEqual(SECTORS.map((s) => `${s}2016R0679`));
    expect(indexTerms('R0679R(01)')).toContain('31979R0679R');
  });
});

/**
 * Parity of each route with the substring scan it replaces, over CELEX values from
 * live CELLAR (2026-09-25): for each fragment below, one CELEX per sector and
 * type-code shape the scan reached. The index is modelled as CELLAR's: a term `'X*'`
 * hits a literal when a word of it starts with X, words split at every character
 * outside `[0-9A-Z]`; a hit then needs the confirming substring test.
 */
describe('partial-CELEX parity with the substring scan (#123)', () => {
  const LIVE_CELEX = [
    '01982R0065-19840623',
    '02002R0679-20020423',
    '02007R0329-20160504',
    '02008E0124-20170608',
    '02016D0687-20160504',
    '02016L0681-20160504',
    '02016R0679-20160504',
    '31972R0679',
    '31979R0679R(01)',
    '31990L0679R(01)',
    '32007R0065',
    '32008E0124',
    '32008E0124R(01)',
    '32011R0065R(01)',
    '32016R0679',
    '32016R0679R(01)',
    '32023C0123(01)',
    '32025D1904R(01)',
    '51973PC2017',
    '51975AC0097',
    '51990PC0679R(01)',
    '51996IR0065',
    '51996PC0097',
    '52001AR0065',
    '52001DC0123',
    '52005AE0124',
    '52005DC0097',
    '52005DC0123R(01)',
    '52005PC0123(04)',
    '52009AE1952',
    '52010PC0123',
    '52010XC0123(07)',
    '52013SC0123',
    '52013SC0123R(01)',
    '52015PC0097R(01)',
    '52018DC0097R(01)',
    '52023DC0679R(01)',
    '52023XC01237',
    '52025SC0097R(01)',
    '52025XC00970',
    '52026SC0097',
    '61977CC0123',
    '61981CJ0131(01)',
    '61983CC0097',
    '61995CJ0131',
    '61998CJ0362',
    '62007FJ0131',
    '62010TJ0131',
    '62014CN0123',
    '62014FN0123',
    '62016TJ0131_RES',
    '62016TN0123',
    '62020CJ0362_SUM',
    '71989L0679ROU_136609',
    '71991L0680DEU_87808',
    '72022L2464ROU_202405372',
    '81991DE0124(01)',
    '82002IE0124(01)',
    '82013BE0124(02)',
    '92011E012400',
    'C/2024/01469',
    'C2017/111/07',
    'E1994C0123',
    'E2003C0097',
    'E2020C0123(01)',
  ];

  function reaches(route: CelexFragmentRoute, upper: string, celex: string): boolean {
    if (route.kind === 'titles' || !celex.includes(upper)) return false;
    if (route.kind === 'scan') return true;
    const words = celex.split(/[^0-9A-Z]+/);
    return route.terms.some((term) => words.some((word) => word.startsWith(term)));
  }

  it.each([
    ['C0097', 'index'],
    ['C0123', 'index'],
    ['E0124', 'index'],
    ['J0131', 'index'],
    ['N0123', 'index'],
    ['R0065', 'index'],
    ['R0679', 'index'],
    ['CJ0362', 'index'],
    ['PC0123', 'index'],
    ['2016R0679', 'index'],
    ['02016R0679', 'index'],
    ['20160504', 'index'],
    ['C2017', 'index'],
    ['E1952', 'index'],
    ['ROU_202405', 'scan'],
    ['R(01)', 'scan'],
    ['C/2024/0146', 'scan'],
    ['2024/01469', 'scan'],
    ['2017/111', 'scan'],
  ])('reaches every CELEX the scan reached for %s, by the %s route', (keyword, kind) => {
    const route = celexFragmentRoute(keyword);
    expect(route.kind).toBe(kind);
    const scanned = LIVE_CELEX.filter((celex) => celex.includes(keyword));
    expect(scanned.length, keyword).toBeGreaterThan(0);
    expect(LIVE_CELEX.filter((celex) => reaches(route, keyword, celex))).toEqual(scanned);
  });

  it.each(['0679R', '0680DEU', '016R0679'])(
    'matches titles only for %s, which opens mid-year or mid-number',
    (keyword) => {
      expect(celexFragmentRoute(keyword)).toEqual({ kind: 'titles' });
      expect(LIVE_CELEX.some((celex) => celex.includes(keyword))).toBe(true);
    },
  );
});

describe('keywordMatchPattern partial-CELEX arm (#123)', () => {
  const svc = { query: vi.fn(async () => []) };

  beforeEach(() => {
    svc.query.mockClear();
  });

  it('narrows through the CELEX full-text index, then confirms the substring', async () => {
    const pattern = await keywordMatchPattern(svc, '2016R0679', createMockContext());

    expect(pattern).toContain('?work cdm:resource_legal_id_celex ?kwCelex .');
    expect(celexFullTextExpressions(pattern)).toEqual([
      SECTORS.map((s) => `'${s}2016R0679*'`).join(' OR '),
    ]);
    expect(confirmingLiterals(pattern)).toEqual(['2016R0679']);
    expect(pattern).not.toContain('LCASE');
  });

  it('confirms the whole uppercased keyword, suffix included, while the terms stop at the run', async () => {
    const pattern = await keywordMatchPattern(svc, '2016r0679-2016', createMockContext());

    expect(celexFullTextExpressions(pattern)[0]).toContain(`'32016R0679*'`);
    expect(confirmingLiterals(pattern)).toEqual(['2016R0679-2016']);
  });

  it('completes a type-letter fragment through the type codes', async () => {
    const pattern = await keywordMatchPattern(svc, 'j0131', createMockContext());

    const [expression] = celexFullTextExpressions(pattern);
    expect(expression).toContain(`'62013CJ0131*'`);
    expect(expression).not.toContain(`'62013J0131*'`);
    expect(confirmingLiterals(pattern)).toEqual(['J0131']);
  });

  it.each(['R(01)', 'rou_202405', 'C/2024/0146', '2024/01469'])(
    'scans every CELEX literal for %s, with no full-text expression',
    async (keyword) => {
      const pattern = await keywordMatchPattern(svc, keyword, createMockContext());

      expect(pattern).toContain('?work cdm:resource_legal_id_celex ?kwCelex .');
      expect(celexFullTextExpressions(pattern)).toEqual([]);
      expect(confirmingLiterals(pattern)).toEqual([keyword.toUpperCase()]);
      expect(pattern).not.toContain('LCASE');
    },
  );

  it('builds no CELEX arm for a keyword that opens mid-year or mid-number', async () => {
    for (const keyword of ['0679', '016R0679', '2016', '0679R', '0680DEU']) {
      const pattern = await keywordMatchPattern(svc, keyword, createMockContext());
      expect(pattern).not.toContain('?kwCelex');
      expect(pattern).not.toContain('UNION');
      expect(pattern).toContain(`?kwTitle bif:contains "'${keyword}'"`);
    }
  });

  /**
   * The guarantee the arm rests on: whatever the keyword, every CELEX full-text
   * expression is a list of quoted `[0-9A-Z]` prefix terms, and every confirming or
   * scanning literal holds only CELEX characters. A payload that closes a quote, adds
   * a full-text operator, or ends in a backslash either builds no CELEX arm or leaves
   * its payload out of the expression.
   */
  it.each([
    "2016R0679' OR 'x",
    '2016R0679"',
    "R0679*' AND 'Z",
    'R0679*',
    '2016R0679 AND 1',
    '2016R0679\\',
    'R0679) } ; DROP',
    '2016R0679(01)',
    '2016R0679\n}',
    'r0679_x',
    'R(01)',
    'Ｒ0679',
    '2016ℝ0679',
  ])('keeps %j from breaking out of the CELEX full-text expression', async (keyword) => {
    const pattern = await keywordMatchPattern(svc, keyword, createMockContext());

    for (const expression of celexFullTextExpressions(pattern)) {
      expect(expression).toMatch(SAFE_EXPRESSION);
    }
    for (const literal of confirmingLiterals(pattern)) {
      expect(literal).toMatch(/^[0-9A-Z()/_-]+$/);
    }
  });

  it('holds the guarantee over randomized keywords', async () => {
    const alphabet = `0123456789ABCRcjr()/_-'"*\\ {}.;\n\tORAND`;
    let seed = 123;
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed;
    };
    for (let i = 0; i < 400; i++) {
      const length = 1 + (next() % 16);
      const keyword = Array.from({ length }, () => alphabet[next() % alphabet.length]).join('');
      if (!/[\p{L}\p{N}]/u.test(keyword)) continue;
      const pattern = await keywordMatchPattern(svc, keyword, createMockContext());
      for (const expression of celexFullTextExpressions(pattern)) {
        expect(expression, keyword).toMatch(SAFE_EXPRESSION);
      }
      for (const literal of confirmingLiterals(pattern)) {
        expect(literal, keyword).toMatch(/^[0-9A-Z()/_-]+$/);
      }
      // Every `bif:contains` in the pattern is either the title phrase or a CELEX
      // expression, so no quote a caller typed opens another one.
      expect(pattern.match(/bif:contains/g)?.length ?? 0).toBe(
        1 + celexFullTextExpressions(pattern).length,
      );
    }
  });
});
