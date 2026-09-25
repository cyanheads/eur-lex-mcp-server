/**
 * @fileoverview eurlex_get_cases — Search CJEU and General Court case law.
 * @module mcp-server/tools/definitions/eurlex-get-cases
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  DERIVATIVE_RESOURCE_TYPES,
  ENG_LANGUAGE_URI,
  parseCaseLawTitle,
  resolveResourceTypeLabels,
} from '@/services/cellar-sparql/cdm-labels.js';
import {
  CellarSparqlService,
  getCellarSparqlService,
} from '@/services/cellar-sparql/cellar-sparql-service.js';
import {
  escapeSparqlLiteral,
  isValidCalendarDate,
} from '@/services/cellar-sparql/eli-resolution.js';
import { resolveCelexWorks } from '@/services/cellar-sparql/work-resolution.js';

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
 * CELEX type letters of sector-6 case law. A case-law CELEX reads
 * `6{year}{court}{document}{number}` — e.g. 62023CO0097(01) is year 2023, court `C`,
 * document `O` (order), number 0097 — so position 6 names the court and position 7
 * the kind of record.
 *
 * The court filter keys on the court letter alone, so every record a court filed is
 * reachable whatever its document letter (issue #91). A case number keys on the court
 * letter plus the document letters that court files under a case number (issue #81),
 * from a survey of every sector-6 CELEX: the primary records, and the notices that
 * only include_derivative admits. Numbered Opinions and Rulings of the Court of
 * Justice (`CV`, `CU`, `CG`, `CX`) are left out: they are cited as "Opinion 2/13",
 * not by case number, and their CELEX collides with the `C-n/yy` case of the same
 * number and year.
 */
const COURT_CELEX_LETTER = { CJEU: 'C', GC: 'T' } as const;
const CASE_NUMBER_DOCUMENT_LETTERS = {
  C: { primary: 'JOCPSTD', notices: 'ABN' },
  T: { primary: 'JOCT', notices: 'ABN' },
  F: { primary: 'JO', notices: 'ABN' },
} as const;

/** CELEX court letter a case-number prefix names: Court of Justice, General Court, Civil Service Tribunal. */
type CaseCourtLetter = keyof typeof CASE_NUMBER_DOCUMENT_LETTERS;

/**
 * Case-number grammar. A `C-`/`T-`/`F-` prefix takes any hyphen form a published
 * reference uses (ASCII, U+2010–U+2015, U+2212 — CELLAR titles often carry U+2011).
 * A prefix-less number is a pre-1989 Court of Justice case (`26/62`, `133-73`),
 * where `/` or a hyphen separates number and year. Both accept a leading "Case" and
 * ignore the text after the year — a procedural suffix (`P`, `R II`, `PPU`, …) or
 * the trailing "." of a case reference — since CELEX carries no suffix. Trailing
 * text that holds another case designation (a digit, `/` or a hyphen, a digit — as
 * in "C-131/12 and C-132/12") names a second case, which a single CELEX match would
 * silently drop, so it is rejected; no procedural suffix contains a digit. Each
 * pattern is anchored or fixed-width and backtracks through a single digit run at
 * most, so cost stays linear in the input length.
 */
const HYPHEN = '[-\\u2010-\\u2015\\u2212]';
const PREFIXED_CASE_NUMBER = new RegExp(
  `^(?:case\\s+)?([CTF])${HYPHEN}(\\d+)/(\\d{2,4})(?!\\d)`,
  'i',
);
const PREFIXLESS_CASE_NUMBER = new RegExp(
  `^(?:case\\s+)?(\\d+)(?:/|${HYPHEN})(\\d{2,4})(?!\\d)`,
  'i',
);
const ANOTHER_CASE_NUMBER = new RegExp(`\\d(?:/|${HYPHEN})\\d`);

