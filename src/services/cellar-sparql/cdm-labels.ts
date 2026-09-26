/**
 * @fileoverview CDM resource-type URI → human-readable label map and resolvers, plus a
 * parser for CELLAR's `#`-delimited case-law expression titles. Used by tool handlers
 * that normalise raw CDM URIs and titles before returning results. Authors are not
 * labelled here: work-agents.ts reads each authority code's English `skos:prefLabel`
 * in its agent query.
 * @module services/cellar-sparql/cdm-labels
 */

/** CELLAR's language authority table; a language's URI appends its upper-case ISO 639-2/T code. */
export const LANGUAGE_AUTHORITY_URI = 'http://publications.europa.eu/resource/authority/language/';

/** English language URI used in expression-level title queries. */
export const ENG_LANGUAGE_URI = `${LANGUAGE_AUTHORITY_URI}ENG`;

/**
 * CDM resource-type URI → human-readable short label.
 * Covers common legislation types, case law types, and preparatory acts.
 * Falls back to the last URI path segment when not in the map.
 */
const RESOURCE_TYPE_LABEL_ENTRIES: Record<string, string> = {
  'http://publications.europa.eu/resource/authority/resource-type/REG': 'Regulation',
  'http://publications.europa.eu/resource/authority/resource-type/REG_ADOPT_INTERNATION':
    'Regulation Adopted by International Bodies',
  'http://publications.europa.eu/resource/authority/resource-type/REG_FINANC':
    'Financial Regulation',
  'http://publications.europa.eu/resource/authority/resource-type/DIR': 'Directive',
  'http://publications.europa.eu/resource/authority/resource-type/DIR_DEL': 'Delegated Directive',
  'http://publications.europa.eu/resource/authority/resource-type/DIR_IMPL':
    'Implementing Directive',
  'http://publications.europa.eu/resource/authority/resource-type/DEC': 'Decision',
  'http://publications.europa.eu/resource/authority/resource-type/DEC_ADOPT_INTERNATION':
    'Decision Adopted by International Bodies',
  'http://publications.europa.eu/resource/authority/resource-type/DEC_DEL': 'Delegated Decision',
  'http://publications.europa.eu/resource/authority/resource-type/DEC_ENTSCHEID': 'Decision',
  'http://publications.europa.eu/resource/authority/resource-type/DEC_FRAMW': 'Framework Decision',
  'http://publications.europa.eu/resource/authority/resource-type/DEC_IMPL':
    'Implementing Decision',
  'http://publications.europa.eu/resource/authority/resource-type/TREATY': 'Treaty',
  'http://publications.europa.eu/resource/authority/resource-type/JUDG': 'Judgment',
  'http://publications.europa.eu/resource/authority/resource-type/ORDER': 'Order',
  'http://publications.europa.eu/resource/authority/resource-type/OPIN_AG': 'AG Opinion',
  'http://publications.europa.eu/resource/authority/resource-type/AG_OPI': 'AG Opinion',
  'http://publications.europa.eu/resource/authority/resource-type/VIEW_AG': 'AG View',
  'http://publications.europa.eu/resource/authority/resource-type/RULING': 'Ruling',
  'http://publications.europa.eu/resource/authority/resource-type/AMEND_PROP': 'Amended Proposal',
  'http://publications.europa.eu/resource/authority/resource-type/AMEND_PROP_DEC':
    'Amended Proposal for a Decision',
  'http://publications.europa.eu/resource/authority/resource-type/AMEND_PROP_DIR':
    'Amended Proposal for a Directive',
  'http://publications.europa.eu/resource/authority/resource-type/AMEND_PROP_REG':
    'Amended Proposal for a Regulation',
  'http://publications.europa.eu/resource/authority/resource-type/JOINT_PROP_DEC':
    'Joint Proposal for a Decision',
  'http://publications.europa.eu/resource/authority/resource-type/JOINT_PROP_REG':
    'Joint Proposal for a Regulation',
  'http://publications.europa.eu/resource/authority/resource-type/PROP_ACT': 'Proposal for an Act',
  'http://publications.europa.eu/resource/authority/resource-type/PROP_DEC':
    'Proposal for a Decision',
  'http://publications.europa.eu/resource/authority/resource-type/PROP_DEC_IMPL':
    'Proposal for an Implementing Decision',
  'http://publications.europa.eu/resource/authority/resource-type/PROP_DEC_NO_ADDRESSEE':
    'Proposal for a Decision without Addressee',
  'http://publications.europa.eu/resource/authority/resource-type/PROP_DIR':
    'Proposal for a Directive',
  'http://publications.europa.eu/resource/authority/resource-type/PROP_DRAFT': 'Draft Proposal',
  'http://publications.europa.eu/resource/authority/resource-type/PROP_JOINT_ACTION':
    'Proposal for a Joint Action',
  'http://publications.europa.eu/resource/authority/resource-type/PROP_OPIN':
    'Proposal for an Opinion',
  'http://publications.europa.eu/resource/authority/resource-type/PROP_RECO':
    'Proposal for a Recommendation',
  'http://publications.europa.eu/resource/authority/resource-type/PROP_REG':
    'Proposal for a Regulation',
  'http://publications.europa.eu/resource/authority/resource-type/PROP_REG_IMPL':
    'Proposal for an Implementing Regulation',
  'http://publications.europa.eu/resource/authority/resource-type/PROP_RES':
    'Proposal for a Resolution',
  'http://publications.europa.eu/resource/authority/resource-type/RECO': 'Recommendation',
  'http://publications.europa.eu/resource/authority/resource-type/RECO_ADOPT_INTERNATION':
    'Recommendation Adopted by International Bodies',
  'http://publications.europa.eu/resource/authority/resource-type/RECO_DEC':
    'Recommendation for a Decision',
  'http://publications.europa.eu/resource/authority/resource-type/RECO_RECO':
    'Recommendation for a Recommendation',
  'http://publications.europa.eu/resource/authority/resource-type/RECO_REG':
    'Recommendation for a Regulation',
  'http://publications.europa.eu/resource/authority/resource-type/REC_SOFT': 'Recommendation',
  'http://publications.europa.eu/resource/authority/resource-type/RES': 'Resolution',
  'http://publications.europa.eu/resource/authority/resource-type/AGREE_INTERNATION':
    'International Agreement',
  'http://publications.europa.eu/resource/authority/resource-type/REG_IMPL':
    'Implementing Regulation',
  'http://publications.europa.eu/resource/authority/resource-type/REG_DEL': 'Delegated Regulation',
  // Derivative sector-6 case-law records. Excluded from the default eurlex_get_cases
  // search but reachable via include_derivative, so map them to labels rather than
  // raw codes (the same raw-code gap #43 fixed for REG_IMPL / REG_DEL).
  'http://publications.europa.eu/resource/authority/resource-type/INFO_JUDICIAL':
    'Judicial Information Notice',
  'http://publications.europa.eu/resource/authority/resource-type/INFO_JUR': 'Information Notice',
  'http://publications.europa.eu/resource/authority/resource-type/ABSTRACT_JUR': 'Case Abstract',
  'http://publications.europa.eu/resource/authority/resource-type/SUM_JUR': 'Case Summary',
  // Types the server's own headline flows return by default, so the raw-code
  // fallback was the common case rather than a long-tail one: CONS_TEXT is what
  // every `resolve: "current_consolidated"` call yields, MEAS_NATION_IMPL what
  // every national-transposition CELEX resolves to, and CORRIGENDUM co-types a
  // large share of a document-search page (the same raw-code gap #43 closed for
  // REG_IMPL / REG_DEL).
  'http://publications.europa.eu/resource/authority/resource-type/CONS_TEXT': 'Consolidated Text',
  'http://publications.europa.eu/resource/authority/resource-type/MEAS_NATION_IMPL':
    'National Implementing Measure',
  'http://publications.europa.eu/resource/authority/resource-type/CORRIGENDUM': 'Corrigendum',
  // The remaining resource-types sector-6 works carry, plus DEC_NC — the national-
  // court decision type (sector 8) eurlex_lookup_celex resolves. Each label is the
  // authority register's English skos:prefLabel in the map's Title Case, e.g.
  // JUDG_EXTRACT "Judgment (extracts)" and DEC_NC "Decision by national courts in
  // the field of European Union law". JUDG_EXTRACT / ORDER_EXTRACT sit on the default
  // eurlex_get_cases path, co-typed with the base judgment or order.
  'http://publications.europa.eu/resource/authority/resource-type/JUDG_EXTRACT':
    'Judgment (Extracts)',
  'http://publications.europa.eu/resource/authority/resource-type/ORDER_EXTRACT':
    'Order (Extracts)',
  'http://publications.europa.eu/resource/authority/resource-type/OPIN_JUR': 'Opinion of the Court',
  'http://publications.europa.eu/resource/authority/resource-type/DEC_NC':
    'Decision by National Courts in the Field of European Union Law',
  'http://publications.europa.eu/resource/authority/resource-type/DEC_REVIEW': 'Decision to Review',
  'http://publications.europa.eu/resource/authority/resource-type/GARNISHEE_ORDER':
    'Attachment Order',
  'http://publications.europa.eu/resource/authority/resource-type/THIRDPARTY_PROCEED':
    'Third-Party Proceedings',
  'http://publications.europa.eu/resource/authority/resource-type/DATPRO': 'Provisional Data',
};

