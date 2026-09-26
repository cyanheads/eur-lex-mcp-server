/**
 * @fileoverview eurlex_search_documents — Search EU legislation, case law, and preparatory acts.
 * @module mcp-server/tools/definitions/eurlex-search-documents
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { echoValue } from '@/mcp-server/tools/echo-value.js';
import {
  ENG_LANGUAGE_URI,
  resolveResourceTypeLabels,
} from '@/services/cellar-sparql/cdm-labels.js';
import {
  CellarSparqlService,
  getCellarSparqlService,
} from '@/services/cellar-sparql/cellar-sparql-service.js';
import { isSafeSparqlIri, isValidCalendarDate } from '@/services/cellar-sparql/eli-resolution.js';
import { keywordMatchPattern, keywordTitlePhrase } from '@/services/cellar-sparql/keyword-match.js';
import { isConsolidatedCelex } from '@/services/cellar-sparql/relation-traversal.js';
import { resolveCelexWorks } from '@/services/cellar-sparql/work-resolution.js';

const RESOURCE_TYPE_BASE = 'http://publications.europa.eu/resource/authority/resource-type/';

const DOCUMENT_TYPES = ['REG', 'DIR', 'DEC', 'TREATY', 'JUDG', 'OPIN_AG', 'PROP', 'REC'] as const;
type DocumentType = (typeof DOCUMENT_TYPES)[number];

/**
 * Exact CELLAR authority codes admitted by each public document category.
 *
 * The resource-type authority scheme exposes these as separate top concepts, so
 * category membership cannot be derived from a hierarchy or URI prefix. Draft
 * regulation/directive/decision/recommendation concepts describe proposals and
 * are deliberately excluded from the corresponding adopted-act families.
 */
const DOCUMENT_TYPE_FAMILIES = {
  REG: ['REG', 'REG_ADOPT_INTERNATION', 'REG_DEL', 'REG_FINANC', 'REG_IMPL'],
  DIR: ['DIR', 'DIR_DEL', 'DIR_IMPL'],
  DEC: ['DEC', 'DEC_ADOPT_INTERNATION', 'DEC_DEL', 'DEC_ENTSCHEID', 'DEC_FRAMW', 'DEC_IMPL'],
  TREATY: ['TREATY'],
  JUDG: ['JUDG'],
  OPIN_AG: ['OPIN_AG', 'VIEW_AG'],
  PROP: [
    'AMEND_PROP',
    'AMEND_PROP_DEC',
    'AMEND_PROP_DIR',
    'AMEND_PROP_REG',
    'JOINT_PROP_DEC',
    'JOINT_PROP_REG',
    'PROP_ACT',
    'PROP_DEC',
    'PROP_DEC_IMPL',
    'PROP_DEC_NO_ADDRESSEE',
    'PROP_DIR',
    'PROP_DRAFT',
    'PROP_JOINT_ACTION',
    'PROP_OPIN',
    'PROP_RECO',
    'PROP_REG',
    'PROP_REG_IMPL',
    'PROP_RES',
  ],
  REC: ['RECO', 'RECO_ADOPT_INTERNATION', 'RECO_DEC', 'RECO_RECO', 'RECO_REG'],
} as const satisfies Record<DocumentType, readonly string[]>;

/**
 * CDM resource-type URI for consolidated texts. A point-in-time consolidation of
 * an act (e.g. 02014R0833-20260424) carries this type — NOT its base type (REG,
 * DIR, …). Its document category therefore comes from the basic act reached by
 * `cdm:act_consolidated_based_on_resource_legal`, not from this generic type.
 */
const CONS_TEXT_URI = `${RESOURCE_TYPE_BASE}CONS_TEXT`;

/**
 * CDM resource-type URI for corrigenda. A corrigendum is a separate CELLAR work
 * with its own `…R(nn)` CELEX, its own — usually recent — `work_date_document`,
 * and no English expression title. It is co-typed CORRIGENDUM *plus* the base
 * type of the act it corrects, so it satisfies every `document_type` family and
 * sorts ahead of the acts themselves under `ORDER BY DESC(?docDate)`, crowding
 * primary acts off the page. Excluded by default and re-admitted by
 * include_corrigenda — the same shape eurlex_get_cases uses for sector-6
 * derivative records.
 */
