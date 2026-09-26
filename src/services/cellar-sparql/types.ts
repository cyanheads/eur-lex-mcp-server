/**
 * @fileoverview Shared domain types for the CELLAR SPARQL service and EUR-Lex content service.
 * @module services/cellar-sparql/types
 */

/**
 * A single SPARQL term: an IRI, a blank node, or a literal. Virtuoso tags every
 * term with `type` and `value`, and adds `datatype` for a typed literal or
 * `xml:lang` for a language-tagged one — the two are mutually exclusive per the
 * SPARQL 1.1 JSON results format.
 */
export interface SparqlTerm {
  datatype?: string;
  type: string;
  value: string;
  'xml:lang'?: string;
}

/** A single binding row from a SPARQL SELECT result. */
export type SparqlBinding = Record<string, SparqlTerm>;

/** The full SPARQL results JSON envelope from Virtuoso. */
export interface SparqlResultsJson {
  head: { vars: string[] };
  results: { bindings: SparqlBinding[] };
}

/** A resolved CELLAR work record. */
export interface CellarWork {
  authorInstitution?: string;
  celexNumber: string;
  date?: string;
  eurovocConcepts?: string[];
  inForce?: boolean;
  resourceType?: string;
  title?: string;
  workUri: string;
}

/** A search result entry from CELLAR. */
export interface WorkSearchResult {
  celexNumber: string;
  date?: string;
  resourceType?: string;
  title?: string;
  workUri: string;
}

/** A CJEU/GC case law result entry. */
export interface CaseResult {
  celexNumber: string;
  court?: string;
  date?: string;
  resourceType?: string;
  title?: string;
  workUri: string;
}

/** A single CDM relation between works. */
export interface WorkRelation {
  direction: 'outgoing' | 'incoming';
  relatedCelexNumber?: string;
  /** The related work's document date (`YYYY-MM-DD`), the value its page is ordered by. Absent when it has none. */
  relatedDate?: string;
  /**
   * ISO 3166-1 alpha-3 member-state code of a national implementing measure, read
   * from its sector-7 CELEX. Set on `national_transposition` relations only.
   */
  relatedMemberState?: string;
  /** The related work's English expression title, whole. Absent when it has none in English. */
  relatedTitle?: string;
  relatedWorkUri: string;
  relationType: string;
}

/** An EuroVoc concept from the thesaurus. */
export interface EuroVocConcept {
  broaderLabel?: string;
  conceptCode?: string;
  conceptUri: string;
  prefLabel: string;
}
