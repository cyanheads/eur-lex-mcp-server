/**
 * @fileoverview eurlex_query_sparql — Execute a raw SPARQL SELECT against the CELLAR endpoint.
 * @module mcp-server/tools/definitions/eurlex-query-sparql
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCellarSparqlService } from '@/services/cellar-sparql/cellar-sparql-service.js';
import type { SparqlBinding, SparqlTerm } from '@/services/cellar-sparql/types.js';

/** The XSD namespace, whose `xsd:` prefix this tool auto-injects into every query. */
const XSD_NAMESPACE = 'http://www.w3.org/2001/XMLSchema#';

/**
 * Render a datatype IRI. XSD datatypes — practically everything CELLAR emits —
 * collapse to the `xsd:` prefix the tool already injects, keeping a 100-row table
 * readable; anything else keeps its full IRI rather than inventing a prefix.
 */
function formatDatatype(datatype: string): string {
  return datatype.startsWith(XSD_NAMESPACE)
    ? `xsd:${datatype.slice(XSD_NAMESPACE.length)}`
    : `<${datatype}>`;
}

/**
 * Render a SPARQL term in the Turtle/SPARQL syntax the query language itself
 * uses: `<iri>`, `_:label`, `"lexical"`, `"lexical"@en`, `"lexical"^^xsd:date`.
 *
 * `structuredContent` carries the whole term object, but the text table used to
 * render `value` alone — so a content[]-only client could not tell an IRI from a
 * literal and lost datatype and language entirely (#54). Quotes and backslashes
 * inside a lexical form are escaped, so the delimiters stay unambiguous.
 *
 * An unbound OPTIONAL variable has no key in the row at all and renders empty.
 */
function formatSparqlTerm(term: SparqlTerm | undefined): string {
  if (!term) return '';
  if (term.type === 'uri') return `<${term.value}>`;
  if (term.type === 'bnode') return `_:${term.value}`;

  const lexical = `"${term.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const lang = term['xml:lang'];
  if (lang) return `${lexical}@${lang}`;
  if (term.datatype) return `${lexical}^^${formatDatatype(term.datatype)}`;
  return lexical;
}

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
            'A single SPARQL result row. Each key is a SELECT variable name; each value is a SPARQL term object with "type" ("uri", "literal", or "bnode") and "value" (the string value), plus "datatype" (an IRI) on a typed literal or "xml:lang" (a language tag) on a language-tagged literal — the two are mutually exclusive. A variable left unbound by an OPTIONAL has no key in the row at all.',
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

  enrichment: {
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when the server-enforced result ceiling capped the rows and more may exist upstream — narrow the query with FILTERs to see the rest.',
      ),
    shown: z.number().optional().describe('Number of binding rows returned in this response.'),
    cap: z.number().optional().describe('The server-enforced result ceiling that was applied.'),
  },

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
    // empty bindings array would drop them. It also reports whether the server's
    // LIMIT ceiling rewrote the query (limitEnforced).
    const { variables, bindings, limitEnforced } = await svc.queryWithVars(
      input.sparql_query,
      ctx,
      input.timeout_hint,
    );
    ctx.log.info('Raw SPARQL query executed', { resultCount: bindings.length });

    /**
     * Disclose truncation only when the server's ceiling both fired AND filled.
     * The row count alone is ambiguous — a caller's own `LIMIT 100` that genuinely
     * matched 100 rows looks identical to a `LIMIT 500` clamped down to 100 — so
     * `limitEnforced` is what separates them (#52).
     *
     * The count is compared with `===`, not `>=`: `enforceLimitInQuery` rewrites
     * only the FIRST `LIMIT` in the query text, so a subselect's limit can absorb
     * the rewrite and leave the outer query uncapped, returning far more rows than
     * the ceiling. `>=` would fire there and report the self-contradicting pair
     * `shown: 759, cap: 100`. Exact equality is the only count the ceiling can
     * actually produce when it bounds the result.
     */
    if (limitEnforced && bindings.length === svc.maxResults) {
      ctx.enrich.truncated({ shown: bindings.length, cap: svc.maxResults });
    }

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
        const cells = result.variables.map((v) => formatSparqlTerm((row as SparqlBinding)[v]));
        lines.push(`| ${cells.join(' | ')} |`);
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
