/**
 * @fileoverview eurlex_get_document — Fetch metadata and full text of an EU act by CELEX number.
 * @module mcp-server/tools/definitions/eurlex-get-document
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { ENG_LANGUAGE_URI, resolveResourceTypeLabel } from '@/services/cellar-sparql/cdm-labels.js';
import {
  CellarSparqlService,
  getCellarSparqlService,
} from '@/services/cellar-sparql/cellar-sparql-service.js';
import {
  CELEX_PATTERN,
  isSafeSparqlIri,
  resolveEliToWork,
} from '@/services/cellar-sparql/eli-resolution.js';
import {
  type ConsolidationBase,
  findConsolidation,
  isConsolidatedCelex,
} from '@/services/cellar-sparql/relation-traversal.js';
import type { SparqlBinding } from '@/services/cellar-sparql/types.js';
import { fetchWorkAgents } from '@/services/cellar-sparql/work-agents.js';
import { resolveCelexWorks } from '@/services/cellar-sparql/work-resolution.js';
import {
  type ActHeading,
  collapseRecitals,
  extractSections,
  outermostSections,
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

/** CELLAR's end-of-validity value for an act with no end date. */
const OPEN_ENDED_VALIDITY = '9999-12-31';

/**
 * The text channel's closing line for a body that did not resolve, keyed on why
 * (#108): only an absent representation is a matter of language, and the
 * English fallback was tried whenever another language was asked for.
 */
function unavailableBodyNote(
  reason: ContentUnavailabilityReason | undefined,
  format: string,
  language: string,
): string {
  switch (reason) {
    case 'no_representation':
      return `*No ${format} body exists for this work in the requested language${language === 'EN' ? '' : ' or in English'}.*`;
    case 'upstream_failure':
      return '*The content host failed to return this work’s body; retry shortly.*';
    case 'multipart_incomplete':
      return '*This work’s Formex 4 body comes in parts that could not all be read, so none was assembled; format "html" or "markdown" may still serve it.*';
    default:
      return '*Document content is not available for this work.*';
  }
}

