/**
 * @fileoverview eurlex_get_relations — Traverse the CELLAR CDM relationship graph for a work.
 * @module mcp-server/tools/definitions/eurlex-get-relations
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { echoValue } from '@/mcp-server/tools/echo-value.js';
import { enumInput } from '@/mcp-server/tools/enum-input.js';
import {
  clampLimit,
  limitClampEnrichment,
  limitClampTrailer,
  ROW_LIMIT_CEILING,
} from '@/mcp-server/tools/limit-clamp.js';
import { renderNoticeBlockquote } from '@/mcp-server/tools/markdown-render.js';
import {
  CellarSparqlService,
  getCellarSparqlService,
} from '@/services/cellar-sparql/cellar-sparql-service.js';
import {
  CELEX_PATTERN,
  celexOfAliasUri,
  isSafeSparqlIri,
  normalizeCelex,
  normalizeWorkUri,
} from '@/services/cellar-sparql/eli-resolution.js';
import {
  ARTICLE_INPUT_PATTERN,
  articleLabel,
  DEFAULT_PER_TYPE_LIMIT,
  MEMBER_STATE_CODES,
  parseArticle,
  RELATION_TYPES,
  type RelationType,
  toMemberStateCode,
  traverseRelations,
} from '@/services/cellar-sparql/relation-traversal.js';
import { isPastSortWindow, SORT_WINDOW } from '@/services/cellar-sparql/sort-window.js';
import type { WorkRelation } from '@/services/cellar-sparql/types.js';
import { resolveCelexWorks } from '@/services/cellar-sparql/work-resolution.js';

/** The tool's domain output, before framework enrichment. */
const RelationsOutputSchema = z.object({
  celex_number: z
    .string()
    .optional()
    .describe(
      'CELEX number of the source work whose relations were traversed — the celex_number input, or the CELEX resolved from work_uri when the addressed work carries exactly one. Absent when the addressed work carries none, carries several, or its identity was not resolved because no requested relation type needs it.',
    ),
  work_uri: z
    .string()
    .describe('CELLAR URI of the source work (the work_uri input, or resolved from the CELEX).'),
  relations: z
    .array(
      z
        .object({
          relation_type: z
            .string()
            .describe(
              'Type of relation: cites, amends, amended_by, repeals, repealed_by, implicitly_repeals, implicitly_repealed_by, legal_basis, basis_for, interprets, interpreted_by, consolidated_version, national_transposition, adopts, adopted_by.',
            ),
          direction: z
            .string()
            .describe(
              'Direction: "outgoing" (this work → related) or "incoming" (related → this work).',
            ),
          related_work_uri: z.string().describe('CELLAR URI of the related work.'),
          related_celex_number: z
            .string()
            .optional()
            .describe('CELEX number of the related work, if available.'),
          related_member_state: z
            .string()
            .optional()
            .describe(
              'ISO 3166-1 alpha-3 code of the member state whose national measure this is (e.g. "CZE"), read from the three letters after the directive number in related_celex_number. Present on national_transposition rows only. The codes are the 27 member states plus "GBR" (the United Kingdom).',
            ),
          related_date: z
            .string()
            .optional()
            .describe(
              'Document date of the related work (YYYY-MM-DD), the date rows are ordered by within each relation type and direction. Absent when CELLAR records none; such rows sort last.',
            ),
          related_title: z
            .string()
            .optional()
            .describe(
              "The related work's English title, whole. Absent when the work has no English title — most national_transposition measures are titled only in their member state's language — with no other language substituted.",
            ),
          provisions: z
            .array(z.string())
            .optional()
            .describe(
              "The provisions CELLAR records this edge as targeting, distinct and sorted. They belong to the edge's object: this act on an incoming row (the articles a ruling interprets, the provisions an amending act changes), the related work on an outgoing one. Read for amends, amended_by, repeals, repealed_by, implicitly_repeals, implicitly_repealed_by, interprets, interpreted_by, adopts, and adopted_by; absent on other types and on an edge CELLAR records no provision for, which does not mean the edge reaches the whole act. Compact codes read A article, P paragraph, L point letter or subparagraph number, PT numbered point, T indent, and BIS/TER/QUATER… the Latin ordinal of a lettered article (A17P1LC is Article 17(1)(c), A28QUATER Article 28c). Authority codes precede numbers, each {CODE|URI} token written as its CODE: AR article, PA paragraph, PO or PTA point, AN annex, ALN unnumbered paragraph, TIRE indent, CHA chapter, TXT text (AR 43 PA 4 is Article 43(4)).",
            ),
          provisions_withheld: z
            .number()
            .int()
            .optional()
            .describe(
              'How many provisions this row has but does not carry: withheld whole, largest row first, to keep a one-row-per-direction page within 64,000 UTF-8 bytes per surface, and named in the notice. Name fewer relation_types to receive them. Absent when nothing was withheld.',
            ),
        })
        .describe('A single CDM relation between the source work and a related work.'),
    )
    .describe('Direct CDM relations for the requested work.'),
  total: z
    .number()
    .describe('Number of relations returned in this page (not a corpus-wide count).'),
  offset: z
    .number()
    .describe('Pagination offset applied to this response (per relation type and direction).'),
  has_more: z
    .boolean()
    .describe(
      'True when an additional valid row or a response-budget cut proves at least one requested relation type/direction has more rows. False on a retained page that ends at row 10,000, the last one CELLAR sorts; its notice names the types and directions that reached it.',
    ),
  next_offset: z
    .number()
    .optional()
    .describe(
      'Offset plus the applied per-type/direction depth after any response-budget cut. Present only when has_more is true; use this value to continue without skipping withheld rows.',
    ),
  requested_relation_types: z
    .array(z.string())
    .describe(
      'The relation types this request traversed — the explicit relation_types list, or all types when it was omitted. Diff against the types present in relations[], or read empty_relation_types, to confirm which requested types returned edges.',
    ),
  member_states: z
    .array(z.string())
    .optional()
    .describe(
      'The member states national_transposition rows were narrowed to, as ISO 3166-1 alpha-3 codes, normalized from member_states and de-duplicated. Absent when no member_states filter was given.',
    ),
  article: z
    .string()
    .optional()
    .describe(
      'The article interpreted_by rows were narrowed to, normalized from the article input: the number without a prefix or leading zeros, any letter in lower case (17, 28c). Absent when no article filter was given.',
    ),
  empty_relation_types: z
    .array(z.string())
    .describe(
      'Requested relation types that returned zero relations in THIS page. Page-scoped: a type can appear here because all its edges sit beyond the current offset/limit window, not only because the act genuinely has none of that relation — so absent-from-here does not prove absent-in-CELLAR. An empty page — a first page with no edges, or an exhausted later page — returns all requested types here.',
    ),
});

