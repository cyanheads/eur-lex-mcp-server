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

/** CDM relation predicates for the summary resource. */
const RELATION_PREDICATES = [
  'cdm:work_cites_work',
  'cdm:resource_legal_amends_resource_legal',
  'cdm:resource_legal_amended_by_resource_legal',
  'cdm:resource_legal_based_on_resource_legal',
  'cdm:resource_legal_has_consolidated_version',
];

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

      // Fetch relations
      const relSparql = `
SELECT ?relatedWork ?relatedCelex ?relationType ?direction WHERE {
  {
    <${workUri}> ?relationType ?relatedWork .
    OPTIONAL { ?relatedWork cdm:resource_legal_id_celex ?relatedCelex . }
    BIND("outgoing" AS ?direction)
    FILTER(?relationType IN (${RELATION_PREDICATES.join(', ')}))
  } UNION {
    ?relatedWork ?relationType <${workUri}> .
    OPTIONAL { ?relatedWork cdm:resource_legal_id_celex ?relatedCelex . }
    BIND("incoming" AS ?direction)
    FILTER(?relationType IN (${RELATION_PREDICATES.join(', ')}))
  }
} LIMIT 50`;

      const relBindings = await svc.query(relSparql, ctx);

      const relations: Array<{
        relation_type: string;
        direction: string;
        related_work_uri: string;
        related_celex_number?: string;
      }> = [];
      const seen = new Set<string>();

      for (const b of relBindings) {
        const relatedWorkUri = CellarSparqlService.bindingValue(b, 'relatedWork') ?? '';
        const predicateUri = CellarSparqlService.bindingValue(b, 'relationType') ?? '';
        const direction = CellarSparqlService.bindingValue(b, 'direction') ?? 'outgoing';
        const key = `${predicateUri}|${relatedWorkUri}|${direction}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const entry: (typeof relations)[number] = {
          relation_type: PREDICATE_TO_TYPE[predicateUri] ?? predicateUri,
          direction,
          related_work_uri: relatedWorkUri,
        };
        const relatedCelex = CellarSparqlService.bindingValue(b, 'relatedCelex');
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
  },
);
