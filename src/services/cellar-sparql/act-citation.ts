/**
 * @fileoverview An act's citation facts — its ELI, Official Journal reference,
 * typed dates of effect, and transposition deadlines — read as aggregates inside
 * the grouped core metadata query that eurlex_get_document and the
 * eurlex://document/{celexNumber} resource already issue, so they cost no added
 * round trip.
 * @module services/cellar-sparql/act-citation
 */

import { LANGUAGE_AUTHORITY_URI } from './cdm-labels.js';
import { CellarSparqlService } from './cellar-sparql-service.js';
import type { SparqlBinding } from './types.js';

/** `annotation:type_of_date` (`fd_335`) codes mapped to their `dates_of_effect` types. */
const EFFECT_TYPES = {
  EV: 'entry_into_force',
  MA: 'application',
  'MA/PART': 'partial_application',
  'MA/PROV': 'provisional_application',
  PE: 'takes_effect',
  'PE/PART': 'takes_partial_effect',
} as const;

/** One `dates_of_effect` type. */
export type EffectType = (typeof EFFECT_TYPES)[keyof typeof EFFECT_TYPES];

/** The `dates_of_effect` types, in the order entries on the same date are listed. */
export const EFFECT_TYPE_VALUES = Object.values(EFFECT_TYPES) as [EffectType, ...EffectType[]];

/** One typed date of effect. */
export interface DateOfEffect {
  date: string;
  type?: EffectType;
}

/** The citation facts of an act; each is absent when CELLAR records none. */
export interface ActCitation {
  dates_of_effect?: DateOfEffect[];
  eli?: string;
  oj_reference?: string;
  transposition_deadlines?: string[];
}

/** Official Journal facts as the core query aggregates them. */
export interface OjFacts {
  /** The act-by-act publication (OJ L from 2023-10, OJ C from 2023-10). */
  act?: { collection: string; date: string; number: string; year: string };
  /** The English manifestation's `first-last` page pairs. */
  englishPages: string[];
  /** The earliest Official Journal issue the act was published in. */
  issue?: { class: string; collection: string; date: string; number: string };
  /** The original-language manifestations' `first-last` page pairs. */
  originalPages: string[];
}

const OWL = 'http://www.w3.org/2002/07/owl#';
const TYPE_OF_DATE = '<http://publications.europa.eu/ontology/annotation#type_of_date>';
/** The languages of the Official Journal before the 1973 English edition. */
const ORIGINAL_LANGUAGES = ['DEU', 'FRA', 'ITA', 'NLD'];
/** The first day of the English edition, before which pages come from the original languages. */
const ENGLISH_EDITION_START = '1973-01-01';

/**
 * Whether the act named by `actCelex` can predate the 1973 English edition: its
 * CELEX year is before 1973, or unknown. Only such an act reads the
 * original-language pages, a join that costs a measurable share of the core query.
 */
function mayPredateEnglishEdition(actCelex: string | undefined): boolean {
  const year = actCelex?.slice(1, 5) ?? '';
  return !isDigits(year) || year < ENGLISH_EDITION_START.slice(0, 4);
}

/**
 * The projection and patterns that fold the citation facts into a grouped core
 * metadata query: the served work's ELI (a consolidated text's own point-in-time
 * ELI), and the act's typed entry-into-force dates, transposition deadlines, and
 * Official Journal facts — the issue it was published in, its act-by-act
 * publication, and the page ranges of its English and, for an act that can
 * predate the English edition, original-language manifestations. `actCelex` is
 * the act's CELEX, when known.
 *
 * The patterns bind `?entryIntoForceDate`, each date joined to its `owl:Axiom`
 * annotation inside the same `OPTIONAL`, so the date also feeds an earliest-entry
 * aggregate the caller projects. Every composite is built with `STR()` and
 * `COALESCE()` inside `CONCAT`, so an unbound part reads as empty rather than
 * dropping the row; an act with no value yields `"|"`-only strings the reader
 * discards. The issue aggregate is a `MIN` over a date-led string, so the
 * earliest of several issues (a 2005–2011 class `M` reprint) is the one cited.
 */
