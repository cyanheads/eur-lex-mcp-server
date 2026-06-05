/**
 * @fileoverview CellarSparqlService — HTTP client for the EU Publications Office CELLAR
 * Virtuoso SPARQL endpoint. Handles POST queries, LIMIT enforcement, and Virtuoso-specific
 * error detection (HTTP 200 with error body).
 * @module services/cellar-sparql/cellar-sparql-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { invalidParams, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
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
 * Inject or cap the LIMIT clause in a SPARQL query to `max`.
 * If the query has no LIMIT, appends one. If it has a LIMIT above `max`, rewrites it.
 */
function enforceLimitInQuery(query: string, max: number): string {
  const limitRe = /\bLIMIT\s+(\d+)/i;
  const match = limitRe.exec(query);
  if (!match) {
    return `${query.trimEnd()}\nLIMIT ${max}`;
  }
  const existing = parseInt(match[1]!, 10);
  if (existing > max) {
    return query.replace(limitRe, `LIMIT ${max}`);
  }
  return query;
}

export class CellarSparqlService {
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly maxResults: number;

  constructor(_config: AppConfig, _storage: StorageService, serverConfig: ServerConfig) {
    this.endpoint = serverConfig.cellarSparqlEndpoint;
    this.timeoutMs = serverConfig.sparqlQueryTimeoutMs;
    this.maxResults = serverConfig.maxSparqlResults;
  }

  /**
   * Execute a raw SPARQL SELECT query. Prefixes are prepended automatically
   * if not already present. LIMIT is injected/capped at `maxResults`.
   */
  async query(rawQuery: string, ctx: Context): Promise<SparqlBinding[]> {
    const withPrefixes = rawQuery.includes('PREFIX cdm:') ? rawQuery : SPARQL_PREFIXES + rawQuery;
    const cappedQuery = enforceLimitInQuery(withPrefixes, this.maxResults);

    return withRetry(
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
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        const text = await response.text();

        if (!response.ok) {
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
          throw invalidParams(`CELLAR SPARQL error: ${text.slice(0, 300)}`, {
            reason: 'sparql_error',
            retryable: false,
          });
        }

        let parsed: SparqlResultsJson;
        try {
          parsed = JSON.parse(text) as SparqlResultsJson;
        } catch {
          if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
            throw serviceUnavailable(
              'CELLAR returned HTML instead of SPARQL results — possibly rate-limited.',
            );
          }
          throw serviceUnavailable('Failed to parse CELLAR SPARQL response as JSON');
        }

        return parsed.results.bindings;
      },
      {
        operation: 'CellarSparqlService.query',
        baseDelayMs: 1500,
        signal: ctx.signal,
      },
    );
  }

  /**
   * Execute a SPARQL query and return bindings with automatic prefix injection
   * and LIMIT enforcement. Convenience wrapper around `query`.
   */
  async queryWithPrefixes(sparql: string, ctx: Context): Promise<SparqlBinding[]> {
    return this.query(sparql, ctx);
  }

  /** Extract a string value from a binding field, returning undefined if absent. */
  static bindingValue(binding: SparqlBinding | undefined, field: string): string | undefined {
    return binding?.[field]?.value;
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