const CORRIGENDUM_URI = `${RESOURCE_TYPE_BASE}CORRIGENDUM`;

export const eurlex_search_documents = tool('eurlex_search_documents', {
  title: 'Search EU Documents',
  description:
    'Search EU legislation, treaties, and preparatory acts across the CELLAR corpus by document type, date range, EuroVoc subject, author institution, and in-force status. Keyword matches English titles and CELEX strings only — there is no full-text body search. Corrigenda are excluded by default so primary acts fill the page (set include_corrigenda to include them). Returns a page of CELEX numbers, work URIs, type labels, dates, and titles, newest first, each flagged with is_consolidated and is_corrigendum. At least one filter is required.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    keyword: z
      .string()
      .optional()
      .describe(
        'Keyword matched against English document titles via the full-text index (multi-word input is treated as a phrase), and against CELEX numbers. A keyword that is a whole CELEX (e.g. 32016R0679) matches that document, its numbered siblings (…(01) to …(20)), and for case law its _INF, _RES, _SUM, and _EXT records, plus its corrigenda (…R(01) to …R(20), and any work recorded as correcting it) when include_corrigenda is set. A partial CELEX that opens with the sector and year (02016R0679), the year and type letters (2016R0679), or type letters followed by the number (R0679, J0131) matches every CELEX containing it, consolidated versions included; one opening with letters not followed by a digit (R(01), ROU_2024) tests every CELEX and can take tens of seconds; a fragment opening mid-year or mid-number (016R0679, 0679, 0679R) matches titles only. A keyword with no digit, or with a character no CELEX holds (a space, a period), matches titles only. A keyword with no letter or digit is rejected.',
      ),
    document_type: z
      .union([
        z.literal(''),
        z
          .enum(DOCUMENT_TYPES)
          .describe(
            'Document type: REG=Regulation, DIR=Directive, DEC=Decision, TREATY=Treaty, JUDG=Judgment, OPIN_AG=AG Opinion, PROP=Proposal, REC=Recommendation.',
          ),
      ])
      .optional()
      .describe(
        'Document category: REG=Regulations, DIR=Directives, DEC=Decisions, TREATY=Treaties, JUDG=Judgments, OPIN_AG=AG Opinions, PROP=Proposals, REC=Recommendations. Each category includes its explicit CELLAR authority variants (for example, delegated and implementing regulations). Omit to search all types. Consolidated texts are excluded unless include_consolidated is true.',
      ),
    include_consolidated: z
      .boolean()
      .default(false)
      .describe(
        'When true and document_type is set, also match consolidated texts whose basic act belongs to that document category. No effect when document_type is omitted. Consolidated rows are always tagged is_consolidated: true.',
      ),
    include_corrigenda: z
      .boolean()
      .default(false)
      .describe(
        'Include corrigenda — separate correction works, co-typed CORRIGENDUM alongside the base type of the act they correct, carrying a "…R(nn)" CELEX and usually no English title. Default false: they are excluded so primary acts fill the page. Every returned row is tagged is_corrigendum.',
      ),
    date_from: z
      .union([
        z.literal(''),
        z
          .string()
          .regex(
            /^\d{4}-\d{2}-\d{2}$/,
            'date_from must be a calendar date in YYYY-MM-DD form, zero-padded (e.g. 2016-05-04).',
          )
          .describe('Start date in ISO 8601 format (YYYY-MM-DD).'),
      ])
      .optional()
      .describe(
        'Start of date range (YYYY-MM-DD), matched against document date. Omit for no lower bound.',
      ),
    date_to: z
      .union([
        z.literal(''),
        z
          .string()
          .regex(
            /^\d{4}-\d{2}-\d{2}$/,
            'date_to must be a calendar date in YYYY-MM-DD form, zero-padded (e.g. 2016-05-04).',
          )
          .describe('End date in ISO 8601 format (YYYY-MM-DD).'),
      ])
      .optional()
      .describe(
        'End of date range (YYYY-MM-DD), matched against document date. Omit for no upper bound.',
      ),
    eurovoc_concept: z
      .union([
        z.literal(''),
        z
          .string()
          .refine(isSafeSparqlIri, {
            message:
              'EuroVoc URI must be a valid http URI with no whitespace, angle brackets, or quotes.',
          })
          .describe('EuroVoc concept URI (e.g. http://eurovoc.europa.eu/2828).'),
      ])
      .optional()
      .describe(
        'EuroVoc concept URI to filter by subject (e.g. http://eurovoc.europa.eu/2828), obtained from eurlex_browse_subjects. Omit for no subject filter.',
      ),
    author_institution: z
      .string()
      .optional()
      .describe(
        'Author institution name (e.g. "European Parliament", "Council", "European Commission"), matched against the English names of EU corporate bodies.',
      ),
    in_force: z
      .boolean()
      .optional()
      .describe(
        'Restrict by in-force status: true returns only acts currently in force; false returns acts not in force — repealed, expired, or not yet in force (eurlex_get_document names which, where CELLAR records one). Either way the act must carry the in-force property, which a minority of works do. Omit to return all regardless of in-force status.',
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
            is_consolidated: z
              .boolean()
              .describe(
                'True when this CELEX is a consolidated version (sector 0, e.g. 02016R0679-20160504) — a point-in-time text that incorporates amendments — rather than a base or amending act.',
              ),
            is_corrigendum: z
              .boolean()
              .describe(
                'True when this work carries the CORRIGENDUM resource-type — a correction to another act rather than a primary act. Only ever true when include_corrigenda is set, since corrigenda are excluded by default.',
              ),
            resource_type: z
              .string()
              .optional()
              .describe(
                'Human-readable document type label (e.g. "Regulation", "Directive"). Works with several resource-types (e.g. corrigenda) list all, comma-separated. Absent for some older works.',
              ),
            date: z.string().optional().describe('Document date in ISO 8601 format (YYYY-MM-DD).'),
            title: z
              .string()
              .optional()
              .describe(
                'English expression title where available; absent for many older works and judgments.',
              ),
          })
          .describe('A single EU legislative work with its CELEX number, type, and date.'),
      )
      .describe(
        'Matching EU documents ordered by date descending, then by CELEX number ascending among documents sharing a date, so pages are stable across calls.',
      ),
    total: z
      .number()
      .describe('Number of documents returned in this page (not a corpus-wide count).'),
    offset: z.number().describe('Pagination offset used for this response.'),
    has_more: z
      .boolean()
      .describe('True only when CELLAR returned an additional valid row beyond this page.'),
    next_offset: z
      .number()
      .optional()
      .describe('Offset for the next page. Present only when has_more is true.'),
    query_echo: z
      .object({
        keyword: z.string().optional().describe('Keyword filter applied.'),
        document_type: z.string().optional().describe('Document type filter applied.'),
        include_consolidated: z
          .boolean()
          .describe(
            'Effective include_consolidated value after the false default is applied — whether consolidated texts whose basic act belongs to the document_type category were included. Always present, since the default shapes which records can appear; has effect only when document_type is set.',
          ),
        include_corrigenda: z
          .boolean()
          .describe(
            'Effective include_corrigenda value after the false default is applied — whether corrigenda were admitted alongside primary acts. Always present, since the default shapes which records can appear.',
          ),
        date_from: z.string().optional().describe('Start date filter applied.'),
        date_to: z.string().optional().describe('End date filter applied.'),
        eurovoc_concept: z.string().optional().describe('EuroVoc concept URI filter applied.'),
        author_institution: z.string().optional().describe('Author institution filter applied.'),
        in_force: z.boolean().optional().describe('In-force filter applied.'),
      })
      .describe('Echo of filters applied to this search. Useful for diagnosing empty results.'),
  }),

  enrichment: {
    truncated: z
      .boolean()
      .optional()
      .describe('True when an additional CELLAR row proves more documents exist beyond this page.'),
    shown: z.number().optional().describe('Number of documents returned in this page.'),
    cap: z.number().optional().describe('The limit that was applied to this page.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance for the next call: on an empty first page, the filters that matched nothing and how to broaden them; on a page with more rows, the offset to continue from.',
      ),
  },

  errors: [
    {
      reason: 'no_filters',
      code: JsonRpcErrorCode.ValidationError,
      when: 'No effective narrowing filter was supplied — an unfiltered search would scan the entire corpus.',
      recovery:
        'Supply at least one filter: keyword, document_type, date_from/date_to, eurovoc_concept, author_institution, or in_force.',
    },
    {
      reason: 'invalid_date_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'date_from or date_to is not a real calendar date, or date_from falls after date_to.',
      recovery:
        'Supply each date as a real calendar day in YYYY-MM-DD form, with date_from on or before date_to.',
    },
    {
      reason: 'invalid_author_institution',
      code: JsonRpcErrorCode.ValidationError,
      when: 'author_institution holds no letters or digits, so it can name no institution.',
      recovery:
        'Pass an institution name such as "European Parliament", "Council", or "European Commission", or omit author_institution.',
    },
    {
      reason: 'invalid_keyword',
      code: JsonRpcErrorCode.ValidationError,
      when: 'keyword holds no letters or digits, so no title and no CELEX can match it.',
      recovery:
        'Pass a title word or phrase (e.g. "data protection") or a CELEX number (e.g. 32016R0679), or omit keyword.',
    },
    {
      reason: 'sparql_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Virtuoso returned HTTP 200 with an error body — query malformed or timed out.',
      recovery: 'Simplify the query or reduce the date range and retry.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const svc = getCellarSparqlService();
    const pageLimit = Math.min(input.limit, svc.maxResults);

    /**
     * Date-range validity, checked before any clause is built and before the
     * no_filters gate. The schema pins the `YYYY-MM-DD` shape only, so an
     * impossible calendar day or an inverted range still reaches CELLAR as an
     * `xsd:date` comparison that Virtuoso answers with zero bindings — the caller
     * would see an empty page and never learn the input was at fault. Ordering
     * matters against the no_filters gate too: the caller did supply a filter, it
     * just failed validation, so no_filters would be the wrong diagnosis. Both
     * values are shape- and calendar-valid by the time the range is compared, so
     * a lexicographic comparison of the ISO strings is a chronological one.
     */
    const dateFrom = input.date_from?.trim();
    const dateTo = input.date_to?.trim();
    if (dateFrom && !isValidCalendarDate(dateFrom)) {
      throw ctx.fail('invalid_date_range', `date_from "${dateFrom}" is not a real calendar date.`, {
        ...ctx.recoveryFor('invalid_date_range'),
      });
    }
    if (dateTo && !isValidCalendarDate(dateTo)) {
      throw ctx.fail('invalid_date_range', `date_to "${dateTo}" is not a real calendar date.`, {
        ...ctx.recoveryFor('invalid_date_range'),
      });
    }
    if (dateFrom && dateTo && dateFrom > dateTo) {
      throw ctx.fail(
        'invalid_date_range',
        `Date range is inverted: date_from "${dateFrom}" falls after date_to "${dateTo}".`,
        { ...ctx.recoveryFor('invalid_date_range') },
      );
    }

    const filters: string[] = [];
    let documentTypeClause = '';
    if (input.document_type) {
      const typeValues = DOCUMENT_TYPE_FAMILIES[input.document_type]
        .map((code) => `<${RESOURCE_TYPE_BASE}${code}>`)
        .join(' ');
      documentTypeClause = `VALUES ?selectedType { ${typeValues} }
  ${
    input.include_consolidated
      ? `{
    ?work cdm:work_has_resource-type ?selectedType .
  } UNION {
    ?work cdm:work_has_resource-type <${CONS_TEXT_URI}> ;
      cdm:act_consolidated_based_on_resource_legal ?basicAct .
    ?basicAct cdm:work_has_resource-type ?selectedType .
  }`
      : '?work cdm:work_has_resource-type ?selectedType .'
  }`;
    }
    if (dateFrom) {
      filters.push(`FILTER(?date >= "${dateFrom}"^^xsd:date)`);
    }
    if (dateTo) {
      filters.push(`FILTER(?date <= "${dateTo}"^^xsd:date)`);
    }
    /**
     * In-force filter, applied for either polarity. CELLAR expresses the negative:
     * Virtuoso serialises `cdm:resource_legal_in-force` as an xsd:integer `0`/`1`,
     * and the comparison against the xsd:boolean coerces, so `FILTER(?inForce =
     * false)` returns the no-longer-in-force works. Gating on `=== true` built no
     * clause for `false`, so the negative ran the same query as omitting the filter
     * while query_echo still reported it as applied (issue #82).
     */
    if (input.in_force !== undefined) {
      filters.push(`FILTER(?inForce = ${input.in_force})`);
    }

    /**
     * Exclude corrigenda by default so primary acts fill the page (issue #83),
     * mirroring the derivative exclusion eurlex_get_cases applies to sector 6.
     * A corrigendum is co-typed CORRIGENDUM plus a base type, so it passes every
     * document_type family; FILTER NOT EXISTS drops the work on the CORRIGENDUM
     * type alone, which no primary act carries, so nothing else is lost. The
     * OPTIONAL type projection below is untouched, so a row re-admitted by
     * include_corrigenda still lists every label it carries.
     */
    if (!input.include_corrigenda) {
      filters.push(`FILTER NOT EXISTS { ?work cdm:work_has_resource-type <${CORRIGENDUM_URI}> . }`);
    }

    const eurovocClause = input.eurovoc_concept?.trim()
      ? `?work cdm:work_is_about_concept_eurovoc <${input.eurovoc_concept.trim()}> .`
      : '';

    /**
     * Author institution filter — a REQUIRED graph pattern (not OPTIONAL) so the
     * author participates in result selection. An OPTIONAL author only binds
     * optional values and never excludes non-matching works, so an impossible
     * author still returned normal rows (issue #6).
     *
     * Two CELLAR realities shape this:
     *   1. Corporate-body names live on `skos:prefLabel` (language-tagged), not
     *      `cdm:corporate-body_label`, which CELLAR does not expose — so the old
     *      label match never bound even for real authors.
     *   2. A `CONTAINS` scan over every `prefLabel` cannot prove a non-match
     *      within the query timeout, so an unknown author would hang. Virtuoso's
     *      `bif:contains` full-text index resolves both hits and misses in well
     *      under a second and scales to every corporate body, not a fixed list.
     */
    let authorClause = '';
    const authorInput = input.author_institution?.trim();
    if (authorInput) {
      // Keep only letters, digits, and spaces so the value cannot break out of
      // the bif:contains phrase or inject full-text operators.
      const authorPhrase = authorInput
        .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!authorPhrase) {
        throw ctx.fail(
          'invalid_author_institution',
          `author_institution "${echoValue(authorInput)}" holds no letters or digits.`,
          { ...ctx.recoveryFor('invalid_author_institution') },
        );
      }
      authorClause = `?work cdm:work_created_by_agent ?agent .
  ?agent skos:prefLabel ?agentLabel .
  ?agentLabel bif:contains "'${authorPhrase}'" .
  FILTER(LANG(?agentLabel) = "en")`;
    }

    /**
     * A keyword with no letter or digit can match no title and no CELEX, so answering
     * it would return an empty page that silently drops every other filter. The input
     * is at fault, so it is rejected before any CELLAR call, and before the no_filters
     * gate for the same reason an invalid date is.
     */
    const keywordInput = input.keyword?.trim();
    if (keywordInput && !keywordTitlePhrase(keywordInput)) {
      throw ctx.fail(
        'invalid_keyword',
        `keyword "${echoValue(keywordInput)}" holds no letters or digits.`,
        { ...ctx.recoveryFor('invalid_keyword') },
      );
    }

    const inForceClause =
      input.in_force !== undefined
        ? `OPTIONAL { ?work cdm:resource_legal_in-force ?inForce . }`
        : '';

    /**
     * Reject a search with no effective narrowing filter. Unlike eurlex_get_cases
     * (always bounded to CELEX sector 6), this tool has no inherent bound — with no
     * keyword, type, date, subject, author, or in-force constraint it would scan the
     * full 2.7M-work corpus and time out, and a bare {} call has no meaningful result
     * anyway. A whitespace-only keyword trims to empty above, so it correctly counts
     * as no filter here rather than issuing a broad query (issue #25).
     * include_consolidated and include_corrigenda broaden rather than narrow, so
     * neither is a filter here.
     *
     * in_force counts for either polarity (issue #82). Only a minority of works
     * carry cdm:resource_legal_in-force at all, so both polarities bound the scan
     * to a small slice of the corpus rather than opening it. The test is
     * `!== undefined`, never truthiness: `false` is a supplied filter, while an
     * omitted optional boolean is undefined and must leave the gate closed.
     */
    const hasEffectiveFilter =
      !!keywordInput ||
      !!input.document_type ||
      !!dateFrom ||
      !!dateTo ||
      !!input.eurovoc_concept?.trim() ||
      !!authorInput ||
      input.in_force !== undefined;
    if (!hasEffectiveFilter) {
      throw ctx.fail(
        'no_filters',
        'A document search needs at least one narrowing filter; an unfiltered query would scan the entire 2.7M-work corpus.',
        { ...ctx.recoveryFor('no_filters') },
      );
    }

    /**
     * Titles live on expressions, not works — traverse the expression graph:
     * ?expr cdm:expression_belongs_to_work ?work (inverse of cdm:work_has_expression),
     * ?expr cdm:expression_uses_language <.../ENG>, ?expr cdm:expression_title ?title.
     *
     * GROUP BY ?celexNumber collapses each document to one row, handling two
     * distinct CELLAR duplications at once:
     *   1. A work carrying several cdm:work_has_resource-type values (corrigenda
     *      hold 2–3) — GROUP_CONCAT gathers every type URI per document (issue #14).
     *   2. Several distinct work URIs sharing one CELEX (e.g. a titled work plus a
     *      do_not_index member work, or parallel manifestations) — grouping by
     *      CELEX rather than ?work merges them, so LIMIT N returns N distinct
     *      documents and each duplicate no longer wastes a result slot (issue #24).
     * MAX(?title) keeps a bound title across the group, so a titled member's title
     * survives over a bare duplicate's absent one; MAX(?titledWork) likewise prefers
     * the work URI that carries a title — ?titledWork binds to ?work only inside the
     * title OPTIONAL — and the handler falls back to SAMPLE(?work) when no work in the
     * group is titled. Both are fallbacks: the row's work_uri is the CELEX's canonical
     * work, resolved for the whole page after this query (#97). The row date uses
     * SAMPLE, NOT MAX, at every level: under ORDER BY DESC(?docDate) a MAX over the
     * ordered column lets Virtuoso pick a date-index TOP-k plan that bypasses the
     * date-range upper-bound FILTER whenever no selective graph pattern is present (a
     * bare date/type search), returning the globally-latest documents instead of the
     * in-range ones. Date is single-valued per CELEX, so SAMPLE shows the same value
     * without triggering that plan.
     *
     * The CELEX breaks date ties, so the order is total: identical calls return
     * identical pages, and consecutive offsets neither repeat nor skip a document
     * that shares its date with others (#102). The tiebreak is the GROUP BY key
     * ?celexNumber, not the projected ?celex — Virtuoso does not sort on a SAMPLE
     * alias of a string.
     */
    const projection = (dateVar: string) => `SELECT
  (SAMPLE(?celexNumber) AS ?celex)
  (MAX(?titledWork) AS ?titledWork)
  (SAMPLE(?work) AS ?work)
  (GROUP_CONCAT(DISTINCT STR(?type); SEPARATOR=" ") AS ?types)
  (SAMPLE(${dateVar}) AS ?docDate)
  (MAX(?title) AS ?docTitle)`;
    const rowPattern = (
      authorPart: string,
      keywordPart: string,
    ) => `?work cdm:resource_legal_id_celex ?celexNumber .
  ${documentTypeClause}
  OPTIONAL { ?work cdm:work_has_resource-type ?type . }
  OPTIONAL { ?work cdm:work_date_document ?date . }
  OPTIONAL {
    ?expr cdm:expression_belongs_to_work ?work .
    ?expr cdm:expression_uses_language <${ENG_LANGUAGE_URI}> .
    ?expr cdm:expression_title ?title .
    BIND(?work AS ?titledWork)
  }
  ${eurovocClause}
  ${authorPart}
  ${keywordPart}
  ${inForceClause}
  ${filters.join('\n  ')}`;
    const paging = `LIMIT ${pageLimit + 1} OFFSET ${input.offset}`;
    const onPageWorks = (pattern: string) => pattern && `FILTER EXISTS {\n    ${pattern}\n  }`;

    // The keyword's one CELLAR lookup runs only once the input has passed validation.
    const keywordClause = keywordInput ? await keywordMatchPattern(svc, keywordInput, ctx) : '';

    /**
     * Page-first form for a search with any date bound — the form #98 gave
     * eurlex_get_cases, for the same reason (#105). The flat query groups and
     * aggregates every matching document before ORDER BY and LIMIT pick the page, so
     * a date range, even a single day, passed the client timeout. The subquery holds
     * the match pattern alone — the CELEX, the document type, the date, the subject,
     * the author, the keyword, the in-force flag, and every filter — and pages in the
     * same total order the outer query uses. The outer query repeats the whole row
     * pattern, so each CELEX groups the same works, types, and titles as the flat
     * form, and takes the row date from the subquery's ?pageDate so a document sorts
     * where it was paged. The page LIMIT sits inside the subquery, below the outer
     * level the service's LIMIT ceiling rewrites, so pageLimit stays the only clamp.
     *
     * The outer query tests the author and the keyword as FILTER EXISTS rather than
     * joining them again: the grouped works are the same, but a join re-drives their
     * full-text and CELEX arms over the whole corpus. With ?work already bound,
     * EXISTS checks the page's works alone.
     *
     * A date-less search keeps the flat form: finding a broad browse's page keys
     * costs about as much as the whole query, and a keyword-only search ran faster
     * flat than paged first.
     */
    const sparql =
      dateFrom || dateTo
        ? `
${projection('?pageDate')} WHERE {
  {
    SELECT ?celexNumber (SAMPLE(?date) AS ?pageDate) WHERE {
      ?work cdm:resource_legal_id_celex ?celexNumber .
      ${documentTypeClause}
      OPTIONAL { ?work cdm:work_date_document ?date . }
      ${eurovocClause}
      ${authorClause}
      ${keywordClause}
      ${inForceClause}
      ${filters.join('\n      ')}
    } GROUP BY ?celexNumber ORDER BY DESC(?pageDate) ?celexNumber ${paging}
  }
  ${rowPattern(onPageWorks(authorClause), onPageWorks(keywordClause))}
} GROUP BY ?celexNumber ORDER BY DESC(?docDate) ?celexNumber`
        : `
${projection('?date')} WHERE {
  ${rowPattern(authorClause, keywordClause)}
} GROUP BY ?celexNumber ORDER BY DESC(?docDate) ?celexNumber ${paging}`;

    const queryEcho = {
      ...(keywordInput ? { keyword: keywordInput } : {}),
      ...(input.document_type ? { document_type: input.document_type } : {}),
      // Echo the effective flags (Zod applies the false default, so each is always
      // a boolean) — a defaulted false still describes the search semantics (#57).
      include_consolidated: input.include_consolidated,
      include_corrigenda: input.include_corrigenda,
      ...(input.date_from ? { date_from: input.date_from } : {}),
      ...(input.date_to ? { date_to: input.date_to } : {}),
      ...(input.eurovoc_concept ? { eurovoc_concept: input.eurovoc_concept } : {}),
      ...(input.author_institution ? { author_institution: input.author_institution } : {}),
      ...(input.in_force !== undefined ? { in_force: input.in_force } : {}),
    };

    const bindings = await svc.queryWithContinuation(sparql, ctx);
    ctx.log.info('Document search', {
      keyword: input.keyword,
      documentType: input.document_type,
      resultCount: bindings.length,
      offset: input.offset,
    });

    /**
     * Zero hits is an answer, not a failure (#112): an empty first page returns the
     * same shape as a page past the end, plus a notice naming the filters and how to
     * broaden them. A page past the end stays silent — the caller already has rows.
     * Each echoed value is bounded; query_echo keeps it whole.
     */
    if (bindings.length === 0 && input.offset === 0) {
      const filterSummary = Object.entries(queryEcho)
        .map(([k, v]) => `${k}=${echoValue(String(v))}`)
        .join(', ');
      ctx.enrich.notice(
        `No documents matched the search criteria (${filterSummary}). Broaden the search by removing filters, trying a shorter keyword, or expanding the date range.`,
      );
    }

    const hasMore = bindings.length > pageLimit;
    const page = bindings.slice(0, pageLimit);
    // A CELEX held by several works resolves to its canonical work (#97), in one
    // follow-up query for the page — the alias match never binds inside the
    // grouped query above.
    const resolvedWorks = await resolveCelexWorks(
      svc,
      page.map((b) => CellarSparqlService.bindingValue(b, 'celex') ?? ''),
      ctx,
    );
    const documents = page.map((b) => {
      const celexNumber = CellarSparqlService.bindingValue(b, 'celex') ?? '';
      // GROUP_CONCAT delivers every resource-type of the work as one space-separated
      // string, so membership is tested against the split list — a substring test
      // would also match a longer code sharing the prefix. Unbound for older works
      // that carry no type, which makes the tag a definite false rather than absent.
      const types = CellarSparqlService.bindingValue(b, 'types');
      const doc: {
        work_uri: string;
        celex_number: string;
        is_consolidated: boolean;
        is_corrigendum: boolean;
        resource_type?: string;
        date?: string;
        title?: string;
      } = {
        work_uri:
          resolvedWorks.get(celexNumber) ??
          CellarSparqlService.bindingValue(b, 'titledWork') ??
          CellarSparqlService.bindingValue(b, 'work') ??
          '',
        celex_number: celexNumber,
        is_consolidated: isConsolidatedCelex(celexNumber),
        is_corrigendum: types?.split(/\s+/).includes(CORRIGENDUM_URI) ?? false,
      };
      const resourceType = resolveResourceTypeLabels(types);
      if (resourceType) doc.resource_type = resourceType;
      const date = CellarSparqlService.bindingValue(b, 'docDate');
      if (date) doc.date = date;
      const title = CellarSparqlService.bindingValue(b, 'docTitle');
      if (title) doc.title = title;
      return doc;
    });

    if (hasMore) {
      ctx.enrich.truncated({
        shown: documents.length,
        cap: pageLimit,
        guidance: `More documents match beyond this page; call again with offset=${input.offset + pageLimit}.`,
      });
    }

    return {
      documents,
      total: documents.length,
      offset: input.offset,
      has_more: hasMore,
      ...(hasMore ? { next_offset: input.offset + pageLimit } : {}),
      query_echo: queryEcho,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `## EU Documents (${result.total} results, offset ${result.offset})\n`,
      `**Has more:** ${result.has_more}`,
    ];
    if (result.next_offset !== undefined) lines.push(`**Next offset:** ${result.next_offset}`);
    lines.push('');
    const echoEntries = Object.entries(result.query_echo);
    if (echoEntries.length > 0) {
      lines.push(
        `*Filters: ${echoEntries.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')}*\n`,
      );
    }
    for (const doc of result.documents) {
      lines.push(`### ${doc.celex_number}${doc.title ? ` — ${doc.title}` : ''}`);
      if (doc.date) lines.push(`**Date:** ${doc.date}`);
      if (doc.resource_type) lines.push(`**Type:** ${doc.resource_type}`);
      lines.push(`**Consolidated:** ${doc.is_consolidated}`);
      lines.push(`**Corrigendum:** ${doc.is_corrigendum}`);
      lines.push(`**Work URI:** ${doc.work_uri}`);
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
