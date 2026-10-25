/**
 * @fileoverview Official Journal references (`OJ L 281, 23.11.1995, p. 31`,
 * `OJ L, 2024/1689, 12.7.2024`) parsed and resolved to the CELEX of the act they
 * name: an issue reference by the issue's CELLAR identifier, its publication date,
 * and the act's first page; an act-by-act reference by the act's own identifier.
 * @module services/cellar-sparql/oj-reference
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { ENG_LANGUAGE_URI } from './cdm-labels.js';
import type { CellarSparqlService } from './cellar-sparql-service.js';
import { escapeSparqlLiteral } from './eli-resolution.js';
import type { SparqlBinding } from './types.js';

/** A parsed Official Journal reference. `publishedOn` is the cited date, `YYYY-MM-DD`. */
export type OjReference =
  | {
      kind: 'issue';
      /** CELLAR `work_id_document` of each issue the reference can name — two only for a series-less 1958 reference. */
      issueIds: readonly string[];
      firstPage: number;
      publishedOn?: string;
    }
  | { kind: 'act'; actId: string; publishedOn?: string };

/** What CELLAR holds for a reference. */
export type OjResolution =
  | { kind: 'one'; celex: string }
  | { kind: 'several'; celex: readonly string[] }
  /** CELLAR holds no such issue, or no act under that act-by-act number. */
  | { kind: 'not_held' }
  /** The issue or act exists, published on another date than the one cited. */
  | { kind: 'other_date'; publishedOn: string | undefined }
  /** The issue exists, but no act with a CELEX starts on the cited page. */
  | { kind: 'no_act_on_page' };

/*
 * The grammar runs on the reference after `normalizeReference`, so every separator
 * is one space and no two quantifiers can claim the same characters: each pattern is
 * anchored at both ends and holds only bounded digit runs, so it runs in time linear
 * in the input. Case is ignored throughout.
 */

/**
 * Issue, date, first page: `OJ L 281, 23.11.1995, p. 31` (or `… of 23.11.1995 …`).
 * Groups: series, number, class letter — or, before 1968, a series-less number —
 * then day, month, year, first page. A page range (`p. 1–88`) and the pre-1968
 * page/year form (`p. 204/62`) are read past.
 */
const ISSUE_REFERENCE =
  /^oj (?:([lc]) ?(\d{1,4}) ?([aeim])?|(\d{1,4}))(?:, | of )(\d{1,2})\.(\d{1,2})\.(\d{4}), p\. ?(\d{1,4})(?: ?[-–] ?\d{1,4}|\/\d{2})?$/i;

/** Year first, the Court's form: `OJ 1995 L 281, p. 31` or `OJ 1995 L 281/31`. No date. */
const YEAR_FIRST_REFERENCE =
  /^oj (\d{4}) ([lc]) ?(\d{1,4}) ?([aeim])?(?:, p\. ?|\/)(\d{1,4})(?: ?[-–] ?\d{1,4}|\/\d{2})?$/i;

/** The act-by-act OJ L, since October 2023: `OJ L, 2024/1689, 12.7.2024`, the date optional. */
const ACT_L_REFERENCE = /^oj l, (\d{4})\/(\d{1,5})(?:, (\d{1,2})\.(\d{1,2})\.(\d{4}))?$/i;

/** The act-by-act OJ C: `OJ C, C/2024/2664, 29.4.2024`. A `C/` number under L is no reference. */
const ACT_C_REFERENCE = /^oj c, c\/(\d{4})\/(\d{1,5})(?:, (\d{1,2})\.(\d{1,2})\.(\d{4}))?$/i;

/** One space per whitespace run; a trailing period, then one pair of surrounding parentheses, dropped. */
function normalizeReference(text: string): string {
  let value = text.trim().replace(/\s+/g, ' ');
  if (value.endsWith('.')) value = value.slice(0, -1);
  if (value.startsWith('(') && value.endsWith(')')) value = value.slice(1, -1).trim();
  return value;
}

