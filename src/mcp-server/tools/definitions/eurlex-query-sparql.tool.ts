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
    'Run a raw, read-only SPARQL SELECT against the CELLAR Virtuoso endpoint — an escape hatch for CDM ontology traversals the curated tools do not cover. Only SELECT is accepted; update forms and ASK/CONSTRUCT/DESCRIBE are rejected before execution, and results are capped at 100. The cdm:, skos:, and xsd: prefixes are auto-injected.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    sparql_query: z
      .string()
      .min(10)
      .describe(
        'A read-only SPARQL SELECT query. Leading comments and PREFIX/BASE declarations are allowed; the cdm:, skos:, and xsd: prefixes are auto-injected. LIMIT is injected at 100 if absent, or capped to 100. Key CDM predicates: cdm:resource_legal_id_celex (CELEX), cdm:work_date_document (date), cdm:work_has_resource-type (type), cdm:work_is_about_concept_eurovoc (EuroVoc subject), cdm:work_cites_work (citation). CELEX is an xsd:string literal — match it with FILTER(STR(?celex) = "…"). For text, use bif:contains with a single-quoted phrase.',
      ),
    timeout_hint: z
      .number()
      .int()
      .min(1000)
      .max(55000)
      .optional()
      .describe(
        'Optional client-side timeout in milliseconds (1000–55000). Defaults apply when omitted; the endpoint hard limit is 60 seconds.',
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
      // Render every row. structuredContent carries the full binding set (bounded
      // only by the service-side maxSparqlResults cap), so the text channel must
      // render all of it too — a fixed 20-row slice left content[]-only clients
      // blind to rows 21+ that structuredContent clients could see (#50).
      const header = `| ${result.variables.join(' | ')} |`;
      const sep = `| ${result.variables.map(() => '---').join(' | ')} |`;
      lines.push(header);
      lines.push(sep);
      for (const row of result.bindings) {
        const cells = result.variables.map((v) => {
          const cell = (row as Record<string, { value?: string }>)[v];
          return cell?.value ?? '';
        });
        lines.push(`| ${cells.join(' | ')} |`);
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