/**
 * Lookup view of {@link RESOURCE_TYPE_LABEL_ENTRIES}. A `Map`, not the object
 * literal, so an upstream URI such as `constructor` cannot resolve through the
 * prototype chain.
 */
export const RESOURCE_TYPE_LABELS: ReadonlyMap<string, string> = new Map(
  Object.entries(RESOURCE_TYPE_LABEL_ENTRIES),
);

/**
 * Derivative sector-6 resource-types: information notices (INFO_JUDICIAL, INFO_JUR),
 * case-law abstracts (ABSTRACT_JUR), case summaries (SUM_JUR), and standalone
 * corrigenda (CORRIGENDUM). Each is a separate CELLAR work with its own CELEX
 * (`…_RES`, `…_SUM`, `…R(nn)`, the `CN`/`CA`/`TN`… notices) that restates or
 * announces a primary judgment, order, or AG opinion rather than being one.
 *
 * eurlex_get_cases excludes them from its default search, where at a page limit they
 * crowd distinct primary cases off the page (issue #44). eurlex_lookup_celex skips
 * them when one ECLI reaches several works, since an `_RES`/`_SUM` sibling carries
 * its parent's ECLI.
 *
 * CORRIGENDUM covers the standalone correction works, all carrying the CELEX `…R(nn)`
 * corrigendum marker (issue #55). No primary judgment/order/AG opinion is typed
 * CORRIGENDUM, so excluding the type drops only the correction record and never the
 * corrected case, which is a distinct CELEX. Listing it explicitly also makes the
 * exclusion robust: sector-6 corrigenda are currently co-typed INFO_JUDICIAL (already
 * listed), but a corrigendum typed CORRIGENDUM alone would otherwise leak.
 * JUDG_EXTRACT/ORDER_EXTRACT are deliberately NOT here: an OJ extract can be the sole
 * published record of an older case, so excluding it would cost recall.
 */
