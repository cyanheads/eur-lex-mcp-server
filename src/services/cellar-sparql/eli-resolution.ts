/**
 * @fileoverview ELI URI → CELLAR work resolution, shared between eurlex_lookup_celex
 * and eurlex_get_document. CELLAR stores the canonical OJ-manifestation ELI literal
 * (`cdm:resource_legal_eli`, an `xsd:anyURI` literal), so a bare work-level ELI is
 * normalized to its `/oj` form on a miss. Extracted from eurlex_lookup_celex (#5) so
 * both tools resolve ELIs identically rather than duplicating the mechanism.
 *
 * Also home to the SPARQL-safety primitives every CELLAR query builder shares —
 * `escapeSparqlLiteral` for values interpolated into a `"…"` literal, `celexLiteral`
 * for a caller's CELEX matched as a typed exact triple, and `isSafeSparqlIri` for
 * URIs interpolated into a `<…>` IRI (with `keywordTitlePhrase` in keyword-match.ts
 * for a `bif:contains` phrase). `tests/sparql-lexical-safety.test.ts` gates their
 * use: it sends hostile values to every tool and resource string input and fails
 * when a caller value lands in a generated query outside a well-formed literal, IRI,
 * or phrase. The file also holds the shared input-validity primitives that reject a
 * value before a CELLAR round-trip is spent on it: `CELEX_PATTERN` and
 * `isValidCalendarDate`.
 *
 * The identifier normalizers live here too: `normalizeCelex`,
 * `normalizeEli`, and `normalizeWorkUri` map the forms a citation pasted from a
 * EUR-Lex page or a browser URL takes to the canonical one, and return every other
 * value trimmed, so each field's existing check still decides it. The schemas apply
 * them with `.overwrite()`, never `z.preprocess`: an overwrite keeps the field a
 * plain string, so its advertised JSON Schema is unchanged and the lexical-safety
 * test still reaches it. The case-number grammar eurlex_get_cases matches and
 * eurlex_lookup_celex routes on sits beside them.
 * @module services/cellar-sparql/eli-resolution
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { CellarSparqlService } from './cellar-sparql-service.js';
import type { SparqlBinding } from './types.js';

/** ELI namespace prefix — all European Legislation Identifiers share this root. */
export const ELI_NAMESPACE = 'http://data.europa.eu/eli/';

/** Detect ELI URI format: starts with http://data.europa.eu/eli/ */
export function isEliUri(identifier: string): boolean {
  return identifier.trim().startsWith(ELI_NAMESPACE);
}

/**
 * A bare work-level ELI — `…/eli/{type}/{year}/{number}` with no manifestation
 * suffix (no `/oj`, no `/YYYY-MM-DD` consolidation date). CELLAR stores the
 * canonical OJ-manifestation literal (`…/{number}/oj`) rather than the bare
 * work-level form, so these never match on exact lookup and must be normalized
 * to their `/oj` form to resolve.
 */
export function isBareWorkLevelEli(eli: string): boolean {
  if (!eli.startsWith(ELI_NAMESPACE)) return false;
  const path = eli.slice(ELI_NAMESPACE.length).replace(/\/+$/, '');
  return /^[^/]+\/\d{4}\/[^/]+$/.test(path);
}

/**
 * Escape a value for interpolation into a SPARQL short string literal (`"…"`).
 *
 * The passes are order-dependent: the backslash pass must run first, because every
 * later pass introduces a backslash of its own. Escaping a newline before the
 * backslash pass would double it, turning the escape back into a literal backslash
 * followed by `n`.
 *
 * A short literal cannot span lines, so an unescaped newline makes the whole query
 * unparseable and Virtuoso's raw compiler error surfaces in place of the tool's own
 * not-found (#53). Virtuoso happens to accept a raw CR or tab in this position, but
 * both are escaped anyway — the SPARQL grammar excludes them, and correctness here
 * should not rest on one endpoint's leniency.
 */
