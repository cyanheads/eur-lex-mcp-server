/**
 * @fileoverview Shared CELLAR CDM relation traversal, used by the
 * eurlex_get_relations tool and the eurlex://document/{celex}/relations
 * resource. Owns the relation-type → CDM predicate + direction model so both
 * surfaces resolve relations identically.
 * @module services/cellar-sparql/relation-traversal
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { ENG_LANGUAGE_URI } from './cdm-labels.js';
import { CellarSparqlService } from './cellar-sparql-service.js';
import { celexLiteral } from './eli-resolution.js';
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
 * The link from a consolidated text to its base act. Every CELEX-bearing
 * consolidation carries exactly one, so it names an act's consolidations however
 * they are numbered (`32000O0007` is consolidated as `02000X0776-…` as well as
 * `02000O0007-…`). The broader `cdm:act_consolidated_consolidates_resource_legal`
 * also points at amending acts and at consolidations of other acts, and needed an
 * act-number match that missed every consolidation outside the `0{act}-YYYYMMDD`
 * shape.
 */
const CONSOLIDATION_BASE_PREDICATE = 'cdm:act_consolidated_based_on_resource_legal';

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
 *    {@link CONSOLIDATION_BASE_PREDICATE} (each consolidated text points back to
 *    its one base act; there is no forward `…has_consolidated_version…` link).
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
  consolidated_version: { predicate: CONSOLIDATION_BASE_PREDICATE, direction: 'incoming' },
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
 * proof. Consolidations require a CELEX; national transposition measures require a
 * sector-`7` CELEX with the source directive's act core. Requiring and filtering the
 * related CELEX before grouping also makes one work with several CELEX values occupy
 * exactly one page row. Client-side checks remain as belt-and-suspenders.
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
 * document date DESC, then by work URI, and paged (LIMIT + OFFSET).
 *
 * Ordering is the fix for the unordered-cap bug: an incoming edge on a
 * heavily-related act (e.g. works citing the GDPR) returns thousands of rows, so
 * an unordered LIMIT dropped the newest. Newest-first keeps the most recent within
 * the cap; `OFFSET` reaches the rest.
 *
 * The date is aggregated as `MAX(STR(?relatedDate))`. CELLAR evaluates `MAX` over the
 * OPTIONAL `xsd:date` wrongly in this grouped query, attaching dates of other works
 * and not the same ones on every call, so pages were neither the newest works nor
 * stable across calls. ISO `YYYY-MM-DD` strings sort lexically in date order, and
 * the string aggregate returns each work its own date. `?relatedWork` breaks ties:
 * it is the GROUP BY key, so the order is total and a same-date run cannot reorder
 * across a page boundary. An undated work's aggregate stays unbound and sorts after
 * every dated one.
 *
 * A symmetric type (`cites`, direction `both`) is a UNION of two subqueries, each
 * ordered and capped independently, so a dense outgoing set can't consume the
 * incoming budget and vice versa. The per-direction LIMITs must each be ≤
 * MAX_SPARQL_RESULTS: this query carries no outer LIMIT, and the internal `query`
 * path passes its subselect LIMITs through unchanged (the service imposes an outer
 * bound only on the raw escape hatch), so an over-cap here would return an
 * over-budget arm — callers pass a limit already clamped to the service ceiling.
 *
 * Each row's English title is joined after paging (#119): the per-direction
 * subqueries find the page, and the outer query adds one `OPTIONAL` English
 * expression title per paged work, so the join touches at most `limit` works per
 * direction however many works relate. Joining it inside the subqueries would
 * aggregate a title for every related work before `LIMIT`. The title aggregates as
 * `MAX(STR(?relatedTitle))` — one value, the same on every call, for a work with
 * several English titles — grouped by the subquery's projected variables, so the
 * rows, dates, and CELEX values are the subqueries' own.
 *
 * The outer query carries its own `ORDER BY ?direction DESC(?relatedDateMax)
 * ?relatedWork`, the subquery order within each direction. Without it the union
 * (and the regrouped rows) come back in an implementation-defined order, and the
 * caller slices each direction to `perTypeLimit` after grouping the rows by
 * direction — so an arbitrary interleaving can place the private continuation
 * sentinel inside the kept slice and drop a real relation instead.
 */
