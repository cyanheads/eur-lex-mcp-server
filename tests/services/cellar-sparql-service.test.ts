/**
 * @fileoverview Tests for CellarSparqlService — the xsd:boolean parser and the
 * query methods' projection handling (head.vars survives an empty result set).
 * @module tests/services/cellar-sparql-service.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import {
  createMockContext,
  type MockContextLogger,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import { eurlex_lookup_celex } from '@/mcp-server/tools/definitions/eurlex-lookup-celex.tool.js';
import { eurlex_query_sparql } from '@/mcp-server/tools/definitions/eurlex-query-sparql.tool.js';
import {
  CellarSparqlService,
  initCellarSparqlService,
} from '@/services/cellar-sparql/cellar-sparql-service.js';

const TEST_SERVER_CONFIG = {
  cellarSparqlEndpoint: 'http://cellar.test/sparql',
  eurLexContentBaseUrl: 'http://content.test',
  sparqlQueryTimeoutMs: 5_000,
  maxSparqlResults: 100,
} satisfies ServerConfig;

function makeService(overrides: Partial<ServerConfig> = {}): CellarSparqlService {
  // config/storage are unused by the query path.
  return new CellarSparqlService({} as unknown as AppConfig, {} as unknown as StorageService, {
    ...TEST_SERVER_CONFIG,
    ...overrides,
  });
}

/*
 * CELLAR error bodies as CELLAR returns them (captured 2026-10-15): SQ156 and
 * SR353 arrive as HTTP 500, a syntax error as HTTP 400.
 */
const SQ156_BODY = `Virtuoso 37000 Error SQ156: Internal Optimized compiler error : subq ot was supposed to be found given the tree in sqlo.c:1119.
Please report the statement compiled.

SPARQL query:
#output-format:application/sparql-results+json
SELECT ?x WHERE { ?x ?y ?z }`;

const SR353_BODY = `Virtuoso 22023 Error SR353: Sorted TOP clause specifies more then 10050 rows to sort. Only 10000 are allowed. Either decrease the offset and/or row count or use a scrollable cursor

SPARQL query:
#output-format:application/sparql-results+json
SELECT ?w ?c WHERE { ?w cdm:resource_legal_id_celex ?c } ORDER BY ?c LIMIT 100 OFFSET 9950`;

const TIMEOUT_BODY =
  'Virtuoso 42000 Error SP031: SPARQL compiler: Estimated query execution time exceeds the limit';

const GATEWAY_PAGE =
  '<html><head><title>502 Bad Gateway</title></head><body><center><h1>502 Bad Gateway</h1></center></body></html>';

/** Stub fetch to answer every request with a JSON payload; returns the stub. */
function stubFetchJson(payload: unknown) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload),
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/**
 * Stub fetch with a JSON payload and capture the SPARQL query actually POSTed,
 * so a test can assert what the LIMIT ceiling did to the caller's query text.
 */
function stubFetchCapturing(payload: unknown): { sentQuery: () => string } {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      calls.push(new URLSearchParams(init.body).get('query') ?? '');
      return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
    }),
  );
  return { sentQuery: () => calls[0] ?? '' };
}

/** A SPARQL-results envelope with `n` throwaway rows. */
function rowsPayload(n: number): unknown {
  return {
    head: { vars: ['work'] },
    results: {
      bindings: Array.from({ length: n }, (_, i) => ({
        work: { type: 'uri', value: `http://work/${i}` },
      })),
    },
  };
}

// --- #20: CELLAR serializes xsd:boolean as the lexical "1"/"0", not "true"/"false" ---

describe('CellarSparqlService.parseBoolean', () => {
  it.each([
    ['1', true],
    ['true', true],
    ['0', false],
    ['false', false],
  ] as const)('parses %s → %s', (lexical, expected) => {
    expect(CellarSparqlService.parseBoolean(lexical)).toBe(expected);
  });

  it('returns undefined for absent or unrecognized values (never a false-negative)', () => {
    expect(CellarSparqlService.parseBoolean(undefined)).toBeUndefined();
    expect(CellarSparqlService.parseBoolean('yes')).toBeUndefined();
    expect(CellarSparqlService.parseBoolean('')).toBeUndefined();
  });
});

describe('CellarSparqlService.bindingValue', () => {
  it('extracts a value or returns undefined', () => {
    const binding = { celex: { type: 'literal', value: '32016R0679' } };
    expect(CellarSparqlService.bindingValue(binding, 'celex')).toBe('32016R0679');
    expect(CellarSparqlService.bindingValue(binding, 'missing')).toBeUndefined();
    expect(CellarSparqlService.bindingValue(undefined, 'celex')).toBeUndefined();
  });
});

// --- #23: head.vars carries the projection independent of binding count ---

describe('CellarSparqlService.queryWithVars', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns the projected SELECT variables when the result set is empty', async () => {
    stubFetchJson({ head: { vars: ['work', 'celex'] }, results: { bindings: [] } });
    const ctx = createMockContext();

    const result = await makeService().queryWithVars(
      'SELECT ?work ?celex WHERE { ?work cdm:resource_legal_id_celex ?celex . FILTER(STR(?celex) = "X") }',
      ctx,
    );

    expect(result.bindings).toHaveLength(0);
    expect(result.variables).toEqual(['work', 'celex']);
  });

  it('returns variables and bindings together when rows match', async () => {
    stubFetchJson({
      head: { vars: ['work', 'celex'] },
      results: {
        bindings: [
          {
            work: { type: 'uri', value: 'http://publications.europa.eu/resource/cellar/gdpr' },
            celex: { type: 'literal', value: '32016R0679' },
          },
        ],
      },
    });
    const ctx = createMockContext();

    const result = await makeService().queryWithVars('SELECT ?work ?celex WHERE { ?s ?p ?o }', ctx);

    expect(result.variables).toEqual(['work', 'celex']);
    expect(result.bindings).toHaveLength(1);
    expect(CellarSparqlService.bindingValue(result.bindings[0], 'celex')).toBe('32016R0679');
  });

  it('query() returns just the binding rows', async () => {
    stubFetchJson({
      head: { vars: ['work'] },
      results: { bindings: [{ work: { type: 'uri', value: 'http://x' } }] },
    });
    const ctx = createMockContext();

    const bindings = await makeService().query('SELECT ?work WHERE { ?s ?p ?o }', ctx);
    expect(bindings).toHaveLength(1);
  });
});

