/**
 * @fileoverview eurlex_query_sparql — Execute a raw SPARQL SELECT against the CELLAR endpoint.
 * @module mcp-server/tools/definitions/eurlex-query-sparql
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { echoValue } from '@/mcp-server/tools/echo-value.js';
import { renderNoticeBlockquote } from '@/mcp-server/tools/markdown-render.js';
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
 * A literal lexical form with the SPARQL string escapes that keep its term
 * identity: `\` and `"`, so the delimiters stay unambiguous, and CR and LF, so a
 * multi-line value stays one table cell and CR stays distinct from LF.
 */
function escapeLexical(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
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

  const lexical = `"${escapeLexical(term.value)}"`;
  const lang = term['xml:lang'];
  if (lang) return `${lexical}@${lang}`;
  if (term.datatype) return `${lexical}^^${formatDatatype(term.datatype)}`;
  return lexical;
}

/**
 * `text` encoded for one GFM table cell, which a CommonMark parse reads back as
 * `text`: Markdown-active characters escaped (`|` included, `_` left bare
 * between letters or digits so identifiers stay copyable), and each line break,
 * which a row cannot hold, written as `&#10;` in place of the escaper's hard
 * break. Header names and every term — the `<`, `_:`, and `^^<…>` of its syntax
 * included — go through it whole.
 */
function markdownTableCell(text: string): string {
  return escapeMarkdownInline(text).replaceAll('\\\n', '&#10;');
}

/**
 * Returns the first significant SPARQL keyword (uppercased) after skipping the
 * query prologue — leading whitespace, `#` line comments, and `BASE`/`PREFIX`
 * declarations. Returns `undefined` for an empty or prologue-only query.
 *
 * Enforces the tool's read-only contract: only a leading `SELECT` is accepted;
 * update operations (`not_read_only`) and every other query form or keyword
 * (`unsupported_query_form`) are rejected before any request reaches CELLAR.
 * IRIs in PREFIX/BASE (which routinely contain `#`, e.g. the cdm: namespace) are
 * consumed whole, so their `#` is never mistaken for the start of a comment.
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

/** The SPARQL 1.1 Update operations — the only keywords `not_read_only` covers. */
const UPDATE_KEYWORDS = new Set([
  'INSERT',
  'DELETE',
  'WITH',
  'LOAD',
  'CLEAR',
  'CREATE',
  'DROP',
  'COPY',
  'MOVE',
  'ADD',
]);

/** `keyword` behind the indefinite article its spoken form takes ("an ASK", "a DROP"). */
function withArticle(keyword: string): string {
  return `${/^[AEIO]/.test(keyword) ? 'an' : 'a'} ${keyword}`;
}

/** Punctuation that ends a term: braces, parentheses, and the triple separators. */
const PUNCTUATION = '{}().,;';

