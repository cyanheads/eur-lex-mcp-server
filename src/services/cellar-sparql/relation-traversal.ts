/**
 * @fileoverview Shared CELLAR CDM relation traversal, used by the
 * eurlex_get_relations tool and the eurlex://document/{celex}/relations
 * resource. Owns the relation-type → CDM predicate + direction model so both
 * surfaces resolve relations identically.
 * @module services/cellar-sparql/relation-traversal
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { ENG_LANGUAGE_URI } from './cdm-labels.js';
import { CellarSparqlService } from './cellar-sparql-service.js';
import { celexLiteral, escapeSparqlLiteral, isSafeSparqlIri } from './eli-resolution.js';
import type { CelexSector } from './keyword-match.js';
import { cellarDate, readWindowedPage, windowedLimit } from './sort-window.js';
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
  'basis_for',
  'interprets',
  'interpreted_by',
  'consolidated_version',
  'national_transposition',
  'adopts',
  'adopted_by',
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
 * Legal basis and case-law interpretation pair the same way:
 *  - `legal_basis` is the outgoing side of `…based_on…` (the treaty article or act
 *    this act rests on); `basis_for` is its incoming side, the works naming this
 *    act among their legal bases — implementing and delegated acts, but also
 *    Parliament resolutions and drafts, which CELLAR links with the same predicate.
 *  - `interprets` is the outgoing side of `…case-law_interpretes…`, whose subject is
 *    always sector-6 case law (what a ruling interprets); `interpreted_by` is its
 *    incoming side, the rulings interpreting this act.
 *  - `adopts` is the outgoing side of `…adopts…`, whose subject is the adopting act:
 *    usually the Commission proposal it adopts, but also the international agreement
 *    a concluding decision adopts or the joint-committee decision a regulation
 *    implements; `adopted_by` is its incoming side, the act that adopted this work.
 *    Like `basis_for`, both are unfiltered: callers tell targets apart by CELEX.
 *
 * Each of these types is one direction only; `cites` is symmetric ("citation
 * graph"), so both directions are surfaced and tagged via `?direction`.
 *
 * `annotated` marks the types whose predicate CELLAR reifies with location axioms
 * ({@link locationAxiom}) naming a provision of the edge's object: amendment,
 * explicit and implicit repeal, interpretation, and adoption (2026-10-24: 203,244,
 * 978, 1,156, 19,539, and 4 axioms). Citation, legal basis, consolidation, and
 * national transposition carry none, so their rows never read provisions.
 */
const RELATION_SPECS: Record<
  RelationType,
  { predicate: string; direction: Direction; annotated?: true }
> = {
  cites: { predicate: 'cdm:work_cites_work', direction: 'both' },
  amends: {
    predicate: 'cdm:resource_legal_amends_resource_legal',
    direction: 'outgoing',
    annotated: true,
  },
  amended_by: {
    predicate: 'cdm:resource_legal_amends_resource_legal',
    direction: 'incoming',
    annotated: true,
  },
  repeals: {
    predicate: 'cdm:resource_legal_repeals_resource_legal',
    direction: 'outgoing',
    annotated: true,
  },
  repealed_by: {
    predicate: 'cdm:resource_legal_repeals_resource_legal',
    direction: 'incoming',
    annotated: true,
  },
  implicitly_repeals: {
    predicate: 'cdm:resource_legal_implicitly_repeals_resource_legal',
    direction: 'outgoing',
    annotated: true,
  },
  implicitly_repealed_by: {
    predicate: 'cdm:resource_legal_implicitly_repeals_resource_legal',
    direction: 'incoming',
    annotated: true,
  },
  legal_basis: { predicate: 'cdm:resource_legal_based_on_resource_legal', direction: 'outgoing' },
  basis_for: { predicate: 'cdm:resource_legal_based_on_resource_legal', direction: 'incoming' },
  interprets: {
    predicate: 'cdm:case-law_interpretes_resource_legal',
    direction: 'outgoing',
    annotated: true,
  },
  interpreted_by: {
    predicate: 'cdm:case-law_interpretes_resource_legal',
    direction: 'incoming',
    annotated: true,
  },
  consolidated_version: { predicate: CONSOLIDATION_BASE_PREDICATE, direction: 'incoming' },
  national_transposition: {
    predicate: 'cdm:measure_national_implementing_implements_resource_legal',
    direction: 'incoming',
  },
  adopts: {
    predicate: 'cdm:resource_legal_adopts_resource_legal',
    direction: 'outgoing',
    annotated: true,
  },
  adopted_by: {
    predicate: 'cdm:resource_legal_adopts_resource_legal',
    direction: 'incoming',
    annotated: true,
  },
};

/** True when `type` reads edges that point at the source work: every type but the outgoing six. */
export function readsIncoming(type: RelationType): boolean {
  return RELATION_SPECS[type].direction !== 'outgoing';
}

const OWL = 'http://www.w3.org/2002/07/owl#';
const MODIFIED_LOCATION =
  '<http://publications.europa.eu/ontology/annotation#reference_to_modified_location>';

/**
 * The `owl:Axiom` CELLAR reifies an edge `source predicate target` with, binding
 * the provision designator it records to `location`. The axiom's annotated source
 * and target are the edge's own work URIs; one edge carries one axiom per
 * designator, and CELLAR records some twice. Full IRIs, since the service's prefix
 * block declares neither vocabulary.
 */
function locationAxiom(
  axiom: string,
  source: string,
  predicate: string,
  target: string,
  location: string,
): string {
  return `${axiom} <${OWL}annotatedSource> ${source} ; <${OWL}annotatedProperty> ${predicate} ; <${OWL}annotatedTarget> ${target} ; ${MODIFIED_LOCATION} ${location} .`;
}

/**
 * An edge's two ends: the related work's variable on one side, on the other the term
 * the source reads — its work `<…>`, or {@link VERSION_WORK} over a version set.
 */
function edgeEnds(
  source: string,
  related: string,
  direction: 'outgoing' | 'incoming',
): [source: string, target: string] {
  return direction === 'outgoing' ? [source, related] : [related, source];
}