// --- #52: whether the maxResults ceiling fired must be observable ---
//
// Row count alone cannot disclose truncation: a caller's own `LIMIT 100` that
// genuinely matched 100 rows is indistinguishable from a `LIMIT 500` the server
// clamped to 100. queryWithVars reports the enforcement decision so callers can
// tell the two apart.

describe('CellarSparqlService.queryWithVars limitEnforced (#52)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reports limitEnforced when the query carries no LIMIT and the ceiling appends one', async () => {
    const { sentQuery } = stubFetchCapturing(rowsPayload(100));
    const ctx = createMockContext();

    const result = await makeService().queryWithVars(
      'SELECT ?work WHERE { ?work cdm:resource_legal_id_celex ?celex . }',
      ctx,
    );

    expect(result.limitEnforced).toBe(true);
    expect(sentQuery()).toContain('LIMIT 100');
  });

  it('reports limitEnforced when a LIMIT above the ceiling is rewritten down', async () => {
    const { sentQuery } = stubFetchCapturing(rowsPayload(100));
    const ctx = createMockContext();

    const result = await makeService().queryWithVars(
      'SELECT ?work WHERE { ?work cdm:resource_legal_id_celex ?celex . } LIMIT 500',
      ctx,
    );

    expect(result.limitEnforced).toBe(true);
    // The caller's 500 is gone; the ceiling is what reaches CELLAR.
    expect(sentQuery()).toContain('LIMIT 100');
    expect(sentQuery()).not.toContain('LIMIT 500');
  });

  it('does not report limitEnforced when the caller LIMIT is exactly the ceiling', async () => {
    // The ambiguous case: 100 rows come back, but the caller's own LIMIT bound
    // them — nothing was truncated, so this must not read as capped.
    const { sentQuery } = stubFetchCapturing(rowsPayload(100));
    const ctx = createMockContext();

    const result = await makeService().queryWithVars(
      'SELECT ?work WHERE { ?work cdm:resource_legal_id_celex ?celex . } LIMIT 100',
      ctx,
    );

    expect(result.limitEnforced).toBe(false);
    expect(result.bindings).toHaveLength(100);
    expect(sentQuery()).toContain('LIMIT 100');
  });

  it('does not report limitEnforced when the caller LIMIT is under the ceiling', async () => {
    const { sentQuery } = stubFetchCapturing(rowsPayload(10));
    const ctx = createMockContext();

    const result = await makeService().queryWithVars(
      'SELECT ?work WHERE { ?work cdm:resource_legal_id_celex ?celex . } LIMIT 10',
      ctx,
    );

    expect(result.limitEnforced).toBe(false);
    // The caller's own LIMIT is left untouched.
    expect(sentQuery()).toContain('LIMIT 10');
  });

  it('reports limitEnforced even when the enforced ceiling is not filled', async () => {
    // Enforcement fired (a LIMIT was appended) but only 76 rows matched — the flag
    // tracks the rewrite, not the row count. Callers pair the two themselves.
    stubFetchCapturing(rowsPayload(76));
    const ctx = createMockContext();

    const result = await makeService().queryWithVars(
      'SELECT ?work WHERE { ?work cdm:work_date_document "2016-04-27"^^xsd:date . }',
      ctx,
    );

    expect(result.limitEnforced).toBe(true);
    expect(result.bindings).toHaveLength(76);
  });

  it('query() still returns bare bindings while execute() tracks enforcement', async () => {
    stubFetchCapturing(rowsPayload(3));
    const ctx = createMockContext();

    const bindings = await makeService().query('SELECT ?work WHERE { ?s ?p ?o }', ctx);
    expect(bindings).toHaveLength(3);
  });
});

// --- #72: trusted paged tools may fetch one private sentinel row without
// widening the raw-SPARQL ceiling exposed through queryWithVars. ---

describe('CellarSparqlService.queryWithContinuation (#72)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('permits exactly maxResults + 1 on the trusted internal path', async () => {
    const { sentQuery } = stubFetchCapturing(rowsPayload(101));
    const ctx = createMockContext();

    const bindings = await makeService().queryWithContinuation(
      'SELECT ?work WHERE { ?work cdm:resource_legal_id_celex ?celex . } LIMIT 101',
      ctx,
    );

    expect(bindings).toHaveLength(101);
    expect(sentQuery()).toContain('LIMIT 101');
  });

  it('does not let the trusted allowance exceed one sentinel row', async () => {
    const { sentQuery } = stubFetchCapturing(rowsPayload(101));
    const ctx = createMockContext();

    await makeService().queryWithContinuation(
      'SELECT ?work WHERE { ?work cdm:resource_legal_id_celex ?celex . } LIMIT 500',
      ctx,
    );

    expect(sentQuery()).toContain('LIMIT 101');
    expect(sentQuery()).not.toContain('LIMIT 500');
  });
});

// --- #63: the maxResults ceiling must bound the OUTER result the caller receives,
// regardless of subselect structure, and must never rewrite the caller's own inner
// LIMIT. Enforcement (raw path) targets the OUTERMOST (brace-depth 0) LIMIT.

