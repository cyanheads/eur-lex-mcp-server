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
import { CELEX_PATTERN, escapeSparqlLiteral } from '@/services/cellar-sparql/eli-resolution.js';
import type { SparqlBinding } from '@/services/cellar-sparql/types.js';

/** Per-dimension row cap for the legal-basis and EuroVoc queries. */
const DIMENSION_LIMIT = 100;

/** One entry per distinct URI, carrying the companion literal when bound. */
function collectResolved(
  bindings: SparqlBinding[],
  uriVariable: string,
  literalVariable: string,
): { uri: string; literal?: string }[] {
  const byUri = new Map<string, string | undefined>();
  for (const b of bindings) {
    const uri = CellarSparqlService.bindingValue(b, uriVariable);
    if (!uri) continue;
    const literal = CellarSparqlService.bindingValue(b, literalVariable);
    if (!byUri.has(uri) || (literal && !byUri.get(uri))) byUri.set(uri, literal);
  }
  return [...byUri].map(([uri, literal]) => ({ uri, ...(literal ? { literal } : {}) }));
}

export const eurlex_document_resource = resource('eurlex://document/{celexNumber}', {
  name: 'EUR-Lex document metadata',
  description:
    'Metadata snapshot for a CELLAR work by CELEX number — human-readable document type and author institution labels, date, title, in-force flag, legal basis acts (work URI plus CELEX), and EuroVoc subjects (concept URI plus English label).',
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
        'CELEX number of the EU act (e.g. 32016R0679 for GDPR). Surrounding whitespace is trimmed and the value is uppercased before validation. A CELEX containing "/" (e.g. 11957A/PRO/CJ/09) cannot be addressed here — the URI template stops at the path separator, so fetch it with the eurlex_get_document tool instead.',
      ),
  }),

  async handler(params, ctx) {
    const svc = getCellarSparqlService();
    const celexNumber = params.celexNumber.trim();
    // The shared helper, not a local quote-only pass: a hand-rolled escape without
    // a backslash pass lets a trailing `\` escape the closing quote, so the literal
    // never terminates and Virtuoso's raw compiler error — internal query text
    // attached — reaches the client in place of this resource's not_found (#61).
    const safeCelexNumber = escapeSparqlLiteral(celexNumber);

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

    // Legal bases and EuroVoc subjects are fetched per dimension (never a
    // cross-product with the core rows) with their identifying literal joined as
    // an OPTIONAL, matching eurlex_get_document (#67). The resource has no
    // language input, so labels are English.
    const legalBasisSparql = `
SELECT ?legalBasis (SAMPLE(?celexValue) AS ?celex) WHERE {
  ?work cdm:resource_legal_id_celex ?c .
  FILTER(STR(?c) = "${safeCelexNumber}")
  ?work cdm:resource_legal_based_on_resource_legal ?legalBasis .
  OPTIONAL { ?legalBasis cdm:resource_legal_id_celex ?celexValue . }
} GROUP BY ?legalBasis LIMIT ${DIMENSION_LIMIT}`;
    const eurovocSparql = `
SELECT ?eurovoc (SAMPLE(?labelValue) AS ?label) WHERE {
  ?work cdm:resource_legal_id_celex ?c .
  FILTER(STR(?c) = "${safeCelexNumber}")
  ?work cdm:work_is_about_concept_eurovoc ?eurovoc .
  OPTIONAL {
    ?eurovoc skos:prefLabel ?labelValue .
    FILTER(LANG(?labelValue) = "en")
  }
} GROUP BY ?eurovoc LIMIT ${DIMENSION_LIMIT}`;

    const bindings = await svc.query(sparql, ctx);

    if (bindings.length === 0) {
      throw notFound(`No CELLAR work found for CELEX: ${celexNumber}`, { celexNumber });
    }

    const [legalBasisBindings, eurovocBindings] = await Promise.all([
      svc.query(legalBasisSparql, ctx),
      svc.query(eurovocSparql, ctx),
    ]);

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

    const legalBasis = collectResolved(legalBasisBindings, 'legalBasis', 'celex').map(
      ({ uri, literal }) => ({ work_uri: uri, ...(literal ? { celex_number: literal } : {}) }),
    );
    if (legalBasis.length > 0) result.legal_basis = legalBasis;
    const eurovoc = collectResolved(eurovocBindings, 'eurovoc', 'label').map(
      ({ uri, literal }) => ({ concept_uri: uri, ...(literal ? { label: literal } : {}) }),
    );
    if (eurovoc.length > 0) result.eurovoc_subjects = eurovoc;

    return result;
  },
});
