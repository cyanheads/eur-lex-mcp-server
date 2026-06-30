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

/**
 * Default character window returned for body content in "paged" mode — bounds a
 * single call while keeping small acts whole. The tail of a larger act is never
 * lost: page forward with `offset`, or request `content_mode: "full"`.
 */
const DEFAULT_CONTENT_LIMIT = 25_000;

/** Hard ceiling on one paged window. Use `content_mode: "full"` for the whole body in a single call. */
const MAX_CONTENT_LIMIT = 100_000;

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
    'HTML format returns the full act text suitable for reading; XML returns Formex4 for structured processing. ' +
    'Large bodies are bounded per call but never lost: content_mode "paged" (default) returns a character window ' +
    '(offset + limit) alongside content_chars_total and has_more, so you can page to the end and reconstruct the whole act; ' +
    'content_mode "full" returns the entire body in one call; content_mode "metadata_only" returns metadata with no body and skips the content fetch.',
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
    content_mode: z
      .enum(['metadata_only', 'paged', 'full'])
      .default('paged')
      .describe(
        'How much of the document body to return. "paged" (default) returns a bounded character window — see offset/limit; ' +
          '"full" returns the entire body in one call (large acts can be hundreds of KB); ' +
          '"metadata_only" returns metadata with no body and skips the content fetch. offset and limit apply only to "paged".',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Character offset into the full document body where the returned window starts ("paged" mode only). ' +
          'Page forward by setting offset = content_offset + content_chars_returned from the previous call.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_CONTENT_LIMIT)
      .default(DEFAULT_CONTENT_LIMIT)
      .describe(
        `Maximum characters of body content to return in this window ("paged" mode only). Default ${DEFAULT_CONTENT_LIMIT}, max ${MAX_CONTENT_LIMIT}. ` +
          'For the entire body in one response, use content_mode "full" instead of a large limit.',
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
      .describe(
        'Body content of the act in the requested format and language. In "paged" mode this is a character window ' +
          '(see content_offset / content_chars_returned / has_more); in "full" mode the entire body; ' +
          'omitted in "metadata_only" mode, when the window is empty (offset past the end), or when content is unavailable.',
      ),
    content_mode: z
      .string()
      .describe('Content mode applied to this response: "metadata_only", "paged", or "full".'),
    content_available: z
      .boolean()
      .describe(
        'Whether body content was fetched from EUR-Lex. False in "metadata_only" mode (no fetch attempted) — ' +
          'use content_mode to distinguish "not requested" from "unavailable upstream".',
      ),
    content_offset: z
      .number()
      .int()
      .optional()
      .describe(
        'Character offset where the returned content window begins. Present when a body was fetched and available.',
      ),
    content_chars_returned: z
      .number()
      .int()
      .optional()
      .describe(
        'Number of body characters returned in this response (equals content length). Present when a body was fetched and available.',
      ),
    content_chars_total: z
      .number()
      .int()
      .optional()
      .describe(
        'Total character length of the full document body. Present when content was fetched and available; ' +
          'use with content_offset to page through the entire act.',
      ),
    has_more: z
      .boolean()
      .describe(
        'True when body content exists beyond the returned window. Page forward with offset = content_offset + content_chars_returned, ' +
          'or request content_mode "full" for the entire act in one call. Always false in "metadata_only" mode.',
      ),
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

    // Step 2: assemble metadata, then shape the body per content_mode. The body
    // is one navigable mechanism — "metadata_only" skips the fetch entirely,
    // "full" returns the whole body, and "paged" returns a bounded
    // [offset, offset+limit) window with content_chars_total + has_more so the
    // tail is always reachable. The same shaped `content` feeds both
    // structuredContent and format(); there is no separate truncation downstream.
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
      content_mode: string;
      content_available: boolean;
      content_offset?: number;
      content_chars_returned?: number;
      content_chars_total?: number;
      has_more: boolean;
      language: string;
      language_fallback?: string;
      content_format: string;
    } = {
      celex_number: confirmedCelex,
      content_mode: input.content_mode,
      content_available: false,
      has_more: false,
      language,
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

    if (input.content_mode !== 'metadata_only') {
      const contentResult = await contentSvc.fetchContent(celexNumber, language, format, ctx);
      result.content_available = contentResult.contentAvailable;
      result.language = contentResult.language;
      if (contentResult.languageFallback) {
        result.language_fallback = contentResult.languageFallback;
      }

      if (contentResult.contentAvailable && contentResult.content) {
        const full = contentResult.content;
        const total = full.length;
        result.content_chars_total = total;

        if (input.content_mode === 'full') {
          result.content = full;
          result.content_offset = 0;
          result.content_chars_returned = total;
          result.has_more = false;
        } else {
          // Bounded [offset, offset+limit) window over the full body. offset is
          // clamped to the body length so over-paging returns an empty window
          // (has_more false) rather than erroring.
          const offset = Math.min(input.offset, total);
          const windowText = full.slice(offset, offset + input.limit);
          result.content_offset = offset;
          result.content_chars_returned = windowText.length;
          result.has_more = offset + windowText.length < total;
          if (windowText.length > 0) result.content = windowText;
        }
      }
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

    // Body rendering honors the same window as structuredContent.content — the
    // shaped content is emitted verbatim with a navigation line; no second cut.
    if (result.content_mode === 'metadata_only') {
      lines.push('');
      lines.push(
        '*Body omitted (content_mode "metadata_only"). Request content_mode "paged" or "full" to retrieve the text.*',
      );
    } else if (result.content_available) {
      const total = result.content_chars_total ?? result.content?.length ?? 0;
      if (result.content) {
        const start = result.content_offset ?? 0;
        const returned = result.content_chars_returned ?? result.content.length;
        const end = start + returned;
        if (result.content_mode === 'full') {
          lines.push(`**Content** (full): full body — ${returned} of ${total} characters.`);
        } else {
          lines.push(
            `**Content** (${result.content_mode}): characters ${start}–${end} of ${total} (${returned} returned).` +
              (result.has_more
                ? ` More available — page forward with offset=${end}, or content_mode="full" for the entire act.`
                : ' End of document.'),
          );
        }
        lines.push('');
        lines.push('---');
        lines.push('');
        lines.push(result.content);
      } else {
        lines.push('');
        lines.push(
          `*No content at offset ${result.content_offset ?? 0} — past the end of the ${total}-character body. Lower offset to read.*`,
        );
      }
    } else {
      lines.push('');
      lines.push('*Document content is not available for this work in the requested language.*');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
