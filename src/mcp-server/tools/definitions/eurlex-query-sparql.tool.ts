/**
 * @fileoverview eurlex_query_sparql — Execute a raw SPARQL SELECT against the CELLAR endpoint.
 * @module mcp-server/tools/definitions/eurlex-query-sparql
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCellarSparqlService } from '@/services/cellar-sparql/cellar-sparql-service.js';

/**
 * Returns the first significant SPARQL keyword (uppercased) after skipping the
 * query prologue — leading whitespace, `#` line comments, and `BASE`/`PREFIX`
 * declarations. Returns `undefined` for an empty or prologue-only query.
 *
 * Enforces the tool's read-only contract: only a leading `SELECT` is accepted;
 * update forms (DELETE/INSERT/…) and other query forms (ASK/CONSTRUCT/DESCRIBE)
 * are rejected before any request reaches CELLAR. IRIs in PREFIX/BASE (which
 * routinely contain `#`, e.g. the cdm: namespace) are consumed whole, so their
 * `#` is never mistaken for the start of a comment.
 */
function leadingSparqlKeyword(query: string): string | undefined {
  let rest = query;
  for (;;) {
    const trimmed = rest.replace(/^\s+/, '');
    if (trimmed.length === 0) return;
    if (trimmed.startsWith('#')) {
      const newline = trimmed.indexOf('\n');
      rest = newline === -1 ? '' : trimmed.slice(newline + 1);
      continue;
    }
    const base = /^BASE\s*<[^>]*>/i.exec(trimmed);
    if (base) {
      rest = trimmed.slice(base[0].length);
      continue;
    }
    const prefix = /^PREFIX\s+[^\s:]*:\s*<[^>]*>/i.exec(trimmed);
    if (prefix) {
      rest = trimmed.slice(prefix[0].length);
      continue;
    }
    return /^[A-Za-z]+/.exec(trimmed)?.[0]?.toUpperCase();
  }
}