export const eurlex_get_document = tool('eurlex_get_document', {
  title: 'Get EU Document',
  description:
    'Fetch the metadata and full text of an EU act by CELEX number, ELI URI, or work URI. Returns structured metadata (title, date, type, author institution, Advocates General, legal basis, EuroVoc subjects, in-force status and, for an act not in force, its repealing acts, end of validity, or pending entry into force) plus the act body as HTML, Markdown, or Formex4 XML, defaulting to English with automatic fallback. Every body returned in one call is capped at 100,000 characters — paged and full windows page onward with offset/limit; use outline: true for a heading map and select to pull specific articles, chapters, recitals, or annexes, reading a selected section on its own from the offset and chars in selected_sections.',
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
        'CELLAR work resource URI to fetch (e.g. http://publications.europa.eu/resource/cellar/3e485e15-11bd-11e6-ba9a-01aa75ed71a1) — the form returned by eurlex_lookup_celex, eurlex_get_relations, and eurlex_search_documents. A work carrying several CELEX numbers (a national implementing measure, one per directive it was notified against) is served under its lowest, with a notice giving the count; each names the same document, so pass celex_number to serve a specific one. Provide exactly one of celex_number, eli_uri, or work_uri.',
      ),
    resolve: z
      .enum(['as_requested', 'current_consolidated'])
      .default('as_requested')
      .describe(
        'Which version to serve. "as_requested" (default) returns the exact CELEX requested; "current_consolidated" serves the newest consolidated version in effect of the requested act — or, for a consolidated CELEX, of its base act — echoing the request in requested_celex, and is a no-op when none exists (with a notice when the act\'s only consolidated versions are dated in the future). Either way, is_superseded / current_consolidated_celex / consolidated_as_of describe the text served.',
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
        `Maximum characters to return in this window ("paged" mode only; select ignores it). Default ${DEFAULT_CONTENT_LIMIT}, max ${MAX_CONTENT_LIMIT}. Follow has_more and the returned offsets until false to reconstruct the complete body.`,
      ),
    outline: z
      .boolean()
      .default(false)
      .describe(
        'Return a structural outline of the act — chapters, sections, articles, annexes, and the preamble\'s recitals as a heading list, each with its character offset — instead of body text. The recitals appear as one entry spanning the run (e.g. "Recitals 1–173") at the first recital\'s offset unless include_recitals is true. Headings of text an amending act inserts into another act are not listed. Read a section by paging with its offset, keeping the same format: outline offsets are measured in the requested format\'s body and land in the wrong place under any other format. Ignores offset/limit and select; no detectable structure returns an empty outline. Not applied in content_mode "metadata_only".',
      ),
    include_recitals: z
      .boolean()
      .default(false)
      .describe(
        'List every recital as its own outline entry, with its own offset, instead of one entry for the run. Applies only when outline is true; select reaches a single recital either way.',
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
        `Return only the text of specific sections by type and number, instead of a raw character window (Roman and Arabic numbers are equivalent; a number may carry an English kind word or one in the language served, e.g. "Article 5", "Artikel 5", "5. cikk"). Sections are located in the body of the requested format, so pair select with the same format used for any outline. A section inside another selected section (an article in a selected chapter) is returned once, within the enclosing one. A section that cannot be located — including a number that appears only in text an amending act inserts into another act — is reported in selection.missed with no wrong text returned. offset and limit do not apply: the joined sections are capped at ${MAX_CONTENT_LIMIT} characters with no continuation, and each section stays readable on its own from its offset and chars in selected_sections. Ignored when outline is true or in content_mode "metadata_only".`,
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
        'Human-readable name of the primary (first) originating institution — an EU institution (e.g. "European Parliament", "Court of Justice"), or for a national-court decision the deciding court (e.g. "Supremo Tribunal de Justiça"). For co-legislated acts, prefer author_institutions for the complete set. For a consolidated text, the base act\'s (see base_act_celex). Absent when not recorded, and for an AG opinion whose only recorded author is the Advocate General.',
      ),
    author_institutions: z
      .array(z.string().describe('Human-readable institution name.'))
      .optional()
      .describe(
        'All originating institutions, for acts adopted by more than one body (e.g. ["European Parliament", "Council of the EU"]). Institutions only: an Advocate General appears in advocates_general. For a consolidated text, the base act\'s. Absent when none recorded.',
      ),
    advocates_general: z
      .array(z.string().describe('Advocate General surname, as CELLAR records it.'))
      .optional()
      .describe(
        'Advocates General who delivered this case-law record, by surname as CELLAR records it (e.g. ["Jääskinen"]), sorted. A few Opinions of the Court list several. Absent for legislation and for case law with none recorded.',
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
      .describe(
        "Legal basis acts for this work — for a consolidated text, its base act's. Absent when none are recorded.",
      ),
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
      .describe(
        "EuroVoc subject classifications — for a consolidated text, its base act's. Absent when none are recorded.",
      ),
    in_force: z
      .boolean()
      .optional()
      .describe(
        'Whether the act is currently in force — for a consolidated text, whether its base act is. When false, repealed_by, entry_into_force, and end_of_validity give the reason where CELLAR records one: an explicit repeal, an entry into force still ahead, or an end of validity — past for an expired act, possibly still ahead for one not yet in force. Some acts not in force carry none of them.',
      ),
    repealed_by: z
      .array(z.string().describe('CELEX number of a repealing act.'))
      .optional()
      .describe(
        "CELEX numbers of the acts that explicitly repeal this one, the relation eurlex_get_relations names repealed_by (implicit repeals are listed there as implicitly_repealed_by). Present only when in_force is false; for a consolidated text, its base act's.",
      ),
    entry_into_force: z
      .string()
      .optional()
      .describe(
        "Earliest entry-into-force date (YYYY-MM-DD) of an act not yet in force. Present only when in_force is false and that date is after today (UTC); for a consolidated text, its base act's.",
      ),
    end_of_validity: z
      .string()
      .optional()
      .describe(
        "Date (YYYY-MM-DD) the act's validity ends or ended: past for an expired act, and possibly in the future for one not yet in force (read it with entry_into_force), so on its own it does not mean the act expired. Present only when in_force is false and CELLAR records an actual date rather than its open-ended 9999-12-31; for a consolidated text, its base act's.",
      ),
    base_act_celex: z
      .string()
      .optional()
      .describe(
        "CELEX of the base act a consolidated text consolidates (e.g. 32024R1689), linked through CELLAR rather than derived from the consolidated CELEX. Its authors, in-force status, legal basis, and EuroVoc subjects are reported here in place of the consolidation's own. Absent for a base act, and for a consolidated text whose base act is unlinked or carries no CELEX.",
      ),
    is_superseded: z
      .boolean()
      .optional()
      .describe(
        'Whether a newer consolidated version (an unofficial reading aid merging later amendments) than the text served is in effect, so this text may lack those amendments. False when the text served is the newest consolidated version in effect, or a consolidated version dated after it that does not apply yet. Not a repeal/replacement signal — the base act remains the law and may still be in force (see in_force). Present whenever the act has a consolidated version in effect; absent otherwise.',
      ),
    current_consolidated_celex: z
      .string()
      .optional()
      .describe(
        'CELEX of the act\'s newest consolidated version in effect (e.g. 02014R0833-20260424) — fetch it with eurlex_get_document, or pass resolve "current_consolidated". A consolidation dated in the future is never this version. Present whenever is_superseded is.',
      ),
    consolidated_as_of: z
      .string()
      .optional()
      .describe(
        'Consolidation date of current_consolidated_celex in ISO 8601 (YYYY-MM-DD). Present whenever is_superseded is.',
      ),
    requested_celex: z
      .string()
      .optional()
      .describe(
        'The originally requested CELEX, echoed when resolve "current_consolidated" served a different consolidated version. celex_number holds the CELEX actually served. Absent when the served work is the one requested.',
      ),
    content: z
      .string()
      .optional()
      .describe(
        `Body content of the act in the requested format and language. In "paged" mode this is the requested window; in "full" mode it starts at zero; under select it is the matched sections joined in document order, each source character once — a section inside another selected section (an article in a selected chapter) is carried inside the enclosing one. Every one is capped at ${MAX_CONTENT_LIMIT} characters. Omitted in "metadata_only" mode, when the window is empty, or when content is unavailable.`,
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
                'Numbering token, the same in every language (e.g. "17", "6A", "IV" — Roman numerals in Latin letters, French "premier" as "1"); empty for a lone unnumbered annex. A recital entry covering a run reads as a range, first–last (e.g. "1–173"), unless include_recitals is true.',
              ),
            label: z
              .string()
              .describe(
                'Human label in English whatever the language and format, e.g. "Article 17", "CHAPTER IV", "Recitals 1–173" — the form selection.matched reports; only an xml article with no number to read keeps its own heading text.',
              ),
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
          .describe(
            'Section descriptors requested, in English whatever the language, e.g. ["Article 17", "CHAPTER IV"].',
          ),
        matched: z
          .array(z.string())
          .describe(
            'Labels of the sections located in the body, in document order — in English whatever the language and format, as in the outline.',
          ),
        missed: z
          .array(z.string())
          .describe('Requested section descriptors that could not be located.'),
      })
      .optional()
      .describe(
        `Outcome of a structural selection. Present only when select was used; content holds the matched sections joined in document order, a nested section's text once inside its enclosing section, capped at ${MAX_CONTENT_LIMIT} characters. When the cap cuts the join, a trailing matched section may be partly or wholly absent from content — read selected_sections for each one's own address.`,
      ),
    selected_sections: z
      .array(
        z
          .object({
            label: z
              .string()
              .describe(
                'Section label in English whatever the language and format, e.g. "Article 17".',
              ),
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
        'Source address of each distinct section the selection located, in document order. Present only when select was used. A section nested inside another selected section keeps its own entry, though its text appears in content only once, inside the enclosing section. A selection is a set of slices, not a contiguous window, so these addresses — not content_offset — are how a caller navigates one; every section stays individually reachable even when the cap cut its text.',
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
    notice: z
      .string()
      .optional()
      .describe(
        'How to retrieve the remaining document content; when a work_uri carries several CELEX numbers, how many it carries and which one was served; and, when no consolidated version is in effect yet, that the consolidated text served does not apply yet, or that resolve "current_consolidated" served the base act.',
      ),
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
    // CELEX, which keys the rest of the flow: the metadata comes from the work that
    // CELEX resolves to, so a work_uri naming a copy is served as the CELEX's
    // canonical work, the same work the body is fetched from (#97).
    const celexInput = input.celex_number?.trim();
    const eliInput = input.eli_uri?.trim();
    const workUriInput = input.work_uri?.trim();
    const providedCount = [celexInput, eliInput, workUriInput].filter(Boolean).length;

    let requestedCelex: string;
    /** Set when a work_uri carries several CELEX numbers and the lowest was served. */
    let celexNotice: string | undefined;
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
      //
      // A national implementing measure carries one CELEX per directive it was
      // notified against, each an alias of the same work, so none is canonical
      // (#104). The lowest serves, the order eurlex_get_relations reads a work's
      // CELEX in, and the count rides the same query for the notice below.
      const safeWorkUri = workUriInput as string;
      const [deref] = await sparqlSvc.query(
        `SELECT (MIN(STR(?celexValue)) AS ?celex) (COUNT(DISTINCT ?celexValue) AS ?celexCount) WHERE {\n  <${safeWorkUri}> cdm:resource_legal_id_celex ?celexValue .\n}`,
        ctx,
      );
      const resolvedCelex = CellarSparqlService.bindingValue(deref, 'celex');
      if (!resolvedCelex) {
        throw ctx.fail(
          'not_found',
          `This CELLAR work carries no CELEX number and cannot be fetched as a document: ${safeWorkUri}`,
          { ...ctx.recoveryFor('not_found') },
        );
      }
      requestedCelex = resolvedCelex;
      const celexCount = Number(CellarSparqlService.bindingValue(deref, 'celexCount'));
      if (celexCount > 1) {
        celexNotice = `This work carries ${celexCount} CELEX numbers, each naming the same document; served the lowest, ${resolvedCelex}. Pass celex_number to serve it under a specific one.`;
      }
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
    //
    // The CELEX resolves to one work first (#97): CELLAR holds some CELEX numbers
    // under several works, and a CELEX-keyed join would read the union of all of
    // them. Every metadata query then keys on the resolved work's IRI.
    //
    // A consolidated text records none of its act's metadata — its author is the
    // Publications Office's provisional-data code, with no in-force flag, subjects,
    // or legal basis — so those come from its linked base act (#110), while its
    // identity (type, date, title, work) stays its own. `base` arrives from the
    // consolidation lookup, awaited alongside the resolution so it adds no serial
    // round trip.
    const fetchMetadata = async (
      celex: string,
      base: Promise<ConsolidationBase | undefined> | undefined,
    ) => {
      const [resolved, baseAct] = await Promise.all([
        resolveCelexWorks(sparqlSvc, [celex], ctx),
        base,
      ]);
      const workUri = resolved.get(celex);
      if (!workUri) return null;
      const actWork = baseAct?.workUri ?? workUri;
      // The in-force reasons (#111) ride the core query as aggregates: the earliest
      // entry into force, the latest end of validity, and the CELEX of every act
      // explicitly repealing this one. The dates aggregate over STR(): CELLAR
      // computes a grouped MIN/MAX over an OPTIONAL xsd:date wrongly. The open-ended
      // placeholder is filtered inside its OPTIONAL, so the MAX sees only real dates
      // on an act that records one alongside it.
      const coreQuery = `
SELECT ?type ?date ?title ?inForce
  (MIN(STR(?entryIntoForceDate)) AS ?entryIntoForce)
  (MAX(STR(?endOfValidityDate)) AS ?endOfValidity)
  (GROUP_CONCAT(DISTINCT STR(?repealerCelex); separator=" ") AS ?repealedBy)
WHERE {
  OPTIONAL { <${workUri}> cdm:work_has_resource-type ?type . }
  OPTIONAL { <${workUri}> cdm:work_date_document ?date . }
  OPTIONAL {
    ?expr cdm:expression_belongs_to_work <${workUri}> .
    ?expr cdm:expression_uses_language <${ENG_LANGUAGE_URI}> .
    ?expr cdm:expression_title ?title .
  }
  OPTIONAL { <${actWork}> cdm:resource_legal_in-force ?inForce . }
  OPTIONAL { <${actWork}> cdm:resource_legal_date_entry-into-force ?entryIntoForceDate . }
  OPTIONAL {
    <${actWork}> cdm:resource_legal_date_end-of-validity ?endOfValidityDate .
    FILTER(STR(?endOfValidityDate) != "${OPEN_ENDED_VALIDITY}")
  }
  OPTIONAL {
    ?repealer cdm:resource_legal_repeals_resource_legal <${actWork}> .
    ?repealer cdm:resource_legal_id_celex ?repealerCelex .
  }
} GROUP BY ?type ?date ?title ?inForce LIMIT 5`;
      // Legal bases and EuroVoc subjects resolve inline (#67): each dimension
      // query joins the identifying literal (CELEX / language-filtered
      // skos:prefLabel) as an OPTIONAL and groups per URI, so the label rides the
      // same round trip and a URI with no label still yields its row.
      const legalBasisQuery = `
SELECT ?legalBasis (SAMPLE(?celexValue) AS ?celex) WHERE {
  <${actWork}> cdm:resource_legal_based_on_resource_legal ?legalBasis .
  OPTIONAL { ?legalBasis cdm:resource_legal_id_celex ?celexValue . }
} GROUP BY ?legalBasis LIMIT ${META_DIMENSION_LIMIT}`;
      const eurovocQuery = `
SELECT ?eurovoc (SAMPLE(?labelValue) AS ?label) WHERE {
  <${actWork}> cdm:work_is_about_concept_eurovoc ?eurovoc .
  OPTIONAL {
    ?eurovoc skos:prefLabel ?labelValue .
    FILTER(LANG(?labelValue) = "${language.toLowerCase()}")
  }
} GROUP BY ?eurovoc LIMIT ${META_DIMENSION_LIMIT}`;

      const [coreBindings, agents, legalBasisBindings, eurovocBindings] = await Promise.all([
        sparqlSvc.query(coreQuery, ctx),
        fetchWorkAgents(sparqlSvc, actWork, ctx),
        sparqlSvc.query(legalBasisQuery, ctx),
        sparqlSvc.query(eurovocQuery, ctx),
      ]);

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
        workUri,
        baseActCelex: baseAct?.celex,
        resourceType: CellarSparqlService.bindingValue(first, 'type'),
        date: CellarSparqlService.bindingValue(first, 'date'),
        title: CellarSparqlService.bindingValue(first, 'title'),
        inForce: CellarSparqlService.parseBoolean(
          CellarSparqlService.bindingValue(first, 'inForce'),
        ),
        entryIntoForce: CellarSparqlService.bindingValue(first, 'entryIntoForce')?.slice(0, 10),
        endOfValidity: CellarSparqlService.bindingValue(first, 'endOfValidity')?.slice(0, 10),
        repealedBy: (CellarSparqlService.bindingValue(first, 'repealedBy') ?? '')
          .split(' ')
          .filter(Boolean)
          .sort(),
        agents,
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

    // Consolidation lookup + opt-in resolution (#29, #109). The lookup keys on the
    // CELEX alone, so it starts at once and runs concurrently with CELEX
    // resolution, the metadata, and the body. It names the act's current
    // consolidated version and, for a consolidated text, its base act, which
    // fetchMetadata awaits alongside the resolution. resolve "current_consolidated"
    // must know which work to serve before fetching, so it awaits the lookup first
    // — an inherent serial step on the opt-in path only. Whichever text is served,
    // the lookup's base act is its base when it is a consolidated text.
    const consolidation = findConsolidation(sparqlSvc, requestedCelex, ctx);
    const baseOf = (celex: string) =>
      isConsolidatedCelex(celex) ? consolidation.then((c) => c.base) : undefined;

    let servedCelex = requestedCelex;
    let metaResult: Awaited<ReturnType<typeof fetchMetadata>>;
    let body: Awaited<ReturnType<typeof fetchBody>>;
    let context: Awaited<typeof consolidation>;

    if (input.resolve === 'current_consolidated') {
      context = await consolidation;
      servedCelex = context.current?.celex ?? requestedCelex;
      [metaResult, body] = await Promise.all([
        fetchMetadata(servedCelex, baseOf(servedCelex)),
        fetchBody(servedCelex),
      ]);
    } else {
      [metaResult, body, context] = await Promise.all([
        fetchMetadata(requestedCelex, baseOf(requestedCelex)),
        fetchBody(requestedCelex),
        consolidation,
      ]);
    }

    ctx.log.info('Document metadata fetch', {
      requestedCelex,
      servedCelex,
      currentConsolidated: context.current?.celex,
    });

    if (!metaResult) {
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
      advocates_general?: string[];
      legal_basis?: { work_uri: string; celex_number?: string }[];
      eurovoc_subjects?: { concept_uri: string; label?: string }[];
      in_force?: boolean;
      repealed_by?: string[];
      entry_into_force?: string;
      end_of_validity?: string;
      base_act_celex?: string;
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
      celex_number: servedCelex,
      content_mode: input.content_mode,
      content_available: false,
      content_status: input.content_mode === 'metadata_only' ? 'not_requested' : 'unavailable',
      has_more: false,
      language,
      content_format: format,
    };

    result.work_uri = metaResult.workUri;
    if (metaResult.baseActCelex) result.base_act_celex = metaResult.baseActCelex;
    if (metaResult.title) result.title = metaResult.title;
    if (metaResult.date) result.date = metaResult.date;
    if (metaResult.resourceType) {
      result.resource_type = resolveResourceTypeLabel(metaResult.resourceType);
    }
    // #33: surface every author. author_institution stays the primary (first) for
    // back-compat; author_institutions carries the full set. Advocates General are
    // people, not institutions, so they get their own field (#96).
    const [primaryInstitution] = metaResult.agents.institutions;
    if (primaryInstitution) {
      result.author_institution = primaryInstitution;
      result.author_institutions = metaResult.agents.institutions;
    }
    if (metaResult.agents.advocatesGeneral.length > 0) {
      result.advocates_general = metaResult.agents.advocatesGeneral;
    }
    if (metaResult.legalBases.length > 0) result.legal_basis = metaResult.legalBases;
    if (metaResult.eurovoc.length > 0) result.eurovoc_subjects = metaResult.eurovoc;
    if (typeof metaResult.inForce === 'boolean') result.in_force = metaResult.inForce;

    // #111: why an act is not in force. Only a false in_force carries a reason — an
    // act in force can still be the target of a partial repeal — and only the parts
    // that explain it: an entry into force still ahead (UTC today), and an end of
    // validity (the query already excludes CELLAR's open-ended placeholder).
    const today = new Date().toISOString().slice(0, 10);
    if (metaResult.inForce === false) {
      if (metaResult.repealedBy.length > 0) result.repealed_by = metaResult.repealedBy;
      if (metaResult.entryIntoForce && metaResult.entryIntoForce > today) {
        result.entry_into_force = metaResult.entryIntoForce;
      }
      if (metaResult.endOfValidity) result.end_of_validity = metaResult.endOfValidity;
    }

    // #109: staleness describes the served text. It is current when it is the
    // newest consolidated version in effect, and not superseded either when it is
    // a consolidated version dated after that one, which does not apply yet. When
    // resolve served a different work, echo the original request so the redirect
    // is visible — celex_number already holds the served CELEX.
    const { current } = context;
    if (current) {
      const servedAsOf = servedCelex === requestedCelex ? context.requestedAsOf : current.asOf;
      result.is_superseded =
        servedCelex !== current.celex && !(servedAsOf !== undefined && servedAsOf > current.asOf);
      result.current_consolidated_celex = current.celex;
      result.consolidated_as_of = current.asOf;
    }
    if (servedCelex !== requestedCelex) {
      result.requested_celex = requestedCelex;
    }

    // With no consolidated version in effect (so the requested text is the one
    // served) there is no staleness to report, but a consolidated text dated after
    // today, or a resolve that found only such versions, would otherwise pass
    // silently for a text that applies.
    let consolidationNotice: string | undefined;
    if (!current && context.requestedAsOf && context.requestedAsOf > today) {
      const baseAct = context.base ? `its base act (${context.base.celex})` : 'its act';
      consolidationNotice = `Consolidated version ${servedCelex} is dated ${context.requestedAsOf} and does not apply yet; no consolidated version of ${baseAct} is in effect.`;
    } else if (!current && context.pending && input.resolve === 'current_consolidated') {
      consolidationNotice = `No consolidated version of ${requestedCelex} is in effect yet (${context.pending.celex} applies from ${context.pending.asOf}), so resolve "current_consolidated" served the base act.`;
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

        // Headings are read in the language served, after any English fallback
        // (#107). A Markdown body arrives with its own, parsed once against the
        // HTML it was rendered from so its quoted headings are told apart (#106);
        // an html or xml body carries its own markup and is parsed here.
        const headings = () => body.headings ?? parseActStructure(full, format, body.language);

        if (input.outline) {
          // Structure-only view: the detected headings and their offsets into the
          // same body the floor pages, no body text. Ignores offset/limit/select.
          // No parseable structure yields an empty outline, never an error. The
          // preamble's recitals collapse into one entry unless asked for one by
          // one (#118); select keeps resolving against every heading.
          const outline = headings();
          result.outline = input.include_recitals ? outline : collapseRecitals(outline);
          result.structure_detected = outline.length > 0;
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
          const located = headings();
          result.structure_detected = located.length > 0;
          const selection = extractSections(
            full,
            located,
            input.select as SectionSelectors,
            body.language,
          );
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
    // Both write the one notice field, so the served-CELEX (#104) and consolidation
    // (#109) notices ride behind it.
    const trailingNotice = [consolidationNotice, celexNotice].filter(Boolean).join(' ');
    const withTrailingNotice = (guidance: string) =>
      trailingNotice ? `${guidance} ${trailingNotice}` : guidance;
    if (result.has_more) {
      const nextOffset = (result.content_offset ?? 0) + (result.content_chars_returned ?? 0);
      const cap = input.content_mode === 'full' ? MAX_CONTENT_LIMIT : input.limit;
      ctx.enrich.truncated({
        shown: result.content_chars_returned ?? 0,
        cap,
        guidance: withTrailingNotice(
          `More document content is available. Continue with content_mode="paged" and offset=${nextOffset}.`,
        ),
      });
    } else if (selectedCharsBeforeCap !== undefined) {
      ctx.enrich.truncated({
        shown: result.content_chars_returned ?? 0,
        cap: MAX_CONTENT_LIMIT,
        guidance: withTrailingNotice(
          `The selected sections total ${selectedCharsBeforeCap} characters and were cut at the ${MAX_CONTENT_LIMIT}-character body cap. Read a section on its own with content_mode="paged", passing its offset and chars from selected_sections, or select fewer sections.`,
        ),
      });
    } else if (trailingNotice) {
      ctx.enrich.notice(trailingNotice);
    }

    return result;
  },

  format: (result) => {
    const lines: string[] = [
      `## ${result.celex_number}${result.title ? ` — ${result.title}` : ''}\n`,
    ];
    if (result.date) lines.push(`**Date:** ${result.date}`);
    if (result.resource_type) lines.push(`**Type:** ${result.resource_type}`);
    if (result.base_act_celex) lines.push(`**Base act:** ${result.base_act_celex}`);
    if (result.author_institution) lines.push(`**Author:** ${result.author_institution}`);
    if (result.author_institutions && result.author_institutions.length > 0) {
      lines.push(`**Authors:** ${result.author_institutions.join(', ')}`);
    }
    if (result.advocates_general && result.advocates_general.length > 0) {
      lines.push(`**Advocates General:** ${result.advocates_general.join(', ')}`);
    }
    if (typeof result.in_force === 'boolean') lines.push(`**In Force:** ${result.in_force}`);
    if (result.repealed_by && result.repealed_by.length > 0) {
      lines.push(`**Repealed by:** ${result.repealed_by.join(', ')}`);
    }
    if (result.end_of_validity) lines.push(`**End of validity:** ${result.end_of_validity}`);
    if (result.entry_into_force) lines.push(`**Entry into force:** ${result.entry_into_force}`);
    // #29/#109 staleness — each field renders in its own block so the
    // format-parity sentinel walk sees every one.
    if (typeof result.is_superseded === 'boolean') {
      const current = `${result.current_consolidated_celex} (${result.consolidated_as_of})`;
      lines.push(
        result.is_superseded
          ? `**Superseded:** true — consolidated version ${current} is newer than this text; not a repeal (see In Force).`
          : result.celex_number === result.current_consolidated_celex
            ? '**Superseded:** false — this is the newest consolidated version.'
            : `**Superseded:** false — this consolidated version is dated after the current one, ${current}, and does not apply yet.`,
      );
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
        // Count the slices content carries: a section nested inside another
        // selected one rides in the enclosing slice (#88).
        const sections = result.selected_sections ?? [];
        const slices = outermostSections(sections).length;
        const nested = sections.length - slices;
        const nestedNote =
          nested > 0
            ? ` (${nested} nested section${nested === 1 ? '' : 's'} carried inside ${slices === 1 ? 'it' : 'them'})`
            : '';
        lines.push(
          `**Body** (${result.content_mode}, selection): ${returned} characters from ${slices} disjoint section${slices === 1 ? '' : 's'}${nestedNote} of a ${total}-character body — not a contiguous window, so there is no continuation offset (has_more ${result.has_more}).`,
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
      lines.push(
        unavailableBodyNote(
          result.content_unavailability_reason,
          result.content_format,
          result.language,
        ),
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