export const DERIVATIVE_RESOURCE_TYPES = [
  'http://publications.europa.eu/resource/authority/resource-type/INFO_JUDICIAL',
  'http://publications.europa.eu/resource/authority/resource-type/INFO_JUR',
  'http://publications.europa.eu/resource/authority/resource-type/ABSTRACT_JUR',
  'http://publications.europa.eu/resource/authority/resource-type/SUM_JUR',
  'http://publications.europa.eu/resource/authority/resource-type/CORRIGENDUM',
] as const;

/** Resolve a CDM resource-type URI to a human-readable label. Falls back to last path segment. */
export function resolveResourceTypeLabel(uri: string): string {
  return RESOURCE_TYPE_LABELS.get(uri) ?? uri.split('/').pop() ?? uri;
}

/**
 * Resolve a whitespace-separated list of CDM resource-type URIs into a single
 * human-readable label string. Search queries collapse each work's resource-types
 * into one row via `GROUP_CONCAT(DISTINCT STR(?type))`, so a work carrying several
 * types (e.g. a corrigendum classified as both CORRIGENDUM and a base type) arrives
 * as space-separated URIs. Each URI is resolved, de-duplicated, sorted for stable
 * output, and joined with ", ". Returns undefined when no type URI is present.
 */
export function resolveResourceTypeLabels(concatenated: string | undefined): string | undefined {
  if (!concatenated) return;
  const labels = [
    ...new Set(concatenated.split(/\s+/).filter(Boolean).map(resolveResourceTypeLabel)),
  ].sort();
  return labels.length > 0 ? labels.join(', ') : undefined;
}

