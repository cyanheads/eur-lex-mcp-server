/**
 * @fileoverview eurlex_get_cases — Search CJEU and General Court case law.
 * @module mcp-server/tools/definitions/eurlex-get-cases
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  ENG_LANGUAGE_URI,
  resolveResourceTypeLabels,
} from '@/services/cellar-sparql/cdm-labels.js';
import {
  CellarSparqlService,
  getCellarSparqlService,
} from '@/services/cellar-sparql/cellar-sparql-service.js';

/** Case type to CELEX type substring mapping. */
const CASE_TYPE_PATTERN: Record<string, string> = {
  judgment: 'CJ',
  order: 'CO',
  ag_opinion: 'CC',
};

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
  const court = m[1] === 'C' ? 'CJ' : 'TJ';
  const caseNum = m[2]!.padStart(4, '0');
  const rawYear = parseInt(m[3]!, 10);
  const year4 = m[3]!.length === 2 ? (rawYear <= 60 ? 2000 + rawYear : 1900 + rawYear) : rawYear;
  return `${year4}${court}${caseNum}`;
}

export const eurlex_get_cases = tool('eurlex_get_cases', {
  title: 'Search CJEU/GC Case Law',
  description:
    'Search CJEU (Court of Justice of the EU) and General Court case law — judgments, orders, and Advocate General opinions. ' +
    'Distinct from eurlex_search_documents because case law uses CELEX sector 6 and practitioners search it differently: ' +
    'by case number, court, party name, or AG opinion type. ' +
    'Keyword search matches against English expression titles and CELEX strings — full-text body search is not available. ' +
    'Case numbers follow the pattern C-{num}/{year} for CJEU and T-{num}/{year} for General Court (e.g. C-131/12). ' +
    'Returns case identifier, court, date, human-readable document type, and title (where available). ' +
    'Use eurlex_get_document with the CELEX number to fetch the full judgment text.',
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
        'Court filter: CJEU = Court of Justice of the EU, GC = General Court. ' +
          'Leave blank or omit to search both courts.',
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
        'Case type filter: judgment, order (procedural decision), or ag_opinion (Advocate General opinion). ' +
          'Leave blank or omit to search all case types.',
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
                'Human-readable case type label (e.g. "Judgment", "Order", "AG Opinion"). ' +
                  'Cases classified under several resource-types (e.g. corrigenda) list all labels, comma-separated. ' +
                  'Absent for some older cases.',
              ),
            date: z.string().optional().describe('Judgment/opinion date in ISO 8601 format.'),
            title: z
              .string()
              .optional()
              .describe(
                'English expression title where available (e.g. "Google Spain SL v AEPD"). Absent for many older cases.',
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
    if (input.case_number && input.case_number.trim()) {
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

    if (input.keyword && input.keyword.trim()) {
      const kw = input.keyword.trim().toLowerCase().replace(/"/g, '\\"');
      filters.push(
        `FILTER(CONTAINS(LCASE(COALESCE(STR(?title), "")), "${kw}") || CONTAINS(LCASE(STR(?celexNumber)), "${kw}"))`,
      );
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

    if (input.case_type) {
      const pattern = CASE_TYPE_PATTERN[input.case_type];
      if (pattern) {
        filters.push(`FILTER(CONTAINS(STR(?celexNumber), "${pattern}"))`);
      }
    }

    if (input.date_from && input.date_from.trim()) {
      filters.push(`FILTER(?date >= "${input.date_from.trim()}"^^xsd:date)`);
    }
    if (input.date_to && input.date_to.trim()) {
      filters.push(`FILTER(?date <= "${input.date_to.trim()}"^^xsd:date)`);
    }

    // Titles live on expressions, not works. Traverse the expression graph:
    // ?expr cdm:expression_belongs_to_work ?work (inverse of cdm:work_has_expression)
    // ?expr cdm:expression_uses_language <.../ENG>
    // ?expr cdm:expression_title ?title
    //
    // GROUP BY ?work collapses each work to one row. A work can carry several
    // cdm:work_has_resource-type values (corrigenda hold 2–3); without grouping these
    // cross-product into duplicate rows that SELECT DISTINCT cannot merge (?type
    // differs per row), and LIMIT/OFFSET would then page over raw rows rather than
    // works. GROUP_CONCAT gathers every resource-type URI per work; SAMPLE picks the
    // single-valued display fields. Aggregate aliases are renamed (?celex/?docDate/
    // ?docTitle) because a projected AS-variable cannot reuse a name already in scope.
    const sparql = `
SELECT ?work
  (SAMPLE(?celexNumber) AS ?celex)
  (GROUP_CONCAT(DISTINCT STR(?type); SEPARATOR=" ") AS ?types)
  (SAMPLE(?date) AS ?docDate)
  (SAMPLE(?title) AS ?docTitle) WHERE {
  ?work cdm:resource_legal_id_celex ?celexNumber .
  OPTIONAL { ?work cdm:work_has_resource-type ?type . }
  OPTIONAL { ?work cdm:work_date_document ?date . }
  OPTIONAL {
    ?expr cdm:expression_belongs_to_work ?work .
    ?expr cdm:expression_uses_language <${ENG_LANGUAGE_URI}> .
    ?expr cdm:expression_title ?title .
  }
  ${filters.join('\n  ')}
} GROUP BY ?work ORDER BY DESC(?docDate) LIMIT ${input.limit} OFFSET ${input.offset}`;

    const queryEcho = {
      ...(input.case_number ? { case_number: input.case_number } : {}),
      ...(celexFragment ? { celex_fragment: celexFragment } : {}),
      ...(input.keyword ? { keyword: input.keyword } : {}),
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
      } = {
        work_uri: CellarSparqlService.bindingValue(b, 'work') ?? '',
        celex_number: CellarSparqlService.bindingValue(b, 'celex') ?? '',
      };
      const resourceType = resolveResourceTypeLabels(CellarSparqlService.bindingValue(b, 'types'));
      if (resourceType) c.resource_type = resourceType;
      const date = CellarSparqlService.bindingValue(b, 'docDate');
      if (date) c.date = date;
      const title = CellarSparqlService.bindingValue(b, 'docTitle');
      if (title) c.title = title;
      return c;
    });

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
      lines.push(`### ${c.celex_number}${c.title ? ` — ${c.title}` : ''}`);
      if (c.date) lines.push(`**Date:** ${c.date}`);
      if (c.resource_type) lines.push(`**Type:** ${c.resource_type}`);
      lines.push(`**Work URI:** ${c.work_uri}`);
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
