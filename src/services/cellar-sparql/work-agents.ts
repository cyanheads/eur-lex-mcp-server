/**
 * @fileoverview Agents of a CELLAR work — the originating institutions and, for case
 * law, the Advocates General. Shared by eurlex_get_document and the
 * eurlex://document/{celexNumber} resource so both surfaces read authors identically.
 * @module services/cellar-sparql/work-agents
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { CellarSparqlService } from './cellar-sparql-service.js';

/** Namespace of CELLAR's own resources, as opposed to authority-register codes. */
const CELLAR_RESOURCE_NAMESPACE = 'http://publications.europa.eu/resource/cellar/';

/** Row cap for the agent query: a handful of creators plus at most nine AGs per work. */
const AGENT_LIMIT = 100;

/** Human-readable agents of one work. */
export interface WorkAgents {
  /** `cdm:agent_name` surnames from `cdm:case-law_delivered_by_advocate-general`, sorted. */
  advocatesGeneral: string[];
  /** Originating institutions, labelled and de-duplicated, in CELLAR's row order. */
  institutions: string[];
}

/**
 * Read the agents of `workUri` in one query: its `cdm:work_created_by_agent` values
 * and its `cdm:case-law_delivered_by_advocate-general` values, each tagged with its
 * role. The person name, the national-court name, and the authority label are read
 * through separate `OPTIONAL` variables; CELLAR leaves a variable shared by two
 * `OPTIONAL`s unbound in the second.
 *
 * A creator is labelled three ways. A `cdm:court_national` carries its name on
 * `cdm:court_national_name`. An authority code — a corporate body, a member state, an
 * MEP-register entry, or any other authority table — carries its English
 * `skos:prefLabel`, the same label the `author_institution` filter of
 * eurlex_search_documents matches, so a displayed author round-trips into that
 * filter; a code with no English label falls back to its last path segment. Any
 * other CELLAR resource is dropped: on CELLAR these are the `cdm:person` creators of
 * case law, and each is also that work's Advocate General, so it reaches the output
 * through `advocatesGeneral` instead of as a UUID.
 */
export async function fetchWorkAgents(
  svc: Pick<CellarSparqlService, 'query'>,
  workUri: string,
  ctx: Context,
): Promise<WorkAgents> {
  const query = `
SELECT ?agent ?role ?personName ?courtName ?agentLabel WHERE {
  { <${workUri}> cdm:work_created_by_agent ?agent . BIND("creator" AS ?role) }
  UNION
  { <${workUri}> cdm:case-law_delivered_by_advocate-general ?agent . BIND("advocate_general" AS ?role) }
  OPTIONAL { ?agent cdm:agent_name ?personName . }
  OPTIONAL { ?agent cdm:court_national_name ?courtName . }
  OPTIONAL { ?agent skos:prefLabel ?agentLabel . FILTER(LANG(?agentLabel) = "en") }
} LIMIT ${AGENT_LIMIT}`;

  const institutions = new Set<string>();
  const advocatesGeneral = new Set<string>();
  for (const b of await svc.query(query, ctx)) {
    const agent = CellarSparqlService.bindingValue(b, 'agent');
    if (!agent) continue;
    if (CellarSparqlService.bindingValue(b, 'role') === 'advocate_general') {
      const name = CellarSparqlService.bindingValue(b, 'personName');
      if (name) advocatesGeneral.add(name);
      continue;
    }
    const courtName = CellarSparqlService.bindingValue(b, 'courtName');
    if (courtName) institutions.add(courtName);
    else if (!agent.startsWith(CELLAR_RESOURCE_NAMESPACE)) {
      institutions.add(
        CellarSparqlService.bindingValue(b, 'agentLabel') ?? agent.split('/').pop() ?? agent,
      );
    }
  }
  return {
    institutions: [...institutions],
    advocatesGeneral: [...advocatesGeneral].sort((a, b) => a.localeCompare(b)),
  };
}
