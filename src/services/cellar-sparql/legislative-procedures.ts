/**
 * @fileoverview The interinstitutional procedures an act belongs to — each one's
 * reference, its status (adopted, withdrawn, pending, not adopted), its withdrawal
 * date, and the acts it produced. Shared by eurlex_get_document and the
 * eurlex://document/{celexNumber} resource so both surfaces read them identically.
 * @module services/cellar-sparql/legislative-procedures
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { CellarSparqlService } from './cellar-sparql-service.js';

/** A procedure's status, from the one CELLAR flag set true on its dossier. */
export const PROCEDURE_STATUS_VALUES = ['adopted', 'withdrawn', 'pending', 'not_adopted'] as const;

/** One procedure status. */
export type ProcedureStatus = (typeof PROCEDURE_STATUS_VALUES)[number];

/** One interinstitutional procedure; each optional field is absent when CELLAR records none. */
export interface LegislativeProcedure {
  /** CELEX of each act the procedure produced, sorted. */
  adopted_acts?: string[];
  /** The reference in its cited form, `2021/0106(COD)`, or verbatim in any other shape. */
  reference: string;
  status?: ProcedureStatus;
  /** `cdm:dossier_date_withdrawn`, on a procedure flagged withdrawn. */
  withdrawal_date?: string;
}

/** The variable each status flag aggregates into, and the status it sets. */
const STATUS_FLAGS = [
  ['adopted', 'adopted'],
  ['withdrawn', 'withdrawn'],
  ['pending', 'pending'],
  ['notAdopted', 'not_adopted'],
] as const satisfies readonly (readonly [string, ProcedureStatus])[];

/**
 * A reference as CELLAR stores it, `YYYY/NUMBER/TYPE` (`2017/0003/COD`, `2011/341A/COD`).
 * Anchored, with each quantified class bounded by a literal `/` it cannot match, so
 * it runs in linear time: no quantifier is nested and no two runs overlap.
 */
const STORED_REFERENCE = /^(\d{4})\/([0-9A-Z]+)\/([A-Z]+)$/;

/**
 * The cited form of a reference: `YYYY/NUMBER(TYPE)`, the number kept as CELLAR
 * writes it (`2011/341A(COD)`). Any other shape — already cited (`2010/2001(BUD)`),
 * or with no type (`2008/0073/`) — is returned verbatim.
 */
function citedReference(stored: string): string {
  const match = STORED_REFERENCE.exec(stored);
  return match ? `${match[1]}/${match[2]}(${match[3]})` : stored;
}

/**
 * Read the interinstitutional procedures of `actWork` in one query: the dossiers
 * carrying a procedure reference that the work is part of
 * (`cdm:work_part_of_dossier`, the link a proposal carries), that produced it
 * (`cdm:dossier_produces_resource_legal`, the only link most adopted acts carry), or
 * that it initiated (`cdm:dossier_initiated_by_act_preparatory`, the only link many
 * initiating proposals carry — and the one eurlex_lookup_celex resolves a procedure
 * reference through, so a proposal it names lists that procedure here).
 * Grouped per dossier, each status flag and the withdrawal date aggregate over
 * `STR()` and the produced acts' CELEX numbers concatenate. The query has no
 * `LIMIT`: the work's own dossiers bound it, at most 32 on any work.
 *
 * `status` is the one flag set true; with none or several true it is absent, since
 * CELLAR then says nothing or contradicts itself. The flags are read rather than
 * `procedure_code_interinstitutional_has_status_file-status`, which still reads
 * pending on every withdrawn dossier carrying it. No adoption date is read:
 * `cdm:dossier_date_adopted` is often the Official Journal date and can be
 * multi-valued. Procedures come back sorted by reference; a work in none yields `[]`.
 */
export async function fetchLegislativeProcedures(
  svc: Pick<CellarSparqlService, 'query'>,
  actWork: string,
  ctx: Context,
): Promise<LegislativeProcedure[]> {
  const query = `
SELECT ?procedureRef
  (MAX(STR(?adoptedFlag)) AS ?adopted)
  (MAX(STR(?withdrawnFlag)) AS ?withdrawn)
  (MAX(STR(?pendingFlag)) AS ?pending)
  (MAX(STR(?notAdoptedFlag)) AS ?notAdopted)
  (MIN(STR(?withdrawalDateValue)) AS ?withdrawalDate)
  (GROUP_CONCAT(DISTINCT STR(?adoptedCelex); separator=" ") AS ?adoptedActs)
WHERE {
  { <${actWork}> cdm:work_part_of_dossier ?procedure . }
  UNION
  { ?procedure cdm:dossier_produces_resource_legal <${actWork}> . }
  UNION
  { ?procedure cdm:dossier_initiated_by_act_preparatory <${actWork}> . }
  ?procedure cdm:procedure_code_interinstitutional_reference_procedure ?procedureRef .
  OPTIONAL { ?procedure cdm:dossier_adopted-proposal ?adoptedFlag . }
  OPTIONAL { ?procedure cdm:dossier_withdrawn-proposal ?withdrawnFlag . }
  OPTIONAL { ?procedure cdm:dossier_pending-proposal ?pendingFlag . }
  OPTIONAL { ?procedure cdm:dossier_not-adopted-proposal ?notAdoptedFlag . }
  OPTIONAL { ?procedure cdm:dossier_date_withdrawn ?withdrawalDateValue . }
  OPTIONAL {
    ?procedure cdm:dossier_produces_resource_legal ?adoptedAct .
    ?adoptedAct cdm:resource_legal_id_celex ?adoptedCelex .
  }
} GROUP BY ?procedure ?procedureRef`;

  const procedures: LegislativeProcedure[] = [];
  for (const b of await svc.query(query, ctx)) {
    const stored = CellarSparqlService.bindingValue(b, 'procedureRef');
    if (!stored) continue;
    const flagged = STATUS_FLAGS.filter(
      ([variable]) =>
        CellarSparqlService.parseBoolean(CellarSparqlService.bindingValue(b, variable)) === true,
    );
    const status = flagged.length === 1 ? flagged[0]?.[1] : undefined;
    const withdrawalDate = flagged.some(([variable]) => variable === 'withdrawn')
      ? CellarSparqlService.bindingValue(b, 'withdrawalDate')?.slice(0, 10)
      : undefined;
    const adoptedActs = [
      ...new Set((CellarSparqlService.bindingValue(b, 'adoptedActs') ?? '').split(' ')),
    ]
      .filter(Boolean)
      .sort();
    procedures.push({
      reference: citedReference(stored),
      ...(status ? { status } : {}),
      ...(withdrawalDate ? { withdrawal_date: withdrawalDate } : {}),
      ...(adoptedActs.length > 0 ? { adopted_acts: adoptedActs } : {}),
    });
  }
  return procedures.sort((a, b) =>
    a.reference < b.reference ? -1 : a.reference > b.reference ? 1 : 0,
  );
}
