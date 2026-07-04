/**
 * @fileoverview CellarSparqlService — HTTP client for the EU Publications Office CELLAR
 * Virtuoso SPARQL endpoint. Handles POST queries, LIMIT enforcement, and Virtuoso-specific
 * error detection (HTTP 200 with error body).
 * @module services/cellar-sparql/cellar-sparql-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { serviceUnavailable, validationError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { withRetry } from '@cyanheads/mcp-ts-core/utils';
import type { ServerConfig } from '@/config/server-config.js';
import type { SparqlBinding, SparqlResultsJson } from './types.js';

/** Required PREFIX declarations for CELLAR CDM ontology queries. */
const SPARQL_PREFIXES = `PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
`;

/** Pattern matching Virtuoso-specific error responses (HTTP 200 with error body). */
const VIRTUOSO_ERROR_RE = /Virtuoso\s+\d+\s+Error/i;
/** Pattern for Virtuoso timeout messages (SP031). */
const VIRTUOSO_TIMEOUT_RE = /SP031|query execution timed out/i;

/**
 * Recovery hint attached to every `sparql_error` throw so the wire
 * `data.recovery.hint` (and its mirrored `Recovery:` content line) is populated
 * even though the error is raised here in the shared service rather than through
 * a handler's `ctx.fail`. Kept identical to the `sparql_error` contract recovery
 * declared on eurlex_query_sparql — that tool's inline literal is the
 * human-readable source of truth, and a service test asserts the two never drift.
 */
export const SPARQL_ERROR_RECOVERY_HINT =
  'Fix the SPARQL query syntax, ensure predicates use the cdm: prefix, and verify variable names.';

/**
 * Inject or cap the LIMIT clause in a SPARQL query to `max`.
 * If the query has no LIMIT, appends one. If it has a LIMIT above `max`, rewrites it.
 */
function enforceLimitInQuery(query: string, max: number): string {
  const limitRe = /\bLIMIT\s+(\d+)/i;
  const match = limitRe.exec(query);
  if (!match) {
    return `${query.trimEnd()}\nLIMIT ${max}`;
  }
  const existing = parseInt(match[1] ?? '', 10);
  if (existing > max) {
    return query.replace(limitRe, `LIMIT ${max}`);
  }
  return query;
}

export class CellarSparqlService {
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  /**
   * Enforced ceiling on generated LIMIT clauses (`MAX_SPARQL_RESULTS`). Public so
   * callers that split a query into multiple independently-capped sub-selects
   * (e.g. the per-direction relation traversal) can clamp each cap to it up front,
   * rather than have `enforceLimitInQuery` rewrite only the first LIMIT it finds.
   */
  readonly maxResults: number;

  constructor(_config: AppConfig, _storage: StorageService, serverConfig: ServerConfig) {
    this.endpoint = serverConfig.cellarSparqlEndpoint;
    this.timeoutMs = serverConfig.sparqlQueryTimeoutMs;
    this.maxResults = serverConfig.maxSparqlResults;
  }

  /**
   * Execute a raw SPARQL SELECT query and return its binding rows. Prefixes are
   * prepended automatically if not already present. LIMIT is injected/capped at
   * `maxResults`.
   *
   * @param timeoutMs - Optional per-call client-side timeout in milliseconds.
   *   Falls back to the server-configured `sparqlQueryTimeoutMs` when omitted.
   */
  async query(rawQuery: string, ctx: Context, timeoutMs?: number): Promise<SparqlBinding[]> {
    return (await this.execute(rawQuery, ctx, timeoutMs)).results.bindings;
  }

  /**
   * Execute a raw SPARQL SELECT query and return the projected SELECT variables
   * (`head.vars`) alongside the binding rows. Unlike deriving variable names
   * from a binding's keys, the projection is reported even when the result set
   * is empty — SPARQL 1.1 carries `head.vars` independent of binding count.
   */
  async queryWithVars(
    rawQuery: string,
    ctx: Context,
    timeoutMs?: number,
  ): Promise<{ variables: string[]; bindings: SparqlBinding[] }> {
    const parsed = await this.execute(rawQuery, ctx, timeoutMs);
    return { variables: parsed.head?.vars ?? [], bindings: parsed.results.bindings };
  }

