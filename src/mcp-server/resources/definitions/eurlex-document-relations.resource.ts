/**
 * @fileoverview eurlex://document/{celexNumber}/relations — Relationship summary for a CELLAR work.
 * @module mcp-server/resources/definitions/eurlex-document-relations
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { notFound } from '@cyanheads/mcp-ts-core/errors';
import {
  CellarSparqlService,
  getCellarSparqlService,
} from '@/services/cellar-sparql/cellar-sparql-service.js';
import { RELATION_TYPES, traverseRelations } from '@/services/cellar-sparql/relation-traversal.js';

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
      'Relationship summary for a CELLAR work: amendment chain, consolidations, legal basis, and cited-by information. ' +
      'Returns direct one-hop CDM relations for the work identified by CELEX number. ' +
      'For deeper traversal or additional relation types, use the eurlex_get_relations tool.',
    mimeType: 'application/json',
    params: z.object({
      celexNumber: z.string().describe('CELEX number of the EU act (e.g. 32016R0679 for GDPR).'),
    }),

    async handler(params, ctx) {
      const svc = getCellarSparqlService();
      const celexNumber = params.celexNumber.trim();
      const safeCelexNumber = celexNumber.replace(/"/g, '\\"');

      // Resolve to work URI first
      const resolveSparql = `
SELECT ?work WHERE {
  ?work cdm:resource_legal_id_celex ?celex .
  FILTER(STR(?celex) = "${safeCelexNumber}")
} LIMIT 1`;

      const resolveBindings = await svc.query(resolveSparql, ctx);

      if (resolveBindings.length === 0) {
        throw notFound(`No CELLAR work found for CELEX: ${celexNumber}`, { celexNumber });
      }

      const workUri = CellarSparqlService.bindingValue(resolveBindings[0], 'work') ?? '';

      // Summarize all relation types via the shared traversal — one query per
      // type so amendment and consolidation relations (modeled one-directionally
      // in CELLAR) actually surface. Passing the CELEX lets the traversal apply
      // the consolidated_version act-number filter (#32). See relation-traversal.ts.
      const workRelations = await traverseRelations(
        svc,
        workUri,
        RELATION_TYPES,
        ctx,
        celexNumber,
        SUMMARY_PER_TYPE_LIMIT,
      );
      const relations = workRelations.map((r) => ({
        relation_type: r.relationType,
        direction: r.direction,
        related_work_uri: r.relatedWorkUri,
        ...(r.relatedCelexNumber ? { related_celex_number: r.relatedCelexNumber } : {}),
      }));

      return {
        celex_number: celexNumber,
        work_uri: workUri,
        relations,
        total: relations.length,
      };
    },
  },
);
