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
import { celexLiteral } from './eli-resolution.js';
import type { SparqlBinding } from './types.js';

/** Namespace of the CELEX alias IRIs CELLAR attaches to a work with `owl:sameAs`. */
const CELEX_ALIAS_NAMESPACE = 'http://publications.europa.eu/resource/celex/';

/**
 * An `OPTIONAL` that binds `?canonicalAlias` on the row of the work `owl:sameAs` the
 * alias IRI of `celexTerm` — a typed CELEX literal, or a variable the pattern has
 * already bound. Place it after the triple that binds `?work`.
 *
 * The IRI is built in SPARQL with `ENCODE_FOR_URI`, which escapes `(` and `)` as
 * CELLAR stores them (`62015TO0235%2801%29`); `encodeURIComponent` leaves them
 * literal. The filtered `OPTIONAL` shape is the one CELLAR evaluates correctly and
 * fast in an ungrouped query: a `VALUES` + `BIND(EXISTS …)` form returns the same
 * rows in ~20 s, and the same `OPTIONAL` inside a grouped query never binds.
 */
export function canonicalAliasPattern(celexTerm: string): string {
  return `OPTIONAL {
    ?work <http://www.w3.org/2002/07/owl#sameAs> ?canonicalAlias .
    FILTER(?canonicalAlias = IRI(CONCAT("${CELEX_ALIAS_NAMESPACE}", ENCODE_FOR_URI(STR(${celexTerm})))))
  }`;
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

/** The first row of the work {@link pickResolvedWork} selects, or `null` for no rows. */
export function resolvedWorkRow(bindings: readonly SparqlBinding[]): SparqlBinding | null {
  const work = pickResolvedWork(bindings);
  return bindings.find((b) => CellarSparqlService.bindingValue(b, 'work') === work) ?? null;
}

/**
 * Resolve each CELEX to its work in one round trip: a `VALUES` join on the typed CELEX
 * literals, one row per work. A CELEX no work holds is absent from the map; an empty
 * list sends no query. The query has no `LIMIT` because the `VALUES` list bounds it —
 * no CELEX has been seen with more than four works.
 */
export async function resolveCelexWorks(
  svc: Pick<CellarSparqlService, 'query'>,
  celexNumbers: readonly string[],
  ctx: Context,
): Promise<Map<string, string>> {
  const distinct = [...new Set(celexNumbers)];
  if (distinct.length === 0) return new Map();

  const query = `
SELECT ?celexNumber ?work ?canonicalAlias WHERE {
  VALUES ?celexNumber { ${distinct.map(celexLiteral).join(' ')} }
  ?work cdm:resource_legal_id_celex ?celexNumber .
  ${canonicalAliasPattern('?celexNumber')}
}`;

  const byCelex = Map.groupBy(await svc.query(query, ctx), (b) =>
    CellarSparqlService.bindingValue(b, 'celexNumber'),
  );

  const resolved = new Map<string, string>();
  for (const [celex, rows] of byCelex) {
    if (!celex) continue;
    const work = pickResolvedWork(rows);
    if (work) resolved.set(celex, work);
  }
  return resolved;
}
