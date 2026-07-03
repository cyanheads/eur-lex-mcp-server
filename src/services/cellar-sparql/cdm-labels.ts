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
  'http://publications.europa.eu/resource/authority/resource-type/DIR': 'Directive',
  'http://publications.europa.eu/resource/authority/resource-type/DEC': 'Decision',
  'http://publications.europa.eu/resource/authority/resource-type/TREATY': 'Treaty',
  'http://publications.europa.eu/resource/authority/resource-type/JUDG': 'Judgment',
  'http://publications.europa.eu/resource/authority/resource-type/ORDER': 'Order',
  'http://publications.europa.eu/resource/authority/resource-type/OPIN_AG': 'AG Opinion',
  'http://publications.europa.eu/resource/authority/resource-type/AG_OPI': 'AG Opinion',
  'http://publications.europa.eu/resource/authority/resource-type/VIEW_AG': 'AG View',
  'http://publications.europa.eu/resource/authority/resource-type/RULING': 'Ruling',
  'http://publications.europa.eu/resource/authority/resource-type/PROP_DIR': 'Proposal',
  'http://publications.europa.eu/resource/authority/resource-type/REC_SOFT': 'Recommendation',
  'http://publications.europa.eu/resource/authority/resource-type/RES': 'Resolution',
  'http://publications.europa.eu/resource/authority/resource-type/AGREE_INTERNATION':
    'International Agreement',
  'http://publications.europa.eu/resource/authority/resource-type/IMPL_REG':
    'Implementing Regulation',
  'http://publications.europa.eu/resource/authority/resource-type/DEL_REG': 'Delegated Regulation',
};

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