/**
 * The consolidated versions of the post-Lisbon treaties, each numbered with its own
 * sector-1 CELEX: the TFEU (`E`) and TEU (`M`) of 2008, 2010, 2012, and 2016, and the
 * Charter of Fundamental Rights (`P`) of 2007, 2010, 2012, and 2016. A provision keeps
 * its number in every version, and CELLAR files its incoming edges against whichever
 * version their author cited (#199): rulings mostly on 2007/2008, legal-basis links on
 * the later versions, citations on all four. No predicate links the versions to one
 * another, so the set is the CELEX suffix under the four prefixes.
 */
const LISBON_TREATY_YEARS = new Map<string, readonly string[]>([
  ['E', ['2008', '2010', '2012', '2016']],
  ['M', ['2008', '2010', '2012', '2016']],
  ['P', ['2007', '2010', '2012', '2016']],
]);

/** A Lisbon treaty article (`12016E102`, three digits) or whole text (`12016E/TXT`). */
const LISBON_TREATY_CELEX = /^1(\d{4})([EMP])(\d{3}|\/TXT)$/;

/**
 * The same-numbered CELEX of every version of the Lisbon treaty article or whole text
 * `celex` names, oldest first, `celex` among them; `undefined` for any other CELEX —
 * a protocol, annex, or declaration, a pre-Lisbon treaty, every act.
 */
export function treatyVersionCelex(celex: string): string[] | undefined {
  const [, year = '', treaty = '', part = ''] = LISBON_TREATY_CELEX.exec(celex) ?? [];
  const years = LISBON_TREATY_YEARS.get(treaty);
  return years?.includes(year) ? years.map((version) => `1${version}${treaty}${part}`) : undefined;
}

/** One version of a Lisbon treaty article or text: its CELEX and the work CELLAR files it under. */
export interface TreatyVersion {
  celex: string;
  workUri: string;
}

/** The versions among `celexNumbers` that resolved to a work, in that order. */
export function resolvedVersions(
  celexNumbers: readonly string[],
  works: ReadonlyMap<string, string>,
): TreatyVersion[] {
  return celexNumbers.flatMap((celex) => {
    const workUri = works.get(celex);
    return workUri ? [{ celex, workUri }] : [];
  });
}

/**
 * Where `article` points on a Lisbon treaty CELEX (#199):
 *  - `text`: on a whole text, the article's own versions (`12016P/TXT` with 47 reads
 *    `12007P047` … `12016P047`). Interpretation edges on a whole text record no
 *    provision, so the provision filter would match nothing there. No Lisbon treaty
 *    article carries a letter or a four-digit number, so such an article names none;
 *  - `same`: on an article, the article it names, which needs no filter;
 *  - `other`: on an article, any other article — provisions recorded on an article's
 *    work are relative to it (`L2LA`), so no other article can match.
 * `undefined` for any other CELEX, whose `interpreted_by` the provision filter narrows.
 */
export type TreatyArticleRoute =
  | { kind: 'text'; versionCelex: string[] }
  | { kind: 'same' }
  | { kind: 'other'; celexArticle: string };

export function treatyArticleRoute(
  celex: string,
  article: ArticleFilter,
): TreatyArticleRoute | undefined {
  const versions = treatyVersionCelex(celex);
  if (!versions) return;
  // After the sector, year, and treaty letter: `102` or `/TXT`.
  const part = celex.slice(6);
  if (part === '/TXT') {
    const named = !article.letter && article.number.length <= 3;
    const number = article.number.padStart(3, '0');
    return {
      kind: 'text',
      versionCelex: named ? versions.map((version) => version.replace('/TXT', number)) : [],
    };
  }
  const celexArticle = part.replace(/^0+/, '');
  return !article.letter && article.number === celexArticle
    ? { kind: 'same' }
    : { kind: 'other', celexArticle };
}

/** The variable a version set's arms bind to each version's work. */
const VERSION_WORK = '?versionWork';

/**
 * `VALUES` binding `variable` to each IRI the IRI guard accepts; CELLAR's own work
 * URIs always pass.
 */
function iriValues(variable: string, iris: readonly string[]): string {
  return `VALUES ${variable} { ${iris
    .filter(isSafeSparqlIri)
    .map((iri) => `<${iri}>`)
    .join(' ')} }`;
}

/** The `VALUES` block binding {@link VERSION_WORK} to a version set's works. */
function versionValues(versions: readonly TreatyVersion[]): string {
  return iriValues(
    VERSION_WORK,
    versions.map((version) => version.workUri),
  );
}

/**
 * Collapse each `{CODE|…/CODE}` authority token of a recorded designator to its
 * code, the token's last URI segment repeated: `{AR|…/fd_370/AR} 43 {PA|…/fd_370/PA} 4`
 * reads `AR 43 PA 4`. A token whose code differs from its URI's last segment
 * (`{TIRE |…/fd_370/TIRE}`), and any other brace text, stays verbatim. The pattern
 * cannot backtrack across a brace or a bar, so the pass is linear in the value.
 */
export function compactProvision(value: string): string {
  return value.replace(/\{([^{}|]+)\|([^{}|]*)\}/g, (token, code: string, uri: string) =>
    uri.endsWith(`/${code}`) ? code : token,
  );
}

/**
 * The `article` input as callers type it: an article number with at most one letter
 * (`17`, `6a`), optionally prefixed `Article`, `Art.`, or `Art`, in any case, or a
 * blank value. Nothing after the number is admitted — no paragraph (`17(1)`), range,
 * or Roman numeral — so a parsed value carries no SPARQL-significant character. No
 * quantifier can trade characters with its neighbour, so matching is linear. Case
 * classes are spelled out rather than flagged, because the JSON Schema pattern
 * clients validate against carries no flags.
 */
export const ARTICLE_INPUT_PATTERN =
  /^\s*(?:(?:[Aa][Rr][Tt][Ii][Cc][Ll][Ee]|[Aa][Rr][Tt]\.?)\s*)?\d{1,4}[A-Za-z]?\s*$|^\s*$/;

/** An article of the interpreted act: its number without leading zeros, and its letter in lower case. */
export interface ArticleFilter {
  letter?: string;
  number: string;
}

/**
 * The article a value matching {@link ARTICLE_INPUT_PATTERN} names, or `undefined`
 * for a blank one.
 */