function buildRelationQuery(
  workUri: string,
  spec: { predicate: string; direction: Direction },
  limit: number,
  offset: number,
  celex?: CelexConstraint,
): string {
  const projection =
    'SELECT ?relatedWork (SAMPLE(?relatedCelex) AS ?relatedCelexSample) ?direction (MAX(STR(?relatedDate)) AS ?relatedDateMax)';
  const paging = `GROUP BY ?relatedWork ?direction ORDER BY DESC(?relatedDateMax) ?relatedWork LIMIT ${limit} OFFSET ${offset}`;
  const subquery = (direction: 'outgoing' | 'incoming') =>
    `{ ${projection} WHERE {
    ${relationArm(workUri, spec.predicate, direction, celex)}
  } ${paging} }`;
  const page =
    spec.direction === 'both'
      ? `${subquery('outgoing')} UNION ${subquery('incoming')}`
      : subquery(spec.direction);
  return `SELECT ?relatedWork ?relatedCelexSample ?direction ?relatedDateMax (MAX(STR(?relatedTitle)) AS ?relatedTitleMax) WHERE {
  ${page}
  OPTIONAL {
    ?relatedExpr cdm:expression_belongs_to_work ?relatedWork .
    ?relatedExpr cdm:expression_uses_language <${ENG_LANGUAGE_URI}> .
    ?relatedExpr cdm:expression_title ?relatedTitle .
  }
} GROUP BY ?relatedWork ?relatedCelexSample ?direction ?relatedDateMax ORDER BY ?direction DESC(?relatedDateMax) ?relatedWork`;
}

/**
 * Extract a CELEX's act-identifying core — the `{year}{type}{number}` that
 * follows the one-character sector — so a national implementing measure (sector
 * `7`) can be matched to the directive it transposes (`32016L0680` and
 * `72016L0680CZE_225030` both yield `2016L0680`). Returns `undefined` when the
 * string doesn't parse as a CELEX.
 */
const CELEX_ACT_CORE_RE = /^[0-9A-Z](\d{4}[A-Z]{1,2}\d+)/;
function celexActCore(celex: string): string | undefined {
  return CELEX_ACT_CORE_RE.exec(celex)?.[1];
}

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
 * `32016L0680`. The trailing measure number is deliberately left
 * unanchored — no digit can extend the act core across three letters, so
 * anchoring it would add false-rejection risk without closing anything.
 * Verified against 3,000 sector-7 CELEX values pulled live from CELLAR: all
 * carry the three-letter code.
 */
function nationalMeasureCelexPattern(sourceActCore: string): string {
  return `^7${sourceActCore}[A-Z]{3}`;
}

/**
 * True when a CELEX names a consolidated text: sector `0` is the consolidated-text
 * sector, and every CELEX-bearing consolidation linked to a base act carries it,
 * including those outside the `0{act}-YYYYMMDD` shape (`02006A0901(01)-20090301`,
 * `02003T0000-20040501`).
 */
export function isConsolidatedCelex(celex: string): boolean {
  return celex.startsWith('0');
}

/** A consolidated text's base act, as its based-on link names it. */
export interface ConsolidationBase {
  /** CELEX of the base act. */
  celex: string;
  workUri: string;
}

/** Where a CELEX stands among its act's consolidated versions. */
export interface ConsolidationContext {
  /**
   * The base act of the consolidated versions: the linked base of a consolidated
   * text, or the requested act itself when it has a current consolidated version.
   * Absent for a consolidated text with no based-on link, or whose base work
   * carries no CELEX — a base that can't be named, so the text reads as its own.
   */
  base?: ConsolidationBase;
  /** The act's newest consolidated version in effect today. Absent when it has none. */
  current?: { asOf: string; celex: string };
  /**
   * For a base-act CELEX with no consolidated version in effect, one dated after
   * today (the latest, when there are several), which does not apply yet. Absent
   * otherwise.
   */
  pending?: { asOf: string; celex: string };
  /** Consolidation date of a consolidated-text CELEX, ISO 8601. */
  requestedAsOf?: string;
}

