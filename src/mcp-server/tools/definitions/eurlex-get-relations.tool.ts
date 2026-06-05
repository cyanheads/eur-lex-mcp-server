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

/** CDM relation predicates traversed by this tool. */
const CDM_RELATIONS: Record<string, string> = {
  cites: 'cdm:work_cites_work',
  amends: 'cdm:resource_legal_amends_resource_legal',
  amended_by: 'cdm:resource_legal_amended_by_resource_legal',
  legal_basis: 'cdm:resource_legal_based_on_resource_legal',
  consolidated_version: 'cdm:resource_legal_has_consolidated_version',
};

/** Map predicate URI to human-readable relation type name. */
const PREDICATE_TO_TYPE: Record<string, string> = {
  'http://publications.europa.eu/ontology/cdm#work_cites_work': 'cites',
  'http://publications.europa.eu/ontology/cdm#resource_legal_amends_resource_legal': 'amends',
  'http://publications.europa.eu/ontology/cdm#resource_legal_amended_by_resource_legal':
    'amended_by',
  'http://publications.europa.eu/ontology/cdm#resource_legal_based_on_resource_legal':
    'legal_basis',
  'http://publications.europa.eu/ontology/cdm#resource_legal_has_consolidated_version':
    'consolidated_version',
};

export const eurlex_get_relations = tool('eurlex_get_relations', {
  title: 'Get CELLAR Relationship Graph',
  description:
    'Traverse the CELLAR CDM relationship graph for an EU work: ' +
    'what it amends, what amends it, its current consolidated version, its legal basis, and works that cite it. ' +
    "This is CELLAR's primary value over HTML scraping — the graph traversal that exposes the lifecycle and dependencies of an EU act. " +
    'Returns one-hop direct relations only. For deeper traversal, use eurlex_query_sparql. ' +
    'The "consolidated_version" relation links to the current consolidated text (a separate CELEX-numbered work); ' +
    'fetch that work with eurlex_get_document. ' +
    'Requires a valid CELEX number or CELLAR work URI — use eurlex_lookup_celex to resolve identifiers first.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    celex_number: z
      .string()
      .min(1)
      .describe('CELEX number of the work to traverse (e.g. 32016R0679). Preferred identifier.'),
    work_uri: z
      .string()
      .optional()
      .describe(
        'CELLAR work URI as alternative to celex_number. Used if celex_number resolves to no work.',
      ),
    relation_types: z
      .array(z.enum(['cites', 'amends', 'amended_by', 'legal_basis', 'consolidated_version']))
      .optional()
      .describe(
        'Subset of relation types to return. Omit to return all types: ' +
          'cites (citation graph), amends (what this work amends), amended_by (what amends this work), ' +
          'legal_basis (treaty/treaty article this act is based on), consolidated_version (current consolidated text).',
      ),
  }),
  output: z.object({
    celex_number: z
      .string()
      .describe('CELEX number of the source work whose relations were traversed.'),
    work_uri: z
      .string()
      .optional()
      .describe('CELLAR URI of the source work (resolved from the CELEX number).'),
    relations: z
      .array(
        z
          .object({
            relation_type: z
              .string()
              .describe(
                'Type of relation: cites, amends, amended_by, legal_basis, consolidated_version.',
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
    total: z.number().describe('Total number of direct CDM relations returned.'),
  }),

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'CELEX/work URI not found in CELLAR — resolve the identifier with eurlex_lookup_celex first.',
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
    const celexNumber = input.celex_number.trim();

    // Step 1: Resolve CELEX to work URI
    const resolveSparql = `
SELECT ?work WHERE {
  ?work cdm:resource_legal_id_celex ?celex .
  FILTER(?celex = "${celexNumber}")
} LIMIT 1`;

    const resolveBindings = await svc.query(resolveSparql, ctx);
    if (resolveBindings.length === 0) {
      throw ctx.fail('not_found', `No CELLAR work found for CELEX: ${celexNumber}`, {
        ...ctx.recoveryFor('not_found'),
      });
    }

    const workUri =
      CellarSparqlService.bindingValue(resolveBindings[0], 'work') ?? input.work_uri ?? '';

    // Step 2: Build relation type filter
    const requestedTypes = input.relation_types ?? [
      'cites',
      'amends',
      'amended_by',
      'legal_basis',
      'consolidated_version',
    ];
    const predicates = requestedTypes.map((t) => CDM_RELATIONS[t]).filter(Boolean);

    if (predicates.length === 0) {
      throw ctx.fail('no_relations', `No valid relation types requested.`, {
        ...ctx.recoveryFor('no_relations'),
      });
    }

    // Step 3: Traverse relation graph (outgoing and incoming)
    const relationSparql = `
SELECT ?relatedWork ?relatedCelex ?relationType ?direction WHERE {
  {
    # Outgoing: this work → related work
    <${workUri}> ?relationType ?relatedWork .
    OPTIONAL { ?relatedWork cdm:resource_legal_id_celex ?relatedCelex . }
    BIND("outgoing" AS ?direction)
    FILTER(?relationType IN (${predicates.join(', ')}))
  } UNION {
    # Incoming: related work → this work
    ?relatedWork ?relationType <${workUri}> .
    OPTIONAL { ?relatedWork cdm:resource_legal_id_celex ?relatedCelex . }
    BIND("incoming" AS ?direction)
    FILTER(?relationType IN (${predicates.join(', ')}))
  }
} LIMIT 100`;

    const relationBindings = await svc.query(relationSparql, ctx);
    ctx.log.info('Relation traversal', {
      celexNumber,
      workUri,
      resultCount: relationBindings.length,
    });

    if (relationBindings.length === 0) {
      throw ctx.fail(
        'no_relations',
        `Work ${celexNumber} has no CDM relations of the requested types.`,
        {
          ...ctx.recoveryFor('no_relations'),
        },
      );
    }

    // Deduplicate relations
    const seen = new Set<string>();
    const relations: Array<{
      relation_type: string;
      direction: string;
      related_work_uri: string;
      related_celex_number?: string;
    }> = [];

    for (const b of relationBindings) {
      const relatedWorkUri = CellarSparqlService.bindingValue(b, 'relatedWork') ?? '';
      const predicateUri = CellarSparqlService.bindingValue(b, 'relationType') ?? '';
      const direction = CellarSparqlService.bindingValue(b, 'direction') ?? 'outgoing';
      const key = `${predicateUri}|${relatedWorkUri}|${direction}`;

      if (seen.has(key)) continue;
      seen.add(key);

      const relationType = PREDICATE_TO_TYPE[predicateUri] ?? predicateUri;
      const relatedCelex = CellarSparqlService.bindingValue(b, 'relatedCelex');

      const entry: (typeof relations)[number] = {
        relation_type: relationType,
        direction,
        related_work_uri: relatedWorkUri,
      };
      if (relatedCelex) entry.related_celex_number = relatedCelex;
      relations.push(entry);
    }

    return {
      celex_number: celexNumber,
      work_uri: workUri,
      relations,
      total: relations.length,
    };
  },

  format: (result) => {
    const lines: string[] = [`## Relations for ${result.celex_number} (${result.total} found)\n`];
    if (result.work_uri) lines.push(`**Work URI:** ${result.work_uri}\n`);

    const grouped = new Map<string, typeof result.relations>();
    for (const r of result.relations) {
      const key = `${r.relation_type} (${r.direction})`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(r);
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
