/**
 * @fileoverview Tests for the keyword graph pattern's partial-CELEX arm: the route a
 * fragment takes (full-text prefix terms, substring scan, or titles only), parity of
 * the index route with the substring scan over live CELEX values, and the guarantee
 * that nothing a caller types reaches the `bif:contains` expression outside a
 * `[0-9A-Z]` run.
 * @module tests/services/keyword-match.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import { CellarSparqlService } from '@/services/cellar-sparql/cellar-sparql-service.js';
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

  it.each(['R(01)', 'ROU_202405', 'C/24', 'C/202', 'R_1'])(
    'scans for %s, whose letters no digit follows',
    (keyword) => {
      expect(celexFragmentRoute(keyword)).toEqual({ kind: 'scan' });
    },
  );

  it.each([
    ['2024/01469', '01469'],
    ['C/2024/01469', '01469'],
    ['C/2024/0146', '0146'],
    ['2024/0146', '0146'],
    ['2024/01469(01)', '01469'],
    ['2024/01469/X', '01469'],
    ['2024/0146A', '0146A'],
    ['C/9999/01469', '01469'],
  ])(
    'uses the number word of the C-sector fragment %s, a word of its own on the index (#137)',
    (keyword, numberWord) => {
      expect(celexFragmentRoute(keyword)).toEqual({ kind: 'index', terms: [numberWord] });
    },
  );

  it.each(['2017/111', '2024/014', 'C/2024/014', '2024/1', '2024/', 'C/2024/', '2024/(01)'])(
    'scans for %s, whose number word is too short for a prefix term (#137)',
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
    'C/2024/01461',
    'C/2024/01462',
    'C/2024/01467',
    'C/2024/01468',
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
    ['C/2024/0146', 'index'],
    ['C/2024/01469', 'index'],
    ['2024/0146', 'index'],
    ['2024/01469', 'index'],
    ['ROU_202405', 'scan'],
    ['R(01)', 'scan'],
    ['2017/111', 'scan'],
    ['2024/014', 'scan'],
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
    // The lookups resolving the completions find the case CELLAR holds the fragment in,
    // 62013CJ0131, by the text before the fragment in it (#208).
    const holding = {
      query: vi.fn(async () => [{ kwHead: { type: 'literal', value: '62013C' } }]),
    };
    const pattern = await keywordMatchPattern(holding, 'j0131', createMockContext());

    const [expression] = celexFullTextExpressions(pattern);
    expect(expression).toContain(`'62013CJ0131*'`);
    expect(expression).not.toContain(`'62013J0131*'`);
    expect(confirmingLiterals(pattern)).toEqual(['J0131']);
  });

  it.each([
    ['2024/01469', `'01469*'`, '2024/01469'],
    ['c/2024/0146', `'0146*'`, 'C/2024/0146'],
    ['2024/01469-x', `'01469*'`, '2024/01469-X'],
  ])(
    'narrows the C-sector fragment %s on its number word, then confirms the whole fragment (#137)',
    async (keyword, expression, confirmed) => {
      const pattern = await keywordMatchPattern(svc, keyword, createMockContext());

      expect(pattern).toContain('?work cdm:resource_legal_id_celex ?kwCelex .');
      expect(celexFullTextExpressions(pattern)).toEqual([expression]);
      expect(confirmingLiterals(pattern)).toEqual([confirmed]);
    },
  );

  it.each(['R(01)', 'rou_202405', '2024/014', 'c/2024/'])(
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
    "2024/01469' OR 'x",
    "C/2024/0146*' AND 'Z",
    '2024/0146"',
    '2024/0146\\',
    'C/2024/01469 AND 1',
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
        // CELLAR rejects a prefix term with fewer than four leading characters (FT370).
        for (const [, term] of expression.matchAll(/'([0-9A-Z]+)\*'/g)) {
          expect(term?.length, keyword).toBeGreaterThanOrEqual(4);
        }
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

/** CELLAR's limit on a SPARQL request body, form-encoded (HTTP 403 past it). */
const REQUEST_LIMIT_BYTES = 8192;

