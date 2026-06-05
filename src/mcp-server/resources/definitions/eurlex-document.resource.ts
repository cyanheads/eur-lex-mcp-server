/**
 * @fileoverview eurlex://document/{celexNumber} — Metadata snapshot for a CELLAR work.
 * @module mcp-server/resources/definitions/eurlex-document
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { notFound } from '@cyanheads/mcp-ts-core/errors';
import {
  CellarSparqlService,
  getCellarSparqlService,
} from '@/services/cellar-sparql/cellar-sparql-service.js';

export const eurlex_document_resource = resource('eurlex://document/{celexNumber}', {
  name: 'EUR-Lex document metadata',
  description:
    'Metadata snapshot for a CELLAR work identified by CELEX number. ' +
    'Returns document type, date, title (where available), author institution, and in-force flag. ' +
    'Read-only, stable-URI injectable context for EU acts. ' +
    'Full content and relations are available via the eurlex_get_document and eurlex_get_relations tools.',
  mimeType: 'application/json',
  params: z.object({
    celexNumber: z.string().describe('CELEX number of the EU act (e.g. 32016R0679 for GDPR).'),
  }),

  async handler(params, ctx) {
    const svc = getCellarSparqlService();
    const celexNumber = params.celexNumber.trim();

    const sparql = `
SELECT ?work ?celexNumber ?type ?date ?title ?inForce ?author WHERE {
  ?work cdm:resource_legal_id_celex ?celexNumber .
  FILTER(STR(?celexNumber) = "${celexNumber}")
  OPTIONAL { ?work cdm:work_has_resource-type ?type . }
  OPTIONAL { ?work cdm:work_date_document ?date . }
  OPTIONAL { ?work cdm:work_title ?titleNode . ?titleNode cdm:expression_title ?title . FILTER(LANG(?title) = "en") }
  OPTIONAL { ?work cdm:resource_legal_in-force ?inForce . }
  OPTIONAL { ?work cdm:work_created_by_agent ?author . }
} LIMIT 5`;

    const bindings = await svc.query(sparql, ctx);

    if (bindings.length === 0) {
      throw notFound(`No CELLAR work found for CELEX: ${celexNumber}`, { celexNumber });
    }

    const first = bindings[0];
    const result: Record<string, unknown> = {
      celex_number: CellarSparqlService.bindingValue(first, 'celexNumber') ?? celexNumber,
    };

    const workUri = CellarSparqlService.bindingValue(first, 'work');
    if (workUri) result.work_uri = workUri;
    const resourceType = CellarSparqlService.bindingValue(first, 'type');
    if (resourceType) result.resource_type = resourceType;
    const date = CellarSparqlService.bindingValue(first, 'date');
    if (date) result.date = date;
    const title = CellarSparqlService.bindingValue(first, 'title');
    if (title) result.title = title;
    const inForceStr = CellarSparqlService.bindingValue(first, 'inForce');
    if (inForceStr !== undefined) result.in_force = inForceStr === 'true';
    const author = CellarSparqlService.bindingValue(first, 'author');
    if (author) result.author_institution = author;

    return result;
  },
});
