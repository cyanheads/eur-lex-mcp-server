/**
 * @fileoverview eurlex_get_document — Fetch metadata and full text of an EU act by CELEX number.
 * @module mcp-server/tools/definitions/eurlex-get-document
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  ENG_LANGUAGE_URI,
  resolveCorporateBodyLabel,
  resolveResourceTypeLabel,
} from '@/services/cellar-sparql/cdm-labels.js';
import {
  CellarSparqlService,
  getCellarSparqlService,
} from '@/services/cellar-sparql/cellar-sparql-service.js';
import { escapeSparqlLiteral, resolveEliToWork } from '@/services/cellar-sparql/eli-resolution.js';
import {
  type ContentFormat,
  type EurLexLanguage,
  getEurLexContentService,
} from '@/services/eurlex-content/eurlex-content-service.js';

export const eurlex_get_document = tool('eurlex_get_document', {
  title: 'Get EU Document',
  description:
    'Fetch the notice (metadata) and full text of an EU act by CELEX number or ELI URI. ' +
    'Returns structured metadata — title, date, document type, author institution, legal basis, EuroVoc subjects — ' +
    'plus the HTML or Formex4 XML content in the requested language. ' +
    'Defaults to English (EN); not all works have content in all 24 official EU languages, ' +
    'especially older acts pre-2004 EU enlargement. ' +
    'If the requested language is unavailable, the server automatically falls back to English and notes the fallback. ' +
    'CELEX format: {sector}{year}{type}{number} e.g. 32016R0679 for GDPR. ' +
    'Use eurlex_lookup_celex to validate an identifier before calling this tool. ' +
    'HTML format returns the full act text suitable for reading; XML returns Formex4 for structured processing.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    celex_number: z
      .string()
      .optional()
      .describe(
        'CELEX number of the act to fetch (e.g. 32016R0679 for GDPR). ' +
          'Provide exactly one of celex_number or eli_uri.',
      ),
    eli_uri: z
      .string()
      .optional()
      .describe(
        'Work-level ELI URI of the act to fetch, resolved to its CELLAR work (e.g. ' +
          'http://data.europa.eu/eli/reg/2016/679, with or without the /oj suffix). ' +
          'Provide exactly one of celex_number or eli_uri.',
      ),
    language: z
      .string()
      .regex(/^[A-Za-z]{2,3}$/)
      .default('EN')
      .describe(
        'Language code for document content (ISO 639-1 uppercase, e.g. EN, FR, DE). ' +
          'Defaults to EN. Falls back to EN if the requested language is unavailable.',
      ),
    format: z
      .enum(['html', 'xml'])
      .default('html')
      .describe(
        'Content format: "html" for readable HTML text (default), "xml" for Formex4 XML structured format.',
      ),
  }),
  output: z.object({
    celex_number: z.string().describe('Confirmed CELEX number for the retrieved work.'),
    work_uri: z.string().optional().describe('CELLAR work URI.'),
    title: z
      .string()
      .optional()
      .describe(
        'Document title in the requested language (absent for some older works and judgments).',
      ),
    date: z.string().optional().describe('Document date in ISO 8601 format (YYYY-MM-DD).'),
    resource_type: z
      .string()
      .optional()
      .describe(
        'Human-readable document type label (e.g. "Regulation", "Directive"). Absent for some older works.',
      ),
    author_institution: z
      .string()
      .optional()
      .describe(
        'Human-readable name of the originating EU institution (e.g. "European Parliament", "Council of the EU"). Absent when not recorded.',
      ),
    legal_basis: z
      .array(z.string().describe('CELEX number or URI of a legal basis act.'))
      .optional()
      .describe('Legal basis acts for this work.'),
    eurovoc_subjects: z
      .array(z.string().describe('EuroVoc concept URI.'))
      .optional()
      .describe('EuroVoc subject classifications.'),
    in_force: z.boolean().optional().describe('Whether the act is currently in force.'),
    content: z
      .string()
      .optional()
      .describe('Full text content of the act in the requested format and language.'),
    content_available: z.boolean().describe('Whether document content was successfully retrieved.'),
    language: z.string().describe('Language code of the returned content.'),
    language_fallback: z
      .string()
      .optional()
      .describe(
        'Human-readable note explaining the fallback that occurred (e.g. "Requested FR content unavailable; returned EN"). Present only when a fallback happened.',
      ),
    content_format: z.string().describe('Format of the returned content: "html" or "xml".'),
  }),

  errors: [
    {
      reason: 'invalid_identifier_args',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Neither celex_number nor eli_uri was provided, or both were.',
      recovery: 'Provide exactly one of celex_number or eli_uri.',
    },
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'CELEX number or ELI URI not found in CELLAR — the work does not exist in the corpus.',
      recovery: 'Verify the identifier or use eurlex_lookup_celex to confirm it exists.',
    },
    {
      reason: 'language_unavailable',
      code: JsonRpcErrorCode.NotFound,
      when: 'Requested language has no content in EUR-Lex after fallback to English also failed.',
      recovery:
        'Retry with language "EN" explicitly, or accept content_available: false and use metadata only.',
    },
    {
      reason: 'content_fetch_failed',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'EUR-Lex content API returned non-200 after language fallback attempts.',
      recovery:
        'The EUR-Lex content API may be temporarily unavailable. Retry after a short delay.',
    },
  ],

  async handler(input, ctx) {
    const sparqlSvc = getCellarSparqlService();
    const contentSvc = getEurLexContentService();

    // Accept exactly one identifier: a CELEX number, or an ELI URI resolved to
    // its CELLAR work. Treat empty/whitespace as absent so form-based clients
    // that send "" for an omitted field route to the friendly guard, not -32602.
    // An ELI is resolved to its CELLAR work via the shared #5 resolution
    // (cdm:resource_legal_eli exact-match + bare-work /oj retry), then the rest
    // of the flow (metadata + content) is keyed on the confirmed CELEX.
    const celexInput = input.celex_number?.trim();
    const eliInput = input.eli_uri?.trim();

    let celexNumber: string;
    if (eliInput && !celexInput) {
      const binding = await resolveEliToWork(sparqlSvc, eliInput, ctx);
      const resolvedCelex = binding && CellarSparqlService.bindingValue(binding, 'celexNumber');
      if (!resolvedCelex) {
        throw ctx.fail('not_found', `No CELLAR work found for ELI: ${eliInput}`, {
          ...ctx.recoveryFor('not_found'),
        });
      }
      celexNumber = resolvedCelex;
    } else if (celexInput && !eliInput) {
      celexNumber = celexInput;
    } else {
      throw ctx.fail(
        'invalid_identifier_args',
        celexInput
          ? 'Provide only one of celex_number or eli_uri, not both.'
          : 'Provide either celex_number or eli_uri.',
        { ...ctx.recoveryFor('invalid_identifier_args') },
      );
    }

    const language = (input.language.trim().toUpperCase() || 'EN') as EurLexLanguage;
    const format = input.format as ContentFormat;
    const safeCelexNumber = escapeSparqlLiteral(celexNumber);

    // Step 1: Fetch metadata via SPARQL
    const metaSparql = `
SELECT ?work ?celexNumber ?type ?date ?title ?inForce ?author ?legalBasis ?eurovoc WHERE {
  ?work cdm:resource_legal_id_celex ?celexNumber .
  FILTER(STR(?celexNumber) = "${safeCelexNumber}")
  OPTIONAL { ?work cdm:work_has_resource-type ?type . }
  OPTIONAL { ?work cdm:work_date_document ?date . }
  OPTIONAL {
    ?expr cdm:expression_belongs_to_work ?work .
    ?expr cdm:expression_uses_language <${ENG_LANGUAGE_URI}> .
    ?expr cdm:expression_title ?title .
  }
  OPTIONAL { ?work cdm:resource_legal_in-force ?inForce . }
  OPTIONAL { ?work cdm:work_created_by_agent ?author . }
  OPTIONAL { ?work cdm:resource_legal_based_on_resource_legal ?legalBasis . }
  OPTIONAL { ?work cdm:work_is_about_concept_eurovoc ?eurovoc . }
} LIMIT 20`;

    const metaBindings = await sparqlSvc.query(metaSparql, ctx);
    ctx.log.info('Document metadata fetch', { celexNumber, resultCount: metaBindings.length });

    if (metaBindings.length === 0) {
      throw ctx.fail('not_found', `No CELLAR work found for CELEX: ${celexNumber}`, {
        ...ctx.recoveryFor('not_found'),
      });
    }

    // Aggregate repeated fields from multi-row result
    const first = metaBindings[0];
    const legalBases = new Set<string>();
    const eurovocConcepts = new Set<string>();
    for (const b of metaBindings) {
      const lb = CellarSparqlService.bindingValue(b, 'legalBasis');
      if (lb) legalBases.add(lb);
      const ev = CellarSparqlService.bindingValue(b, 'eurovoc');
      if (ev) eurovocConcepts.add(ev);
    }

    const workUri = CellarSparqlService.bindingValue(first, 'work');
    const confirmedCelex = CellarSparqlService.bindingValue(first, 'celexNumber') ?? celexNumber;
    const resourceType = CellarSparqlService.bindingValue(first, 'type');
    const date = CellarSparqlService.bindingValue(first, 'date');
    const title = CellarSparqlService.bindingValue(first, 'title');
    const inForceStr = CellarSparqlService.bindingValue(first, 'inForce');
    const inForce = inForceStr !== undefined ? inForceStr === 'true' : undefined;
    const authorUri = CellarSparqlService.bindingValue(first, 'author');

    // Step 2: Fetch document content via EUR-Lex content API
    const contentResult = await contentSvc.fetchContent(celexNumber, language, format, ctx);

    const result: {
      celex_number: string;
      work_uri?: string;
      title?: string;
      date?: string;
      resource_type?: string;
      author_institution?: string;
      legal_basis?: string[];
      eurovoc_subjects?: string[];
      in_force?: boolean;
      content?: string;
      content_available: boolean;
      language: string;
      language_fallback?: string;
      content_format: string;
    } = {
      celex_number: confirmedCelex,
      content_available: contentResult.contentAvailable,
      language: contentResult.language,
      content_format: format,
    };

    if (workUri) result.work_uri = workUri;
    if (title) result.title = title;
    if (date) result.date = date;
    if (resourceType) result.resource_type = resolveResourceTypeLabel(resourceType);
    if (authorUri) result.author_institution = resolveCorporateBodyLabel(authorUri);
    if (legalBases.size > 0) result.legal_basis = [...legalBases];
    if (eurovocConcepts.size > 0) result.eurovoc_subjects = [...eurovocConcepts];
    if (typeof inForce === 'boolean') result.in_force = inForce;
    if (contentResult.contentAvailable && contentResult.content) {
      result.content = contentResult.content;
    }
    if (contentResult.languageFallback) {
      result.language_fallback = contentResult.languageFallback;
    }

    return result;
  },

  format: (result) => {
    const lines: string[] = [
      `## ${result.celex_number}${result.title ? ` — ${result.title}` : ''}\n`,
    ];
    if (result.date) lines.push(`**Date:** ${result.date}`);
    if (result.resource_type) lines.push(`**Type:** ${result.resource_type}`);
    if (result.author_institution) lines.push(`**Author:** ${result.author_institution}`);
    if (typeof result.in_force === 'boolean') lines.push(`**In Force:** ${result.in_force}`);
    if (result.work_uri) lines.push(`**Work URI:** ${result.work_uri}`);
    if (result.legal_basis && result.legal_basis.length > 0) {
      lines.push(`**Legal Basis:** ${result.legal_basis.join(', ')}`);
    }
    if (result.eurovoc_subjects && result.eurovoc_subjects.length > 0) {
      lines.push(
        `**EuroVoc Subjects:** ${result.eurovoc_subjects.slice(0, 5).join(', ')}${result.eurovoc_subjects.length > 5 ? ` (+${result.eurovoc_subjects.length - 5} more)` : ''}`,
      );
    }
    lines.push(`**Language:** ${result.language} | **Format:** ${result.content_format}`);
    if (result.language_fallback) lines.push(`*Note: ${result.language_fallback}*`);
    lines.push(`**Content Available:** ${result.content_available}`);
    if (result.content_available && result.content) {
      lines.push('');
      lines.push('---');
      lines.push('');
      // Truncate very large content for format() output
      const maxLen = 8000;
      if (result.content.length > maxLen) {
        lines.push(result.content.slice(0, maxLen));
        lines.push(
          `\n*[Content truncated — ${result.content.length} chars total. Use the CELEX number to fetch directly.]*`,
        );
      } else {
        lines.push(result.content);
      }
    } else if (!result.content_available) {
      lines.push('');
      lines.push('*Document content is not available for this work in the requested language.*');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