describe('CellarSparqlService #63 outer-LIMIT enforcement', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('appends an outer LIMIT when the only LIMIT sits inside a subselect (raw path)', async () => {
    const { sentQuery } = stubFetchCapturing(rowsPayload(100));
    const ctx = createMockContext();

    const result = await makeService().queryWithVars(
      'SELECT ?work ?celex WHERE {\n  { SELECT ?work WHERE { ?work cdm:work_date_document ?d . } LIMIT 500 }\n  ?work cdm:resource_legal_id_celex ?celex .\n}',
      ctx,
    );

    // The caller's inner LIMIT 500 is preserved verbatim (not clamped to 100)...
    expect(sentQuery()).toContain('LIMIT 500');
    // ...and an outer LIMIT bounds the result the caller actually receives.
    expect(sentQuery().trimEnd().endsWith('LIMIT 100')).toBe(true);
    expect(result.limitEnforced).toBe(true);
  });

  it('rewrites the OUTERMOST LIMIT and leaves a subselect LIMIT untouched (raw path)', async () => {
    const { sentQuery } = stubFetchCapturing(rowsPayload(100));
    const ctx = createMockContext();

    await makeService().queryWithVars(
      'SELECT ?work WHERE {\n  { SELECT ?work WHERE { ?work cdm:work_date_document ?d . } LIMIT 500 }\n  ?work cdm:resource_legal_id_celex ?celex .\n} LIMIT 200',
      ctx,
    );

    // The inner subselect LIMIT is the caller's own paging — never rewritten.
    expect(sentQuery()).toContain('LIMIT 500');
    // The outer LIMIT 200 (above the ceiling) is the one clamped to 100.
    expect(sentQuery()).not.toContain('LIMIT 200');
    expect(sentQuery().trimEnd().endsWith('LIMIT 100')).toBe(true);
  });

  it('appends the outer LIMIT after a top-level ORDER BY so ordering is preserved (raw path)', async () => {
    const { sentQuery } = stubFetchCapturing(rowsPayload(100));
    const ctx = createMockContext();

    await makeService().queryWithVars(
      'SELECT ?work ?d WHERE {\n  { SELECT ?work WHERE { ?work cdm:work_date_document ?d2 . } LIMIT 500 }\n  ?work cdm:work_date_document ?d .\n} ORDER BY DESC(?d)',
      ctx,
    );

    const q = sentQuery();
    expect(q).toContain('LIMIT 500'); // inner subselect preserved
    expect(q.trimEnd().endsWith('LIMIT 100')).toBe(true); // cap appended
    // The cap lands AFTER the ORDER BY, so it's a top-N, not an arbitrary slice.
    expect(q.indexOf('LIMIT 100')).toBeGreaterThan(q.indexOf('ORDER BY'));
  });

  it('does not read a "#" inside a full IRI as a comment hiding the top-level LIMIT (raw path)', async () => {
    const { sentQuery } = stubFetchCapturing(rowsPayload(100));
    const ctx = createMockContext();

    // The "#" in the cdm IRI must not swallow the trailing "} LIMIT 500" as a line
    // comment; the outermost LIMIT is found and clamped in place, not missed (which
    // would wrongly append a second LIMIT and leave 500 standing).
    await makeService().queryWithVars(
      'SELECT ?s WHERE { ?s <http://publications.europa.eu/ontology/cdm#work_date_document> ?o } LIMIT 500',
      ctx,
    );

    expect(sentQuery()).not.toContain('LIMIT 500');
    expect(sentQuery()).toContain('LIMIT 100');
  });

  it('does not read a "}" inside a string literal as closing the WHERE block (raw path)', async () => {
    const { sentQuery } = stubFetchCapturing(rowsPayload(100));
    const ctx = createMockContext();

    // The "}" inside the literal must not drop brace depth early; the top-level
    // LIMIT 500 stays at depth 0 and is clamped in place.
    await makeService().queryWithVars('SELECT ?s WHERE { ?s rdfs:label "a } b" } LIMIT 500', ctx);

    expect(sentQuery()).not.toContain('LIMIT 500');
    expect(sentQuery()).toContain('LIMIT 100');
  });

  it('leaves a UNION-of-subselects untouched on the internal path (no outer LIMIT appended)', async () => {
    const { sentQuery } = stubFetchCapturing(rowsPayload(50));
    const ctx = createMockContext();

    // The symmetric relation traversal deliberately sums two per-arm subselect
    // LIMITs past the ceiling; the internal `query` path must not append an outer
    // LIMIT that would truncate the merged two-direction result.
    const unionQuery =
      'SELECT ?r ?dir WHERE {\n  { SELECT ?r ?dir WHERE { <urn:w> cdm:work_cites_work ?r . BIND("out" AS ?dir) } LIMIT 100 }\n  UNION\n  { SELECT ?r ?dir WHERE { ?r cdm:work_cites_work <urn:w> . BIND("in" AS ?dir) } LIMIT 100 }\n}';
    await makeService().query(unionQuery, ctx);

    // No outer LIMIT was appended — the query still ends at the WHERE block's brace.
    expect(sentQuery().trimEnd().endsWith('}')).toBe(true);
    // Both per-arm LIMITs survive intact.
    expect(sentQuery().match(/LIMIT 100/g)).toHaveLength(2);
  });
});

// --- #26: typed sparql_error / sparql_timeout throws; the calling tool's contract
// recovery reaches the wire (#145) ---

