/**
 * @fileoverview Splits a keyed CELLAR lookup across as few requests as CELLAR's
 * request limit allows, and sends them: the keyword's whole-CELEX family and
 * type-letter fragment lookups, and the relation provisions follow-up.
 * @module services/cellar-sparql/request-chunks
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { CellarSparqlService } from './cellar-sparql-service.js';
import { CELLAR_REQUEST_LIMIT_BYTES, sparqlRequestBytes } from './sparql-request-body.js';
import type { SparqlBinding } from './types.js';

/**
 * Most requests of one split lookup in flight at once. The splits measured
 * (2026-11-17): a type-letter fragment's lookups, 2 for `J0131`, 4 for `R0679`, 5 for
 * `C0001`, and 9 for `C0001` followed by 18 more digits; a whole-CELEX family, 2 once
 * the keyword costs 27 characters (each `(`, `)`, and `/` counting as three) and for
 * the heaviest CELEX CELLAR holds, 3 at the 100-character bound and
 * 6 there with 94 parentheses; the provisions of a 100-row page, 2, across a treaty
 * article's versions too. Six sends every split a real CELEX or fragment makes in one
 * round, and keeps a long synthetic keyword from fanning out at a shared public
 * endpoint.
 */
const MAX_CONCURRENT_REQUESTS = 6;

/**
 * `items` split, in order, into the fewest runs whose query, built by `queryFor`, fits
 * {@link CELLAR_REQUEST_LIMIT_BYTES}, measured as the exact body the service sends
 * ({@link sparqlRequestBytes}). Each run is the longest that fits from where the last
 * one ended; an item whose query is over the limit on its own is a run of its own, so
 * the service refuses it rather than the split dropping it or never ending. Every item
 * lands in exactly one run. `queryFor` must not shrink as items are added, as a list
 * rendered into the query never does; it renders each candidate run, a logarithmic
 * number of times per run.
 */
export function requestChunks<T>(
  items: readonly T[],
  queryFor: (chunk: readonly T[]) => string,
): T[][] {
  const fits = (start: number, end: number) =>
    sparqlRequestBytes(queryFor(items.slice(start, end))) <= CELLAR_REQUEST_LIMIT_BYTES;
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; ) {
    // `end` fits; `over`, once found, does not. Double the step until a run is over the
    // limit or takes every item, then bisect between the two.
    let end = start + 1;
    let over = items.length + 1;
    if (fits(start, end)) {
      for (let step = 1; end < items.length; step *= 2) {
        const probe = Math.min(end + step, items.length);
        if (!fits(start, probe)) {
          over = probe;
          break;
        }
        end = probe;
      }
      while (over - end > 1) {
        const middle = (end + over) >>> 1;
        if (fits(start, middle)) end = middle;
        else over = middle;
      }
    }
    chunks.push(items.slice(start, end));
    start = end;
  }
  return chunks;
}

/**
 * The rows of `queryFor` over `items`, split by {@link requestChunks} and sent
 * {@link MAX_CONCURRENT_REQUESTS} at a time, in run order. Every request of a round
 * settles before a failure among them is thrown, the first run's failure first, and no
 * later round is sent; the caller's cancellation fails every request in flight, so it
 * ends the call as itself. All requests share the call's SPARQL budget through `ctx`.
 * No items, no request.
 */
export async function queryRequestChunks<T>(
  svc: Pick<CellarSparqlService, 'query'>,
  items: readonly T[],
  queryFor: (chunk: readonly T[]) => string,
  ctx: Context,
): Promise<SparqlBinding[]> {
  const chunks = requestChunks(items, queryFor);
  const rows: SparqlBinding[] = [];
  for (let start = 0; start < chunks.length; start += MAX_CONCURRENT_REQUESTS) {
    const settled = await Promise.allSettled(
      chunks
        .slice(start, start + MAX_CONCURRENT_REQUESTS)
        .map((chunk) => svc.query(queryFor(chunk), ctx)),
    );
    const failed = settled.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
    for (const result of settled) if (result.status === 'fulfilled') rows.push(...result.value);
  }
  return rows;
}