export function parseArticle(value: string): ArticleFilter | undefined {
  const core = value.trim().replace(/^(?:article|art\.?)\s*/i, '');
  if (!core) return;
  const letter = /[a-z]$/i.test(core) ? core.slice(-1).toLowerCase() : undefined;
  const number = (letter ? core.slice(0, -1) : core).replace(/^0+(?=\d)/, '');
  return letter ? { number, letter } : { number };
}

/** An article as the tool echoes it: `17`, `28c`. */
export function articleLabel(article: ArticleFilter): string {
  return `${article.number}${article.letter ?? ''}`;
}

/**
 * The Latin ordinals CELLAR's legacy codes write a lettered article with, following
 * the French numbering: Article 28a is `A28BIS`, 28c is `A28QUATER`. Index 0 is `a`.
 */
const LATIN_ORDINALS = [
  'BIS',
  'TER',
  'QUATER',
  'QUINQUIES',
  'SEXIES',
  'SEPTIES',
  'OCTIES',
  'NONIES',
  'DECIES',
  'UNDECIES',
  'DUODECIES',
  'TERDECIES',
  'QUATERDECIES',
  'QUINDECIES',
  'SEXDECIES',
  'SEPTDECIES',
  'OCTODECIES',
  'NOVODECIES',
  'VICIES',
];

/** The short ordinals authority-token designators carry (`AR 10BI`, `AR 28TR.2`, `AR 10QT`). */
const TOKEN_ORDINALS: Readonly<Record<string, string>> = { a: 'BI', b: 'TR', c: 'QT' };

/**
 * Letters that open a sub-article segment in a compact code (`P` paragraph, `L`
 * point letter or subparagraph, `T` indent, `SNT`), so `A17P1` is Article 17(1),
 * never Article 17p: a lettered article with one of these is matched by its
 * ordinal alone in the compact form.
 */
const COMPACT_SEGMENT_LETTERS = new Set(['l', 'p', 's', 't']);

/**
 * The REGEX a recorded designator matches when it lies in `article`, at any depth.
 * Two forms carry the article (2026-10-24, interprets axioms):
 *  - compact codes (80%): `A`, the number with optional zero padding, then the
 *    end or a segment — `A17`, `A17P1LC`, `A067SNT2` (Article 67) — and never a
 *    longer number or another article's suffix (`A170`, `A17BIS`, `A17TER`);
 *  - authority tokens (5%): `{AR|…} 17`, then the end, a space, or a dot —
 *    `AR 17.6 L2`, `AR 17 .6` — and never `AR 17a`.
 * A letter matches itself and its Latin ordinal (`28c`: `A28QUATER…`, `AR 28c`,
 * `AR 28QT`). The pattern is built from the parsed digits and letter alone.
 */
export function articleLocationPattern(article: ArticleFilter): string {
  const { number, letter } = article;
  const alternation = (options: string[]) => (options.length ? `(${options.join('|')})` : '');
  const ordinal = letter ? LATIN_ORDINALS[letter.charCodeAt(0) - 97] : undefined;
  const compact = letter
    ? [
        ...(COMPACT_SEGMENT_LETTERS.has(letter) ? [] : [letter.toUpperCase()]),
        ...(ordinal ? [ordinal] : []),
      ]
    : [];
  const token = letter
    ? [
        letter,
        letter.toUpperCase(),
        ...(ordinal ? [ordinal] : []),
        ...(TOKEN_ORDINALS[letter] ? [TOKEN_ORDINALS[letter]] : []),
      ]
    : [];
  const branches = [
    ...(letter && compact.length === 0
      ? []
      : [`A0*${number}${alternation(compact)}(P|L|T[0-9]|SNT|$)`]),
    `\\{AR\\|[^}]*\\} 0*${number}${alternation(token)}([ .]|$)`,
  ];
  return `^(${branches.join('|')})`;
}

/**
 * `FILTER EXISTS` keeping an `interpreted_by` row only when one of its recorded
 * provisions lies in `article`, pushed into the paged query so LIMIT, OFFSET, and
 * the sentinel row count matching rulings alone.
 */
function articleFilterClause(
  sourceTerm: string,
  related: string,
  predicate: string,
  direction: 'outgoing' | 'incoming',
  article: ArticleFilter,
): string {
  const [source, target] = edgeEnds(sourceTerm, related, direction);
  return `FILTER EXISTS { ${locationAxiom('?articleAxiom', source, predicate, target, '?articleLocation')} FILTER(REGEX(STR(?articleLocation), "${escapeSparqlLiteral(articleLocationPattern(article))}")) }`;
}

/**
 * Ceiling on the per-direction page size: the largest `limit` the
 * eurlex_get_relations tool serves, clamping anything above it. It is not the
 * tool's default, which its input schema sets. Each relation type is queried
 * independently with its own LIMIT so a high-volume type (e.g. `cites`) can't
 * starve rarer types under a single shared cap; a symmetric type splits its cap
 * per direction too (see `buildRelationQuery`). The service caps further if
 * MAX_SPARQL_RESULTS is lower — callers clamp to it to keep both sides of a
 * symmetric query capped consistently.
 */
export const PER_TYPE_LIMIT_CEILING = 100;

/**
 * CELEX constraint pushed into a relation arm before LIMIT/OFFSET and continuation
 * proof. Consolidations require a CELEX; national transposition measures require a
 * sector-`7` CELEX with the source directive's act core; a caller's `relatedSectors`
 * requires one opening with a listed sector. Requiring and filtering the related
 * CELEX before grouping also makes one work with several CELEX values occupy exactly
 * one page row, reported by a CELEX that passed. Client-side checks remain as
 * belt-and-suspenders for the pattern.
 */
interface CelexConstraint {
  /** Regular expression applied to the related work's required CELEX identifier. */
  pattern?: string;
  /** Sectors the related work's required CELEX must open with. */
  sectors?: readonly CelexSector[];
}

/**
 * The FILTERs a CELEX constraint applies to `variable`, the related work's CELEX. The
 * sector test lists members of the closed sector set, so no caller character reaches
 * it; the pattern is built from the source act core and member-state codes.
 */
function celexFilters(variable: string, celex: CelexConstraint): string[] {
  return [
    ...(celex.pattern ? [`FILTER(REGEX(STR(${variable}), "${celex.pattern}"))`] : []),
    ...(celex.sectors
      ? [
          `FILTER(SUBSTR(STR(${variable}), 1, 1) IN (${celex.sectors.map((sector) => `"${sector}"`).join(', ')}))`,
        ]
      : []),
  ];
}

