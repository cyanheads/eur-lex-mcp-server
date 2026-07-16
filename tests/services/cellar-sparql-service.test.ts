/**
 * @fileoverview Tests for CellarSparqlService — the xsd:boolean parser and the
 * query methods' projection handling (head.vars survives an empty result set).
 * @module tests/services/cellar-sparql-service.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import { eurlex_query_sparql } from '@/mcp-server/tools/definitions/eurlex-query-sparql.tool.js';
import {
  CellarSparqlService,
  SPARQL_ERROR_RECOVERY_HINT,
} from '@/services/cellar-sparql/cellar-sparql-service.js';

function makeService(): CellarSparqlService {
  const serverConfig = {
    cellarSparqlEndpoint: 'http://cellar.test/sparql',
    sparqlQueryTimeoutMs: 5_000,
    maxSparqlResults: 100,
  } satisfies ServerConfig;
  // config/storage are unused by the query path.
  return new CellarSparqlService(
    {} as unknown as AppConfig,
    {} as unknown as StorageService,
    serverConfig,
  );
}

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

// --- #26: sparql_error throws carry the declared recovery hint on the wire ---

describe('CellarSparqlService sparql_error recovery (#26)', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetchRaw(opts: { ok: boolean; status: number; body: string }): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: opts.ok,
        status: opts.status,
        text: async () => opts.body,
      })),
    );
  }

  it('attaches the recovery hint to an HTTP 400 malformed-query error', async () => {
    stubFetchRaw({
      ok: false,
      status: 400,
      body: "Virtuoso 37000 Error SP030: SPARQL compiler, line 5: syntax error at 'WHERE'",
    });
    const ctx = createMockContext();

    await expect(makeService().query('SELECT WHERE { ?s ?p ?o }', ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'sparql_error',
        recovery: { hint: SPARQL_ERROR_RECOVERY_HINT },
      },
    });
  });

  it('attaches the recovery hint to a Virtuoso HTTP-200 error body', async () => {
    // Virtuoso returns HTTP 200 even for syntax errors — the body carries the error.
    stubFetchRaw({
      ok: true,
      status: 200,
      body: "Virtuoso 37000 Error SP030: SPARQL compiler, line 5: syntax error at 'WHERE' before '{'",
    });
    const ctx = createMockContext();

    await expect(makeService().query('SELECT WHERE { ?s ?p ?o }', ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'sparql_error',
        recovery: { hint: SPARQL_ERROR_RECOVERY_HINT },
      },
    });
  });

  it('keeps the service hint identical to the eurlex_query_sparql contract recovery (no drift)', () => {
    const contractRecovery = eurlex_query_sparql.errors?.find(
      (e) => e.reason === 'sparql_error',
    )?.recovery;
    expect(SPARQL_ERROR_RECOVERY_HINT).toBe(contractRecovery);
  });
});
