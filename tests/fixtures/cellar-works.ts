/**
 * @fileoverview CELEX numbers that CELLAR holds under several works, with the work
 * URIs read live on 2026-09-25, plus a fake that answers CELEX-keyed queries the way
 * CELLAR does: one row per work, in no guaranteed order, with the `owl:sameAs`
 * alias bound only on the canonical work and only when the query asks for it.
 * @module tests/fixtures/cellar-works
 */

/** CELLAR work namespace. */
export const CELLAR = 'http://publications.europa.eu/resource/cellar/';

/** One CELLAR work holding a CELEX. */
export interface FixtureWork {
  /** True for the work that is `owl:sameAs <…/resource/celex/{CELEX}>`. */
  canonical: boolean;
  uri: string;
}

type Row = Record<string, { type: string; value: string }>;

/**
 * Works holding each CELEX. Every multi-work list puts a non-canonical work first,
 * so code that takes the first row of an unordered result picks the wrong work.
 */
export const CELEX_WORKS: Record<string, FixtureWork[]> = {
  /** Main work, a `do_not_index` copy, and a work aliased `62022TJ0181_EXT`. */
  '62022TJ0181': [
    { uri: `${CELLAR}ca51f381-8097-11ef-a67d-01aa75ed71a1`, canonical: false },
    { uri: `${CELLAR}bbd04459-8097-11ef-a67d-01aa75ed71a1`, canonical: true },
    { uri: `${CELLAR}736c7d97-2efc-4194-9590-481bd3d19eeb`, canonical: false },
  ],
  '62012CJ0131': [
    { uri: `${CELLAR}57f6959c-51b3-4ab5-9164-ce6ca914c502`, canonical: false },
    { uri: `${CELLAR}09eb0861-da7a-11e3-8cd4-01aa75ed71a1`, canonical: true },
  ],
  '51988DC0713': [
    { uri: `${CELLAR}052caca5-31a8-11e7-9412-01aa75ed71a1`, canonical: false },
    { uri: `${CELLAR}06611a86-e844-4e4a-8380-2357d1082a4f`, canonical: true },
  ],
  /** Parenthesized CELEX: its alias IRI carries `%28`/`%29`. */
  '62015TO0235(01)': [
    { uri: `${CELLAR}ad35bf3b-5ca8-11e5-afbf-01aa75ed71a1`, canonical: false },
    { uri: `${CELLAR}4a758329-a866-4fee-8d78-e26719d9f4c5`, canonical: false },
    { uri: `${CELLAR}5339dbbe-2e54-11e6-b497-01aa75ed71a1`, canonical: true },
  ],
  '32016R0679': [{ uri: `${CELLAR}3e485e15-11bd-11e6-ba9a-01aa75ed71a1`, canonical: true }],
  '62024CC0505': [{ uri: `${CELLAR}1e2e40df-2931-11f1-8803-01aa75ed71a1`, canonical: true }],
  '82003PT1111(51)': [{ uri: `${CELLAR}52bc5aaf-df75-11e3-8cd4-01aa75ed71a1`, canonical: true }],
  '61983CJ0271': [{ uri: `${CELLAR}ae98d1ba-f619-4246-ac51-41e04d100c9d`, canonical: true }],
};

/** The URI of the fixture work at `index` in the list for `celex`. */
export function fixtureWork(celex: string, index: number): string {
  const work = CELEX_WORKS[celex]?.[index];
  if (!work) throw new Error(`No fixture work ${index} for ${celex}`);
  return work.uri;
}

/** The canonical work URI of a fixture CELEX. */
export function canonicalWork(celex: string): string {
  const work = CELEX_WORKS[celex]?.find((w) => w.canonical);
  if (!work) throw new Error(`No canonical fixture work for ${celex}`);
  return work.uri;
}

/** True for the CELEX → work resolution query (the one that reads the `owl:sameAs` alias). */
export function isResolutionQuery(sparql: string): boolean {
  return sparql.includes('VALUES ?celexNumber') && sparql.includes('owl#sameAs');
}

/** The CELEX values a resolution query asks for, unescaped, in `VALUES` order. */
export function requestedCelex(sparql: string): string[] {
  const values = /VALUES \?celexNumber \{([^}]*)\}/.exec(sparql)?.[1] ?? '';
  return [...values.matchAll(/"((?:[^"\\]|\\.)*)"\^\^xsd:string/g)].map((m) =>
    (m[1] ?? '').replace(/\\(.)/g, '$1'),
  );
}

