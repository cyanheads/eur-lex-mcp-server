/**
 * @fileoverview Tests for the shared request splitter: runs packed to CELLAR's
 * 8,192-byte request limit on the exact body the service sends, every item once and in
 * order, an over-limit item alone, and the bounded, settle-then-fail sending of the runs.
 * @module tests/services/request-chunks.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import { CellarSparqlService } from '@/services/cellar-sparql/cellar-sparql-service.js';
import { queryRequestChunks, requestChunks } from '@/services/cellar-sparql/request-chunks.js';
import { sparqlRequestBytes } from '@/services/cellar-sparql/sparql-request-body.js';
import type { SparqlBinding } from '@/services/cellar-sparql/types.js';

/** CELLAR's limit on a SPARQL request body, form-encoded (HTTP 403 past it). */
const LIMIT = 8192;

/** A lookup keyed on string literals, the shape the keyword and provisions lookups take. */
const queryFor = (chunk: readonly string[]) =>
  `SELECT ?key WHERE { VALUES ?key { ${chunk.map((key) => `"${key}"`).join(' ')} } }`;

const bytes = (chunk: readonly string[]) => sparqlRequestBytes(queryFor(chunk));

/** A key of `length` letters, each one encoded byte. */
const key = (length: number, letter = 'a') => letter.repeat(length);

describe('requestChunks', () => {
  it('returns no run for no items, without rendering a query', () => {
    const render = vi.fn(queryFor);
    expect(requestChunks([], render)).toEqual([]);
    expect(render).not.toHaveBeenCalled();
  });

  it('puts a single item in one run', () => {
    expect(requestChunks(['k1'], queryFor)).toEqual([['k1']]);
  });

  it('sends a run of exactly the limit whole, and splits one a byte over it', () => {
    const items = Array.from({ length: 40 }, (_, i) =>
      key(100, String.fromCharCode(97 + (i % 26))),
    );
    const last = key(LIMIT - bytes([...items, '']));
    expect(bytes([...items, last])).toBe(LIMIT);
    expect(requestChunks([...items, last], queryFor)).toEqual([[...items, last]]);

    const overByOne = `${last}a`;
    expect(bytes([...items, overByOne])).toBe(LIMIT + 1);
    expect(requestChunks([...items, overByOne], queryFor)).toEqual([items, [overByOne]]);
  });

  it('sends an item over the limit on its own and keeps packing after it', () => {
    const huge = key(LIMIT);
    expect(bytes([huge])).toBeGreaterThan(LIMIT);
    expect(requestChunks(['k1', huge, 'k2', 'k3'], queryFor)).toEqual([
      ['k1'],
      [huge],
      ['k2', 'k3'],
    ]);
    expect(requestChunks([huge, huge], queryFor)).toEqual([[huge], [huge]]);
  });

  it('packs items of unequal size into the fewest runs, each item once and in order', () => {
    let seed = 208;
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed;
    };
    // Lengths 1–1,200, three-byte `(` and `)` mixed in, so each item's cost differs.
    const items = Array.from(
      { length: 400 },
      (_, i) => `${i}-${'(x)'.repeat(next() % 100)}${key(next() % 900)}`,
    );
    const chunks = requestChunks(items, queryFor);

    expect(chunks.flat()).toEqual(items);
    expect(chunks.length).toBeGreaterThan(10);
    chunks.forEach((chunk, i) => {
      expect(bytes(chunk)).toBeLessThanOrEqual(LIMIT);
      // Each run is the longest that fits: the next item would carry it past the limit.
      const following = chunks[i + 1]?.[0];
      if (following !== undefined) expect(bytes([...chunk, following])).toBeGreaterThan(LIMIT);
    });
  });
});

describe('queryRequestChunks', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Keys long enough that each fills a request alone. */
  const loneKeys = (count: number) =>
    Array.from({ length: count }, (_, i) => key(5000, String.fromCharCode(97 + i)));

  const row = (value: string): SparqlBinding => ({ key: { type: 'literal', value } });

  /** The keys a query asks about. */
  const keysOf = (query: string) => [...query.matchAll(/"([a-z]+)"/g)].map((m) => m[1] ?? '');

  it('sends no request for no items', async () => {
    const svc = { query: vi.fn(async () => [] as SparqlBinding[]) };
    await expect(queryRequestChunks(svc, [], queryFor, createMockContext())).resolves.toEqual([]);
    expect(svc.query).not.toHaveBeenCalled();
  });

  it('returns the rows of every run in run order, six requests in flight at most', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const answers: (() => void)[] = [];
    const svc = {
      query: vi.fn(
        (query: string) =>
          new Promise<SparqlBinding[]>((resolve) => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            answers.push(() => {
              inFlight -= 1;
              resolve(keysOf(query).map((k) => row(k.slice(0, 1))));
            });
          }),
      ),
    };
    const keys = loneKeys(13);
    const call = queryRequestChunks(svc, keys, queryFor, createMockContext());
    // Each round's later runs answer first, so the rows follow the runs, not the answers.
    for (const roundSize of [6, 6, 1]) {
      await vi.waitFor(() => expect(answers).toHaveLength(roundSize));
      for (const answer of answers.splice(0).reverse()) answer();
    }
    const rows = await call;

    expect(svc.query).toHaveBeenCalledTimes(13);
    expect(maxInFlight).toBe(6);
    expect(rows.map((r) => r.key?.value)).toEqual(keys.map((k) => k.slice(0, 1)));
  });

  it('throws the first failing run once its round has settled, and sends no later round', async () => {
    let releaseFirst: () => void = () => {};
    const firstAnswered = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const svc = {
      query: vi.fn(async (query: string) => {
        calls += 1;
        const [first = ''] = keysOf(query);
        if (first.startsWith('a')) {
          await firstAnswered;
          return [row('a')];
        }
        throw new Error(`run ${first.slice(0, 1)} failed`);
      }),
    };
    let settled = false;
    const call = queryRequestChunks(svc, loneKeys(13), queryFor, createMockContext());
    call.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.waitFor(() => expect(calls).toBe(6));
    for (let turn = 0; turn < 10; turn++) await Promise.resolve();
    expect(settled).toBe(false);

    releaseFirst();
    await expect(call).rejects.toThrow('run b failed');
    expect(calls).toBe(6);
  });

  it('ends on cancellation as the cancellation itself, sending no later round', async () => {
    const controller = new AbortController();
    const svc = {
      query: vi.fn(
        (_query: string, ctx: { signal: AbortSignal }) =>
          new Promise<SparqlBinding[]>((_resolve, reject) => {
            ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason));
          }),
      ),
    };
    const call = queryRequestChunks(
      svc,
      loneKeys(13),
      queryFor,
      createMockContext({ signal: controller.signal }),
    );
    await vi.waitFor(() => expect(svc.query).toHaveBeenCalledTimes(6));
    controller.abort();

    await expect(call).rejects.toMatchObject({ name: 'AbortError' });
    expect(svc.query).toHaveBeenCalledTimes(6);
  });

  it('lets the service refuse an item over the limit, unsent, rather than dropping it', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const service = new CellarSparqlService(
      {} as AppConfig,
      {} as StorageService,
      {
        cellarSparqlEndpoint: 'http://cellar.test/sparql',
        sparqlQueryTimeoutMs: 5000,
        maxSparqlResults: 100,
      } as ServerConfig,
    );

    await expect(
      queryRequestChunks(service, [key(LIMIT)], queryFor, createMockContext()),
    ).rejects.toMatchObject({ data: { reason: 'request_too_large' } });
    expect(fetch).not.toHaveBeenCalled();
  });
});
