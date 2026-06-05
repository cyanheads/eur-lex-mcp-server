/**
 * @fileoverview eurlex_get_cases — Search CJEU and General Court case law.
 * @module mcp-server/tools/definitions/eurlex-get-cases
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
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

export const eurlex_get_cases = tool('eurlex_get_cases', {
  title: 'Search CJEU/GC Case Law',
  description:
    'Search CJEU (Court of Justice of the EU) and General Court case law — judgments, orders, and Advocate General opinions. ' +
    'Distinct from eurlex_search_documents because case law uses CELEX sector 6 and practitioners search it differently: ' +
    'by case number, court, party name, or AG opinion type. ' +
    'Keyword search applies to case titles and CELEX strings only — full-text body search is not available. ' +
    'Case numbers follow the pattern C-{num}/{year} for CJEU and T-{num}/{year} for General Court. ' +
    'Returns case identifier, court, date, document type, and title (where available). ' +
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
      .enum(['CJEU', 'GC'])
      .optional()
      .describe('Court filter: CJEU = Court of Justice of the EU, GC = General Court.'),
    case_type: z
      .enum(['judgment', 'order', 'ag_opinion'])
      .optional()
      .describe(
        'Case type filter: judgment, order (procedural decision), or ag_opinion (Advocate General opinion).',
      ),
    date_from: z
      .string()
      .optional()
      .describe('Start of date range in ISO 8601 format (YYYY-MM-DD).'),
    date_to: z.string().optional().describe('End of date range in ISO 8601 format (YYYY-MM-DD).'),
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
                'CDM resource type URI indicating the case type (e.g. .../resource-type/JUDG for Judgment). Absent for some older cases.',
              ),
            date: z.string().optional().describe('Judgment/opinion date in ISO 8601 format.'),
            title: z
              .string()
              .optional()
              .describe(
                'Case title where available (e.g. "Google Spain SL v AEPD"). Absent for many older cases.',
              ),
          })
          .describe('A single CJEU or General Court case law record.'),
      )
      .describe('Matching case law records ordered by date descending.'),
    total: z.number().describe('Number of cases returned in this page (not a corpus-wide count).'),
    offset: z.number().describe('Pagination offset used for this response.'),
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

    if (input.case_number && input.case_number.trim()) {
      // Convert standard case number format to CELEX substring
      // e.g. C-131/12 → search for "131" and "12" in celex
      const cn = input.case_number.trim().replace(/"/g, '\\"');
      filters.push(
        `FILTER(CONTAINS(LCASE(STR(?title)), LCASE("${cn}")) || CONTAINS(LCASE(STR(?celexNumber)), LCASE("${cn}")))`,
      );
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

    const sparql = `
SELECT DISTINCT ?work ?celexNumber ?type ?date ?title WHERE {
  ?work cdm:resource_legal_id_celex ?celexNumber .
  OPTIONAL { ?work cdm:work_has_resource-type ?type . }
  OPTIONAL { ?work cdm:work_date_document ?date . }
  OPTIONAL { ?work cdm:work_title ?titleNode . ?titleNode cdm:expression_title ?title . FILTER(LANG(?title) = "en") }
  ${filters.join('\n  ')}
} ORDER BY DESC(?date) LIMIT ${input.limit} OFFSET ${input.offset}`;

    const bindings = await svc.query(sparql, ctx);
    ctx.log.info('Case law search', {
      caseNumber: input.case_number,
      keyword: input.keyword,
      court: input.court,
      caseType: input.case_type,
      resultCount: bindings.length,
    });

    if (bindings.length === 0) {
      throw ctx.fail('no_results', 'No case law records matched the search criteria.', {
        ...ctx.recoveryFor('no_results'),
      });
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
        celex_number: CellarSparqlService.bindingValue(b, 'celexNumber') ?? '',
      };
      const type = CellarSparqlService.bindingValue(b, 'type');
      if (type) c.resource_type = type;
      const date = CellarSparqlService.bindingValue(b, 'date');
      if (date) c.date = date;
      const title = CellarSparqlService.bindingValue(b, 'title');
      if (title) c.title = title;
      return c;
    });

    return { cases, total: cases.length, offset: input.offset };
  },

  format: (result) => {
    const lines: string[] = [
      `## CJEU/GC Case Law (${result.total} results, offset ${result.offset})\n`,
    ];
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
