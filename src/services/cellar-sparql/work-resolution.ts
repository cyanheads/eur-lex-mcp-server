/**
 * @fileoverview CELEX → CELLAR work resolution. CELLAR holds some CELEX numbers under
 * several works: `cdm:do_not_index` copies on case law and preparatory acts, and on a
 * few General Court CELEX a second work aliased `…_EXT`. Exactly one of them is
 * `owl:sameAs <http://publications.europa.eu/resource/celex/{CELEX}>`, the IRI the
 * EUR-Lex content resolver serves the body from. Every CELEX-keyed site resolves
 * through the rule here: that work, else the lowest work URI.
 * @module services/cellar-sparql/work-resolution
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { CellarSparqlService } from './cellar-sparql-service.js';
import { CELEX_ALIAS_NAMESPACE, celexLiteral } from './eli-resolution.js';
import type { SparqlBinding } from './types.js';

/**
 * An `OPTIONAL` that binds `?canonicalAlias` on the row of the work `owl:sameAs` the
 * alias IRI of `celexTerm` — a typed CELEX literal, or a variable the pattern has
 * already bound. Place it after the triple that binds `?work`.
 *
 * The IRI is built in SPARQL with `ENCODE_FOR_URI`, which escapes `(` and `)` as
 * CELLAR stores them (`62015TO0235%2801%29`); `encodeURIComponent` leaves them
 * literal. The filtered `OPTIONAL` shape is the one CELLAR evaluates correctly and
 * fast in an ungrouped query: a `VALUES` + `BIND(EXISTS …)` form returns the same
 * rows in ~20 s. Inside a grouped query the same `OPTIONAL` is unreliable: it bound
 * under a grouped `COUNT` and stayed unbound in the search and case-law page
 * queries, so those read the canonical work in a follow-up
 * ({@link resolveCelexWorkRows}) and test for it with {@link aliasRivalPattern}.
 */
export function canonicalAliasPattern(celexTerm: string): string {
  return `OPTIONAL {
    ?work <http://www.w3.org/2002/07/owl#sameAs> ?canonicalAlias .
    FILTER(?canonicalAlias = IRI(CONCAT("${CELEX_ALIAS_NAMESPACE}", ENCODE_FOR_URI(STR(${celexTerm})))))
  }`;
}

/**
 * Patterns that match when a work other than `workVar` holds the CELEX `celexVar`
 * binds and carries that CELEX's alias: `workVar` is then a copy, and the match,
 * bound as `?aliasRival`, is the work the CELEX resolves to. For the body of a
 * `FILTER NOT EXISTS`, which drops a copy and keeps the alias work itself and any
 * work whose CELEX has no alias work; a further pattern on `?aliasRival` in the same
 * body narrows which copies are dropped. `celexVar` must be bound where the filter
 * is evaluated.
 *
 * The `owl:sameAs` triple is required here, not the `OPTIONAL` of
 * {@link canonicalAliasPattern}, so it evaluates the same in a grouped query, a
 * page-first subquery, and a flat one.
 */
export function aliasRivalPattern(workVar: string, celexVar: string): string {
  return `?aliasRival cdm:resource_legal_id_celex ${celexVar} .
    ?aliasRival <http://www.w3.org/2002/07/owl#sameAs> ?rivalAlias .
    FILTER(?aliasRival != ${workVar} && ?rivalAlias = IRI(CONCAT("${CELEX_ALIAS_NAMESPACE}", ENCODE_FOR_URI(STR(${celexVar})))))`;
}

/** True when a row belongs to the work carrying its CELEX alias. */
export function isCanonicalRow(binding: SparqlBinding): boolean {
  return CellarSparqlService.bindingValue(binding, 'canonicalAlias') !== undefined;
}

/**
 * The work a set of rows for one CELEX resolves to: the work carrying the CELEX
 * alias, else the lowest work URI. Independent of row order, which CELLAR does not
 * guarantee. Rows project `?work`, and `?canonicalAlias` from
 * {@link canonicalAliasPattern}.
 */
