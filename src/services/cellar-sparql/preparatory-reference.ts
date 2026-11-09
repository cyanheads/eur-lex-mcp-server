/**
 * @fileoverview Commission document numbers (`COM(2021) 206 final`, `SWD(2021) 84
 * final`) and interinstitutional procedure references (`2021/0106(COD)`) parsed and
 * resolved to the CELEX they name: a document number by the typed `comnat:` document
 * id CELLAR records on the work, a procedure reference by the typed reference literal
 * on its dossier, then the act that initiated the dossier — or, when no act with a
 * CELEX initiated it, the acts it produced.
 * @module services/cellar-sparql/preparatory-reference
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { CellarSparqlService } from './cellar-sparql-service.js';
import { escapeSparqlLiteral } from './eli-resolution.js';
import type { SparqlBinding } from './types.js';

/** The Commission document series that carry a `comnat:` id: no `C(…)` decision does. */
const DOCUMENT_SERIES = ['COM', 'SEC', 'SWD', 'JOIN'] as const;

type DocumentSeries = (typeof DOCUMENT_SERIES)[number];

/** A parsed Commission document number or interinstitutional procedure reference. */
export type PreparatoryReference =
  | {
      kind: 'document';
      series: DocumentSeries;
      year: string;
      /** Zero-padded to four digits, as every `comnat:` id writes it. */
      number: string;
      /** The `n` of `final/n` (the id's `_FINn`), empty for the first version. */
      version: string;
    }
  | {
      kind: 'procedure';
      year: string;
      /** The number without its zero padding: CELLAR pads a lettered number to three or four digits. */
      number: string;
      /** The letter of a split procedure (`2023/0077B`), empty when there is none. */
      suffix: string;
      /** The three-letter procedure type (`COD`, `NLE`, `CNS`, …), uppercased. */
      type: string;
    };

/** What CELLAR holds for a document number or procedure reference. */
export type PreparatoryResolution =
  | { kind: 'one'; celex: string }
  | { kind: 'several'; celex: readonly string[] }
  /** No work carries the document number, or no dossier the procedure reference. */
  | { kind: 'not_held' }
  /**
   * The procedure's dossier exists, but no act with a CELEX initiated it. `produced`
   * is the CELEX of each act its dossiers produced, sorted, empty when none has one.
   */
  | { kind: 'no_initiating_act'; produced: readonly string[] };

/*
 * Both patterns run on the value after `normalize`, so every separator is one space;
 * each is anchored at both ends and holds only bounded digit runs and single optional
 * characters, so it runs in time linear in the input. Case is ignored.
 */

/**
 * `COM(2021) 206 final`, `COM(2021)206`, `COM (2021) 0206`, `COM/2021/206 final`, and
 * `COM(2021) 278 final/2`, for COM, SEC, SWD, and JOIN. Groups: series, the year in
 * parentheses or between slashes (two digits read as 19YY), the number, the version.
 */
const DOCUMENT_NUMBER = new RegExp(
  `^(${DOCUMENT_SERIES.join('|')})(?: ?\\((\\d{2}|\\d{4})\\) ?|/(\\d{2}|\\d{4})/)(\\d{1,4})(?: final(?:/(\\d{1,2}))?)?$`,
  'i',
);

/**
 * `2021/0106(COD)`, `2021/106 (COD)`, `2021/0106/COD`, and a split procedure's
 * `2023/0077B(COD)`. Groups: year, number, letter, then the type in parentheses or
 * after a slash. A reference without its type (`2021/0106`) is not read: it shares
 * its shape with act numbers (`2016/679`), and a year and number alone can name
 * several dossiers.
 */
const PROCEDURE_REFERENCE = /^(\d{4})\/(\d{1,4})([a-z])? ?(?:\(([a-z]{3})\)|\/([a-z]{3}))$/i;

/** One space per whitespace run and one trailing period, the end of a sentence, dropped. */
function normalize(text: string): string {
  const value = text.trim().replace(/\s+/g, ' ');
  return value.endsWith('.') ? value.slice(0, -1) : value;
}

/**
 * The Commission document number or procedure reference `text` spells, or undefined
 * when it is neither. A Commission decision number (`C(2021) 4500 final`) is not
 * read, nor two references in one string.
 */
export function parsePreparatoryReference(text: string): PreparatoryReference | undefined {
  const value = normalize(text);
  const document = DOCUMENT_NUMBER.exec(value);
  const [, seriesText = '', parenthesizedYear, slashedYear, number = '', version = ''] =
    document ?? [];
  const series = DOCUMENT_SERIES.find((s) => s === seriesText.toUpperCase());
  if (series) {
    const yearText = parenthesizedYear ?? slashedYear ?? '';
    return {
      kind: 'document',
      series,
      year: yearText.length === 2 ? `19${yearText}` : yearText,
      number: number.padStart(4, '0'),
      version,
    };
  }
  const procedure = PROCEDURE_REFERENCE.exec(value);
  if (procedure) {
    const [, year = '', number = '', suffix = '', parenthesizedType, slashedType] = procedure;
    return {
      kind: 'procedure',
      year,
      number: String(Number(number)),
      suffix: suffix.toUpperCase(),
      type: (parenthesizedType ?? slashedType ?? '').toUpperCase(),
    };
  }
  return;
}

/** A reference spelled canonically: `COM(1990) 314 final`, `2021/0106(COD)`. */
export function preparatoryLabel(reference: PreparatoryReference): string {
  if (reference.kind === 'document') {
    const version = reference.version ? `/${reference.version}` : '';
    return `${reference.series}(${reference.year}) ${Number(reference.number)} final${version}`;
  }
  return `${reference.year}/${reference.number.padStart(4, '0')}${reference.suffix}(${reference.type})`;
}

