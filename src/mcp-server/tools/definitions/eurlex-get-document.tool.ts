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
  type CurrentConsolidated,
  findCurrentConsolidated,
} from '@/services/cellar-sparql/relation-traversal.js';
import type { SparqlBinding } from '@/services/cellar-sparql/types.js';
import {
  type ActHeading,
  extractSections,
  parseActStructure,
  type SectionSelectors,
} from '@/services/eurlex-content/act-structure.js';
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
    'Fetch the notice (metadata) and full text of an EU act by CELEX number or ELI URI. ' +
    'Returns structured metadata — title, date, document type, author institution, legal basis, EuroVoc subjects — ' +
    'plus the act content as HTML, Markdown, or Formex4 XML in the requested language. ' +
    'Defaults to English (EN); not all works have content in all 24 official EU languages, ' +
    'especially older acts pre-2004 EU enlargement. ' +
    'If the requested language is unavailable, the server automatically falls back to English and notes the fallback. ' +
    'CELEX format: {sector}{year}{type}{number} e.g. 32016R0679 for GDPR. ' +
    'Use eurlex_lookup_celex to validate an identifier before calling this tool. ' +
    'HTML returns the full act text as served by EUR-Lex; markdown converts that HTML to clean Markdown server-side ' +
    '(recitals and numbered points as readable text, genuine data tables as GFM tables); XML returns Formex4 for structured processing. ' +
    'Large bodies are bounded per call but never lost: content_mode "paged" (default) returns a character window ' +
    '(offset + limit) alongside content_chars_total and has_more, so you can page to the end and reconstruct the whole act; ' +
    'content_mode "full" returns the entire body in one call; content_mode "metadata_only" returns metadata with no body and skips the content fetch. ' +
    'To navigate structure instead of raw offsets: outline: true returns a heading list of the chapters, articles, annexes, and recitals (no body), and select (e.g. { articles: "1,5,17" }) returns only those sections as text. ' +
    'Acts with no detectable structure (e.g. case law) fall back to the paging floor, never an error.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    celex_number: z
      .string()
      .optional()
      .describe(
        'CELEX number of the act to fetch (e.g. 32016R0679 for GDPR). ' +
          'Provide exactly one of celex_number, eli_uri, or work_uri.',
      ),
    eli_uri: z
      .string()
      .optional()
      .describe(
        'Work-level ELI URI of the act to fetch, resolved to its CELLAR work (e.g. ' +
          'http://data.europa.eu/eli/reg/2016/679, with or without the /oj suffix). ' +
          'Provide exactly one of celex_number, eli_uri, or work_uri.',
      ),
    work_uri: z
      .string()
      .refine(
        (v) =>
          !v ||
          (v.startsWith('http') &&
            !v.includes('>') &&
            !v.includes('<') &&
            !v.includes('"') &&
            !v.includes(' ')),
        { message: 'work_uri must be a valid http URI with no angle brackets, quotes, or spaces.' },
      )
      .optional()
      .describe(
        'CELLAR work resource URI to fetch (e.g. ' +
          'http://publications.europa.eu/resource/cellar/3e485e15-11bd-11e6-ba9a-01aa75ed71a1) — ' +
          'the form returned by eurlex_lookup_celex, eurlex_get_relations, and eurlex_search_documents. ' +
          'Dereferenced to its CELEX, then fetched by the same flow. Provide exactly one of celex_number, eli_uri, or work_uri.',
      ),
    resolve: z
      .enum(['as_requested', 'current_consolidated'])
      .default('as_requested')
      .describe(
        'Which version to serve for a base act that has newer consolidated versions. ' +
          '"as_requested" (default) returns the exact CELEX requested — for a base act, the as-enacted text. ' +
          '"current_consolidated" transparently serves the newest consolidated version instead when one exists, ' +
          'reporting the served CELEX in celex_number and the originally requested CELEX in requested_celex; ' +
          'a no-op when no newer consolidated version exists. Regardless of this setting, is_superseded / ' +
          'current_consolidated_celex / consolidated_as_of flag a stale base act.',
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
      .enum(['html', 'xml', 'markdown'])
      .default('html')
      .describe(
        'Content format: "html" for the act text as served by EUR-Lex (default); ' +
          '"markdown" for that HTML converted to clean Markdown server-side ' +
          '(recitals and numbered points as readable text, genuine data tables as GFM); ' +
          '"xml" for Formex4 XML structured format.',
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
    outline: z
      .boolean()
      .default(false)
      .describe(
        'Return a structural outline of the act — the detected chapters, sections, articles, annexes, and recitals as ' +
          'a heading list, each with its character offset into the body of the requested format — instead of body text. ' +
          'Use it to see what sections exist, then read one by paging (content_mode "paged") with its offset. ' +
          'Ignores offset/limit and select. An act with no detectable structure (e.g. case law) returns an empty outline, never an error. ' +
          'Not applied in content_mode "metadata_only".',
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
        'Return only the text of specific sections by type and number, instead of a raw character window. ' +
          'Roman and Arabic chapter/annex numbers are treated as equivalent. Applies on top of the requested format (html, markdown, xml). ' +
          'A section that cannot be located, or an act with no detectable structure, is reported in selection.missed with no wrong text returned — ' +
          'use offset/limit or content_mode "full" to read it. Ignored when outline is true or in content_mode "metadata_only".',
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
        'Human-readable name of the primary (first) originating EU institution (e.g. "European Parliament", "Council of the EU"). ' +
          'For co-legislated acts adopted by more than one body, prefer author_institutions for the complete set. Absent when not recorded.',
      ),
    author_institutions: z
      .array(z.string().describe('Human-readable EU institution name.'))
      .optional()
      .describe(
        'All originating EU institutions, for co-legislated acts adopted by more than one body ' +
          '(e.g. ["European Parliament", "Council of the EU"] for an ordinary-legislative-procedure act). Absent when none recorded.',
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
    is_superseded: z
      .boolean()
      .optional()
      .describe(
        'True when the requested work is a base act with a newer consolidated version available — the returned text ' +
          'may be outdated. Absent when the act has no consolidated version, or is itself a consolidated version.',
      ),
    current_consolidated_celex: z
      .string()
      .optional()
      .describe(
        'CELEX of the newest consolidated version of the requested base act (e.g. 02014R0833-20260424) — ' +
          'fetch it with eurlex_get_document, or pass resolve "current_consolidated". Present only when is_superseded is true.',
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
        'The originally requested CELEX, echoed when resolve "current_consolidated" served a different (consolidated) work. ' +
          'celex_number holds the CELEX actually served. Absent when the served work is the one requested.',
      ),
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
          .describe('Section descriptors found and returned in content, in document order.'),
        missed: z
          .array(z.string())
          .describe('Requested section descriptors that could not be located.'),
      })
      .optional()
      .describe(
        'Outcome of a structural selection. Present only when select was used; content holds the matched sections joined in document order.',
      ),
    structure_detected: z
      .boolean()
      .optional()
      .describe(
        'Whether any act structure was parsed from the body. Present when outline or select was used; false means the act has no ' +
          'detectable chapter/article/annex structure — read it via the paging floor (offset/limit or content_mode "full").',
      ),
  }),

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

    const language = (input.language.trim().toUpperCase() || 'EN') as EurLexLanguage;
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

      const [coreBindings, authorBindings, legalBasisBindings, eurovocBindings] = await Promise.all(
        [
          sparqlSvc.query(coreQuery, ctx),
          sparqlSvc.query(dimensionQuery('cdm:work_created_by_agent', 'author'), ctx),
          sparqlSvc.query(
            dimensionQuery('cdm:resource_legal_based_on_resource_legal', 'legalBasis'),
            ctx,
          ),
          sparqlSvc.query(dimensionQuery('cdm:work_is_about_concept_eurovoc', 'eurovoc'), ctx),
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
        legalBases: collect(legalBasisBindings, 'legalBasis'),
        eurovoc: collect(eurovocBindings, 'eurovoc'),
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
    // "full" returns the whole body, and "paged" returns a bounded
    // [offset, offset+limit) window with content_chars_total + has_more so the
    // tail is always reachable. The same shaped `content` feeds both
    // structuredContent and format(); there is no separate truncation downstream.
    const result: {
      celex_number: string;
      requested_celex?: string;
      work_uri?: string;
      title?: string;
      date?: string;
      resource_type?: string;
      author_institution?: string;
      author_institutions?: string[];
      legal_basis?: string[];
      eurovoc_subjects?: string[];
      in_force?: boolean;
      is_superseded?: boolean;
      current_consolidated_celex?: string;
      consolidated_as_of?: string;
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
      outline?: ActHeading[];
      selection?: { requested: string[]; matched: string[]; missed: string[] };
      structure_detected?: boolean;
    } = {
      celex_number: metaResult.confirmedCelex,
      content_mode: input.content_mode,
      content_available: false,
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

    if (body) {
      result.content_available = body.contentAvailable;
      result.language = body.language;
      if (body.languageFallback) {
        result.language_fallback = body.languageFallback;
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
          const headings = parseActStructure(full, format);
          result.structure_detected = headings.length > 0;
          const selection = extractSections(full, headings, input.select as SectionSelectors);
          result.selection = {
            requested: selection.requested,
            matched: selection.matched,
            missed: selection.missed,
          };
          result.has_more = false;
          result.content_chars_returned = selection.text.length;
          if (selection.text.length > 0) result.content = selection.text;
        } else if (input.content_mode === 'full') {
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
      lines.push(`**Legal Basis:** ${result.legal_basis.join(', ')}`);
    }
    if (result.eurovoc_subjects && result.eurovoc_subjects.length > 0) {
      // Render the full list for format parity with structuredContent — the set is
      // bounded at META_DIMENSION_LIMIT (100) and real acts carry ~a dozen, so
      // there is no length reason to cut it (previously truncated to 5).
      lines.push(`**EuroVoc Subjects:** ${result.eurovoc_subjects.join(', ')}`);
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
      const start = result.content_offset ?? 0;
      const returned = result.content_chars_returned ?? result.content?.length ?? 0;
      const end = start + returned;

      // Navigation status — always rendered so every navigation field (content_mode,
      // content_offset, content_chars_returned/total, has_more) reaches the text
      // channel too, whichever view (window / outline / selection) shaped the body.
      if (result.content_mode === 'full') {
        lines.push(
          `**Body** (full): full body — ${returned} of ${total} characters from offset ${start}.`,
        );
      } else {
        lines.push(
          `**Body** (${result.content_mode}): characters ${start}–${end} of ${total} (${returned} returned).` +
            (result.has_more
              ? ` More available — page forward with offset=${end}, or content_mode="full" for the entire act.`
              : ''),
        );
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

      if (result.content) {
        lines.push('');
        lines.push('---');
        lines.push('');
        lines.push(result.content);
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
