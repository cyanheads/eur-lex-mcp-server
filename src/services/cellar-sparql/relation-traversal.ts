/**
 * @fileoverview Shared CELLAR CDM relation traversal, used by the
 * eurlex_get_relations tool and the eurlex://document/{celex}/relations
 * resource. Owns the relation-type → CDM predicate + direction model so both
 * surfaces resolve relations identically.
 * @module services/cellar-sparql/relation-traversal
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { CellarSparqlService } from './cellar-sparql-service.js';
import { escapeSparqlLiteral } from './eli-resolution.js';
import type { SparqlBinding, WorkRelation } from './types.js';

/** The relation types this server exposes over the CDM graph. */
export const RELATION_TYPES = [
  'cites',
  'amends',
  'amended_by',
  'repeals',
  'repealed_by',
  'implicitly_repeals',
  'implicitly_repealed_by',
  'legal_basis',
  'consolidated_version',
  'national_transposition',
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
 * Repeal carries triples in the natural direction on `…repeals…` and
 * `…implicitly_repeals…`, so each is exposed as a pair of distinct enum values —
 * `repeals`/`repealed_by` and `implicitly_repeals`/`implicitly_repealed_by` — the
 * outgoing and incoming sides of one predicate, the same inversion `amends`/
 * `amended_by` uses. That lets a caller ask either "what did this act repeal?" or
 * "what repealed it?", and keeps explicit and implicit repeal distinguishable.
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
  repeals: { predicate: 'cdm:resource_legal_repeals_resource_legal', direction: 'outgoing' },
  repealed_by: { predicate: 'cdm:resource_legal_repeals_resource_legal', direction: 'incoming' },
  implicitly_repeals: {
    predicate: 'cdm:resource_legal_implicitly_repeals_resource_legal',
    direction: 'outgoing',
  },
  implicitly_repealed_by: {
    predicate: 'cdm:resource_legal_implicitly_repeals_resource_legal',
    direction: 'incoming',
  },
  legal_basis: { predicate: 'cdm:resource_legal_based_on_resource_legal', direction: 'outgoing' },
  consolidated_version: {
    predicate: 'cdm:act_consolidated_consolidates_resource_legal',
    direction: 'incoming',
  },
  national_transposition: {
    predicate: 'cdm:measure_national_implementing_implements_resource_legal',
    direction: 'incoming',
  },
};

/**
 * Default per-direction result cap. Each relation type is queried independently
 * with its own LIMIT so a high-volume type (e.g. `cites`) can't starve rarer
 * types under a single shared cap; a symmetric type splits its cap per direction
 * too (see `buildRelationQuery`). The service caps further if MAX_SPARQL_RESULTS
 * is lower — callers clamp to it to keep both sides of a symmetric query capped
 * consistently.
 */
export const DEFAULT_PER_TYPE_LIMIT = 100;

/**
 * CELEX constraint pushed into a relation arm before LIMIT/OFFSET and continuation
 * proof. Consolidations require a sector-`0` same-act CELEX; national transposition
 * measures require a sector-`7` CELEX with the source directive's act core. Requiring
 * and filtering the related CELEX before grouping also makes one work with several
 * CELEX values occupy exactly one page row. Client-side checks remain as
 * belt-and-suspenders.
 */
interface CelexConstraint {
  /** Regular expression applied to the related work's required CELEX identifier. */
  pattern?: string;
}

/** One direction's graph pattern for a relation predicate, tagged with its direction. */
function relationArm(
  workUri: string,
  predicate: string,
  direction: 'outgoing' | 'incoming',
  celex?: CelexConstraint,
): string {
  const edge =
    direction === 'outgoing'
      ? `<${workUri}> ${predicate} ?relatedWork .`
      : `?relatedWork ${predicate} <${workUri}> .`;
  // A pushed constraint requires the related CELEX; other relation types keep it
  // OPTIONAL so CELEX-less related works still return.
  const celexTriple = celex
    ? `?relatedWork cdm:resource_legal_id_celex ?relatedCelex .`
    : `OPTIONAL { ?relatedWork cdm:resource_legal_id_celex ?relatedCelex . }`;
  const celexFilter = celex?.pattern
    ? `\n    FILTER(REGEX(STR(?relatedCelex), "${celex.pattern}"))`
    : '';
  // `?relatedDate` drives the per-direction ordering below; it stays OPTIONAL so
  // related works without a document date still return (they sort last under DESC).
  return `${edge}
    ${celexTriple}${celexFilter}
    OPTIONAL { ?relatedWork cdm:work_date_document ?relatedDate . }
    BIND("${direction}" AS ?direction)`;
}

