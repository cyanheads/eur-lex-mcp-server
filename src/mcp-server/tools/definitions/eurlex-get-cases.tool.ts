/**
 * @fileoverview eurlex_get_cases — Search CJEU and General Court case law.
 * @module mcp-server/tools/definitions/eurlex-get-cases
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  ENG_LANGUAGE_URI,
  parseCaseLawTitle,
  resolveResourceTypeLabels,
} from '@/services/cellar-sparql/cdm-labels.js';
import {
  CellarSparqlService,
  getCellarSparqlService,
} from '@/services/cellar-sparql/cellar-sparql-service.js';

/**
 * Case type → CDM resource-type authority URI. A case_type filter tests the
 * work's resource-type, NOT a CELEX substring: abstract (`_RES` → ABSTRACT_JUR)
 * and summary (`_SUM` → SUM_JUR) sibling works carry the same CELEX type letters
 * as their parent judgment/order (they still CONTAIN "CJ"/"CO"), only under a
 * distinct CELEX, so a substring test admitted them as separate rows. Requiring
 * the resource-type excludes those derivative works (issue #38). CELLAR types
 * CJEU/GC judgments as JUDG, orders as ORDER, and AG opinions (CELEX "CC") as
 * OPIN_AG.
 */
const CASE_TYPE_RESOURCE_TYPE: Record<string, string> = {
  judgment: 'http://publications.europa.eu/resource/authority/resource-type/JUDG',
  order: 'http://publications.europa.eu/resource/authority/resource-type/ORDER',
  ag_opinion: 'http://publications.europa.eu/resource/authority/resource-type/OPIN_AG',
};

/**
 * Derivative sector-6 resource-types excluded from the untyped/default search:
 * information notices (INFO_JUDICIAL, INFO_JUR), case-law abstracts (ABSTRACT_JUR),
 * and case summaries (SUM_JUR). Each is a separate CELLAR work with its own CELEX,
 * so at a page limit they crowd distinct primary cases off the page — a keyword
 * search for a landmark ruling could drop the ruling itself entirely (issue #44).
 * A case_type filter already excludes them structurally (it requires a primary
 * resource-type); the untyped path excludes them unless include_derivative opts in.
 * JUDG_EXTRACT/ORDER_EXTRACT are deliberately NOT here: an OJ extract can be the
 * sole published record of an older case, so excluding it would cost recall.
 */
const DERIVATIVE_RESOURCE_TYPES = [
  'http://publications.europa.eu/resource/authority/resource-type/INFO_JUDICIAL',
  'http://publications.europa.eu/resource/authority/resource-type/INFO_JUR',
  'http://publications.europa.eu/resource/authority/resource-type/ABSTRACT_JUR',
  'http://publications.europa.eu/resource/authority/resource-type/SUM_JUR',
] as const;

/**
 * Convert a standard EU case number (C-131/12 or T-131/12) into a CELEX substring
 * suitable for a CONTAINS filter.
 *
 * CELEX format for case law: 6{year4d}{court}{num4d}
 *   e.g. C-131/12 → 62012CJ0131, T-22/20 → 62020TJ0022
 *
 * 2-digit year heuristic: yy ≤ 60 → 20yy, else → 19yy.
 * Returns null if the input doesn't match the expected pattern.
 */
function caseNumberToCelexFragment(caseNumber: string): string | null {
  const m = /^([CT])-(\d+)\/(\d{2,4})$/.exec(caseNumber.trim().toUpperCase());
  if (!m) return null;
  // Groups 1–3 are all present once the pattern matches; the `?? ''` fallbacks
  // satisfy the type-checker without a non-null assertion and never fire at runtime.
  const court = m[1] === 'C' ? 'CJ' : 'TJ';
  const caseNum = (m[2] ?? '').padStart(4, '0');
  const yearStr = m[3] ?? '';
  const rawYear = parseInt(yearStr, 10);
  const year4 = yearStr.length === 2 ? (rawYear <= 60 ? 2000 + rawYear : 1900 + rawYear) : rawYear;
  return `${year4}${court}${caseNum}`;
}