type RelationsPage = z.infer<typeof RelationsOutputSchema>;

/**
 * The same renderers measure and emit every enrichment trailer byte. The notice
 * quotes CELEX numbers, work URIs, and SPARQL continuations, so it is escaped as
 * text and each of its lines kept in the blockquote.
 */
const relationTrailers = {
  limit_clamp: limitClampTrailer,
  truncated: { render: (value: boolean | undefined) => `**truncated:** ${value}` },
  shown: { render: (value: number | undefined) => `**shown:** ${value}` },
  cap: { render: (value: number | undefined) => `**cap:** ${value}` },
  notice: { render: (value: string | undefined) => renderNoticeBlockquote(value ?? '') },
};

/**
 * `escapeMarkdownInline` remembered for one call. The budget search re-renders the
 * page at every candidate depth, and titles run to tens of kilobytes, so escaping
 * each distinct string once keeps the search's cost in serialization alone.
 */
function memoizedEscape(): (text: string) => string {
  const escaped = new Map<string, string>();
  return (text) => {
    let value = escaped.get(text);
    if (value === undefined) {
      value = escapeMarkdownInline(text);
      escaped.set(text, value);
    }
    return value;
  };
}

const relationEnrichment = {
  truncated: z
    .boolean()
    .optional()
    .describe(
      'True when an additional valid row proves at least one relation type/direction has more related works — page with offset.',
    ),
  shown: z
    .number()
    .optional()
    .describe(
      'Number of relations returned in this page, summed across every relation type and direction — not the count for any single type or direction.',
    ),
  cap: z
    .number()
    .optional()
    .describe(
      'The per-direction cap. It bounds each relation type and each direction independently, so it is not an upper bound on shown: a page spanning several types and both directions can return more relations than this number.',
    ),
  notice: z
    .string()
    .optional()
    .describe(
      'Guidance for the next call: on an empty first page, how to widen the traversal; on a first page where member_states matched no national_transposition measures, the codes it named; with article, that interpreted_by leaves out rulings CELLAR records no provision for, or on a first page with none, the article it named; on a page with more rows, the offset to continue from; on a page ending at row 10,000, the relation types and directions that reached it, each with a ready-to-run eurlex_query_sparql query listing its older works; the rows whose provisions were withheld to fit the response budget, and the relation types whose provisions CELLAR did not return.',
    ),
  limit_clamp: limitClampEnrichment,
};

type RelationsEnrichment = z.infer<z.ZodObject<typeof relationEnrichment>>;

