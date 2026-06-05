/**
 * @fileoverview eurlex_search_documents — Search EU legislation, case law, and preparatory acts.
 * @module mcp-server/tools/definitions/eurlex-search-documents
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  CellarSparqlService,
  getCellarSparqlService,
} from '@/services/cellar-sparql/cellar-sparql-service.js';

/** CDM resource type URIs for common document categories. */
const DOCUMENT_TYPE_URIS: Record<string, string> = {
  REG: 'http://publications.europa.eu/resource/authority/resource-type/REG',
  DIR: 'http://publications.europa.eu/resource/authority/resource-type/DIR',
  DEC: 'http://publications.europa.eu/resource/authority/resource-type/DEC',
  TREATY: 'http://publications.europa.eu/resource/authority/resource-type/TREATY',
  JUDG: 'http://publications.europa.eu/resource/authority/resource-type/JUDG',
  OPIN_AG: 'http://publications.europa.eu/resource/authority/resource-type/OPIN_AG',
  PROP: 'http://publications.europa.eu/resource/authority/resource-type/PROP_DIR',
  REC: 'http://publications.europa.eu/resource/authority/resource-type/REC_SOFT',
};

export const eurlex_search_documents = tool('eurlex_search_documents', {
  title: 'Search EU Documents',
  description:
    'Search EU legislation, treaties, and preparatory acts across the CELLAR corpus of 2.7M+ works. ' +
    'Filters by document type, date range, EuroVoc subject concept, author institution, and in-force status. ' +
    'Keyword search applies to document titles and CELEX strings only — full-text body search is not available via this API. ' +
    'For multi-word searches, supply a single dominant keyword; use other filters to narrow results. ' +
    'Returns CELEX numbers, work URIs, document types, and dates — use these with eurlex_get_document to fetch full content. ' +
    'To filter by EuroVoc subject, first call eurlex_browse_subjects to obtain the concept URI. ' +
    'Case law (CJEU/GC judgments) is better searched via eurlex_get_cases which has court-specific parameters.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    keyword: z
      .string()
      .optional()
      .describe(
        'Keyword to match against document titles. Single dominant word recommended; multi-word phrase uses substring match.',
      ),
    document_type: z
      .enum(['REG', 'DIR', 'DEC', 'TREATY', 'JUDG', 'OPIN_AG', 'PROP', 'REC'])
      .optional()
      .describe(
        'Document type filter: REG=Regulation, DIR=Directive, DEC=Decision, TREATY=Treaty, ' +
          'JUDG=Judgment, OPIN_AG=AG Opinion, PROP=Proposal, REC=Recommendation.',
      ),
    date_from: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe('Start of date range in ISO 8601 format (YYYY-MM-DD). Matches document date.'),
    date_to: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe('End of date range in ISO 8601 format (YYYY-MM-DD). Matches document date.'),
    eurovoc_concept: z
      .string()
      .startsWith('http')
      .refine((v) => !v.includes('>') && !v.includes('"') && !v.includes(' '), {
        message: 'EuroVoc URI must be a valid http URI with no angle brackets, quotes, or spaces.',
      })
      .optional()
      .describe(
        'EuroVoc concept URI to filter by subject (e.g. http://eurovoc.europa.eu/2828). ' +
          'Obtain concept URIs from eurlex_browse_subjects first.',
      ),
    author_institution: z
      .string()
      .optional()
      .describe(
        'Author institution name filter (e.g. "European Parliament", "Council"). Substring match.',
      ),
    in_force: z
      .boolean()
      .optional()
      .describe(
        'If true, restrict to acts currently in force. Omit to return all regardless of in-force status.',
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
    documents: z
      .array(
        z
          .object({
            work_uri: z.string().describe('CELLAR work URI (stable resource identifier).'),
            celex_number: z.string().describe('CELEX identifier for the work.'),
            resource_type: z
              .string()
              .optional()
              .describe(
                'CDM resource type URI indicating the document category (e.g. .../resource-type/REG for Regulation). Absent for some older works.',
              ),
            date: z.string().optional().describe('Document date in ISO 8601 format (YYYY-MM-DD).'),
            title: z
              .string()
              .optional()
              .describe(
                'Document title in English where available; absent for many older works and judgments.',
              ),
          })
          .describe('A single EU legislative work with its CELEX number, type, and date.'),
      )
      .describe('Matching EU documents ordered by date descending.'),
    total: z
      .number()
      .describe('Number of documents returned in this page (not a corpus-wide count).'),
    offset: z.number().describe('Pagination offset used for this response.'),
  }),

  errors: [
    {
      reason: 'no_results',
      code: JsonRpcErrorCode.NotFound,
      when: 'The query returned zero bindings — no matching documents in CELLAR.',
      recovery:
        'Broaden the search by removing filters, trying a shorter keyword, or expanding the date range.',
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

    const filters: string[] = [];
    if (input.keyword && input.keyword.trim()) {
      const kw = input.keyword.trim().toLowerCase().replace(/"/g, '\\"');
      filters.push(
        `FILTER(CONTAINS(LCASE(COALESCE(STR(?title), "")), "${kw}") || CONTAINS(LCASE(STR(?celexNumber)), "${kw}"))`,
      );
    }
    if (input.document_type) {
      const typeUri = DOCUMENT_TYPE_URIS[input.document_type];
      if (typeUri) {
        filters.push(`FILTER(?type = <${typeUri}>)`);
      }
    }
    if (input.date_from && input.date_from.trim()) {
      filters.push(`FILTER(?date >= "${input.date_from.trim()}"^^xsd:date)`);
    }
    if (input.date_to && input.date_to.trim()) {
      filters.push(`FILTER(?date <= "${input.date_to.trim()}"^^xsd:date)`);
    }
    if (input.in_force === true) {
      filters.push(`FILTER(?inForce = true)`);
    }

    const eurovocClause =
      input.eurovoc_concept && input.eurovoc_concept.trim()
        ? `?work cdm:work_is_about_concept_eurovoc <${input.eurovoc_concept.trim()}> .`
        : '';

    const authorClause =
      input.author_institution && input.author_institution.trim()
        ? `OPTIONAL { ?work cdm:work_created_by_agent ?agent . ?agent cdm:corporate-body_label ?agentLabel . FILTER(LANG(?agentLabel) = "en") FILTER(CONTAINS(LCASE(STR(?agentLabel)), "${input.author_institution.trim().toLowerCase().replace(/"/g, '\\"')}")) }`
        : '';

    const inForceClause =
      input.in_force === true ? `OPTIONAL { ?work cdm:resource_legal_in-force ?inForce . }` : '';

    const sparql = `
SELECT DISTINCT ?work ?celexNumber ?type ?date ?title WHERE {
  ?work cdm:resource_legal_id_celex ?celexNumber .
  OPTIONAL { ?work cdm:work_has_resource-type ?type . }
  OPTIONAL { ?work cdm:work_date_document ?date . }
  OPTIONAL { ?work cdm:work_title ?titleNode . ?titleNode cdm:expression_title ?title . FILTER(LANG(?title) = "en") }
  ${eurovocClause}
  ${authorClause}
  ${inForceClause}
  ${filters.join('\n  ')}
} ORDER BY DESC(?date) LIMIT ${input.limit} OFFSET ${input.offset}`;

    const bindings = await svc.query(sparql, ctx);
    ctx.log.info('Document search', {
      keyword: input.keyword,
      documentType: input.document_type,
      resultCount: bindings.length,
      offset: input.offset,
    });

    if (bindings.length === 0) {
      throw ctx.fail('no_results', 'No documents matched the search criteria.', {
        ...ctx.recoveryFor('no_results'),
      });
    }

    const documents = bindings.map((b) => {
      const doc: {
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
      if (type) doc.resource_type = type;
      const date = CellarSparqlService.bindingValue(b, 'date');
      if (date) doc.date = date;
      const title = CellarSparqlService.bindingValue(b, 'title');
      if (title) doc.title = title;
      return doc;
    });

    return { documents, total: documents.length, offset: input.offset };
  },

  format: (result) => {
    const lines: string[] = [
      `## EU Documents (${result.total} results, offset ${result.offset})\n`,
    ];
    for (const doc of result.documents) {
      lines.push(`### ${doc.celex_number}${doc.title ? ` — ${doc.title}` : ''}`);
      if (doc.date) lines.push(`**Date:** ${doc.date}`);
      if (doc.resource_type) lines.push(`**Type:** ${doc.resource_type}`);
      lines.push(`**Work URI:** ${doc.work_uri}`);
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