/** Unprefixed Court of Justice case numbers were issued from 1953 until the General Court opened in 1989. */
const PREFIXLESS_FIRST_YEAR = 1953;
const PREFIXLESS_LAST_YEAR = 1988;

/**
 * A value made only of characters a CELEX can hold. Every sector-6 CELEX is made of
 * these characters alone, so any value a CELEX substring match can reach is one of
 * these strings; a value that parses as no case number and contains anything else
 * can never match and is rejected instead of answered with an empty search.
 */
const CELEX_CHARACTERS = /^[0-9A-Za-z()_]+$/;

type ParsedCaseNumber =
  | { kind: 'case'; court: CaseCourtLetter; year: number; number: string }
  | { kind: 'unprefixed_out_of_range'; year: number }
  | { kind: 'several' }
  | { kind: 'unparsed' };

/**
 * Parse a single case number into the CELEX parts it names.
 *
 * Prefixed years keep the historical two-digit heuristic (yy ≤ 60 → 20yy, else
 * 19yy), so C-25/62 still reads as 1962; a three- or four-digit year is taken as
 * written. A prefix-less number always reads as the Court of Justice with a 19yy
 * year, and one dated outside 1953–1988 is reported separately — it cannot be told
 * apart from a General Court or Court of Justice number that lost its prefix. A value
 * whose trailing text holds a second case designation is reported as `several`.
 */
function parseCaseNumber(value: string): ParsedCaseNumber {
  const prefixed = PREFIXED_CASE_NUMBER.exec(value);
  const match = prefixed ?? PREFIXLESS_CASE_NUMBER.exec(value);
  if (!match) return { kind: 'unparsed' };
  if (ANOTHER_CASE_NUMBER.test(value.slice(match[0].length))) return { kind: 'several' };
  if (prefixed) {
    // Groups 1–3 are all present once the pattern matches; the `?? ''` fallbacks
    // satisfy the type-checker without a non-null assertion and never fire at runtime.
    const yearText = prefixed[3] ?? '';
    const rawYear = parseInt(yearText, 10);
    return {
      kind: 'case',
      court: (prefixed[1] ?? '').toUpperCase() as CaseCourtLetter,
      year: yearText.length === 2 ? (rawYear <= 60 ? 2000 + rawYear : 1900 + rawYear) : rawYear,
      number: (prefixed[2] ?? '').padStart(4, '0'),
    };
  }
  const yearText = match[2] ?? '';
  const rawYear = parseInt(yearText, 10);
  const year = yearText.length === 2 ? 1900 + rawYear : rawYear;
  if (year < PREFIXLESS_FIRST_YEAR || year > PREFIXLESS_LAST_YEAR) {
    return { kind: 'unprefixed_out_of_range', year };
  }
  return { kind: 'case', court: 'C', year, number: (match[1] ?? '').padStart(4, '0') };
}

