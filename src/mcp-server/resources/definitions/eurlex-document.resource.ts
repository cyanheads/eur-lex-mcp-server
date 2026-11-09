/**
 * @fileoverview eurlex://document/{celexNumber} — Metadata snapshot for a CELLAR work.
 * @module mcp-server/resources/definitions/eurlex-document
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { actCitationQuery, readActCitation } from '@/services/cellar-sparql/act-citation.js';
import { ENG_LANGUAGE_URI, resolveResourceTypeLabel } from '@/services/cellar-sparql/cdm-labels.js';
import {
  CellarSparqlService,
  getCellarSparqlService,
} from '@/services/cellar-sparql/cellar-sparql-service.js';
import { CELEX_PATTERN, normalizeCelex } from '@/services/cellar-sparql/eli-resolution.js';
import { celexMissError, findHeldCelex } from '@/services/cellar-sparql/held-celex.js';
import { fetchLegislativeProcedures } from '@/services/cellar-sparql/legislative-procedures.js';
import {
  findConsolidation,
  isConsolidatedCelex,
} from '@/services/cellar-sparql/relation-traversal.js';
import { cellarDate, UNDATED_PLACEHOLDERS } from '@/services/cellar-sparql/sort-window.js';
import type { SparqlBinding } from '@/services/cellar-sparql/types.js';
import { fetchWorkAgents } from '@/services/cellar-sparql/work-agents.js';
import { resolveCelexWorks } from '@/services/cellar-sparql/work-resolution.js';
import { isCaseLawCelex } from '@/services/eurlex-content/act-structure.js';

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
  description: `Metadata snapshot for a CELLAR work by CELEX number — human-readable document type, authors by English authority label (an EU institution or body, a member state, an MEP, or a national court; each usable as the author_institution filter of eurlex_search_documents), Advocates General of a case-law record, date, English title, in-force flag, ELI (eli), Official Journal reference (oj_reference, e.g. OJ L 119, 4.5.2016, p. 1–88), every date of effect with its type and the clause that sets it (dates_of_effect: [{ date, type?, provision? }], type one of entry_into_force, application, partial_application, provisional_application, takes_effect, takes_partial_effect; provision e.g. Article 113(a), numbered as CELLAR records it), a directive's transposition deadlines (transposition_deadlines), each list leaving out the values CELLAR records for no date (${UNDATED_PLACEHOLDERS.join(', ')}) and reading CELLAR's dates, which can lag an amending act that moves one (eurlex_get_document names such an act and the current consolidated version, whose text states the dates that apply), legal basis acts (work URI plus CELEX), EuroVoc subjects (concept URI plus English label), and the legislative procedures the act belongs to, sorted (procedures: [{ reference, status?, withdrawal_date?, adopted_acts? }], reference e.g. 2021/0106(COD), status one of adopted, withdrawn, pending, not_adopted and absent when CELLAR flags none or several, withdrawal_date when CELLAR flags the procedure withdrawn, adopted_acts the CELEX numbers the procedure produced). A consolidated text keeps its own type, date, title, and ELI, and reports its base act (base_act_celex) with that act's authors, in-force flag, OJ reference, dates of effect, transposition deadlines, legal bases, subjects, and procedures.`,
  mimeType: 'application/json',
  params: z.object({
    celexNumber: z
      .string()
      .overwrite(normalizeCelex)
      .regex(
        CELEX_PATTERN,
        'celexNumber must be a CELEX identifier — a sector character followed by the year, type letters, and number (e.g. 32016R0679). Resolve a citation to its CELEX with eurlex_lookup_celex first.',
      )
      .describe(
        'CELEX number of the EU act (e.g. 32016R0679 for GDPR). Surrounding whitespace is trimmed and the value is uppercased before validation. A CELEX containing "/" (e.g. 11957A/PRO/CJ/09) cannot be addressed here — the URI template stops at the path separator, so fetch it with the eurlex_get_document tool instead.',
      ),
  }),

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No CELLAR work holds the CELEX number. One numbering convention away from a CELEX CELLAR holds — a consolidated CELEX with no date or a date no version carries, a (nn) suffix missing or extra, a number not zero-padded to four digits — each held CELEX is named in the message and in data.held_celex.',
      recovery:
        'Confirm the CELEX number with eurlex_lookup_celex, then read the resource again with the CELEX it returns.',
    },
    {
      reason: 'sparql_error',
      code: JsonRpcErrorCode.ValidationError,
      when: 'CELLAR rejected a query this read sent to resolve the CELEX or read its metadata.',
      recovery:
        'Fetch the same metadata with the eurlex_get_document tool, passing celex_number and content_mode "metadata_only".',
      thrownBy: 'service',
    },
    {
      reason: 'sparql_timeout',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: "A query this read sent to CELLAR ran past the time budget the read's queries share (retryable: CELLAR's response time varies, so a later read can finish), or CELLAR refused it as too costly to run (not retryable: the same query is refused again). Neither is retried within the read, apart from one re-send, inside the same budget, of a lookup CELLAR leaves unanswered for 20 s.",
      recovery:
        'When the error is retryable, read the resource again shortly; or fetch the metadata with the eurlex_get_document tool and content_mode "metadata_only".',
      thrownBy: 'service',
    },
  ],

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
      // A CELEX one numbering convention away from a held CELEX names it (#196).
      const miss = celexMissError(
        `No CELLAR work found for CELEX: ${celexNumber}`,
        await findHeldCelex(svc, celexNumber, ctx),
      );
      throw ctx.fail('not_found', miss.message, { celexNumber, ...miss.data }, miss.options);
    }
    const baseAct = consolidation?.base;
    const actWork = baseAct?.workUri ?? workUri;

    const sparql = `
SELECT ?type ?date ?title ?inForce
WHERE {
  OPTIONAL { <${workUri}> cdm:work_has_resource-type ?type . }
  OPTIONAL { <${workUri}> cdm:work_date_document ?date . }
  OPTIONAL {
    ?expr cdm:expression_belongs_to_work <${workUri}> .
    ?expr cdm:expression_uses_language <${ENG_LANGUAGE_URI}> .
    ?expr cdm:expression_title ?title .
  }
  OPTIONAL { <${actWork}> cdm:resource_legal_in-force ?inForce . }
} LIMIT 5`;
    // The citation facts (#169) come from their own query (#173), the one
    // eurlex_get_document runs: the served work's ELI, the act's OJ reference,
    // typed dates of effect, and transposition deadlines.
    const citationSparql = actCitationQuery(
      workUri,
      actWork,
      baseAct ? baseAct.celex : celexNumber,
    );

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
    // never from rows cross-joined with the single-valued fields. So do the
    // legislative procedures (#180), which no case-law work belongs to.
    const [bindings, citationBindings, agents, legalBasisBindings, eurovocBindings, procedures] =
      await Promise.all([
        svc.query(sparql, ctx),
        svc.query(citationSparql, ctx),
        fetchWorkAgents(svc, actWork, ctx),
        svc.query(legalBasisSparql, ctx),
        svc.query(eurovocSparql, ctx),
        isCaseLawCelex(celexNumber) ? [] : fetchLegislativeProcedures(svc, actWork, ctx),
      ]);

    const first = bindings[0];
    const result: Record<string, unknown> = { celex_number: celexNumber, work_uri: workUri };
    if (baseAct) result.base_act_celex = baseAct.celex;

    // Resolve the raw CDM authority URI to a human-readable label, matching the
    // eurlex_get_document tool (previously the resource leaked the raw URI).
    const resourceType = CellarSparqlService.bindingValue(first, 'type');
    if (resourceType) result.resource_type = resolveResourceTypeLabel(resourceType);
    const date = cellarDate(CellarSparqlService.bindingValue(first, 'date'));
    if (date) result.date = date;
    const title = CellarSparqlService.bindingValue(first, 'title');
    if (title) result.title = title;
    const inForce = CellarSparqlService.parseBoolean(
      CellarSparqlService.bindingValue(first, 'inForce'),
    );
    if (inForce !== undefined) result.in_force = inForce;
    Object.assign(result, readActCitation(citationBindings[0]));

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
    if (procedures.length > 0) result.procedures = procedures;

    return result;
  },
});
