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
 * Locate the outermost (brace-depth 0) `LIMIT` clause — the solution modifier
 * that bounds the top-level query's result, as opposed to a `LIMIT` inside a
 * `{ SELECT … }` subselect. Scans past `#` comments, string literals (both quote
 * styles, short and long forms), and `<iri>` refs so their contents are never
 * mistaken for structure, tracking `{ }` nesting to tell an outer `LIMIT` from an
 * inner one — a distinction a plain regex cannot make (#63). Returns the match's
 * position, span, and value, or `null` when the outer query has no `LIMIT`.
 */
function findOuterLimit(query: string): { index: number; length: number; value: number } | null {
  let depth = 0;
  let found: { index: number; length: number; value: number } | null = null;
  const n = query.length;
  let i = 0;
  while (i < n) {
    const ch = query[i];
    if (ch === '#') {
      const newline = query.indexOf('\n', i);
      i = newline === -1 ? n : newline + 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const close = query[i + 1] === ch && query[i + 2] === ch ? ch.repeat(3) : ch;
      i += close.length;
      while (i < n) {
        if (query[i] === '\\') {
          i += 2;
          continue;
        }
        if (query.startsWith(close, i)) {
          i += close.length;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === '<') {
      // An IRIREF can hold '#' (never a brace), so skip it whole rather than read
      // its '#' as a comment start. A bare '<' (less-than operator) has no closing
      // '>' before whitespace, so the pattern simply does not match and it falls
      // through as an ordinary character.
      const iri = /^<[^\s<>"{}|\\^`]*>/.exec(query.slice(i));
      if (iri) {
        i += iri[0].length;
        continue;
      }
    }
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
    } else if (depth === 0 && (ch === 'L' || ch === 'l')) {
      const atBoundary = i === 0 || /[^A-Za-z0-9_]/.test(query[i - 1] ?? '');
      const limit = atBoundary ? /^LIMIT\s+(\d+)/i.exec(query.slice(i)) : null;
      if (limit) found = { index: i, length: limit[0].length, value: parseInt(limit[1] ?? '', 10) };
    }
    i += 1;
  }
  return found;
}

/**
 * Bound a SPARQL query's result to `max` by acting on its OUTERMOST `LIMIT`:
 * rewrite a top-level `LIMIT` above `max` down to `max`, or — when
 * `appendWhenAbsent` is set — append `LIMIT max` to a query that has no top-level
 * `LIMIT` at all. A `LIMIT` inside a subselect is never touched, so the caller's
 * own inner paging survives and the ceiling still bounds the rows they actually
 * receive regardless of subselect structure (#63).
 *
 * `appendWhenAbsent` splits the two callers. The raw SPARQL escape hatch
 * (`queryWithVars`) sets it: the caller's query is untrusted, so an outer bound
 * must be imposed even when only a subselect carries a `LIMIT`, else the outer
 * join runs uncapped. Internal queries (`query`) leave it unset — each is built
 * self-bounded (a single top-level `LIMIT`, or a UNION whose per-arm subselect
 * `LIMIT`s are pre-clamped to the ceiling and deliberately sum past it in the
 * symmetric relation traversal), so appending an outer `LIMIT` here would truncate
 * a legitimate two-arm result.
 *
 * `enforced` reports whether the ceiling changed the query — true when a top-level
 * `LIMIT` was appended or rewritten down, false when the caller's own top-level
 * `LIMIT` was already at or under `max` (or absent, on the internal path) and so
 * remains the binding constraint. Callers need this to read a result whose row
 * count equals `max`: without it, a caller `LIMIT 100` that genuinely matched 100
 * rows is indistinguishable from a `LIMIT 500` clamped to 100 with more waiting
 * upstream (#52).
 */
function enforceLimitInQuery(
  query: string,
  max: number,
  appendWhenAbsent: boolean,
): { query: string; enforced: boolean } {
  const outer = findOuterLimit(query);
  if (!outer) {
    if (!appendWhenAbsent) return { query, enforced: false };
    return { query: `${query.trimEnd()}\nLIMIT ${max}`, enforced: true };
  }
  if (outer.value > max) {
    const rewritten = `${query.slice(0, outer.index)}LIMIT ${max}${query.slice(outer.index + outer.length)}`;
    return { query: rewritten, enforced: true };
  }
  return { query, enforced: false };
}

export class CellarSparqlService {
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  /**
   * Enforced ceiling on generated LIMIT clauses (`MAX_SPARQL_RESULTS`). Public so
   * callers that split a query into multiple independently-capped sub-selects
   * (e.g. the per-direction relation traversal) can clamp each cap to it up front:
   * internal queries run through `query`, which passes their subselect LIMITs
   * through unchanged, so each arm must already respect the ceiling by construction.
   */
  readonly maxResults: number;

  constructor(_config: AppConfig, _storage: StorageService, serverConfig: ServerConfig) {
    this.endpoint = serverConfig.cellarSparqlEndpoint;
    this.timeoutMs = serverConfig.sparqlQueryTimeoutMs;
    this.maxResults = serverConfig.maxSparqlResults;
  }

  /**
   * Execute a raw SPARQL SELECT query and return its binding rows. Prefixes are
   * prepended automatically if not already present. Intended for internal,
   * self-bounded queries: a top-level LIMIT above `maxResults` is capped, but a
   * query with no top-level LIMIT is passed through unchanged — callers supply
   * their own bound. The untrusted raw escape hatch uses `queryWithVars`, which
   * additionally imposes an outer LIMIT.
   *
   * @param timeoutMs - Optional per-call client-side timeout in milliseconds.
   *   Falls back to the server-configured `sparqlQueryTimeoutMs` when omitted.
   */
  async query(rawQuery: string, ctx: Context, timeoutMs?: number): Promise<SparqlBinding[]> {
    return (await this.execute(rawQuery, ctx, timeoutMs, false)).parsed.results.bindings;
  }

  /**
   * Execute a raw SPARQL SELECT query and return the projected SELECT variables
   * (`head.vars`) alongside the binding rows. Unlike deriving variable names
   * from a binding's keys, the projection is reported even when the result set
   * is empty — SPARQL 1.1 carries `head.vars` independent of binding count.
   *
   * This is the untrusted raw-escape-hatch path: it imposes an outer LIMIT so the
   * caller's result is bounded to `maxResults` regardless of subselect structure.
   * `limitEnforced` reports whether that ceiling rewrote the query, so a caller can
   * tell a genuinely complete result from one the server truncated.
   */
  async queryWithVars(
    rawQuery: string,
    ctx: Context,
    timeoutMs?: number,
  ): Promise<{ variables: string[]; bindings: SparqlBinding[]; limitEnforced: boolean }> {
    const { parsed, limitEnforced } = await this.execute(rawQuery, ctx, timeoutMs, true);
    return {
      variables: parsed.head?.vars ?? [],
      bindings: parsed.results.bindings,
      limitEnforced,
    };
  }

  /**
   * POST a SPARQL query to CELLAR and return the parsed SPARQL-results JSON
   * envelope (`head` + `results`) alongside whether the `maxResults` ceiling
   * rewrote the query. Shared by `query` and `queryWithVars`.
   *
   * @param boundOuterResult - When true (the raw escape hatch), append an outer
   *   `LIMIT` if the query has none of its own, so an untrusted query is bounded
   *   even when only a subselect carries a `LIMIT`. When false (internal, trusted,
   *   self-bounded queries), leave a LIMIT-less query untouched.
   */
  private async execute(
    rawQuery: string,
    ctx: Context,
    timeoutMs: number | undefined,
    boundOuterResult: boolean,
  ): Promise<{ parsed: SparqlResultsJson; limitEnforced: boolean }> {
    const effectiveTimeoutMs = timeoutMs ?? this.timeoutMs;
    const withPrefixes = rawQuery.includes('PREFIX cdm:') ? rawQuery : SPARQL_PREFIXES + rawQuery;
    const { query: cappedQuery, enforced: limitEnforced } = enforceLimitInQuery(
      withPrefixes,
      this.maxResults,
      boundOuterResult,
    );

    const parsed = await withRetry(
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

    return { parsed, limitEnforced };
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