export function pickResolvedWork(bindings: readonly SparqlBinding[]): string | undefined {
  let best: { canonical: boolean; work: string } | undefined;
  for (const b of bindings) {
    const work = CellarSparqlService.bindingValue(b, 'work');
    if (!work) continue;
    const canonical = isCanonicalRow(b);
    if (
      !best ||
      (canonical && !best.canonical) ||
      (canonical === best.canonical && work < best.work)
    ) {
      best = { canonical, work };
    }
  }
  return best?.work;
}

/**
 * Every row of the work {@link pickResolvedWork} selects, in their order: one per
 * combination of its column values (each type, each title), so a reader sees the
 * whole work rather than whichever row came first. Empty for no rows.
 */
export function resolvedWorkRows(bindings: readonly SparqlBinding[]): SparqlBinding[] {
  const work = pickResolvedWork(bindings);
  return bindings.filter((b) => CellarSparqlService.bindingValue(b, 'work') === work);
}

/** The values a column takes across rows, sorted by code unit. */
export function columnValues(rows: readonly SparqlBinding[], column: string): string[] {
  return rows.flatMap((b) => CellarSparqlService.bindingValue(b, column) ?? []).sort();
}

/**
 * Columns a resolution query reads on every work beside its URI: the variables to
 * project and the patterns that bind them on `?work`. Each pattern is an `OPTIONAL`,
 * so a work lacking one still returns, and the query stays ungrouped, the one shape
 * in which {@link canonicalAliasPattern} binds.
 */
export interface PerWorkColumns {
  patterns: readonly string[];
  /** Projected variables, e.g. `?type`. */
  variables: readonly string[];
}

/** A CELEX's resolved work, with the rows the resolution query returned for it. */
export interface ResolvedCelexWork {
  /** Rows of every work holding the CELEX, the resolved one included. */
  celexRows: SparqlBinding[];
  work: string;
  /** Rows of the resolved work alone: one per combination of its column values. */
  workRows: SparqlBinding[];
}

/**
 * Resolve each CELEX to its work in one round trip: a `VALUES` join on the typed CELEX
 * literals, one row per work — with `perWork`, one per work and combination of its
 * column values. A CELEX no work holds is absent from the map; an empty list sends no
 * query. The query has no `LIMIT` because the `VALUES` list bounds it — no CELEX has
 * been seen with more than four works.
 */
export async function resolveCelexWorkRows(
  svc: Pick<CellarSparqlService, 'query'>,
  celexNumbers: readonly string[],
  ctx: Context,
  perWork?: PerWorkColumns,
): Promise<Map<string, ResolvedCelexWork>> {
  const distinct = [...new Set(celexNumbers)];
  if (distinct.length === 0) return new Map();

  const variables = perWork?.variables.map((v) => ` ${v}`).join('') ?? '';
  const patterns = perWork?.patterns.map((p) => `\n  ${p}`).join('') ?? '';
  const query = `
SELECT ?celexNumber ?work ?canonicalAlias${variables} WHERE {
  VALUES ?celexNumber { ${distinct.map(celexLiteral).join(' ')} }
  ?work cdm:resource_legal_id_celex ?celexNumber .
  ${canonicalAliasPattern('?celexNumber')}${patterns}
}`;

  const byCelex = Map.groupBy(await svc.query(query, ctx), (b) =>
    CellarSparqlService.bindingValue(b, 'celexNumber'),
  );

  const resolved = new Map<string, ResolvedCelexWork>();
  for (const [celex, rows] of byCelex) {
    if (!celex) continue;
    const work = pickResolvedWork(rows);
    if (!work) continue;
    resolved.set(celex, {
      work,
      workRows: rows.filter((b) => CellarSparqlService.bindingValue(b, 'work') === work),
      celexRows: rows,
    });
  }
  return resolved;
}

/** Resolve each CELEX to its work URI: {@link resolveCelexWorkRows} with no columns. */
export async function resolveCelexWorks(
  svc: Pick<CellarSparqlService, 'query'>,
  celexNumbers: readonly string[],
  ctx: Context,
): Promise<Map<string, string>> {
  const resolved = await resolveCelexWorkRows(svc, celexNumbers, ctx);
  return new Map([...resolved].map(([celex, { work }]) => [celex, work]));
}
