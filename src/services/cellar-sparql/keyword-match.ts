/**
 * @fileoverview The keyword graph pattern shared by eurlex_search_documents and
 * eurlex_get_cases: an English-title arm on the Virtuoso full-text index, plus a
 * CELEX arm chosen from the keyword's shape.
 * @module services/cellar-sparql/keyword-match
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { ENG_LANGUAGE_URI } from './cdm-labels.js';
import { CellarSparqlService } from './cellar-sparql-service.js';
import { CELEX_PATTERN, celexLiteral, escapeSparqlLiteral } from './eli-resolution.js';

/** Every character a CELEX holds — the charset of {@link CELEX_PATTERN}. */
const CELEX_CHARSET = /^[0-9A-Z()/_-]+$/;

/**
 * Highest sibling ordinal a whole-CELEX keyword reaches, for both the numbered
 * `(nn)` form and the corrigendum `R(nn)` form. A live survey of every sector-3 and
 * sector-6 CELEX (2026-09-25) found sector-6 `(nn)` up to `(20)` and `R(nn)` at
 * `R(01)` only; sector 3 runs `R(nn)` to `R(30)` and `(nn)` to `(61)`, with under
 * 1% of its corrigenda and 8% of its numbered siblings past 20.
 */
const MAX_SIBLING_ORDINAL = 20;

/**
 * Case-law suffixes CELLAR files beside a record and beside each numbered sibling:
 * judicial information notice, abstract, summary, and extract. The first three are
 * derivative types eurlex_get_cases admits only under include_derivative; an `_EXT`
 * extract is a primary record.
 */
const RECORD_SUFFIXES = ['_INF', '_RES', '_SUM', '_EXT'] as const;

/**
 * The type codes of each CELEX sector: the letters between the year and the number,
 * from every CELEX in CELLAR shaped `{sector}{year}{letters}…` (live, 2026-09-25).
 * A fragment that opens with letters is completed with the codes ending in them
 * ({@link celexFragmentRoute}), so a code CELLAR adds later is reached only once it
 * is listed here.
 */
export const CELEX_TYPE_CODES = {
  '0': 'A B C D E F G H J L M ME N O P Q R S T W X XC XG Y'.split(' '),
  '1': [
    ...'A AN AR B BN C D DNA DNB E EN F G H HN I IN J JN K KN L LN LR M MA MB MC MD'.split(' '),
    ...'ME MF MG MH MI MJ MK ML MM MN MO MP MQ MR MS N NN P R S SA SAFI SAN SP SPN'.split(' '),
    ...'SPR T TN TR U V VN W X XA XB XC'.split(' '),
  ],
  '2': 'A D P X XC'.split(' '),
  '3': 'A B C D E F G H J K L M O Q R S X Y'.split(' '),
  '4': 'A D X Y Z'.split(' '),
  '5': [
    ...'AA AB AC AE AG AK AP AR AS AT BC BP DC DMA DP DSA EC FC GC HB IE IG IP IR'.split(' '),
    ...'JC KG M PC SA SC TA XA XB XC XE XG XK XP XR XX'.split(' '),
  ],
  '6': 'CA CB CC CD CG CJ CN CO CP CS CT CU CV CX FA FB FJ FN FO TA TB TC TJ TN TO TT'.split(' '),
  '7': 'D F L R'.split(' '),
  '8': [
    ...'AT BE BG CH CY CZ DE DK EE EL ES ET FI FR HR HU IE IS IT LT LU LV MT NL NO'.split(' '),
    ...'PL PT RO SE SI SK SL UK XI XX'.split(' '),
  ],
  '9': 'E H O'.split(' '),
  C: [],
  E: 'A C G J P X'.split(' '),
} as const satisfies Record<string, readonly string[]>;

/** The sector character every CELEX opens with. */
const CELEX_SECTORS = Object.keys(CELEX_TYPE_CODES) as (keyof typeof CELEX_TYPE_CODES)[];

/**
 * Earliest year a CELEX carries after its sector character. A live check of the
 * index hits (2026-09-25) found no sector-and-year prefix in 1900–1950, nor any
 * past the current year.
 */
const FIRST_CELEX_YEAR = 1951;

/**
 * The keyword reduced to letters, digits, and single spaces: the phrase the title
 * arm quotes for `bif:contains`, which it cannot break out of. Empty when the
 * keyword holds no letter or digit — then no title matches it, and no CELEX either,
 * since every CELEX holds a four-digit year — so callers reject such a keyword
 * before building a query.
 */