export const eurlex_query_sparql = tool('eurlex_query_sparql', {
  title: 'Raw CELLAR SPARQL Query',
  description:
    'Execute a raw, read-only SPARQL SELECT query against the CELLAR Virtuoso endpoint. ' +
    'Only SELECT is accepted: update forms (DELETE, INSERT, LOAD, CLEAR, CREATE, DROP, COPY, MOVE, ADD) and other query forms (ASK, CONSTRUCT, DESCRIBE) are rejected locally before any request is sent. ' +
    'Use only when the curated tools (eurlex_search_documents, eurlex_get_relations, etc.) do not cover the needed traversal. ' +
    'The server caps all queries at 100 results — include an explicit LIMIT in your query to control the count; ' +
    'if omitted or above 100 it will be injected or capped automatically. ' +
    'The CDM ontology prefix is prepended automatically: cdm: = http://publications.europa.eu/ontology/cdm#. ' +
    'Also auto-includes skos: and xsd: prefixes. ' +
    'Requires familiarity with the CELLAR CDM ontology. ' +
    'Key predicates: cdm:resource_legal_id_celex (CELEX number), cdm:work_date_document (date), ' +
    'cdm:work_has_resource-type (document type), cdm:work_is_about_concept_eurovoc (EuroVoc subject), ' +
    'cdm:work_cites_work (citation). ' +
    'CELEX is stored as an xsd:string-typed literal, so match it with FILTER(STR(?celex) = "…"); a plain FILTER(?celex = "…") matches nothing. ' +
    'For multi-word phrases, single-quote the term inside bif:contains (e.g. "\'data protection\'") to use the full-text index, or FILTER(CONTAINS(LCASE(?title), "keyword")) to scan.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    sparql_query: z
      .string()
      .min(10)
      .describe(
        'A read-only SPARQL SELECT query to execute against CELLAR. Non-SELECT queries (updates such as DELETE/INSERT, or ASK/CONSTRUCT/DESCRIBE) are rejected before execution. ' +
          'Leading comments and PREFIX/BASE declarations are allowed before the SELECT keyword. The cdm:, skos:, and xsd: prefixes are auto-injected. ' +
          'LIMIT is injected at 100 if absent or capped to 100 if above that threshold.',
      ),
    timeout_hint: z
      .number()
      .int()
      .min(1000)
      .max(55000)
      .optional()
      .describe(
        'Optional client-side timeout for this request, in milliseconds (1000–55000). ' +
          'When omitted, the default timeout applies; the endpoint hard limit is 60 seconds.',
      ),
  }),
  output: z.object({
    bindings: z
      .array(
        z
          .object({})
          .passthrough()
          .describe(
            'A single SPARQL result row. Each key is a SELECT variable name; each value is a SPARQL term object with "type" (e.g. "uri", "literal") and "value" (the string value) fields.',
          ),
      )
      .describe(
        'Raw SPARQL binding rows. To extract a value from a row: row["varName"]?.value. Use the variables array to iterate in query order.',
      ),
    variables: z
      .array(z.string().describe('A SELECT variable name, in the order declared in the query.'))
      .describe('Variable names from the SELECT head, in query order.'),
    total: z.number().describe('Number of binding rows returned (capped at 100 by the server).'),
  }),

  errors: [
    {
      reason: 'not_read_only',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The query is not a read-only SELECT — an update or non-SELECT query form was supplied.',
      recovery:
        'Rewrite the request as a SPARQL SELECT query; this tool is read-only and does not run updates (DELETE/INSERT) or other query forms (ASK/CONSTRUCT/DESCRIBE).',
    },
    {
      reason: 'sparql_error',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Virtuoso returned a syntax or semantic error — the query is malformed.',
      recovery:
        'Fix the SPARQL query syntax, ensure predicates use the cdm: prefix, and verify variable names.',
    },
    {
      reason: 'sparql_timeout',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Query exceeded the 60-second Virtuoso hard limit.',
      recovery:
        'Add more specific FILTER conditions, reduce the scope, or use LIMIT with a smaller value.',
    },
  ],

  async handler(input, ctx) {
    const keyword = leadingSparqlKeyword(input.sparql_query);
    if (keyword !== 'SELECT') {
      throw ctx.fail(
        'not_read_only',
        keyword
          ? `Only read-only SELECT queries are accepted; received a ${keyword} query.`
          : 'Only read-only SELECT queries are accepted; no SELECT keyword was found.',
        { ...ctx.recoveryFor('not_read_only') },
      );
    }

    const svc = getCellarSparqlService();

    // queryWithVars exposes the projected SELECT variables (head.vars), so the
    // result columns are reported even when no rows match — Object.keys on an
    // empty bindings array would drop them.
    const { variables, bindings } = await svc.queryWithVars(
      input.sparql_query,
      ctx,
      input.timeout_hint,
    );
    ctx.log.info('Raw SPARQL query executed', { resultCount: bindings.length });

    return {
      bindings,
      variables,
      total: bindings.length,
    };
  },

  format: (result) => {
    const lines: string[] = [`## SPARQL Results (${result.total} rows)\n`];
    if (result.variables.length > 0) {
      lines.push(`**Variables:** ${result.variables.join(', ')}\n`);
    }
    if (result.total === 0) {
      lines.push('*No bindings returned.*');
    } else {
      // Render first 20 rows as a table
      const displayRows = result.bindings.slice(0, 20);
      const header = `| ${result.variables.join(' | ')} |`;
      const sep = `| ${result.variables.map(() => '---').join(' | ')} |`;
      lines.push(header);
      lines.push(sep);
      for (const row of displayRows) {
        const cells = result.variables.map((v) => {
          const cell = (row as Record<string, { value?: string }>)[v];
          return cell?.value ?? '';
        });
        lines.push(`| ${cells.join(' | ')} |`);
      }
      if (result.total > 20) {
        lines.push(`\n*Showing first 20 of ${result.total} rows.*`);
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