/**
 * Structured decomposition of a CELLAR case-law expression title. Every field but
 * `complete` is optional — a real title may carry fewer segments, empty segments,
 * or no `#` delimiter at all, and no field is ever fabricated from missing data.
 */
export interface ParsedCaseTitle {
  /** Advocate General named by an opinion's leading segment, e.g. "Jääskinen". */
  advocateGeneral?: string;
  /** Case reference, e.g. "Case C-97/23 P." or "Joined Cases C-443/14 and C-444/14.". */
  caseReference?: string;
  /**
   * True when the fields hold everything the raw title carries: every non-empty
   * segment was assigned to a field (the leading court/AG descriptor counts as
   * assigned when it parses and marks no publication by extracts), and the
   * descriptor's date equals the record's date. A caller may drop the raw title
   * only when this is true.
   */
  complete: boolean;
  /** Clean human-readable title for display: the parties, or the court/AG descriptor when there are none. */
  displayTitle?: string;
  /**
   * The formation named in the leading segment, verbatim: the parenthetical after
   * the court ("Grand Chamber", "Fourth Chamber, Extended Composition"), or the
   * issuing office of an order so titled ("President", "Vice-President",
   * "President of the Second Chamber"). Never "(Extracts)", never inferred.
   */
  formation?: string;
  /** The parties segment, e.g. "Google Spain SL v AEPD". */
  parties?: string;
  /** National court that referred a preliminary ruling, e.g. "Audiencia Nacional" or "Tariefcommissie - Netherlands". */
  referringCourt?: string;
  /** Subject-matter keyword summary — the en-dash-delimited keyword list. */
  subjectMatter?: string;
}

const MONTH_NUMBERS: ReadonlyMap<string, string> = new Map(
  [
    'january',
    'february',
    'march',
    'april',
    'may',
    'june',
    'july',
    'august',
    'september',
    'october',
    'november',
    'december',
  ].map((month, i) => [month, String(i + 1).padStart(2, '0')]),
);

/** `{day} {Month} {year}` as three groups, the date form every leading segment uses. */
const TITLE_DATE = String.raw`(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})`;
const TITLE_COURT =
  '(?:Court of First Instance|General Court|Court(?: of Justice)?|(?:European Union )?Civil Service Tribunal)';

/**
 * Leading segment of a judgment or order: the court, an optional formation
 * parenthetical, the date (after "of" or a comma, or neither in the upper-case
 * Civil Service Tribunal form), and an optional trailing extracts marker, captured
 * last ("(Extracts)", 62014TJ0353).
 */
const JUDGMENT_OR_ORDER_DESCRIPTOR = new RegExp(
  String.raw`^(?:Judgment|Order)\s+of\s+the\s+${TITLE_COURT}(?:\s*\(([^)]+)\))?,?\s+(?:of\s+)?${TITLE_DATE}(\s*\((?:Extracts?|publication by extracts)\))?\.?$`,
  'i',
);

