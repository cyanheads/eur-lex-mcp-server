/**
 * @fileoverview Runs a tool against the actual CellarSparqlService posting to a stubbed
 * CELLAR endpoint, so a test reads each request as the body the service sends: the
 * shared splitter and the query builders are the production ones, CELLAR the stub.
 * @module tests/helpers/cellar-wire
 */

import type { Mock } from 'vitest';
import { vi } from 'vitest';
import { isResolutionQuery, requestedCelex } from '../fixtures/cellar-works.js';

type WireBinding = Record<string, { type: string; value: string }>;

/** What the stubbed CELLAR holds. */
interface WireCellar {
  /** CELEX a whole-CELEX family lookup finds carried. */
  carried?: string[];
  /** CELEX a fragment lookup reads the text before its run in. */
  corpus?: string[];
  /** Rows of the page's work resolution, each answered only when the query names its `celexNumber`. */
  resolutionRows?: WireBinding[];
  /** Rows of the page query. */
  rows: WireBinding[];
}

/**
 * Runs `call` against a stubbed CELLAR with `mockQuery`, the module mock of the
 * service's `query` and `queryWithContinuation`, routed to the actual service. A
 * family lookup returns what `carried` holds of the CELEX it names, a fragment lookup
 * the distinct text before its run in each CELEX of `corpus` holding a completion it
 * names (a word starting with one, the confirming literal held), the page its `rows`,
 * its work resolution the `resolutionRows` of the CELEX the resolution's `VALUES` list
 * names, and any other query nothing. Returns `call`'s result, every request body sent,
 * and each body's query.
 */
export async function cellarOnTheWire<Result>(
  mockQuery: Mock,
  call: () => Promise<Result>,
  cellar: WireCellar,
) {
  const actual = await vi.importActual<
    typeof import('@/services/cellar-sparql/cellar-sparql-service.js')
  >('@/services/cellar-sparql/cellar-sparql-service.js');
  const svc = new actual.CellarSparqlService(
    {} as never,
    {} as never,
    {
      cellarSparqlEndpoint: 'http://cellar.test/sparql',
      sparqlQueryTimeoutMs: 5000,
      maxSparqlResults: 100,
    } as never,
  );
  mockQuery.mockImplementation((q: string, ctx: never) =>
    q.includes('GROUP BY ?celexNumber') ? svc.queryWithContinuation(q, ctx) : svc.query(q, ctx),
  );
  const bodies: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = String(init.body);
      bodies.push(body);
      const q = new URLSearchParams(body).get('query') ?? '';
      const terms = [
        ...(/\?kwCelex bif:contains "([^"]*)"/.exec(q)?.[1] ?? '').matchAll(/'(\w+)\*'/g),
      ].map((m) => m[1] ?? '');
      const literal = /FILTER\(CONTAINS\(STR\(\?kwCelex\), "([^"]*)"\)\)/.exec(q)?.[1] ?? '';
      const run = /^SELECT DISTINCT \(STRBEFORE\(STR\(\?kwCelex\), "(\w+)"\) AS \?kwHead\)/m.exec(
        q,
      )?.[1];
      const holding = (cellar.corpus ?? []).filter(
        (c) =>
          c.includes(literal) &&
          c.split(/[^0-9A-Z]+/).some((w) => terms.some((t) => w.startsWith(t))),
      );
      const bindings = q.includes('GROUP BY ?celexNumber')
        ? cellar.rows
        : isResolutionQuery(q)
          ? (cellar.resolutionRows ?? []).filter((row) =>
              requestedCelex(q).includes(row.celexNumber?.value ?? ''),
            )
          : q.includes('VALUES ?kwCelex')
            ? (cellar.carried ?? [])
                .filter((c) => q.includes(`"${c}"^^xsd:string`))
                .map((c) => ({ kwCelex: { type: 'literal', value: c } }))
            : run !== undefined
              ? [...new Set(holding.map((c) => c.slice(0, c.indexOf(run))))].map((head) => ({
                  kwHead: { type: 'literal', value: head },
                }))
              : [];
      return new Response(JSON.stringify({ head: { vars: [] }, results: { bindings } }));
    }),
  );
  try {
    const result = await call();
    return {
      result,
      bodies,
      queries: bodies.map((b) => new URLSearchParams(b).get('query') ?? ''),
    };
  } finally {
    vi.unstubAllGlobals();
  }
}
