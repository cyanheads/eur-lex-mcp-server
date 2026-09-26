/**
 * @fileoverview Consolidated texts and their base acts as CELLAR held them on
 * 2026-09-25, plus a fake that answers the queries `eurlex_get_document` and the
 * `eurlex://document` resource issue about them. Each query is answered the way
 * CELLAR evaluates it as written: a column is bound only when the query carries the
 * pattern that binds it, and each date filter, OPTIONAL, `ORDER BY`, and `LIMIT`
 * applies only when present, so a query that leaves one out gets the rows CELLAR
 * would give it.
 * @module tests/fixtures/cellar-consolidations
 */

import { CELLAR, isResolutionQuery, requestedCelex } from './cellar-works.js';

type Row = Record<string, { type: string; value: string }>;

const CB = 'http://publications.europa.eu/resource/authority/corporate-body/';
const RT = 'http://publications.europa.eu/resource/authority/resource-type/';

/** English `skos:prefLabel` of each authority code the fixture works name as author. */
const AGENT_LABELS: ReadonlyMap<string, string> = new Map(
  Object.entries({
    EP: 'European Parliament',
    CONSIL: 'Council of the European Union',
    COM: 'European Commission',
    ECB: 'European Central Bank',
    CYP: 'Cyprus',
    CZE: 'Czechia',
    OP_DATPRO: 'Provisional data',
  }).map(([code, label]) => [`${CB}${code}`, label]),
);

/** One CELLAR work in the fixture set. */
export interface FixtureAct {
  /** Base act work, via `cdm:act_consolidated_based_on_resource_legal`. */
  basedOn?: string;
  /** `cdm:act_consolidated_date`, on a consolidated text. */
  consolidatedDate?: string;
  /** `cdm:work_created_by_agent` authority codes. */
  creators: string[];
  date: string;
  /**
   * `cdm:resource_legal_date_end-of-validity` values; a few acts carry a real date
   * alongside the open-ended placeholder.
   */
  endOfValidity?: string[];
  /** `cdm:resource_legal_date_entry-into-force` values; an act can enter into force in stages. */
  entryIntoForce?: string[];
  eurovoc: string[];
  inForce?: '0' | '1';
  legalBases: string[];
  /**
   * CELEX of each work whose `cdm:resource_legal_repeals_resource_legal` names this
   * one; `null` for a repealing work that carries no CELEX.
   */
  repealedBy?: (string | null)[];
  title: string;
  type: string;
  uri: string;
}

const base = (
  uri: string,
  date: string,
  inForce: '0' | '1',
  creators: string[],
  eurovocCount: number,
  legalBasisCount: number,
  type = 'REG',
): FixtureAct => ({
  uri,
  type: `${RT}${type}`,
  date,
  title: `Base act ${uri.slice(-8)}`,
  inForce,
  creators: creators.map((c) => `${CB}${c}`),
  eurovoc: Array.from(
    { length: eurovocCount },
    (_, i) => `http://eurovoc.europa.eu/${uri.slice(-4)}${i}`,
  ),
  legalBases: Array.from(
    { length: legalBasisCount },
    (_, i) => `${CELLAR}basis-${uri.slice(-4)}-${i}`,
  ),
});

const consolidation = (
  uri: string,
  basedOn: string | undefined,
  consolidatedDate: string,
): FixtureAct => ({
  uri,
  type: `${RT}CONS_TEXT`,
  date: consolidatedDate,
  title: `Consolidated text of ${consolidatedDate}`,
  consolidatedDate,
  ...(basedOn ? { basedOn } : {}),
  creators: [`${CB}OP_DATPRO`],
  eurovoc: [],
  legalBases: [],
});

/** Work URIs of the base acts (live values where the probes read them). */
export const WORK = {
  aiAct: `${CELLAR}dc8116a1-3fe6-11ef-865a-01aa75ed71a1`,
  gdpr: `${CELLAR}3e485e15-11bd-11e6-ba9a-01aa75ed71a1`,
  schengen: `${CELLAR}fixture-22006A0901(01)`,
  ecbGuideline: `${CELLAR}fbe3f849-dcbb-4ba5-8b3e-37238df7d1e4`,
  ets: `${CELLAR}4a34193b-60ed-4106-8e2f-2e06386af029`,
  accession: `${CELLAR}fixture-12003T-TXT`,
  reg1422: `${CELLAR}fixture-31995R1422`,
  unconsolidated: `${CELLAR}fixture-32026R2099`,
  celexlessBase: `${CELLAR}fixture-celexless-base`,
  dataProtectionDirective: `${CELLAR}775a4724-2086-4a06-9213-1a4e6489053b`,
  partlyRepealed: `${CELLAR}fixture-32003R1882`,
  unexplained: `${CELLAR}fixture-31990R0001`,
  expired2002: `${CELLAR}fixture-32000D0670`,
  expired2024: `${CELLAR}fixture-32020D1531`,
  pendingWithEnd: `${CELLAR}fixture-32026R1975`,
  pendingConsolidationOnly: `${CELLAR}fixture-32021D1442`,
} as const;