  /**
   * POST a SPARQL query to CELLAR and return the parsed SPARQL-results JSON
   * envelope (`head` + `results`). Shared by `query` and `queryWithVars`.
   */
  private async execute(
    rawQuery: string,
    ctx: Context,
    timeoutMs?: number,
  ): Promise<SparqlResultsJson> {
    const effectiveTimeoutMs = timeoutMs ?? this.timeoutMs;
    const withPrefixes = rawQuery.includes('PREFIX cdm:') ? rawQuery : SPARQL_PREFIXES + rawQuery;
    const cappedQuery = enforceLimitInQuery(withPrefixes, this.maxResults);

    return await withRetry(
      async () => {
        const body = new URLSearchParams({
          query: cappedQuery,
          format: 'application/sparql-results+json',
        });
        const response = await fetch(this.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/sparql-results+json',
          },
          body: body.toString(),
          signal: AbortSignal.timeout(effectiveTimeoutMs),
        });

        const text = await response.text();

        if (!response.ok) {
          if (response.status === 400) {
            // HTTP 400 = client error (malformed query) — not retryable
            throw validationError(`CELLAR SPARQL error: ${text.slice(0, 300)}`, {
              reason: 'sparql_error',
              retryable: false,
              recovery: { hint: SPARQL_ERROR_RECOVERY_HINT },
            });
          }
          throw serviceUnavailable(`CELLAR SPARQL HTTP ${response.status}`, {
            status: response.status,
          });
        }

        /** Virtuoso returns HTTP 200 even for errors — inspect the body. */
        if (VIRTUOSO_ERROR_RE.test(text)) {
          if (VIRTUOSO_TIMEOUT_RE.test(text)) {
            throw serviceUnavailable('CELLAR SPARQL query timed out on Virtuoso', {
              reason: 'sparql_timeout',
            });
          }
          // Syntax / semantic error — not transient, fail immediately
          throw validationError(`CELLAR SPARQL error: ${text.slice(0, 300)}`, {
            reason: 'sparql_error',
            retryable: false,
            recovery: { hint: SPARQL_ERROR_RECOVERY_HINT },
          });
        }

        try {
          return JSON.parse(text) as SparqlResultsJson;
        } catch {
          if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
            throw serviceUnavailable(
              'CELLAR returned HTML instead of SPARQL results — possibly rate-limited.',
            );
          }
          throw serviceUnavailable('Failed to parse CELLAR SPARQL response as JSON');
        }
      },
      {
        operation: 'CellarSparqlService.query',
        baseDelayMs: 1500,
        signal: ctx.signal,
      },
    );
  }

  /** Extract a string value from a binding field, returning undefined if absent. */
  static bindingValue(binding: SparqlBinding | undefined, field: string): string | undefined {
    return binding?.[field]?.value;
  }

  /**
   * Interpret a SPARQL `xsd:boolean` lexical value. Virtuoso serializes
   * `xsd:boolean` as the lexicals `"1"` / `"0"` (not `"true"` / `"false"`) in
   * SPARQL-JSON, so accept both forms. Returns `undefined` for an absent or
   * unrecognized value rather than coercing it to a false negative.
   */
  static parseBoolean(lexical: string | undefined): boolean | undefined {
    if (lexical === 'true' || lexical === '1') return true;
    if (lexical === 'false' || lexical === '0') return false;
    return;
  }
}

// --- Init/accessor pattern ---

let _service: CellarSparqlService | undefined;

export function initCellarSparqlService(
  config: AppConfig,
  storage: StorageService,
  serverConfig: ServerConfig,
): void {
  _service = new CellarSparqlService(config, storage, serverConfig);
}

export function getCellarSparqlService(): CellarSparqlService {
  if (!_service) {
    throw new Error(
      'CellarSparqlService not initialized — call initCellarSparqlService() in setup()',
    );
  }
  return _service;
}