/** Leading segment of an order issued by a court's President, Vice-President, or a chamber President. */
const PRESIDENT_ORDER_DESCRIPTOR = new RegExp(
  String.raw`^Order\s+of\s+the\s+((?:Vice-)?President(?:\s+of\s+the\s+\w+\s+Chamber)?)\s+of\s+the\s+${TITLE_COURT},?\s+(?:of\s+)?${TITLE_DATE}\.?$`,
  'i',
);

/** Leading segment of an AG opinion: "[Joined] Opinion of [Mr] [First] Advocate General X delivered on DATE." */
const AG_OPINION_DESCRIPTOR = new RegExp(
  String.raw`^(?:Joined\s+)?Opinion\s+of\s+(?:(?:Mr|Mrs|Ms)\s+)?(?:First\s+)?Advocate\s+General\s+(.+?)\s+delivered\s+on\s+${TITLE_DATE}\.?$`,
  'i',
);

/**
 * Referral segment of a preliminary ruling: "Request(s)/Reference(s) for a
 * preliminary ruling from [the] X." or the older "…: X - Country.". The first word
 * is any word, since CELLAR carries typos of it ("Reqeust"). The dash form
 * ("Reference for a preliminary ruling – VAT – …") is a keyword list, not a
 * referral, and does not match.
 */
const REFERRAL_SEGMENT = /^\p{L}+ for a preliminary ruling(?: from (?:the )?|\s*:\s*)(.+?)\.?$/iu;

/** Trailing case-reference segment: "Case …", "Cases …", or "Joined Case(s) …", in either capitalization. */
const CASE_REFERENCE_SEGMENT = /^(?:Joined\s+)?Cases?\b/i;

/** ISO `YYYY-MM-DD` from a matched day, English month name, and year; undefined for an unknown month. */
function titleDateIso(day = '', month = '', year = ''): string | undefined {
  const monthNumber = MONTH_NUMBERS.get(month.toLowerCase());
  return monthNumber ? `${year}-${monthNumber}-${day.padStart(2, '0')}` : undefined;
}

/** What a leading court/AG descriptor of a known shape carries. */
interface TitleDescriptor {
  advocateGeneral?: string | undefined;
  /** ISO date; undefined when the month name is not an English one. */
  date: string | undefined;
  /**
   * True when the descriptor marks the text as published by extracts, which no
   * field carries: the trailing "(Extracts)", or an extracts parenthetical where
   * the formation sits.
   */
  extracts?: boolean;
  formation?: string;
}

/** What the leading court/AG descriptor carries, or undefined when it has none of the known shapes. */
function parseDescriptor(segment: string): TitleDescriptor | undefined {
  const judgmentOrOrder = JUDGMENT_OR_ORDER_DESCRIPTOR.exec(segment);
  if (judgmentOrOrder) {
    const [, formation, day, month, year, trailingExtracts] = judgmentOrOrder;
    const extractsFormation = formation !== undefined && /extract/i.test(formation);
    return {
      date: titleDateIso(day, month, year),
      extracts: trailingExtracts !== undefined || extractsFormation,
      ...(formation && !extractsFormation ? { formation } : {}),
    };
  }
  const presidentOrder = PRESIDENT_ORDER_DESCRIPTOR.exec(segment);
  if (presidentOrder) {
    const [, office = '', day, month, year] = presidentOrder;
    return {
      date: titleDateIso(day, month, year),
      formation: office.charAt(0).toUpperCase() + office.slice(1),
    };
  }
  const opinion = AG_OPINION_DESCRIPTOR.exec(segment);
  if (opinion) {
    const [, advocateGeneral, day, month, year] = opinion;
    return { advocateGeneral, date: titleDateIso(day, month, year) };
  }
  return;
}

