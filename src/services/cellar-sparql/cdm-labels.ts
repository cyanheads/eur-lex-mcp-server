/**
 * @fileoverview CDM authority-register URI → human-readable label maps and resolvers,
 * plus a parser for CELLAR's `#`-delimited case-law expression titles.
 * Covers resource types (legislation, case law) and corporate bodies (EU institutions).
 * Used by tool handlers that normalise raw CDM URIs and titles before returning results.
 * @module services/cellar-sparql/cdm-labels
 */

/** English language URI used in expression-level title queries. */
export const ENG_LANGUAGE_URI = 'http://publications.europa.eu/resource/authority/language/ENG';

/**
 * CDM resource-type URI → human-readable short label.
 * Covers common legislation types, case law types, and preparatory acts.
 * Falls back to the last URI path segment when not in the map.
 */
export const RESOURCE_TYPE_LABELS: Record<string, string> = {
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
  return RESOURCE_TYPE_LABELS[uri] ?? uri.split('/').pop() ?? uri;
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
 * Structured decomposition of a CELLAR case-law expression title. Every field is
 * optional — a real title may carry fewer segments, empty segments, or no `#`
 * delimiter at all, and no segment is ever fabricated from missing data.
 */
export interface ParsedCaseTitle {
  /** Case reference, e.g. "Case C-97/23 P.". */
  caseReference?: string;
  /** Clean human-readable title for display: the parties, or the court/AG descriptor when there are none. */
  displayTitle?: string;
  /** The parties segment, e.g. "Google Spain SL v AEPD". */
  parties?: string;
  /** Subject-matter keyword summary — the en-dash-delimited keyword list. */
  subjectMatter?: string;
}

/**
 * Parse a CELLAR case-law expression title into structured fields.
 *
 * Case-law titles pack several segments into one `#`-delimited string, roughly
 *   `{court + date}#{parties}#[request for a ruling]#{subject-matter keywords}#{case reference}`
 * e.g. `Judgment of the Court (Grand Chamber) of 10 February 2026.#WhatsApp
 * Ireland Ltd v European Data Protection Board.#Appeal – … .#Case C-97/23 P.`
 *
 * The segment count is not fixed: preliminary-ruling judgments insert a "Request
 * for a preliminary ruling from …" provenance segment before the subject matter,
 * and AG opinions leave the parties/subject/reference segments empty (`Opinion of
 * Advocate General … .###`). Rather than assume a fixed layout, this anchors on
 * the reliable positions — the parties are the second segment, the case reference
 * is the trailing `Case …` segment, and the subject matter is the segment
 * immediately before it. Absent or empty segments are left unset, never invented.
 * A title with no `#` (already a plain title, or an older sparse record) yields an
 * empty object so the caller keeps the raw title untouched.
 */
export function parseCaseLawTitle(raw: string | undefined): ParsedCaseTitle {
  if (!raw?.includes('#')) return {};
  const segments = raw.split('#').map((s) => s.trim());
  const result: ParsedCaseTitle = {};

  // Parties: the second segment — the reliable display-name position.
  const parties = segments[1];
  if (parties) result.parties = parties;

  // Locate the trailing non-empty segment; it anchors the case reference.
  const lastIdx = segments.findLastIndex((s) => s !== '');

  // Case reference: the trailing segment, only when it has the "Case …"/"Cases …"
  // shape and sits past the parties (index ≥ 2). The optional trailing "s" matches
  // CELLAR's plural joined-case form ("Cases T-318/24 and T-362/24.") — `\b` never
  // asserts between "Case" and "s", so a singular-only anchor missed it (issue #42).
  // AG-opinion titles whose trailing segments are all empty leave this unset.
  const last = lastIdx >= 2 ? segments[lastIdx] : undefined;
  const hasCaseReference = last !== undefined && /^Cases?\b/i.test(last);
  if (hasCaseReference && last) result.caseReference = last;

  // Subject matter: the keyword list — the segment right before the case reference,
  // or, absent a case reference, the trailing segment when it sits past the parties.
  const subjectIdx = hasCaseReference ? lastIdx - 1 : lastIdx;
  if (subjectIdx >= 2) {
    const subject = segments[subjectIdx];
    if (subject) result.subjectMatter = subject;
  }

  // Display title: the parties for contested cases, else the leading court/AG descriptor.
  const displayTitle = result.parties ?? segments[0];
  if (displayTitle) result.displayTitle = displayTitle;

  return result;
}

/**
 * CDM corporate-body URI → human-readable institution name.
 * Falls back to the last URI path segment when not in the map.
 */
export const CORPORATE_BODY_LABELS: Record<string, string> = {
  'http://publications.europa.eu/resource/authority/corporate-body/EP': 'European Parliament',
  'http://publications.europa.eu/resource/authority/corporate-body/CONSIL': 'Council of the EU',
  'http://publications.europa.eu/resource/authority/corporate-body/COM': 'European Commission',
  'http://publications.europa.eu/resource/authority/corporate-body/CURIA':
    'Court of Justice of the EU',
  // The courts that author sector-6 (case-law) works, from a CELLAR survey of their
  // cdm:work_created_by_agent values; each label is the corporate-body authority
  // register's English skos:prefLabel.
  'http://publications.europa.eu/resource/authority/corporate-body/CJ': 'Court of Justice',
  'http://publications.europa.eu/resource/authority/corporate-body/GCEU': 'General Court',
  'http://publications.europa.eu/resource/authority/corporate-body/CST': 'Civil Service Tribunal',
  'http://publications.europa.eu/resource/authority/corporate-body/CFI': 'Court of First Instance',
  'http://publications.europa.eu/resource/authority/corporate-body/ECB': 'European Central Bank',
  'http://publications.europa.eu/resource/authority/corporate-body/EIB': 'European Investment Bank',
  'http://publications.europa.eu/resource/authority/corporate-body/ECA':
    'European Court of Auditors',
  'http://publications.europa.eu/resource/authority/corporate-body/ESC':
    'European Economic and Social Committee',
  'http://publications.europa.eu/resource/authority/corporate-body/COR': 'Committee of the Regions',
  'http://publications.europa.eu/resource/authority/corporate-body/EURATOM': 'Euratom',
  'http://publications.europa.eu/resource/authority/corporate-body/SRB': 'Single Resolution Board',
  'http://publications.europa.eu/resource/authority/corporate-body/ESMA':
    'European Securities and Markets Authority',
  'http://publications.europa.eu/resource/authority/corporate-body/EBA':
    'European Banking Authority',
  'http://publications.europa.eu/resource/authority/corporate-body/EIOPA':
    'European Insurance and Occupational Pensions Authority',
  'http://publications.europa.eu/resource/authority/corporate-body/ECDC':
    'European Centre for Disease Prevention and Control',
  'http://publications.europa.eu/resource/authority/corporate-body/EEA':
    'European Environment Agency',
  'http://publications.europa.eu/resource/authority/corporate-body/EASA':
    'European Union Aviation Safety Agency',
  'http://publications.europa.eu/resource/authority/corporate-body/EFSA':
    'European Food Safety Authority',
  'http://publications.europa.eu/resource/authority/corporate-body/EMA':
    'European Medicines Agency',
  'http://publications.europa.eu/resource/authority/corporate-body/EMEA':
    'European Medicines Agency',
  'http://publications.europa.eu/resource/authority/corporate-body/FRONTEX': 'Frontex',
  'http://publications.europa.eu/resource/authority/corporate-body/EUIPO':
    'European Union Intellectual Property Office',
  'http://publications.europa.eu/resource/authority/corporate-body/ETF':
    'European Training Foundation',
  'http://publications.europa.eu/resource/authority/corporate-body/EASO':
    'European Asylum Support Office',
  'http://publications.europa.eu/resource/authority/corporate-body/ESTAT': 'Eurostat',
  'http://publications.europa.eu/resource/authority/corporate-body/JUST': 'DG Justice',
  'http://publications.europa.eu/resource/authority/corporate-body/GROW': 'DG Internal Market',
  'http://publications.europa.eu/resource/authority/corporate-body/SANTE':
    'DG Health and Food Safety',
  'http://publications.europa.eu/resource/authority/corporate-body/COMP': 'DG Competition',
  'http://publications.europa.eu/resource/authority/corporate-body/FISMA': 'DG Financial Stability',
  'http://publications.europa.eu/resource/authority/corporate-body/TRADE': 'DG Trade',
};

/** Resolve a CDM corporate-body URI to a human-readable institution name. Falls back to last path segment. */
export function resolveCorporateBodyLabel(uri: string): string {
  return CORPORATE_BODY_LABELS[uri] ?? uri.split('/').pop() ?? uri;
}