/**
 * One direction's graph pattern for a relation predicate, tagged with its direction.
 * With `versions`, the edge reaches any of the version works rather than `workUri`.
 */
function relationArm(
  workUri: string,
  predicate: string,
  direction: 'outgoing' | 'incoming',
  celex?: CelexConstraint,
  article?: ArticleFilter,
  versions?: readonly TreatyVersion[],
): string {
  const sourceTerm = versions ? VERSION_WORK : `<${workUri}>`;
  const [source, target] = edgeEnds(sourceTerm, '?relatedWork', direction);
  const edge = `${versions ? `${versionValues(versions)}\n    ` : ''}${source} ${predicate} ${target} .`;
  // A pushed constraint requires the related CELEX; other relation types keep it
  // OPTIONAL so CELEX-less related works still return.
  const celexTriple = celex
    ? `?relatedWork cdm:resource_legal_id_celex ?relatedCelex .`
    : `OPTIONAL { ?relatedWork cdm:resource_legal_id_celex ?relatedCelex . }`;
  const celexFilter = celex
    ? celexFilters('?relatedCelex', celex)
        .map((filter) => `\n    ${filter}`)
        .join('')
    : '';
  const articleFilter = article
    ? `\n    ${articleFilterClause(sourceTerm, '?relatedWork', predicate, direction, article)}`
    : '';
  // `?relatedDate` drives the per-direction ordering below; it stays OPTIONAL so
  // related works without a document date still return (they sort last under DESC).
  return `${edge}
    ${celexTriple}${celexFilter}
    OPTIONAL { ?relatedWork cdm:work_date_document ?relatedDate . }${articleFilter}
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
 *
 * With `versions` (#199), the incoming arm binds {@link VERSION_WORK} to each version's
 * work in a `VALUES` block and follows the edge to any of them, so a related work whose
 * edges reach two versions still groups into one row, dated and paged once. A `FILTER`
 * joining the versions' CELEX literals instead was timed at 51–117 s on Charter Article
 * 47; the `VALUES` arm answers in well under a second there.
 */
function buildRelationQuery(
  workUri: string,
  spec: { predicate: string; direction: Direction },
  limit: number,
  offset: number,
  celex?: CelexConstraint,
  article?: ArticleFilter,
  versions?: readonly TreatyVersion[],
): string {
  const projection =
    'SELECT ?relatedWork (SAMPLE(?relatedCelex) AS ?relatedCelexSample) ?direction (MAX(STR(?relatedDate)) AS ?relatedDateMax)';
  // Over a version set, the incoming arm also names the versions each related work's
  // edges reach: at most four work URIs, far inside the size a grouped concatenation
  // fails at (SR319, about 4 KB).
  const recordedAgainst = versions
    ? ` (GROUP_CONCAT(DISTINCT STR(${VERSION_WORK}); separator=" ") AS ?recordedAgainst)`
    : '';
  const paging = `GROUP BY ?relatedWork ?direction ORDER BY DESC(?relatedDateMax) ?relatedWork LIMIT ${limit} OFFSET ${offset}`;
  const subquery = (direction: 'outgoing' | 'incoming') => {
    const armVersions = direction === 'incoming' ? versions : undefined;
    return `{ ${projection}${armVersions ? recordedAgainst : ''} WHERE {
    ${relationArm(workUri, spec.predicate, direction, celex, article, armVersions)}
  } ${paging} }`;
  };
  const page =
    spec.direction === 'both'
      ? `${subquery('outgoing')} UNION ${subquery('incoming')}`
      : subquery(spec.direction);
  const recorded = versions ? ' ?recordedAgainst' : '';
  return `SELECT ?relatedWork ?relatedCelexSample ?direction ?relatedDateMax${recorded} (MAX(STR(?relatedTitle)) AS ?relatedTitleMax) WHERE {
  ${page}
  OPTIONAL {
    ?relatedExpr cdm:expression_belongs_to_work ?relatedWork .
    ?relatedExpr cdm:expression_uses_language <${ENG_LANGUAGE_URI}> .
    ?relatedExpr cdm:expression_title ?relatedTitle .
  }
} GROUP BY ?relatedWork ?relatedCelexSample ?direction ?relatedDateMax${recorded} ORDER BY ?direction DESC(?relatedDateMax) ?relatedWork`;
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
 * The member-state codes a sector-7 CELEX carries after the act core: ISO 3166-1
 * alpha-3 for the 27 member states plus `GBR` for the United Kingdom. Every CELEX of
 * a national implementing measure in CELLAR carries one of these 28, in upper case,
 * and nothing else (268,076 values, 2026-10-14).
 */
export const MEMBER_STATE_CODES = [
  'AUT',
  'BEL',
  'BGR',
  'CYP',
  'CZE',
  'DEU',
  'DNK',
  'ESP',
  'EST',
  'FIN',
  'FRA',
  'GBR',
  'GRC',
  'HRV',
  'HUN',
  'IRL',
  'ITA',
  'LTU',
  'LUX',
  'LVA',
  'MLT',
  'NLD',
  'POL',
  'PRT',
  'ROU',
  'SVK',
  'SVN',
  'SWE',
] as const;

export type MemberStateCode = (typeof MEMBER_STATE_CODES)[number];

/**
 * Each member state's two-letter code: ISO 3166-1 alpha-2 plus the EU's own `EL`
 * (Greece) and `UK` (the United Kingdom). A two-letter code never reaches the CELEX
 * pattern as given — the pattern is right-unanchored, so `ES` would match the
 * Estonian `EST` measures rather than the Spanish `ESP` ones.
 */
const MEMBER_STATE_ALPHA2 = new Map<string, MemberStateCode>([
  ['AT', 'AUT'],
  ['BE', 'BEL'],
  ['BG', 'BGR'],
  ['CY', 'CYP'],
  ['CZ', 'CZE'],
  ['DE', 'DEU'],
  ['DK', 'DNK'],
  ['EE', 'EST'],
  ['EL', 'GRC'],
  ['ES', 'ESP'],
  ['FI', 'FIN'],
  ['FR', 'FRA'],
  ['GB', 'GBR'],
  ['GR', 'GRC'],
  ['HR', 'HRV'],
  ['HU', 'HUN'],
  ['IE', 'IRL'],
  ['IT', 'ITA'],
  ['LT', 'LTU'],
  ['LU', 'LUX'],
  ['LV', 'LVA'],
  ['MT', 'MLT'],
  ['NL', 'NLD'],
  ['PL', 'POL'],
  ['PT', 'PRT'],
  ['RO', 'ROU'],
  ['SE', 'SWE'],
  ['SI', 'SVN'],
  ['SK', 'SVK'],
  ['UK', 'GBR'],
]);

/**
 * The member-state code a caller's value names — one of {@link MEMBER_STATE_CODES}
 * or its two-letter code, in any case and with surrounding whitespace — as the
 * three-letter code a sector-7 CELEX carries; `undefined` for anything else.
 */
export function toMemberStateCode(value: string): MemberStateCode | undefined {
  const code = value.trim().toUpperCase();
  return (
    MEMBER_STATE_CODES.find((memberState) => memberState === code) ?? MEMBER_STATE_ALPHA2.get(code)
  );
}

/**
 * CELEX pattern for a national implementing measure that transposes the act
 * identified by `sourceActCore`: sector `7`, the source act core, then the
 * three-letter member-state code every sector-7 CELEX carries
 * (`72016L0680CZE_225030`, `72014L0056FIN_240353`) — any code, or one of
 * `memberStates` when the caller narrows to them (`^72022L2555(DEU|FRA)`).
 *
 * The country code is what anchors the act core on its right-hand side, and it
 * has to be there: a left-anchored `^7{core}` alone also matches a longer act
 * number that merely starts with the same digits, so measures transposing a
 * hypothetical `32016L06801` would be returned as transpositions of
 * `32016L0680`. The trailing measure number is deliberately left
 * unanchored — no digit can extend the act core across three letters, so
 * anchoring it would add false-rejection risk without closing anything.
 * Verified against 3,000 sector-7 CELEX values pulled live from CELLAR: all
 * carry the three-letter code. The codes come from the closed
 * {@link MEMBER_STATE_CODES} set, so no caller character reaches the pattern.
 */
function nationalMeasureCelexPattern(
  sourceActCore: string,
  memberStates?: readonly MemberStateCode[],
): string {
  const memberState = memberStates?.length ? `(${memberStates.join('|')})` : '[A-Z]{3}';
  return `^7${sourceActCore}${memberState}`;
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

/** A relation type and direction whose page ends at CELLAR's sort window (#154). */
export interface RelationWindowEnd {
  /**
   * A ready-to-run SELECT, for the raw SPARQL tool, listing the direction's related
   * works past the page — see {@link continuationQuery}.
   */
  continuationQuery: string;
  direction: 'outgoing' | 'incoming';
  /** Related date of the direction's last row on the page; absent when that row reports none. */
  lastDate?: string;
  relationType: RelationType;
}

/**
 * The SELECT that lists a direction's related works past a page ending at row
 * 10,000, ordered as the page was: the works dated on or before the date the page's
 * last row sorted on (CELLAR's undated placeholder included), newest first, or — when
 * the page ended among the undated works, which sort last — the undated works. Either
 * way the page's own last rows come first again, and nothing past them is skipped.
 *
 * Ungrouped by design: CELLAR evaluates a grouped `MAX` over the date wrongly (see
 * {@link buildRelationQuery}), so a work with several dates or CELEX numbers repeats
 * rather than being aggregated. The CELEX constraint of the relation type carries
 * over, `relatedSectors` included, and so does an `article` filter, so the rows are
 * the ones the traversal would have returned.
 */
function continuationQuery(
  workUri: string,
  predicate: string,
  direction: 'outgoing' | 'incoming',
  lastDate: string | undefined,
  celex?: CelexConstraint,
  article?: ArticleFilter,
  versions?: readonly TreatyVersion[],
): string {
  // Over a version set (#199) the edge reaches any version, and DISTINCT lists a work
  // whose edges reach two of them once per date and CELEX, as without one.
  const sourceTerm = versions ? VERSION_WORK : `<${workUri}>`;
  const [source, target] = edgeEnds(sourceTerm, '?work', direction);
  const edge = `${versions ? `${versionValues(versions)} ` : ''}${source} ${predicate} ${target} .`;
  const select = versions ? 'SELECT DISTINCT' : 'SELECT';
  const celexPattern = `${
    celex
      ? `?work cdm:resource_legal_id_celex ?celex .${celexFilters('?celex', celex)
          .map((filter) => ` ${filter}`)
          .join('')}`
      : 'OPTIONAL { ?work cdm:resource_legal_id_celex ?celex }'
  }${article ? ` ${articleFilterClause(sourceTerm, '?work', predicate, direction, article)}` : ''}`;
  return lastDate
    ? `${select} ?work ?celex ?date WHERE { ${edge} ?work cdm:work_date_document ?date . ${celexPattern} FILTER(?date <= "${lastDate}"^^xsd:date) } ORDER BY DESC(?date) ?work`
    : `${select} ?work ?celex WHERE { ${edge} ${celexPattern} FILTER NOT EXISTS { ?work cdm:work_date_document ?date } } ORDER BY ?work`;
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
 * `memberStates`, when non-empty, narrows `national_transposition` to the measures
 * of those member states by replacing the pattern's any-code segment with their
 * alternation, so paging and `hasMore` count matching measures only. Every other
 * relation type ignores it.
 *
 * `perTypeLimit` bounds each direction of each type; `offset` (below 10,000) pages
 * within a direction. Each query requests one additional grouped row per direction,
 * then removes that private sentinel before returning. `hasMore` is true only when a
 * direction produced that additional row. Near row 10,000 CELLAR's sort window cuts
 * the request (#154): the sentinel, then part of the page, no longer fit, and a
 * direction that fills what the window allows is listed in `windowEnds` with its
 * last related date and the query that continues it — its rows may continue past
 * row 10,000, where no offset reaches.
 *
 * Each relation carries the related work's date — the value its page is ordered
 * by — and its English title (#119), each omitted when the work has none. CELLAR's
 * undated placeholder reads as no date (#184), and no other language stands in for
 * a missing English title.
 *
 * `article` narrows `interpreted_by` to the rulings with a recorded provision in
 * that article ({@link articleLocationPattern}), pushed into the paged query and its
 * window-end continuation; every other type ignores it.
 *
 * `relatedSectors`, when non-empty, keeps the related works whose CELEX opens with
 * one of those sectors, in every type: each arm requires the CELEX and tests its first
 * character before grouping, so paging and `hasMore` count matching works only, and
 * a related work with no CELEX is left out. `national_transposition` is sector 7 by
 * its pattern, so with `7` listed its query is the unfiltered one, and without `7` it
 * returns no rows and sends no query.
 *
 * With `provisions` set, each page row of an annotated type (see
 * {@link RELATION_SPECS}) carries the distinct designators its edge's location
 * axioms record, compacted ({@link compactProvision}) and sorted; a row with none
 * carries no `provisions`. They are read by one follow-up query per annotated type
 * with rows on the page, keyed on those rows (`VALUES`) and ungrouped: a
 * `GROUP_CONCAT` inside the paged query fails once an edge's designators pass
 * about 4 KB (Virtuoso SR319, HTTP 500). The follow-up runs after the page query,
 * so it adds one round-trip to the call; its keys are split into as many requests as
 * CELLAR's body limit needs ({@link chunkKeys}), sent together. A follow-up CELLAR
 * fails, in any of its requests, is reported in `provisionsUnavailable` and the type's
 * rows are returned without provisions; the caller's cancellation still ends the call.
 *
 * `versions`, for a Lisbon treaty article or text (#199), are its versions, the source
 * work among them: every incoming arm but `national_transposition` (a measure's CELEX
 * names the one act it transposes) reads the edges reaching any of them as one arm —
 * one row per related work, paged as one, its provisions read from the versions its
 * edges reach — and each of its rows carries `recordedAgainst`, the CELEX of those
 * versions. `interpretedByVersions` replaces them for `interpreted_by`, which then reads
 * no provision filter: an article's versions on a whole text, or none, when no query
 * is sent. Outgoing arms read the source work alone.
 */
export async function traverseRelations(
  svc: Pick<CellarSparqlService, 'query' | 'queryWithContinuation'>,
  workUri: string,
  types: readonly RelationType[],
  ctx: Context,
  options: {
    article?: ArticleFilter | undefined;
    interpretedByVersions?: readonly TreatyVersion[] | undefined;
    memberStates?: readonly MemberStateCode[] | undefined;
    offset?: number;
    perTypeLimit: number;
    provisions?: boolean;
    relatedSectors?: readonly CelexSector[] | undefined;
    sourceCelex?: string | undefined;
    versions?: readonly TreatyVersion[] | undefined;
  },
): Promise<{
  hasMore: boolean;
  provisionsUnavailable: RelationType[];
  relations: WorkRelation[];
  windowEnds: RelationWindowEnd[];
}> {
  const { article, memberStates, offset = 0, perTypeLimit, relatedSectors, sourceCelex } = options;
  const sectors = relatedSectors?.length ? relatedSectors : undefined;
  const articleFor = (type: RelationType) => (type === 'interpreted_by' ? article : undefined);
  const versionsFor = (type: RelationType): readonly TreatyVersion[] | undefined => {
    if (type === 'interpreted_by' && options.interpretedByVersions) {
      return options.interpretedByVersions;
    }
    return readsIncoming(type) && type !== 'national_transposition' ? options.versions : undefined;
  };
  const sourceActCore = sourceCelex ? celexActCore(sourceCelex) : undefined;
  const fetchLimit = windowedLimit(offset, perTypeLimit);
  const perType = await Promise.all(
    types.map(
      async (
        type,
      ): Promise<{
        type: RelationType;
        bindings: SparqlBinding[];
        celex?: CelexConstraint;
        versions?: readonly TreatyVersion[];
      }> => {
        const versions = versionsFor(type);
        if (versions?.length === 0) return { type, bindings: [] };
        /**
         * Push relation-specific CELEX validity into the query before pagination:
         * sector-7 same-act national measures, the caller's sectors, and CELEX-bearing
         * consolidations.
         */
        let celex: CelexConstraint | undefined;
        if (type === 'national_transposition') {
          // With no source act core there is no pattern that selects this act's
          // implementing measures, and every row is dropped either way; nor without
          // sector 7 among the caller's sectors, since every measure is sector 7. Return
          // the empty result directly rather than spending a CELLAR round-trip on a
          // query whose filter can match nothing.
          if (!sourceActCore || (sectors && !sectors.includes('7'))) return { type, bindings: [] };
          celex = { pattern: nationalMeasureCelexPattern(sourceActCore, memberStates) };
        } else if (sectors) {
          celex = { sectors };
        } else if (type === 'consolidated_version') {
          celex = {};
        }
        return {
          type,
          bindings: await svc.queryWithContinuation(
            buildRelationQuery(
              workUri,
              RELATION_SPECS[type],
              fetchLimit,
              offset,
              celex,
              articleFor(type),
              versions,
            ),
            ctx,
          ),
          ...(celex ? { celex } : {}),
          ...(versions ? { versions } : {}),
        };
      },
    ),
  );

  const nationalMeasureRe = sourceActCore
    ? new RegExp(nationalMeasureCelexPattern(sourceActCore, memberStates))
    : undefined;
  const relations: WorkRelation[] = [];
  const windowEnds: RelationWindowEnd[] = [];
  const pageRowsByType = new Map<RelationType, WorkRelation[]>();
  let hasMore = false;
  for (const { type, bindings, celex, versions } of perType) {
    const versionCelex = new Map(versions?.map((version) => [version.workUri, version.celex]));
    // Each row beside the date its page sorted it on, CELLAR's undated placeholder
    // included: the row reports a real date alone, and a window end continues from
    // the sort date.
    const rowsByDirection = new Map<
      'outgoing' | 'incoming',
      { row: Omit<WorkRelation, 'direction'>; sortDate: string | undefined }[]
    >();
    // Rows CELLAR returned per direction, before the client-side re-checks: the
    // window is reached by what the query read, not by what survived them.
    const fetchedByDirection = new Map<'outgoing' | 'incoming', number>();
    const seenForType = new Set<string>();
    for (const b of bindings) {
      const relatedWorkUri = CellarSparqlService.bindingValue(b, 'relatedWork') ?? '';
      const direction =
        CellarSparqlService.bindingValue(b, 'direction') === 'incoming' ? 'incoming' : 'outgoing';
      fetchedByDirection.set(direction, (fetchedByDirection.get(direction) ?? 0) + 1);
      const relatedCelex = CellarSparqlService.bindingValue(b, 'relatedCelexSample');
      const sortDate = CellarSparqlService.bindingValue(b, 'relatedDateMax')?.slice(0, 10);
      const relatedDate = cellarDate(sortDate);
      const relatedTitle = CellarSparqlService.bindingValue(b, 'relatedTitleMax');
      // The version works the grouped incoming row's edges reach, as their CELEX.
      const recordedAgainst = [
        ...new Set(
          (CellarSparqlService.bindingValue(b, 'recordedAgainst') ?? '')
            .split(' ')
            .flatMap((versionWork) => versionCelex.get(versionWork) ?? []),
        ),
      ].toSorted();

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
        row: {
          relationType: type,
          relatedWorkUri,
          ...(relatedCelex ? { relatedCelexNumber: relatedCelex } : {}),
          ...(relatedMemberState ? { relatedMemberState } : {}),
          ...(relatedDate ? { relatedDate } : {}),
          ...(relatedTitle ? { relatedTitle } : {}),
          ...(recordedAgainst.length > 0 ? { recordedAgainst } : {}),
        },
        sortDate,
      });
      rowsByDirection.set(direction, rows);
    }

    for (const [direction, rows] of rowsByDirection) {
      if (rows.length > perTypeLimit) hasMore = true;
      const kept = rows.slice(0, perTypeLimit);
      const page = kept.map(({ row }) => ({ ...row, direction }));
      relations.push(...page);
      pageRowsByType.set(type, [...(pageRowsByType.get(type) ?? []), ...page]);
      const fetched = fetchedByDirection.get(direction) ?? 0;
      if (readWindowedPage(fetched, offset, perTypeLimit).atWindowEnd) {
        // A page ending among placeholder-dated works continues through them, bounded
        // by the placeholder; reporting no date must not send it to the undated works.
        const lastSortDate = kept.at(-1)?.sortDate;
        const lastDate = cellarDate(lastSortDate);
        windowEnds.push({
          relationType: type,
          direction,
          ...(lastDate ? { lastDate } : {}),
          continuationQuery: continuationQuery(
            workUri,
            RELATION_SPECS[type].predicate,
            direction,
            lastSortDate,
            celex,
            articleFor(type),
            direction === 'incoming' ? versions : undefined,
          ),
        });
      }
    }
  }

  const provisionsUnavailable: RelationType[] = [];
  if (options.provisions) {
    await Promise.all(
      [...pageRowsByType]
        .filter(([type]) => RELATION_SPECS[type].annotated)
        .map(async ([type, rows]) => {
          let byWork: Map<string, string[]>;
          try {
            byWork = await readProvisions(svc, workUri, type, rows, ctx, versionsFor(type));
          } catch (error) {
            // Best effort: rows stay, without provisions, and the type is reported.
            // Cancellation and anything that is not a CELLAR failure still end the call.
            if (ctx.signal.aborted || !(error instanceof McpError)) throw error;
            ctx.log.warning('Provisions follow-up failed; rows returned without them', {
              relationType: type,
              error: error.message,
            });
            provisionsUnavailable.push(type);
            return;
          }
          for (const row of rows) {
            const provisions = byWork.get(row.relatedWorkUri);
            if (provisions) row.provisions = provisions;
          }
        }),
    );
  }
  return { relations, hasMore, windowEnds, provisionsUnavailable };
}

/** One member state's national implementing measures of an act. */
export interface MemberStateTransposition {
  /** Newest document date among the measures (YYYY-MM-DD); absent when none has a real one. */
  latestDate?: string;
  /** Distinct measures whose CELEX carries this code after the act core. */
  measures: number;
  /** The three-letter code the measures' CELEX carries after the act core. */
  memberState: string;
}

/** An act's national transposition tallied per member state, or CELLAR's failure to give it. */
export type TranspositionSummary =
  | {
      /** Every code with at least one measure, sorted. */
      byMemberState: MemberStateTransposition[];
      status: 'summarized';
      /** The codes in scope with no measure, sorted. */
      withoutMeasures: string[];
    }
  | { status: 'unavailable' };

/** The 27 current member states: every code a sector-7 CELEX carries but the United Kingdom's. */
const CURRENT_MEMBER_STATES = MEMBER_STATE_CODES.filter((code) => code !== 'GBR');

/** Prefix of the IRI each member state's group is keyed on (see {@link summarizeTransposition}). */
const MEMBER_STATE_KEY = 'urn:member-state:';

/**
 * Tally the national implementing measures of the act `sourceCelex` names per member
 * state, in one grouped query over the same pushed CELEX pattern its
 * `national_transposition` rows page through, `memberStates` included: each state's
 * distinct measures and their newest document date, and the states in scope with
 * none — the `memberStates` filter, or else the 27 current member states.
 *
 * The group key is an IRI built from the code after the act core, never that code
 * as a computed string: CELLAR splits a computed-string GROUP BY key into several
 * groups by the length of the CELEX it came from (NIS2's CZE measures came back as
 * groups of 27 and 56, its HUN measures as 4 and 36). The date aggregates as
 * `MAX(STR(?date))`, as the paged query's does, so each state's `latestDate` is the
 * `relatedDate` of its first row. CELLAR's undated placeholder is its earliest date, so
 * the aggregate returns it only when no measure of the state has a real date, and it
 * is then dropped as on rows; the `measures` count includes every measure either way.
 *
 * Returns `undefined` without a query when the CELEX carries no act core, and
 * `undefined` when no member state in scope has a measure. A CELLAR failure returns
 * `unavailable`, for the caller to serve its page without the summary; cancellation
 * and anything that is not a CELLAR failure still end the call.
 */
export async function summarizeTransposition(
  svc: Pick<CellarSparqlService, 'query'>,
  workUri: string,
  sourceCelex: string | undefined,
  memberStates: readonly MemberStateCode[] | undefined,
  ctx: Context,
): Promise<TranspositionSummary | undefined> {
  const sourceActCore = sourceCelex ? celexActCore(sourceCelex) : undefined;
  if (!sourceActCore) return;
  const query = `SELECT ?memberState (COUNT(DISTINCT ?measure) AS ?measures) (MAX(STR(?date)) AS ?latestDate) WHERE {
  ?measure cdm:measure_national_implementing_implements_resource_legal <${workUri}> .
  ?measure cdm:resource_legal_id_celex ?celex .
  FILTER(REGEX(STR(?celex), "${nationalMeasureCelexPattern(sourceActCore, memberStates)}"))
  BIND(IRI(CONCAT("${MEMBER_STATE_KEY}", SUBSTR(STRAFTER(STR(?celex), "7${sourceActCore}"), 1, 3))) AS ?memberState)
  OPTIONAL { ?measure cdm:work_date_document ?date . }
} GROUP BY ?memberState`;
  let bindings: SparqlBinding[];
  try {
    bindings = await svc.query(query, ctx);
  } catch (error) {
    if (ctx.signal.aborted || !(error instanceof McpError)) throw error;
    ctx.log.warning('Transposition summary failed; page returned without it', {
      error: error.message,
    });
    return { status: 'unavailable' };
  }
  const byMemberState: MemberStateTransposition[] = [];
  for (const binding of bindings) {
    const key = CellarSparqlService.bindingValue(binding, 'memberState');
    const measures = Number(CellarSparqlService.bindingValue(binding, 'measures'));
    if (!key?.startsWith(MEMBER_STATE_KEY) || !Number.isInteger(measures)) continue;
    const latestDate = cellarDate(
      CellarSparqlService.bindingValue(binding, 'latestDate')?.slice(0, 10),
    );
    byMemberState.push({
      memberState: key.slice(MEMBER_STATE_KEY.length),
      measures,
      ...(latestDate ? { latestDate } : {}),
    });
  }
  if (byMemberState.length === 0) return;
  byMemberState.sort((a, b) => a.memberState.localeCompare(b.memberState));
  const present = new Set(byMemberState.map((entry) => entry.memberState));
  return {
    status: 'summarized',
    byMemberState,
    withoutMeasures: (memberStates ?? CURRENT_MEMBER_STATES)
      .filter((code) => !present.has(code))
      .toSorted(),
  };
}

/** CELLAR refuses a SPARQL POST body over this many bytes, form-encoded (HTTP 403). */
const CELLAR_BODY_LIMIT_BYTES = 8192;

/**
 * The longest source CELEX and work URI a traversal is sent for. No CELLAR work holds
 * a longer one — its longest CELEX has 27 characters, its work URIs 82 (2026-11-14) —
 * and every query built from them stays within {@link CELLAR_BODY_LIMIT_BYTES}.
 */
export const SOURCE_CELEX_MAX_LENGTH = 100;
export const SOURCE_WORK_URI_MAX_LENGTH = 256;

/**
 * Room each body keeps for what the service sends around a query: the `query=` key,
 * its PREFIX block, and the results-format field, 271 encoded bytes (2026-11-14).
 */
const SERVICE_BODY_ALLOWANCE_BYTES = 512;

/**
 * The bytes `text` takes form-encoded, as the service posts a query. Encoding is per
 * character, so the size of a concatenation is the sum of its parts' sizes.
 */
function encodedBytes(text: string): number {
  return new URLSearchParams({ q: text }).toString().length - 'q='.length;
}

/**
 * `keys` split, in order, into the fewest runs whose query `queryFor` builds fits
 * CELLAR's body limit, each key counted at its encoded `<…>` and separating space.
 */
function chunkKeys(
  keys: readonly string[],
  queryFor: (chunk: readonly string[]) => string,
): string[][] {
  const budget =
    CELLAR_BODY_LIMIT_BYTES - SERVICE_BODY_ALLOWANCE_BYTES - encodedBytes(queryFor([]));
  const chunks: string[][] = [];
  let chunk: string[] = [];
  let size = 0;
  for (const key of keys) {
    const cost = encodedBytes(` <${key}>`);
    if (chunk.length > 0 && size + cost > budget) {
      chunks.push(chunk);
      chunk = [];
      size = 0;
    }
    chunk.push(key);
    size += cost;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

/**
 * The compacted, de-duplicated, sorted designators each page row of an annotated
 * type records, by related work URI: ungrouped queries keyed on the rows, split so
 * each request fits CELLAR's body limit and sent together. Only a URI the IRI guard
 * accepts is keyed; CELLAR's own work URIs always pass. With `versions`, the axioms
 * are those of the edges reaching any version, each designator read from the version
 * its edge targets. Every request settles before a failure among them is thrown.
 */
async function readProvisions(
  svc: Pick<CellarSparqlService, 'query'>,
  workUri: string,
  type: RelationType,
  rows: readonly WorkRelation[],
  ctx: Context,
  versions?: readonly TreatyVersion[],
): Promise<Map<string, string[]>> {
  const keys = [...new Set(rows.map((row) => row.relatedWorkUri))].filter(isSafeSparqlIri);
  if (keys.length === 0) return new Map();
  const { predicate, direction } = RELATION_SPECS[type];
  // Annotated types are one-directional by construction.
  const [source, target] = edgeEnds(
    versions ? VERSION_WORK : `<${workUri}>`,
    '?relatedWork',
    direction as 'outgoing' | 'incoming',
  );
  const versionBlock = versions ? `${versionValues(versions)} ` : '';
  const queryFor = (chunk: readonly string[]) =>
    `SELECT DISTINCT ?relatedWork ?location WHERE { ${iriValues('?relatedWork', chunk)} ${versionBlock}${locationAxiom('?axiom', source, predicate, target, '?location')} }`;
  const settled = await Promise.allSettled(
    chunkKeys(keys, queryFor).map((chunk) => svc.query(queryFor(chunk), ctx)),
  );
  const failed = settled.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
  const bindings = settled.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
  const sets = new Map<string, Set<string>>();
  for (const binding of bindings) {
    const work = CellarSparqlService.bindingValue(binding, 'relatedWork');
    const location = CellarSparqlService.bindingValue(binding, 'location');
    if (!work || location === undefined) continue;
    const set = sets.get(work) ?? new Set<string>();
    set.add(compactProvision(location));
    sets.set(work, set);
  }
  return new Map([...sets].map(([work, set]) => [work, [...set].sort()]));
}