/** A run of characters no other token rule claims — a prefixed name, variable, path, number, or operator. */
const WORD = /[^\s{}().,;"'<#]+/y;

/** Whitespace then `^^` or `@`: the literal just closed carries a datatype or language tag. */
const ANNOTATION = /\s*(?:\^\^|@)/y;

/** An IRIREF — `<` then no whitespace or delimiter before `>`. A bare `<` is the less-than operator. */
const IRIREF = /<[^\s<>"{}|\\^`]*>/y;

/**
 * Lexical forms of the plain string literals — no datatype, no language tag —
 * that stand as the object of a triple pattern in `query`.
 *
 * CELLAR stores its identifiers typed (CELEX, ECLI, and `cdm:work_id_document`
 * as `xsd:string`, ELI as `xsd:anyURI`), and Virtuoso does not match a plain
 * literal against a typed one, so such a pattern returns zero rows with no
 * other signal (#115). The scan skips comments, IRIs, and the contents of every
 * literal, so text inside them never counts. A literal counts only outside
 * parentheses — a function argument such as `FILTER(LANG(?l) = "en")` is
 * legitimate — and only after a predicate, or after the `,` of an object list
 * whose predicate it inherits. A `bif:contains` phrase is a plain literal by
 * design and is excluded. `VALUES` data and `FILTER` equality stay out of scope.
 */
function plainTripleObjectLiterals(query: string): string[] {
  const found: string[] = [];
  let depth = 0;
  /** The previous token: a term's text, a punctuation character, or `"` for a literal. */
  let prev = '';
  /** The predicate of the object list being read, for objects that follow a `,`. */
  let listPredicate = '';
  const isTerm = (token: string) => token !== '' && token !== '"' && !PUNCTUATION.includes(token);

  const n = query.length;
  let i = 0;
  while (i < n) {
    const ch = query[i] ?? '';
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '#') {
      const newline = query.indexOf('\n', i);
      i = newline === -1 ? n : newline + 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const close = query[i + 1] === ch && query[i + 2] === ch ? ch.repeat(3) : ch;
      const start = i + close.length;
      let end = n;
      i = start;
      while (i < n) {
        if (query[i] === '\\') {
          i += 2;
          continue;
        }
        if (query.startsWith(close, i)) {
          end = i;
          i += close.length;
          break;
        }
        i += 1;
      }
      ANNOTATION.lastIndex = i;
      if (depth === 0) {
        if (isTerm(prev)) listPredicate = prev;
        const predicate = prev === ',' || isTerm(prev) ? listPredicate : '';
        const plain = !ANNOTATION.test(query);
        if (plain && predicate !== '' && predicate.toLowerCase() !== 'bif:contains') {
          found.push(query.slice(start, end));
        }
      }
      prev = '"';
      continue;
    }
    if (ch === '<') {
      IRIREF.lastIndex = i;
      const iri = IRIREF.exec(query);
      if (iri) {
        if (depth === 0 && isTerm(prev)) listPredicate = prev;
        prev = iri[0];
        i += iri[0].length;
        continue;
      }
    }
    if (PUNCTUATION.includes(ch)) {
      if (ch === '(') depth += 1;
      else if (ch === ')') depth = Math.max(0, depth - 1);
      prev = ch;
      i += 1;
      continue;
    }
    WORD.lastIndex = i;
    const word = WORD.exec(query)?.[0] ?? ch;
    if (depth === 0 && isTerm(prev)) listPredicate = prev;
    prev = word;
    i += word.length;
  }
  return found;
}

export const eurlex_query_sparql = tool('eurlex_query_sparql', {
  title: 'Raw CELLAR SPARQL Query',
  description:
    'Run a raw, read-only SPARQL SELECT against the CELLAR Virtuoso endpoint — an escape hatch for CDM ontology traversals the curated tools do not cover. Only SELECT is accepted; update forms and ASK/CONSTRUCT/DESCRIBE are rejected before execution, and results are capped at the server row cap (100 by default). The cdm:, skos:, and xsd: prefixes are auto-injected.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    sparql_query: z
      .string()
      .min(10)
      .describe(
        'A read-only SPARQL SELECT query. Leading comments and PREFIX/BASE declarations are allowed; the cdm:, skos:, and xsd: prefixes are auto-injected. LIMIT is injected at the server row cap (100 unless the deployment configures a lower one) if absent, or capped to it; to read past the cap, add ORDER BY and repeat the query with OFFSET raised by the cap (a sorted query reaches row 10,000 at most). Key CDM predicates: cdm:resource_legal_id_celex (CELEX), cdm:work_date_document (date), cdm:work_has_resource-type (type), cdm:work_is_about_concept_eurovoc (EuroVoc subject), cdm:work_cites_work (citation). CELEX is an xsd:string literal — match it as a typed triple, ?work cdm:resource_legal_id_celex "32016R0679"^^xsd:string (an untyped literal matches nothing, in a triple or in FILTER(?celex = "…"), and a FILTER(STR(…)) comparison scans every CELEX). For text, use bif:contains with a single-quoted phrase.',
      ),
    timeout_hint: z
      .number()
      .int()
      .min(1000)
      .max(55000)
      .optional()
      .describe(
        'Optional client-side timeout in milliseconds (1000–55000). The server default (55000 unless the deployment configures another value) applies when omitted.',
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
    total: z
      .number()
      .describe("Number of binding rows returned (at most the server's row cap, 100 by default)."),
  }),

  enrichment: {
    truncated: z
      .boolean()
      .optional()
      .describe(
        "True when the server's row cap (the deployment's configured cap, 100 by default; cap gives the value applied) limited the rows and more may exist upstream — page on with ORDER BY in the query and OFFSET raised by the cap per call (sorted queries reach row 10,000 at most), or narrow the query with FILTERs.",
      ),
    shown: z.number().optional().describe('Number of binding rows returned in this response.'),
    cap: z.number().optional().describe('The server-enforced result ceiling that was applied.'),
    notice: z
      .string()
      .optional()
      .describe(
        'On a truncated result: how to page past the row cap with ORDER BY and OFFSET, and the 10,000-row limit on a sorted query. On a zero-row result whose query has an untyped string literal as a triple object: how to type or language-tag it, since CELLAR stores identifiers as typed literals that an untyped one never matches.',
      ),
  },
  // The notice quotes a literal from the caller's query, so it is escaped whole and reads back as written.
  enrichmentTrailer: {
    notice: {
      render: (notice?: string) => renderNoticeBlockquote(String(notice)),
    },
  },

  errors: [
    {
      reason: 'not_read_only',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The query is a SPARQL Update operation (INSERT, DELETE, WITH, LOAD, CLEAR, CREATE, DROP, COPY, MOVE, or ADD).',
      recovery:
        'Rewrite the request as a read-only SPARQL SELECT query; this tool never runs updates such as INSERT or DELETE.',
    },
    {
      reason: 'unsupported_query_form',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The query is not a SELECT: an ASK, CONSTRUCT, or DESCRIBE form, an unrecognized keyword, or no query keyword after the prologue.',
      recovery:
        'Rewrite it as a SPARQL SELECT that projects the variables you need, placed after any PREFIX or BASE declarations.',
    },
    {
      reason: 'sparql_error',
      code: JsonRpcErrorCode.ValidationError,
      when: 'CELLAR rejected the query: a syntax or semantic error, a compile error, or a sorted query whose OFFSET + LIMIT passes row 10,000 (SR353, answered with its own recovery: lower OFFSET or narrow the query). The same query fails the same way again.',
      recovery:
        'Fix the SPARQL query syntax, ensure predicates use the cdm: prefix, and verify variable names.',
      thrownBy: 'service',
    },
    {
      reason: 'sparql_timeout',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The query ran past the client-side timeout (timeout_hint, default 55 s), or Virtuoso refused it as over its estimated-cost limit. Neither is retried: the call fails inside the configured bound.',
      recovery:
        'Narrow the query with more specific FILTER conditions or a smaller LIMIT, or raise timeout_hint.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const keyword = leadingSparqlKeyword(input.sparql_query);
    if (keyword !== undefined && UPDATE_KEYWORDS.has(keyword)) {
      throw ctx.fail(
        'not_read_only',
        `This tool is read-only; received ${withArticle(keyword)} request, a SPARQL Update it never runs.`,
      );
    }
    if (keyword !== 'SELECT') {
      throw ctx.fail(
        'unsupported_query_form',
        keyword
          ? `Only SELECT queries are accepted; received ${withArticle(keyword)} query. Rewrite it as SELECT.`
          : 'Only SELECT queries are accepted; no query keyword follows the prologue. Rewrite it as SELECT.',
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
     * The count is compared with `===`, not `>=`. `enforceLimitInQuery` bounds the
     * OUTER result to `maxResults` regardless of subselect structure (#63), so a
     * full page is exactly `maxResults` rows and any fewer means the query simply
     * matched fewer — `>=` would buy nothing but the ability to emit the
     * self-contradicting pair `shown > cap` should that bound ever regress. Exact
     * equality is the only count a sound ceiling produces when it truncates.
     */
    if (limitEnforced && bindings.length === svc.maxResults) {
      // No input raises the ceiling; the query's own ORDER BY + OFFSET pages past
      // it, up to Virtuoso's 10,000-row sorted window (SR353 beyond, #150).
      ctx.enrich.truncated({
        shown: bindings.length,
        cap: svc.maxResults,
        guidance: `The ${svc.maxResults}-row cap is fixed. To read further, add ORDER BY to the query for a stable order and repeat it with OFFSET raised by ${svc.maxResults} each call. A sorted query reaches at most row 10,000 (OFFSET + LIMIT); narrow it with FILTERs to reach the rest.`,
      });
    }

    /**
     * The query is forwarded as written, never auto-typed: the datatype depends on
     * the predicate (`xsd:anyURI` for an ELI), and a rewrite would silently change
     * what the escape hatch runs. A zero-row result is the only point where the
     * untyped-literal trap is both likely and invisible, so that is where it is named.
     */
    const untyped = bindings.length === 0 ? plainTripleObjectLiterals(input.sparql_query) : [];
    const [firstUntyped] = untyped;
    if (firstUntyped !== undefined) {
      const others = untyped.length > 1 ? ` and ${untyped.length - 1} more` : '';
      ctx.enrich.notice(
        `No rows matched, and the query has an untyped string literal ("${echoValue(firstUntyped)}"${others}) as a triple object. CELLAR stores identifiers as typed literals that an untyped one never matches: write "…"^^xsd:string for a CELEX, ECLI, or cdm:work_id_document, "…"^^xsd:anyURI for an ELI, or "…"@en for a label.`,
      );
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
      lines.push(
        `**Variables:** ${result.variables.map((v) => escapeMarkdownInline(v)).join(', ')}\n`,
      );
    }
    if (result.total === 0) {
      lines.push('*No bindings returned.*');
    } else {
      // Render every row. structuredContent carries the full binding set (bounded
      // only by the service-side maxSparqlResults cap), so the text channel must
      // render all of it too — a fixed 20-row slice left content[]-only clients
      // blind to rows 21+ that structuredContent clients could see (#50).
      const header = `| ${result.variables.map(markdownTableCell).join(' | ')} |`;
      const sep = `| ${result.variables.map(() => '---').join(' | ')} |`;
      lines.push(header);
      lines.push(sep);
      for (const row of result.bindings) {
        const cells = result.variables.map((v) =>
          markdownTableCell(formatSparqlTerm((row as SparqlBinding)[v])),
        );
        lines.push(`| ${cells.join(' | ')} |`);
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
