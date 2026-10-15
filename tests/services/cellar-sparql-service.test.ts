/**
 * @fileoverview Tests for CellarSparqlService — the xsd:boolean parser and the
 * query methods' projection handling (head.vars survives an empty result set).
 * @module tests/services/cellar-sparql-service.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
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

function makeService(): CellarSparqlService {
  // config/storage are unused by the query path.
  return new CellarSparqlService(
    {} as unknown as AppConfig,
    {} as unknown as StorageService,
    TEST_SERVER_CONFIG,
  );
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

function stubFetchJson(payload: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(payload),
    })),
  );
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

  it('fails fast on a client-side timeout: one attempt, typed reason, no hint of its own (#78, #145)', async () => {
    const fetchMock = vi.fn(async () => {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    });
    vi.stubGlobal('fetch', fetchMock);
    const ctx = createMockContext();

    const error = (await makeService()
      .query('SELECT ?work WHERE { ?s ?p ?o }', ctx, 1_000)
      .catch((e: unknown) => e)) as { data?: Record<string, unknown> };

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'sparql_timeout', retryable: false },
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
      data: { reason: 'sparql_timeout', retryable: false },
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

    it('carries the tool’s sparql_timeout recovery for a Virtuoso timeout', async () => {
      stubFetchRaw({ ok: true, status: 200, body: TIMEOUT_BODY });

      const error = await wireError();

      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: {
          reason: 'sparql_timeout',
          recovery: {
            hint: eurlex_query_sparql.errors?.find((e) => e.reason === 'sparql_timeout')?.recovery,
          },
        },
      });
      expect(error.data?.recovery?.hint).toContain('timeout_hint');
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

  /** The rejection of one query, with the retry backoff fast-forwarded. */
  async function rejectionOfQuery(): Promise<{
    code?: number;
    message: string;
    data?: Record<string, unknown>;
  }> {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = makeService()
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
    stubSlowFetch(5_000);
    const ctx = createMockContext();

    await expect(
      makeService().query('SELECT ?work WHERE { ?s ?p ?o } LIMIT 1', ctx, 30),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'sparql_timeout', retryable: false },
    });
  });
});