function isoDate(day: string, month: string, year: string): string {
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

/** `oj:JOL_1995_281_R`: series, year, number padded to three digits, class (`R` when none is cited). */
function issueId(
  series: string,
  year: string,
  number: string,
  issueClass: string | undefined,
): string {
  return `oj:JO${series.toUpperCase()}_${year}_${number.padStart(3, '0')}_${(issueClass ?? 'R').toUpperCase()}`;
}

/**
 * The issues a series-less reference can name. Before the 1968 split into L and C
 * the Journal ran as the ECSC journal (`JOA`, 1952–1958) and then one EEC journal
 * (`JOP`, 1958–1967); a 1958 number can be either, and the cited date tells them
 * apart. From 1968 on a reference without its series names no issue.
 */
function seriesLessIssueIds(year: string, number: string): string[] {
  const y = Number(year);
  if (y >= 1968) return [];
  const series = y < 1958 ? ['A'] : y === 1958 ? ['A', 'P'] : ['P'];
  return series.map((s) => issueId(s, year, number, undefined));
}

/**
 * The OJ reference `text` spells, or undefined when it is none this parser reads.
 * A reference without a year or a first page (`OJ L 281`, `OJ L 119/1`), a special
 * edition, and the EUR-Lex `OJ:L:2016:119:TOC` form name no single act and are not
 * parsed.
 */
export function parseOjReference(text: string): OjReference | undefined {
  const value = normalizeReference(text);
  const issue = ISSUE_REFERENCE.exec(value);
  if (issue) {
    const [, series, number, issueClass, seriesLess, day = '', month = '', year = '', page] = issue;
    const issueIds =
      series && number
        ? [issueId(series, year, number, issueClass)]
        : seriesLessIssueIds(year, seriesLess ?? '');
    if (issueIds.length === 0) return;
    return {
      kind: 'issue',
      issueIds,
      firstPage: Number(page),
      publishedOn: isoDate(day, month, year),
    };
  }
  const yearFirst = YEAR_FIRST_REFERENCE.exec(value);
  if (yearFirst) {
    const [, year = '', series = '', number = '', issueClass, page] = yearFirst;
    return {
      kind: 'issue',
      issueIds: [issueId(series, year, number, issueClass)],
      firstPage: Number(page),
    };
  }
  for (const [series, pattern] of [
    ['L', ACT_L_REFERENCE],
    ['C', ACT_C_REFERENCE],
  ] as const) {
    const act = pattern.exec(value);
    if (!act) continue;
    const [, year = '', number = '', day, month, dateYear] = act;
    return {
      kind: 'act',
      actId: `oj:${series}_${year}${number.padStart(5, '0')}`,
      ...(day && month && dateYear ? { publishedOn: isoDate(day, month, dateYear) } : {}),
    };
  }
  return;
}

const ENGLISH = `<${ENG_LANGUAGE_URI}>`;

/**
 * One row per CELEX-bearing work of the issue whose manifestation starts on
 * `firstPage`, plus the issue's publication date. CELLAR stores the first page as a
 * string with and without zero padding (`0047`, `47`), so it is compared as an
 * integer, inside one issue's works.
 *
 * Pages are compared on the English edition, since corrigenda paginate per language:
 * page 2 of OJ L 127 of 2018 starts one corrigendum in English and another in
 * Italian. `?english` marks a work whose English manifestation starts on the page.
 * The English edition began in 1973, and earlier English manifestations carry no
 * page, so `?englishPaged` reports whether any English manifestation in the issue
 * carries one; when none does, every language's page counts. When nothing starts on
 * the page the issue still answers one row, with its date and no CELEX.
 *
 * One issue identifier per query: a `VALUES` list of several issues runs past the
 * client timeout where each single-issue query returns at once.
 */
export function buildOjIssueQuery(issueIdValue: string, firstPage: number): string {
  return `
SELECT ?published ?englishPaged ?celex (MAX(IF(?language = ${ENGLISH}, 1, 0)) AS ?english) WHERE {
  ?issue cdm:work_id_document "${escapeSparqlLiteral(issueIdValue)}"^^xsd:string .
  OPTIONAL { ?issue cdm:publication_general_date_publication ?published . }
  BIND(IF(EXISTS {
    ?englishWork cdm:resource_legal_published_in_official-journal ?issue .
    ?englishExpression cdm:expression_belongs_to_work ?englishWork ;
      cdm:expression_uses_language ${ENGLISH} .
    ?englishManifestation cdm:manifestation_manifests_expression ?englishExpression ;
      cdm:manifestation_official-journal_part_page_first ?englishPage .
  }, 1, 0) AS ?englishPaged)
  OPTIONAL {
    ?work cdm:resource_legal_published_in_official-journal ?issue ;
      cdm:resource_legal_id_celex ?celex .
    ?expression cdm:expression_belongs_to_work ?work ;
      cdm:expression_uses_language ?language .
    ?manifestation cdm:manifestation_manifests_expression ?expression ;
      cdm:manifestation_official-journal_part_page_first ?page .
    FILTER(xsd:integer(?page) = ${firstPage})
  }
} GROUP BY ?published ?englishPaged ?celex LIMIT 100`;
}

/** The CELEX of the act-by-act work carrying `actIdValue`, with its publication date. */
export function buildOjActQuery(actIdValue: string): string {
  return `
SELECT DISTINCT ?celex ?published WHERE {
  ?work cdm:work_id_document "${escapeSparqlLiteral(actIdValue)}"^^xsd:string ;
    cdm:resource_legal_id_celex ?celex .
  OPTIONAL { ?work cdm:official-journal-act_date_publication ?published . }
} LIMIT 100`;
}

function value(binding: SparqlBinding, field: string): string | undefined {
  return binding[field]?.value;
}

/** One CELEX resolves, several are named, none is a miss. */
function byCelex(celex: Iterable<string>): OjResolution {
  const unique = [...new Set(celex)].sort();
  const [only] = unique;
  if (only === undefined) return { kind: 'no_act_on_page' };
  return unique.length === 1 ? { kind: 'one', celex: only } : { kind: 'several', celex: unique };
}

/** The CELEX starting on the page of one issue's rows: English pages when the issue has any. */
function celexOnPage(rows: readonly SparqlBinding[]): string[] {
  const englishPaged = rows.some((row) => value(row, 'englishPaged') === '1');
  return rows
    .filter((row) => !englishPaged || value(row, 'english') === '1')
    .flatMap((row) => value(row, 'celex') ?? []);
}

/**
 * Resolve a parsed reference against CELLAR. Only works carrying a CELEX count: a
 * work without one cannot be looked up or fetched. A cited date must equal the
 * issue's (or act's) publication date, so a mistyped date or a number from another
 * year is a miss rather than a silent match on whatever issue holds that number.
 */
export async function resolveOjReference(
  svc: Pick<CellarSparqlService, 'query'>,
  reference: OjReference,
  ctx: Context,
): Promise<OjResolution> {
  if (reference.kind === 'act') {
    const rows = await svc.query(buildOjActQuery(reference.actId), ctx);
    const [first] = rows;
    if (!first) return { kind: 'not_held' };
    const published = value(first, 'published');
    if (reference.publishedOn && published !== reference.publishedOn) {
      return { kind: 'other_date', publishedOn: published };
    }
    return byCelex(rows.flatMap((row) => value(row, 'celex') ?? []));
  }

  const issues = await Promise.all(
    reference.issueIds.map((id) => svc.query(buildOjIssueQuery(id, reference.firstPage), ctx)),
  );
  const held = issues.filter((rows) => rows.length > 0);
  if (held.length === 0) return { kind: 'not_held' };
  const dated = held.filter(
    (rows) => !reference.publishedOn || value(rows[0] ?? {}, 'published') === reference.publishedOn,
  );
  if (dated.length === 0) {
    const published = held.length === 1 ? value(held[0]?.[0] ?? {}, 'published') : undefined;
    return { kind: 'other_date', publishedOn: published };
  }
  return byCelex(dated.flatMap(celexOnPage));
}
