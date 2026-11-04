/**
 * @fileoverview eurlex_get_cases — Search CJEU and General Court case law.
 * @module mcp-server/tools/definitions/eurlex-get-cases
 */

import { type Context, tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { echoValue } from '@/mcp-server/tools/echo-value.js';
import { enumInput } from '@/mcp-server/tools/enum-input.js';
import {
  clampLimit,
  limitClampEnrichment,
  limitClampTrailer,
  ROW_LIMIT_CEILING,
} from '@/mcp-server/tools/limit-clamp.js';
import {
  escapeMarkdownHeading,
  renderNoticeBlockquote,
} from '@/mcp-server/tools/markdown-render.js';
import { fetchCaseLawFacts } from '@/services/cellar-sparql/case-law-facts.js';
import {
  CASE_LAW_SUBJECT_MATTER_SCHEME,
  COUNTRY_AUTHORITY_URI,
  DERIVATIVE_RESOURCE_TYPES,
  ENG_LANGUAGE_URI,
  isProvisionalData,
  labelHoldsEveryWord,
  PROCEDURE_AUTHORITY_URI,
  PROCEDURE_OUTCOME_CODES,
  PROCEDURE_OUTCOME_SEPARATOR,
  PROCEDURE_OUTCOMES,
  PROCEDURE_TYPE_ROOTS,
  PROCEDURE_TYPES,
  type ProcedureOutcome,
  type ProcedureType,
  parseCaseLawTitle,
  resolveResourceTypeLabels,
  subjectWords,
} from '@/services/cellar-sparql/cdm-labels.js';
import {
  CellarSparqlService,
  getCellarSparqlService,
} from '@/services/cellar-sparql/cellar-sparql-service.js';
import {
  type CaseCourtLetter,
  escapeSparqlLiteral,
  isValidCalendarDate,
  parseCaseNumber,
} from '@/services/cellar-sparql/eli-resolution.js';
import {
  celexFragmentRoute,
  celexPrefixMatch,
  celexPrefixTerms,
  keywordMatchPattern,
  keywordTitlePhrase,
} from '@/services/cellar-sparql/keyword-match.js';
import {
  MEMBER_STATE_CODES,
  toMemberStateCode,
} from '@/services/cellar-sparql/relation-traversal.js';
import {
  cellarDate,
  dateRangeFilters,
  isPastSortWindow,
  readWindowedPage,
  UNDATED_PLACEHOLDER,
  windowEndRoute,
  windowedLimit,
} from '@/services/cellar-sparql/sort-window.js';
import type { SparqlBinding } from '@/services/cellar-sparql/types.js';
import {
  type PerWorkColumns,
  resolveCelexWorkRows,
} from '@/services/cellar-sparql/work-resolution.js';

/** Cases served per call; a larger `limit` is clamped to it. */
const MAX_PAGE_SIZE = 100;

/**
 * Case type → exact CDM resource-type authority family. A case_type filter tests the
 * work's resource-type, NOT a CELEX substring: abstract (`_RES` → ABSTRACT_JUR)
 * and summary (`_SUM` → SUM_JUR) sibling works carry the same CELEX type letters
 * as their parent judgment/order (they still CONTAIN "CJ"/"CO"), only under a
 * distinct CELEX, so a substring test admitted them as separate rows. Requiring
 * the resource-type excludes those derivative works (issue #38). CELLAR types
 * CJEU/GC judgments as JUDG, orders as ORDER, and AG opinions (CELEX "CC") as
 * OPIN_AG; AG Views (CELEX "CP") use VIEW_AG and belong to the same filter.
 */
const CASE_TYPES = ['judgment', 'order', 'ag_opinion'] as const;
const CASE_TYPE_RESOURCE_TYPES = {
  judgment: ['JUDG'],
  order: ['ORDER'],
  ag_opinion: ['OPIN_AG', 'VIEW_AG'],
} as const satisfies Record<(typeof CASE_TYPES)[number], readonly string[]>;

/**
 * What a row reads from the work its CELEX resolves to, in the page's resolution
 * follow-up (#146): its resource types, ECLI, and English titles. Titles live on
 * expressions, not works: ?expr cdm:expression_belongs_to_work ?work (inverse of
 * cdm:work_has_expression), in English, carrying cdm:expression_title.
 */
const CASE_WORK_COLUMNS: PerWorkColumns = {
  variables: ['?type', '?ecli', '?title'],
  patterns: [
    'OPTIONAL { ?work cdm:work_has_resource-type ?type . }',
    'OPTIONAL { ?work cdm:case-law_ecli ?ecli . }',
    `OPTIONAL {
    ?expr cdm:expression_belongs_to_work ?work .
    ?expr cdm:expression_uses_language <${ENG_LANGUAGE_URI}> .
    ?expr cdm:expression_title ?title .
  }`,
  ],
};

/** The values a column takes across rows, sorted by code unit. */
function columnValues(rows: readonly SparqlBinding[], column: string): string[] {
  return rows.flatMap((b) => CellarSparqlService.bindingValue(b, column) ?? []).sort();
}

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
const COURTS = ['CJEU', 'GC'] as const satisfies readonly (keyof typeof COURT_CELEX_LETTER)[];
const CASE_NUMBER_DOCUMENT_LETTERS = {
  C: { primary: 'JOCPSTD', notices: 'ABN' },
  T: { primary: 'JOCT', notices: 'ABN' },
  F: { primary: 'JO', notices: 'ABN' },
} as const satisfies Record<CaseCourtLetter, { primary: string; notices: string }>;

/**
 * A value made only of characters a CELEX can hold. Every sector-6 CELEX is made of
 * these characters alone, so any value a CELEX substring match can reach is one of
 * these strings; a value that parses as no case number and contains anything else
 * can never match and is rejected instead of answered with an empty search.
 */
const CELEX_CHARACTERS = /^[0-9A-Za-z()_]+$/;

/**
 * Openings a CELEX-character case_number can hold at one position of a sector-6
 * CELEX only: the sector and year (`62014CJ…`, position 1), the year and both
 * letters (`2013CJ…`, position 2), or both letters and the number (`CJ0131`,
 * position 6). A live check of every sector-6 CELEX (2026-09-25) found them all
 * shaped `6{year}{court}{document}{number}` with a year from 1951, followed by
 * `(nn)`, `R(nn)`, or an `_` suffix, and none of these openings anywhere else. So
 * the prefix terms that complete such a value to a CELEX start reach every CELEX
 * holding it (#134). Any other opening (`12CJ0131`, `J0131`, `C0097`, which is
 * also the tail of `62023CC0097`) could sit elsewhere in a CELEX, so the index
 * could miss a literal the substring holds.
 */
const INDEXED_CASE_CELEX_OPENING = /^(?:6\d{4}|\d{4}[A-Z]{2}|[A-Z]{2}\d)/;

/**
 * The match for a case_number made of CELEX characters that parses as no case
 * number: every sector-6 CELEX holding it, case-insensitively. An opening in
 * {@link INDEXED_CASE_CELEX_OPENING} is answered from the CELEX full-text index,
 * its sector-6 prefix terms plus the confirming substring test (#134), since
 * CELLAR stores CELEX in upper case; any other value, and one the keyword route
 * gives no sector-6 term (a year past next year, letters no sector-6 type code
 * ends in), keeps the substring test of every CELEX literal.
 */
function celexSubstringMatch(value: string): string {
  const upper = value.toUpperCase();
  const route = INDEXED_CASE_CELEX_OPENING.test(upper) ? celexFragmentRoute(upper) : undefined;
  const terms = route?.kind === 'index' ? route.terms.filter((term) => term.startsWith('6')) : [];
  return terms.length > 0
    ? celexPrefixMatch('?celexNumber', upper, terms)
    : `FILTER(CONTAINS(LCASE(STR(?celexNumber)), LCASE("${escapeSparqlLiteral(value)}")))`;
}

/**
 * The match for a parsed case number: `{year}{court}[{document letters}]{number}` as
 * an unanchored `REGEX` behind one CELEX full-text prefix term per
 * document letter (`'62014CJ0443*' OR '62014CO0443*' OR …`), so CELLAR tests the
 * index hits rather than every sector-6 CELEX (#138). The terms reach every CELEX the
 * `REGEX` admits: a four-digit year followed by two letters sits only at position 2
 * of a sector-6 CELEX (the #134 survey), so the match opens its first word. Each
 * term is built from the parsed digits, the court letter, and a document letter
 * from {@link CASE_NUMBER_DOCUMENT_LETTERS}, never from caller text. A year written
 * with fewer than four digits (`C-131/012`, read as 12) keeps the `REGEX` alone,
 * which reaches that year's digits at the end of a four-digit year.
 */
function caseNumberMatch(
  { court, year, number }: { court: CaseCourtLetter; year: number; number: string },
  documentLetters: string,
): string {
  const regex = `FILTER(REGEX(STR(?celexNumber), "${year}${court}[${documentLetters}]${number}"))`;
  if (year < 1000) return regex;
  const terms = [...documentLetters].map((letter) => `6${year}${court}${letter}${number}`);
  return `${celexPrefixTerms('?celexNumber', terms)}\n    ${regex}`;
}

/**
 * The procedure match: a procedure code of the work that is one of the type's roots or
 * a root plus an outcome (`ANNU`, `ANNU%3DOB`), never a longer root sharing its start
 * (`REFE` must not take `REFER_PREL_URG`). With an outcome, the code is that root plus
 * that outcome, so both hold on the same procedure: a case recorded as `ANNU%3DRF`
 * and `PVOI%3DOB` is no successful annulment. An outcome alone matches any root
 * carrying it. Built from the enum tables alone; undefined when neither is given.
 */
function procedurePattern(
  type: ProcedureType | undefined,
  outcome: ProcedureOutcome | undefined,
): string | undefined {
  const triple = '?work cdm:case-law_has_type_procedure_concept_type_procedure ?procedure .';
  const suffix = outcome
    ? `${PROCEDURE_OUTCOME_SEPARATOR}${PROCEDURE_OUTCOME_CODES[outcome]}`
    : undefined;
  if (!type) return suffix && `${triple}\n  FILTER(STRENDS(STR(?procedure), "${suffix}"))`;
  const tests = PROCEDURE_TYPE_ROOTS[type].flatMap((root) => {
    const code = `${PROCEDURE_AUTHORITY_URI}${root}`;
    return suffix
      ? [`?procedure = <${code}${suffix}>`]
      : [
          `?procedure = <${code}>`,
          `STRSTARTS(STR(?procedure), "${code}${PROCEDURE_OUTCOME_SEPARATOR}")`,
        ];
  });
  return `${triple}\n  FILTER(${tests.join(' || ')})`;
}

/**
 * The case-law subjects a subject phrase names: every concept of the subject-matter
 * scheme whose English label holds each of `words`, but the "Provisional data"
 * placeholder, with the labels matched. One lookup of the scheme's English labels,
 * matched here, so no caller text reaches the query; it needs no `LIMIT`, since the
 * scheme bounds it (186 concepts). The page then joins the concepts as `VALUES`,
 * about 18× faster than testing the labels inside the page query.
 */
async function resolveSubjects(
  svc: Pick<CellarSparqlService, 'query'>,
  words: readonly string[],
  ctx: Context,
): Promise<{ concepts: string[]; labels: string[] }> {
  const rows = await svc.query(
    `
SELECT ?concept ?label WHERE {
  ?concept skos:inScheme <${CASE_LAW_SUBJECT_MATTER_SCHEME}> .
  ?concept skos:prefLabel ?label .
  FILTER(LANG(?label) = "en")
}`,
    ctx,
  );
  const concepts = new Set<string>();
  const labels = new Set<string>();
  for (const b of rows) {
    const concept = CellarSparqlService.bindingValue(b, 'concept');
    const label = CellarSparqlService.bindingValue(b, 'label');
    if (!concept || !label || isProvisionalData(concept) || !labelHoldsEveryWord(label, words)) {
      continue;
    }
    concepts.add(concept);
    labels.add(label);
  }
  return { concepts: [...concepts].sort(), labels: [...labels].sort() };
}

export const eurlex_get_cases = tool('eurlex_get_cases', {
  title: 'Search CJEU/GC Case Law',
  description:
    'Search CJEU and General Court case law — judgments, orders, and Advocate General opinions and views — by case number, court, case type, member state, procedure type and outcome, subject, keyword, and date range. A case number reaches every judgment, order, AG opinion, and AG view filed under it. By default only these primary records are returned; derivative judicial information notices, case abstracts, summaries, and corrigenda are excluded so distinct cases fill the page (set include_derivative to include them). Keyword matches English case titles (which carry party names) and CELEX strings; there is no full-text body search. member_state, procedure_type, outcome, and subject match the facts CELLAR records on each case, so a case it records none of a filtered fact for never matches. Returns each case with its CELEX number (whose sixth character names the court: C, T, or F), work URI, ECLI, date, and type; where CELLAR records them, its countries, procedure types with outcome, subjects, and procedure languages; and — parsed from the title where present — the formation, Advocate General, parties, referring court, subject matter, and case reference. The raw CELLAR title is returned only when those fields do not capture all of it.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    case_number: z
      .string()
      .optional()
      .describe(
        'Number of a single case: C-{num}/{year} (Court of Justice), T-{num}/{year} (General Court), or F-{num}/{year} (Civil Service Tribunal), e.g. C-131/12. Also accepts the case_reference form ("Case C-97/23 P."), any procedural suffix after the year (P, R, PPU, …), and a pre-1989 Court of Justice number with no prefix (26/62). A value naming more than one case ("C-131/12 and C-132/12") is rejected; search each separately. Matches the judgments, orders, AG opinions, and other primary records filed under that number; derivative records (notices, abstracts, summaries, corrigenda) join only under include_derivative. Numbered Opinions and Rulings of the Court of Justice ("Opinion 2/13", "Ruling 1/78") are not reached by a case number; look one up by its CELEX (e.g. 62013CV0002). A value made only of CELEX characters is matched as a CELEX substring instead, case-insensitively: one opening with the sector and year (62014CJ0362), the year and both letters (2013CJ0131), or both letters and the number (CJ0131) is answered from the CELEX index; any other (12CJ0131, 0131) tests every CELEX and can take tens of seconds.',
      ),
    keyword: z
      .string()
      .optional()
      .describe(
        'Keyword matched against English case titles via the full-text index (multi-word input is treated as a phrase), and against CELEX numbers. A keyword that is a whole CELEX (e.g. 62023CO0097) matches that record, its numbered siblings (…(01) to …(20)), its _INF, _RES, _SUM, and _EXT records, and its corrigenda, with notices, abstracts, summaries, and corrigenda still joining only under include_derivative; for every record filed under a case, use case_number. A partial CELEX that opens with the sector and year (62013CJ), the year and type letters (2013CJ0131), or type letters followed by the number (CJ0131, J0131) matches every CELEX that holds it at that position; one opening with letters not followed by a digit (R(01)) tests every CELEX and can take tens of seconds; a bare year (2013) or a fragment opening mid-year or mid-number (013CJ0131, 0131) matches titles only. A keyword with no digit, or with a character no CELEX holds (a space, a period), matches titles only. A keyword with no letter or digit is rejected.',
      ),
    court: enumInput(
      COURTS,
      z
        .union([
          z.literal(''),
          z.enum(COURTS).describe('CJEU (C) = Court of Justice of the EU, GC (T) = General Court.'),
        ])
        .optional()
        .describe(
          'Court filter, by the court letter at position 6 of the CELEX: CJEU (C) = Court of Justice of the EU, GC (T) = General Court. It does not narrow by record type: every primary record the court filed matches, and its derivative records (notices, abstracts, summaries, corrigenda) join only under include_derivative. Omit to search every court.',
        ),
    ),
    case_type: enumInput(
      CASE_TYPES,
      z
        .union([
          z.literal(''),
          z
            .enum(CASE_TYPES)
            .describe(
              'judgment, order (procedural decision), or ag_opinion (Advocate General opinion or view).',
            ),
        ])
        .optional()
        .describe(
          'Case type: judgment, order (procedural decision), or ag_opinion (Advocate General opinion or view). Omit to search all.',
        ),
    ),
    member_state: z
      .string()
      .refine((value) => value.trim() === '' || toMemberStateCode(value) !== undefined, {
        message: `member_state takes a member-state code: ISO 3166-1 alpha-3 (${MEMBER_STATE_CODES.join(', ')}; GBR is the United Kingdom) or the two-letter codes (DE, FR; EL or GR for Greece, UK or GB for the United Kingdom), in any case.`,
      })
      .optional()
      .describe(
        "Member state the case originates in, as CELLAR records it: the referring court's state on a preliminary reference, the defendant state on an action for failure to fulfil obligations, the applicant's state (or the member state party) on a direct action. A member state as its ISO 3166-1 alpha-3 code (DEU, GRC, GBR for the United Kingdom) or two-letter code (DE; EL or GR for Greece; UK or GB), in any case: the 27 member states plus the United Kingdom. Cases CELLAR records no country for, Civil Service Tribunal staff cases among them, never match. Leave blank or omit to search every state.",
      ),
    procedure_type: enumInput(
      PROCEDURE_TYPES,
      z
        .union([
          z.literal(''),
          z
            .enum(PROCEDURE_TYPES)
            .describe(
              'preliminary_ruling, annulment, staff_case, appeal, failure_to_fulfil_obligations, damages, interim_measures, appeal_against_penalty, failure_to_act, or arbitration_clause.',
            ),
        ])
        .optional()
        .describe(
          'Procedure type, as CELLAR classifies the case: preliminary_ruling (urgent references included), annulment, staff_case, appeal, failure_to_fulfil_obligations, damages, interim_measures, appeal_against_penalty, failure_to_act, or arbitration_clause. A case can carry several: an appeal also carries the action appealed. Each row lists its own in procedure_types. Omit to search all.',
        ),
    ),
    outcome: enumInput(
      PROCEDURE_OUTCOMES,
      z
        .union([
          z.literal(''),
          z
            .enum(PROCEDURE_OUTCOMES)
            .describe('successful, unfounded, inadmissible, or decision_unnecessary.'),
        ])
        .optional()
        .describe(
          'Outcome CELLAR records with the procedure: successful, unfounded, inadmissible, or decision_unnecessary. With procedure_type, both hold on the same procedure (annulment with successful finds annulment actions that succeeded); alone, any procedure with that outcome. Preliminary references rarely record one. Omit to search all.',
        ),
    ),
    subject: z
      .string()
      .optional()
      .describe(
        'Subject phrase matched against the English labels of CELLAR\'s case-law subject classification: the search covers every subject whose label contains each word of the phrase, in any case and also inside a longer word ("trade mark" matches "Trade marks", "personal data" "Protection of personal data", "tax" also "Taxation"). query_echo.subject_labels names the subjects matched; each row lists its own in subjects. This is not the title\'s subject_matter keywords. A phrase matching no label returns an empty page with a notice. Leave blank or omit to search every subject.',
      ),
    include_derivative: z
      .boolean()
      .default(false)
      .describe(
        'Include derivative sector-6 records — judicial information notices, case abstracts, case summaries, and corrigenda — alongside primary judgments, orders, AG opinions, and AG views. Default false: these are excluded so distinct primary cases fill the page. Ignored when case_type is set (that path already requires the selected primary type family). Has no effect beside member_state, procedure_type, outcome, or subject, since derivative records carry none of those facts.',
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
      .describe(
        'Pagination offset — number of results to skip. Defaults to 0. Must be below 10,000: CELLAR sorts at most 10,000 matches for one search, so pages stop at row 10,000; narrow with a date_from/date_to window to reach older cases.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(ROW_LIMIT_CEILING)
      .default(20)
      .describe(
        'Maximum number of results to return, served up to 100 per call; a larger value (up to 10,000) is served at 100 and reported in limit_clamp. Defaults to 20.',
      ),
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
            date: z
              .string()
              .optional()
              .describe(
                `Judgment/opinion date in ISO 8601 format. Absent when CELLAR records no real document date — none, or the ${UNDATED_PLACEHOLDER} it records for an undated work; such cases sort last.`,
              ),
            title: z
              .string()
              .optional()
              .describe(
                'Raw English expression title as stored in CELLAR, a "#"-delimited string (court, formation and date; parties; referral; subject matter; case reference). Present only when the parsed fields do not capture all of it: a segment the parser could not place, a judgment or order published by extracts ("(Extracts)"), a leading date that differs from date, or a title with no "#". Absent when the parse is complete, and for records with no English title.',
              ),
            formation: z
              .string()
              .optional()
              .describe(
                'Formation that decided, from the title\'s leading segment, verbatim (e.g. "Grand Chamber", "Full Court", "Fourth Chamber, Extended Composition"), or "President", "Vice-President", or "President of the Second Chamber" for an order issued by that office. Absent when the title names none, as older "Judgment of the Court of …" titles do.',
              ),
            advocate_general: z
              .string()
              .optional()
              .describe(
                'Advocate General who delivered the opinion, from an AG opinion title (e.g. "Jääskinen"). Absent on judgments and orders.',
              ),
            display_title: z
              .string()
              .optional()
              .describe(
                'Clean human-readable title for display — the parties for a contested case (e.g. "Google Spain SL v AEPD"), or the court/AG descriptor when a case has no named parties. Parsed from the English title; absent when the record has none or its title carries no "#" segments.',
              ),
            parties: z
              .string()
              .optional()
              .describe(
                'Parties to the case, parsed from the title (e.g. "WhatsApp Ireland Ltd v European Data Protection Board."). Absent when the title carries no parties segment (e.g. AG opinions).',
              ),
            referring_court: z
              .string()
              .optional()
              .describe(
                'National court that referred a preliminary ruling, from the title\'s referral segment (e.g. "Audiencia Nacional", or "Tariefcommissie - Netherlands" in older titles). Absent on direct actions and appeals.',
              ),
            subject_matter: z
              .string()
              .optional()
              .describe(
                "Subject-matter keyword summary parsed from the title — the legal topics and provisions at issue. Free text, unlike subjects, CELLAR's subject classification. Absent when the title carries no subject-matter segment.",
              ),
            case_reference: z
              .string()
              .optional()
              .describe(
                'Case reference parsed from the title (e.g. "Case C-97/23 P."). Absent when the title carries no case-reference segment.',
              ),
            countries: z
              .array(z.string().describe('ISO 3166-1 alpha-3 country code, e.g. "BGR".'))
              .optional()
              .describe(
                "Countries CELLAR records the case as originating in, as ISO 3166-1 alpha-3 codes, sorted: the referring court's state on a preliminary reference, the defendant state on an action for failure to fulfil obligations, the applicant's state on a direct action. Member states, the values member_state takes, bar a few older direct actions by non-EU applicants. Absent when CELLAR records none, as on Civil Service Tribunal staff cases.",
              ),
            procedure_types: z
              .array(
                z
                  .string()
                  .describe('English procedure label, e.g. "Action for annulment - successful".'),
              )
              .optional()
              .describe(
                'Procedure types CELLAR classifies the case under, as English labels with the outcome where recorded ("Reference for a preliminary ruling", "Appeal - unfounded"), sorted; what procedure_type and outcome match. An appeal also lists the action appealed. Absent when CELLAR records none.',
              ),
            subjects: z
              .array(
                z.string().describe('English subject label, e.g. "Protection of personal data".'),
              )
              .optional()
              .describe(
                "Subjects of CELLAR's case-law subject classification, as English labels, sorted; what subject matches. A controlled vocabulary, unlike the title's subject_matter keywords. Absent when CELLAR records none.",
              ),
            procedure_languages: z
              .array(z.string().describe('Two-letter EUR-Lex language code, e.g. "BG".'))
              .optional()
              .describe(
                'Languages of the case, as the two-letter codes eurlex_get_document takes as language, sorted. Absent when CELLAR records none, as on about half of the Court of Justice AG opinions and records dated before 1990.',
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
      .describe(
        'True only when CELLAR returned an additional valid row beyond this page. False on a page that ends at row 10,000, the last one CELLAR sorts; its notice says whether more may match.',
      ),
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
        member_state: z
          .string()
          .optional()
          .describe('Member-state filter applied, as its ISO 3166-1 alpha-3 code.'),
        procedure_type: z.string().optional().describe('Procedure type filter applied.'),
        outcome: z.string().optional().describe('Outcome filter applied.'),
        subject: z.string().optional().describe('Subject phrase applied.'),
        subject_labels: z
          .array(z.string().describe('English subject label.'))
          .optional()
          .describe(
            'English labels of the subjects the subject phrase matched, sorted: the subjects the search was narrowed to. Empty when the phrase matched none, and then no case was searched. Absent when no subject was given.',
          ),
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
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance for the next call: on an empty first page, the filters that matched nothing and how to broaden them; when subject matched no subject label, that no case was searched; on a page with more rows, the offset to continue from; on a page ending at row 10,000, that no later page can be read and the closed date_from/date_to window that continues past it.',
      ),
    limit_clamp: limitClampEnrichment,
  },
  enrichmentTrailer: {
    limit_clamp: limitClampTrailer,
    // The notice quotes caller filters and a CELLAR date, so it is escaped whole and reads back as written.
    notice: {
      render: (notice?: string) => renderNoticeBlockquote(String(notice)),
    },
  },

  errors: [
    {
      reason: 'offset_past_window',
      code: JsonRpcErrorCode.ValidationError,
      when: 'offset is 10,000 or more, past the last row CELLAR sorts for one search.',
      recovery:
        'Narrow the search below 10,000 matches — search a date_from/date_to window ending at the date of the last case reached (results run newest first), or add court, case_type, keyword, member_state, procedure_type, outcome, or subject — then page from offset 0.',
    },
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
      reason: 'invalid_keyword',
      code: JsonRpcErrorCode.ValidationError,
      when: 'keyword holds no letters or digits, so no case title and no CELEX can match it.',
      recovery:
        'Pass a party name or title phrase (e.g. "Google Spain") or a CELEX number (e.g. 62013CJ0131), or omit keyword.',
    },
    {
      reason: 'invalid_subject',
      code: JsonRpcErrorCode.ValidationError,
      when: 'subject holds no letters or digits, so no subject label can match it.',
      recovery:
        'Pass a subject phrase such as "data protection", "trade mark", or "state aid", or omit subject.',
    },
    {
      reason: 'sparql_error',
      code: JsonRpcErrorCode.ValidationError,
      when: 'CELLAR rejected the search it was sent: a filter combination its query planner cannot compile. The same call fails the same way again.',
      recovery:
        'Drop one of the combined filters (keyword, case_number, case_type, court, member_state, procedure_type, outcome, subject), then search again.',
      thrownBy: 'service',
    },
    {
      reason: 'sparql_timeout',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: "The search ran past its time budget (retryable: CELLAR's response time varies, so a later search can finish), or CELLAR refused it as too costly to run (not retryable: the same search is refused again). Neither is retried within the call.",
      recovery:
        'Narrow the search with a closer date_from/date_to range, a court, or a more specific keyword or case_number, then search again.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    if (isPastSortWindow(input.offset)) {
      throw ctx.fail(
        'offset_past_window',
        `offset ${input.offset} is past row 10,000, the last row CELLAR sorts for one search, so no page starts there.`,
      );
    }
    const svc = getCellarSparqlService();
    const pageLimit = clampLimit(ctx, input.limit, Math.min(MAX_PAGE_SIZE, svc.maxResults));

    /**
     * Date-range validity, checked before any clause is built. The schema pins the
     * `YYYY-MM-DD` shape only, so an impossible calendar day or an inverted range
     * still reaches CELLAR as an `xsd:date` comparison that Virtuoso answers with
     * zero bindings — the caller would see an empty page and never learn the input
     * was at fault. Both values are shape- and calendar-valid by the time the range is
     * compared, so a lexicographic comparison of the ISO strings is a chronological
     * one.
     */
    const dateFrom = input.date_from?.trim();
    const dateTo = input.date_to?.trim();
    if (dateFrom && !isValidCalendarDate(dateFrom)) {
      throw ctx.fail('invalid_date_range', `date_from "${dateFrom}" is not a real calendar date.`);
    }
    if (dateTo && !isValidCalendarDate(dateTo)) {
      throw ctx.fail('invalid_date_range', `date_to "${dateTo}" is not a real calendar date.`);
    }
    if (dateFrom && dateTo && dateFrom > dateTo) {
      throw ctx.fail(
        'invalid_date_range',
        `Date range is inverted: date_from "${dateFrom}" falls after date_to "${dateTo}".`,
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
     * that parsed before still reaches what it reached then; it confirms the CELEX
     * index hits of one prefix term per letter ({@link caseNumberMatch}). A value
     * that parses as no case number keeps the CELEX-substring match only when it is
     * made of CELEX characters, answered from the CELEX index where its opening
     * allows ({@link celexSubstringMatch}); anything else could never match and is
     * rejected.
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
        filters.push(caseNumberMatch(parsed, documentLetters));
      } else if (parsed.kind === 'unparsed' && CELEX_CHARACTERS.test(caseNumberInput)) {
        filters.push(celexSubstringMatch(caseNumberInput));
      } else {
        const quoted = echoValue(caseNumberInput);
        throw ctx.fail(
          'invalid_case_number',
          parsed.kind === 'unprefixed_out_of_range'
            ? `Case number "${quoted}" has no court prefix, and its year ${parsed.year} falls outside 1953–1988, when unprefixed Court of Justice numbers were issued. Add the C-, T-, or F- prefix.`
            : parsed.kind === 'several'
              ? `Case number "${quoted}" names more than one case.`
              : `Case number "${quoted}" is not a recognizable case number.`,
        );
      }
    }

    /**
     * A keyword with no letter or digit can match no title and no CELEX, so answering
     * it would return an empty page that silently drops every other filter. The input
     * is at fault, so it is rejected before any CELLAR call.
     */
    const keywordInput = input.keyword?.trim();
    if (keywordInput && !keywordTitlePhrase(keywordInput)) {
      throw ctx.fail(
        'invalid_keyword',
        `keyword "${echoValue(keywordInput)}" holds no letters or digits.`,
      );
    }

    // A subject with no letter or digit can match no subject label, so it is rejected
    // the same way, before any CELLAR call.
    const subjectInput = input.subject?.trim();
    const subjectTerms = subjectInput ? subjectWords(subjectInput) : [];
    if (subjectInput && subjectTerms.length === 0) {
      throw ctx.fail(
        'invalid_subject',
        `subject "${echoValue(subjectInput)}" holds no letters or digits.`,
      );
    }
    // The schema admits only a member-state code or a blank value, which names none.
    const memberState = input.member_state ? toMemberStateCode(input.member_state) : undefined;

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
     * opinions (issue #38). The display label still lists every type the resolved
     * work carries, so a corrigendum-judgment keeps all its labels.
     */
    let typeConstraint = '';
    if (input.case_type) {
      const typeUris = CASE_TYPE_RESOURCE_TYPES[input.case_type].map(
        (code) => `<http://publications.europa.eu/resource/authority/resource-type/${code}>`,
      );
      typeConstraint =
        typeUris.length === 1
          ? `?work cdm:work_has_resource-type ${typeUris[0]} .`
          : `VALUES ?selectedCaseType { ${typeUris.join(' ')} }
  ?work cdm:work_has_resource-type ?selectedCaseType .`;
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

    filters.push(...dateRangeFilters(dateFrom, dateTo));

    /**
     * The case-law facts CELLAR records on a work (#178), each a required pattern, so
     * a case it records none of a filtered fact for never matches, and derivative
     * records, which carry none, drop out whatever include_derivative says. They are
     * appended only when set, so a search without them sends the query it always did.
     */
    const factPatterns: string[] = [];
    if (memberState) {
      factPatterns.push(
        `?work cdm:case-law_originates_in_country <${COUNTRY_AUTHORITY_URI}${memberState}> .`,
      );
    }
    const procedure = procedurePattern(
      input.procedure_type || undefined,
      input.outcome || undefined,
    );
    if (procedure) factPatterns.push(procedure);

    // The subject's one lookup runs before the page, which joins what it resolved to.
    const subjects = subjectInput ? await resolveSubjects(svc, subjectTerms, ctx) : undefined;
    if (subjects?.concepts.length) {
      factPatterns.push(
        `VALUES ?subject { ${subjects.concepts.map((uri) => `<${uri}>`).join(' ')} }
  ?work cdm:case-law_is-about_case-law-subject-matter ?subject .`,
      );
    }

    const queryEcho = {
      ...(input.case_number ? { case_number: input.case_number } : {}),
      ...(celexFragment ? { celex_fragment: celexFragment } : {}),
      ...(keywordInput ? { keyword: keywordInput } : {}),
      ...(input.court ? { court: input.court } : {}),
      ...(input.case_type ? { case_type: input.case_type } : {}),
      ...(memberState ? { member_state: memberState } : {}),
      ...(input.procedure_type ? { procedure_type: input.procedure_type } : {}),
      ...(input.outcome ? { outcome: input.outcome } : {}),
      ...(subjectInput && subjects
        ? { subject: subjectInput, subject_labels: subjects.labels }
        : {}),
      // Echo the effective flag (Zod applies the false default, so it is always a
      // boolean) — a defaulted false still describes the search semantics (#57).
      include_derivative: input.include_derivative,
      ...(input.date_from ? { date_from: input.date_from } : {}),
      ...(input.date_to ? { date_to: input.date_to } : {}),
    };

    // A subject naming no label leaves no case to search: an empty page, no page query.
    if (subjectInput && subjects?.concepts.length === 0) {
      ctx.enrich.notice(
        `No case-law subject label contains every word of subject "${echoValue(subjectInput)}", so no case was searched. Try fewer or other words — labels read like "Protection of personal data", "Trade marks", or "State aid" — or omit subject.`,
      );
      return { cases: [], total: 0, offset: input.offset, has_more: false, query_echo: queryEcho };
    }

    // Title arm on the full-text index, CELEX arm by the keyword's shape (#17, #105).
    // Its one CELLAR lookup runs only once the input has passed validation.
    const keywordClause = keywordInput ? await keywordMatchPattern(svc, keywordInput, ctx) : '';

    /**
     * The search pages CELEX keys and dates alone; each row's title, types, and ECLI
     * come from the work its CELEX resolves to, read in the page's follow-up (#146).
     * It also samples one work of each CELEX, the row's work URI should the follow-up
     * miss it.
     *
     * GROUP BY ?celexNumber collapses the several works that can share one CELEX
     * (e.g. a judgment plus its do_not_index copy) into one row, so LIMIT N returns N
     * distinct cases and `total` counts cases rather than rows (issue #21).
     *
     * ?docDate uses SAMPLE, NOT MAX: under ORDER BY DESC(?docDate) a MAX over the
     * ordered column lets Virtuoso pick a date-index TOP-k plan that bypasses the
     * date-range upper-bound FILTER whenever no selective graph pattern is present (a
     * bare date/court/type search), returning the globally-latest cases instead of
     * the in-range ones. Date is single-valued per CELEX, so SAMPLE shows the same
     * value without triggering that plan.
     *
     * The CELEX breaks date ties, so the order is total: identical calls return
     * identical pages, and consecutive offsets neither repeat nor skip a case that
     * shares its date with others (#102). The tiebreak is the GROUP BY key
     * ?celexNumber, not the projected ?celex — Virtuoso does not sort on a SAMPLE
     * alias of a string.
     *
     * With nothing to aggregate beyond the key, the date, and that work, the query is the page
     * subquery the date-bounded page-first form (#98) once wrapped, whatever the
     * filters: the cost #98 avoided was gathering titles, types, and ECLI for every
     * matching case before the page was picked.
     *
     * The page asks for one sentinel row past it, cut to CELLAR's sort window
     * (#154): a sorted query may not read past row 10,000.
     */
    const sparql = `
SELECT
  (SAMPLE(?celexNumber) AS ?celex)
  (SAMPLE(?date) AS ?docDate)
  (SAMPLE(?work) AS ?pageWork) WHERE {
  ?work cdm:resource_legal_id_celex ?celexNumber .
  ${typeConstraint}
  OPTIONAL { ?work cdm:work_date_document ?date . }
  ${keywordClause}${factPatterns.map((pattern) => `\n  ${pattern}`).join('')}
  ${filters.join('\n  ')}
} GROUP BY ?celexNumber ORDER BY DESC(?docDate) ?celexNumber LIMIT ${windowedLimit(input.offset, pageLimit)} OFFSET ${input.offset}`;

    const bindings = await svc.queryWithContinuation(sparql, ctx);
    ctx.log.info('Case law search', {
      caseNumber: input.case_number,
      celexFragment,
      keyword: input.keyword,
      court: input.court,
      caseType: input.case_type,
      memberState,
      procedureType: input.procedure_type,
      outcome: input.outcome,
      subjectConcepts: subjects?.concepts.length,
      resultCount: bindings.length,
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
      const factFilters = (
        ['member_state', 'procedure_type', 'outcome', 'subject'] as const
      ).filter((key) => key in queryEcho);
      const [onlyFactFilter] = factFilters;
      const factHint =
        factFilters.length > 1
          ? ` Or drop one of ${factFilters.join(', ')}: each matches only the cases CELLAR records its fact for.`
          : onlyFactFilter
            ? ` Or drop ${onlyFactFilter}: it matches only the cases CELLAR records that fact for.`
            : '';
      ctx.enrich.notice(
        `No case law records matched the search criteria (${filterSummary}). Try a different keyword, broader date range, or remove the court/case_type filter.${factHint}`,
      );
    }

    const { hasMore, atWindowEnd } = readWindowedPage(bindings.length, input.offset, pageLimit);
    const page = bindings.slice(0, pageLimit);
    // A CELEX held by several works resolves to its canonical work (#97), in one
    // follow-up query for the page that also reads each work's types, ECLI, and
    // English titles (#146) — the alias match never binds inside the grouped
    // query above.
    const resolvedWorks = await resolveCelexWorkRows(
      svc,
      page.map((b) => CellarSparqlService.bindingValue(b, 'celex') ?? ''),
      ctx,
      CASE_WORK_COLUMNS,
    );
    /**
     * The case-law facts sit on the resolved work, never on its `do_not_index` copy
     * (#178), so they are read for the resolved works, in one more query: folded into
     * the resolution query above, each work's rows would multiply across its types,
     * titles, and every fact's values.
     */
    const facts = await fetchCaseLawFacts(
      svc,
      [...resolvedWorks.values()].map(({ work }) => work),
      ctx,
    );
    const cases = page.map((b) => {
      const celexNumber = CellarSparqlService.bindingValue(b, 'celex') ?? '';
      const date = cellarDate(CellarSparqlService.bindingValue(b, 'docDate'));
      const resolved = resolvedWorks.get(celexNumber);
      /**
       * The page's CELEX came from the same triple the follow-up joins on, so a miss
       * means CELLAR changed between the two queries. The row is served as the search
       * found it, under the work it sampled, with no fields the follow-up would read.
       */
      if (!resolved) {
        return {
          work_uri: CellarSparqlService.bindingValue(b, 'pageWork') ?? '',
          celex_number: celexNumber,
          ...(date ? { date } : {}),
        };
      }
      const c: {
        work_uri: string;
        celex_number: string;
        ecli?: string;
        resource_type?: string;
        date?: string;
        title?: string;
        formation?: string;
        advocate_general?: string;
        display_title?: string;
        parties?: string;
        referring_court?: string;
        subject_matter?: string;
        case_reference?: string;
      } = { work_uri: resolved.work, celex_number: celexNumber };
      /**
       * Every field but the date is the resolved work's, so a row matches
       * eurlex_get_document. Its ECLI is its own, else the lowest any work of the
       * CELEX records, since the canonical work can carry none while a copy does
       * (#84, #117); its title the greatest of its English titles, else of any work's,
       * so an untitled canonical work keeps a copy's (#21). The date stays the page's,
       * the value the row was sorted on.
       */
      const ecli =
        columnValues(resolved.workRows, 'ecli')[0] ?? columnValues(resolved.celexRows, 'ecli')[0];
      if (ecli) c.ecli = ecli;
      const types = [...new Set(columnValues(resolved.workRows, 'type'))].join(' ');
      const resourceType = resolveResourceTypeLabels(types);
      if (resourceType) c.resource_type = resourceType;
      if (date) c.date = date;
      /**
       * Surface the parsed case-law segments, and the raw title only when the parse
       * is incomplete (#116). A complete parse places every segment in a field and
       * dates the title as the row is dated, so dropping the raw string loses nothing
       * while it would otherwise repeat the row; an incomplete one keeps it, so
       * nothing the fields miss is dropped (#40).
       */
      const title =
        columnValues(resolved.workRows, 'title').at(-1) ??
        columnValues(resolved.celexRows, 'title').at(-1);
      if (title) {
        const parsed = parseCaseLawTitle(title, date);
        if (!parsed.complete) c.title = title;
        if (parsed.formation) c.formation = parsed.formation;
        if (parsed.advocateGeneral) c.advocate_general = parsed.advocateGeneral;
        if (parsed.displayTitle) c.display_title = parsed.displayTitle;
        if (parsed.parties) c.parties = parsed.parties;
        if (parsed.referringCourt) c.referring_court = parsed.referringCourt;
        if (parsed.subjectMatter) c.subject_matter = parsed.subjectMatter;
        if (parsed.caseReference) c.case_reference = parsed.caseReference;
      }
      return { ...c, ...facts.get(resolved.work) };
    });

    if (hasMore) {
      ctx.enrich.truncated({
        shown: cases.length,
        cap: pageLimit,
        guidance: `More cases match beyond this page; call again with offset=${input.offset + pageLimit}.`,
      });
    } else if (atWindowEnd) {
      // Rows run newest first, so the last row's date continues the search past the
      // window; cases of that date are read again.
      ctx.enrich.notice(
        `This page ends at row 10,000, the last row CELLAR sorts for one search, so no later page can be read and more cases may match. ${windowEndRoute('cases', cases.at(-1)?.date, dateFrom)}`,
      );
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
      const filters = echoEntries.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ');
      lines.push(`*Filters: ${escapeMarkdownInline(filters)}*\n`);
    }
    const field = (label: string, value: string) => `**${label}:** ${escapeMarkdownInline(value)}`;
    for (const c of result.cases) {
      // Prefer the clean parsed display title; fall back to the raw title (already
      // clean for the plain, non-"#"-delimited titles that don't parse).
      const heading = c.display_title ?? c.title;
      lines.push(
        `### ${escapeMarkdownHeading(c.celex_number)}${heading ? ` — ${escapeMarkdownHeading(heading)}` : ''}`,
      );
      if (c.date) lines.push(field('Date', c.date));
      if (c.ecli) lines.push(field('ECLI', c.ecli));
      if (c.resource_type) lines.push(field('Type', c.resource_type));
      if (c.formation) lines.push(field('Formation', c.formation));
      if (c.advocate_general) lines.push(field('Advocate General', c.advocate_general));
      // The heading already shows the parties when they are the display title.
      if (c.parties && c.parties !== heading) lines.push(field('Parties', c.parties));
      if (c.referring_court) lines.push(field('Referring court', c.referring_court));
      if (c.subject_matter) lines.push(field('Subject matter', c.subject_matter));
      if (c.case_reference) lines.push(field('Case reference', c.case_reference));
      if (c.countries) lines.push(field('Countries', c.countries.join(', ')));
      if (c.procedure_types) lines.push(field('Procedure types', c.procedure_types.join('; ')));
      if (c.subjects) lines.push(field('Subjects', c.subjects.join('; ')));
      if (c.procedure_languages) {
        lines.push(field('Procedure languages', c.procedure_languages.join(', ')));
      }
      // Raw CELLAR title, present only when the parsed fields miss part of it.
      if (c.title) lines.push(field('Full title', c.title));
      lines.push(field('Work URI', c.work_uri));
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