export const eurlex_get_cases = tool('eurlex_get_cases', {
  title: 'Search CJEU/GC Case Law',
  description:
    'Search CJEU and General Court case law — judgments, orders, and Advocate General opinions — by case number, court, case type, keyword, and date range. By default only these primary records are returned; derivative judicial information notices, case abstracts, and summaries are excluded so distinct cases fill the page (set include_derivative to include them). Keyword matches English case titles (which carry party names) and CELEX strings; there is no full-text body search. Returns each case with its court, date, and type, plus — parsed from the title where present — the parties, subject matter, and case reference.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    case_number: z
      .string()
      .optional()
      .describe(
        'Case number in standard format: C-{num}/{year} for CJEU or T-{num}/{year} for General Court (e.g. C-131/12).',
      ),
    keyword: z
      .string()
      .optional()
      .describe('Keyword to match against case titles and CELEX strings.'),
    court: z
      .union([
        z.literal(''),
        z.enum(['CJEU', 'GC']).describe('CJEU = Court of Justice of the EU, GC = General Court.'),
      ])
      .optional()
      .describe(
        'Court filter: CJEU = Court of Justice of the EU, GC = General Court. Omit to search both.',
      ),
    case_type: z
      .union([
        z.literal(''),
        z
          .enum(['judgment', 'order', 'ag_opinion'])
          .describe(
            'judgment, order (procedural decision), or ag_opinion (Advocate General opinion).',
          ),
      ])
      .optional()
      .describe(
        'Case type: judgment, order (procedural decision), or ag_opinion (Advocate General opinion). Omit to search all.',
      ),
    include_derivative: z
      .boolean()
      .default(false)
      .describe(
        'Include derivative sector-6 records — judicial information notices, case abstracts, and case summaries — alongside primary judgments, orders, and AG opinions. Default false: these are excluded so distinct primary cases fill the page. Ignored when case_type is set (that path already returns a single primary type).',
      ),
    date_from: z
      .union([
        z.literal(''),
        z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe('Start date in ISO 8601 format (YYYY-MM-DD).'),
      ])
      .optional()
      .describe(
        'Start of date range in ISO 8601 format (YYYY-MM-DD). Leave blank or omit for no lower bound.',
      ),
    date_to: z
      .union([
        z.literal(''),
        z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe('End date in ISO 8601 format (YYYY-MM-DD).'),
      ])
      .optional()
      .describe(
        'End of date range in ISO 8601 format (YYYY-MM-DD). Leave blank or omit for no upper bound.',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Pagination offset — number of results to skip. Defaults to 0.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .describe('Maximum number of results to return (1–100). Defaults to 20.'),
  }),
  output: z.object({
    cases: z
      .array(
        z
          .object({
            work_uri: z.string().describe('CELLAR work URI.'),
            celex_number: z.string().describe('CELEX identifier for the case (e.g. 62024CJ0629).'),
            resource_type: z
              .string()
              .optional()
              .describe(
                'Human-readable case type label (e.g. "Judgment", "Order", "AG Opinion"). Cases with several resource-types (e.g. corrigenda) list all, comma-separated. Absent for some older cases.',
              ),
            date: z.string().optional().describe('Judgment/opinion date in ISO 8601 format.'),
            title: z
              .string()
              .optional()
              .describe(
                'Raw English expression title as stored in CELLAR — a "#"-delimited string (court+date, parties, subject-matter, case reference) whose segments are surfaced in display_title, parties, subject_matter, and case_reference. Absent for many older cases.',
              ),
            display_title: z
              .string()
              .optional()
              .describe(
                'Clean human-readable title for display — the parties for a contested case (e.g. "Google Spain SL v AEPD"), or the court/AG descriptor when a case has no named parties. Parsed from title; absent when title is.',
              ),
            parties: z
              .string()
              .optional()
              .describe(
                'Parties to the case, parsed from the title (e.g. "WhatsApp Ireland Ltd v European Data Protection Board."). Absent when the title carries no parties segment (e.g. AG opinions).',
              ),
            subject_matter: z
              .string()
              .optional()
              .describe(
                'Subject-matter keyword summary parsed from the title — the legal topics and provisions at issue. Absent when the title carries no subject-matter segment.',
              ),
            case_reference: z
              .string()
              .optional()
              .describe(
                'Case reference parsed from the title (e.g. "Case C-97/23 P."). Absent when the title carries no case-reference segment.',
              ),
          })
          .describe('A single CJEU or General Court case law record.'),
      )
      .describe('Matching case law records ordered by date descending.'),
    total: z.number().describe('Number of cases returned in this page (not a corpus-wide count).'),
    offset: z.number().describe('Pagination offset used for this response.'),
    query_echo: z
      .object({
        case_number: z.string().optional().describe('Case number filter applied.'),
        celex_fragment: z.string().optional().describe('CELEX substring derived from case_number.'),
        keyword: z.string().optional().describe('Keyword filter applied.'),
        court: z.string().optional().describe('Court filter applied.'),
        case_type: z.string().optional().describe('Case type filter applied.'),
        date_from: z.string().optional().describe('Start date filter applied.'),
        date_to: z.string().optional().describe('End date filter applied.'),
      })
      .describe('Echo of filters applied to this search. Useful for diagnosing empty results.'),
  }),

  enrichment: {
    truncated: z
      .boolean()
      .optional()
      .describe('True when the returned page was capped at the limit and more cases may exist.'),
    shown: z.number().optional().describe('Number of cases returned in this page.'),
    cap: z.number().optional().describe('The limit that was applied to this page.'),
  },

  errors: [
    {
      reason: 'no_results',
      code: JsonRpcErrorCode.NotFound,
      when: 'The query returned zero bindings — no matching cases in CELLAR sector 6.',
      recovery:
        'Try a different keyword, broader date range, or remove the court/case_type filter.',
    },
    {
      reason: 'sparql_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Virtuoso returned HTTP 200 with an error body — query malformed or timed out.',
      recovery: 'Simplify the query or reduce the date range and retry.',
    },
  ],

  async handler(input, ctx) {
    const svc = getCellarSparqlService();

    // All case law is in CELEX sector 6
    const filters: string[] = [`FILTER(STRSTARTS(STR(?celexNumber), "6"))`];

    let celexFragment: string | undefined;
    if (input.case_number?.trim()) {
      // Convert standard case number (C-131/12) to CELEX substring (2012CJ0131).
      // The old approach — searching for the raw "131/12" string in the CELEX — is
      // inverted: CELEX stores year before case number, so "131/12" never matches.
      celexFragment = caseNumberToCelexFragment(input.case_number) ?? undefined;
      if (celexFragment) {
        filters.push(`FILTER(CONTAINS(STR(?celexNumber), "${celexFragment}"))`);
      } else {
        // Fallback for non-standard formats: substring match on CELEX
        const cn = input.case_number.trim().replace(/"/g, '\\"');
        filters.push(`FILTER(CONTAINS(LCASE(STR(?celexNumber)), LCASE("${cn}")))`);
      }
    }

    /**
     * Keyword match — title via the Virtuoso full-text index, CELEX by substring.
     * The former `FILTER(CONTAINS(LCASE(?title), …))` scan forced the expression
     * graph to be joined for every candidate work before the term was tested, so
     * a broad keyword scanned every candidate title and risked the query timeout
     * (issue #17). `bif:contains` drives the match straight off the full-text
     * index — the same fix the author filter in eurlex_search_documents uses —
     * resolving in well under a second. Exact-substring CELEX matching is
     * preserved as a UNION arm; a UNION arm evaluates its FILTER over its own
     * scope, so the CELEX triple is re-bound inside the arm (a bare FILTER on the
     * outer ?celexNumber binds nothing there).
     */
    let keywordClause = '';
    const keywordInput = input.keyword?.trim();
    if (keywordInput) {
      const celexTerm = keywordInput.toLowerCase().replace(/"/g, '\\"');
      const ftPhrase = keywordInput
        .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const celexArm = `?work cdm:resource_legal_id_celex ?kwCelex .
    FILTER(CONTAINS(LCASE(STR(?kwCelex)), "${celexTerm}"))`;
      keywordClause = ftPhrase
        ? `{
    ?kwExpr cdm:expression_title ?kwTitle .
    ?kwTitle bif:contains "'${ftPhrase}'" .
    ?kwExpr cdm:expression_uses_language <${ENG_LANGUAGE_URI}> .
    ?kwExpr cdm:expression_belongs_to_work ?work .
  } UNION {
    ${celexArm}
  }`
        : celexArm;
    }

    if (input.court === 'CJEU') {
      // CJEU cases have CELEX pattern 6{year}CJ or 6{year}CC (AG opinions)
      filters.push(
        `FILTER(CONTAINS(STR(?celexNumber), "CJ") || CONTAINS(STR(?celexNumber), "CC") || CONTAINS(STR(?celexNumber), "CO"))`,
      );
    } else if (input.court === 'GC') {
      // General Court cases have pattern 6{year}TJ
      filters.push(
        `FILTER(CONTAINS(STR(?celexNumber), "TJ") || CONTAINS(STR(?celexNumber), "TO"))`,
      );
    }

    /**
     * Case-type filter — a required resource-type triple, not a CELEX substring.
     * The old `FILTER(CONTAINS(STR(?celexNumber), "CJ"))` also matched the abstract
     * (`_RES`) and summary (`_SUM`) sibling works, which share the parent's CELEX
     * type letters under a distinct CELEX and so survived `GROUP BY ?celexNumber`
     * as extra rows. Requiring the resource-type keeps only true judgments/orders/
     * opinions (issue #38). The `OPTIONAL { … ?type }` below still gathers every
     * type for the display label, so a corrigendum-judgment keeps all its labels.
     */
    let typeConstraint = '';
    if (input.case_type) {
      const typeUri = CASE_TYPE_RESOURCE_TYPE[input.case_type];
      if (typeUri) {
        typeConstraint = `?work cdm:work_has_resource-type <${typeUri}> .`;
      }
    }

    /**
     * Exclude derivative sector-6 records (notices, abstracts, summaries) on the
     * untyped/default path so distinct primary cases fill the page (issue #44). A
     * single FILTER NOT EXISTS drops any work carrying one of the derivative types;
     * type-less older cases carry none of them and are kept, so recall of pre-typed
     * records is unaffected. Skipped when case_type is set — its required
     * resource-type triple already excludes derivatives — or when include_derivative
     * opts them back in.
     */
    if (!input.case_type && !input.include_derivative) {
      const derivativeValues = DERIVATIVE_RESOURCE_TYPES.map((uri) => `<${uri}>`).join(' ');
      filters.push(
        `FILTER NOT EXISTS { ?work cdm:work_has_resource-type ?derivativeType . VALUES ?derivativeType { ${derivativeValues} } }`,
      );
    }

    if (input.date_from?.trim()) {
      filters.push(`FILTER(?date >= "${input.date_from.trim()}"^^xsd:date)`);
    }
    if (input.date_to?.trim()) {
      filters.push(`FILTER(?date <= "${input.date_to.trim()}"^^xsd:date)`);
    }

    /**
     * Titles live on expressions, not works — traverse the expression graph:
     * ?expr cdm:expression_belongs_to_work ?work (inverse of cdm:work_has_expression),
     * ?expr cdm:expression_uses_language <.../ENG>, ?expr cdm:expression_title ?title.
     *
     * GROUP BY ?celexNumber collapses each case to one row, handling two distinct
     * CELLAR duplications at once:
     *   1. A work carrying several cdm:work_has_resource-type values (corrigenda
     *      hold 2–3) — GROUP_CONCAT gathers every type URI per case (issue #14).
     *   2. Several distinct work URIs sharing one CELEX (e.g. a titled judgment
     *      plus a do_not_index member work) — grouping by CELEX rather than ?work
     *      merges them, so LIMIT N returns N distinct cases and `total` counts
     *      cases rather than rows (issue #21).
     * MAX(?title) keeps a bound title across the group, so a titled member's title
     * survives over a bare duplicate's absent one; MAX(?titledWork) likewise prefers
     * the work URI that carries a title — ?titledWork binds to ?work only inside the
     * title OPTIONAL — and the handler falls back to SAMPLE(?work) when no work in the
     * group is titled. ?docDate uses SAMPLE, NOT MAX: under ORDER BY DESC(?docDate) a
     * MAX over the ordered column lets Virtuoso pick a date-index TOP-k plan that
     * bypasses the date-range upper-bound FILTER whenever no selective graph pattern
     * is present (a bare date/court/type search), returning the globally-latest cases
     * instead of the in-range ones. Date is single-valued per CELEX, so SAMPLE shows
     * the same value without triggering that plan.
     */
    const sparql = `
SELECT
  (SAMPLE(?celexNumber) AS ?celex)
  (MAX(?titledWork) AS ?titledWork)
  (SAMPLE(?work) AS ?work)
  (GROUP_CONCAT(DISTINCT STR(?type); SEPARATOR=" ") AS ?types)
  (SAMPLE(?date) AS ?docDate)
  (MAX(?title) AS ?docTitle) WHERE {
  ?work cdm:resource_legal_id_celex ?celexNumber .
  ${typeConstraint}
  OPTIONAL { ?work cdm:work_has_resource-type ?type . }
  OPTIONAL { ?work cdm:work_date_document ?date . }
  OPTIONAL {
    ?expr cdm:expression_belongs_to_work ?work .
    ?expr cdm:expression_uses_language <${ENG_LANGUAGE_URI}> .
    ?expr cdm:expression_title ?title .
    BIND(?work AS ?titledWork)
  }
  ${keywordClause}
  ${filters.join('\n  ')}
} GROUP BY ?celexNumber ORDER BY DESC(?docDate) LIMIT ${input.limit} OFFSET ${input.offset}`;

    const queryEcho = {
      ...(input.case_number ? { case_number: input.case_number } : {}),
      ...(celexFragment ? { celex_fragment: celexFragment } : {}),
      ...(keywordInput ? { keyword: keywordInput } : {}),
      ...(input.court ? { court: input.court } : {}),
      ...(input.case_type ? { case_type: input.case_type } : {}),
      ...(input.date_from ? { date_from: input.date_from } : {}),
      ...(input.date_to ? { date_to: input.date_to } : {}),
    };

    const bindings = await svc.query(sparql, ctx);
    ctx.log.info('Case law search', {
      caseNumber: input.case_number,
      celexFragment,
      keyword: input.keyword,
      court: input.court,
      caseType: input.case_type,
      resultCount: bindings.length,
    });

    if (bindings.length === 0) {
      const filterSummary = Object.entries(queryEcho)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(', ');
      throw ctx.fail(
        'no_results',
        `No case law records matched the search criteria${filterSummary ? `. Filters: ${filterSummary}` : '.'}`,
        { ...ctx.recoveryFor('no_results') },
      );
    }

    const cases = bindings.map((b) => {
      const c: {
        work_uri: string;
        celex_number: string;
        resource_type?: string;
        date?: string;
        title?: string;
        display_title?: string;
        parties?: string;
        subject_matter?: string;
        case_reference?: string;
      } = {
        work_uri:
          CellarSparqlService.bindingValue(b, 'titledWork') ??
          CellarSparqlService.bindingValue(b, 'work') ??
          '',
        celex_number: CellarSparqlService.bindingValue(b, 'celex') ?? '',
      };
      const resourceType = resolveResourceTypeLabels(CellarSparqlService.bindingValue(b, 'types'));
      if (resourceType) c.resource_type = resourceType;
      const date = CellarSparqlService.bindingValue(b, 'docDate');
      if (date) c.date = date;
      // Preserve the raw title verbatim, then surface the parsed case-law segments
      // (parties/subject-matter/case-reference and a clean display title) alongside
      // it — nothing is dropped, and a sparse or malformed title just leaves the
      // structured fields unset (issue #40).
      const title = CellarSparqlService.bindingValue(b, 'docTitle');
      if (title) {
        c.title = title;
        const parsed = parseCaseLawTitle(title);
        if (parsed.displayTitle) c.display_title = parsed.displayTitle;
        if (parsed.parties) c.parties = parsed.parties;
        if (parsed.subjectMatter) c.subject_matter = parsed.subjectMatter;
        if (parsed.caseReference) c.case_reference = parsed.caseReference;
      }
      return c;
    });

    // A full page means the limit capped the list — page forward with offset for more.
    if (cases.length >= input.limit) {
      ctx.enrich.truncated({ shown: cases.length, cap: input.limit });
    }

    return { cases, total: cases.length, offset: input.offset, query_echo: queryEcho };
  },

  format: (result) => {
    const lines: string[] = [
      `## CJEU/GC Case Law (${result.total} results, offset ${result.offset})\n`,
    ];
    const echoEntries = Object.entries(result.query_echo);
    if (echoEntries.length > 0) {
      lines.push(
        `*Filters: ${echoEntries.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')}*\n`,
      );
    }
    for (const c of result.cases) {
      // Prefer the clean parsed display title; fall back to the raw title (already
      // clean for the plain, non-"#"-delimited titles that don't parse).
      const heading = c.display_title ?? c.title;
      lines.push(`### ${c.celex_number}${heading ? ` — ${heading}` : ''}`);
      if (c.date) lines.push(`**Date:** ${c.date}`);
      if (c.resource_type) lines.push(`**Type:** ${c.resource_type}`);
      if (c.parties) lines.push(`**Parties:** ${c.parties}`);
      if (c.subject_matter) lines.push(`**Subject matter:** ${c.subject_matter}`);
      if (c.case_reference) lines.push(`**Case reference:** ${c.case_reference}`);
      // Full raw CELLAR title — carries the court/chamber/date descriptor the parsed
      // fields omit, and keeps the original string available to the reader.
      if (c.title) lines.push(`**Full title:** ${c.title}`);
      lines.push(`**Work URI:** ${c.work_uri}`);
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
