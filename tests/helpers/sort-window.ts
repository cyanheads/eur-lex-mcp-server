/**
 * @fileoverview CELLAR's sorted-query window as a test stand-in (#154). Virtuoso
 * refuses any sorted query whose OFFSET plus LIMIT exceeds 10,000 rows, however few
 * rows match; these helpers apply that rule to every LIMIT/OFFSET pair a generated
 * query carries, so a paged tool's query is checked the way CELLAR checks it.
 * @module tests/helpers/sort-window
 */

/** The body CELLAR returns for a sorted page past the window (HTTP 500). */
export const SR353 =
  'Virtuoso 22023 Error SR353: Sorted TOP clause specifies more then 10001 rows to sort. Only 10000 are allowed.';

/** One LIMIT/OFFSET pair of a query, in text order. */
export interface PagingClause {
  limit: number;
  offset: number;
}

/** Every LIMIT/OFFSET pair `sparql` carries — one per paged subquery. */
export function pagingClauses(sparql: string): PagingClause[] {
  return [...sparql.matchAll(/LIMIT (\d+) OFFSET (\d+)/g)].map((m) => ({
    limit: Number(m[1]),
    offset: Number(m[2]),
  }));
}

/** Throws CELLAR's SR353 refusal when any paged subquery of `sparql` reads past row 10,000. */
export function assertInSortWindow(sparql: string): void {
  if (pagingClauses(sparql).some((c) => c.offset + c.limit > 10_000)) throw new Error(SR353);
}

/** The positions `[start, end)` a clause reads from a sorted set of `total` rows. */
export function pageSpan(clause: PagingClause, total: number): { start: number; end: number } {
  return {
    start: Math.min(clause.offset, total),
    end: Math.min(clause.offset + clause.limit, total),
  };
}
