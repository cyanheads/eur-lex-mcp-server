/**
 * @fileoverview The CELEX numbers CELLAR holds one numbering convention away from a
 * CELEX that names no work (#196): a consolidated CELEX with no date or a date no
 * version carries, a CELEX missing or carrying a `(nn)` sibling ordinal, and a number
 * not zero-padded to four digits. A miss sends one query of exact typed literals to
 * name them; a CELEX that names a work never reaches it.
 * @module services/cellar-sparql/held-celex
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { CellarSparqlService } from './cellar-sparql-service.js';
import { celexLiteral, escapeSparqlLiteral, isValidCalendarDate } from './eli-resolution.js';
import { CELEX_TYPE_CODES, type CelexSector, FIRST_CELEX_YEAR } from './keyword-match.js';
import type { ConsolidationBase } from './relation-traversal.js';
import type { SparqlBinding } from './types.js';

/**
 * A CELEX read as sector, year, type letters, a number of one to four digits, an
 * optional `(nn)` sibling ordinal, and a `-YYYYMMDD` consolidation date. Anchored,
 * with every quantifier bounded, so a value fails within its first characters
 * however long it is.
 */
const CELEX_PARTS = /^([0-9E])(\d{4})([A-Z]{1,4})(\d{1,4})(\(\d{2}\))?(?:-(\d{8}))?$/;

/**
 * The sectors a consolidated text's base act sits in. Of 33,267 sector-0
 * consolidations with a based-on link, 33,231 share their base act's characters
 * after the sector, and those base acts are all in sector 1, 2, 3, 4, 5, or E
 * (2026-11-09). The other 36 (`32000O0007`, consolidated as `02000X0776-…`) cannot
 * be derived and stay plain misses.
 */
const BASE_SECTORS = ['1', '2', '3', '4', '5', 'E'] as const satisfies readonly CelexSector[];

/**
 * The `(nn)` sibling ordinals, `(01)`–`(99)`: a live survey of the ordinals CELLAR
 * files runs to `(99)` in sector 5, `(73)` in sector 2, and `(61)` in sector 3
 * (2026-11-09).
 */
const SIBLING_ORDINALS = Array.from(
  { length: 99 },
  (_, i) => `(${String(i + 1).padStart(2, '0')})`,
);

const LIST = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

/** What a CELEX that names no work is looked up as. */
export type CelexMissReading =
  /**
   * A consolidated CELEX: its base act under each sector a base can sit in, and the
   * core (the CELEX before its date) its consolidated versions must start with.
   */
  | { bases: string[]; core: string; date?: string; kind: 'consolidated' }
  /** Any other CELEX: the forms one numbering convention away. */
  | { forms: string[]; kind: 'act' };

/**
 * How a CELEX that names no work is looked up (#196), or undefined when it does not
 * read as a sector, a year from {@link FIRST_CELEX_YEAR} through next year, a type
 * code of that sector, and a number, and so sends no query.
 *
 * - **Sector 0** (`02014R0833`, `02006R1907-20260101`): the same characters after the
 *   sector, before any date, under each of {@link BASE_SECTORS} whose type codes hold
 *   the type. The date must be a calendar date.
 * - **Any other sector**: `(01)`–`(99)` after a CELEX with no `(nn)` (`52026AG0012`),
 *   the CELEX without its `(nn)` (`62009CJ0197(01)`), and a number of one to three
 *   digits zero-padded to four (`32023R138`). Conventions are not composed:
 *   `32023R138` gets no `(nn)` on its padded number.
 */
export function readCelexMiss(celex: string): CelexMissReading | undefined {
  const parts = CELEX_PARTS.exec(celex);
  if (!parts) return;
  const [, sector = '', year = '', type = '', number = '', ordinal = '', date] = parts;
  const lastYear = new Date().getUTCFullYear() + 1;
  if (Number(year) < FIRST_CELEX_YEAR || Number(year) > lastYear) return;
  const holdsType = (s: CelexSector) => (CELEX_TYPE_CODES[s] as readonly string[]).includes(type);
  if (!holdsType(sector as CelexSector)) return;

  if (sector === '0') {
    const isoDate = date && `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}`;
    if (isoDate && !isValidCalendarDate(isoDate)) return;
    const core = date ? celex.slice(0, -(date.length + 1)) : celex;
    const bases = BASE_SECTORS.filter(holdsType).map((s) => `${s}${core.slice(1)}`);
    return { kind: 'consolidated', core, bases, ...(isoDate ? { date: isoDate } : {}) };
  }
  if (date) return;
  const stem = `${sector}${year}${type}${number}`;
  const forms = ordinal ? [stem] : SIBLING_ORDINALS.map((o) => `${stem}${o}`);
  if (number.length < 4) forms.push(`${sector}${year}${type}${number.padStart(4, '0')}${ordinal}`);
  return { kind: 'act', forms };
}