/** Budget each serialized final surface independently, including the framework trailer. */
function fitsRelationBudget(
  page: RelationsPage,
  enrichment: RelationsEnrichment,
  md: (text: string) => string,
): boolean {
  const lines: string[] = [];
  if (enrichment.limit_clamp)
    lines.push(relationTrailers.limit_clamp.render(enrichment.limit_clamp));
  if (enrichment.truncated !== undefined)
    lines.push(relationTrailers.truncated.render(enrichment.truncated));
  if (enrichment.shown !== undefined) lines.push(relationTrailers.shown.render(enrichment.shown));
  if (enrichment.cap !== undefined) lines.push(relationTrailers.cap.render(enrichment.cap));
  if (enrichment.notice !== undefined) lines.push(renderNoticeBlockquote(enrichment.notice, md));
  const content = [
    ...renderRelationsPage(page, md),
    ...(lines.length ? [{ type: 'text', text: `\n\n${lines.join('\n')}` }] : []),
  ];
  return (
    Buffer.byteLength(JSON.stringify({ ...page, ...enrichment }), 'utf8') <= 64_000 &&
    Buffer.byteLength(JSON.stringify(content), 'utf8') <= 64_000
  );
}

export const eurlex_get_relations = tool('eurlex_get_relations', {
  title: 'Get CELLAR Relationship Graph',
  description:
    'Traverse the one-hop CDM relationship graph of an EU act: what it amends or is amended by, what it repeals or is repealed by (explicit and implicit), its consolidated versions, national transposition measures, its legal basis and the works adopted under it, the proposal it adopts (or, for a proposal, the act that adopted it), the CJEU rulings interpreting it (or, for a ruling, the acts it interprets), and works that cite it. Amendment, repeal, interpretation, and adoption rows carry the provisions CELLAR records each edge as targeting, and article narrows interpreted_by to the rulings on one article. Returns direct relations only, paginated per relation type and direction. Requires a CELEX number or CELLAR work URI.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    celex_number: z
      .union([
        z.literal(''),
        z
          .string()
          .overwrite(normalizeCelex)
          .regex(
            CELEX_PATTERN,
            'celex_number must be a CELEX identifier — a sector character followed by the year, type letters, and number (e.g. 32016R0679). Resolve a citation to its CELEX with eurlex_lookup_celex first.',
          )
          .describe(
            'CELEX number of the work (e.g. 32016R0679). Surrounding whitespace is trimmed and the value is uppercased before validation.',
          ),
      ])
      .optional()
      .describe(
        'CELEX number of the work to traverse (e.g. 32016R0679). Provide exactly one of celex_number or work_uri.',
      ),
    work_uri: z
      .string()
      .overwrite(normalizeWorkUri)
      .refine((v) => !v || isSafeSparqlIri(v), {
        message:
          'work_uri must be an http URI with no whitespace, control characters, or any of < > " { } | ^ ` \\.',
      })
      .optional()
      .describe(
        'CELLAR work resource URI to traverse (e.g. http://publications.europa.eu/resource/cellar/3e485e15-11bd-11e6-ba9a-01aa75ed71a1). Used directly as the addressed work; its CELEX identity is resolved for the national_transposition act match, which stands down when the work carries several CELEX numbers — address such a work by celex_number to name the act you mean. Provide exactly one of celex_number or work_uri.',
      ),
    relation_types: z
      .array(enumInput(RELATION_TYPES, z.enum([...RELATION_TYPES])))
      .optional()
      .describe(
        'Subset of relation types to return; omit for all fifteen, equivalent to listing them explicitly. Types: cites, amends, amended_by, repeals, repealed_by, implicitly_repeals, implicitly_repealed_by, legal_basis (treaty/article this act rests on), basis_for (works naming this act among their legal bases — implementing and delegated acts, decisions, Parliament resolutions, drafts; the incoming side of legal_basis), interprets (for a ruling: the acts it interprets), interpreted_by (CJEU and General Court rulings interpreting this act; the incoming side of interprets), consolidated_version (consolidated texts of this act), national_transposition (member-state implementing measures), adopts (the works this act adopts — usually its Commission proposal, also an international agreement its concluding decision adopts or a joint-committee decision; tell them apart by CELEX), adopted_by (the act that adopted this work; the incoming side of adopts). Whole rows, titles, and provisions are kept within a 64,000 UTF-8 byte budget per complete response surface by lowering the common per-type/direction depth, never below 1; a depth-1 page still over it has the provisions of its rows withheld whole, largest first (counted in provisions_withheld), and is then returned whole with disclosure. Name only the types you need to reduce the response.',
      ),
    member_states: z
      .array(
        z
          .string()
          .refine((value) => toMemberStateCode(value) !== undefined, {
            message: `member_states takes member-state codes: ISO 3166-1 alpha-3 (${MEMBER_STATE_CODES.join(', ')}; GBR is the United Kingdom) or the two-letter codes (DE, FR; EL or GR for Greece, UK or GB for the United Kingdom), in any case.`,
          })
          .describe(
            'A member state as its ISO 3166-1 alpha-3 code (DEU, GRC, GBR for the United Kingdom) or two-letter code (DE; EL or GR for Greece; UK or GB), in any case.',
          ),
      )
      .optional()
      .describe(
        'Narrow national_transposition rows to the measures of these member states — the 27 member states plus the United Kingdom, by alpha-3 or two-letter code, in any case. Paging, has_more, and next_offset then count matching measures only; other relation types are unaffected. With an explicit relation_types, include national_transposition. An empty list is the same as omitting it.',
      ),
    article: z
      .string()
      .regex(
        ARTICLE_INPUT_PATTERN,
        'article takes an article number with at most one letter — 17, 6a, "Article 17", "Art. 17" — not a paragraph (17(1)), a range (17-18), or a Roman numeral (XVII).',
      )
      .optional()
      .describe(
        'Narrow interpreted_by to the rulings with a recorded provision in this article of the act: an article number with at most one letter (17, 6a), optionally prefixed "Article", "Art." or "Art", in any case. The article matches at any depth (17 matches provisions recorded in Article 17(1)(c)), leading zeros are ignored, and a letter also matches its Latin ordinal (28c matches Article 28 quater). Rulings CELLAR records no provision for are left out. Paging, has_more, and next_offset then count matching rulings only; other relation types are unaffected. With an explicit relation_types, include interpreted_by. A blank value is the same as omitting it.',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Pagination offset applied per relation type and direction — related works to skip (default 0). Continue at the returned next_offset, which adds the applied depth after any response-budget cut; incoming edges are newest-first, so higher offsets reach older works. Must be below 10,000: CELLAR sorts at most 10,000 related works per type and direction, so pages stop at row 10,000.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(ROW_LIMIT_CEILING)
      .default(100)
      .describe(
        'Maximum related works per relation type and direction, served up to 100 per call (default 100); a larger value (up to 10,000) is served at 100 and reported in limit_clamp. A response-budget cut can lower the common depth further to fit each complete surface within 64,000 UTF-8 bytes, never below 1; the notice reports requested/applied limits and withheld rows. Incoming edges are newest-first. Continue at next_offset for older works; narrow relation_types or lower limit for a smaller response.',
      ),
  }),
  output: RelationsOutputSchema,

  enrichment: relationEnrichment,
  enrichmentTrailer: relationTrailers,

  errors: [
    {
      reason: 'offset_past_window',
      code: JsonRpcErrorCode.ValidationError,
      when: 'offset is 10,000 or more, past the last row CELLAR sorts for one relation type and direction.',
      recovery:
        'Page from an offset below 10,000; the page that reaches row 10,000 gives, for each relation type and direction it ends, a ready-to-run eurlex_query_sparql query listing the older related works.',
    },
    {
      reason: 'invalid_identifier_args',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Neither celex_number nor work_uri was provided, or both were.',
      recovery: 'Provide exactly one of celex_number or work_uri.',
    },
    {
      reason: 'member_states_not_applicable',
      code: JsonRpcErrorCode.ValidationError,
      when: 'member_states was given with a relation_types list that does not include national_transposition, the only type it filters.',
      recovery:
        'Add national_transposition to relation_types, omit relation_types to traverse every type, or drop member_states.',
    },
    {
      reason: 'article_not_applicable',
      code: JsonRpcErrorCode.ValidationError,
      when: 'article was given with a relation_types list that does not include interpreted_by, the only type it filters.',
      recovery:
        'Add interpreted_by to relation_types, omit relation_types to traverse every type, or drop article.',
    },
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The CELEX number, given directly or as a resource/celex/ work URI, is not found in CELLAR — resolve the identifier with eurlex_lookup_celex first.',
      recovery: 'Use eurlex_lookup_celex to confirm the CELEX number exists, then retry.',
    },
    {
      reason: 'sparql_error',
      code: JsonRpcErrorCode.ValidationError,
      when: 'CELLAR rejected a query this traversal sent. The same call fails the same way again.',
      recovery:
        'Name fewer types in relation_types to isolate the one CELLAR rejects, or list that relation with eurlex_query_sparql.',
      thrownBy: 'service',
    },
    {
      reason: 'sparql_timeout',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'A query this traversal sent ran past the client timeout, or CELLAR refused it as too costly to run. It is not retried.',
      recovery:
        'Name only the relation types you need in relation_types, or lower limit, then call again; every type on a heavily linked act is the heaviest call.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx): Promise<RelationsPage> {
    if (isPastSortWindow(input.offset)) {
      throw ctx.fail(
        'offset_past_window',
        `offset ${input.offset} is past row 10,000, the last row CELLAR sorts for one relation type and direction, so no page starts there.`,
      );
    }
    const svc = getCellarSparqlService();
    const requestedTypes: readonly RelationType[] = input.relation_types ?? RELATION_TYPES;

    // Normalize to the three-letter codes a sector-7 CELEX carries; the schema has
    // already rejected anything that names no member state. An empty list is absent.
    const memberStates = input.member_states?.length
      ? [...new Set(input.member_states.flatMap((value) => toMemberStateCode(value) ?? []))]
      : undefined;
    // A filter on a type the call does not traverse would read as applied.
    if (memberStates && !requestedTypes.includes('national_transposition')) {
      throw ctx.fail(
        'member_states_not_applicable',
        `member_states narrows national_transposition, which relation_types (${requestedTypes.join(', ')}) does not include.`,
      );
    }
    // The schema admitted only an article number and letter; a blank value is absent.
    const article = input.article === undefined ? undefined : parseArticle(input.article);
    if (article && !requestedTypes.includes('interpreted_by')) {
      throw ctx.fail(
        'article_not_applicable',
        `article narrows interpreted_by, which relation_types (${requestedTypes.join(', ')}) does not include.`,
      );
    }

    // Accept exactly one identifier. Treat empty/whitespace as absent so
    // form-based clients sending "" for an omitted field hit the friendly guard.
    // A `resource/celex/{CELEX}` alias work_uri is `owl:sameAs` its work, not a work
    // with edges of its own, so it is traversed as the CELEX it names (#147).
    const celexInput = input.celex_number?.trim();
    const workUriGiven = input.work_uri?.trim();
    const aliasCelex = workUriGiven && !celexInput ? celexOfAliasUri(workUriGiven) : undefined;
    const celexNumber = celexInput || aliasCelex;
    const workUriInput = aliasCelex ? undefined : workUriGiven;

    // Step 1: Determine the source work URI. A work_uri is the CELLAR work
    // resource directly — use it as-is, skipping the CELEX→work resolution that
    // would otherwise throw not_found before the URI could be used. A
    // celex_number is resolved to its work first.
    let workUri: string;
    let sourceCelexNumber = celexNumber;
    if (workUriInput && !celexNumber) {
      workUri = workUriInput;
      /**
       * Establish the addressed work's CELEX identity, which gates the
       * `national_transposition` act-core constraint. Two rows are requested
       * rather than one so an ambiguous identity is detectable: a CELLAR work can
       * carry many CELEX values — a national implementing measure holds one per
       * directive it transposes, dozens in practice — and there is no principled
       * basis for choosing among them. Picking the first would silently constrain
       * the traversal to an arbitrary act, so an ambiguous work supplies no source
       * CELEX at all and `national_transposition` returns nothing rather than
       * measures selected against an act the caller never named.
       *
       * Only `national_transposition` consumes that identity, so the lookup runs
       * only when it was requested — a traversal of any other type spends no
       * CELLAR round-trip on it.
       */
      if (requestedTypes.includes('national_transposition')) {
        const sourceIdentitySparql = `
SELECT ?sourceCelex WHERE {
  <${workUri}> cdm:resource_legal_id_celex ?sourceCelex .
} ORDER BY ?sourceCelex LIMIT 2`;

        const sourceIdentityBindings = await svc.query(sourceIdentitySparql, ctx);
        const sourceCelexValues = [
          ...new Set(
            sourceIdentityBindings
              .map((b) => CellarSparqlService.bindingValue(b, 'sourceCelex'))
              .filter((value): value is string => !!value),
          ),
        ];
        sourceCelexNumber = sourceCelexValues.length === 1 ? sourceCelexValues[0] : undefined;
        if (sourceCelexValues.length > 1) {
          ctx.log.info('Work carries several CELEX identifiers; act-core constraint stands down', {
            workUri,
            sourceCelexValues,
          });
        }
      }
    } else if (celexNumber && !workUriInput) {
      // A CELEX held by several works resolves to its canonical work (#97), so the
      // traversal never runs on a copy that lacks edges.
      const resolved = (await resolveCelexWorks(svc, [celexNumber], ctx)).get(celexNumber);
      if (!resolved) {
        throw ctx.fail('not_found', `No CELLAR work found for CELEX: ${echoValue(celexNumber)}`);
      }
      workUri = resolved;
    } else {
      throw ctx.fail(
        'invalid_identifier_args',
        celexNumber
          ? 'Provide only one of celex_number or work_uri, not both.'
          : 'Provide either celex_number or work_uri.',
      );
    }

    // Step 2: Traverse the requested relation types. Each type is resolved
    // through its own query (with its own per-direction LIMIT + OFFSET), run
    // concurrently, so a high-volume type (e.g. cites) can't starve the rarer
    // ones under a shared cap. The predicate + direction model lives in
    // relation-traversal.ts. Clamp the per-direction cap to the service ceiling
    // (MAX_SPARQL_RESULTS) up front so both sides of a symmetric query stay
    // capped consistently — the symmetric UNION has no outer LIMIT and the
    // internal query path passes its per-arm subselect LIMITs through unchanged.
    const perDirectionLimit = clampLimit(
      ctx,
      input.limit,
      Math.min(DEFAULT_PER_TYPE_LIMIT, svc.maxResults),
    );
    // Pass the source CELEX resolved from either identifier path so the
    // national_transposition act-core constraint operates before LIMIT/OFFSET and
    // continuation proof.
    const {
      relations: workRelations,
      hasMore,
      windowEnds,
      provisionsUnavailable,
    } = await traverseRelations(svc, workUri, requestedTypes, ctx, {
      sourceCelex: sourceCelexNumber,
      perTypeLimit: perDirectionLimit,
      offset: input.offset,
      memberStates,
      article,
      provisions: true,
    });
    ctx.log.info('Relation traversal', {
      celexNumber,
      workUri,
      memberStates,
      article,
      resultCount: workRelations.length,
      offset: input.offset,
      hasMore,
    });

    /**
     * Zero edges is an answer, not a failure (#112): an empty first page returns the
     * same shape as a page past the end, with every requested type in
     * empty_relation_types, plus a notice on how to widen the traversal. A work_uri
     * is used as given and never checked for existence, so on that path the notice
     * also routes a mistyped URI to a lookup. A page past the end stays silent.
     *
     * A member_states filter that matched no measure on the first page gets its own
     * notice naming the codes, whatever the other types returned (#149): the generic
     * one would point at relation_types when the filter is what emptied the type.
     * The framework keeps one notice, so it joins the continuation guidance below.
     * An article filter does the same (#168), and on any page with interpreted_by
     * rows says that rulings CELLAR records no provision for are left out.
     *
     * `provisionsWithheld` names the kept rows whose provisions are left out to fit
     * the budget; each keeps its count, and the notice names it.
     */
    const buildPage = (
      depth: number,
      disclose: boolean,
      provisionsWithheld: ReadonlySet<WorkRelation> = new Set(),
    ): { page: RelationsPage; enrichment: RelationsEnrichment; kept: WorkRelation[] } => {
      const counts = new Map<string, number>();
      const kept = workRelations.filter((row) => {
        const key = `${row.relationType}:${row.direction}`;
        const count = (counts.get(key) ?? 0) + 1;
        counts.set(key, count);
        return count <= depth;
      });
      const withheld = workRelations.length - kept.length;
      const pageHasMore = hasMore || withheld > 0;
      const pageWindowEnds = withheld > 0 && input.offset + depth < SORT_WINDOW ? [] : windowEnds;
      const notices: string[] = [];
      const interpretingRulings = kept.some((r) => r.relationType === 'interpreted_by');
      if (article && interpretingRulings) {
        notices.push(
          `interpreted_by lists only the rulings with a recorded provision in Article ${articleLabel(article)}; rulings CELLAR records no provision for are left out.`,
        );
      }
      if (input.offset === 0) {
        const source = echoValue(celexNumber ?? workUri);
        const filterNotices: string[] = [];
        if (memberStates && !kept.some((r) => r.relationType === 'national_transposition')) {
          filterNotices.push(
            `No national_transposition measures of ${memberStates.join(', ')} were found for ${source}. Name other member states in member_states, or drop it to list every member state's measures.`,
          );
        }
        if (article && !interpretingRulings) {
          filterNotices.push(
            `No interpreted_by rulings with a recorded provision in Article ${articleLabel(article)} were found for ${source}; rulings CELLAR records no provision for are left out. Name another article, or drop article to list every interpreting ruling.`,
          );
        }
        if (filterNotices.length > 0) {
          notices.push(...filterNotices);
        } else if (kept.length === 0) {
          notices.push(
            `Work ${source} has no CDM relations of the requested types. Try other relation_types or omit the filter to fetch all available relation types.`,
          );
        }
        if (kept.length === 0 && !celexNumber) {
          notices.push(
            'The work URI is not checked for existence; confirm it with eurlex_get_document (content_mode "metadata_only").',
          );
        }
      }
      // A direction that filled what CELLAR's sort window allows may continue past row
      // 10,000, where no offset reaches (#154); this tool has no date filter, so the
      // route is a raw query per direction, bounded by the last date its page reached.
      if (pageWindowEnds.length > 0) {
        const reached = pageWindowEnds
          .map(
            (end) =>
              `${end.relationType} (${end.direction})${end.lastDate ? `, last related_date ${end.lastDate}` : ', ending among works with no date'}`,
          )
          .join('; ');
        const continuations = pageWindowEnds
          .map((end) => `${end.relationType} (${end.direction}): ${end.continuationQuery}`)
          .join('; ');
        notices.push(
          `This page reaches row 10,000, the last row CELLAR sorts for one relation type and direction, in ${reached}. No later page can be read there, and more related works may exist. To list them, run the query for each with eurlex_query_sparql, paging it with OFFSET; its first rows repeat the end of this page, and a work with several dates or CELEX numbers appears once per value. ${continuations}`,
        );
      }

      if (disclose) {
        notices.push(
          `Response budget 64,000 UTF-8 bytes per surface: requested limit ${input.limit}, applied limit ${depth}; ${withheld} rows withheld from the fetched page. Whole titles and rows are retained; a minimum depth of 1 is returned whole even when it exceeds the budget. Narrow relation_types or lower limit for a smaller response.`,
        );
      }
      if (provisionsWithheld.size > 0) {
        const rows = [...provisionsWithheld]
          .map(
            (r) =>
              `${r.relationType} ${r.relatedCelexNumber ?? r.relatedWorkUri} (${r.provisions?.length ?? 0})`,
          )
          .join('; ');
        notices.push(
          `Provisions withheld whole to fit the response budget, largest first: ${rows}. Each row keeps its count in provisions_withheld; name fewer relation_types to receive them.`,
        );
      }
      if (provisionsUnavailable.length > 0) {
        notices.push(
          `CELLAR did not return the provisions of ${provisionsUnavailable.join(', ')}; those rows are listed without them. Call again to retry.`,
        );
      }
      const relations = kept.map((r) => ({
        relation_type: r.relationType,
        direction: r.direction,
        related_work_uri: r.relatedWorkUri,
        ...(r.relatedCelexNumber ? { related_celex_number: r.relatedCelexNumber } : {}),
        ...(r.relatedMemberState ? { related_member_state: r.relatedMemberState } : {}),
        ...(r.relatedDate ? { related_date: r.relatedDate } : {}),
        ...(r.relatedTitle ? { related_title: r.relatedTitle } : {}),
        ...(r.provisions
          ? provisionsWithheld.has(r)
            ? { provisions_withheld: r.provisions.length }
            : { provisions: r.provisions }
          : {}),
      }));

      const enrichment: RelationsEnrichment = {
        ...(input.limit > perDirectionLimit
          ? { limit_clamp: { requested: input.limit, applied: perDirectionLimit } }
          : {}),
      };
      if (pageHasMore) {
        Object.assign(enrichment, {
          truncated: true,
          shown: relations.length,
          cap: depth,
          notice: [
            ...notices,
            `At least one relation type or direction has more related works; call again with offset=${input.offset + depth}.`,
          ].join(' '),
        });
      } else if (notices.length > 0) {
        enrichment.notice = notices.join(' ');
      }

      // #47: make requested-but-empty types explicit. A requested type with zero
      // edges is silently absent from the flat relations[] array, so a caller can't
      // tell "no such edges" from "dropped/paged out". Echo the full requested list
      // and the subset that returned nothing in this page (computed from the
      // post-filter relations — no extra queries).
      const presentTypes = new Set(relations.map((r) => r.relation_type));
      const emptyRelationTypes = requestedTypes.filter((t) => !presentTypes.has(t));

      // Echo the CELEX the traversal actually ran against. On the work_uri path that
      // is the identity resolved from the work — reported only when the work carries
      // exactly one, which is also the only case where it gated the act-core
      // constraint — so the caller can see which act national_transposition matched.
      const resolvedCelexNumber = celexNumber ?? sourceCelexNumber;

      const page: RelationsPage = {
        ...(resolvedCelexNumber ? { celex_number: resolvedCelexNumber } : {}),
        work_uri: workUri,
        relations,
        total: relations.length,
        offset: input.offset,
        has_more: pageHasMore,
        ...(pageHasMore ? { next_offset: input.offset + depth } : {}),
        requested_relation_types: [...requestedTypes],
        ...(memberStates ? { member_states: memberStates } : {}),
        ...(article ? { article: articleLabel(article) } : {}),
        empty_relation_types: emptyRelationTypes,
      };
      return { page, enrichment, kept };
    };
    const md = memoizedEscape();
    let selected = buildPage(perDirectionLimit, false);
    if (!fitsRelationBudget(selected.page, selected.enrichment, md)) {
      const armCounts = new Map<string, number>();
      for (const row of workRelations) {
        const key = `${row.relationType}:${row.direction}`;
        armCounts.set(key, (armCounts.get(key) ?? 0) + 1);
      }
      // Exhausted arms cannot shrink until depth falls below their actual size.
      // In particular, an oversize lone row goes straight to the depth-1 disclosure.
      const largestCut = Math.max(
        1,
        Math.min(perDirectionLimit, Math.max(0, ...armCounts.values())) - 1,
      );
      // The cap is at most 100. Descending checks find the largest fitting depth
      // even when a changing notice makes serialized size non-monotonic.
      for (let depth = largestCut; depth >= 1; depth--) {
        selected = buildPage(depth, true);
        if (fitsRelationBudget(selected.page, selected.enrichment, md)) break;
      }
      // Still over at depth 1: provisions go before the oversize exception applies,
      // whole and largest first, so they never take a page past the budget (#168).
      const provisionBytes = (r: WorkRelation) => Buffer.byteLength(JSON.stringify(r.provisions));
      const heaviest = selected.kept
        .filter((r) => r.provisions)
        .sort((a, b) => provisionBytes(b) - provisionBytes(a));
      const provisionsWithheld = new Set<WorkRelation>();
      for (const row of heaviest) {
        if (fitsRelationBudget(selected.page, selected.enrichment, md)) break;
        provisionsWithheld.add(row);
        selected = buildPage(1, true, provisionsWithheld);
      }
    }
    ctx.enrich(selected.enrichment);
    return selected.page;
  },

  format: formatRelationsPage,
});