export function actCitationQueryParts(
  servedWork: string,
  actWork: string,
  actCelex: string | undefined,
): { patterns: string; select: string } {
  const originalPages = mayPredateEnglishEdition(actCelex);
  const originalLanguages = ORIGINAL_LANGUAGES.map(
    (code) => `<${LANGUAGE_AUTHORITY_URI}${code}>`,
  ).join(', ');
  const select = `
  (MIN(STR(?eliValue)) AS ?eli)
  (GROUP_CONCAT(DISTINCT CONCAT(STR(?entryIntoForceDate), "|", COALESCE(STR(?effectType), "")); separator=" ") AS ?datesOfEffect)
  (GROUP_CONCAT(DISTINCT STR(?transpositionDate); separator=" ") AS ?transposition)
  (MIN(CONCAT(COALESCE(STR(?ojIssueDate), ""), "|", COALESCE(STR(?ojIssueCollection), ""), "|", COALESCE(STR(?ojIssueNumber), ""), "|", COALESCE(STR(?ojIssueClass), ""))) AS ?ojIssue)
  (MIN(CONCAT(COALESCE(STR(?ojActDate), ""), "|", COALESCE(STR(?ojActCollection), ""), "|", COALESCE(STR(?ojActYear), ""), "|", COALESCE(STR(?ojActNumber), ""))) AS ?ojAct)
  (GROUP_CONCAT(DISTINCT CONCAT(STR(?ojEnglishFirst), "|", COALESCE(STR(?ojEnglishLast), "")); separator=" ") AS ?ojEnglishPages)${
    originalPages
      ? `
  (GROUP_CONCAT(DISTINCT CONCAT(STR(?ojOriginalFirst), "|", COALESCE(STR(?ojOriginalLast), "")); separator=" ") AS ?ojOriginalPages)`
      : ''
  }`;
  const patterns = `
  OPTIONAL {
    <${actWork}> cdm:resource_legal_date_entry-into-force ?entryIntoForceDate .
    OPTIONAL {
      ?effectAxiom <${OWL}annotatedSource> <${actWork}> ;
        <${OWL}annotatedProperty> cdm:resource_legal_date_entry-into-force ;
        <${OWL}annotatedTarget> ?entryIntoForceDate ;
        ${TYPE_OF_DATE} ?effectType .
    }
  }
  OPTIONAL { <${servedWork}> cdm:resource_legal_eli ?eliValue . }
  OPTIONAL { <${actWork}> cdm:directive_date_transposition ?transpositionDate . }
  OPTIONAL {
    <${actWork}> cdm:resource_legal_published_in_official-journal ?ojIssueWork .
    ?ojIssueWork cdm:publication_general_date_publication ?ojIssueDate ;
      cdm:official-journal_part_of_collection_document ?ojIssueCollection ;
      cdm:official-journal_number ?ojIssueNumber .
    OPTIONAL { ?ojIssueWork cdm:official-journal_class ?ojIssueClass . }
  }
  OPTIONAL {
    <${actWork}> cdm:official-journal-act_date_publication ?ojActDate ;
      cdm:official-journal-act_part_of_collection_document ?ojActCollection ;
      cdm:official-journal-act_year ?ojActYear ;
      cdm:official-journal-act_number ?ojActNumber .
  }
  OPTIONAL {
    ?ojEnglishExpr cdm:expression_belongs_to_work <${actWork}> ;
      cdm:expression_uses_language <${LANGUAGE_AUTHORITY_URI}ENG> .
    ?ojEnglishManifestation cdm:manifestation_manifests_expression ?ojEnglishExpr ;
      cdm:manifestation_official-journal_part_page_first ?ojEnglishFirst .
    OPTIONAL { ?ojEnglishManifestation cdm:manifestation_official-journal_part_page_last ?ojEnglishLast . }
  }${
    originalPages
      ? `
  OPTIONAL {
    ?ojOriginalExpr cdm:expression_belongs_to_work <${actWork}> ;
      cdm:expression_uses_language ?ojOriginalLanguage .
    FILTER(?ojOriginalLanguage IN (${originalLanguages}))
    ?ojOriginalManifestation cdm:manifestation_manifests_expression ?ojOriginalExpr ;
      cdm:manifestation_official-journal_part_page_first ?ojOriginalFirst .
    OPTIONAL { ?ojOriginalManifestation cdm:manifestation_official-journal_part_page_last ?ojOriginalLast . }
  }`
      : ''
  }`;
  return { select, patterns };
}

/** `"a|b|c"` split on `|`, or `undefined` when its leading part is empty. */
function splitComposite(value: string | undefined): string[] | undefined {
  const parts = (value ?? '').split('|');
  return parts[0] ? parts : undefined;
}

/** A date as `d.m.yyyy`, the Official Journal's citation form. */
function citationDate(isoDate: string): string {
  const [year, month, day] = isoDate.slice(0, 10).split('-');
  return `${Number(day)}.${Number(month)}.${year}`;
}

/** True for a token of ASCII digits only. */
function isDigits(token: string): boolean {
  return /^\d+$/.test(token);
}

/** An issue or act number without its zero padding; a non-numeric token stays verbatim. */
function unpadded(token: string): string {
  return isDigits(token) ? token.replace(/^0+(?=\d)/, '') : token;
}

/** A CELLAR document-collection URI's series letter: `L`, `C`, or none for the pre-1968 journal. */
function seriesOf(collection: string): string {
  const series = collection.slice(collection.lastIndexOf('/') + 1).replace(/^OJ-/, '');
  return series === 'P' || series === 'A' ? '' : series;
}

/**
 * The `p. first–last` range over a manifestation's page pairs, or `undefined` when
 * none. Only a numeric page is cited: CELLAR also records tokens such as `s1` on
 * the treaties and keying errors such as `0A01`, which name no Official Journal page.
 */