/** An act's in-force reasons (#111): entry into force, end of validity, repealers. */
const withReasons = (
  act: FixtureAct,
  reasons: Pick<FixtureAct, 'endOfValidity' | 'entryIntoForce' | 'repealedBy'>,
): FixtureAct => ({ ...act, ...reasons });

/** CELLAR's end-of-validity placeholder for an act with no end date. */
const OPEN_ENDED = '9999-12-31';

/** Every fixture work, keyed by CELEX. */
export const ACTS: Record<string, FixtureAct> = {
  '32024R1689': base(WORK.aiAct, '2024-06-13', '1', ['EP', 'CONSIL'], 7, 2),
  '02024R1689-20260727': consolidation(
    `${CELLAR}b1730fb2-8f1c-11f1-9262-01aa75ed71a1`,
    WORK.aiAct,
    '2026-07-27',
  ),
  '02024R1689-20240712': consolidation(
    `${CELLAR}b93c5306-b410-11f0-b37f-01aa75ed71a1`,
    WORK.aiAct,
    '2024-07-12',
  ),
  '32016R0679': withReasons(base(WORK.gdpr, '2016-04-27', '1', ['EP', 'CONSIL'], 5, 1), {
    entryIntoForce: ['2018-05-25', '2016-05-24'],
    endOfValidity: [OPEN_ENDED],
  }),
  '02016R0679-20160504': consolidation(`${CELLAR}fixture-02016R0679`, WORK.gdpr, '2016-05-04'),
  '22006A0901(01)': base(WORK.schengen, '2006-09-01', '1', ['CONSIL'], 4, 1, 'AGREE_INTERNATION'),
  '02006A0901(01)-20090301': consolidation(
    `${CELLAR}fixture-02006A0901(01)`,
    WORK.schengen,
    '2009-03-01',
  ),
  '32000O0007': base(WORK.ecbGuideline, '2000-08-31', '0', ['ECB'], 3, 1, 'GUIDELINE'),
  '02000X0776-20110201': consolidation(
    `${CELLAR}fixture-02000X0776-2011`,
    WORK.ecbGuideline,
    '2011-02-01',
  ),
  '02000X0776-20090511': consolidation(
    `${CELLAR}fixture-02000X0776-2009`,
    WORK.ecbGuideline,
    '2009-05-11',
  ),
  '02000O0007-20120101': consolidation(
    `${CELLAR}fixture-02000O0007-2012`,
    WORK.ecbGuideline,
    '2012-01-01',
  ),
  '32002L0087': base(WORK.ets, '2003-10-13', '1', ['EP', 'CONSIL'], 6, 1, 'DIR'),
  '02002L0087-20240109': consolidation(`${CELLAR}fixture-02002L0087-2024`, WORK.ets, '2024-01-09'),
  '02002L0087-20270130': consolidation(`${CELLAR}fixture-02002L0087-2027`, WORK.ets, '2027-01-30'),
  '12003T/TXT': base(WORK.accession, '2003-04-16', '1', ['CYP', 'CZE'], 9, 0, 'TREATY'),
  '02003T0000-20040501': consolidation(`${CELLAR}fixture-02003T0000`, WORK.accession, '2004-05-01'),
  '31995R1422': withReasons(base(WORK.reg1422, '1995-06-23', '0', ['CONSIL'], 4, 1), {
    endOfValidity: ['2006-06-30'],
    repealedBy: ['32006R0951'],
  }),
  '01995R1422-20060701': consolidation(`${CELLAR}fixture-01995R1422`, WORK.reg1422, '2006-07-01'),
  /** Dated 2026-09-21, in force from 2026-10-12 in three stages. */
  '32026R2099': withReasons(base(WORK.unconsolidated, '2026-09-21', '0', ['COM'], 3, 1), {
    entryIntoForce: ['2027-03-26', '2026-10-12', '2029-03-26'],
    endOfValidity: [OPEN_ENDED],
  }),
  /** Repealed by the GDPR. */
  '31995L0046': withReasons(
    base(WORK.dataProtectionDirective, '1995-10-24', '0', ['EP', 'CONSIL'], 6, 2, 'DIR'),
    { entryIntoForce: ['1995-12-13'], endOfValidity: ['2018-05-24'], repealedBy: ['32016R0679'] },
  ),
  '01995L0046-20180525': consolidation(
    `${CELLAR}fixture-01995L0046`,
    WORK.dataProtectionDirective,
    '2018-05-25',
  ),
  /** In force, yet the target of three partial repeals. */
  '32003R1882': withReasons(base(WORK.partlyRepealed, '2003-09-29', '1', ['EP', 'CONSIL'], 3, 1), {
    entryIntoForce: ['2003-11-20'],
    endOfValidity: [OPEN_ENDED],
    repealedBy: ['32009R0217', '32008R1101', '32012R0528'],
  }),
  /**
   * Not in force with no reason CELLAR can name: entered into force long ago, open
   * validity, and repealed only by a work with no CELEX.
   */
  '31990R0001': withReasons(base(WORK.unexplained, '1990-01-01', '0', ['CONSIL'], 1, 0), {
    entryIntoForce: ['1990-01-04'],
    endOfValidity: [OPEN_ENDED],
    repealedBy: [null],
  }),
  /** Not in force; a real end of validity recorded alongside the open-ended placeholder. */
  '32000D0670': withReasons(base(WORK.expired2002, '2000-10-19', '0', ['COM'], 2, 1, 'DEC'), {
    endOfValidity: [OPEN_ENDED, '2002-12-31'],
  }),
  '32020D1531': withReasons(
    base(WORK.expired2024, '2020-10-21', '0', ['EP', 'CONSIL'], 2, 1, 'DEC'),
    { endOfValidity: ['2024-03-17', OPEN_ENDED], repealedBy: ['32024D0867'] },
  ),
  /** Not yet in force, with a validity that already has an end date ahead. */
  '32026R1975': withReasons(base(WORK.pendingWithEnd, '2026-09-08', '0', ['COM'], 2, 1), {
    entryIntoForce: ['2026-09-29'],
    endOfValidity: ['2030-12-31'],
  }),
  /** Its only consolidated version is dated after 2026-09-25. */
  '32021D1442': base(WORK.pendingConsolidationOnly, '2021-08-03', '1', ['ECB'], 2, 1, 'DEC'),
  '02021D1442-20261001': consolidation(
    `${CELLAR}fixture-02021D1442`,
    WORK.pendingConsolidationOnly,
    '2026-10-01',
  ),
  /** A consolidated text with no based-on link (31 such works on CELLAR). */
  '02099R9999-20200101': consolidation(`${CELLAR}fixture-unlinked`, undefined, '2020-01-01'),
  /** A consolidated text whose base work carries no CELEX (44 on CELLAR). */
  '02098R9998-20200101': consolidation(
    `${CELLAR}fixture-celexless-cons`,
    WORK.celexlessBase,
    '2020-01-01',
  ),
};

