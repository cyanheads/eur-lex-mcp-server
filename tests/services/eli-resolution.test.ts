/**
 * @fileoverview Tests for the SPARQL-safety primitives shared by every CELLAR
 * query builder — `escapeSparqlLiteral` (values interpolated into a `"…"` literal)
 * and `isSafeSparqlIri` (URIs interpolated into a `<…>` IRI) — plus the shared
 * input-validity primitives `CELEX_PATTERN` and `isValidCalendarDate`.
 * @module tests/services/eli-resolution.test
 */

import { describe, expect, it } from 'vitest';
import {
  CELEX_PATTERN,
  escapeSparqlLiteral,
  isSafeSparqlIri,
  isValidCalendarDate,
} from '@/services/cellar-sparql/eli-resolution.js';

/**
 * Expected values use `String.raw` throughout: these assertions are about which
 * *characters* land in the query, and a conventional string literal would need
 * doubled backslashes that obscure exactly the thing under test. `String.raw`a\\b``
 * is the four characters a, \, \, b.
 *
 * A CELLAR work URI and the GDPR CELEX stand in for real caller input.
 */
const CELLAR_WORK_URI =
  'http://publications.europa.eu/resource/cellar/3e485e15-11bd-11e6-ba9a-01aa75ed71a1';
const EUROVOC_URI = 'http://eurovoc.europa.eu/2828';