/**
 * Parse a CELLAR case-law expression title into structured fields. This is the one
 * parser every tool that reads a case-law title shares, so each field and the
 * `complete` verdict mean the same thing wherever a title is decomposed.
 *
 * Case-law titles pack several segments into one `#`-delimited string, roughly
 *   `{court + formation + date}#{parties}#[referral]#{subject-matter keywords}#{case reference}`
 * e.g. `Judgment of the Court (Grand Chamber) of 10 February 2026.#WhatsApp
 * Ireland Ltd v European Data Protection Board.#Appeal – … .#Case C-97/23 P.`
 *
 * The segment count is not fixed: preliminary-ruling titles insert a referral
 * segment naming the national court before the subject matter, and AG opinions
 * leave the parties/subject/reference segments empty (`Opinion of Advocate General
 * … .###`). Rather than assume a fixed layout, this anchors on the reliable
 * positions:
 * - the leading segment is the court/AG descriptor, read for the formation, the
 *   Advocate General, and the date — a pre-chamber "Judgment of the Court of DATE."
 *   names no formation, and none is inferred. A descriptor marking publication by
 *   extracts ("… of 15 September 2016 (Extracts).") is read the same way but left
 *   unassigned, since no field says the text is an extract;
 * - the parties are the second segment, unless that segment is the referral, as it
 *   is in a title that names no parties;
 * - the case reference is the trailing "Case …", "Cases …", or "Joined Cases …"
 *   segment past the second;
 * - the referring court is the first referral segment between the descriptor and
 *   the case reference;
 * - the subject matter is the segment immediately before the case reference (or
 *   the trailing segment when there is none) that is not the referral.
 * Absent or empty segments are left unset, never invented.
 *
 * `date` is the record's own date (`YYYY-MM-DD`, any time or zone suffix ignored).
 * The parse is `complete` only when every non-empty segment was assigned and the
 * descriptor's date equals it — so a caller that drops the raw title on a complete
 * parse loses nothing the fields and the record's date do not already carry. A
 * title with no `#` (a plain title, or an older sparse record) yields only
 * `complete: false`, so the caller keeps the raw title untouched.
 */
export function parseCaseLawTitle(raw: string | undefined, date?: string): ParsedCaseTitle {
  if (!raw?.includes('#')) return { complete: false };
  const segments = raw.split('#').map((s) => s.trim());
  const assigned = new Set<number>();
  const result: ParsedCaseTitle = { complete: false };

  const descriptor = parseDescriptor(segments[0] ?? '');
  if (descriptor) {
    if (!descriptor.extracts) assigned.add(0);
    if (descriptor.formation) result.formation = descriptor.formation;
    if (descriptor.advocateGeneral) result.advocateGeneral = descriptor.advocateGeneral;
  }

  // Parties: the second segment — the reliable display-name position — unless it is
  // the referral, as in a title that names no parties (62023CJ0002).
  const parties = segments[1];
  if (parties && !REFERRAL_SEGMENT.test(parties)) {
    result.parties = parties;
    assigned.add(1);
  }

  // Case reference: the trailing non-empty segment, only when it has the case
  // shape and sits past the second segment (index ≥ 2). The optional "s" matches the plural
  // joined-case form (issue #42), and the optional "Joined" its long form.
  const lastIdx = segments.findLastIndex((s) => s !== '');
  let end = lastIdx;
  const last = segments[lastIdx];
  if (lastIdx >= 2 && last && CASE_REFERENCE_SEGMENT.test(last)) {
    result.caseReference = last;
    assigned.add(lastIdx);
    end = lastIdx - 1;
  }

  for (let i = result.parties ? 2 : 1; i <= end; i++) {
    const court = REFERRAL_SEGMENT.exec(segments[i] ?? '')?.[1];
    if (court) {
      result.referringCourt = court;
      assigned.add(i);
      break;
    }
  }

  // Subject matter: the keyword list right before the case reference, unless that
  // segment is the referral itself.
  const subject = segments[end];
  if (end >= 2 && subject && !assigned.has(end)) {
    result.subjectMatter = subject;
    assigned.add(end);
  }

  // Display title: the parties for contested cases, else the leading court/AG descriptor.
  const displayTitle = result.parties ?? segments[0];
  if (displayTitle) result.displayTitle = displayTitle;

  const everySegmentAssigned = segments.every((s, i) => s === '' || assigned.has(i));
  result.complete =
    everySegmentAssigned &&
    descriptor?.date !== undefined &&
    descriptor.date === date?.slice(0, 10);
  return result;
}
