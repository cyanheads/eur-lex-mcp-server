/**
 * @fileoverview Tests for CELLAR's sorted-query window arithmetic (#154).
 * @module tests/services/sort-window.test
 */

import { describe, expect, it } from 'vitest';
import {
  isPastSortWindow,
  readWindowedPage,
  SORT_WINDOW,
  windowEndRoute,
  windowedLimit,
} from '@/services/cellar-sparql/sort-window.js';

describe('CELLAR sort window', () => {
  it('is 10,000 rows', () => {
    expect(SORT_WINDOW).toBe(10_000);
  });

  it.each([
    [0, false],
    [9_999, false],
    [10_000, true],
    [10_001, true],
  ])('offset %i is past the window: %s', (offset, past) => {
    expect(isPastSortWindow(offset)).toBe(past);
  });

  /** [offset, page limit, LIMIT asked for]: the page plus a sentinel, cut to the window. */
  it.each([
    [0, 100, 101],
    [9_899, 100, 101],
    [9_900, 100, 100],
    [9_949, 100, 51],
    [9_950, 100, 50],
    [9_999, 100, 1],
    [9_949, 50, 51],
    [9_950, 50, 50],
    [9_999, 50, 1],
    [9_999, 1, 1],
    [9_998, 1, 2],
  ])('offset %i, page %i asks for %i rows and never crosses row 10,000', (offset, page, limit) => {
    expect(windowedLimit(offset, page)).toBe(limit);
    expect(offset + windowedLimit(offset, page)).toBeLessThanOrEqual(SORT_WINDOW);
  });

  it('proves more rows when the sentinel comes back inside the window', () => {
    expect(readWindowedPage(101, 9_899, 100)).toEqual({ hasMore: true, atWindowEnd: false });
    expect(readWindowedPage(100, 9_899, 100)).toEqual({ hasMore: false, atWindowEnd: false });
  });

  it('marks the window end when the window cut the sentinel and every row it allows came back', () => {
    expect(readWindowedPage(100, 9_900, 100)).toEqual({ hasMore: false, atWindowEnd: true });
    expect(readWindowedPage(50, 9_950, 100)).toEqual({ hasMore: false, atWindowEnd: true });
    expect(readWindowedPage(1, 9_999, 100)).toEqual({ hasMore: false, atWindowEnd: true });
  });

  it('reads a short page inside the cut window as the end of the rows, not the window', () => {
    expect(readWindowedPage(20, 9_900, 100)).toEqual({ hasMore: false, atWindowEnd: false });
    expect(readWindowedPage(0, 9_999, 100)).toEqual({ hasMore: false, atWindowEnd: false });
  });

  it('walks next pages to row 10,000 and no further', () => {
    const total = 14_567;
    const page = 100;
    let offset = 9_700;
    const visited: number[] = [];
    for (;;) {
      visited.push(offset);
      const rows = Math.max(0, Math.min(total, offset + windowedLimit(offset, page)) - offset);
      const { hasMore, atWindowEnd } = readWindowedPage(rows, offset, page);
      if (!hasMore) {
        expect(atWindowEnd).toBe(true);
        expect(offset + Math.min(rows, page)).toBe(SORT_WINDOW);
        break;
      }
      offset += page;
    }
    expect(visited).toEqual([9_700, 9_800, 9_900]);
  });
});

describe('route past the sort window', () => {
  it('continues an open-ended search through closed windows, the last date first, then earlier years', () => {
    const route = windowEndRoute('cases', '2020-04-30');
    expect(route).toContain('date_from=2020-01-01, date_to=2020-04-30');
    expect(route).toContain('cases dated 2020-04-30 appear again');
    expect(route).toContain('date_from=2019-01-01, date_to=2019-12-31');
    expect(route).toContain('offset 0');
  });

  it.each([
    ['2020-01-01', 'date_from=2020-01-01, date_to=2020-01-01', '2019'],
    ['1001-03-04', 'date_from=1001-01-01, date_to=1001-03-04', '1000'],
  ])('starts the first window at the last date’s year (%s)', (lastDate, window, earlier) => {
    const route = windowEndRoute('documents', lastDate);
    expect(route).toContain(window);
    expect(route).toContain(`date_from=${earlier}-01-01, date_to=${earlier}-12-31`);
  });

  it("closes the window at the caller's date_from, with no earlier years to step through", () => {
    const route = windowEndRoute('documents', '2020-04-30', '1990-01-01');
    expect(route).toContain('date_from=1990-01-01, date_to=2020-04-30');
    expect(route).toContain('documents dated 2020-04-30 appear again');
    expect(route).not.toContain('date_from=2020-01-01');
    expect(route).not.toContain('calendar year');
  });

  it('names the date filters, and no date, when the last row is undated', () => {
    const route = windowEndRoute('cases', undefined, '1990-01-01');
    expect(route).toContain('date_from/date_to');
    expect(route).not.toMatch(/date_(from|to)=/);
  });
});
