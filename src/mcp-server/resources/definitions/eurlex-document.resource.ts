/**
 * @fileoverview eurlex://document/{celexNumber} — Metadata snapshot for a CELLAR work.
 * @module mcp-server/resources/definitions/eurlex-document
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { notFound } from '@cyanheads/mcp-ts-core/errors';
import { ENG_LANGUAGE_URI, resolveResourceTypeLabel } from '@/services/cellar-sparql/cdm-labels.js';
import {
  CellarSparqlService,
  getCellarSparqlService,
} from '@/services/cellar-sparql/cellar-sparql-service.js';
import { CELEX_PATTERN } from '@/services/cellar-sparql/eli-resolution.js';
import {
  findConsolidation,
  isConsolidatedCelex,
} from '@/services/cellar-sparql/relation-traversal.js';
import type { SparqlBinding } from '@/services/cellar-sparql/types.js';
import { fetchWorkAgents } from '@/services/cellar-sparql/work-agents.js';
import { resolveCelexWorks } from '@/services/cellar-sparql/work-resolution.js';

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
    "Metadata snapshot for a CELLAR work by CELEX number — human-readable document type, authors by English authority label (an EU institution or body, a member state, an MEP, or a national court; each usable as the author_institution filter of eurlex_search_documents), Advocates General of a case-law record, date, English title, in-force flag, legal basis acts (work URI plus CELEX), and EuroVoc subjects (concept URI plus English label). A consolidated text keeps its own type, date, and title, and reports its base act (base_act_celex) with that act's authors, in-force flag, legal bases, and subjects.",
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

    // The CELEX resolves to one work first (#97): CELLAR holds some CELEX numbers
    // under several works, and a CELEX-keyed join would read the union of all of
    // them. Every metadata query then keys on the resolved work's IRI.
    //
    // A consolidated text records none of its act's metadata, so its authors,
    // in-force flag, legal bases, and subjects come from its linked base act
    // (#110), found by a lookup that runs alongside the resolution.
    const [resolved, consolidation] = await Promise.all([
      resolveCelexWorks(svc, [celexNumber], ctx),
      isConsolidatedCelex(celexNumber) ? findConsolidation(svc, celexNumber, ctx) : undefined,
    ]);
    const workUri = resolved.get(celexNumber);
    if (!workUri) {
      throw notFound(`No CELLAR work found for CELEX: ${celexNumber}`, { celexNumber });
    }
    const baseAct = consolidation?.base;
    const actWork = baseAct?.workUri ?? workUri;

    const sparql = `
SELECT ?type ?date ?title ?inForce WHERE {
  OPTIONAL { <${workUri}> cdm:work_has_resource-type ?type . }
  OPTIONAL { <${workUri}> cdm:work_date_document ?date . }
  OPTIONAL {
    ?expr cdm:expression_belongs_to_work <${workUri}> .
    ?expr cdm:expression_uses_language <${ENG_LANGUAGE_URI}> .
    ?expr cdm:expression_title ?title .
  }
  OPTIONAL { <${actWork}> cdm:resource_legal_in-force ?inForce . }
} LIMIT 5`;

    // Legal bases and EuroVoc subjects are fetched per dimension (never a
    // cross-product with the core rows) with their identifying literal joined as
    // an OPTIONAL, matching eurlex_get_document (#67). The resource has no
    // language input, so labels are English.
    const legalBasisSparql = `
SELECT ?legalBasis (SAMPLE(?celexValue) AS ?celex) WHERE {
  <${actWork}> cdm:resource_legal_based_on_resource_legal ?legalBasis .
  OPTIONAL { ?legalBasis cdm:resource_legal_id_celex ?celexValue . }
} GROUP BY ?legalBasis LIMIT ${DIMENSION_LIMIT}`;
    const eurovocSparql = `
SELECT ?eurovoc (SAMPLE(?labelValue) AS ?label) WHERE {
  <${actWork}> cdm:work_is_about_concept_eurovoc ?eurovoc .
  OPTIONAL {
    ?eurovoc skos:prefLabel ?labelValue .
    FILTER(LANG(?labelValue) = "en")
  }
} GROUP BY ?eurovoc LIMIT ${DIMENSION_LIMIT}`;

    // Authors come from their own query, shared with eurlex_get_document (#96),
    // never from rows cross-joined with the single-valued fields.
    const [bindings, agents, legalBasisBindings, eurovocBindings] = await Promise.all([
      svc.query(sparql, ctx),
      fetchWorkAgents(svc, actWork, ctx),
      svc.query(legalBasisSparql, ctx),
      svc.query(eurovocSparql, ctx),
    ]);

    const first = bindings[0];
    const result: Record<string, unknown> = { celex_number: celexNumber, work_uri: workUri };
    if (baseAct) result.base_act_celex = baseAct.celex;

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

    // The first institution is the primary author_institution, the full set is
    // author_institutions; Advocates General are listed on their own (#96).
    const [primaryInstitution] = agents.institutions;
    if (primaryInstitution) {
      result.author_institution = primaryInstitution;
      result.author_institutions = agents.institutions;
    }
    if (agents.advocatesGeneral.length > 0) result.advocates_general = agents.advocatesGeneral;

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