/**
 * Locate a CELEX among its act's consolidated versions in one query. A base-act
 * CELEX reads its newest consolidation; a consolidated-text CELEX (sector `0`)
 * reads its own consolidation date, its base act's work and CELEX, and that base
 * act's newest consolidation.
 *
 * An act's consolidations are the works whose {@link CONSOLIDATION_BASE_PREDICATE}
 * is its work. The newest is the latest `cdm:act_consolidated_date` on or before
 * today, which also supplies its `asOf`: a consolidation dated in the future does
 * not apply yet and is never the current one. The date orders the versions, not
 * the CELEX, because one act's consolidations can be numbered differently. Dates
 * compare as ISO strings, the form `STR()` renders an `xsd:date` in.
 *
 * A base act whose consolidations are all dated in the future has no current
 * version; the same query reads one of those as `pending`, so a caller can say no
 * consolidated version is in effect yet. Both arms are OPTIONAL, and unbound values
 * sort last under `DESC`, so a current version always wins the one row returned.
 *
 * Self-contained: keys on the typed CELEX literal (#92), so a caller can run it
 * concurrently with CELEX resolution and the metadata fetch.
 */
export async function findConsolidation(
  svc: Pick<CellarSparqlService, 'query'>,
  celex: string,
  ctx: Context,
): Promise<ConsolidationContext> {
  const today = new Date().toISOString().slice(0, 10);
  const currentPattern = `?current ${CONSOLIDATION_BASE_PREDICATE} ?baseWork ;
      cdm:act_consolidated_date ?currentDate ;
      cdm:resource_legal_id_celex ?currentCelex .
    FILTER(STR(?currentDate) <= "${today}")`;
  const newestFirst = 'ORDER BY DESC(STR(?currentDate)) DESC(?currentCelex)';

  const query = isConsolidatedCelex(celex)
    ? `
SELECT ?requestedDate ?baseWork ?baseCelex ?currentCelex ?currentDate WHERE {
  ?requested cdm:resource_legal_id_celex ${celexLiteral(celex)} ;
    ${CONSOLIDATION_BASE_PREDICATE} ?baseWork .
  OPTIONAL { ?requested cdm:act_consolidated_date ?requestedDate . }
  OPTIONAL { ?baseWork cdm:resource_legal_id_celex ?baseCelex . }
  OPTIONAL {
    ${currentPattern}
  }
} ${newestFirst} LIMIT 1`
    : `
SELECT ?baseWork ?currentCelex ?currentDate ?pendingCelex ?pendingDate WHERE {
  ?baseWork cdm:resource_legal_id_celex ${celexLiteral(celex)} .
  OPTIONAL {
    ${currentPattern}
  }
  OPTIONAL {
    ?pending ${CONSOLIDATION_BASE_PREDICATE} ?baseWork ;
      cdm:act_consolidated_date ?pendingDate ;
      cdm:resource_legal_id_celex ?pendingCelex .
    FILTER(STR(?pendingDate) > "${today}")
  }
} ${newestFirst} DESC(STR(?pendingDate)) LIMIT 1`;

  const [row] = await svc.query(query, ctx);
  const baseWork = CellarSparqlService.bindingValue(row, 'baseWork');
  if (!baseWork) return {};

  const version = (celexVariable: string, dateVariable: string) => {
    const versionCelex = CellarSparqlService.bindingValue(row, celexVariable);
    const date = CellarSparqlService.bindingValue(row, dateVariable);
    return versionCelex && date ? { celex: versionCelex, asOf: date.slice(0, 10) } : undefined;
  };
  const current = version('currentCelex', 'currentDate');

  if (!isConsolidatedCelex(celex)) {
    if (current) return { base: { workUri: baseWork, celex }, current };
    const pending = version('pendingCelex', 'pendingDate');
    return pending ? { pending } : {};
  }
  const baseCelex = CellarSparqlService.bindingValue(row, 'baseCelex');
  const requestedAsOf = CellarSparqlService.bindingValue(row, 'requestedDate')?.slice(0, 10);
  return {
    ...(baseCelex ? { base: { workUri: baseWork, celex: baseCelex } } : {}),
    ...(current ? { current } : {}),
    ...(requestedAsOf ? { requestedAsOf } : {}),
  };
}