/** A base work with no CELEX: reachable only by IRI. */
const CELEXLESS_BASE = base(WORK.celexlessBase, '2019-01-01', '1', ['COM'], 2, 1);

const byUri = new Map<string, { celex?: string; act: FixtureAct }>([
  ...Object.entries(ACTS).map(([celex, act]) => [act.uri, { celex, act }] as const),
  [CELEXLESS_BASE.uri, { act: CELEXLESS_BASE }],
]);

const uri = (value: string) => ({ type: 'uri', value });
const literal = (value: string) => ({ type: 'literal', value });

/** The fixture work a work-keyed query reads, by the first work IRI it names. */
function addressedAct(sparql: string): FixtureAct | undefined {
  for (const [workUri, { act }] of byUri) {
    if (sparql.includes(`<${workUri}>`)) return act;
  }
  return;
}

/** The typed CELEX literal bound to `variable` in `?variable cdm:resource_legal_id_celex "…"`. */
function keyedCelex(sparql: string, variable: string): string | undefined {
  const m = new RegExp(`\\?${variable} cdm:resource_legal_id_celex "([^"]+)"\\^\\^xsd:string`).exec(
    sparql,
  );
  return m?.[1];
}

/** The consolidations of `baseWork`, in descending CELEX order. */
function consolidationsOf(baseWork: string): { celex: string; date: string }[] {
  return Object.entries(ACTS)
    .filter(([, a]) => a.basedOn === baseWork)
    .map(([celex, a]) => ({ celex, date: a.consolidatedDate as string }))
    .sort((a, b) => b.celex.localeCompare(a.celex));
}

