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
import { escapeSparqlLiteral, isSafeSparqlIri } from '@/services/cellar-sparql/eli-resolution.js';
import {
  RELATION_TYPES,
  type RelationType,
  traverseRelations,
} from '@/services/cellar-sparql/relation-traversal.js';

export const eurlex_get_relations = tool('eurlex_get_relations', {
  title: 'Get CELLAR Relationship Graph',
  description:
    'Traverse the one-hop CDM relationship graph of an EU act: what it amends or is amended by, what it repeals or is repealed by (explicit and implicit), its consolidated versions, its legal basis, and works that cite it. Returns direct relations only, paginated per relation type and direction. Requires a CELEX number or CELLAR work URI.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    celex_number: z
      .string()
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
        'CELLAR work resource URI to traverse (e.g. http://publications.europa.eu/resource/cellar/3e485e15-11bd-11e6-ba9a-01aa75ed71a1). Used directly without CELEX resolution. Provide exactly one of celex_number or work_uri.',
      ),
    relation_types: z
      .array(z.enum([...RELATION_TYPES]))
      .optional()
      .describe(
        'Subset of relation types to return; omit for all. Types: cites, amends, amended_by, repeals, repealed_by, implicitly_repeals, implicitly_repealed_by, legal_basis (treaty/article this act rests on), consolidated_version (consolidated texts of this act).',
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
        'Maximum related works per relation type and direction (1–100, default 100). Incoming edges are ordered newest-first, so the cap keeps the newest — page with offset for older ones. When truncated is true, at least one direction filled its cap.',
      ),
  }),
  output: z.object({
    celex_number: z
      .string()
      .optional()
      .describe(
        'CELEX number of the source work whose relations were traversed. Absent when addressed directly by work_uri.',
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
                'Type of relation: cites, amends, amended_by, repeals, repealed_by, implicitly_repeals, implicitly_repealed_by, legal_basis, consolidated_version.',
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
          })
          .describe('A single CDM relation between the source work and a related work.'),
      )
      .describe('Direct CDM relations for the requested work.'),
    total: z
      .number()
      .describe(
        'Number of relations returned in this page (not a corpus-wide count). A direction that filled its cap sets truncated — page with offset for the rest.',
      ),
    offset: z
      .number()
      .describe('Pagination offset applied to this response (per relation type and direction).'),
    requested_relation_types: z
      .array(z.string())
      .describe(
        'The relation types this request traversed — the explicit relation_types list, or all types when it was omitted. Diff against the types present in relations[], or read empty_relation_types, to confirm which requested types returned edges.',
      ),
    empty_relation_types: z
      .array(z.string())
      .describe(
        'Requested relation types that returned zero relations in THIS page. Page-scoped: a type can appear here because all its edges sit beyond the current offset/limit window, not only because the act genuinely has none of that relation — so absent-from-here does not prove absent-in-CELLAR. When every requested type is empty the tool throws no_relations instead.',
      ),
  }),

  enrichment: {
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when at least one relation type/direction filled its per-direction cap and more related works may exist — page with offset.',
      ),
    shown: z.number().optional().describe('Number of relations returned in this page.'),
    cap: z.number().optional().describe('The per-direction cap applied to this page.'),
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
      when: 'Work exists but has no CDM relations of the requested types.',
      recovery:
        'Try other relation_types or omit the filter to fetch all available relation types.',
    },
  ],

  async handler(input, ctx) {
    const svc = getCellarSparqlService();

    // Accept exactly one identifier. Treat empty/whitespace as absent so
    // form-based clients sending "" for an omitted field hit the friendly guard.
    const celexNumber = input.celex_number?.trim();
    const workUriInput = input.work_uri?.trim();

    // Step 1: Determine the source work URI. A work_uri is the CELLAR work
    // resource directly — use it as-is, skipping the CELEX→work resolution that
    // would otherwise throw not_found before the URI could be used. A
    // celex_number is resolved to its work first.
    let workUri: string;
    if (workUriInput && !celexNumber) {
      workUri = workUriInput;
    } else if (celexNumber && !workUriInput) {
      const resolveSparql = `
SELECT ?work WHERE {
  ?work cdm:resource_legal_id_celex ?celex .
  FILTER(STR(?celex) = "${escapeSparqlLiteral(celexNumber)}")
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
    // capped consistently — the service's LIMIT enforcement rewrites only the
    // first LIMIT it finds, which would leave a UNION's second subquery uncapped.
    const requestedTypes: readonly RelationType[] = input.relation_types ?? RELATION_TYPES;
    const perDirectionLimit = Math.min(input.limit, svc.maxResults);
    // Pass the source CELEX (undefined on the work_uri path) so the shared
    // traversal can apply the consolidated_version act-number filter (#32).
    const { relations: workRelations, truncated } = await traverseRelations(
      svc,
      workUri,
      requestedTypes,
      ctx,
      celexNumber,
      perDirectionLimit,
      input.offset,
    );
    ctx.log.info('Relation traversal', {
      celexNumber,
      workUri,
      resultCount: workRelations.length,
      offset: input.offset,
      truncated,
    });

    if (workRelations.length === 0) {
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
    }));

    // Disclose truncation so a capped list isn't mistaken for the complete set —
    // the same signal eurlex_get_cases and eurlex_search_documents expose.
    if (truncated) {
      ctx.enrich.truncated({ shown: relations.length, cap: perDirectionLimit });
    }

    // #47: make requested-but-empty types explicit. A requested type with zero
    // edges is silently absent from the flat relations[] array, so a caller can't
    // tell "no such edges" from "dropped/paged out". Echo the full requested list
    // and the subset that returned nothing in this page (computed from the
    // post-filter relations — no extra queries).
    const presentTypes = new Set(relations.map((r) => r.relation_type));
    const emptyRelationTypes = requestedTypes.filter((t) => !presentTypes.has(t));

    return {
      ...(celexNumber ? { celex_number: celexNumber } : {}),
      work_uri: workUri,
      relations,
      total: relations.length,
      offset: input.offset,
      requested_relation_types: [...requestedTypes],
      empty_relation_types: emptyRelationTypes,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `## Relations for ${result.celex_number ?? result.work_uri} (${result.total} in this page, offset ${result.offset})\n`,
    ];
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
        lines.push(`- ${label}`);
      }
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
