/**
 * @fileoverview eurlex://document/{celexNumber}/relations — Relationship summary for a CELLAR work.
 * @module mcp-server/resources/definitions/eurlex-document-relations
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { notFound } from '@cyanheads/mcp-ts-core/errors';
import { getCellarSparqlService } from '@/services/cellar-sparql/cellar-sparql-service.js';
import { CELEX_PATTERN } from '@/services/cellar-sparql/eli-resolution.js';
import { RELATION_TYPES, traverseRelations } from '@/services/cellar-sparql/relation-traversal.js';
import { resolveCelexWorks } from '@/services/cellar-sparql/work-resolution.js';

/**
 * Per-type relation cap for the summary resource — lighter than the
 * eurlex_get_relations tool's default. This resource is injectable context, not
 * an exhaustive traversal.
 */
const SUMMARY_PER_TYPE_LIMIT = 25;

export const eurlex_document_relations_resource = resource(
  'eurlex://document/{celexNumber}/relations',
  {
    name: 'EUR-Lex document relations',
    description:
      'One-hop CDM relationship summary for a CELLAR work by CELEX number: amendment chain, consolidations, national transposition measures, legal basis, and citations.',
    mimeType: 'application/json',
    params: z.object({
      celexNumber: z
        .string()
        .overwrite((value) => value.trim().toUpperCase())
        .regex(
          CELEX_PATTERN,
          'celexNumber must be a CELEX identifier — a sector character followed by the year, type letters, and number (e.g. 32016R0679). Resolve a citation to its CELEX with eurlex_lookup_celex first.',
        )
        .describe(
          'CELEX number of the EU act (e.g. 32016R0679 for GDPR). Surrounding whitespace is trimmed and the value is uppercased before validation. A CELEX containing "/" (e.g. 11957A/PRO/CJ/09) cannot be addressed here — the URI template stops at the path separator, so traverse it with the eurlex_get_relations tool instead.',
        ),
    }),

    async handler(params, ctx) {
      const svc = getCellarSparqlService();
      const celexNumber = params.celexNumber.trim();

      // Resolve to the CELEX's canonical work first (#97), so a CELEX held by
      // several works never summarizes a copy that lacks edges.
      const workUri = (await resolveCelexWorks(svc, [celexNumber], ctx)).get(celexNumber);
      if (!workUri) {
        throw notFound(`No CELLAR work found for CELEX: ${celexNumber}`, { celexNumber });
      }

      // Summarize all relation types via the shared traversal — one query per
      // type so amendment and consolidation relations (modeled one-directionally
      // in CELLAR) actually surface. Passing the CELEX lets the traversal apply
      // the act-number filter for national transposition measures. Incoming
      // edges come ordered newest-first, so this lightweight summary keeps the
      // most recent within its per-direction cap. See relation-traversal.ts. The
      // cap is clamped to the service ceiling so both sides of a symmetric query
      // stay capped consistently.
      const { relations: workRelations, hasMore } = await traverseRelations(
        svc,
        workUri,
        RELATION_TYPES,
        ctx,
        celexNumber,
        Math.min(SUMMARY_PER_TYPE_LIMIT, svc.maxResults),
      );
      const relations = workRelations.map((r) => ({
        relation_type: r.relationType,
        direction: r.direction,
        related_work_uri: r.relatedWorkUri,
        ...(r.relatedCelexNumber ? { related_celex_number: r.relatedCelexNumber } : {}),
        ...(r.relatedMemberState ? { related_member_state: r.relatedMemberState } : {}),
      }));

      return {
        celex_number: celexNumber,
        work_uri: workUri,
        relations,
        total: relations.length,
        truncated: hasMore,
        ...(hasMore
          ? {
              continuation: {
                kind: 'expanded_traversal' as const,
                tool: 'eurlex_get_relations' as const,
                input: { celex_number: celexNumber },
              },
            }
          : {}),
      };
    },
  },
);
