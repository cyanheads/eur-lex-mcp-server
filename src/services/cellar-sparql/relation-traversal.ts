/**
 * @fileoverview Shared CELLAR CDM relation traversal, used by the
 * eurlex_get_relations tool and the eurlex://document/{celex}/relations
 * resource. Owns the relation-type → CDM predicate + direction model so both
 * surfaces resolve relations identically.
 * @module services/cellar-sparql/relation-traversal
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { CellarSparqlService } from './cellar-sparql-service.js';
import type { WorkRelation } from './types.js';

/** The relation types this server exposes over the CDM graph. */
export const RELATION_TYPES = [
  'cites',
  'amends',
  'amended_by',
  'legal_basis',
  'consolidated_version',
] as const;

export type RelationType = (typeof RELATION_TYPES)[number];

type Direction = 'outgoing' | 'incoming' | 'both';

/**
 * Per-relation-type CDM traversal spec: the predicate to follow and the
 * direction(s) relative to the source work.
 *
 * CELLAR models amendment and consolidation one-directionally, so two types are
 * the INCOMING side of a predicate whose name reads the other way — the
 * dedicated `…amended_by…` and `…has_consolidated_version…` predicates carry
 * zero triples:
 *  - `amended_by` is the incoming side of `…amends…` (`?amender amends <work>`).
 *  - `consolidated_version` is the incoming side of
 *    `…act_consolidated_consolidates…` (the consolidated act points back to the
 *    base; there is no forward `…has_consolidated_version…` link).
 *
 * `amends` and `legal_basis` are outgoing-only — their incoming rows describe a
 * different relation (what amends this / what is based on this) and belong under
 * `amended_by` and another work's `legal_basis`, not here. `cites` is symmetric
 * ("citation graph"), so both directions are surfaced and tagged via `?direction`.
 */
const RELATION_SPECS: Record<RelationType, { predicate: string; direction: Direction }> = {
  cites: { predicate: 'cdm:work_cites_work', direction: 'both' },
  amends: { predicate: 'cdm:resource_legal_amends_resource_legal', direction: 'outgoing' },
  amended_by: { predicate: 'cdm:resource_legal_amends_resource_legal', direction: 'incoming' },
  legal_basis: { predicate: 'cdm:resource_legal_based_on_resource_legal', direction: 'outgoing' },
  consolidated_version: {
    predicate: 'cdm:act_consolidated_consolidates_resource_legal',
    direction: 'incoming',
  },
};

/**
 * Default per-type result cap. Each relation type is queried independently with
 * its own LIMIT so a high-volume type (e.g. `cites`) can't starve rarer types
 * under a single shared cap. The service caps further if MAX_SPARQL_RESULTS is
 * lower than this.
 */
export const DEFAULT_PER_TYPE_LIMIT = 100;

/** Build a single-relation-type SPARQL query for the given predicate + direction. */
function buildRelationQuery(
  workUri: string,
  spec: { predicate: string; direction: Direction },
  limit: number,
): string {
  const outgoing = `{
    <${workUri}> ${spec.predicate} ?relatedWork .
    OPTIONAL { ?relatedWork cdm:resource_legal_id_celex ?relatedCelex . }
    BIND("outgoing" AS ?direction)
  }`;
  const incoming = `{
    ?relatedWork ${spec.predicate} <${workUri}> .
    OPTIONAL { ?relatedWork cdm:resource_legal_id_celex ?relatedCelex . }
    BIND("incoming" AS ?direction)
  }`;
  const body =
    spec.direction === 'outgoing'
      ? outgoing
      : spec.direction === 'incoming'
        ? incoming
        : `${outgoing} UNION ${incoming}`;
  return `SELECT ?relatedWork ?relatedCelex ?direction WHERE {
${body}
} LIMIT ${limit}`;
}

/**
 * Traverse the requested CDM relation types for a work — one query per type, run
 * concurrently — and return de-duplicated relations tagged with their type and
 * direction. Each type is resolved through its own query (and its own LIMIT) so
 * the per-type caps are independent.
 */
export async function traverseRelations(
  svc: Pick<CellarSparqlService, 'query'>,
  workUri: string,
  types: readonly RelationType[],
  ctx: Context,
  perTypeLimit: number = DEFAULT_PER_TYPE_LIMIT,
): Promise<WorkRelation[]> {
  const perType = await Promise.all(
    types.map(async (type) => ({
      type,
      bindings: await svc.query(
        buildRelationQuery(workUri, RELATION_SPECS[type], perTypeLimit),
        ctx,
      ),
    })),
  );

  const seen = new Set<string>();
  const relations: WorkRelation[] = [];
  for (const { type, bindings } of perType) {
    for (const b of bindings) {
      const relatedWorkUri = CellarSparqlService.bindingValue(b, 'relatedWork') ?? '';
      const direction =
        CellarSparqlService.bindingValue(b, 'direction') === 'incoming' ? 'incoming' : 'outgoing';
      const key = `${type}|${direction}|${relatedWorkUri}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const relation: WorkRelation = { relationType: type, direction, relatedWorkUri };
      const relatedCelex = CellarSparqlService.bindingValue(b, 'relatedCelex');
      if (relatedCelex) relation.relatedCelexNumber = relatedCelex;
      relations.push(relation);
    }
  }
  return relations;
}