/** The actual service, posting to a stubbed CELLAR endpoint. */
function cellarService(): CellarSparqlService {
  return new CellarSparqlService(
    {} as AppConfig,
    {} as StorageService,
    {
      cellarSparqlEndpoint: 'http://cellar.test/sparql',
      sparqlQueryTimeoutMs: 5000,
      maxSparqlResults: 100,
    } as ServerConfig,
  );
}

/** A result row: each variable it binds and that variable's literal value. */
type CellarRow = Readonly<Record<string, string>>;

/** A query's rows, a bare string binding `?kwCelex`, or the response that fails it. */
type CellarAnswer = readonly (string | CellarRow)[] | Response;

/**
 * Stubs CELLAR's endpoint, recording each request body and the rows each query was
 * answered with; `answer` gives a query's rows, or the response that fails it.
 */
function stubCellar(answer: (query: string) => CellarAnswer | Promise<CellarAnswer>) {
  const bodies: string[] = [];
  const answered: CellarRow[][] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = String(init.body);
      bodies.push(body);
      const values = await answer(new URLSearchParams(body).get('query') ?? '');
      if (values instanceof Response) return values;
      const rows = values.map((value) => (typeof value === 'string' ? { kwCelex: value } : value));
      answered.push(rows);
      const bindings = rows.map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([name, value]) => [name, { type: 'literal', value }]),
        ),
      );
      return new Response(JSON.stringify({ head: { vars: [] }, results: { bindings } }));
    }),
  );
  return {
    bodies,
    answered,
    queries: () => bodies.map((body) => new URLSearchParams(body).get('query') ?? ''),
  };
}

/** The 125 forms of a whole CELEX the family lookup asks CELLAR about, in order. */
function familyOf(celex: string): string[] {
  const ordinals = Array.from({ length: 20 }, (_, i) => `(${String(i + 1).padStart(2, '0')})`);
  return [
    celex,
    ...ordinals.map((ordinal) => `${celex}${ordinal}`),
    ...ordinals.map((ordinal) => `${celex}R${ordinal}`),
    ...['', ...ordinals].flatMap((ordinal) =>
      ['_INF', '_RES', '_SUM', '_EXT'].map((suffix) => `${celex}${ordinal}${suffix}`),
    ),
  ];
}

/** The family lookup query for `members`, as the service receives it after its PREFIX block. */
function familyLookup(members: readonly string[]): string {
  return `SELECT DISTINCT ?kwCelex WHERE {
  VALUES ?kwCelex { ${members.map((m) => `"${m}"^^xsd:string`).join(' ')} }
  ?kwWork cdm:resource_legal_id_celex ?kwCelex .
}`;
}

/** The typed literals of every `VALUES ?kwCelex { … }` list in a query. */
function valuesLiterals(query: string): string[] {
  return [...query.matchAll(/VALUES \?kwCelex \{ ([^}]*) \}/g)].flatMap((m) =>
    [...(m[1] ?? '').matchAll(/"((?:[^"\\]|\\.)*)"\^\^xsd:string/g)].map((v) => v[1] ?? ''),
  );
}

/** `celex` padded with zeros to `length` characters, a CELEX-shaped value no work carries. */
const padded = (celex: string, length: number) => celex.padEnd(length, '0');

/**
 * The whole pattern of an uppercase partial keyword whose CELEX arm carries `terms`: the
 * English-title arm on `phrase`, then the prefix terms and the confirming substring test.
 */
function partialPattern(keyword: string, terms: readonly string[], phrase = keyword): string {
  return `{
    ?kwExpr cdm:expression_title ?kwTitle .
    ?kwTitle bif:contains "'${phrase}'" .
    ?kwExpr cdm:expression_uses_language <http://publications.europa.eu/resource/authority/language/ENG> .
    ?kwExpr cdm:expression_belongs_to_work ?work .
  } UNION {
    ?work cdm:resource_legal_id_celex ?kwCelex .
    ?kwCelex bif:contains "${terms.map((term) => `'${term}*'`).join(' OR ')}" .
    FILTER(CONTAINS(STR(?kwCelex), "${keyword}"))
  }`;
}

/**
 * A fragment lookup from its `SELECT` on: the distinct text before `run` in each CELEX
 * holding `keyword` that one of `terms` starts.
 */
