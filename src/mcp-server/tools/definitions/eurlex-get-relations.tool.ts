/**
 * @fileoverview eurlex_get_relations — Traverse the CELLAR CDM relationship graph for a work.
 * @module mcp-server/tools/definitions/eurlex-get-relations
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  CellarSparqlService,
  getCellarSparqlService,
} from '@/services/cellar-sparql/cellar-sparql-service.js';
import {
  CELEX_PATTERN,
  celexLiteral,
  isSafeSparqlIri,
} from '@/services/cellar-sparql/eli-resolution.js';
import {
  RELATION_TYPES,
  type RelationType,
  traverseRelations,
} from '@/services/cellar-sparql/relation-traversal.js';

export const eurlex_get_relations = tool('eurlex_get_relations', {
  title: 'Get CELLAR Relationship Graph',
  description:
    'Traverse the one-hop CDM relationship graph of an EU act: what it amends or is amended by, what it repeals or is repealed by (explicit and implicit), its consolidated versions, national transposition measures, its legal basis, and works that cite it. Returns direct relations only, paginated per relation type and direction. Requires a CELEX number or CELLAR work URI.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    celex_number: z
      .union([
        z.literal(''),
        z
          .string()
          .overwrite((value) => value.trim().toUpperCase())
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
      .refine((v) => !v || isSafeSparqlIri(v), {
        message: 'work_uri must be a valid http URI with no whitespace, angle brackets, or quotes.',
      })
      .optional()
      .describe(
        'CELLAR work resource URI to traverse (e.g. http://publications.europa.eu/resource/cellar/3e485e15-11bd-11e6-ba9a-01aa75ed71a1). Used directly as the addressed work; its CELEX identity is resolved for relation-specific act matching, and act-matched relation types stand down when the work carries several CELEX numbers — address such a work by celex_number to name the act you mean. Provide exactly one of celex_number or work_uri.',
      ),
    relation_types: z
      .array(z.enum([...RELATION_TYPES]))
      .optional()
      .describe(
        'Subset of relation types to return; omit for all. Types: cites, amends, amended_by, repeals, repealed_by, implicitly_repeals, implicitly_repealed_by, legal_basis (treaty/article this act rests on), consolidated_version (consolidated texts of this act), national_transposition (member-state implementing measures).',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Pagination offset applied per relation type and direction — related works to skip (default 0). Page forward by adding limit; incoming edges are newest-first, so higher offsets reach older works.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(100)
      .describe(
        'Maximum related works per relation type and direction (1–100, default 100). Incoming edges are ordered newest-first, so the cap keeps the newest — page with offset for older ones.',
      ),
  }),
  output: z.object({
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
                'Type of relation: cites, amends, amended_by, repeals, repealed_by, implicitly_repeals, implicitly_repealed_by, legal_basis, consolidated_version, national_transposition.',
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
        'True only when at least one requested relation type/direction returned an additional valid row beyond this page.',
      ),
    next_offset: z
      .number()
      .optional()
      .describe('Offset for the next page. Present only when has_more is true.'),
    requested_relation_types: z
      .array(z.string())
      .describe(
        'The relation types this request traversed — the explicit relation_types list, or all types when it was omitted. Diff against the types present in relations[], or read empty_relation_types, to confirm which requested types returned edges.',
      ),
    empty_relation_types: z
      .array(z.string())
      .describe(
        'Requested relation types that returned zero relations in THIS page. Page-scoped: a type can appear here because all its edges sit beyond the current offset/limit window, not only because the act genuinely has none of that relation — so absent-from-here does not prove absent-in-CELLAR. An empty first page throws no_relations; an exhausted non-zero page returns all requested types here.',
      ),
  }),

  enrichment: {
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
  },

  errors: [
    {
      reason: 'invalid_identifier_args',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Neither celex_number nor work_uri was provided, or both were.',
      recovery: 'Provide exactly one of celex_number or work_uri.',
    },
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'CELEX number not found in CELLAR — resolve the identifier with eurlex_lookup_celex first.',
      recovery: 'Use eurlex_lookup_celex to confirm the CELEX number exists, then retry.',
    },
    {
      reason: 'no_relations',
      code: JsonRpcErrorCode.NotFound,
      when: 'The first page (offset 0) was empty — the work exists but has no CDM relations of the requested types. A later page that comes back empty returns an empty success instead.',
      recovery:
        'Try other relation_types or omit the filter to fetch all available relation types.',
    },
  ],

  async handler(input, ctx) {
    const svc = getCellarSparqlService();
    const requestedTypes: readonly RelationType[] = input.relation_types ?? RELATION_TYPES;

    // Accept exactly one identifier. Treat empty/whitespace as absent so
    // form-based clients sending "" for an omitted field hit the friendly guard.
    const celexNumber = input.celex_number?.trim();
    const workUriInput = input.work_uri?.trim();

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
       * relation-specific act-core constraints. Two rows are requested rather than
       * one so an ambiguous identity is detectable: a CELLAR work can carry many
       * CELEX values — a national implementing measure holds one per directive it
       * transposes, dozens in practice — and there is no principled basis for
       * choosing among them. Picking the first would silently constrain the
       * traversal to an arbitrary act, so an ambiguous work supplies no source
       * CELEX at all and the act-core constraints stand down: `consolidated_version`
       * falls back to requiring a CELEX without an act match, and
       * `national_transposition` returns nothing rather than measures selected
       * against an act the caller never named.
       *
       * Only `consolidated_version` and `national_transposition` consume that
       * identity, so the lookup runs only when one of them was requested — a
       * traversal of the other eight types spends no CELLAR round-trip on it.
       */
      if (
        requestedTypes.includes('consolidated_version') ||
        requestedTypes.includes('national_transposition')
      ) {
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
          ctx.log.info('Work carries several CELEX identifiers; act-core constraints stand down', {
            workUri,
            sourceCelexValues,
          });
        }
      }
    } else if (celexNumber && !workUriInput) {
      // Typed exact triple (#92): resolves from the index, where STR() equality scans.
      const resolveSparql = `
SELECT ?work WHERE {
  ?work cdm:resource_legal_id_celex ${celexLiteral(celexNumber)} .
} LIMIT 1`;

      const resolveBindings = await svc.query(resolveSparql, ctx);
      if (resolveBindings.length === 0) {
        throw ctx.fail('not_found', `No CELLAR work found for CELEX: ${celexNumber}`, {
          ...ctx.recoveryFor('not_found'),
        });
      }
      workUri = CellarSparqlService.bindingValue(resolveBindings[0], 'work') ?? '';
    } else {
      throw ctx.fail(
        'invalid_identifier_args',
        celexNumber
          ? 'Provide only one of celex_number or work_uri, not both.'
          : 'Provide either celex_number or work_uri.',
        { ...ctx.recoveryFor('invalid_identifier_args') },
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
    const perDirectionLimit = Math.min(input.limit, svc.maxResults);
    // Pass the source CELEX resolved from either identifier path so relation-specific
    // act-core constraints operate before LIMIT/OFFSET and continuation proof.
    const { relations: workRelations, hasMore } = await traverseRelations(
      svc,
      workUri,
      requestedTypes,
      ctx,
      sourceCelexNumber,
      perDirectionLimit,
      input.offset,
    );
    ctx.log.info('Relation traversal', {
      celexNumber,
      workUri,
      resultCount: workRelations.length,
      offset: input.offset,
      hasMore,
    });

    if (workRelations.length === 0 && input.offset === 0) {
      throw ctx.fail(
        'no_relations',
        `Work ${celexNumber ?? workUri} has no CDM relations of the requested types.`,
        {
          ...ctx.recoveryFor('no_relations'),
        },
      );
    }

    const relations = workRelations.map((r) => ({
      relation_type: r.relationType,
      direction: r.direction,
      related_work_uri: r.relatedWorkUri,
      ...(r.relatedCelexNumber ? { related_celex_number: r.relatedCelexNumber } : {}),
      ...(r.relatedMemberState ? { related_member_state: r.relatedMemberState } : {}),
    }));

    if (hasMore) {
      ctx.enrich.truncated({ shown: relations.length, cap: perDirectionLimit });
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
    // constraints — so the caller can see which act the constrained types matched.
    const resolvedCelexNumber = celexNumber ?? sourceCelexNumber;

    return {
      ...(resolvedCelexNumber ? { celex_number: resolvedCelexNumber } : {}),
      work_uri: workUri,
      relations,
      total: relations.length,
      offset: input.offset,
      has_more: hasMore,
      ...(hasMore ? { next_offset: input.offset + perDirectionLimit } : {}),
      requested_relation_types: [...requestedTypes],
      empty_relation_types: emptyRelationTypes,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `## Relations for ${result.celex_number ?? result.work_uri} (${result.total} in this page, offset ${result.offset})\n`,
      `**Has more:** ${result.has_more}`,
    ];
    if (result.next_offset !== undefined) lines.push(`**Next offset:** ${result.next_offset}`);
    lines.push('');
    if (result.work_uri) lines.push(`**Work URI:** ${result.work_uri}\n`);

    // #47: surface coverage so a non-structuredContent client sees the same
    // requested-vs-empty signal the structured output carries.
    lines.push(`**Requested types:** ${result.requested_relation_types.join(', ')}`);
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
          ? `${item.related_celex_number} (${item.related_work_uri})`
          : item.related_work_uri;
        const memberState = item.related_member_state
          ? ` — member state ${item.related_member_state}`
          : '';
        lines.push(`- ${label}${memberState}`);
      }
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