/** A lookup query's `FILTER(STR(?variable) op "date")` bound, when it carries one. */
function dateBound(sparql: string, variable: string, op: '<=' | '>'): string | undefined {
  return new RegExp(`FILTER\\(STR\\(\\?${variable}\\) ${op} "(\\d{4}-\\d{2}-\\d{2})"\\)`).exec(
    sparql,
  )?.[1];
}

/**
 * The consolidation columns of `baseWork`'s rows, as the lookup query reads them:
 * the current-version arm (`?currentCelex`/`?currentDate`) and, when the query
 * carries it, the future-dated arm (`?pendingCelex`/`?pendingDate`). Each date
 * filter, each arm's OPTIONAL, the `ORDER BY` keys, and `LIMIT 1` apply only when
 * the query carries them. Without an order the rows come back in descending CELEX
 * order, the order that picks the wrong version for an act whose consolidations are
 * numbered differently; an unbound value sorts last under `DESC`, as in CELLAR.
 */
function versionRows(sparql: string, baseWork: string): Row[] {
  const all = consolidationsOf(baseWork);
  const today = dateBound(sparql, 'currentDate', '<=');
  let rows: Row[] = all
    .filter((r) => !today || r.date <= today)
    .map((r) => ({ currentCelex: literal(r.celex), currentDate: literal(r.date) }));
  if (rows.length === 0) {
    if (!/OPTIONAL \{\s*\?current /.test(sparql)) return [];
    rows = [{}];
  }
  if (sparql.includes('?pending cdm:act_consolidated_based_on_resource_legal ?baseWork')) {
    const after = dateBound(sparql, 'pendingDate', '>');
    const pending = all
      .filter((r) => !after || r.date > after)
      .map((r) => ({ pendingCelex: literal(r.celex), pendingDate: literal(r.date) }));
    if (pending.length > 0) rows = rows.flatMap((row) => pending.map((p) => ({ ...row, ...p })));
  }
  const desc = (key: string) => (a: Row, b: Row) =>
    (b[key]?.value ?? '').localeCompare(a[key]?.value ?? '');
  const order = /ORDER BY ([^\n]*?) LIMIT/.exec(sparql)?.[1] ?? '';
  const keys = [
    ['DESC(STR(?currentDate))', 'currentDate'],
    ['DESC(?currentCelex)', 'currentCelex'],
    ['DESC(STR(?pendingDate))', 'pendingDate'],
  ].filter(([clause]) => order.includes(clause as string));
  if (keys.length > 0) {
    rows.sort((a, b) => {
      for (const [, key] of keys) {
        const c = desc(key as string)(a, b);
        if (c !== 0) return c;
      }
      return 0;
    });
  }
  return /LIMIT 1\b/.test(sparql) ? rows.slice(0, 1) : rows;
}

/** True for the consolidation lookup (either shape). */
export function isConsolidationLookup(sparql: string): boolean {
  return (
    sparql.includes('cdm:act_consolidated_based_on_resource_legal') &&
    sparql.includes('?currentCelex')
  );
}

/** Answer every query the consolidation paths issue, from the fixture works. */
export async function fakeConsolidationCellar(sparql: string): Promise<Row[]> {
  if (isResolutionQuery(sparql)) {
    return requestedCelex(sparql).flatMap((celex) => {
      const act = ACTS[celex];
      return act
        ? [
            {
              celexNumber: literal(celex),
              work: uri(act.uri),
              canonicalAlias: uri(`http://publications.europa.eu/resource/celex/${celex}`),
            },
          ]
        : [];
    });
  }

  if (isConsolidationLookup(sparql)) {
    const requested = keyedCelex(sparql, 'requested');
    if (requested) {
      const act = ACTS[requested];
      if (!act?.basedOn) return [];
      const baseEntry = byUri.get(act.basedOn);
      // Each column is bound only when the query carries the pattern that binds it.
      const readsRequestedDate = sparql.includes(
        '?requested cdm:act_consolidated_date ?requestedDate .',
      );
      const readsBaseCelex = sparql.includes('?baseWork cdm:resource_legal_id_celex ?baseCelex .');
      const [versions = {}] = versionRows(sparql, act.basedOn);
      return [
        {
          ...(readsRequestedDate ? { requestedDate: literal(act.consolidatedDate as string) } : {}),
          baseWork: uri(act.basedOn),
          ...(readsBaseCelex && baseEntry?.celex ? { baseCelex: literal(baseEntry.celex) } : {}),
          ...versions,
        },
      ];
    }
    const baseCelex = keyedCelex(sparql, 'baseWork');
    const act = baseCelex ? ACTS[baseCelex] : undefined;
    if (!act) return [];
    return versionRows(sparql, act.uri).map((row) => ({ baseWork: uri(act.uri), ...row }));
  }

  const act = addressedAct(sparql);
  if (!act) return [];
  if (sparql.includes('cdm:work_created_by_agent')) {
    const readsLabel = sparql.includes('?agentLabel');
    return act.creators.map((c) => {
      const label = readsLabel ? AGENT_LABELS.get(c) : undefined;
      return {
        agent: uri(c),
        role: literal('creator'),
        ...(label ? { agentLabel: literal(label) } : {}),
      };
    });
  }
  if (sparql.includes('cdm:resource_legal_based_on_resource_legal')) {
    return act.legalBases.map((lb) => ({ legalBasis: uri(lb) }));
  }
  if (sparql.includes('cdm:work_is_about_concept_eurovoc')) {
    return act.eurovoc.map((e) => ({ eurovoc: uri(e) }));
  }
  if (sparql.includes('cdm:expression_belongs_to_work')) {
    return [coreRow(sparql)];
  }
  return [];
}

/**
 * The core metadata row. The single-valued fields come from the work each is read
 * from: a query that reads `in_force` from a second work IRI gets that work's value.
 */
function coreRow(sparql: string): Row {
  const servedWork = /<([^>]+)> cdm:work_has_resource-type \?type/.exec(sparql)?.[1] ?? '';
  const served = byUri.get(servedWork)?.act as FixtureAct;
  const inForceWork = /<([^>]+)> cdm:resource_legal_in-force \?inForce/.exec(sparql)?.[1];
  const status = inForceWork ? byUri.get(inForceWork)?.act : served;
  return {
    type: uri(served.type),
    date: literal(served.date),
    title: literal(served.title),
    ...(status?.inForce ? { inForce: literal(status.inForce) } : {}),
    ...reasonColumns(sparql),
  };
}

/**
 * The in-force reason aggregates (#111), answered only when the query projects them
 * and each from the work its own pattern reads, the way CELLAR evaluates the query
 * as written:
 *  - the earliest entry into force;
 *  - the latest end of validity over every value the pattern binds — CELLAR's
 *    `9999-12-31` placeholder included, unless a filter inside that same OPTIONAL
 *    excludes it;
 *  - the space-joined values of the aggregated variable over every repealing work:
 *    each work's CELEX when the query joins it, the work IRI when the aggregate
 *    reads the repealer itself, and an empty string when the variable is never
 *    bound, as CELLAR's `GROUP_CONCAT` returns.
 */
function reasonColumns(sparql: string): Row {
  const columns: Row = {};

  const entry = /<([^>]+)> cdm:resource_legal_date_entry-into-force \?(\w+)/.exec(sparql);
  if (entry && sparql.includes(`(MIN(STR(?${entry[2]})) AS ?entryIntoForce)`)) {
    const earliest = byUri.get(entry[1] as string)?.act.entryIntoForce?.toSorted()[0];
    if (earliest) columns.entryIntoForce = literal(earliest);
  }

  const end = /<([^>]+)> cdm:resource_legal_date_end-of-validity \?(\w+)/.exec(sparql);
  if (end && sparql.includes(`(MAX(STR(?${end[2]})) AS ?endOfValidity)`)) {
    const excluded = new RegExp(
      `OPTIONAL \\{[^{}]*cdm:resource_legal_date_end-of-validity \\?${end[2]} \\.[^{}]*FILTER\\(STR\\(\\?${end[2]}\\) != "([^"]+)"\\)[^{}]*\\}`,
    ).exec(sparql)?.[1];
    const latest = (byUri.get(end[1] as string)?.act.endOfValidity ?? [])
      .filter((date) => date !== excluded)
      .toSorted()
      .at(-1);
    if (latest) columns.endOfValidity = literal(latest);
  }

  const repeal = /\?(\w+) cdm:resource_legal_repeals_resource_legal <([^>]+)>/.exec(sparql);
  const aggregated =
    /GROUP_CONCAT\((?:DISTINCT )?STR\(\?(\w+)\); separator=" "\) AS \?repealedBy\)/.exec(
      sparql,
    )?.[1];
  if (repeal && aggregated) {
    const [, repealer, work] = repeal;
    const repealers = byUri.get(work as string)?.act.repealedBy ?? [];
    const joinsCelex = sparql.includes(`?${repealer} cdm:resource_legal_id_celex ?${aggregated} .`);
    const values =
      aggregated === repealer
        ? repealers.map((celex, i) => `${CELLAR}repealer-${celex ?? `celexless-${i}`}`)
        : joinsCelex
          ? repealers.filter((c): c is string => c !== null)
          : [];
    columns.repealedBy = literal([...new Set(values)].join(' '));
  }
  return columns;
}
