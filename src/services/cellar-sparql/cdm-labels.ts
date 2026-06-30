/**
 * @fileoverview CDM authority-register URI → human-readable label maps and resolvers.
 * Covers resource types (legislation, case law) and corporate bodies (EU institutions).
 * Used by tool handlers that normalise raw CDM URIs into labels before returning results.
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