describe('CellarSparqlService typed failures (#26)', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetchRaw(opts: { ok: boolean; status: number; body: string }): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (new URL(url).hostname !== 'cellar.test') throw new Error(`unmocked fetch: ${url}`);
        return { ok: opts.ok, status: opts.status, text: async () => opts.body };
      }),
    );
  }

  /*
   * A query that runs out of time is reported retryable (#177): whether it finishes
   * turns on CELLAR's response time, so a later call can. The service still sends it
   * once: re-running it inside the call would spend the same budget again (#78).
   */
  it('fails fast on a client-side timeout: one attempt, typed reason, no hint of its own (#78, #145)', async () => {
    const fetchMock = vi.fn(async () => {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    });
    vi.stubGlobal('fetch', fetchMock);
    const ctx = createMockContext();

    // A 1,000 ms per-query timeout under the 5,000 ms budget: the timeout, not the budget, ends it.
    const error = (await makeService()
      .query('SELECT ?work WHERE { ?s ?p ?o }', ctx, 1_000)
      .catch((e: unknown) => e)) as { data?: Record<string, unknown> };

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: 'CELLAR SPARQL request exceeded the 1000 ms client timeout',
      data: { reason: 'sparql_timeout', retryable: true },
    });
    // The calling tool's sparql_timeout recovery fills the hint on the wire.
    expect(error?.data).not.toHaveProperty('recovery');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails fast when the client timeout fires while the body is still arriving (#78)', async () => {
    // Headers arrive, then the body stalls until the request signal aborts — as a
    // real fetch rejects response.text() with the signal's TimeoutError.
    const fetchMock = vi.fn(async (_url: string, init: { signal: AbortSignal }) => ({
      ok: true,
      status: 200,
      text: () =>
        new Promise<string>((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason));
        }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      makeService().query('SELECT ?work WHERE { ?s ?p ?o }', createMockContext(), 30),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'sparql_timeout', retryable: true },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('marks a Virtuoso-side timeout non-retryable as sparql_timeout (#78)', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        'Virtuoso 42000 Error SP031: SPARQL compiler: Estimated query execution time exceeds the limit',
    }));
    vi.stubGlobal('fetch', fetchMock);
    const ctx = createMockContext();

    await expect(makeService().query('SELECT ?work WHERE { ?s ?p ?o }', ctx)).rejects.toMatchObject(
      {
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'sparql_timeout', retryable: false },
      },
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails an HTTP 400 malformed-query error as sparql_error', async () => {
    stubFetchRaw({
      ok: false,
      status: 400,
      body: "Virtuoso 37000 Error SP030: SPARQL compiler, line 5: syntax error at 'WHERE'",
    });
    const ctx = createMockContext();

    await expect(makeService().query('SELECT WHERE { ?s ?p ?o }', ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'sparql_error', retryable: false },
    });
  });

  it('fails a Virtuoso HTTP-200 error body as sparql_error', async () => {
    // Virtuoso can return HTTP 200 for an error — the body carries it.
    stubFetchRaw({
      ok: true,
      status: 200,
      body: "Virtuoso 37000 Error SP030: SPARQL compiler, line 5: syntax error at 'WHERE' before '{'",
    });
    const ctx = createMockContext();

    await expect(makeService().query('SELECT WHERE { ?s ?p ?o }', ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'sparql_error', retryable: false },
    });
  });

  it('reads an HTTP-200 results body whose literal quotes a Virtuoso error as rows', async () => {
    // A real result can quote error text — a title, a comment, a raw query's own
    // literal — and the parsed results are the answer, not a failure.
    const literal = 'CELLAR answered: Virtuoso 37000 Error SP030: syntax error at "WHERE"';
    stubFetchRaw({
      ok: true,
      status: 200,
      body: JSON.stringify({
        head: { vars: ['note'] },
        results: { bindings: [{ note: { type: 'literal', value: literal } }] },
      }),
    });

    const rows = await makeService().query(
      'SELECT ?note WHERE { ?s ?p ?note }',
      createMockContext(),
    );

    expect(rows).toEqual([{ note: { type: 'literal', value: literal } }]);
  });

  it('reads an HTTP-200 results body quoting a Virtuoso timeout as rows, on the raw path too', async () => {
    const literal = 'Virtuoso 42000 Error SP031: query execution timed out';
    stubFetchRaw({
      ok: true,
      status: 200,
      body: JSON.stringify({
        head: { vars: ['note'] },
        results: { bindings: [{ note: { type: 'literal', value: literal } }] },
      }),
    });

    const { variables, bindings } = await makeService().queryWithVars(
      'SELECT ?note WHERE { ?s ?p ?note } LIMIT 1',
      createMockContext(),
    );

    expect(variables).toEqual(['note']);
    expect(bindings).toEqual([{ note: { type: 'literal', value: literal } }]);
  });

  describe('through eurlex_query_sparql on the wire', () => {
    beforeEach(() => {
      initCellarSparqlService({} as AppConfig, {} as StorageService, TEST_SERVER_CONFIG);
    });

    /** The `error` envelope of one eurlex_query_sparql call. */
    async function wireError(): Promise<{
      code?: number;
      data?: { reason?: string; recovery?: { hint?: string } };
    }> {
      const result = await runToolContract(eurlex_query_sparql, {
        sparql_query: 'SELECT ?s WHERE { ?s ?p ?o } LIMIT 1',
      });
      expect(result.isError).toBe(true);
      return (result.structuredContent as { error: Record<string, never> }).error;
    }

    it.each([
      ['an HTTP 400 syntax error', 400, "Virtuoso 37000 Error SP030: syntax error at '}'"],
      ['an HTTP 500 compile error', 500, SQ156_BODY],
    ])('carries the tool’s sparql_error recovery for %s', async (_label, status, body) => {
      stubFetchRaw({ ok: false, status, body });

      const error = await wireError();

      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: {
          reason: 'sparql_error',
          recovery: {
            hint: 'Fix the SPARQL query syntax, ensure predicates use the cdm: prefix, and verify variable names.',
          },
        },
      });
    });

    it('carries the sort-window recovery, not the syntax one, for an HTTP 500 SR353', async () => {
      stubFetchRaw({ ok: false, status: 500, body: SR353_BODY });

      const error = await wireError();

      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'sparql_error' },
      });
      expect(error.data?.recovery?.hint).toContain('lower OFFSET so OFFSET + LIMIT stays within');
      expect(error.data?.recovery?.hint).not.toContain('syntax');
    });

    /*
     * The service's 5,000 ms timeout is below the most timeout_hint accepts, so the tool
     * adds a higher timeout_hint to its contract recovery (#177).
     */
    const TIMEOUT_RECOVERY = `${eurlex_query_sparql.errors?.find((e) => e.reason === 'sparql_timeout')?.recovery} Raising timeout_hint above the 5000 ms in effect, up to 55000, gives a query that ran past its timeout longer.`;

    it('carries the tool’s sparql_timeout recovery for a Virtuoso timeout, not retryable', async () => {
      stubFetchRaw({ ok: true, status: 200, body: TIMEOUT_BODY });

      const error = await wireError();

      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'sparql_timeout', retryable: false, recovery: { hint: TIMEOUT_RECOVERY } },
      });
    });

    it('reports a query that ran out of time as retryable, in both channels (#177)', async () => {
      const fetchMock = vi.fn(async () => {
        throw new DOMException('The operation timed out.', 'TimeoutError');
      });
      vi.stubGlobal('fetch', fetchMock);

      const result = await runToolContract(eurlex_query_sparql, {
        sparql_query: 'SELECT ?s WHERE { ?s ?p ?o } LIMIT 1',
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const { data } = (result.structuredContent as { error: { data: Record<string, unknown> } })
        .error;
      expect(data).toMatchObject({
        reason: 'sparql_timeout',
        retryable: true,
        recovery: { hint: TIMEOUT_RECOVERY },
      });
      const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
      expect(text).toContain(`Recovery: ${TIMEOUT_RECOVERY}`);
      expect(text.trimEnd().endsWith('(reason sparql_timeout · retryable)')).toBe(true);
    });
  });
});

