/**
 * @fileoverview ELI URI → CELLAR work resolution, shared between eurlex_lookup_celex
 * and eurlex_get_document. CELLAR stores the canonical OJ-manifestation ELI literal
 * (`cdm:resource_legal_eli`, an `xsd:anyURI` literal), so a bare work-level ELI is
 * normalized to its `/oj` form on a miss. Extracted from eurlex_lookup_celex (#5) so
 * both tools resolve ELIs identically rather than duplicating the mechanism.
 *
 * Also home to the SPARQL-safety primitives every CELLAR query builder shares —
 * `escapeSparqlLiteral` for values interpolated into a `"…"` literal, and
 * `isSafeSparqlIri` for URIs interpolated into a `<…>` IRI.
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
 * Characters that cannot appear inside a SPARQL IRI reference (`<…>`): any
 * whitespace — including the tab and newline a bare space check misses — plus the
 * angle brackets that delimit the IRI and a double quote.
 */
const UNSAFE_SPARQL_IRI_CHARS = /[\s<>"]/;

/**
 * True when `value` is an http URI safe to interpolate into a SPARQL `<…>` IRI.
 *
 * Caller-supplied URIs reach the query as `<${uri}>`, so a value carrying an IRI-
 * forbidden character builds an unparseable query and leaks Virtuoso's raw compiler
 * error — with the internal query text attached — in place of the tool's own error
 * (#53, #60). Real CELLAR work URIs and EuroVoc concept URIs contain none of these
 * characters, so the check has no false-positive risk against genuine values.
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