/** The CELEX of every work among `forms`, one row each. */
function heldFormsQuery(forms: readonly string[]): string {
  return `
SELECT DISTINCT ?heldCelex WHERE {
  VALUES ?heldCelex { ${forms.map(celexLiteral).join(' ')} }
  ?heldWork cdm:resource_legal_id_celex ?heldCelex .
}`;
}

/**
 * One row per base act CELLAR holds among `reading.bases` with a consolidated
 * version: its newest version on or before today, on or before the requested date,
 * and whether any version's CELEX starts with the requested core. A version is a
 * `date|CELEX` composite, so `MAX` orders by date and then CELEX, as the
 * consolidation lookup does, and reads `""` when no version qualifies. `STRSTARTS`
 * reads only the base act's own versions, never every CELEX literal. Grouped on the
 * CELEX, which bounds the rows by the `VALUES` list.
 */
function baseVersionsQuery(
  reading: Extract<CelexMissReading, { kind: 'consolidated' }>,
  today: string,
): string {
  const newestBy = (date: string) =>
    `MAX(IF(STR(?consolidationDate) <= "${date}", CONCAT(STR(?consolidationDate), "|", STR(?consolidationCelex)), ""))`;
  const inEffect = reading.date ? `\n  (${newestBy(reading.date)} AS ?inEffect)` : '';
  return `
SELECT ?baseCelex (MIN(STR(?baseWork)) AS ?baseWorkUri)
  (${newestBy(today)} AS ?current)${inEffect}
  (MAX(IF(STRSTARTS(STR(?consolidationCelex), "${escapeSparqlLiteral(reading.core)}-"), 1, 0)) AS ?carriesCore)
WHERE {
  VALUES ?baseCelex { ${reading.bases.map(celexLiteral).join(' ')} }
  ?baseWork cdm:resource_legal_id_celex ?baseCelex .
  ?consolidation cdm:act_consolidated_based_on_resource_legal ?baseWork ;
    cdm:resource_legal_id_celex ?consolidationCelex ;
    cdm:act_consolidated_date ?consolidationDate .
} GROUP BY ?baseCelex`;
}

/** A consolidated version: its CELEX and consolidation date, ISO 8601. */
interface Version {
  asOf: string;
  celex: string;
}

/** A `date|CELEX` composite as a version, or undefined for `""`. */
function readVersion(composite: string | undefined): Version | undefined {
  const [date, celex] = composite?.split('|') ?? [];
  return date && celex ? { asOf: date.slice(0, 10), celex } : undefined;
}

/** What a CELEX miss found one numbering convention away. */
export type HeldCelex =
  /** No query was sent, or CELLAR holds no such form. */
  | { kind: 'none' }
  /** CELLAR did not answer the lookup, so whether it holds one went unchecked. */
  | { kind: 'unchecked'; sentence: string }
  | {
      /**
       * Each held CELEX, to pass back in place of the one sent: sorted, or for a
       * consolidated CELEX by base act, its version in effect on the requested date
       * before its current one.
       */
      celex: string[];
      /**
       * For a consolidated CELEX: the current version of the one base act whose
       * versions carry its core, which resolve "current_consolidated" serves. Absent
       * when several base acts do, or that one has no version in effect.
       */
      current?: Version & { base: ConsolidationBase };
      kind: 'held';
      /** Every CELEX the sentence names, the requested one first: the error's literals. */
      named: string[];
      /** A sentence naming each held CELEX and what it is. */
      sentence: string;
    };

const UNCHECKED_SENTENCE =
  'CELLAR did not answer whether it holds a CELEX one numbering convention away; call again to check.';

/**
 * Look up the CELEX CELLAR holds one numbering convention away from `celex`, a CELEX
 * no work holds (#196), in one query; `{ kind: 'none' }` without a query when
 * {@link readCelexMiss} does not read it.
 *
 * The miss is already established, so a CELLAR that does not answer — the call's
 * time budget spent, an outage — leaves the forms unchecked rather than failing the
 * call (`unchecked`, with a sentence saying so). A caller's cancellation and a query
 * CELLAR rejects propagate.
 */