export function keywordTitlePhrase(keyword: string): string {
  return keyword
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The graph pattern binding `?work` to the works a keyword matches. The keyword
 * must hold a letter or digit ({@link keywordTitlePhrase} non-empty).
 *
 * The title arm drives the match off the `bif:contains` full-text index (issue #17).
 * The CELEX arm depends on the uppercased keyword, since CELLAR stores CELEX in
 * upper case (#105):
 *
 * - **None** when the keyword has no digit or a character outside `[0-9A-Z()/_-]`.
 *   Every CELEX opens with a sector character and a four-digit year, so a digit-free
 *   keyword could only hit type letters or suffixes (`R`, `PC`) across the whole
 *   corpus, and a keyword with any other character is in no CELEX at all.
 * - **Exact** when some work carries the keyword as its whole CELEX: the typed
 *   literals of that CELEX and of each sibling in {@link celexFamily} some work
 *   carries, each an index lookup, plus the corrigenda that
 *   `cdm:resource_legal_corrects_resource_legal` links to the CELEX. Whether the
 *   keyword is whole is CELLAR's answer, not the pattern's: `02016R0679` and
 *   `72014L0056` are CELEX-shaped prefixes of real values that no work carries.
 * - **Partial** otherwise, routed by {@link celexFragmentRoute} (#123): prefix terms
 *   on the full-text index CELLAR keeps on CELEX literals, then a confirming
 *   substring test on the narrowed literals, so a partial CELEX (`2016R0679`,
 *   `R0679`) still reaches its consolidated versions from index hits. A fragment
 *   opening with letters no type code ends in, or with letters not followed by a
 *   digit (`R(01)`), keeps the substring test of every CELEX literal; one opening
 *   mid-year or mid-number (`016R0679`, `0679`) gets no CELEX arm and matches titles
 *   only.
 *
 * The family lookup is the one CELLAR call made here; it propagates any failure,
 * cancellation included, rather than falling back to the partial arm.
 */
export async function keywordMatchPattern(
  svc: Pick<CellarSparqlService, 'query'>,
  keyword: string,
  ctx: Context,
): Promise<string> {
  const titleArm = `{
    ?kwExpr cdm:expression_title ?kwTitle .
    ?kwTitle bif:contains "'${keywordTitlePhrase(keyword)}'" .
    ?kwExpr cdm:expression_uses_language <${ENG_LANGUAGE_URI}> .
    ?kwExpr cdm:expression_belongs_to_work ?work .
  }`;
  const celexArm = await celexKeywordArm(svc, keyword, ctx);
  return celexArm ? `${titleArm} UNION {\n    ${celexArm}\n  }` : titleArm;
}

/**
 * A CELEX followed by the siblings CELLAR files under longer CELEX that begin with
 * it: numbered `(01)`–`(20)`, corrigenda `R(01)`–`R(20)`, and the `_INF`, `_RES`,
 * `_SUM`, and `_EXT` records of the CELEX and of each numbered sibling. Before #105
 * a whole-CELEX keyword reached these through the substring scan; the bounded list
 * reaches them by index lookups instead — `62023CO0097` its `(01)` and `(02)`
 * orders, `32016R0679` its `R(01)`–`R(03)`. Longer forms (`(21)`, `R(21)`, a
 * corrigendum of a numbered sibling) are left out.
 */
function celexFamily(celex: string): string[] {
  const ordinals = Array.from(
    { length: MAX_SIBLING_ORDINAL },
    (_, i) => `(${String(i + 1).padStart(2, '0')})`,
  );
  return [
    celex,
    ...ordinals.map((ordinal) => `${celex}${ordinal}`),
    ...ordinals.map((ordinal) => `${celex}R${ordinal}`),
    ...['', ...ordinals].flatMap((ordinal) =>
      RECORD_SUFFIXES.map((suffix) => `${celex}${ordinal}${suffix}`),
    ),
  ];
}

async function celexKeywordArm(
  svc: Pick<CellarSparqlService, 'query'>,
  keyword: string,
  ctx: Context,
): Promise<string> {
  const upper = keyword.toUpperCase();
  if (!/\d/.test(upper) || !CELEX_CHARSET.test(upper)) return '';

  if (CELEX_PATTERN.test(upper)) {
    const carried = await svc.query(
      `SELECT DISTINCT ?kwCelex WHERE {
  VALUES ?kwCelex { ${celexFamily(upper).map(celexLiteral).join(' ')} }
  ?kwWork cdm:resource_legal_id_celex ?kwCelex .
}`,
      ctx,
    );
    const carriedCelex = carried.flatMap(
      (b) => CellarSparqlService.bindingValue(b, 'kwCelex') ?? [],
    );
    if (carriedCelex.includes(upper)) {
      return `{ VALUES ?kwCelex { ${carriedCelex.map(celexLiteral).join(' ')} }
      ?work cdm:resource_legal_id_celex ?kwCelex . }
    UNION
    { ?kwBase cdm:resource_legal_id_celex ${celexLiteral(upper)} .
      ?work cdm:resource_legal_corrects_resource_legal ?kwBase . }`;
    }
  }

  const route = celexFragmentRoute(upper);
  switch (route.kind) {
    case 'titles':
      return '';
    case 'scan':
      return `?work cdm:resource_legal_id_celex ?kwCelex .
    FILTER(CONTAINS(STR(?kwCelex), "${escapeSparqlLiteral(upper)}"))`;
    case 'index':
      return `?work cdm:resource_legal_id_celex ?kwCelex .
    ${celexPrefixMatch('?kwCelex', upper, route.terms)}`;
  }
}

/**
 * Narrows `variable`, a bound CELEX literal, to the literals holding `upperValue`:
 * the `terms` from {@link celexFragmentRoute} on the CELEX full-text index, then the
 * confirming substring test those index hits need (#123). `upperValue` is matched
 * case-sensitively, since CELLAR stores CELEX in upper case.
 */
export function celexPrefixMatch(
  variable: `?${string}`,
  upperValue: string,
  terms: readonly string[],
): string {
  return `${variable} bif:contains "${terms.map((term) => `'${term}*'`).join(' OR ')}" .
    FILTER(CONTAINS(STR(${variable}), "${escapeSparqlLiteral(upperValue)}"))`;
}

/**
 * How a partial CELEX keyword reaches the CELEX it is part of:
 *
 * - `index`: full-text prefix terms that complete it to the start of every CELEX
 *   holding it, for {@link celexPrefixMatch};
 * - `scan`: no completion is known, so a substring test of every CELEX literal;
 * - `titles`: it opens mid-year or mid-number, where no index route reaches, and
 *   matches titles only.
 */
export type CelexFragmentRoute =
  | { kind: 'index'; terms: string[] }
  | { kind: 'scan' }
  | { kind: 'titles' };

/**
 * Routes a partial CELEX keyword by its leading run of `[0-9A-Z]` (#123). The index
 * does not split a word between digits and letters, so `'2016R0679*'` matches
 * nothing: a term must open where a CELEX opens, `{sector}{year}{type code}`. Every
 * term is that run behind a sector character, a year, and a type code from
 * {@link CELEX_TYPE_CODES}, so no character a caller typed outside the run reaches
 * the full-text expression, and the run cannot break out of its quotes. A year is
 * {@link FIRST_CELEX_YEAR} through next year.
 *
 * - Five digits (`02016R0679`): the run itself, a sector digit and a year. The index
 *   also splits words at `-`, so `20160504` reaches the consolidations of that date.
 * - `C` or `E` and a year (`C2006`, `E2003C0097`): the run itself, and the run read
 *   as type letters followed by the number, since `51973PC2017` holds `C2017`.
 * - A year and a letter (`2016R0679`): the run behind each sector.
 * - Letters and a digit (`R0679`, `CJ0362`, `J0131`, `C0097`): the run behind every
 *   sector, year, and type code ending in those letters, so `J0131` reaches
 *   `62013CJ0131`; `scan` when no type code ends in them.
 * - Letters and anything else (`R(01)`, `ROU_202405`, `C/2024/0146`): `scan`.
 * - Anything else (`016R0679`, `0679`, `0679R`, `9999R0679`): `titles`. Four digits
 *   that are no year sit mid-number (`31979R0679R(01)`).
 *
 * Four digits that are a year are read as one, so a number followed by letters
 * (`32005R1998R(01)` for `1998R`) is not reached, nor a letter run after the number
 * (`31962D0241P1331` for `P1331`). The index also splits words at `_`, `/`, and `-`,
 * so a term can hit a suffix or a date; the caller's confirming substring test drops
 * those.
 */
export function celexFragmentRoute(upperKeyword: string): CelexFragmentRoute {
  const run = /^[0-9A-Z]*/.exec(upperKeyword)?.[0] ?? '';
  const lastYear = new Date().getUTCFullYear() + 1;
  const isYear = (digits: string) =>
    Number(digits) >= FIRST_CELEX_YEAR && Number(digits) <= lastYear;

  if (/^\d{5}/.test(run)) return { kind: 'index', terms: [run] };
  const sectorYear = /^[CE](\d{4})/.exec(run);
  if (sectorYear && isYear(sectorYear[1] ?? '')) {
    return { kind: 'index', terms: [run, ...typeCodeTerms(run, lastYear)] };
  }
  const yearLetter = /^(\d{4})[A-Z]/.exec(run);
  if (yearLetter) {
    return isYear(yearLetter[1] ?? '')
      ? { kind: 'index', terms: CELEX_SECTORS.map((sector) => `${sector}${run}`) }
      : { kind: 'titles' };
  }
  if (/^[A-Z]+\d/.test(run)) {
    const terms = typeCodeTerms(run, lastYear);
    return terms.length > 0 ? { kind: 'index', terms } : { kind: 'scan' };
  }
  return /^[A-Z]/.test(run) ? { kind: 'scan' } : { kind: 'titles' };
}

/**
 * `run`, whose leading letters end a type code, behind every sector, year, and type
 * code ending in those letters.
 */
function typeCodeTerms(run: string, lastYear: number): string[] {
  const letters = /^[A-Z]+/.exec(run)?.[0] ?? '';
  const tail = run.slice(letters.length);
  const years = Array.from(
    { length: lastYear - FIRST_CELEX_YEAR + 1 },
    (_, i) => FIRST_CELEX_YEAR + i,
  );
  return CELEX_SECTORS.flatMap((sector) =>
    CELEX_TYPE_CODES[sector]
      .filter((code) => code.endsWith(letters))
      .flatMap((code) => years.map((year) => `${sector}${year}${code}${tail}`)),
  );
}
