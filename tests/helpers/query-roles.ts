/**
 * @fileoverview The role of each CELLAR query a metadata read sends, so a test names
 * which queries ran rather than counting them: a count holds when one query is
 * swapped for another, a list of roles does not.
 * @module tests/helpers/query-roles
 */

import { isConsolidationLookup, isProcedureLookup } from '../fixtures/cellar-consolidations.js';
import { isCaseLawFactsQuery, isResolutionQuery } from '../fixtures/cellar-works.js';

/** Each role and the test for it, the more specific first. */
const MATCHERS: [role: string, matches: (sparql: string) => boolean][] = [
  ['resolution', isResolutionQuery],
  ['consolidation', isConsolidationLookup],
  ['procedures', isProcedureLookup],
  ['case_law_facts', isCaseLawFactsQuery],
  ['citation', (q) => q.includes('AS ?datesOfEffect)')],
  ['core', (q) => q.includes('cdm:work_has_resource-type')],
  ['agents', (q) => q.includes('cdm:work_created_by_agent')],
  ['legal_basis', (q) => q.includes('cdm:resource_legal_based_on_resource_legal')],
  ['eurovoc', (q) => q.includes('cdm:work_is_about_concept_eurovoc')],
];

/** The role of every query in `queries`, sorted; a query with no role throws. */
export function queryRoles(queries: string[]): string[] {
  return queries
    .map((sparql) => {
      const role = MATCHERS.find(([, matches]) => matches(sparql))?.[0];
      if (!role) throw new Error(`No role for query: ${sparql.slice(0, 200)}`);
      return role;
    })
    .sort();
}

/** `names` sorted, to compare with {@link queryRoles}. */
export const roles = (...names: string[]): string[] => names.sort();