/**
 * Build a single-relation-type SPARQL query, ordered by the related work's
 * document date DESC and paged (LIMIT + OFFSET).
 *
 * Ordering is the fix for the unordered-cap bug: an incoming edge on a
 * heavily-related act (e.g. works citing the GDPR) returns thousands of rows, so
 * an unordered LIMIT dropped the newest. `ORDER BY DESC(?relatedDate)` keeps the
 * most recent within the cap; `OFFSET` reaches the rest.
 *
 * A symmetric type (`cites`, direction `both`) is a UNION of two subqueries, each
 * ordered and capped independently, so a dense outgoing set can't consume the
 * incoming budget and vice versa. The per-direction LIMITs must each be ≤
 * MAX_SPARQL_RESULTS: this query carries no outer LIMIT, and the internal `query`
 * path passes its subselect LIMITs through unchanged (the service imposes an outer
 * bound only on the raw escape hatch), so an over-cap here would return an
 * over-budget arm — callers pass a limit already clamped to the service ceiling.
 *
 * The outer UNION carries its own `ORDER BY ?direction DESC(?relatedDateMax)`.
 * Without it the union order is implementation-defined, and the caller slices each
 * direction to `perTypeLimit` after grouping the rows by direction — so an
 * arbitrary interleaving can place the private continuation sentinel inside the
 * kept slice and drop a real relation instead.
 */
function buildRelationQuery(
  workUri: string,
  spec: { predicate: string; direction: Direction },
  limit: number,
  offset: number,
  celex?: CelexConstraint,
): string {
  const projection =
    'SELECT ?relatedWork (SAMPLE(?relatedCelex) AS ?relatedCelexSample) ?direction (MAX(?relatedDate) AS ?relatedDateMax)';
  const paging = `GROUP BY ?relatedWork ?direction ORDER BY DESC(?relatedDateMax) LIMIT ${limit} OFFSET ${offset}`;
  if (spec.direction !== 'both') {
    return `${projection} WHERE {
    ${relationArm(workUri, spec.predicate, spec.direction, celex)}
} ${paging}`;
  }
  const subquery = (direction: 'outgoing' | 'incoming') =>
    `{ ${projection} WHERE {
    ${relationArm(workUri, spec.predicate, direction, celex)}
  } ${paging} }`;
  return `SELECT ?relatedWork ?relatedCelexSample ?direction ?relatedDateMax WHERE {
  ${subquery('outgoing')} UNION ${subquery('incoming')}
} ORDER BY ?direction DESC(?relatedDateMax)`;
}

/**
 * Extract a CELEX's act-identifying core — the `{year}{type}{number}` that
 * follows the one-character sector — so a consolidated version (sector `0`) can
 * be matched to its base act (legislation is sector `3`). `32016R0679` and its
 * consolidation `02016R0679-20160504` both yield `2016R0679`; a consolidation of
 * a different act (`01995L0046-20180525`) yields `1995L0046`. Returns `undefined`
 * when the string doesn't parse as a CELEX.
 */
const CELEX_ACT_CORE_RE = /^[0-9A-Z](\d{4}[A-Z]{1,2}\d+)/;
function celexActCore(celex: string): string | undefined {
  return CELEX_ACT_CORE_RE.exec(celex)?.[1];
}

/**
 * A consolidated-version CELEX: sector `0`, the `{year}{type}{number}` act core
 * (group 1), and a `-YYYYMMDD` consolidation-date suffix (groups 2–4). Genuine
 * consolidations of an act carry this shape, e.g. `02014R0833-20260424`.
 */
const CONSOLIDATED_CELEX_RE = /^0(\d{4}[A-Z]{1,2}\d+)-(\d{4})(\d{2})(\d{2})$/;

/**
 * CELEX pattern for a national implementing measure that transposes the act
 * identified by `sourceActCore`: sector `7`, the source act core, then the
 * three-letter member-state code every sector-7 CELEX carries
 * (`72016L0680CZE_225030`, `72014L0056FIN_240353`).
 *
 * The country code is what anchors the act core on its right-hand side, and it
 * has to be there: a left-anchored `^7{core}` alone also matches a longer act
 * number that merely starts with the same digits, so measures transposing a
 * hypothetical `32016L06801` would be returned as transpositions of
 * `32016L0680`. That mirrors the two-ended discipline the `consolidated_version`
 * pattern already applies. The trailing measure number is deliberately left
 * unanchored — no digit can extend the act core across three letters, so
 * anchoring it would add false-rejection risk without closing anything.
 * Verified against 3,000 sector-7 CELEX values pulled live from CELLAR: all
 * carry the three-letter code.
 */
