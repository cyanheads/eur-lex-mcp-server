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