/**
 * Answer a resolution query with one canonical work per requested CELEX — the shape
 * of a CELEX that CELLAR holds under a single work. `workFor` names the work.
 */
export function resolutionRows(
  sparql: string,
  workFor: (celex: string) => string = (celex) => `${CELLAR}${celex}`,
): Row[] {
  return requestedCelex(sparql).map((celex) => ({
    celexNumber: { type: 'literal', value: celex },
    work: { type: 'uri', value: workFor(celex) },
    canonicalAlias: { type: 'uri', value: `http://publications.europa.eu/resource/celex/${celex}` },
  }));
}

/** The CELEX literal a query names, as CELLAR stores it (`"…"^^xsd:string`). */
function namesCelex(sparql: string, celex: string): boolean {
  return sparql.includes(`"${celex}"^^xsd:string`);
}

/**
 * Answer a CELEX-keyed query from `registry`: one row per work of every CELEX the
 * query names as a typed literal, carrying `?celexNumber` and `?work`. The
 * `?canonicalAlias` binding is added on the canonical work only when the query reads
 * `owl:sameAs`, as CELLAR binds it. `extra` adds per-work columns (type, date, …).
 */
export function celexWorkRows(
  sparql: string,
  registry: Record<string, FixtureWork[]> = CELEX_WORKS,
  extra: (work: FixtureWork, celex: string) => Row = () => ({}),
): Row[] {
  const asksAlias = sparql.includes('owl#sameAs');
  const rows: Row[] = [];
  for (const [celex, works] of Object.entries(registry)) {
    if (!namesCelex(sparql, celex)) continue;
    for (const work of works) {
      rows.push({
        celexNumber: { type: 'literal', value: celex },
        work: { type: 'uri', value: work.uri },
        ...(asksAlias && work.canonical
          ? {
              canonicalAlias: {
                type: 'uri',
                value: `http://publications.europa.eu/resource/celex/${encodeURIComponent(celex).replace(/\(/g, '%28').replace(/\)/g, '%29')}`,
              },
            }
          : {}),
        ...extra(work, celex),
      });
    }
  }
  return rows;
}

const RESOURCE_TYPE = 'http://publications.europa.eu/resource/authority/resource-type/';

/** A case-law work with the per-work columns a resolution query can read beside it. */
export interface FixtureCaseWork extends FixtureWork {
  ecli?: string;
  /** English expression titles; a work can carry several. */
  titles: string[];
  /** Resource-type codes, e.g. `JUDG`. */
  types: string[];
}

const SCHREMS_PARTIES =
  'Data Protection Commissioner v Facebook Ireland Limited and Maximillian Schrems.';
const SCHREMS_SUBJECT =
  'Reference for a preliminary ruling — Protection of individuals with regard to the processing of personal data — Charter of Fundamental Rights of the European Union — Articles 7, 8 and 47 — Regulation (EU) 2016/679.';
const FIE_TAIL =
  '#Friends of the Irish Environment Ltd v Commissioner for Environmental Information.#Request for a preliminary ruling from the High Court (Irlande).#Reference for a preliminary ruling – Aarhus Convention – Directive 2003/4/EC – Right of access to environmental information held by public authorities.#Case C-470/19.';
const PLASTICS_EUROPE =
  'Judgment of the General Court (Eighth Chamber) of 16 December 2020 (Extracts).#PlasticsEurope v European Chemicals Agency.#REACH – Establishment of a list of substances identified with a view to their eventual inclusion in Annex XIV to Regulation (EC) No 1907/2006.#Case T-207/18.';

/**
 * Case-law CELEX whose `do_not_index` copy differs from the canonical work, with the
 * work URIs, types, and ECLI read live on 2026-10-14. Subject-matter segments are
 * shortened; every other segment is as CELLAR stores it. The copy comes first, as in
 * {@link CELEX_WORKS}.
 */
