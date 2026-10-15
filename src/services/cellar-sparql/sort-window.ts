/**
 * @fileoverview CELLAR's sorted-query window. Virtuoso refuses any
 * `ORDER BY` query whose `OFFSET` plus `LIMIT` exceeds 10,000 rows (`SR353`),
 * however few rows the pattern matches. Every paged tool asks for one sentinel
 * row past its page to prove more exist; this module sizes that request so it
 * never crosses the window, and reads back whether a page proved more rows or
 * stopped at the window's end.
 * @module services/cellar-sparql/sort-window
 */

/**
 * Lower date bound for a search bounded by date_to alone. It sits below the
 * earliest `cdm:work_date_document` CELLAR holds (1001-01-01), so it excludes no work.
 */
const DATE_FLOOR = '1000-01-01';

/**
 * The `?date` filters of a date-ranged search. A date_to-only search is bounded
 * below by the floor: CELLAR's plan for a range open below drops in-range matches,
 * so the page skips rows with no error. The floor admits the same rows as no bound.
 */
export function dateRangeFilters(dateFrom?: string, dateTo?: string): string[] {
  const lowerBound = dateFrom || (dateTo ? DATE_FLOOR : undefined);
  return [
    ...(lowerBound ? [`FILTER(?date >= "${lowerBound}"^^xsd:date)`] : []),
    ...(dateTo ? [`FILTER(?date <= "${dateTo}"^^xsd:date)`] : []),
  ];
}

/** Rows a sorted CELLAR query can reach: `OFFSET + LIMIT` may not exceed it. */
export const SORT_WINDOW = 10_000;

/** True when `offset` starts at or past the window, where no sorted page can be read. */
export function isPastSortWindow(offset: number): boolean {
  return offset >= SORT_WINDOW;
}

/**
 * The `LIMIT` for a page of `pageLimit` rows at `offset` (below the window): the
 * page plus one sentinel row, cut to the rows the window leaves. Near the window's
 * end the sentinel, and then part of the page, no longer fit; offset 9,950 at a
 * page of 100 asks for 50 rows.
 */
export function windowedLimit(offset: number, pageLimit: number): number {
  return Math.min(pageLimit + 1, SORT_WINDOW - offset);
}

/** What a page fetched with {@link windowedLimit} says about the rows after it. */
export interface WindowedPage {
  /**
   * The window cut the sentinel and every row it allowed came back: the page ends
   * at row 10,000, more rows may exist past it, and no offset reaches them.
   */
  atWindowEnd: boolean;
  /** The sentinel row came back: more rows exist, and the next page is in the window. */
  hasMore: boolean;
}

/**
 * The route past a newest-first search's page ending at row 10,000, for its window
 * notice. The last row's date continues the search, as a closed window: CELLAR
 * answers a closed `date_from`/`date_to` range several times faster than the same
 * rows bounded by `date_to` alone. The window starts at the caller's `date_from`,
 * or else at the last date's year, the earlier years following one at a time.
 */
export function windowEndRoute(noun: string, lastDate?: string, dateFrom?: string): string {
  if (!lastDate) {
    return 'To continue, narrow the search with date_from/date_to or another filter and page from offset 0.';
  }
  const again = `(results run newest first; ${noun} dated ${lastDate} appear again)`;
  if (dateFrom) {
    return `To continue, search date_from=${dateFrom}, date_to=${lastDate} ${again} and page from offset 0, or narrow with another filter.`;
  }
  const year = lastDate.slice(0, 4);
  const earlier = String(Number(year) - 1).padStart(4, '0');
  return `To continue, search date_from=${year}-01-01, date_to=${lastDate} ${again} and page from offset 0, then each earlier calendar year in turn (date_from=${earlier}-01-01, date_to=${earlier}-12-31, and so on); a closed window answers much faster than date_to alone. Or narrow with another filter.`;
}

/** Read a page of `rowCount` rows fetched at `offset` with {@link windowedLimit}. */
export function readWindowedPage(
  rowCount: number,
  offset: number,
  pageLimit: number,
): WindowedPage {
  const fetched = windowedLimit(offset, pageLimit);
  return {
    atWindowEnd: fetched <= pageLimit && rowCount >= fetched,
    hasMore: rowCount > pageLimit,
  };
}
