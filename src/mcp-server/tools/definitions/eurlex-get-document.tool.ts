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
import {
  CELEX_PATTERN,
  escapeSparqlLiteral,
  isSafeSparqlIri,
  resolveEliToWork,
} from '@/services/cellar-sparql/eli-resolution.js';
import {
  type CurrentConsolidated,
  findCurrentConsolidated,
} from '@/services/cellar-sparql/relation-traversal.js';
import type { SparqlBinding } from '@/services/cellar-sparql/types.js';
import {
  type ActHeading,
  extractSections,
  parseActStructure,
  type SectionSelectors,
  type SelectedSection,
} from '@/services/eurlex-content/act-structure.js';
import {
  type ContentFormat,
  type ContentUnavailabilityReason,
  EURLEX_LANGUAGES,
  type EurLexLanguage,
  getEurLexContentService,
} from '@/services/eurlex-content/eurlex-content-service.js';

/**
 * Default character window returned for body content in "paged" mode — bounds a
 * single call while keeping small acts whole. The tail of a larger act is never
 * lost: page forward with `offset`.
 */
const DEFAULT_CONTENT_LIMIT = 25_000;

/** Hard ceiling on any one body window, including an oversized "full" request. */
const MAX_CONTENT_LIMIT = 100_000;

/** Case-insensitive pattern derived from the canonical supported-language list. */
const EURLEX_LANGUAGE_PATTERN = new RegExp(
  `^(?:${EURLEX_LANGUAGES.map((code) =>
    [...code].map((letter) => `[${letter}${letter.toLowerCase()}]`).join(''),
  ).join('|')})$`,
);

/**
 * Present HTML/XML source as literal text without allowing source-owned tildes
 * to close the surrounding CommonMark fence.
 */
function formatLiteralSource(content: string, format: 'html' | 'xml'): string {
  let longestTildeRun = 0;
  for (const run of content.matchAll(/~+/g)) {
    longestTildeRun = Math.max(longestTildeRun, run[0].length);
  }
  const fence = '~'.repeat(Math.max(3, longestTildeRun + 1));
  const closingSeparator = content.endsWith('\n') ? '' : '\n';
  return `${fence}${format}\n${content}${closingSeparator}${fence}`;
}

/**
 * Per-dimension row cap for the multi-valued metadata queries (authors, legal
 * bases, EuroVoc subjects). Each dimension is fetched in its own query — never a
 * cross-product — so this bounds a single dimension in isolation, comfortably
 * above any real act (a handful of authors, a dozen legal bases, ~20 subjects).
 * The service caps further if MAX_SPARQL_RESULTS is lower.
 */
const META_DIMENSION_LIMIT = 100;