describe('escapeSparqlLiteral', () => {
  it('leaves a value with nothing to escape unchanged', () => {
    expect(escapeSparqlLiteral('32016R0679')).toBe('32016R0679');
  });

  it('escapes a backslash', () => {
    expect(escapeSparqlLiteral('a\\b')).toBe(String.raw`a\\b`);
  });

  it('escapes a double quote', () => {
    expect(escapeSparqlLiteral('a"b')).toBe(String.raw`a\"b`);
  });

  /**
   * The defect #53 reproduces live: a short SPARQL literal cannot span lines, so a
   * raw newline in an identifier made the whole query unparseable and Virtuoso's
   * compiler error reached the caller in place of the tool's own not-found.
   */
  it('escapes a newline', () => {
    expect(escapeSparqlLiteral('32016R0679\nGDPR')).toBe(String.raw`32016R0679\nGDPR`);
  });

  /**
   * CR and tab do not currently break a query — Virtuoso accepts both raw in this
   * position, returning zero bindings rather than an error. They are escaped anyway:
   * the SPARQL grammar excludes them, and the fix should not depend on one endpoint
   * being more lenient than the spec.
   */
  it('escapes a carriage return', () => {
    expect(escapeSparqlLiteral('a\rb')).toBe(String.raw`a\rb`);
  });

  it('escapes a tab', () => {
    expect(escapeSparqlLiteral('a\tb')).toBe(String.raw`a\tb`);
  });

  /**
   * Order regression: the backslash pass must run before the passes that introduce
   * backslashes of their own. Escaping the newline first would leave the backslash
   * pass to double the escape it just added, turning the newline back into a literal
   * backslash followed by `n` (`String.raw`a\\\\nb``).
   */
  it('escapes a backslash adjacent to a newline without doubling the newline escape', () => {
    // Input characters: a, \, newline, b
    const value = 'a\\\nb';
    expect(escapeSparqlLiteral(value)).toBe(String.raw`a\\\nb`);
    expect(escapeSparqlLiteral(value)).not.toBe(String.raw`a\\\\nb`);
  });

  it('escapes every special character in one value', () => {
    expect(escapeSparqlLiteral('\\"\n\r\t')).toBe(String.raw`\\\"\n\r\t`);
  });

  /**
   * The invariant that actually matters, independent of how the passes are written:
   * nothing that a SPARQL short literal forbids survives into the query text.
   */
  it('leaves no raw control character in the output', () => {
    expect(escapeSparqlLiteral('a\nb\rc\td')).not.toMatch(/[\n\r\t]/);
  });

  it('leaves no unescaped double quote in the output', () => {
    expect(escapeSparqlLiteral('a"b')).not.toMatch(/(^|[^\\])"/);
  });
});

describe('isSafeSparqlIri', () => {
  it.each([
    ['a CELLAR work URI', CELLAR_WORK_URI],
    ['a EuroVoc concept URI', EUROVOC_URI],
    ['an https URI', 'https://publications.europa.eu/resource/cellar/abc'],
  ])('accepts %s', (_label, uri) => {
    expect(isSafeSparqlIri(uri)).toBe(true);
  });

  /**
   * Whitespace is the gap #53/#60 close: the guards these replaced tested only for a
   * literal space, so a tab or newline reached `<${uri}>` and built a malformed IRI.
   * Both are confirmed live to leak Virtuoso's compiler error on the IRI path.
   */
  it.each([
    ['a tab', `${CELLAR_WORK_URI}\tX`],
    ['a newline', `${CELLAR_WORK_URI}\nX`],
    ['a carriage return', `${CELLAR_WORK_URI}\rX`],
    ['a space', `${CELLAR_WORK_URI} X`],
    ['an opening angle bracket', `${CELLAR_WORK_URI}<X`],
    ['a closing angle bracket', `${CELLAR_WORK_URI}>X`],
    ['a double quote', `${CELLAR_WORK_URI}"X`],
  ])('rejects a URI containing %s', (_label, uri) => {
    expect(isSafeSparqlIri(uri)).toBe(false);
  });

  it.each([
    ['a bare token', 'not-a-uri'],
    ['a non-http scheme', 'ftp://example.org/x'],
    ['an empty string', ''],
  ])('rejects %s', (_label, value) => {
    expect(isSafeSparqlIri(value)).toBe(false);
  });
});

/**
 * The structural CELEX floor applied at the schema layer, before a CELLAR
 * round-trip is spent on an identifier that can never resolve. Sector coverage is
 * the point: the corpus spans digit sectors 0–9 plus the letter sectors C and E,
 * and real values carry treaty slashes, corrigendum parentheses, consolidation
 * date suffixes, and national-measure underscores.
 *
 * The floor is a plain charset-and-length pattern with no lookarounds, so the
 * advertised JSON Schema `pattern` stays usable by RE2-family validators. A value
 * made only of digits, or only of uppercase letters, therefore passes the floor —
 * existence is CELLAR's answer, not this pattern's.
 */
describe('CELEX_PATTERN', () => {
  it.each([
    ['sector 0, consolidated version', '02016R0679-20160504'],
    ['sector 1, treaty reference with slashes', '11957A/PRO/CJ/09'],
    ['sector 1, a second slashed treaty reference', '12008M/PRO/07'],
    ['sector 1, the shortest value in the corpus', '11997M'],
    ['sector 2, external relations', '22001D0815'],
    ['sector 3, regulation', '32016R0679'],
    ['sector 3, directive', '32016L0680'],
    ['sector 3, corrigendum marker', '32016R0679R(02)'],
    ['sector 4, complementary legislation', '42002D0234'],
    ['sector 5, preparatory act', '52016PC0001'],
    ['sector 6, case law', '62024CJ0629'],
    ['sector 7, national implementing measure', '72014L0056FIN_240353'],
    ['sector 8, national case law', '82003PT1111(51)'],
    ['sector 9, parliamentary question', '91980E001013'],
    ['sector C, OJ C series', 'C/2026/01104'],
    ['sector E, EFTA document', 'E2016C0186'],
  ])('accepts a real %s', (_label, celex) => {
    expect(CELEX_PATTERN.test(celex)).toBe(true);
  });

  it.each([
    ['a bare zero', '0'],
    ['a lowercase word', 'hello'],
    ['whitespace only', '   '],
    ['an empty string', ''],
    ['a value shorter than six characters', '3201R'],
    ['a lowercased CELEX', '32016r0679'],
    ['a value with an embedded space', '32016R0679 GDPR'],
    ['a value with an embedded newline', '32016R0679\nGDPR'],
    ['a value with a trailing backslash', '32016R0679\\'],
    ['a value with an embedded double quote', '32016R0679"'],
    ['a leading-punctuation value', '-2016R0679'],
  ])('rejects %s', (_label, value) => {
    expect(CELEX_PATTERN.test(value)).toBe(false);
  });

  it('is stateless across repeated tests of the same value', () => {
    // A `g`-flagged regex would advance lastIndex and alternate true/false here.
    expect(CELEX_PATTERN.test('32016R0679')).toBe(true);
    expect(CELEX_PATTERN.test('32016R0679')).toBe(true);
  });
});

/**
 * Calendar validity for the date filters. The shape regex on those fields admits
 * any four-two-two digit string, and CELLAR answers an impossible `xsd:date`
 * comparison with zero bindings rather than an error, so the calendar has to be
 * checked before the query is built.
 */
describe('isValidCalendarDate', () => {
  it.each([
    ['an ordinary date', '2016-04-27'],
    ['the first day of a month', '2020-01-01'],
    ['the last day of a 31-day month', '2020-12-31'],
    ['the last day of a 30-day month', '2020-04-30'],
    ['a leap day in a leap year', '2024-02-29'],
    ['a leap day in a 400-year leap year', '2000-02-29'],
    ['the last day of February in a common year', '2023-02-28'],
  ])('accepts %s', (_label, value) => {
    expect(isValidCalendarDate(value)).toBe(true);
  });

  it.each([
    ['an impossible month and day', '2026-99-99'],
    ['month 13', '2026-13-01'],
    ['month 00', '2026-00-01'],
    ['day 00', '2026-01-00'],
    ['day 32 in a 31-day month', '2026-01-32'],
    ['day 31 in a 30-day month', '2026-04-31'],
    ['a leap day in a common year', '2023-02-29'],
    ['a leap day in a non-leap century year', '1900-02-29'],
  ])('rejects %s', (_label, value) => {
    expect(isValidCalendarDate(value)).toBe(false);
  });

  it.each([
    ['a year alone', '2016'],
    ['a single-digit month and day', '2026-2-9'],
    ['a leading-whitespace value', ' 2026-01-01'],
    ['a trailing-whitespace value', '2026-01-01 '],
    ['a slash-separated date', '2026/01/01'],
    ['an empty string', ''],
    ['a datetime', '2026-01-01T00:00:00Z'],
  ])('rejects %s on shape alone', (_label, value) => {
    expect(isValidCalendarDate(value)).toBe(false);
  });
});