function nationalMeasureCelexPattern(sourceActCore: string): string {
  return `^7${sourceActCore}[A-Z]{3}`;
}

/** True when a CELEX is itself a consolidated version (…-YYYYMMDD), not a base act. */
export function isConsolidatedCelex(celex: string): boolean {
  return CONSOLIDATED_CELEX_RE.test(celex);
}

/** The newest consolidated version of a base act. */
export interface CurrentConsolidated {
  /** Consolidation date parsed from the CELEX suffix, ISO 8601 (`2026-04-24`). */
  asOf: string;
  /** CELEX of the consolidated work, e.g. `02014R0833-20260424`. */
  celex: string;
}

/**
 * Find the newest consolidated version of a base act, or `undefined` when the
 * act has no consolidation (or is itself a consolidated version). Mirrors the
 * `consolidated_version` relation — the incoming side of
 * `cdm:act_consolidated_consolidates_resource_legal`, CELEX-bearing, same act
 * core — so a base act (sector `3`) resolves to its sector-`0` consolidations.
 *
 * Self-contained: resolves the base work by CELEX inline (rather than taking a
 * work URI like `traverseRelations`), so the caller can run it concurrently with
 * the metadata/content fetch. `ORDER BY DESC(?consolidatedCelex)` puts the newest
 * same-act consolidation first — the date suffix sorts chronologically within an
 * act core — so the first row whose core matches is the current version, robust
 * to a truncating LIMIT. CELLAR also asserts the `consolidates` edge for
 * consolidations of *other* acts (a graph artifact), so the act-core match is
 * required, not incidental.
 */
export async function findCurrentConsolidated(
  svc: Pick<CellarSparqlService, 'query'>,
  celex: string,
  ctx: Context,
): Promise<CurrentConsolidated | undefined> {
  // A consolidated version has no newer consolidation to resolve to.
  if (isConsolidatedCelex(celex)) return;
  const baseCore = celexActCore(celex);
  if (!baseCore) return;

  const query = `
SELECT ?consolidatedCelex WHERE {
  ?work cdm:resource_legal_id_celex ?c .
  FILTER(STR(?c) = "${escapeSparqlLiteral(celex)}")
  ?consolidated cdm:act_consolidated_consolidates_resource_legal ?work .
  ?consolidated cdm:resource_legal_id_celex ?consolidatedCelex .
}
ORDER BY DESC(?consolidatedCelex)
LIMIT 100`;

  const bindings = await svc.query(query, ctx);
  for (const b of bindings) {
    const c = CellarSparqlService.bindingValue(b, 'consolidatedCelex');
    if (!c) continue;
    const m = CONSOLIDATED_CELEX_RE.exec(c);
    if (m && m[1] === baseCore) {
      return { celex: c, asOf: `${m[2]}-${m[3]}-${m[4]}` };
    }
  }
  return;
}

/**
 * Traverse the requested CDM relation types for a work — one query per type, run
 * concurrently — and return de-duplicated relations tagged with their type and
 * direction. Each type is resolved through its own query (and its own LIMIT) so
 * the per-type caps are independent.
 *
 * `sourceCelex` is the CELEX identity of the work being traversed, supplied from
 * the CELEX input or resolved from the work URI. It gates the relation-specific
 * act-number filters. For `consolidated_version`,
 * CELLAR asserts the `consolidates` edge for genuine consolidations of this act
 * *and* — as a graph artifact — for consolidations of other acts (e.g. an act
 * this one repealed) plus CELEX-less `CONS_TEXT` member/manifestation works. That
 * filter is pushed into the SPARQL query for `consolidated_version` (see
 * `CelexConstraint`) so LIMIT/OFFSET and the truncation count operate on valid
 * rows only (issue #45); the same test is re-applied client-side below as
 * belt-and-suspenders. `consolidated_version` rows with no related CELEX are
 * always dropped (they can't be fetched via get_document anyway); when
 * `sourceCelex` is known, rows whose CELEX belongs to a different act are dropped
 * too. `national_transposition` similarly requires a sector-`7` CELEX carrying
 * the source directive's act core followed by a member-state code, selecting the
 * matching identifier before grouping when one national measure has several CELEX
 * values. Every other relation type is returned unfiltered.
 *
 * An absent `sourceCelex` — an addressed work with no CELEX, or one whose CELEX
 * identity is ambiguous because the work carries several — stands the act-core
 * constraints down rather than binding the traversal to an arbitrary act:
 * `consolidated_version` then requires only that the related work carry some
 * CELEX, and `national_transposition` returns nothing without issuing a query at
 * all, since selecting measures with no source act is precisely the arbitrary
 * binding the constraint exists to prevent.
 *
 * `perTypeLimit` bounds each direction of each type; `offset` pages within a
 * direction. Each query requests one additional grouped row per direction, then
 * removes that private sentinel before returning. `hasMore` is true only when a
 * direction produced that additional row.
 */
