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
