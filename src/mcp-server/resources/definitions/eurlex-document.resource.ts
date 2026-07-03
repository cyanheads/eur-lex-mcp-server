/**
 * @fileoverview eurlex://document/{celexNumber} — Metadata snapshot for a CELLAR work.
 * @module mcp-server/resources/definitions/eurlex-document
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { notFound } from '@cyanheads/mcp-ts-core/errors';
import {
  ENG_LANGUAGE_URI,
  resolveCorporateBodyLabel,
  resolveResourceTypeLabel,
} from '@/services/cellar-sparql/cdm-labels.js';
import {
  CellarSparqlService,
  getCellarSparqlService,
} from '@/services/cellar-sparql/cellar-sparql-service.js';

export const eurlex_document_resource = resource('eurlex://document/{celexNumber}', {
  name: 'EUR-Lex document metadata',
  description:
    'Metadata snapshot for a CELLAR work identified by CELEX number. ' +
    'Returns human-readable document type and author institution labels, date, title (where available), and in-force flag. ' +
    'Read-only, stable-URI injectable context for EU acts.',
  mimeType: 'application/json',
  params: z.object({
    celexNumber: z.string().describe('CELEX number of the EU act (e.g. 32016R0679 for GDPR).'),
  }),

  async handler(params, ctx) {
    const svc = getCellarSparqlService();
    const celexNumber = params.celexNumber.trim();
    const safeCelexNumber = celexNumber.replace(/"/g, '\\"');

    const sparql = `
SELECT ?work ?celexNumber ?type ?date ?title ?inForce ?author WHERE {
  ?work cdm:resource_legal_id_celex ?celexNumber .
  FILTER(STR(?celexNumber) = "${safeCelexNumber}")
  OPTIONAL { ?work cdm:work_has_resource-type ?type . }
  OPTIONAL { ?work cdm:work_date_document ?date . }
  OPTIONAL {
    ?expr cdm:expression_belongs_to_work ?work .
    ?expr cdm:expression_uses_language <${ENG_LANGUAGE_URI}> .
    ?expr cdm:expression_title ?title .
  }
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
    // Resolve the raw CDM authority URI to a human-readable label, matching the
    // eurlex_get_document tool (previously the resource leaked the raw URI).
    const resourceType = CellarSparqlService.bindingValue(first, 'type');
    if (resourceType) result.resource_type = resolveResourceTypeLabel(resourceType);
    const date = CellarSparqlService.bindingValue(first, 'date');
    if (date) result.date = date;
    const title = CellarSparqlService.bindingValue(first, 'title');
    if (title) result.title = title;
    const inForce = CellarSparqlService.parseBoolean(
      CellarSparqlService.bindingValue(first, 'inForce'),
    );
    if (inForce !== undefined) result.in_force = inForce;

    // Authors resolve to human-readable institution labels, matching
    // eurlex_get_document. The metadata query returns one row per author
    // (cross-joined with the single-valued fields), so gather every author across
    // the rows — a co-legislated act (e.g. GDPR: Parliament + Council) carries
    // several. Labels are de-duplicated (distinct URIs like EMA/EMEA share a
    // label); the first is the primary author_institution, the full set is
    // author_institutions.
    const authorUris = new Set<string>();
    for (const b of bindings) {
      const author = CellarSparqlService.bindingValue(b, 'author');
      if (author) authorUris.add(author);
    }
    if (authorUris.size > 0) {
      const institutions = [...new Set([...authorUris].map(resolveCorporateBodyLabel))];
      const [primary] = institutions;
      if (primary) {
        result.author_institution = primary;
        result.author_institutions = institutions;
      }
    }

    return result;
  },
});
