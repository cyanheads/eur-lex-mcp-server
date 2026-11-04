/**
 * @fileoverview The facts CELLAR records on a case-law work — judgment, order, or AG
 * opinion: the countries it originates in, its procedure types with their outcomes,
 * its subject matter, and its procedure languages. Read for resolved works, since a
 * CELEX's `do_not_index` copy carries none of them. Shared by eurlex_get_cases (each
 * row) and eurlex_get_document (a case-law work) so both read them identically.
 * @module services/cellar-sparql/case-law-facts
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { LANGUAGE_TO_ISO_639_2 } from '@/services/eurlex-content/eurlex-content-service.js';
import { isProvisionalData } from './cdm-labels.js';
import { CellarSparqlService } from './cellar-sparql-service.js';

/** The case-law facts of one work: each a sorted list, absent when CELLAR records none. */
export interface CaseLawFacts {
  /** ISO 3166-1 alpha-3 codes from `cdm:case-law_originates_in_country`. */
  countries?: string[];
  /** EUR-Lex two-letter language codes from `cdm:case-law_uses_procedure_language`. */
  procedure_languages?: string[];
  /** English `fd_100` labels, outcome included, from `cdm:case-law_has_type_procedure_concept_type_procedure`. */
  procedure_types?: string[];
  /** English case-law subject-matter labels from `cdm:case-law_is-about_case-law-subject-matter`. */
  subjects?: string[];
}

type CaseLawFact = keyof CaseLawFacts;

/** The {@link CaseLawFacts} keys, each bound as `?fact` by its arm of the query. */
const FACTS: readonly string[] = [
  'countries',
  'procedure_types',
  'subjects',
  'procedure_languages',
] satisfies CaseLawFact[];

function isCaseLawFact(value: string): value is CaseLawFact {
  return FACTS.includes(value);
}

/** CELLAR's language authority code (`BUL`) → the EUR-Lex code (`BG`). */
const EURLEX_LANGUAGE_BY_AUTHORITY_CODE: ReadonlyMap<string, string> = new Map(
  Object.entries(LANGUAGE_TO_ISO_639_2).map(([eurlex, iso]) => [iso.toUpperCase(), eurlex]),
);

/** The last path segment of an authority URI: its code as CELLAR stores it (`ANNU%3DOB`). */
function authorityCode(uri: string): string {
  return uri.slice(uri.lastIndexOf('/') + 1);
}

/**
 * The value a fact row reports: a country's alpha-3 code, a procedure's or subject's
 * English label, a language's EUR-Lex code. A procedure or subject with no English
 * label, or a language with no EUR-Lex code, reports its authority code, as
 * resource types fall back to theirs, so no recorded value is dropped.
 */
function factValue(fact: CaseLawFact, code: string, label: string | undefined): string {
  switch (fact) {
    case 'countries':
      return authorityCode(code);
    case 'procedure_types':
    case 'subjects':
      return label ?? authorityCode(code);
    case 'procedure_languages': {
      const authority = authorityCode(code);
      return EURLEX_LANGUAGE_BY_AUTHORITY_CODE.get(authority) ?? authority;
    }
    default: {
      const unhandled: never = fact;
      return unhandled;
    }
  }
}

/**
 * Read the case-law facts of `workUris` in one query: one row per work, fact, and
 * value, as a `UNION` arm per fact, each value's English label joined inline. The
 * query is ungrouped, so a work's values never multiply across facts, and has no
 * `LIMIT`, since the `VALUES` list bounds it. Pass resolved works: a `do_not_index`
 * copy carries none of these facts.
 *
 * A work CELLAR records none of the facts for is absent from the map, and a fact it
 * records no value for is absent from the work's entry, never an empty list. The
 * "Provisional data" placeholder is never reported. An empty list sends no query.
 */
export async function fetchCaseLawFacts(
  svc: Pick<CellarSparqlService, 'query'>,
  workUris: readonly string[],
  ctx: Context,
): Promise<Map<string, CaseLawFacts>> {
  const distinct = [...new Set(workUris)];
  if (distinct.length === 0) return new Map();

  const query = `
SELECT ?work ?fact ?code ?label WHERE {
  VALUES ?work { ${distinct.map((uri) => `<${uri}>`).join(' ')} }
  {
    ?work cdm:case-law_originates_in_country ?code .
    BIND("countries" AS ?fact)
  } UNION {
    ?work cdm:case-law_has_type_procedure_concept_type_procedure ?code .
    BIND("procedure_types" AS ?fact)
    OPTIONAL { ?code skos:prefLabel ?label . FILTER(LANG(?label) = "en") }
  } UNION {
    ?work cdm:case-law_is-about_case-law-subject-matter ?code .
    BIND("subjects" AS ?fact)
    OPTIONAL { ?code skos:prefLabel ?label . FILTER(LANG(?label) = "en") }
  } UNION {
    ?work cdm:case-law_uses_procedure_language ?code .
    BIND("procedure_languages" AS ?fact)
  }
}`;

  const values = new Map<string, Map<CaseLawFact, Set<string>>>();
  for (const b of await svc.query(query, ctx)) {
    const work = CellarSparqlService.bindingValue(b, 'work');
    const fact = CellarSparqlService.bindingValue(b, 'fact');
    const code = CellarSparqlService.bindingValue(b, 'code');
    if (!work || !fact || !isCaseLawFact(fact) || !code || isProvisionalData(code)) continue;
    const byFact = values.get(work) ?? new Map<CaseLawFact, Set<string>>();
    values.set(work, byFact);
    const set = byFact.get(fact) ?? new Set<string>();
    byFact.set(fact, set);
    set.add(factValue(fact, code, CellarSparqlService.bindingValue(b, 'label')));
  }

  const facts = new Map<string, CaseLawFacts>();
  for (const [work, byFact] of values) {
    const entry: CaseLawFacts = {};
    for (const [fact, set] of byFact) entry[fact] = [...set].sort();
    facts.set(work, entry);
  }
  return facts;
}