function headLookup(run: string, keyword: string, terms: readonly string[]): string {
  return `SELECT DISTINCT (STRBEFORE(STR(?kwCelex), "${run}") AS ?kwHead) WHERE {
  ?kwWork cdm:resource_legal_id_celex ?kwCelex .
  ?kwCelex bif:contains "${terms.map((term) => `'${term}*'`).join(' OR ')}" .
    FILTER(CONTAINS(STR(?kwCelex), "${keyword}"))
}`;
}

/** The prefix terms a query's CELEX full-text expressions ask about, in order. */
function askedTerms(query: string): string[] {
  return celexFullTextExpressions(query).flatMap((expression) =>
    [...expression.matchAll(/'([0-9A-Z]+)\*'/g)].map((m) => m[1] ?? ''),
  );
}

describe('keyword lookups on the wire, through the actual service (#208)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * Characterization: the requests each of these keywords sent before the family
   * lookup was split. The byte counts are the bodies measured on the wire against
   * live CELLAR (2026-11-17).
   */
  it.each([
    ['32016R0679', 6091],
    ['62023CO0097R(01)', 7341],
    [padded('32016R0679', 26), 8091],
  ])('sends the whole-CELEX keyword %s one family lookup of %i bytes', async (keyword, bytes) => {
    const cellar = stubCellar(() => []);
    await keywordMatchPattern(cellarService(), keyword, createMockContext());

    expect(cellar.bodies.map((body) => body.length)).toEqual([bytes]);
    expect(cellar.queries()).toEqual([expect.stringContaining(familyLookup(familyOf(keyword)))]);
  });

  it('matches a carried whole CELEX on the exact literals CELLAR returned, plus its corrigenda', async () => {
    stubCellar(() => ['32016R0679', '32016R0679R(01)']);
    const pattern = await keywordMatchPattern(cellarService(), '32016R0679', createMockContext());

    expect(
      pattern,
    ).toContain(`{ VALUES ?kwCelex { "32016R0679"^^xsd:string "32016R0679R(01)"^^xsd:string }
      ?work cdm:resource_legal_id_celex ?kwCelex . }
    UNION
    { ?kwBase cdm:resource_legal_id_celex "32016R0679"^^xsd:string .
      ?work cdm:resource_legal_corrects_resource_legal ?kwBase . }`);
  });

  it.each([
    ['CJ0362', 5591, Array.from({ length: YEARS }, (_, i) => `6${1951 + i}CJ0362`)],
    ['2016R0679', 5966, SECTORS.map((s) => `${s}2016R0679`)],
    [padded('32016R0679', 26), 8091, [padded('32016R0679', 26)]],
  ])(
    'puts the full term list of %s, which no work carries whole, in the arm after its one family lookup',
    async (keyword, bytes, terms) => {
      const cellar = stubCellar(() => []);
      const pattern = await keywordMatchPattern(cellarService(), keyword, createMockContext());

      expect(cellar.bodies.map((body) => body.length)).toEqual([bytes]);
      expect(celexFullTextExpressions(pattern)).toEqual([
        terms.map((term) => `'${term}*'`).join(' OR '),
      ]);
      expect(confirmingLiterals(pattern)).toEqual([keyword]);
    },
  );

  it.each([
    // 27 characters counted with `(` and `)` at three bytes: 8,216 bytes unsplit.
    ['32016R0679R(02)(01)', 2],
    // The heaviest CELEX CELLAR holds: 9,466 bytes unsplit.
    ['52016TA1013(01)R(02)R(01)', 2],
    [padded('32016R0679', 100), 3],
    // 94 parentheses, each three bytes encoded: 40,841 bytes unsplit.
    [`32016${'()'.repeat(47)}R`, 6],
  ])(
    'splits the family lookup of %s across %i requests within the limit, each member asked once, in order',
    async (keyword, requests) => {
      const cellar = stubCellar(() => []);
      await keywordMatchPattern(cellarService(), keyword, createMockContext());

      expect(cellar.bodies).toHaveLength(requests);
      for (const body of cellar.bodies)
        expect(body.length).toBeLessThanOrEqual(REQUEST_LIMIT_BYTES);
      expect(cellar.queries().flatMap(valuesLiterals)).toEqual(familyOf(keyword));
    },
  );

  it('merges the CELEX every family request carries into the arm, a sibling only the second request asked about included', async () => {
    const keyword = '32016R0679R(02)(01)';
    const lastSibling = `${keyword}(20)_EXT`;
    const cellar = stubCellar((query) =>
      [keyword, lastSibling].filter((celex) => valuesLiterals(query).includes(celex)),
    );
    const pattern = await keywordMatchPattern(cellarService(), keyword, createMockContext());

    const [first = '', second = ''] = cellar.queries();
    expect(valuesLiterals(first)).toContain(keyword);
    expect(valuesLiterals(second)).toContain(lastSibling);
    expect(valuesLiterals(pattern)).toEqual([keyword, lastSibling]);
    expect(pattern).toContain(`?kwBase cdm:resource_legal_id_celex "${keyword}"^^xsd:string .`);
  });

  it('fails the call with a failed family request once every request has settled', async () => {
    let answerFirst: (values: CellarAnswer) => void = () => {};
    const first = new Promise<CellarAnswer>((resolve) => {
      answerFirst = resolve;
    });
    let calls = 0;
    stubCellar(() => {
      calls += 1;
      if (calls === 1) return first;
      return new Response('Virtuoso 37000 Error SP030: SPARQL compiler, line 3: syntax error', {
        status: 400,
      });
    });
    let settled = false;
    const call = keywordMatchPattern(cellarService(), '32016R0679R(02)(01)', createMockContext());
    call.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.waitFor(() => expect(calls).toBe(2));
    await Promise.resolve();
    expect(settled).toBe(false);

    answerFirst(['32016R0679R(02)(01)']);
    await expect(call).rejects.toMatchObject({ data: { reason: 'sparql_error' } });
  });

  it('fails the call with a failed head lookup, after sending every lookup of its round, rather than matching titles alone', async () => {
    const failure = 'Virtuoso 37000 Error SP030: SPARQL compiler, line 4: syntax error';
    let calls = 0;
    const cellar = stubCellar(() => {
      calls += 1;
      return calls === 2 ? new Response(failure, { status: 400 }) : [{ kwHead: '32016' }];
    });

    await expect(
      keywordMatchPattern(cellarService(), 'R0679', createMockContext()),
    ).rejects.toMatchObject({
      message: `CELLAR SPARQL error: ${failure}`,
      data: { reason: 'sparql_error', retryable: false },
    });
    // R0679 is no CELEX, so no family lookup: its four head lookups, all in one round.
    expect(cellar.bodies).toHaveLength(4);
    for (const query of cellar.queries()) {
      expect(query).toContain('SELECT DISTINCT (STRBEFORE(STR(?kwCelex), "R0679") AS ?kwHead)');
    }
    expect(cellar.queries().flatMap(askedTerms)).toEqual(indexTerms('R0679'));
  });

  it('ends the call on cancellation instead of building the arm without the lookup', async () => {
    const controller = new AbortController();
    const bodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            bodies.push(String(init.body));
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          }),
      ),
    );
    const call = keywordMatchPattern(
      cellarService(),
      '32016R0679R(02)(01)',
      createMockContext({ signal: controller.signal }),
    );
    await vi.waitFor(() => expect(bodies).toHaveLength(2));
    controller.abort();

    await expect(call).rejects.toMatchObject({ name: 'AbortError' });
    expect(bodies).toHaveLength(2);
  });

  it('looks up a CELEX-shaped keyword of 100 characters, and sends none for one of 101, which takes the partial arm', async () => {
    const cellar = stubCellar(() => []);
    await keywordMatchPattern(cellarService(), padded('32016R0679', 100), createMockContext());
    expect(cellar.bodies.length).toBeGreaterThan(0);

    const longer = padded('32016R0679', 101);
    const after = stubCellar(() => []);
    const pattern = await keywordMatchPattern(cellarService(), longer, createMockContext());

    expect(after.bodies).toEqual([]);
    expect(celexFullTextExpressions(pattern)).toEqual([`'${longer}*'`]);
    expect(confirmingLiterals(pattern)).toEqual([longer]);
  });

  it('sends a type-letter fragment of 100 characters its head lookups, and one of 101 none, which matches titles alone', async () => {
    /** The type codes ending in R, by sector in route order: 14 codes, each behind 77 years. */
    const codesEndingInR: [sector: string, codes: string[]][] = [
      ['0', ['R']],
      ['1', ['AR', 'LR', 'MR', 'R', 'SPR', 'TR']],
      ['3', ['R']],
      ['5', ['AR', 'IR', 'XR']],
      ['7', ['R']],
      ['8', ['FR', 'HR']],
    ];
    const termsOf = (keyword: string) =>
      codesEndingInR.flatMap(([sector, codes]) =>
        codes.flatMap((code) =>
          Array.from({ length: YEARS }, (_, i) => `${sector}${1951 + i}${code}${keyword.slice(1)}`),
        ),
      );
    // CELLAR answers every lookup with one head, so a lookup that is sent shapes the arm.
    const answer = () => [{ kwHead: '32016' }];

    const keyword = 'R0679'.padEnd(100, '0');
    const cellar = stubCellar(answer);
    const pattern = await keywordMatchPattern(cellarService(), keyword, createMockContext());

    for (const body of cellar.bodies) expect(body.length).toBeLessThanOrEqual(REQUEST_LIMIT_BYTES);
    // CELEX-shaped, so its family is looked up first, in three requests, and carried by no work.
    const family = cellar.queries().filter((query) => query.includes('VALUES ?kwCelex'));
    expect(family.flatMap(valuesLiterals)).toEqual(familyOf(keyword));
    expect(family).toHaveLength(3);
    const lookups = cellar.queries().filter((query) => !query.includes('VALUES ?kwCelex'));
    expect(lookups).toHaveLength(18);
    expect(lookups.flatMap(askedTerms)).toEqual(termsOf(keyword));
    expect(termsOf(keyword)).toHaveLength(1078);
    for (const query of lookups) {
      expect(query.slice(query.indexOf('SELECT'))).toBe(
        headLookup(keyword, keyword, askedTerms(query)),
      );
    }
    expect(pattern).toBe(partialPattern(keyword, [`32016${keyword}`]));

    const longer = 'R0679'.padEnd(101, '0');
    const after = stubCellar(answer);
    const titlesOnly = await keywordMatchPattern(cellarService(), longer, createMockContext());

    expect(after.bodies).toEqual([]);
    expect(titlesOnly).not.toContain('?kwCelex');
    expect(titlesOnly).not.toContain('UNION');
    expect(titlesOnly).toContain(`?kwTitle bif:contains "'${longer}'"`);
  });

  /**
   * CELLAR's CELEX full-text index over `corpus`, as the page and the lookups query it:
   * a term `'X*'` hits a CELEX with a word starting with X, words split at every
   * character outside `[0-9A-Z]`, and a hit must hold the confirming literal. A query
   * projecting `(STRBEFORE(STR(?kwCelex), "R") AS ?kwHead)` under `SELECT DISTINCT` is
   * answered as SPARQL does: one row per distinct text before the first `R` in a hit.
   */
  function indexOver(corpus: readonly string[]) {
    return (query: string): CellarAnswer => {
      const [expression = ''] = celexFullTextExpressions(query);
      const terms = [...expression.matchAll(/'([0-9A-Z]+)\*'/g)].map((m) => m[1] ?? '');
      const [literal = ''] = confirmingLiterals(query);
      const hits = corpus.filter(
        (celex) =>
          celex.includes(literal) &&
          celex.split(/[^0-9A-Z]+/).some((word) => terms.some((term) => word.startsWith(term))),
      );
      const before =
        /^SELECT DISTINCT \(STRBEFORE\(STR\(\?kwCelex\), "([^"]*)"\) AS \?kwHead\)/m.exec(
          query,
        )?.[1];
      if (before === undefined) return hits;
      const heads = hits.map((celex) =>
        celex.includes(before) ? celex.slice(0, celex.indexOf(before)) : '',
      );
      return [...new Set(heads)].map((kwHead) => ({ kwHead }));
    };
  }

  it.each([
    [
      'R0679',
      ['02002R0679-20020423', '02016R0679-20160504', '31972R0679', '31979R0679R(01)', '32016R0679'],
      ['02002R0679', '02016R0679', '31972R0679', '31979R0679', '32016R0679'],
    ],
    [
      'J0131',
      ['61981CJ0131(01)', '61995CJ0131', '62013CJ0131', '62007FJ0131', '62016TJ0131_RES'],
      ['61981CJ0131', '61995CJ0131', '62013CJ0131', '62007FJ0131', '62016TJ0131'],
    ],
    [
      'C0001',
      ['32010C0001(02)', '52020PC0001', '61977CC0001', 'E2003C0001', '52020DC0001R(01)'],
      ['32010C0001', '52020DC0001', '52020PC0001', '61977CC0001', 'E2003C0001'],
    ],
    // A C-sector CELEX opens with the run itself, so its completion is the run.
    [
      'C2006',
      ['C2006/123/01', '52006PC2006', '62006CC2006'],
      ['C2006', '52006PC2006', '62006CC2006'],
    ],
  ])(
    'resolves the type-letter fragment %s in lookups within the limit, and keeps only the terms a CELEX holding it starts',
    async (keyword, corpus, live) => {
      const unrelated = ['32016R0680', '62013CJ0132', '52020PC0002'];
      const cellar = stubCellar(indexOver([...corpus, ...unrelated]));
      const pattern = await keywordMatchPattern(cellarService(), keyword, createMockContext());

      expect(cellar.bodies.length).toBeGreaterThan(1);
      for (const body of cellar.bodies)
        expect(body.length).toBeLessThanOrEqual(REQUEST_LIMIT_BYTES);
      // Every term of the route is asked about once, in order, across the lookups.
      const asked = cellar
        .queries()
        .flatMap((q) => celexFullTextExpressions(q))
        .flatMap((e) => [...e.matchAll(/'([0-9A-Z]+)\*'/g)].map((m) => m[1] ?? ''));
      expect(asked).toEqual(indexTerms(keyword));
      for (const query of cellar.queries()) expect(confirmingLiterals(query)).toEqual([keyword]);

      expect(celexFullTextExpressions(pattern)).toEqual([live.map((t) => `'${t}*'`).join(' OR ')]);
      expect(confirmingLiterals(pattern)).toEqual([keyword]);
      // The arm reaches the CELEX the full term list reached.
      expect(indexOver([...corpus, ...unrelated])(pattern)).toEqual(corpus);
    },
  );

  it('matches titles only for a type-letter fragment no CELEX holds', async () => {
    const cellar = stubCellar(() => []);
    const pattern = await keywordMatchPattern(cellarService(), 'R0679', createMockContext());

    expect(cellar.bodies.length).toBeGreaterThan(1);
    expect(pattern).not.toContain('?kwCelex');
    expect(pattern).not.toContain('UNION');
    expect(pattern).toContain(`?kwTitle bif:contains "'R0679'"`);
  });

  it.each([
    [
      'R0679',
      ['02016R0679-20160504', '31972R0679', '32016R0679', '32016R0679R(01)'],
      ['02016R0679', '31972R0679', '32016R0679'],
    ],
    [
      'J0131',
      ['61981CJ0131(01)', '62013CJ0131', '62013CJ0131_SUM', '62010TJ0131'],
      ['61981CJ0131', '62013CJ0131', '62010TJ0131'],
    ],
    [
      'C0001',
      ['32010C0001(02)', '52020PC0001', '52020PC0001R(01)', 'E2003C0001'],
      ['32010C0001', '52020PC0001', 'E2003C0001'],
    ],
  ])(
    'builds the whole pattern of %s from the CELEX CELLAR holds it in',
    async (keyword, corpus, live) => {
      stubCellar(indexOver([...corpus, '32016R0680', '62013CJ0132', '52020PC0002']));
      const pattern = await keywordMatchPattern(cellarService(), keyword, createMockContext());

      expect(pattern).toBe(partialPattern(keyword, live));
    },
  );

  it.each([
    ['CJ0362', [] as string[]],
    ['2016R0679', [] as string[]],
    ['32016R0679', ['32016R0679', '32016R0679R(01)']],
  ])('sends %s its family lookup and no fragment lookup', async (keyword, carried) => {
    const cellar = stubCellar((query) =>
      carried.filter((celex) => valuesLiterals(query).includes(celex)),
    );
    await keywordMatchPattern(cellarService(), keyword, createMockContext());

    expect(cellar.queries()).toEqual([expect.stringContaining(familyLookup(familyOf(keyword)))]);
  });

  it.each([
    ['R0679', 'R0679'],
    // The confirming test holds the whole keyword; the head is read before its run.
    ['R0679-2016', 'R0679'],
    ['C2006', 'C2006'],
  ])(
    'asks each lookup of %s for the distinct text before %s in the CELEX it reaches, never for the CELEX',
    async (keyword, run) => {
      const cellar = stubCellar(() => []);
      await keywordMatchPattern(cellarService(), keyword, createMockContext());

      // A CELEX-shaped keyword (R0679-2016) is first looked up as a whole CELEX.
      const queries = cellar.queries().filter((query) => !query.includes('VALUES ?kwCelex'));
      expect(queries.length).toBeGreaterThan(1);
      expect(queries.flatMap(askedTerms)).toEqual(indexTerms(keyword));
      for (const query of queries) {
        expect(query.slice(query.indexOf('SELECT'))).toBe(
          headLookup(run, keyword, askedTerms(query)),
        );
      }
      for (const body of cellar.bodies)
        expect(body.length).toBeLessThanOrEqual(REQUEST_LIMIT_BYTES);
    },
  );

  it('keeps exactly the terms the returned heads complete, in route order, and ignores a head completing none', async () => {
    // '' + R0679, 99999R0679, 62013CJR0679, and 32016R0679R0679 are no completion of R0679.
    const heads = ['32016', '99999', '02016', '', '62013CJ', '32016R0679', '31972'];
    stubCellar(() => heads.map((kwHead) => ({ kwHead })));
    const pattern = await keywordMatchPattern(cellarService(), 'R0679', createMockContext());

    expect(pattern).toBe(partialPattern('R0679', ['02016R0679', '31972R0679', '32016R0679']));
  });

  it('matches titles only when every returned head completes no term', async () => {
    stubCellar(() => [{ kwHead: '' }, { kwHead: '99999' }]);
    const pattern = await keywordMatchPattern(cellarService(), 'R0679', createMockContext());

    expect(pattern).not.toContain('?kwCelex');
    expect(pattern).toContain(`?kwTitle bif:contains "'R0679'"`);
  });

  it('maps an empty head, a C or E and year run opening the CELEX, to the run itself', async () => {
    stubCellar(() => [{ kwHead: '52006P' }, { kwHead: '' }]);
    const pattern = await keywordMatchPattern(cellarService(), 'C2006', createMockContext());

    expect(pattern).toBe(partialPattern('C2006', ['C2006', '52006PC2006']));
  });

  it('is answered with a row per head, not per CELEX, and keeps the terms those CELEX start', async () => {
    const holding = [
      '32016R0679',
      '32016R0679R(01)',
      '32016R0679R(02)',
      '02016R0679-20160504',
      '02016R0679-20180525',
    ];
    const cellar = stubCellar(indexOver([...holding, '32016R0680']));
    const pattern = await keywordMatchPattern(cellarService(), 'R0679', createMockContext());

    expect(cellar.answered.flat()).toHaveLength(2);
    expect(cellar.answered.flat().map((row) => row.kwHead)).toEqual(
      expect.arrayContaining(['02016', '32016']),
    );
    expect(pattern).toBe(partialPattern('R0679', ['02016R0679', '32016R0679']));
  });

  it('keeps the terms that start the CELEX holding a keyword that runs past its run', async () => {
    const holding = ['02002R0679-20160101', '02016R0679-20160504'];
    stubCellar(indexOver([...holding, '32016R0679', '02016R0679-20180525']));
    const pattern = await keywordMatchPattern(cellarService(), 'R0679-2016', createMockContext());

    expect(pattern).toBe(partialPattern('R0679-2016', ['02002R0679', '02016R0679'], 'R0679 2016'));
  });
});