// --- #145: a non-200/400 body is read and classified by its Virtuoso SQLSTATE ---
//
// CELLAR answers deterministic compile (SQ156, SQLSTATE 37000) and sort-window
// (SR353, 22023) errors with HTTP 500. Those fail on the first attempt with the
// Virtuoso text; a gateway page, an empty body, or another SQLSTATE stays a
// retryable outage.

describe('CellarSparqlService non-200 bodies (#145)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** A fetch answering every attempt with `status` and `body`, routed to the CELLAR host only. */
  function stubStatus(status: number, body: string): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async (url: string) => {
      if (new URL(url).hostname !== 'cellar.test') throw new Error(`unmocked fetch: ${url}`);
      return { ok: status >= 200 && status < 300, status, text: async () => body };
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  /**
   * The rejection of one query, with the retry backoff fast-forwarded. The
   * default budget fits the whole ladder (four attempts, about 10.5 s of backoff).
   */
  async function rejectionOfQuery(sparqlQueryTimeoutMs = 60_000): Promise<{
    code?: number;
    message: string;
    data?: Record<string, unknown>;
  }> {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = makeService({ sparqlQueryTimeoutMs })
      .query('SELECT ?work WHERE { ?s ?p ?o } LIMIT 1', createMockContext())
      .then(
        () => {
          throw new Error('Expected the query to reject');
        },
        (error: unknown) =>
          error as { code?: number; message: string; data?: Record<string, unknown> },
      );
    await vi.runAllTimersAsync();
    return pending;
  }

  it.each([
    ['an HTML gateway page on 502', 502, GATEWAY_PAGE],
    ['an empty body on 503', 503, ''],
    [
      'a Virtuoso body of another SQLSTATE on 500',
      500,
      'Virtuoso 40001 Error SR172: Transaction deadlocked',
    ],
  ])('retries %s as a transient outage carrying the status', async (_label, status, body) => {
    const fetchMock = stubStatus(status, body);

    const error = await rejectionOfQuery();

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.message).toContain(`CELLAR SPARQL HTTP ${status}`);
    expect(error.data?.reason).toBeUndefined();
  });

  it('stops retrying an outage once the next backoff would outlast the budget, reporting the outage', async () => {
    const fetchMock = stubStatus(502, GATEWAY_PAGE);

    // A 2 s budget fits the first backoff (at most 1.875 s) but not the second (at least 2.25 s).
    const error = await rejectionOfQuery(2_000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.message).toContain('CELLAR SPARQL HTTP 502');
  });

  it.each([
    ['SQ156 compile error', SQ156_BODY, 'SQ156'],
    ['SR353 sort-window error', SR353_BODY, 'SR353'],
  ])('fails a 500 %s on the first attempt as sparql_error', async (_label, body, code) => {
    const fetchMock = stubStatus(500, body);

    const error = await rejectionOfQuery();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({ reason: 'sparql_error', retryable: false });
    expect(error.message).toContain(code);
    // The Virtuoso text is cut at 300 characters, so the echoed query stays short.
    expect(error.message).toBe(`CELLAR SPARQL error: ${body.slice(0, 300)}`);
  });

  it('fails a 500 timeout body on the first attempt as sparql_timeout', async () => {
    const fetchMock = stubStatus(500, TIMEOUT_BODY);

    const error = await rejectionOfQuery();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({ reason: 'sparql_timeout', retryable: false });
  });

  it.each([
    [500, SR353_BODY],
    [200, SR353_BODY],
  ])('gives an HTTP %i SR353 sort-window error its own recovery hint', async (status, body) => {
    stubStatus(status, body);

    const error = await rejectionOfQuery();

    expect(error.data).toMatchObject({
      reason: 'sparql_error',
      recovery: {
        hint: 'CELLAR sorts at most 10,000 rows: lower OFFSET so OFFSET + LIMIT stays within 10,000, or narrow the query with a FILTER so fewer rows match.',
      },
    });
  });

  it('leaves the recovery hint to the calling tool on every other typed throw', async () => {
    for (const [status, body] of [
      [400, "Virtuoso 37000 Error SP030: SPARQL compiler, line 2: syntax error at '}'"],
      [200, "Virtuoso 37000 Error SP030: SPARQL compiler, line 2: syntax error at '}'"],
      [200, TIMEOUT_BODY],
      [500, SQ156_BODY],
      [500, TIMEOUT_BODY],
    ] as const) {
      stubStatus(status, body);
      const error = await rejectionOfQuery();
      expect(error.data?.reason).toMatch(/^sparql_(error|timeout)$/);
      expect(error.data).not.toHaveProperty('recovery');
    }
  });
});

// --- #122: a caller's cancellation reaches the request in flight ---