export const CASE_LAW_WORKS: Record<string, FixtureCaseWork[]> = {
  /** Schrems II: the copy's title lacks the referral segment. */
  '62018CJ0311': [
    {
      uri: `${CELLAR}d17ef5a0-c749-11ea-adf7-01aa75ed71a1`,
      canonical: false,
      types: ['JUDG'],
      ecli: 'ECLI:EU:C:2020:559',
      titles: [
        `Judgment of the Court (Grand Chamber) of 16 July 2020.#${SCHREMS_PARTIES}#${SCHREMS_SUBJECT}#Case C-311/18.`,
      ],
    },
    {
      uri: `${CELLAR}c93f72bb-c749-11ea-adf7-01aa75ed71a1`,
      canonical: true,
      types: ['JUDG'],
      ecli: 'ECLI:EU:C:2020:559',
      titles: [
        `Judgment of the Court (Grand Chamber) of 16 July 2020.#${SCHREMS_PARTIES}#Request for a preliminary ruling from the High Court (Ireland).#${SCHREMS_SUBJECT}#Case C-311/18.`,
      ],
    },
  ],
  /** An AG opinion whose copy carries only the bare "Opinion of … delivered on …" title. */
  '62019CC0470': [
    {
      uri: `${CELLAR}f5da411c-9dcd-11eb-b85c-01aa75ed71a1`,
      canonical: false,
      types: ['OPIN_AG'],
      ecli: 'ECLI:EU:C:2020:986',
      titles: ['Opinion of Advocate General Bobek delivered on 3 December 2020.'],
    },
    {
      uri: `${CELLAR}e5466ea7-3561-11eb-b27b-01aa75ed71a1`,
      canonical: true,
      types: ['OPIN_AG'],
      ecli: 'ECLI:EU:C:2020:986',
      titles: [`Opinion of Advocate General Bobek delivered on 3 December 2020.${FIE_TAIL}`],
    },
  ],
  /** A General Court judgment whose copy is typed as published by extracts. */
  '62018TJ0207': [
    {
      uri: `${CELLAR}5d1274a0-3fab-11eb-b27b-01aa75ed71a1`,
      canonical: false,
      types: ['JUDG_EXTRACT'],
      ecli: 'ECLI:EU:T:2020:623',
      titles: [PLASTICS_EUROPE],
    },
    {
      uri: `${CELLAR}039ca67d-3faa-11eb-b27b-01aa75ed71a1`,
      canonical: true,
      types: ['JUDG'],
      ecli: 'ECLI:EU:T:2020:623',
      titles: [PLASTICS_EUROPE],
    },
  ],
};

/**
 * Answer a resolution query from a case-law `registry` the way CELLAR does: one row
 * per work, per type, and per title it carries, each column bound only when the
 * query reads it, so a query that reads no per-work column gets one row per work.
 */
export function caseWorkRows(
  sparql: string,
  registry: Record<string, FixtureCaseWork[]> = CASE_LAW_WORKS,
): Row[] {
  const readsType = sparql.includes('cdm:work_has_resource-type ?type');
  const readsEcli = sparql.includes('cdm:case-law_ecli ?ecli');
  const readsTitle = sparql.includes('cdm:expression_title ?title');
  const works = new Map(
    Object.values(registry)
      .flat()
      .map((w) => [w.uri, w]),
  );
  return celexWorkRows(sparql, registry).flatMap((row) => {
    const work = works.get(row.work?.value ?? '');
    if (!work) return [row];
    const types = readsType && work.types.length > 0 ? work.types : [undefined];
    const titles = readsTitle && work.titles.length > 0 ? work.titles : [undefined];
    return types.flatMap((type) =>
      titles.map((title) => ({
        ...row,
        ...(type ? { type: { type: 'uri', value: `${RESOURCE_TYPE}${type}` } } : {}),
        ...(readsEcli && work.ecli ? { ecli: { type: 'literal', value: work.ecli } } : {}),
        ...(title ? { title: { type: 'literal', value: title } } : {}),
      })),
    );
  });
}

const CORPORATE_BODY = 'http://publications.europa.eu/resource/authority/corporate-body/';

/** A `cdm:work_created_by_agent` or `cdm:case-law_delivered_by_advocate-general` value. */
export interface FixtureAgent {
  /** `cdm:court_national_name`, carried by a `cdm:court_national` resource. */
  courtName?: string;
  /** English `skos:prefLabel`, carried by an authority code. */
  label?: string;
  /** `cdm:agent_name`, carried by a `cdm:person` resource. */
  personName?: string;
  uri: string;
}

const COURT_OF_JUSTICE: FixtureAgent = { uri: `${CORPORATE_BODY}CJ`, label: 'Court of Justice' };