export function escapeSparqlLiteral(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/**
 * A CELEX as the typed SPARQL literal `cdm:resource_legal_id_celex` stores, ready to
 * sit in the object position of `?work cdm:resource_legal_id_celex <literal> .`.
 *
 * CELLAR types every CELEX literal as `xsd:string` (confirmed across sectors 0–7, C,
 * and E), so the typed exact triple resolves from the index in a fraction of a
 * second, while `FILTER(STR(?c) = "…")` scans every CELEX literal and takes seconds.
 * The datatype is load-bearing: an untyped literal matches no work at all.
 */
export function celexLiteral(celex: string): string {
  return `"${escapeSparqlLiteral(celex)}"^^xsd:string`;
}

/**
 * Structural floor for a CELEX identifier, applied before a CELLAR round-trip is
 * spent on a value that can never resolve.
 *
 * Deliberately permissive rather than a strict grammar. CELEX spans twelve
 * sectors — digits `0`–`9` plus the letter sectors `C` (OJ C series) and `E`
 * (EFTA) — and real values carry slash-delimited treaty references
 * (`11957A/PRO/CJ/09`), corrigendum markers (`32016R0679R(02)`), consolidation
 * date suffixes (`02016R0679-20160504`), and national-measure suffixes
 * (`72014L0056FIN_240353`). The pattern therefore requires only: a leading digit
 * or uppercase letter, a charset limited to digits, `A`–`Z`, and the punctuation
 * real CELEX values use, and at least six characters (the shortest observed value
 * is `11997M`). Verified against 6,000 CELEX values pulled live from CELLAR, 500
 * per sector across all twelve: zero rejections. A narrower digit-first grammar
 * rejects every sector C and E value.
 *
 * Written as a plain floor with no lookaheads. The pattern is advertised verbatim
 * as the JSON Schema `pattern` of every CELEX-typed input, and RE2-family engines
 * — which some MCP clients validate arguments with — reject lookarounds outright,
 * so a lookahead here makes the advertised schema unusable for those callers. The
 * digit-and-letter requirement the lookaheads carried was never load-bearing:
 * existence is CELLAR's answer, not this pattern's, and a garbage string sharing
 * this charset and shape passed either way.
 */
export const CELEX_PATTERN = /^[0-9A-Z][0-9A-Z()/_-]{5,}$/;

/** Percent-decode a value, or return it as given when its escapes are malformed. */
function decodeOrKeep(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** A `CELEX:` prefix as EUR-Lex writes it, in any case, raw or percent-encoded. */
const CELEX_PREFIX = /^celex(?::|%3a)\s*/i;

/** A CELLAR resource URI in any scheme or host case. */
const CELLAR_RESOURCE_PREFIX = /^https?:\/\/publications\.europa\.eu\/resource\//i;

/** Canonical form of {@link CELLAR_RESOURCE_PREFIX}, the form CELLAR stores. */
const CELLAR_RESOURCE_NAMESPACE = 'http://publications.europa.eu/resource/';

/** Namespace of the CELEX alias URIs CELLAR records as `owl:sameAs` a work. */
export const CELEX_ALIAS_NAMESPACE = `${CELLAR_RESOURCE_NAMESPACE}celex/`;

/**
 * A CELLAR work URI in the `http` form CELLAR stores: an `https` scheme or an
 * upper-case scheme or host is rewritten. Every other value is returned trimmed.
 */
export function normalizeWorkUri(value: string): string {
  const trimmed = value.trim();
  const prefix = CELLAR_RESOURCE_PREFIX.exec(trimmed);
  return prefix ? CELLAR_RESOURCE_NAMESPACE + trimmed.slice(prefix[0].length) : trimmed;
}

/**
 * The CELEX a `…/resource/celex/{CELEX}` alias URI names, uppercased, or undefined
 * for any other URI. CELLAR records the alias as `owl:sameAs` the work rather than
 * as a work of its own, so a caller passing one as a work URI means that CELEX.
 */
export function celexOfAliasUri(uri: string): string | undefined {
  const normalized = normalizeWorkUri(uri);
  if (!normalized.startsWith(CELEX_ALIAS_NAMESPACE)) return undefined;
  const celex = decodeOrKeep(normalized.slice(CELEX_ALIAS_NAMESPACE.length)).toUpperCase();
  return CELEX_PATTERN.test(celex) ? celex : undefined;
}

/**
 * The CELEX a wrapped citation carries, uppercased: a `CELEX:` prefix (`celex:`,
 * `CELEX%3A`), a `…/resource/celex/{CELEX}` alias URI, or a EUR-Lex page URL whose
 * `uri` parameter is `CELEX:{celex}` — any `legal-content` view, extra parameters, a
 * fragment, a percent-encoded value, and the legacy `LexUriServ.do?uri=CELEX:{celex}:{LANG}:{FORMAT}`.
 * Undefined for any other value, a EUR-Lex URL whose `uri` names no CELEX
 * (`OJ:L:2016:119:TOC`) included: nothing is guessed from it.
 */
export function extractCelex(value: string): string | undefined {
  const trimmed = value.trim();
  const prefix = CELEX_PREFIX.exec(trimmed);
  if (prefix) return decodeOrKeep(trimmed.slice(prefix[0].length)).toUpperCase();
  const alias = celexOfAliasUri(trimmed);
  if (alias) return alias;
  if (!URL.canParse(trimmed)) return undefined;
  const url = new URL(trimmed);
  if (!/^https?:$/.test(url.protocol) || url.hostname !== 'eur-lex.europa.eu') return undefined;
  const uri = url.searchParams.get('uri') ?? '';
  const uriPrefix = CELEX_PREFIX.exec(uri);
  return uriPrefix ? uri.slice(uriPrefix[0].length).split(':')[0]?.toUpperCase() : undefined;
}

/**
 * A CELEX field's value: the CELEX a wrapped citation carries
 * ({@link extractCelex}), else the value trimmed and uppercased.
 */
export function normalizeCelex(value: string): string {
  return extractCelex(value) ?? value.trim().toUpperCase();
}

/** An ELI root in any scheme or host case, on either host that serves ELIs, or with no scheme. */
const ELI_ROOT = /^(?:https?:\/\/)?(?:data|eur-lex)\.europa\.eu\/eli\//i;

/**
 * The ISO 639-2/T codes of the 24 EUR-Lex languages, the language segment an ELI
 * carries after its manifestation (`…/oj/eng`).
 */
const ELI_LANGUAGE_SEGMENTS: ReadonlySet<string> = new Set([
  'bul',
  'ces',
  'dan',
  'deu',
  'ell',
  'eng',
  'est',
  'fin',
  'fra',
  'gle',
  'hrv',
  'hun',
  'ita',
  'lav',
  'lit',
  'mlt',
  'nld',
  'pol',
  'por',
  'ron',
  'slk',
  'slv',
  'spa',
  'swe',
]);

/** A point-in-time ELI segment (`…/2016-05-04`). */
const ELI_POINT_IN_TIME = /^\d{4}-\d{2}-\d{2}$/;

/**
 * An ELI in the `http://data.europa.eu/eli/…` form CELLAR stores: an `https` or
 * missing scheme, the `eur-lex.europa.eu` host, an upper-case scheme or host, and a
 * trailing `/` are rewritten, and a language segment after `/oj` or a point-in-time
 * date is dropped (no CELLAR literal carries one). A format segment after the
 * language (`…/oj/eng/pdf`) is left in place. Every other value is returned trimmed.
 */
export function normalizeEli(value: string): string {
  const trimmed = value.trim();
  const root = ELI_ROOT.exec(trimmed);
  if (!root) return trimmed;
  const eli = ELI_NAMESPACE + trimmed.slice(root[0].length);
  let end = eli.length;
  while (end > ELI_NAMESPACE.length && eli[end - 1] === '/') end--;
  const path = eli.slice(0, end);
  const lastSlash = path.lastIndexOf('/');
  const head = path.slice(0, lastSlash);
  const manifestation = head.slice(head.lastIndexOf('/') + 1);
  const dropsLanguage =
    ELI_LANGUAGE_SEGMENTS.has(path.slice(lastSlash + 1)) &&
    (manifestation === 'oj' || ELI_POINT_IN_TIME.test(manifestation));
  return dropsLanguage ? head : path;
}

/**
 * Case-number grammar, shared by eurlex_get_cases (which matches a case number to
 * its CELEX) and eurlex_lookup_celex (which routes one there). A `C-`/`T-`/`F-`
 * prefix takes any hyphen form a published reference uses (ASCII, U+2010–U+2015,
 * U+2212 — CELLAR titles often carry U+2011). A prefix-less number is a pre-1989
 * Court of Justice case (`26/62`, `133-73`), where `/` or a hyphen separates number
 * and year. Both accept a leading "Case" and ignore the text after the year — a
 * procedural suffix (`P`, `R II`, `PPU`, …) or the trailing "." of a case reference
 * — since CELEX carries no suffix. Trailing text that holds another case designation
 * (a digit, `/` or a hyphen, a digit — as in "C-131/12 and C-132/12") names a second
 * case, which a single CELEX match would silently drop, so it is rejected; no
 * procedural suffix contains a digit. Each pattern is anchored or fixed-width and
 * backtracks through a single digit run at most, so cost stays linear in the input
 * length.
 */
const HYPHEN = '[-\\u2010-\\u2015\\u2212]';
const PREFIXED_CASE_NUMBER = new RegExp(
  `^(?:case\\s+)?([CTF])${HYPHEN}(\\d+)/(\\d{2,4})(?!\\d)`,
  'i',
);
const PREFIXLESS_CASE_NUMBER = new RegExp(
  `^(?:case\\s+)?(\\d+)(?:/|${HYPHEN})(\\d{2,4})(?!\\d)`,
  'i',
);
const ANOTHER_CASE_NUMBER = new RegExp(`\\d(?:/|${HYPHEN})\\d`);

/** Unprefixed Court of Justice case numbers were issued from 1953 until the General Court opened in 1989. */
const PREFIXLESS_FIRST_YEAR = 1953;
const PREFIXLESS_LAST_YEAR = 1988;

/** CELEX court letter a case-number prefix names: Court of Justice, General Court, Civil Service Tribunal. */
export type CaseCourtLetter = 'C' | 'T' | 'F';

export type ParsedCaseNumber =
  | { kind: 'case'; court: CaseCourtLetter; year: number; number: string }
  | { kind: 'unprefixed_out_of_range'; year: number }
  | { kind: 'several' }
  | { kind: 'unparsed' };

/**
 * True when `value` opens with a prefixed case number (`C-131/12`, `Case T-1/99 P`).
 * Never a CELEX: a sector-C CELEX reads `C/2024/01469` or `C2017/111/07`, and a
 * case number names several records (the judgment, the Advocate General's opinion,
 * orders), not one work. A prefix-less number (`26/62`) is not matched: it collides
 * with OJ citation numbering (`95/46`).
 */
export function isPrefixedCaseNumber(value: string): boolean {
  return PREFIXED_CASE_NUMBER.test(value.trim());
}

/**
 * Parse a single case number into the CELEX parts it names.
 *
 * Prefixed years keep the historical two-digit heuristic (yy ≤ 60 → 20yy, else
 * 19yy), so C-25/62 still reads as 1962; a three- or four-digit year is taken as
 * written. A prefix-less number always reads as the Court of Justice with a 19yy
 * year, and one dated outside 1953–1988 is reported separately — it cannot be told
 * apart from a General Court or Court of Justice number that lost its prefix. A value
 * whose trailing text holds a second case designation is reported as `several`.
 */
export function parseCaseNumber(value: string): ParsedCaseNumber {
  const prefixed = PREFIXED_CASE_NUMBER.exec(value);
  const match = prefixed ?? PREFIXLESS_CASE_NUMBER.exec(value);
  if (!match) return { kind: 'unparsed' };
  if (ANOTHER_CASE_NUMBER.test(value.slice(match[0].length))) return { kind: 'several' };
  if (prefixed) {
    // Groups 1–3 are all present once the pattern matches; the `?? ''` fallbacks
    // satisfy the type-checker without a non-null assertion and never fire at runtime.
    const yearText = prefixed[3] ?? '';
    const rawYear = parseInt(yearText, 10);
    return {
      kind: 'case',
      court: (prefixed[1] ?? '').toUpperCase() as CaseCourtLetter,
      year: yearText.length === 2 ? (rawYear <= 60 ? 2000 + rawYear : 1900 + rawYear) : rawYear,
      number: (prefixed[2] ?? '').padStart(4, '0'),
    };
  }
  const yearText = match[2] ?? '';
  const rawYear = parseInt(yearText, 10);
  const year = yearText.length === 2 ? 1900 + rawYear : rawYear;
  if (year < PREFIXLESS_FIRST_YEAR || year > PREFIXLESS_LAST_YEAR) {
    return { kind: 'unprefixed_out_of_range', year };
  }
  return { kind: 'case', court: 'C', year, number: (match[1] ?? '').padStart(4, '0') };
}

/** Days in each month for a non-leap year, indexed by month number minus one. */
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/**
 * True when `value` is a real calendar date in `YYYY-MM-DD` form.
 *
 * The date filters both search tools expose reach CELLAR as an `xsd:date`
 * literal comparison. Virtuoso does not reject an impossible date there — the
 * comparison simply matches nothing — so `2026-99-99` comes back as an empty
 * result set rather than an input error, and the caller never learns the value
 * was not a date. Shape validation alone cannot catch it; the calendar has to be
 * checked before the query is built.
 */
export function isValidCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return false;
  const isLeapYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const maxDay = month === 2 && isLeapYear ? 29 : (DAYS_IN_MONTH[month - 1] ?? 0);
  return day >= 1 && day <= maxDay;
}

/**
 * Characters that cannot appear inside a SPARQL IRI reference (`<…>`): the whole
 * IRIREF exclusion set of SPARQL 1.1 grammar rule [139] — U+0000–U+0020 and
 * `` <>"{}|^`\ `` — plus any other Unicode whitespace, which no real URI carries.
 * CELLAR rejects every excluded character with SP030, U+0000 as an HTTP 500 (#140).
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: SPARQL excludes the C0 controls from an IRI, so the guard must match them.
const UNSAFE_SPARQL_IRI_CHARS = /[\s\x00-\x20<>"{}|^`\\]/;

/**
 * True when `value` is an http URI safe to interpolate into a SPARQL `<…>` IRI.
 *
 * Caller-supplied URIs reach the query as `<${uri}>`, so a value carrying an IRI-
 * forbidden character builds an unparseable query and leaks Virtuoso's raw compiler
 * error — with the internal query text attached — in place of the tool's own error
 * (#53, #60, #140). Real CELLAR work URIs and EuroVoc concept URIs contain none of
 * these characters, so the check has no false-positive risk against genuine values.
 */
export function isSafeSparqlIri(value: string): boolean {
  return value.startsWith('http') && !UNSAFE_SPARQL_IRI_CHARS.test(value);
}

/**
 * ELI exact-match query: resolve the single work whose canonical ELI literal
 * (`cdm:resource_legal_eli`, an `xsd:anyURI` literal) equals `safeEli`, reading
 * its CELEX, type, and date. `safeEli` must be pre-escaped.
 */
export function buildEliQuery(safeEli: string): string {
  return `
SELECT ?work ?celexNumber ?type ?date WHERE {
  ?work cdm:resource_legal_eli "${safeEli}"^^xsd:anyURI .
  ?work cdm:resource_legal_id_celex ?celexNumber .
  OPTIONAL { ?work cdm:work_has_resource-type ?type . }
  OPTIONAL { ?work cdm:work_date_document ?date . }
} LIMIT 5`;
}

/**
 * Resolve an ELI URI to its canonical CELLAR work binding.
 *
 * Exact-matches the ELI literal; a bare work-level ELI that misses is retried
 * once with `/oj` appended — a deterministic, one-to-one normalization to the
 * same act's canonical OJ manifestation. The retry is gated to bare work-level
 * ELIs, so a manifestation-suffixed ELI (e.g. a `/YYYY-MM-DD` consolidated
 * version) never silently falls back to the original act.
 *
 * Returns the first matching binding (with `?work ?celexNumber ?type ?date`),
 * or `null` when the ELI resolves to no work.
 */
export async function resolveEliToWork(
  svc: Pick<CellarSparqlService, 'query'>,
  eli: string,
  ctx: Context,
): Promise<SparqlBinding | null> {
  const trimmed = eli.trim();
  let bindings = await svc.query(buildEliQuery(escapeSparqlLiteral(trimmed)), ctx);

  if (bindings.length === 0 && isBareWorkLevelEli(trimmed)) {
    const ojEli = `${trimmed.replace(/\/+$/, '')}/oj`;
    ctx.log.debug('ELI exact-match missed; retrying with /oj manifestation', {
      eli: trimmed,
      ojEli,
    });
    bindings = await svc.query(buildEliQuery(escapeSparqlLiteral(ojEli)), ctx);
  }

  return bindings[0] ?? null;
}
