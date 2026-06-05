/**
 * @fileoverview Shared domain types for the CELLAR SPARQL service and EUR-Lex content service.
 * @module services/cellar-sparql/types
 */

/** A single binding row from a SPARQL SELECT result. */
export type SparqlBinding = Record<string, { type: string; value: string; datatype?: string }>;

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