export const eurlex_get_document = tool('eurlex_get_document', {
  title: 'Get EU Document',
  description:
    'Fetch the metadata and full text of an EU act by CELEX number, ELI URI, or work URI. Returns structured metadata (title, date, type, author institution, legal basis, EuroVoc subjects, in-force status) plus the act body as HTML, Markdown, or Formex4 XML, defaulting to English with automatic fallback. Every body returned in one call is capped at 100,000 characters — paged and full windows page onward with offset/limit; use outline: true for a heading map and select to pull specific articles, chapters, recitals, or annexes, reading a selected section on its own from the offset and chars in selected_sections.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    celex_number: z
      .union([
        z.literal(''),
        z
          .string()
          .overwrite((value) => value.trim().toUpperCase())
          .regex(
            CELEX_PATTERN,
            'celex_number must be a CELEX identifier — a sector character followed by the year, type letters, and number (e.g. 32016R0679). Resolve a citation to its CELEX with eurlex_lookup_celex first.',
          )
          .describe(
            'CELEX number of the act (e.g. 32016R0679 for GDPR). Surrounding whitespace is trimmed and the value is uppercased before validation.',
          ),
      ])
      .optional()
      .describe(
        'CELEX number of the act to fetch (e.g. 32016R0679 for GDPR). Provide exactly one of celex_number, eli_uri, or work_uri.',
      ),
    eli_uri: z
      .string()
      .optional()
      .describe(
        'Work-level ELI URI of the act to fetch (e.g. http://data.europa.eu/eli/reg/2016/679, with or without the /oj suffix). Provide exactly one of celex_number, eli_uri, or work_uri.',
      ),
    work_uri: z
      .string()
      .refine((v) => !v || isSafeSparqlIri(v), {
        message: 'work_uri must be a valid http URI with no whitespace, angle brackets, or quotes.',
      })
      .optional()
      .describe(
        'CELLAR work resource URI to fetch (e.g. http://publications.europa.eu/resource/cellar/3e485e15-11bd-11e6-ba9a-01aa75ed71a1) — the form returned by eurlex_lookup_celex, eurlex_get_relations, and eurlex_search_documents. Provide exactly one of celex_number, eli_uri, or work_uri.',
      ),
    resolve: z
      .enum(['as_requested', 'current_consolidated'])
      .default('as_requested')
      .describe(
        'Which version to serve for a base act with newer consolidated versions. "as_requested" (default) returns the exact CELEX requested; "current_consolidated" serves the newest consolidated version instead (echoing the request in requested_celex), a no-op when none exists. Either way, is_superseded / current_consolidated_celex / consolidated_as_of flag a stale base act.',
      ),
    language: z
      .string()
      .regex(EURLEX_LANGUAGE_PATTERN, 'language must be one of the 24 supported EUR-Lex codes')
      .overwrite((value) => value.toUpperCase())
      .pipe(z.enum(EURLEX_LANGUAGES))
      .default('EN')
      .describe(
        'One of the 24 supported two-letter EUR-Lex language codes (e.g. EN, FR, DE), accepted case-insensitively and normalized to uppercase. Defaults to EN, and falls back to EN if the requested language is unavailable.',
      ),
    format: z
      .enum(['html', 'xml', 'markdown'])
      .default('html')
      .describe(
        'Content format: "html" for the act text as served by EUR-Lex (default), "markdown" for that HTML converted to clean Markdown server-side, or "xml" for Formex4 structured XML.',
      ),
    content_mode: z
      .enum(['metadata_only', 'paged', 'full'])
      .default('paged')
      .describe(
        `How much of the body to return. "paged" (default) returns an offset/limit window; "full" requests from the start and returns at most ${MAX_CONTENT_LIMIT} characters with continuation metadata when more exists; "metadata_only" skips the content fetch. offset and limit apply only to "paged".`,
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Character offset into the body where the returned window starts ("paged" mode only). Page forward by setting offset = content_offset + content_chars_returned from the previous call. Offsets are format-specific: an offset is only valid against the same format it was measured in — keep format constant when paging.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_CONTENT_LIMIT)
      .default(DEFAULT_CONTENT_LIMIT)
      .describe(
        `Maximum characters to return in this window ("paged" mode only). Default ${DEFAULT_CONTENT_LIMIT}, max ${MAX_CONTENT_LIMIT}. Follow has_more and the returned offsets until false to reconstruct the complete body.`,
      ),
    outline: z
      .boolean()
      .default(false)
      .describe(
        'Return a structural outline of the act — chapters, sections, articles, annexes, and recitals as a heading list, each with its character offset — instead of body text. Read a section by paging with its offset, keeping the same format: outline offsets are measured in the requested format\'s body and land in the wrong place under any other format. Ignores offset/limit and select; no detectable structure returns an empty outline. Not applied in content_mode "metadata_only".',
      ),
    select: z
      .object({
        articles: z.string().optional().describe('Comma-separated article numbers, e.g. "1,5,17".'),
        chapters: z
          .string()
          .optional()
          .describe('Comma-separated chapter numbers, Roman or Arabic, e.g. "I,IV" or "1,4".'),
        recitals: z.string().optional().describe('Comma-separated recital numbers, e.g. "1,10".'),
        annexes: z
          .string()
          .optional()
          .describe('Comma-separated annex numbers or letters, e.g. "I,II".'),
      })
      .optional()
      .describe(
        'Return only the text of specific sections by type and number, instead of a raw character window (Roman and Arabic numbers are equivalent). Sections are located in the body of the requested format, so pair select with the same format used for any outline. A section that cannot be located is reported in selection.missed with no wrong text returned. Ignored when outline is true or in content_mode "metadata_only".',
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
        'Human-readable name of the primary (first) originating EU institution (e.g. "European Parliament", "Council of the EU"). For co-legislated acts, prefer author_institutions for the complete set. Absent when not recorded.',
      ),
    author_institutions: z
      .array(z.string().describe('Human-readable EU institution name.'))
      .optional()
      .describe(
        'All originating EU institutions, for co-legislated acts adopted by more than one body (e.g. ["European Parliament", "Council of the EU"]). Absent when none recorded.',
      ),
    legal_basis: z
      .array(
        z
          .object({
            work_uri: z
              .string()
              .describe(
                'CELLAR work URI of the legal basis act. When celex_number is present, pass either as work_uri or celex_number to eurlex_get_document to fetch that act; a basis with no CELEX is a CELLAR reference that may not resolve to a fetchable work.',
              ),
            celex_number: z
              .string()
              .optional()
              .describe(
                'CELEX number of the legal basis act (e.g. 12012E016 for TFEU Article 16). Absent when CELLAR records no CELEX for the work.',
              ),
          })
          .describe('A legal basis act: its CELLAR work URI plus its CELEX number when recorded.'),
      )
      .optional()
      .describe('Legal basis acts for this work. Absent when none are recorded.'),
    eurovoc_subjects: z
      .array(
        z
          .object({
            concept_uri: z
              .string()
              .describe(
                'EuroVoc concept URI (http://eurovoc.europa.eu/{id}), the exact value the eurovoc_concept filter of eurlex_search_documents accepts.',
              ),
            label: z
              .string()
              .optional()
              .describe(
                'EuroVoc preferred label in the requested language. Absent when the concept has no label in that language.',
              ),
          })
          .describe('An EuroVoc subject: its concept URI plus its preferred label when available.'),
      )
      .optional()
      .describe('EuroVoc subject classifications. Absent when none are recorded.'),
    in_force: z.boolean().optional().describe('Whether the act is currently in force.'),
    is_superseded: z
      .boolean()
      .optional()
      .describe(
        'True when a newer consolidated version of the requested base act exists (an unofficial reading aid merging later amendments), so the returned text may not include those amendments. Not a repeal/replacement signal — the base act remains the law and may still be in force (see in_force). Absent when the act has no consolidated version, or is itself one.',
      ),
    current_consolidated_celex: z
      .string()
      .optional()
      .describe(
        'CELEX of the newest consolidated version of the requested base act (e.g. 02014R0833-20260424) — fetch it with eurlex_get_document, or pass resolve "current_consolidated". Present only when is_superseded is true.',
      ),
    consolidated_as_of: z
      .string()
      .optional()
      .describe(
        'Consolidation date of current_consolidated_celex in ISO 8601 (YYYY-MM-DD). Present only when is_superseded is true.',
      ),
    requested_celex: z
      .string()
      .optional()
      .describe(
        'The originally requested CELEX, echoed when resolve "current_consolidated" served a different (consolidated) work. celex_number holds the CELEX actually served. Absent when the served work is the one requested.',
      ),
    content: z
      .string()
      .optional()
      .describe(
        `Body content of the act in the requested format and language. In "paged" mode this is the requested window; in "full" mode it starts at zero; under select it is the matched sections joined in document order. Every one is capped at ${MAX_CONTENT_LIMIT} characters. Omitted in "metadata_only" mode, when the window is empty, or when content is unavailable.`,
      ),
    content_mode: z
      .string()
      .describe('Content mode applied to this response: "metadata_only", "paged", or "full".'),
    content_available: z
      .boolean()
      .describe(
        'Whether body content was fetched from EUR-Lex. False in "metadata_only" mode (no fetch attempted) — use content_mode to distinguish "not requested" from "unavailable upstream".',
      ),
    content_status: z
      .enum(['not_requested', 'available', 'unavailable'])
      .describe(
        'Body resolution status: "not_requested" for metadata-only calls, "available" when a body was resolved, or "unavailable" after ordinary resolution attempts returned no usable body.',
      ),
    content_unavailability_reason: z
      .enum(['no_representation', 'upstream_failure', 'multipart_incomplete'])
      .optional()
      .describe(
        'Why content_status is "unavailable": no representation exists, the upstream request failed, or a multipart Formex body could not be assembled completely.',
      ),
    content_offset: z
      .number()
      .int()
      .optional()
      .describe(
        'Character offset where the returned contiguous window begins. Present in "paged" and "full" modes. Absent for outline and select responses, whose content is not a contiguous span — read selected_sections for each matched section\'s own offset.',
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
        'Total character length of the full document body. Present when content was fetched and available; use with content_offset to page through the entire act.',
      ),
    has_more: z
      .boolean()
      .describe(
        'True when body content exists beyond the returned contiguous window. Continue in "paged" mode with offset = content_offset + content_chars_returned until false. Always false in "metadata_only" mode, and always false for outline and select responses, where that recipe cannot resume across disjoint slices — a cut selection is disclosed through the truncated enrichment instead.',
      ),
    language: z.string().describe('Language code of the returned content.'),
    requested_language: z
      .string()
      .optional()
      .describe(
        'Originally requested language code when English fallback changed the effective language reported in language.',
      ),
    language_fallback: z
      .string()
      .optional()
      .describe(
        'Human-readable note explaining the fallback that occurred (e.g. "Requested FR content unavailable; returned EN"). Present only when a fallback happened.',
      ),
    content_format: z
      .string()
      .describe('Format of the returned content: "html", "markdown", or "xml".'),
    outline: z
      .array(
        z
          .object({
            kind: z
              .string()
              .describe(
                'Structural unit kind: "chapter", "section", "article", "annex", or "recital".',
              ),
            number: z
              .string()
              .describe(
                'Numbering token as rendered (e.g. "17", "IV"); empty for a lone unnumbered annex.',
              ),
            label: z.string().describe('Human label, e.g. "Article 17", "CHAPTER IV".'),
            title: z.string().optional().describe('Descriptive title where the act supplies one.'),
            offset: z
              .number()
              .int()
              .describe(
                'Character offset of the heading in the full body of the requested format — pass as offset in a paged call to read from here.',
              ),
          })
          .describe('One detected heading, addressable by its character offset into the body.'),
      )
      .optional()
      .describe(
        'Structural outline of the act. Present only when outline is true; an empty array means no structure was detected.',
      ),
    selection: z
      .object({
        requested: z
          .array(z.string())
          .describe('Section descriptors requested, e.g. ["Article 17", "CHAPTER IV"].'),
        matched: z
          .array(z.string())
          .describe('Section descriptors located in the body, in document order.'),
        missed: z
          .array(z.string())
          .describe('Requested section descriptors that could not be located.'),
      })
      .optional()
      .describe(
        `Outcome of a structural selection. Present only when select was used; content holds the matched sections joined in document order, capped at ${MAX_CONTENT_LIMIT} characters. When the cap cuts the join, a trailing matched section may be partly or wholly absent from content — read selected_sections for each one's own address.`,
      ),
    selected_sections: z
      .array(
        z
          .object({
            label: z.string().describe('Section descriptor, e.g. "Article 17".'),
            offset: z
              .number()
              .int()
              .describe(
                'Character offset of the section in the full body of the requested format — pass as offset in a paged call to read it.',
              ),
            chars: z
              .number()
              .int()
              .describe(
                'Characters the section spans in the source body — pass as limit alongside offset to read exactly this section. A section longer than the maximum window is read by paging forward from offset instead.',
              ),
          })
          .describe('One selected section, addressable on its own through the paging floor.'),
      )
      .optional()
      .describe(
        'Source address of each section the selection sliced, in document order. Present only when select was used. A selection is a set of disjoint slices, not a contiguous window, so these addresses — not content_offset — are how a caller navigates one; every section stays individually reachable even when the cap cut its text.',
      ),
    structure_detected: z
      .boolean()
      .optional()
      .describe(
        'Whether any act structure was parsed from the body. Present when outline or select was used; false means no detectable chapter/article/annex structure — read it via offset/limit or content_mode "full".',
      ),
  }),

  enrichment: {
    truncated: z.boolean().optional().describe('True when the returned body window was capped.'),
    shown: z.number().int().optional().describe('Number of body characters returned.'),
    cap: z.number().int().optional().describe('Maximum body characters allowed in the window.'),
    notice: z.string().optional().describe('How to retrieve the remaining document content.'),
  },

  errors: [
    {
      reason: 'invalid_identifier_args',
      code: JsonRpcErrorCode.ValidationError,
      when: 'None of celex_number, eli_uri, or work_uri was provided, or more than one was.',
      recovery: 'Provide exactly one of celex_number, eli_uri, or work_uri.',
    },
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The CELEX, ELI, or work URI resolves to no fetchable work — the work is absent from the corpus, or the CELLAR work carries no CELEX number.',
      recovery:
        'Verify the identifier with eurlex_lookup_celex; a CELLAR work with no CELEX cannot be fetched as a document.',
    },
    {
      reason: 'content_challenge',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The primary content response is an AWS WAF bot-challenge interstitial rather than legal text.',
      recovery:
        'Retry shortly, or use content_mode "metadata_only" while the content host challenge persists.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const sparqlSvc = getCellarSparqlService();
    const contentSvc = getEurLexContentService();

    // Accept exactly one identifier: a CELEX number, an ELI URI resolved to its
    // CELLAR work, or a CELLAR work URI dereferenced to its CELEX. Treat
    // empty/whitespace as absent so form-based clients sending "" for an omitted
    // field route to the friendly guard, not a raw -32602. An ELI is resolved via
    // the shared #5 resolution (cdm:resource_legal_eli exact-match + bare-work /oj
    // retry); a work_uri (the form eurlex_lookup_celex / get_relations / search
    // emit) is dereferenced by cdm:resource_legal_id_celex. Every path lands on a
    // CELEX, which keys the rest of the flow.
    const celexInput = input.celex_number?.trim();
    const eliInput = input.eli_uri?.trim();
    const workUriInput = input.work_uri?.trim();
    const providedCount = [celexInput, eliInput, workUriInput].filter(Boolean).length;

    let requestedCelex: string;
    if (providedCount !== 1) {
      throw ctx.fail(
        'invalid_identifier_args',
        providedCount === 0
          ? 'Provide one of celex_number, eli_uri, or work_uri.'
          : 'Provide only one of celex_number, eli_uri, or work_uri, not multiple.',
        { ...ctx.recoveryFor('invalid_identifier_args') },
      );
    } else if (celexInput) {
      requestedCelex = celexInput;
    } else if (eliInput) {
      const binding = await resolveEliToWork(sparqlSvc, eliInput, ctx);
      const resolvedCelex = binding && CellarSparqlService.bindingValue(binding, 'celexNumber');
      if (!resolvedCelex) {
        throw ctx.fail('not_found', `No CELLAR work found for ELI: ${eliInput}`, {
          ...ctx.recoveryFor('not_found'),
        });
      }
      requestedCelex = resolvedCelex;
    } else {
      // work_uri (#34): dereference the CELLAR work to its CELEX. A work with no
      // CELEX (some CONS_TEXT member/manifestation works) can't be fetched by the
      // CELEX-keyed flow — report that honestly, never as a mislabeled ELI. The
      // refine already guaranteed the URI is safe to interpolate inside <...>.
      const safeWorkUri = workUriInput as string;
      const derefBindings = await sparqlSvc.query(
        `SELECT ?celex WHERE {\n  <${safeWorkUri}> cdm:resource_legal_id_celex ?celex .\n} LIMIT 1`,
        ctx,
      );
      const resolvedCelex =
        derefBindings[0] && CellarSparqlService.bindingValue(derefBindings[0], 'celex');
      if (!resolvedCelex) {
        throw ctx.fail(
          'not_found',
          `This CELLAR work carries no CELEX number and cannot be fetched as a document: ${safeWorkUri}`,
          { ...ctx.recoveryFor('not_found') },
        );
      }
      requestedCelex = resolvedCelex;
    }

    const language = input.language as EurLexLanguage;
    const format = input.format as ContentFormat;

    // Metadata fetch (#33): one query per multi-valued dimension, never a
    // cross-product. The old single query was a LIMIT-20 cross-product of author ×
    // legalBasis × eurovoc, so a heavily-classified act could drop source rows
    // before aggregation — and authors were read from the first row only, losing
    // co-legislators. Each dimension now gets its own query (as
    // relation-traversal.ts runs one per relation type); the core query carries the
    // single-valued fields. No dimension can truncate another.
    const fetchMetadata = async (celex: string) => {
      const safe = escapeSparqlLiteral(celex);
      const coreQuery = `
SELECT ?work ?celexNumber ?type ?date ?title ?inForce WHERE {
  ?work cdm:resource_legal_id_celex ?celexNumber .
  FILTER(STR(?celexNumber) = "${safe}")
  OPTIONAL { ?work cdm:work_has_resource-type ?type . }
  OPTIONAL { ?work cdm:work_date_document ?date . }
  OPTIONAL {
    ?expr cdm:expression_belongs_to_work ?work .
    ?expr cdm:expression_uses_language <${ENG_LANGUAGE_URI}> .
    ?expr cdm:expression_title ?title .
  }
  OPTIONAL { ?work cdm:resource_legal_in-force ?inForce . }
} LIMIT 5`;
      const dimensionQuery = (predicate: string, variable: string) => `
SELECT ?${variable} WHERE {
  ?work cdm:resource_legal_id_celex ?c .
  FILTER(STR(?c) = "${safe}")
  ?work ${predicate} ?${variable} .
} LIMIT ${META_DIMENSION_LIMIT}`;
      // Legal bases and EuroVoc subjects resolve inline (#67): each dimension
      // query joins the identifying literal (CELEX / language-filtered
      // skos:prefLabel) as an OPTIONAL and groups per URI, so the label rides the
      // same round trip and a URI with no label still yields its row.
      const legalBasisQuery = `
SELECT ?legalBasis (SAMPLE(?celexValue) AS ?celex) WHERE {
  ?work cdm:resource_legal_id_celex ?c .
  FILTER(STR(?c) = "${safe}")
  ?work cdm:resource_legal_based_on_resource_legal ?legalBasis .
  OPTIONAL { ?legalBasis cdm:resource_legal_id_celex ?celexValue . }
} GROUP BY ?legalBasis LIMIT ${META_DIMENSION_LIMIT}`;
      const eurovocQuery = `
SELECT ?eurovoc (SAMPLE(?labelValue) AS ?label) WHERE {
  ?work cdm:resource_legal_id_celex ?c .
  FILTER(STR(?c) = "${safe}")
  ?work cdm:work_is_about_concept_eurovoc ?eurovoc .
  OPTIONAL {
    ?eurovoc skos:prefLabel ?labelValue .
    FILTER(LANG(?labelValue) = "${language.toLowerCase()}")
  }
} GROUP BY ?eurovoc LIMIT ${META_DIMENSION_LIMIT}`;

      const [coreBindings, authorBindings, legalBasisBindings, eurovocBindings] = await Promise.all(
        [
          sparqlSvc.query(coreQuery, ctx),
          sparqlSvc.query(dimensionQuery('cdm:work_created_by_agent', 'author'), ctx),
          sparqlSvc.query(legalBasisQuery, ctx),
          sparqlSvc.query(eurovocQuery, ctx),
        ],
      );

      const collect = (bindings: SparqlBinding[], variable: string): string[] => {
        const set = new Set<string>();
        for (const b of bindings) {
          const v = CellarSparqlService.bindingValue(b, variable);
          if (v) set.add(v);
        }
        return [...set];
      };
      /** One entry per distinct URI, carrying the companion literal when bound. */
      const collectResolved = (
        bindings: SparqlBinding[],
        uriVariable: string,
        literalVariable: string,
      ): { uri: string; literal?: string }[] => {
        const byUri = new Map<string, string | undefined>();
        for (const b of bindings) {
          const uri = CellarSparqlService.bindingValue(b, uriVariable);
          if (!uri) continue;
          const literal = CellarSparqlService.bindingValue(b, literalVariable);
          if (!byUri.has(uri) || (literal && !byUri.get(uri))) byUri.set(uri, literal);
        }
        return [...byUri].map(([uri, literal]) => ({ uri, ...(literal ? { literal } : {}) }));
      };

      const first = coreBindings[0];
      return {
        found: Boolean(first),
        workUri: CellarSparqlService.bindingValue(first, 'work'),
        confirmedCelex: CellarSparqlService.bindingValue(first, 'celexNumber') ?? celex,
        resourceType: CellarSparqlService.bindingValue(first, 'type'),
        date: CellarSparqlService.bindingValue(first, 'date'),
        title: CellarSparqlService.bindingValue(first, 'title'),
        inForce: CellarSparqlService.parseBoolean(
          CellarSparqlService.bindingValue(first, 'inForce'),
        ),
        authorUris: collect(authorBindings, 'author'),
        legalBases: collectResolved(legalBasisBindings, 'legalBasis', 'celex').map(
          ({ uri, literal }) => ({ work_uri: uri, ...(literal ? { celex_number: literal } : {}) }),
        ),
        eurovoc: collectResolved(eurovocBindings, 'eurovoc', 'label').map(({ uri, literal }) => ({
          concept_uri: uri,
          ...(literal ? { label: literal } : {}),
        })),
      };
    };

    const fetchBody = (celex: string) =>
      input.content_mode === 'metadata_only'
        ? Promise.resolve(null)
        : contentSvc.fetchContent(celex, language, format, ctx);

    // Staleness detection + opt-in resolution (#29). findCurrentConsolidated is
    // self-contained (resolves the base work by CELEX), so on the default path it
    // runs concurrently with the metadata + content fetch and adds no serial
    // latency. resolve "current_consolidated" must know which work to serve before
    // fetching, so it awaits detection first — an inherent serial step on the
    // opt-in path only. The staleness fields always describe the REQUESTED base
    // act, whichever work is served.
    let staleness: CurrentConsolidated | undefined;
    let servedCelex = requestedCelex;
    let metaResult: Awaited<ReturnType<typeof fetchMetadata>>;
    let body: Awaited<ReturnType<typeof fetchBody>>;

    if (input.resolve === 'current_consolidated') {
      staleness = await findCurrentConsolidated(sparqlSvc, requestedCelex, ctx);
      servedCelex = staleness?.celex ?? requestedCelex;
      [metaResult, body] = await Promise.all([fetchMetadata(servedCelex), fetchBody(servedCelex)]);
    } else {
      [metaResult, body, staleness] = await Promise.all([
        fetchMetadata(requestedCelex),
        fetchBody(requestedCelex),
        findCurrentConsolidated(sparqlSvc, requestedCelex, ctx),
      ]);
    }

    ctx.log.info('Document metadata fetch', {
      requestedCelex,
      servedCelex,
      superseded: Boolean(staleness),
    });

    if (!metaResult.found) {
      throw ctx.fail('not_found', `No CELLAR work found for CELEX: ${servedCelex}`, {
        ...ctx.recoveryFor('not_found'),
      });
    }

    // Step 2: assemble metadata, then shape the body per content_mode. The body
    // is one navigable mechanism — "metadata_only" skips the fetch entirely,
    // "full" returns the first per-call window, and "paged" returns a bounded
    // [offset, offset+limit) window with content_chars_total + has_more so the
    // tail is always reachable through subsequent calls. The same shaped
    // `content` feeds both structuredContent and format(); there is no separate
    // truncation downstream.
    const result: {
      celex_number: string;
      requested_celex?: string;
      work_uri?: string;
      title?: string;
      date?: string;
      resource_type?: string;
      author_institution?: string;
      author_institutions?: string[];
      legal_basis?: { work_uri: string; celex_number?: string }[];
      eurovoc_subjects?: { concept_uri: string; label?: string }[];
      in_force?: boolean;
      is_superseded?: boolean;
      current_consolidated_celex?: string;
      consolidated_as_of?: string;
      content?: string;
      content_mode: string;
      content_available: boolean;
      content_status: 'not_requested' | 'available' | 'unavailable';
      content_unavailability_reason?: ContentUnavailabilityReason;
      content_offset?: number;
      content_chars_returned?: number;
      content_chars_total?: number;
      has_more: boolean;
      language: string;
      requested_language?: string;
      language_fallback?: string;
      content_format: string;
      outline?: ActHeading[];
      selection?: { requested: string[]; matched: string[]; missed: string[] };
      selected_sections?: SelectedSection[];
      structure_detected?: boolean;
    } = {
      celex_number: metaResult.confirmedCelex,
      content_mode: input.content_mode,
      content_available: false,
      content_status: input.content_mode === 'metadata_only' ? 'not_requested' : 'unavailable',
      has_more: false,
      language,
      content_format: format,
    };

    if (metaResult.workUri) result.work_uri = metaResult.workUri;
    if (metaResult.title) result.title = metaResult.title;
    if (metaResult.date) result.date = metaResult.date;
    if (metaResult.resourceType) {
      result.resource_type = resolveResourceTypeLabel(metaResult.resourceType);
    }
    // #33: surface every author. author_institution stays the primary (first) for
    // back-compat; author_institutions carries the full set (labels deduped, since
    // distinct URIs like EMA/EMEA share a label).
    if (metaResult.authorUris.length > 0) {
      const institutions = [...new Set(metaResult.authorUris.map(resolveCorporateBodyLabel))];
      const [primary] = institutions;
      if (primary) {
        result.author_institution = primary;
        result.author_institutions = institutions;
      }
    }
    if (metaResult.legalBases.length > 0) result.legal_basis = metaResult.legalBases;
    if (metaResult.eurovoc.length > 0) result.eurovoc_subjects = metaResult.eurovoc;
    if (typeof metaResult.inForce === 'boolean') result.in_force = metaResult.inForce;

    // #29: staleness describes the requested base act. When resolve served a
    // different (consolidated) work, echo the original request so the redirect is
    // visible — celex_number already holds the served CELEX.
    if (staleness) {
      result.is_superseded = true;
      result.current_consolidated_celex = staleness.celex;
      result.consolidated_as_of = staleness.asOf;
    }
    if (servedCelex !== requestedCelex) {
      result.requested_celex = requestedCelex;
    }

    /** Uncapped size of a structural selection, set only when the cap cut it. */
    let selectedCharsBeforeCap: number | undefined;

    if (body) {
      result.content_available = body.contentAvailable;
      result.content_status = body.contentAvailable ? 'available' : 'unavailable';
      result.language = body.language;
      if (body.language !== language) {
        result.requested_language = language;
      }
      if (body.languageFallback) {
        result.language_fallback = body.languageFallback;
      }
      if (!body.contentAvailable && body.unavailabilityReason) {
        result.content_unavailability_reason = body.unavailabilityReason;
      }

      if (body.contentAvailable && body.content) {
        const full = body.content;
        const total = full.length;
        result.content_chars_total = total;

        if (input.outline) {
          // Structure-only view: the detected headings and their offsets into the
          // same body the floor pages, no body text. Ignores offset/limit/select.
          // No parseable structure yields an empty outline, never an error.
          const headings = parseActStructure(full, format);
          result.outline = headings;
          result.structure_detected = headings.length > 0;
          result.content_chars_returned = 0;
          result.has_more = false;
        } else if (input.select) {
          // Structural selection: return only the requested sections' text. A miss
          // (bad number, or no structure at all) is reported in selection.missed
          // with no body returned — never the wrong section — and the paging floor
          // stays available. Applies on top of the requested format.
          //
          // #80: the join is a set of disjoint slices, so it takes the same
          // per-call ceiling as paged/full but NOT their continuation protocol —
          // has_more's recipe (offset + chars_returned) describes a contiguous
          // window and cannot resume here. The cut is disclosed through the
          // truncated enrichment, and selected_sections carries each section's own
          // source address so every one stays individually reachable through the
          // paging floor (#12).
          const headings = parseActStructure(full, format);
          result.structure_detected = headings.length > 0;
          const selection = extractSections(full, headings, input.select as SectionSelectors);
          result.selection = {
            requested: selection.requested,
            matched: selection.matched,
            missed: selection.missed,
          };
          result.selected_sections = selection.sections;
          result.has_more = false;
          const windowText = selection.text.slice(0, MAX_CONTENT_LIMIT);
          if (windowText.length < selection.text.length) {
            selectedCharsBeforeCap = selection.text.length;
          }
          result.content_chars_returned = windowText.length;
          if (windowText.length > 0) result.content = windowText;
        } else if (input.content_mode === 'full') {
          const windowText = full.slice(0, MAX_CONTENT_LIMIT);
          result.content = windowText;
          result.content_offset = 0;
          result.content_chars_returned = windowText.length;
          result.has_more = windowText.length < total;
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

    // Truncation disclosure. A contiguous window discloses through has_more plus a
    // continuation offset; a capped selection has no resumable offset, so it
    // discloses through this enrichment alone and points at the per-section
    // addresses instead (#80).
    if (result.has_more) {
      const nextOffset = (result.content_offset ?? 0) + (result.content_chars_returned ?? 0);
      const cap = input.content_mode === 'full' ? MAX_CONTENT_LIMIT : input.limit;
      ctx.enrich.truncated({
        shown: result.content_chars_returned ?? 0,
        cap,
        guidance: `More document content is available. Continue with content_mode="paged" and offset=${nextOffset}.`,
      });
    } else if (selectedCharsBeforeCap !== undefined) {
      ctx.enrich.truncated({
        shown: result.content_chars_returned ?? 0,
        cap: MAX_CONTENT_LIMIT,
        guidance: `The selected sections total ${selectedCharsBeforeCap} characters and were cut at the ${MAX_CONTENT_LIMIT}-character body cap. Read a section on its own with content_mode="paged", passing its offset and chars from selected_sections, or select fewer sections.`,
      });
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
    if (result.author_institutions && result.author_institutions.length > 0) {
      lines.push(`**Authors:** ${result.author_institutions.join(', ')}`);
    }
    if (typeof result.in_force === 'boolean') lines.push(`**In Force:** ${result.in_force}`);
    // #29 staleness — each field renders in its own block so the format-parity
    // sentinel walk sees every one; is_superseded is present only when true.
    if (result.is_superseded) {
      lines.push('**Superseded:** true — a newer consolidated version exists.');
    }
    if (result.current_consolidated_celex) {
      lines.push(`**Current consolidated:** ${result.current_consolidated_celex}`);
    }
    if (result.consolidated_as_of) {
      lines.push(`**Consolidated as of:** ${result.consolidated_as_of}`);
    }
    if (result.requested_celex) {
      lines.push(
        `**Requested CELEX:** ${result.requested_celex} (served ${result.celex_number} instead)`,
      );
    }
    if (result.work_uri) lines.push(`**Work URI:** ${result.work_uri}`);
    if (result.legal_basis && result.legal_basis.length > 0) {
      lines.push(
        `**Legal Basis:** ${result.legal_basis
          .map((lb) => (lb.celex_number ? `${lb.celex_number} (${lb.work_uri})` : lb.work_uri))
          .join('; ')}`,
      );
    }
    if (result.eurovoc_subjects && result.eurovoc_subjects.length > 0) {
      // Render the full list for format parity with structuredContent — the set is
      // bounded at META_DIMENSION_LIMIT (100) and real acts carry ~a dozen, so
      // there is no length reason to cut it (previously truncated to 5).
      lines.push(
        `**EuroVoc Subjects:** ${result.eurovoc_subjects
          .map((s) => (s.label ? `${s.label} (${s.concept_uri})` : s.concept_uri))
          .join('; ')}`,
      );
    }
    lines.push(`**Language:** ${result.language} | **Format:** ${result.content_format}`);
    if (result.requested_language) {
      lines.push(
        `**Requested language:** ${result.requested_language} | **Effective content language:** ${result.language}`,
      );
    }
    if (result.language_fallback) lines.push(`*Note: ${result.language_fallback}*`);
    lines.push(`**Content status:** ${result.content_status}`);
    if (result.content_unavailability_reason) {
      lines.push(`**Content unavailable because:** ${result.content_unavailability_reason}`);
    }

    // Body rendering honors the same window as structuredContent.content — the
    // shaped content is emitted verbatim with a navigation line; no second cut.
    if (result.content_mode === 'metadata_only') {
      lines.push('');
      lines.push(
        '*Body omitted (content_mode "metadata_only"). Request content_mode "paged" or "full" to retrieve the text.*',
      );
    } else if (result.content_available) {
      const total = result.content_chars_total ?? result.content?.length ?? 0;
      const start = result.content_offset ?? 0;
      const returned = result.content_chars_returned ?? result.content?.length ?? 0;
      const end = start + returned;

      // Navigation status — one line per view that shaped the body, so every
      // navigation field (content_mode, content_offset, content_chars_returned /
      // total, has_more) reaches the text channel too. Outline and selection each
      // get their own line and the contiguous-window line is gated on
      // content_offset: neither returns a contiguous span, so describing either as
      // a character range would report a window that does not exist (#80).
      if (result.outline) {
        lines.push(
          `**Body** (${result.content_mode}, outline): structure only — ${result.outline.length} heading${result.outline.length === 1 ? '' : 's'} indexed over a ${total}-character body, ${returned} body characters returned. Read a section by paging with its offset.`,
        );
      }
      if (result.selection) {
        const sections = result.selected_sections ?? [];
        lines.push(
          `**Body** (${result.content_mode}, selection): ${returned} characters from ${sections.length} disjoint section${sections.length === 1 ? '' : 's'} of a ${total}-character body — not a contiguous window, so there is no continuation offset (has_more ${result.has_more}).`,
        );
        if (returned >= MAX_CONTENT_LIMIT) {
          lines.push(
            `Capped at ${MAX_CONTENT_LIMIT} characters — a trailing section may be cut. Read one on its own with content_mode="paged" at its offset and chars below.`,
          );
        }
      }
      if (result.content_offset !== undefined) {
        if (result.content_mode === 'full' && result.has_more) {
          lines.push(
            `**Body** (full request, capped): characters ${start}–${end} of ${total} (${returned} returned). ` +
              `Continue with content_mode="paged" and offset=${end}.`,
          );
        } else if (result.content_mode === 'full') {
          lines.push(
            `**Body** (full): full body — ${returned} of ${total} characters from offset ${start}.`,
          );
        } else {
          lines.push(
            `**Body** (${result.content_mode}): characters ${start}–${end} of ${total} (${returned} returned).` +
              (result.has_more
                ? ` More available — continue with content_mode="paged" and offset=${end}.`
                : ''),
          );
        }
      }

      if (result.outline) {
        if (result.outline.length > 0) {
          lines.push('');
          lines.push(
            `**Outline** — ${result.outline.length} section${result.outline.length === 1 ? '' : 's'} detected. Read one by paging with its offset (content_mode "paged", offset=…):`,
          );
          lines.push('');
          for (const h of result.outline) {
            lines.push(
              `- \`offset ${h.offset}\` — [${h.kind} ${h.number}] ${h.label}${h.title ? `: ${h.title}` : ''}`,
            );
          }
        } else {
          lines.push('');
          lines.push(
            `*No act structure detected in the ${total}-character ${result.content_format} body (e.g. case law or a non-standard layout). Use content_mode "paged"/"full" to read it.*`,
          );
        }
      }

      if (result.selection) {
        lines.push('');
        lines.push(
          `**Selection** — requested: ${result.selection.requested.join(', ') || '(none)'}.`,
        );
        if (result.selection.matched.length > 0) {
          lines.push(`Returned: ${result.selection.matched.join(', ')}.`);
        }
        if (result.selection.missed.length > 0) {
          lines.push(
            `Not found: ${result.selection.missed.join(', ')} — ${result.structure_detected ? 'no such section in this act' : 'no act structure detected'}. ` +
              'Use offset/limit or content_mode "full" to read the act.',
          );
        }
      }

      // Per-section addresses: the navigation a disjoint selection actually has.
      // Each doubles as the paged call that re-reads that section alone (#12).
      if (result.selected_sections && result.selected_sections.length > 0) {
        lines.push(
          `Section addresses (content_mode "paged", offset/limit): ${result.selected_sections
            .map((s) => `${s.label} — offset ${s.offset}, ${s.chars} chars`)
            .join('; ')}.`,
        );
      }

      if (result.content) {
        lines.push('');
        lines.push('---');
        lines.push('');
        lines.push(
          result.content_format === 'html' || result.content_format === 'xml'
            ? formatLiteralSource(result.content, result.content_format)
            : result.content,
        );
      } else if (!result.outline && !result.selection) {
        lines.push('');
        lines.push(
          `*No content at offset ${start} — past the end of the ${total}-character body. Lower offset to read.*`,
        );
      }
    } else {
      lines.push('');
      lines.push('*Document content is not available for this work in the requested language.*');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
