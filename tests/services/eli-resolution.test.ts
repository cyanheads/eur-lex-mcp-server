/**
 * @fileoverview Tests for the SPARQL-safety primitives shared by every CELLAR
 * query builder — `escapeSparqlLiteral` (values interpolated into a `"…"` literal)
 * and `isSafeSparqlIri` (URIs interpolated into a `<…>` IRI).
 * @module tests/services/eli-resolution.test
 */

import { describe, expect, it } from 'vitest';
import { escapeSparqlLiteral, isSafeSparqlIri } from '@/services/cellar-sparql/eli-resolution.js';

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