export async function traverseRelations(
  svc: Pick<CellarSparqlService, 'queryWithContinuation'>,
  workUri: string,
  types: readonly RelationType[],
  ctx: Context,
  sourceCelex?: string,
  perTypeLimit: number = DEFAULT_PER_TYPE_LIMIT,
  offset = 0,
): Promise<{ relations: WorkRelation[]; hasMore: boolean }> {
  const sourceActCore = sourceCelex ? celexActCore(sourceCelex) : undefined;
  const perType = await Promise.all(
    types.map(async (type): Promise<{ type: RelationType; bindings: SparqlBinding[] }> => {
      /**
       * Push relation-specific CELEX validity into the query before pagination:
       * sector-0 same-act consolidations and sector-7 same-act national measures.
       */
      let celex: CelexConstraint | undefined;
      if (type === 'consolidated_version') {
        celex = sourceActCore ? { pattern: `^0${sourceActCore}-[0-9]{8}$` } : {};
      } else if (type === 'national_transposition') {
        // With no source act core there is no pattern that selects this act's
        // implementing measures, and every row is dropped either way. Return the
        // empty result directly rather than spending a CELLAR round-trip on a
        // query whose filter can match nothing.
        if (!sourceActCore) return { type, bindings: [] };
        celex = { pattern: nationalMeasureCelexPattern(sourceActCore) };
      }
      return {
        type,
        bindings: await svc.queryWithContinuation(
          buildRelationQuery(workUri, RELATION_SPECS[type], perTypeLimit + 1, offset, celex),
          ctx,
        ),
      };
    }),
  );

  const relations: WorkRelation[] = [];
  let hasMore = false;
  for (const { type, bindings } of perType) {
    const rowsByDirection = new Map<
      'outgoing' | 'incoming',
      Array<{ relatedWorkUri: string; relatedCelex?: string }>
    >();
    const seenForType = new Set<string>();
    for (const b of bindings) {
      const relatedWorkUri = CellarSparqlService.bindingValue(b, 'relatedWork') ?? '';
      const direction =
        CellarSparqlService.bindingValue(b, 'direction') === 'incoming' ? 'incoming' : 'outgoing';
      const relatedCelex = CellarSparqlService.bindingValue(b, 'relatedCelexSample');

      // Keep CELEX-constrained relation lists trustworthy at a glance. These
      // checks mirror the SPARQL filters as client-side belt-and-suspenders.
      if (type === 'consolidated_version') {
        if (!relatedCelex) continue;
        if (sourceActCore && celexActCore(relatedCelex) !== sourceActCore) continue;
      }
      if (
        type === 'national_transposition' &&
        (!relatedCelex ||
          !sourceActCore ||
          !new RegExp(nationalMeasureCelexPattern(sourceActCore)).test(relatedCelex))
      ) {
        continue;
      }

      // Redundant since the query groups by ?relatedWork ?direction, which already
      // yields one row per pair; kept as a guard so a future projection change
      // cannot reintroduce duplicate relations in the output.
      const typeKey = `${direction}|${relatedWorkUri}`;
      if (seenForType.has(typeKey)) continue;
      seenForType.add(typeKey);
      const rows = rowsByDirection.get(direction) ?? [];
      rows.push({ relatedWorkUri, ...(relatedCelex ? { relatedCelex } : {}) });
      rowsByDirection.set(direction, rows);
    }

    for (const [direction, rows] of rowsByDirection) {
      if (rows.length > perTypeLimit) hasMore = true;
      for (const { relatedWorkUri, relatedCelex } of rows.slice(0, perTypeLimit)) {
        const relation: WorkRelation = { relationType: type, direction, relatedWorkUri };
        if (relatedCelex) relation.relatedCelexNumber = relatedCelex;
        relations.push(relation);
      }
    }
  }
  return { relations, hasMore };
}