/** Agents of the canonical work of each CELEX, as CELLAR returned them on 2026-09-25. */
export const WORK_AGENTS: Record<
  string,
  { advocatesGeneral: FixtureAgent[]; creators: FixtureAgent[] }
> = {
  '32016R0679': {
    creators: [
      { uri: `${CORPORATE_BODY}CONSIL`, label: 'Council of the European Union' },
      { uri: `${CORPORATE_BODY}EP`, label: 'European Parliament' },
    ],
    advocatesGeneral: [],
  },
  '62012CJ0131': {
    creators: [
      { uri: `${CELLAR}233d79cc-67e5-4048-9fd0-fda2509029b4`, personName: 'Jääskinen' },
      COURT_OF_JUSTICE,
    ],
    advocatesGeneral: [
      { uri: `${CELLAR}233d79cc-67e5-4048-9fd0-fda2509029b4`, personName: 'Jääskinen' },
    ],
  },
  '62024CC0505': {
    creators: [{ uri: `${CELLAR}76d5fb73-0e44-4b6a-b304-92e654529d86`, personName: 'Biondi' }],
    advocatesGeneral: [
      { uri: `${CELLAR}76d5fb73-0e44-4b6a-b304-92e654529d86`, personName: 'Biondi' },
    ],
  },
  '82003PT1111(51)': {
    creators: [
      {
        uri: `${CELLAR}06234cad-d720-11e5-8fea-01aa75ed71a1`,
        courtName: 'Supremo Tribunal de Justiça',
      },
    ],
    advocatesGeneral: [],
  },
  '61983CJ0271': {
    creators: [
      { uri: `${CELLAR}f2960242-438e-421c-8dc9-2c27c46de49d`, personName: 'VerLoren van Themaat' },
      { uri: `${CELLAR}abcde658-756b-448d-acad-8e2b122e23c6`, personName: 'Mischo' },
      COURT_OF_JUSTICE,
    ],
    advocatesGeneral: [
      { uri: `${CELLAR}f2960242-438e-421c-8dc9-2c27c46de49d`, personName: 'VerLoren van Themaat' },
      { uri: `${CELLAR}abcde658-756b-448d-acad-8e2b122e23c6`, personName: 'Mischo' },
    ],
  },
};

/** The fixture CELEX a query addresses, by its typed CELEX literal or one of its work IRIs. */
export function addressedCelex(sparql: string): string | undefined {
  return addressedWorks(sparql)[0]?.celex;
}

/**
 * The fixture works a query reads: every work of a CELEX named as a typed literal (a
 * CELEX-keyed join reaches all of them), otherwise each work named by its IRI.
 */
export function addressedWorks(sparql: string): { celex: string; work: FixtureWork }[] {
  return Object.entries(CELEX_WORKS).flatMap(([celex, works]) =>
    works
      .filter((w) => namesCelex(sparql, celex) || sparql.includes(`<${w.uri}>`))
      .map((work) => ({ celex, work })),
  );
}

/**
 * Answer an author query for the fixture CELEX it addresses. A query that also reads
 * `cdm:case-law_delivered_by_advocate-general` gets one row per agent and role, with
 * the person and court names bound where CELLAR carries them, and the English label
 * bound only when the query reads `?agentLabel`; a query that reads only
 * `cdm:work_created_by_agent` gets one `?author` row per creator.
 */
export function agentRows(sparql: string): Row[] {
  const celex = addressedCelex(sparql);
  const agents = celex ? WORK_AGENTS[celex] : undefined;
  if (!agents) return [];
  const readsLabel = sparql.includes('?agentLabel');
  const named = (a: FixtureAgent, role: string): Row => ({
    agent: { type: 'uri', value: a.uri },
    role: { type: 'literal', value: role },
    ...(a.personName ? { personName: { type: 'literal', value: a.personName } } : {}),
    ...(a.courtName ? { courtName: { type: 'literal', value: a.courtName } } : {}),
    ...(a.label && readsLabel ? { agentLabel: { type: 'literal', value: a.label } } : {}),
  });
  if (sparql.includes('cdm:case-law_delivered_by_advocate-general')) {
    return [
      ...agents.creators.map((a) => named(a, 'creator')),
      ...agents.advocatesGeneral.map((a) => named(a, 'advocate_general')),
    ];
  }
  return agents.creators.map((a) => ({ author: { type: 'uri', value: a.uri } }));
}