/**
 * Render every retained row without shortening titles. Upstream values (CELEX
 * numbers, work URIs, dates, titles, provisions) and the caller's work_uri render
 * through `escapeMarkdownInline`, so a CommonMark parse reads each back as written.
 */
function formatRelationsPage(result: RelationsPage): { type: 'text'; text: string }[] {
  return renderRelationsPage(result, escapeMarkdownInline);
}

/** {@link formatRelationsPage} with the escaper supplied, so the budget search can memoize it. */
function renderRelationsPage(
  result: RelationsPage,
  md: (text: string) => string,
): { type: 'text'; text: string }[] {
  const lines: string[] = [
    `## Relations for ${md(result.celex_number ?? result.work_uri)} (${result.total} in this page, offset ${result.offset})\n`,
    `**Has more:** ${result.has_more}`,
  ];
  if (result.next_offset !== undefined) lines.push(`**Next offset:** ${result.next_offset}`);
  lines.push('');
  if (result.work_uri) lines.push(`**Work URI:** ${md(result.work_uri)}\n`);

  // #47: surface coverage so a non-structuredContent client sees the same
  // requested-vs-empty signal the structured output carries.
  lines.push(`**Requested types:** ${result.requested_relation_types.join(', ')}`);
  if (result.member_states) lines.push(`**Member states:** ${result.member_states.join(', ')}`);
  if (result.article) lines.push(`**Article:** ${result.article}`);
  lines.push(
    `**Empty types (this page):** ${
      result.empty_relation_types.length > 0 ? result.empty_relation_types.join(', ') : 'none'
    }\n`,
  );

  const grouped = new Map<string, typeof result.relations>();
  for (const r of result.relations) {
    const key = `${r.relation_type} (${r.direction})`;
    let bucket = grouped.get(key);
    if (!bucket) {
      bucket = [];
      grouped.set(key, bucket);
    }
    bucket.push(r);
  }

  for (const [group, items] of grouped) {
    lines.push(`### ${group}`);
    for (const item of items) {
      const label = item.related_celex_number
        ? `${md(item.related_celex_number)} (${md(item.related_work_uri)})`
        : md(item.related_work_uri);
      const memberState = item.related_member_state
        ? ` — member state ${item.related_member_state}`
        : '';
      const date = item.related_date ? ` · ${md(item.related_date)}` : '';
      const title = item.related_title ? ` · ${md(item.related_title)}` : '';
      lines.push(`- ${label}${memberState}${date}${title}`);
      if (item.provisions) lines.push(`  - provisions: ${item.provisions.map(md).join(', ')}`);
      if (item.provisions_withheld !== undefined) {
        lines.push(`  - provisions withheld: ${item.provisions_withheld}`);
      }
    }
    lines.push('');
  }
  return [{ type: 'text', text: lines.join('\n') }];
}