/**
 * The part suffixes a document number can carry. Up to 2009 one number can span
 * parts `(01)`–`(67)` — sometimes beside a work holding the bare number — so the
 * bare id and every part `(01)`–`(99)` are sent together.
 */
const PART_SUFFIXES = [
  '',
  ...Array.from({ length: 99 }, (_, i) => `(${String(i + 1).padStart(2, '0')})`),
];

/**
 * The `comnat:` document ids a number can be recorded under:
 * `comnat:{SERIES}_{YYYY}_{NNNN}[(nn)]_FIN[n]`. Every id carries `_FIN`, so a citation
 * without "final" names the same document.
 */
export function commissionDocumentIds(
  reference: PreparatoryReference & { kind: 'document' },
): string[] {
  const { series, year, number, version } = reference;
  return PART_SUFFIXES.map((part) => `comnat:${series}_${year}_${number}${part}_FIN${version}`);
}

/**
 * The reference literals a procedure can be recorded under: `YYYY/NNNN/TYPE`, also
 * as `YYYY/NNNN(TYPE)` (a few budget procedures are stored so), and a lettered
 * number padded to both three and four digits (`2022/132A/COD`, `2023/0077B/COD`).
 */
export function procedureReferenceLiterals(
  reference: PreparatoryReference & { kind: 'procedure' },
): string[] {
  const { year, number, suffix, type } = reference;
  const numbers = suffix
    ? [...new Set([number.padStart(4, '0'), number.padStart(3, '0')])].map((n) => n + suffix)
    : [number.padStart(4, '0')];
  return numbers.flatMap((n) => [`${year}/${n}/${type}`, `${year}/${n}(${type})`]);
}

/** A list of typed `xsd:string` literals, the type CELLAR stores both identifiers under. */
function typedLiterals(values: readonly string[]): string {
  return values.map((v) => `"${escapeSparqlLiteral(v)}"^^xsd:string`).join(' ');
}

/** The CELEX of every work carrying one of the document number's ids. */
export function buildCommissionDocumentQuery(
  reference: PreparatoryReference & { kind: 'document' },
): string {
  return `
SELECT DISTINCT ?celex WHERE {
  VALUES ?documentId { ${typedLiterals(commissionDocumentIds(reference))} }
  ?work cdm:work_id_document ?documentId ;
    cdm:resource_legal_id_celex ?celex .
} LIMIT 100`;
}

/**
 * Each dossier carrying the procedure reference, with the CELEX of the act that
 * initiated it (`?celex`) and of each act it produced (`?producedCelex`, #190).
 * CELLAR records some initiating acts as the act's `…/resource/celex/` alias IRI
 * rather than its work, so the initiating CELEX is also read through the work
 * `owl:sameAs` that alias. A produced act is read directly, as
 * `procedures[].adopted_acts` reads it: no produced resource without a CELEX reaches
 * one through `owl:sameAs` (2026-11-09). The two reads are separate `OPTIONAL`s, so a
 * dossier with neither still answers one row, and one with no initiating act still
 * answers its produced acts. A stored reference answers at most 7 rows (2026-11-09),
 * far inside the `LIMIT`.
 */
export function buildProcedureQuery(
  reference: PreparatoryReference & { kind: 'procedure' },
): string {
  return `
SELECT DISTINCT ?dossier ?celex ?producedCelex WHERE {
  VALUES ?reference { ${typedLiterals(procedureReferenceLiterals(reference))} }
  ?dossier cdm:procedure_code_interinstitutional_reference_procedure ?reference .
  OPTIONAL {
    ?dossier cdm:dossier_initiated_by_act_preparatory ?initiator .
    { ?initiator cdm:resource_legal_id_celex ?celex . }
    UNION
    {
      ?initiatorWork <http://www.w3.org/2002/07/owl#sameAs> ?initiator ;
        cdm:resource_legal_id_celex ?celex .
    }
  }
  OPTIONAL {
    ?dossier cdm:dossier_produces_resource_legal ?produced .
    ?produced cdm:resource_legal_id_celex ?producedCelex .
  }
} LIMIT 100`;
}

/** The distinct values `variable` binds across `rows`, sorted. */
function sortedValues(rows: readonly SparqlBinding[], variable: string): string[] {
  return [...new Set(rows.flatMap((row) => row[variable]?.value ?? []))].sort();
}

/** One CELEX resolves, several are named, none is undefined. */
function byCelex(rows: readonly SparqlBinding[]): PreparatoryResolution | undefined {
  const celex = sortedValues(rows, 'celex');
  const [only] = celex;
  if (only === undefined) return;
  return celex.length === 1 ? { kind: 'one', celex: only } : { kind: 'several', celex };
}

/**
 * Resolve a parsed reference against CELLAR in one query. A procedure held by several
 * dossiers (`2000/0247(ACC)`) or opened by several acts names each CELEX, as does a
 * document number held in parts. A procedure that no act with a CELEX initiated
 * carries the acts every dossier holding it produced (#190); one with an initiating
 * act resolves to that act alone.
 */
export async function resolvePreparatoryReference(
  svc: Pick<CellarSparqlService, 'query'>,
  reference: PreparatoryReference,
  ctx: Context,
): Promise<PreparatoryResolution> {
  if (reference.kind === 'document') {
    const rows = await svc.query(buildCommissionDocumentQuery(reference), ctx);
    return byCelex(rows) ?? { kind: 'not_held' };
  }
  const rows = await svc.query(buildProcedureQuery(reference), ctx);
  if (rows.length === 0) return { kind: 'not_held' };
  return (
    byCelex(rows) ?? { kind: 'no_initiating_act', produced: sortedValues(rows, 'producedCelex') }
  );
}