describe('CellarSparqlService caller cancellation (#122)', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** A fetch that answers after `ms` unless the request's signal aborts first, as a real fetch does. */
  function stubSlowFetch(ms: number): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((resolve, reject) => {
          if (init.signal.aborted) {
            reject(init.signal.reason);
            return;
          }
          const timer = setTimeout(
            () =>
              resolve({ ok: true, status: 200, text: async () => JSON.stringify(rowsPayload(1)) }),
            ms,
          );
          init.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(init.signal.reason);
          });
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('rejects a request the caller cancels mid-flight instead of returning its rows', async () => {
    const fetchMock = stubSlowFetch(200);
    const controller = new AbortController();
    const ctx = createMockContext({ signal: controller.signal });

    const pending = makeService().query('SELECT ?work WHERE { ?s ?p ?o } LIMIT 1', ctx);
    setTimeout(() => controller.abort(), 20);

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('hands fetch an already-aborted signal for a caller that has already cancelled, and rejects', async () => {
    const fetchMock = stubSlowFetch(200);
    const controller = new AbortController();
    controller.abort();

    await expect(
      makeService().query(
        'SELECT ?work WHERE { ?s ?p ?o } LIMIT 1',
        createMockContext({ signal: controller.signal }),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    // One attempt, no retry; a real fetch given an aborted signal rejects without sending.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as { signal: AbortSignal };
    expect(init.signal.aborted).toBe(true);
  });

  it('propagates a caller signal aborted with a TimeoutError as itself, not as sparql_timeout', async () => {
    stubSlowFetch(4_000);
    // The caller's own deadline, well inside the service's 5 s client timeout.
    const ctx = createMockContext({ signal: AbortSignal.timeout(10) });

    const rejection = await makeService()
      .query('SELECT ?work WHERE { ?s ?p ?o } LIMIT 1', ctx)
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(rejection).toMatchObject({ name: 'TimeoutError' });
    expect(rejection).not.toHaveProperty('code', JsonRpcErrorCode.ServiceUnavailable);
    expect((rejection as { data?: { reason?: string } }).data?.reason).not.toBe('sparql_timeout');
  });

  it('still reports its own client timeout as sparql_timeout, not as a cancellation', async () => {
    const fetchMock = stubSlowFetch(5_000);
    const ctx = createMockContext();

    await expect(
      makeService().query('SELECT ?work WHERE { ?s ?p ?o } LIMIT 1', ctx, 30),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'sparql_timeout', retryable: true },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// --- One SPARQL budget per call: chained queries share sparqlQueryTimeoutMs ---

describe('CellarSparqlService per-call deadline', () => {
  const QUERY = 'SELECT ?work WHERE { ?s ?p ?o } LIMIT 1';
  const START = new Date('2026-10-24T12:00:00Z').getTime();
  const BUDGET_SPENT = {
    code: JsonRpcErrorCode.ServiceUnavailable,
    message: 'CELLAR SPARQL queries for this request ran past the time budget they share',
    data: { reason: 'sparql_timeout', retryable: true },
  };

  // Only the clock is faked, so moving it ages the call's first query; the budget is 5,000 ms.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Move the clock `ms` past the first query's start. */
  const elapse = (ms: number) => vi.setSystemTime(START + ms);

  it('fails a later query of the same call without sending it once the budget is spent', async () => {
    const fetchMock = stubFetchJson(rowsPayload(1));
    const service = makeService();
    const ctx = createMockContext();

    await service.query(QUERY, ctx);
    elapse(5_000);

    await expect(service.query(QUERY, ctx)).rejects.toMatchObject(BUDGET_SPENT);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('bounds a later query of the same call by what is left of the budget', async () => {
    const fetchMock = vi.fn(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((resolve, reject) => {
          // The first query answers at once; the second never answers on its own.
          if (fetchMock.mock.calls.length === 1) {
            resolve({ ok: true, status: 200, text: async () => JSON.stringify(rowsPayload(1)) });
            return;
          }
          init.signal.addEventListener('abort', () => reject(init.signal.reason));
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const service = makeService();
    const ctx = createMockContext();

    await service.query(QUERY, ctx);
    // 4,980 ms of the budget are gone: the next query gets the last 20 ms.
    elapse(4_980);

    await expect(service.query(QUERY, ctx)).rejects.toMatchObject(BUDGET_SPENT);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('sizes the budget to an explicit per-query timeout above the configured one', async () => {
    stubFetchJson(rowsPayload(1));
    const service = makeService();
    const ctx = createMockContext();

    // eurlex_query_sparql's timeout_hint can exceed a lowered SPARQL_QUERY_TIMEOUT_MS.
    await service.query(QUERY, ctx, 8_000);
    elapse(6_000);

    await expect(service.query(QUERY, ctx, 8_000)).resolves.toHaveLength(1);
  });

  it('gives each call its own budget', async () => {
    stubFetchJson(rowsPayload(1));
    const service = makeService();

    await service.query(QUERY, createMockContext());
    elapse(5_000);

    await expect(service.query(QUERY, createMockContext())).resolves.toHaveLength(1);
  });
});

// --- #193: a lookup whose first request stalls is aborted at 20 s and re-sent once ---

describe('CellarSparqlService stalled lookup re-send (#193)', () => {
  const QUERY = 'SELECT ?work WHERE { ?s ?p ?o } LIMIT 1';
  const START = new Date('2026-11-09T12:00:00Z').getTime();
  const BUDGET_SPENT = {
    code: JsonRpcErrorCode.ServiceUnavailable,
    message: 'CELLAR SPARQL queries for this request ran past the time budget they share',
    data: { reason: 'sparql_timeout', retryable: true },
  };

  /*
   * The stall timer, the retry backoff, and the call's deadline all run on the faked
   * clock. Jitter is pinned, so the ladder's first backoff is exactly 1,500 ms and
   * its second 3,000 ms.
   */
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(START);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /** Advance the faked clock to `ms` past the call's start. */
  const clockAt = (ms: number) => vi.advanceTimersByTimeAsync(START + ms - Date.now());

  /**
   * How CELLAR answers each request, in order: `stall` never answers, `stall-body`
   * sends headers and never the body, `rows` answers at once with one row, `502` a
   * gateway page, and `{ rowsAfterMs }` one row after that long. A request past the
   * plan stalls. An unanswered request rejects with its signal's reason when that
   * signal aborts, as a real fetch does.
   */
  type Answer = 'stall' | 'stall-body' | 'rows' | 502 | { rowsAfterMs: number };

  function stubCellar(plan: readonly Answer[]) {
    const untilAborted = (signal: AbortSignal) =>
      new Promise<never>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    const rows = { ok: true, status: 200, text: async () => JSON.stringify(rowsPayload(1)) };
    let sent = 0;
    const fetchMock = vi.fn(async (_url: string, init: { signal: AbortSignal }) => {
      const answer = plan[sent++] ?? 'stall';
      if (answer === 'rows') return rows;
      if (answer === 502) return { ok: false, status: 502, text: async () => GATEWAY_PAGE };
      if (answer === 'stall-body') {
        return { ok: true, status: 200, text: () => untilAborted(init.signal) };
      }
      if (answer === 'stall') return untilAborted(init.signal);
      return Promise.race([
        new Promise((resolve) => setTimeout(() => resolve(rows), answer.rowsAfterMs)),
        untilAborted(init.signal),
      ]);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  /** The signal request `n` (1-based) was sent with. */
  function signalOf(fetchMock: ReturnType<typeof stubCellar>, n: number): AbortSignal {
    const init = fetchMock.mock.calls[n - 1]?.[1];
    if (!init) throw new Error(`Request ${n} was never sent`);
    return init.signal;
  }

  /** `pending`'s outcome, readable while the faked clock is still being advanced. */
  function track(pending: Promise<unknown>) {
    const outcome: { settled: boolean; value?: unknown; error?: unknown } = { settled: false };
    pending.then(
      (value) => Object.assign(outcome, { settled: true, value }),
      (error: unknown) => Object.assign(outcome, { settled: true, error }),
    );
    return outcome;
  }

  /** A service at the default 55 s budget, or the one given. */
  const service = (sparqlQueryTimeoutMs = 55_000) => makeService({ sparqlQueryTimeoutMs });

  it.each([
    ['before its headers', 'stall'],
    ['partway through its body', 'stall-body'],
  ] as const)(
    'aborts a first request still silent %s at 20 s and resolves with the re-send’s rows',
    async (_label, first) => {
      const fetchMock = stubCellar([first, 'rows']);
      const ctx = createMockContext();
      const outcome = track(service().query(QUERY, ctx));

      await clockAt(19_999);
      expect(signalOf(fetchMock, 1).aborted).toBe(false);
      expect((ctx.log as MockContextLogger).calls).toEqual([]);

      await clockAt(20_000);
      expect(signalOf(fetchMock, 1).aborted).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect((ctx.log as MockContextLogger).calls).toEqual([
        {
          level: 'warning',
          msg: 'CELLAR SPARQL request stalled with no complete response; aborted to send it again',
          data: { stalledMs: 20_000 },
        },
      ]);

      // The re-send goes out after the ladder's first backoff, never alongside the first request.
      await clockAt(21_499);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await clockAt(21_500);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(outcome).toEqual({
        settled: true,
        value: [{ work: { type: 'uri', value: 'http://work/0' } }],
      });
    },
  );

  it('fails as the budget’s sparql_timeout after exactly two requests when the re-send stalls too', async () => {
    const fetchMock = stubCellar(['stall', 'stall']);
    const pending = service().query(QUERY, createMockContext());
    const outcome = track(pending);

    await clockAt(54_999);
    expect(outcome.settled).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The re-send is not itself cut at 20 s: it has the rest of the budget.
    expect(signalOf(fetchMock, 2).aborted).toBe(false);

    await clockAt(55_000);
    expect(outcome.settled).toBe(true);
    await expect(pending).rejects.toMatchObject(BUDGET_SPENT);
    expect(signalOf(fetchMock, 2).aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports the budget’s sparql_timeout when too little is left for the backoff after a stall', async () => {
    const fetchMock = stubCellar(['stall']);
    // 1,000 ms are left at the stall, under the 1,500 ms backoff: the ladder stops before sleeping.
    const pending = service(21_000).query(QUERY, createMockContext());
    const outcome = track(pending);

    await clockAt(19_999);
    expect(outcome.settled).toBe(false);

    await clockAt(20_000);
    expect(signalOf(fetchMock, 1).aborted).toBe(true);
    expect(outcome.settled).toBe(true);
    // Never the ladder's own retry_deadline_exceeded, nor the stall itself.
    await expect(pending).rejects.toMatchObject(BUDGET_SPENT);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports the budget’s sparql_timeout when the budget ends during the backoff after a stall', async () => {
    const fetchMock = stubCellar(['stall']);
    // The deadline lands on the backoff's last instant, and its clock fires first.
    const pending = service(21_500).query(QUERY, createMockContext());
    const outcome = track(pending);

    await clockAt(20_000);
    expect(signalOf(fetchMock, 1).aborted).toBe(true);
    await clockAt(21_499);
    expect(outcome.settled).toBe(false);

    await clockAt(21_500);
    expect(outcome.settled).toBe(true);
    await expect(pending).rejects.toMatchObject(BUDGET_SPENT);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps retrying an outage the re-send meets, on the ladder’s own backoff', async () => {
    const fetchMock = stubCellar(['stall', 502, 'rows']);
    const pending = service().query(QUERY, createMockContext());
    const outcome = track(pending);

    await clockAt(21_500);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await clockAt(24_499);
    expect(outcome.settled).toBe(false);

    await clockAt(24_500);
    expect(outcome.settled).toBe(true);
    await expect(pending).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('re-sends only a first request: one that follows an outage keeps the rest of the budget', async () => {
    const fetchMock = stubCellar([502, 'stall']);
    const pending = service().query(QUERY, createMockContext());
    const outcome = track(pending);

    await clockAt(1_500);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await clockAt(54_999);
    expect(signalOf(fetchMock, 2).aborted).toBe(false);
    expect(outcome.settled).toBe(false);

    await clockAt(55_000);
    await expect(pending).rejects.toMatchObject(BUDGET_SPENT);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('sends a lookup answered at once one request, with no clock moved and no timer left', async () => {
    const fetchMock = stubCellar(['rows']);
    const ctx = createMockContext();

    await expect(service().query(QUERY, ctx)).resolves.toHaveLength(1);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(Date.now()).toBe(START);
    expect(vi.getTimerCount()).toBe(0);
    expect((ctx.log as MockContextLogger).calls).toEqual([]);
  });

  it('sends a lookup answered just under 20 s one request', async () => {
    const fetchMock = stubCellar([{ rowsAfterMs: 19_999 }]);
    const pending = service().query(QUERY, createMockContext());

    await clockAt(19_999);
    await expect(pending).resolves.toHaveLength(1);
    expect(signalOf(fetchMock, 1).aborted).toBe(false);
    await clockAt(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([20_000, 15_000])(
    'sends one request under a %i ms SPARQL_QUERY_TIMEOUT_MS',
    async (budgetMs) => {
      const fetchMock = stubCellar(['stall']);
      const pending = service(budgetMs).query(QUERY, createMockContext());
      const outcome = track(pending);

      await clockAt(budgetMs - 1);
      expect(signalOf(fetchMock, 1).aborted).toBe(false);
      expect(outcome.settled).toBe(false);

      await clockAt(budgetMs);
      await expect(pending).rejects.toMatchObject(BUDGET_SPENT);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it('sends one request for a lookup that starts with 20 s or less of the budget left', async () => {
    const fetchMock = stubCellar(['rows', 'stall']);
    const s = service();
    const ctx = createMockContext();

    await s.query(QUERY, ctx);
    await clockAt(35_000);
    const pending = s.query(QUERY, ctx);
    const outcome = track(pending);

    await clockAt(54_999);
    expect(signalOf(fetchMock, 2).aborted).toBe(false);
    expect(outcome.settled).toBe(false);

    await clockAt(55_000);
    await expect(pending).rejects.toMatchObject(BUDGET_SPENT);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('ends every later attempt of a chained call by the deadline its first query set', async () => {
    const fetchMock = stubCellar(['stall', 'rows', 'stall', 'stall']);
    const s = service();
    const ctx = createMockContext();

    const first = track(s.query(QUERY, ctx));
    await clockAt(21_500);
    expect(first.settled).toBe(true);
    expect(first.value).toHaveLength(1);

    // 33,500 ms are left, so this lookup's first request is re-sent too, at 43 s.
    const pending = s.query(QUERY, ctx);
    const outcome = track(pending);
    await clockAt(41_500);
    expect(signalOf(fetchMock, 3).aborted).toBe(true);
    await clockAt(54_999);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(signalOf(fetchMock, 4).aborted).toBe(false);
    expect(outcome.settled).toBe(false);

    await clockAt(55_000);
    expect(outcome.settled).toBe(true);
    await expect(pending).rejects.toMatchObject(BUDGET_SPENT);
    expect(signalOf(fetchMock, 4).aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it.each([
    [
      'a search or relation page',
      (s: CellarSparqlService, ctx: Context) => s.queryWithContinuation(QUERY, ctx),
    ],
    [
      'an eurlex_query_sparql query',
      (s: CellarSparqlService, ctx: Context) => s.queryWithVars(QUERY, ctx),
    ],
    [
      'an eurlex_query_sparql query at timeout_hint 55000',
      (s: CellarSparqlService, ctx: Context) => s.queryWithVars(QUERY, ctx, 55_000),
    ],
  ])('sends %s once, unanswered, and fails it at the budget as today', async (_label, run) => {
    const fetchMock = stubCellar(['stall']);
    const pending = run(service(), createMockContext());
    const outcome = track(pending);

    await clockAt(54_999);
    expect(signalOf(fetchMock, 1).aborted).toBe(false);
    expect(outcome.settled).toBe(false);

    await clockAt(55_000);
    await expect(pending).rejects.toMatchObject(BUDGET_SPENT);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['before 20 s', ['stall'], 10_000, 1],
    ['during the backoff', ['stall'], 20_500, 1],
    ['during the re-send', ['stall', 'stall'], 25_000, 2],
  ] as const)(
    'rejects with the caller’s abort %s and sends nothing after it',
    async (_label, plan, abortAtMs, requests) => {
      const fetchMock = stubCellar(plan);
      const controller = new AbortController();
      const outcome = track(
        service().query(QUERY, createMockContext({ signal: controller.signal })),
      );

      await clockAt(abortAtMs);
      expect(fetchMock).toHaveBeenCalledTimes(requests);
      expect(signalOf(fetchMock, 1).aborted).toBe(abortAtMs >= 20_000);

      controller.abort();
      await clockAt(abortAtMs);
      expect(outcome).toEqual({ settled: true, error: controller.signal.reason });

      await clockAt(60_000);
      expect(fetchMock).toHaveBeenCalledTimes(requests);
    },
  );

  it('surfaces a stall the budget cuts short as sparql_timeout in both channels of a tool', async () => {
    initCellarSparqlService({} as AppConfig, {} as StorageService, {
      ...TEST_SERVER_CONFIG,
      sparqlQueryTimeoutMs: 21_000,
    });
    const fetchMock = stubCellar(['stall']);
    const pending = runToolContract(eurlex_lookup_celex, {
      identifier: '32016R0679',
      identifier_type: 'celex',
    });
    const outcome = track(pending);

    await clockAt(20_000);
    expect(outcome.settled).toBe(true);
    const result = await pending;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    const recovery = eurlex_lookup_celex.errors?.find(
      (e) => e.reason === 'sparql_timeout',
    )?.recovery;
    expect((result.structuredContent as { error: unknown }).error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'sparql_timeout', retryable: true, recovery: { hint: recovery } },
    });
    const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(text).toContain(BUDGET_SPENT.message);
    expect(text.trimEnd().endsWith('(reason sparql_timeout · retryable)')).toBe(true);
  });
});