export const eurlex_get_cases = tool('eurlex_get_cases', {
  title: 'Search CJEU/GC Case Law',
  description:
    'Search CJEU and General Court case law — judgments, orders, and Advocate General opinions — by case number, court, case type, keyword, and date range. A case number reaches every judgment, order, and AG opinion filed under it. By default only these primary records are returned; derivative judicial information notices, case abstracts, summaries, and corrigenda are excluded so distinct cases fill the page (set include_derivative to include them). Keyword matches English case titles (which carry party names) and CELEX strings; there is no full-text body search. Returns each case with its CELEX number (whose sixth character names the court: C, T, or F), work URI, ECLI, date, and type, plus — parsed from the title where present — the parties, subject matter, and case reference.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    case_number: z
      .string()
      .optional()
      .describe(
        'Number of a single case: C-{num}/{year} (Court of Justice), T-{num}/{year} (General Court), or F-{num}/{year} (Civil Service Tribunal), e.g. C-131/12. Also accepts the case_reference form ("Case C-97/23 P."), any procedural suffix after the year (P, R, PPU, …), and a pre-1989 Court of Justice number with no prefix (26/62). A value naming more than one case ("C-131/12 and C-132/12") is rejected; search each separately. Matches the judgments, orders, AG opinions, and other primary records filed under that number; derivative records (notices, abstracts, summaries, corrigenda) join only under include_derivative. Numbered Opinions and Rulings of the Court of Justice ("Opinion 2/13", "Ruling 1/78") are not reached by a case number; look one up by its CELEX (e.g. 62013CV0002). A value made only of CELEX characters (e.g. 2023CJ0097) is matched as a CELEX substring instead.',
      ),
    keyword: z
      .string()
      .optional()
      .describe('Keyword to match against case titles and CELEX strings.'),
    court: z
      .union([
        z.literal(''),
        z
          .enum(['CJEU', 'GC'])
          .describe('CJEU (C) = Court of Justice of the EU, GC (T) = General Court.'),
      ])
      .optional()
      .describe(
        'Court filter, by the court letter at position 6 of the CELEX: CJEU (C) = Court of Justice of the EU, GC (T) = General Court. It does not narrow by record type: every primary record the court filed matches, and its derivative records (notices, abstracts, summaries, corrigenda) join only under include_derivative. Omit to search every court.',
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
        'Include derivative sector-6 records — judicial information notices, case abstracts, case summaries, and corrigenda — alongside primary judgments, orders, and AG opinions. Default false: these are excluded so distinct primary cases fill the page. Ignored when case_type is set (that path already returns a single primary type).',
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
        'Start of date range in ISO 8601 format (YYYY-MM-DD). Leave blank or omit for no lower bound.',
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
            ecli: z
              .string()
              .optional()
              .describe(
                'European Case Law Identifier, the citation form of the record (e.g. "ECLI:EU:C:2014:317"); eurlex_lookup_celex resolves one back to its CELEX. Absent for judicial notices and the few records that carry none.',
              ),
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
      .describe(
        'Matching case law records ordered by date descending, then by CELEX number ascending among records sharing a date, so pages are stable across calls.',
      ),
    total: z.number().describe('Number of cases returned in this page (not a corpus-wide count).'),
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
        case_number: z.string().optional().describe('Case number filter applied.'),
        celex_fragment: z
          .string()
          .optional()
          .describe(
            'CELEX pattern matched for case_number: year, court letter, and zero-padded case number, with * standing for any document letter that court files under a case number (e.g. "2023C*0097" reaches 62023CJ0097, 62023CO0097, and 62023CC0097). Absent when case_number was matched as a raw CELEX substring.',
          ),
        keyword: z.string().optional().describe('Keyword filter applied.'),
        court: z.string().optional().describe('Court filter applied.'),
        case_type: z.string().optional().describe('Case type filter applied.'),
        include_derivative: z
          .boolean()
          .describe(
            'Effective include_derivative value after the false default is applied — whether derivative sector-6 records (notices, abstracts, summaries, corrigenda) were admitted alongside primary cases. Always present, since the default shapes which records can appear.',
          ),
        date_from: z.string().optional().describe('Start date filter applied.'),
        date_to: z.string().optional().describe('End date filter applied.'),
      })
      .describe('Echo of filters applied to this search. Useful for diagnosing empty results.'),
  }),

  enrichment: {
    truncated: z
      .boolean()
      .optional()
      .describe('True when an additional CELLAR row proves more cases exist beyond this page.'),
    shown: z.number().optional().describe('Number of cases returned in this page.'),
    cap: z.number().optional().describe('The limit that was applied to this page.'),
  },

  errors: [
    {
      reason: 'invalid_date_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'date_from or date_to is not a real calendar date, or date_from falls after date_to.',
      recovery:
        'Supply each date as a real calendar day in YYYY-MM-DD form, with date_from on or before date_to.',
    },
    {
      reason: 'invalid_case_number',
      code: JsonRpcErrorCode.ValidationError,
      when: 'case_number is not a recognizable case number and holds characters no CELEX contains, names more than one case (e.g. "C-131/12 and C-132/12"), or is a prefix-less number dated outside 1953–1988.',
      recovery:
        'Pass one case number per call, written as C-{number}/{year}, T-{number}/{year}, or F-{number}/{year} (e.g. C-131/12); a leading "Case", a trailing procedural suffix, and a pre-1989 Court of Justice number such as 26/62 are also accepted.',
    },
    {
      reason: 'no_results',
      code: JsonRpcErrorCode.NotFound,
      when: 'The first page (offset 0) returned zero bindings — no matching cases in CELLAR sector 6. A later page that comes back empty returns an empty success instead.',
      recovery:
        'Try a different keyword, broader date range, or remove the court/case_type filter.',
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
     * Date-range validity, checked before any clause is built. The schema pins the
     * `YYYY-MM-DD` shape only, so an impossible calendar day or an inverted range
     * still reaches CELLAR as an `xsd:date` comparison that Virtuoso answers with
     * zero bindings — the caller would see no_results and never learn the input was
     * at fault. Both values are shape- and calendar-valid by the time the range is
     * compared, so a lexicographic comparison of the ISO strings is a chronological
     * one.
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

    // All case law is in CELEX sector 6
    const filters: string[] = [`FILTER(STRSTARTS(STR(?celexNumber), "6"))`];

    /**
     * Case number → CELEX match. CELEX stores the year before the number
     * (C-131/12 → 62012CJ0131), and the court files one case under several
     * document letters (judgment CJ, order CO, AG opinion CC, …), so the match
     * fixes year, court letter, and number and lets the document letter vary over
     * the set that court uses. Notice letters join only when derivative records are
     * admitted. The REGEX is unanchored, as the former CONTAINS was, so every value
     * that parsed before still reaches what it reached then. A value that parses as
     * no case number keeps the escaped CELEX-substring match only when it is made
     * of CELEX characters; anything else could never match and is rejected.
     */
    let celexFragment: string | undefined;
    const caseNumberInput = input.case_number?.trim();
    if (caseNumberInput) {
      const parsed = parseCaseNumber(caseNumberInput);
      if (parsed.kind === 'case') {
        const letters = CASE_NUMBER_DOCUMENT_LETTERS[parsed.court];
        const admitsNotices = !input.case_type && input.include_derivative;
        const documentLetters = letters.primary + (admitsNotices ? letters.notices : '');
        celexFragment = `${parsed.year}${parsed.court}*${parsed.number}`;
        filters.push(
          `FILTER(REGEX(STR(?celexNumber), "${parsed.year}${parsed.court}[${documentLetters}]${parsed.number}"))`,
        );
      } else if (parsed.kind === 'unparsed' && CELEX_CHARACTERS.test(caseNumberInput)) {
        const cn = escapeSparqlLiteral(caseNumberInput);
        filters.push(`FILTER(CONTAINS(LCASE(STR(?celexNumber)), LCASE("${cn}")))`);
      } else {
        throw ctx.fail(
          'invalid_case_number',
          parsed.kind === 'unprefixed_out_of_range'
            ? `Case number "${caseNumberInput}" has no court prefix, and its year ${parsed.year} falls outside 1953–1988, when unprefixed Court of Justice numbers were issued. Add the C-, T-, or F- prefix.`
            : parsed.kind === 'several'
              ? `Case number "${caseNumberInput}" names more than one case.`
              : `Case number "${caseNumberInput}" is not a recognizable case number.`,
          { ...ctx.recoveryFor('invalid_case_number') },
        );
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
      const celexTerm = escapeSparqlLiteral(keywordInput.toLowerCase());
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

    if (input.court) {
      filters.push(
        `FILTER(SUBSTR(STR(?celexNumber), 6, 1) = "${COURT_CELEX_LETTER[input.court]}")`,
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

    if (dateFrom) {
      filters.push(`FILTER(?date >= "${dateFrom}"^^xsd:date)`);
    }
    if (dateTo) {
      filters.push(`FILTER(?date <= "${dateTo}"^^xsd:date)`);
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
     * group is titled. Both are fallbacks: the row's work_uri is the CELEX's canonical
     * work, resolved for the whole page after this query (#97). ?docDate uses SAMPLE,
     * NOT MAX: under ORDER BY DESC(?docDate) a MAX over the ordered column lets
     * Virtuoso pick a date-index TOP-k plan that bypasses the date-range upper-bound
     * FILTER whenever no selective graph pattern is present (a bare date/court/type
     * search), returning the globally-latest cases
     * instead of the in-range ones. Date is single-valued per CELEX, so SAMPLE shows
     * the same value without triggering that plan. The ECLI is single-valued per
     * CELEX too, but only some member works of a group carry it, so MAX keeps a
     * bound value the way it does for the title (issue #84).
     *
     * The CELEX breaks date ties, so the order is total: identical calls return
     * identical pages, and consecutive offsets neither repeat nor skip a case that
     * shares its date with others (#102). The tiebreak is the GROUP BY key
     * ?celexNumber, not the projected ?celex — Virtuoso does not sort on a SAMPLE
     * alias of a string.
     */
    const projection = (dateVar: string) => `SELECT
  (SAMPLE(?celexNumber) AS ?celex)
  (MAX(?titledWork) AS ?titledWork)
  (SAMPLE(?work) AS ?work)
  (GROUP_CONCAT(DISTINCT STR(?type); SEPARATOR=" ") AS ?types)
  (SAMPLE(${dateVar}) AS ?docDate)
  (MAX(?caseEcli) AS ?ecli)
  (MAX(?title) AS ?docTitle)`;
    const rowPattern = (keywordPart: string) => `?work cdm:resource_legal_id_celex ?celexNumber .
  ${typeConstraint}
  OPTIONAL { ?work cdm:work_has_resource-type ?type . }
  OPTIONAL { ?work cdm:work_date_document ?date . }
  OPTIONAL { ?work cdm:case-law_ecli ?caseEcli . }
  OPTIONAL {
    ?expr cdm:expression_belongs_to_work ?work .
    ?expr cdm:expression_uses_language <${ENG_LANGUAGE_URI}> .
    ?expr cdm:expression_title ?title .
    BIND(?work AS ?titledWork)
  }
  ${keywordPart}
  ${filters.join('\n  ')}`;
    const paging = `LIMIT ${pageLimit + 1} OFFSET ${input.offset}`;

    /**
     * Page-first form for a search with any date bound (#98). The flat query groups
     * and aggregates every matching case before ORDER BY and LIMIT pick the page;
     * with a date bound, selecting the page's CELEX keys first and aggregating only
     * those is far cheaper. The subquery holds the match pattern alone — the CELEX,
     * the required type, the date, the keyword, and every filter — and pages in the
     * same total order the outer query uses. The outer query repeats the whole row
     * pattern, so each CELEX groups the same works, types, ECLI, and titles as the
     * flat form, and takes the row date from the subquery's ?pageDate so a case sorts
     * where it was paged. ?pageDate is a SAMPLE for the same reason ?docDate is. The
     * page LIMIT sits inside the subquery, below the outer level the service's LIMIT
     * ceiling rewrites, so pageLimit stays the only clamp.
     *
     * The outer query tests the keyword as FILTER EXISTS rather than joining it
     * again: the grouped works are the same (a work stays in its CELEX group only
     * when it matches the keyword either way), but a join re-drives the full-text
     * and CELEX-substring arms over the whole corpus, which made a keyword search over
     * a wide date range slower than the flat form. With ?work already bound, EXISTS
     * checks the page's works alone.
     *
     * A date-less search keeps the flat form: finding a broad browse's page keys
     * costs about as much as the whole query, and a court-only browse measured the
     * two forms at parity.
     */
    const sparql =
      dateFrom || dateTo
        ? `
${projection('?pageDate')} WHERE {
  {
    SELECT ?celexNumber (SAMPLE(?date) AS ?pageDate) WHERE {
      ?work cdm:resource_legal_id_celex ?celexNumber .
      ${typeConstraint}
      OPTIONAL { ?work cdm:work_date_document ?date . }
      ${keywordClause}
      ${filters.join('\n      ')}
    } GROUP BY ?celexNumber ORDER BY DESC(?pageDate) ?celexNumber ${paging}
  }
  ${rowPattern(keywordClause && `FILTER EXISTS {\n    ${keywordClause}\n  }`)}
} GROUP BY ?celexNumber ORDER BY DESC(?docDate) ?celexNumber`
        : `
${projection('?date')} WHERE {
  ${rowPattern(keywordClause)}
} GROUP BY ?celexNumber ORDER BY DESC(?docDate) ?celexNumber ${paging}`;

    const queryEcho = {
      ...(input.case_number ? { case_number: input.case_number } : {}),
      ...(celexFragment ? { celex_fragment: celexFragment } : {}),
      ...(keywordInput ? { keyword: keywordInput } : {}),
      ...(input.court ? { court: input.court } : {}),
      ...(input.case_type ? { case_type: input.case_type } : {}),
      // Echo the effective flag (Zod applies the false default, so it is always a
      // boolean) — a defaulted false still describes the search semantics (#57).
      include_derivative: input.include_derivative,
      ...(input.date_from ? { date_from: input.date_from } : {}),
      ...(input.date_to ? { date_to: input.date_to } : {}),
    };

    const bindings = await svc.queryWithContinuation(sparql, ctx);
    ctx.log.info('Case law search', {
      caseNumber: input.case_number,
      celexFragment,
      keyword: input.keyword,
      court: input.court,
      caseType: input.case_type,
      resultCount: bindings.length,
    });

    if (bindings.length === 0 && input.offset === 0) {
      const filterSummary = Object.entries(queryEcho)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(', ');
      throw ctx.fail(
        'no_results',
        `No case law records matched the search criteria${filterSummary ? `. Filters: ${filterSummary}` : '.'}`,
        { ...ctx.recoveryFor('no_results') },
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
    const cases = page.map((b) => {
      const celexNumber = CellarSparqlService.bindingValue(b, 'celex') ?? '';
      const c: {
        work_uri: string;
        celex_number: string;
        ecli?: string;
        resource_type?: string;
        date?: string;
        title?: string;
        display_title?: string;
        parties?: string;
        subject_matter?: string;
        case_reference?: string;
      } = {
        work_uri:
          resolvedWorks.get(celexNumber) ??
          CellarSparqlService.bindingValue(b, 'titledWork') ??
          CellarSparqlService.bindingValue(b, 'work') ??
          '',
        celex_number: celexNumber,
      };
      const ecli = CellarSparqlService.bindingValue(b, 'ecli');
      if (ecli) c.ecli = ecli;
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

    if (hasMore) {
      ctx.enrich.truncated({ shown: cases.length, cap: pageLimit });
    }

    return {
      cases,
      total: cases.length,
      offset: input.offset,
      has_more: hasMore,
      ...(hasMore ? { next_offset: input.offset + pageLimit } : {}),
      query_echo: queryEcho,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `## CJEU/GC Case Law (${result.total} results, offset ${result.offset})\n`,
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
    for (const c of result.cases) {
      // Prefer the clean parsed display title; fall back to the raw title (already
      // clean for the plain, non-"#"-delimited titles that don't parse).
      const heading = c.display_title ?? c.title;
      lines.push(`### ${c.celex_number}${heading ? ` — ${heading}` : ''}`);
      if (c.date) lines.push(`**Date:** ${c.date}`);
      if (c.ecli) lines.push(`**ECLI:** ${c.ecli}`);
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