/**
 * Traverse the requested CDM relation types for a work — one query per type, run
 * concurrently — and return de-duplicated relations tagged with their type and
 * direction. Each type is resolved through its own query (and its own LIMIT) so
 * the per-type caps are independent.
 *
 * `sourceCelex` is the CELEX identity of the work being traversed, supplied from
 * the CELEX input or resolved from the work URI. It gates the act-number filter of
 * `national_transposition`, which requires a sector-`7` CELEX carrying the source
 * directive's act core followed by a member-state code, selecting the matching
 * identifier before grouping when one national measure has several CELEX values,
 * and reports that code as the row's `relatedMemberState` — the only relation type
 * that carries one. The filter is pushed into the SPARQL query (see
 * `CelexConstraint`) so LIMIT/OFFSET and the truncation count operate on valid rows
 * only (issue #45), and re-applied client-side below as belt-and-suspenders. An
 * absent `sourceCelex` — an addressed work with no CELEX, or one whose CELEX
 * identity is ambiguous because the work carries several — returns no
 * `national_transposition` rows without issuing a query at all, since selecting
 * measures with no source act is precisely the arbitrary binding the constraint
 * exists to prevent.
 *
 * `consolidated_version` follows the based-on link, which reaches this act's
 * consolidations alone, and requires only that the related work carry a CELEX:
 * a CELEX-less `CONS_TEXT` member or manifestation work can't be fetched via
 * get_document. Every other relation type is returned unfiltered.
 *
 * `perTypeLimit` bounds each direction of each type; `offset` pages within a
 * direction. Each query requests one additional grouped row per direction, then
 * removes that private sentinel before returning. `hasMore` is true only when a
 * direction produced that additional row.
 *
 * Each relation carries the related work's date — the value its page is ordered
 * by — and its English title (#119), each omitted when the work has none; no
 * other language stands in for a missing English title.
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
       * CELEX-bearing consolidations and sector-7 same-act national measures.
       */
      let celex: CelexConstraint | undefined;
      if (type === 'consolidated_version') {
        celex = {};
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

  const nationalMeasureRe = sourceActCore
    ? new RegExp(nationalMeasureCelexPattern(sourceActCore))
    : undefined;
  const relations: WorkRelation[] = [];
  let hasMore = false;
  for (const { type, bindings } of perType) {
    const rowsByDirection = new Map<'outgoing' | 'incoming', Omit<WorkRelation, 'direction'>[]>();
    const seenForType = new Set<string>();
    for (const b of bindings) {
      const relatedWorkUri = CellarSparqlService.bindingValue(b, 'relatedWork') ?? '';
      const direction =
        CellarSparqlService.bindingValue(b, 'direction') === 'incoming' ? 'incoming' : 'outgoing';
      const relatedCelex = CellarSparqlService.bindingValue(b, 'relatedCelexSample');
      const relatedDate = CellarSparqlService.bindingValue(b, 'relatedDateMax')?.slice(0, 10);
      const relatedTitle = CellarSparqlService.bindingValue(b, 'relatedTitleMax');

      // Keep CELEX-constrained relation lists trustworthy at a glance. These
      // checks mirror the SPARQL filters as client-side belt-and-suspenders.
      if (type === 'consolidated_version' && !relatedCelex) continue;
      let relatedMemberState: string | undefined;
      if (type === 'national_transposition') {
        const match = relatedCelex ? nationalMeasureRe?.exec(relatedCelex) : undefined;
        if (!match) continue;
        // The anchored pattern ends on the member-state code, so the match's last
        // three characters are that code (#85).
        relatedMemberState = match[0].slice(-3);
      }

      // Redundant since the query groups by ?relatedWork ?direction, which already
      // yields one row per pair; kept as a guard so a future projection change
      // cannot reintroduce duplicate relations in the output.
      const typeKey = `${direction}|${relatedWorkUri}`;
      if (seenForType.has(typeKey)) continue;
      seenForType.add(typeKey);
      const rows = rowsByDirection.get(direction) ?? [];
      rows.push({
        relationType: type,
        relatedWorkUri,
        ...(relatedCelex ? { relatedCelexNumber: relatedCelex } : {}),
        ...(relatedMemberState ? { relatedMemberState } : {}),
        ...(relatedDate ? { relatedDate } : {}),
        ...(relatedTitle ? { relatedTitle } : {}),
      });
      rowsByDirection.set(direction, rows);
    }

    for (const [direction, rows] of rowsByDirection) {
      if (rows.length > perTypeLimit) hasMore = true;
      for (const row of rows.slice(0, perTypeLimit)) relations.push({ ...row, direction });
    }
  }
  return { relations, hasMore };
}