function pageRange(pairs: string[]): string | undefined {
  const firsts: number[] = [];
  const lasts: number[] = [];
  for (const pair of pairs) {
    const [first = '', last = ''] = pair.split('|');
    if (!isDigits(first)) continue;
    firsts.push(Number(first));
    lasts.push(Number(isDigits(last) ? last : first));
  }
  if (firsts.length === 0) return;
  const first = Math.min(...firsts);
  const last = Math.max(...lasts);
  return first === last ? `p. ${first}` : `p. ${first}–${last}`;
}

/**
 * The Official Journal reference: `OJ L 119, 4.5.2016, p. 1–88` for an act in an
 * issue (no series letter before 1968; a class other than `R` follows the number,
 * `OJ L 42I`), `OJ L, 2024/1689, 12.7.2024` or `OJ C, C/2024/2664, 29.4.2024` for
 * an act-by-act publication. Pages are the English manifestation's, or before the
 * 1973 English edition the original-language ones; a range is omitted when neither
 * records one.
 */
export function formatOjReference(facts: OjFacts): string | undefined {
  if (facts.act) {
    const { collection, date, number, year } = facts.act;
    const series = seriesOf(collection);
    const prefix = series === 'C' ? 'C/' : '';
    return `OJ ${series}, ${prefix}${year}/${unpadded(number)}, ${citationDate(date)}`;
  }
  if (!facts.issue) return;
  const { class: issueClass, collection, date, number } = facts.issue;
  const series = seriesOf(collection);
  const issue = `${unpadded(number)}${issueClass && issueClass !== 'R' ? issueClass : ''}`;
  const pages =
    pageRange(facts.englishPages) ??
    (date < ENGLISH_EDITION_START ? pageRange(facts.originalPages) : undefined);
  return [`OJ ${series ? `${series} ` : ''}${issue}`, citationDate(date), pages]
    .filter(Boolean)
    .join(', ');
}

/** `{CODE|uri}` (CELLAR's `type_of_date` literal) read to its `dates_of_effect` type. */
function effectTypeOf(raw: string): EffectType | undefined {
  const code = raw.startsWith('{') ? raw.slice(1, raw.indexOf('|')) : raw;
  return Object.hasOwn(EFFECT_TYPES, code)
    ? EFFECT_TYPES[code as keyof typeof EFFECT_TYPES]
    : undefined;
}

/**
 * The dated entries of the `?datesOfEffect` aggregate: one per date and type,
 * sorted by date and, on one date, in {@link EFFECT_TYPE_VALUES} order with an
 * untyped entry last. A date whose code maps to no type is listed without one.
 */
function readDatesOfEffect(value: string | undefined): DateOfEffect[] {
  const byKey = new Map<string, DateOfEffect>();
  for (const item of (value ?? '').split(' ')) {
    const separator = item.indexOf('|');
    const date = (separator === -1 ? item : item.slice(0, separator)).slice(0, 10);
    if (!date) continue;
    const type = separator === -1 ? undefined : effectTypeOf(item.slice(separator + 1));
    byKey.set(`${date}|${type ?? ''}`, { date, ...(type ? { type } : {}) });
  }
  const rank = (entry: DateOfEffect) =>
    entry.type ? EFFECT_TYPE_VALUES.indexOf(entry.type) : EFFECT_TYPE_VALUES.length;
  return [...byKey.values()].sort((a, b) => a.date.localeCompare(b.date) || rank(a) - rank(b));
}

/** The citation facts of the core query's first row. */
export function readActCitation(binding: SparqlBinding | undefined): ActCitation {
  const value = (name: string) => CellarSparqlService.bindingValue(binding, name);
  const issue = splitComposite(value('ojIssue'));
  const act = splitComposite(value('ojAct'));
  const pairs = (name: string) => (value(name) ?? '').split(' ').filter((p) => p && p !== '|');
  const ojReference = formatOjReference({
    ...(issue
      ? {
          issue: {
            date: issue[0] as string,
            collection: issue[1] ?? '',
            number: issue[2] ?? '',
            class: issue[3] ?? '',
          },
        }
      : {}),
    ...(act
      ? {
          act: {
            date: act[0] as string,
            collection: act[1] ?? '',
            year: act[2] ?? '',
            number: act[3] ?? '',
          },
        }
      : {}),
    englishPages: pairs('ojEnglishPages'),
    originalPages: pairs('ojOriginalPages'),
  });
  const datesOfEffect = readDatesOfEffect(value('datesOfEffect'));
  const transposition = [
    ...new Set(
      (value('transposition') ?? '')
        .split(' ')
        .filter(Boolean)
        .map((date) => date.slice(0, 10)),
    ),
  ].sort();
  const eli = value('eli');
  return {
    ...(eli ? { eli } : {}),
    ...(ojReference ? { oj_reference: ojReference } : {}),
    ...(datesOfEffect.length > 0 ? { dates_of_effect: datesOfEffect } : {}),
    ...(transposition.length > 0 ? { transposition_deadlines: transposition } : {}),
  };
}