export async function findHeldCelex(
  svc: Pick<CellarSparqlService, 'query'>,
  celex: string,
  ctx: Context,
): Promise<HeldCelex> {
  const reading = readCelexMiss(celex);
  if (!reading) return { kind: 'none' };
  const today = new Date().toISOString().slice(0, 10);
  let rows: SparqlBinding[];
  try {
    rows = await svc.query(
      reading.kind === 'act' ? heldFormsQuery(reading.forms) : baseVersionsQuery(reading, today),
      ctx,
    );
  } catch (error) {
    if (
      ctx.signal.aborted ||
      !(error instanceof McpError) ||
      error.code !== JsonRpcErrorCode.ServiceUnavailable
    ) {
      throw error;
    }
    return { kind: 'unchecked', sentence: UNCHECKED_SENTENCE };
  }
  return reading.kind === 'act' ? heldForms(celex, rows) : heldVersions(celex, reading, rows);
}

function heldForms(celex: string, rows: SparqlBinding[]): HeldCelex {
  const held = [
    ...new Set(rows.flatMap((row) => CellarSparqlService.bindingValue(row, 'heldCelex') ?? [])),
  ].sort();
  if (held.length === 0) return { kind: 'none' };
  return {
    kind: 'held',
    celex: held,
    named: [celex, ...held],
    sentence: `CELLAR holds ${LIST.format(held)}.`,
  };
}

function heldVersions(
  celex: string,
  reading: Extract<CelexMissReading, { kind: 'consolidated' }>,
  rows: SparqlBinding[],
): HeldCelex {
  const value = (row: SparqlBinding, field: string) => CellarSparqlService.bindingValue(row, field);
  const bases = rows
    .flatMap((row) => {
      const baseCelex = value(row, 'baseCelex');
      const workUri = value(row, 'baseWorkUri');
      if (!baseCelex || !workUri || value(row, 'carriesCore') !== '1') return [];
      const current = readVersion(value(row, 'current'));
      const inEffect = readVersion(value(row, 'inEffect'));
      return current || inEffect
        ? [{ base: { celex: baseCelex, workUri }, current, inEffect }]
        : [];
    })
    .sort((a, b) => (a.base.celex < b.base.celex ? -1 : 1));
  if (bases.length === 0) return { kind: 'none' };

  const clauses = bases.map(({ base, current, inEffect }) => {
    const onDate = `the consolidated version of ${base.celex} in effect on ${reading.date}`;
    if (!inEffect) return `${current?.celex}, the current consolidated version of ${base.celex}`;
    if (!current) return `${inEffect.celex}, ${onDate}`;
    return inEffect.celex === current.celex
      ? `${current.celex}, ${onDate} and its current one`
      : `${inEffect.celex}, ${onDate}, and ${current.celex}, its current one`;
  });
  const held = [
    ...new Set(bases.flatMap(({ current, inEffect }) => [inEffect?.celex, current?.celex])),
  ].filter((c): c is string => c !== undefined);
  const last = clauses.pop();
  const [only] = bases;
  return {
    kind: 'held',
    celex: held,
    named: [...new Set([celex, ...held, ...bases.map(({ base }) => base.celex)])],
    sentence: `CELLAR holds ${clauses.length > 0 ? `${clauses.join('; ')}; and ${last}` : last}.`,
    ...(bases.length === 1 && only?.current
      ? { current: { ...only.current, base: only.base } }
      : {}),
  };
}

/**
 * The `not_found` a CELEX miss fails with: `message`, then the sentence naming what
 * CELLAR holds and `data.held_celex` listing it, with every CELEX named passed as a
 * literal so `content[]` renders each as code. A miss with nothing held keeps
 * `message` as given.
 */
export function celexMissError(
  message: string,
  held: HeldCelex,
): {
  data: { held_celex?: string[] };
  message: string;
  options: { literals?: readonly string[] };
} {
  switch (held.kind) {
    case 'none':
      return { message, data: {}, options: {} };
    case 'unchecked':
      return { message: `${message}. ${held.sentence}`, data: {}, options: {} };
    case 'held':
      return {
        message: `${message}. ${held.sentence}`,
        data: { held_celex: held.celex },
        options: { literals: held.named },
      };
  }
}
