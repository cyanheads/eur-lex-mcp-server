/**
 * @fileoverview An act's citation facts — its ELI, Official Journal reference,
 * typed dates of effect, and transposition deadlines — read by one aggregate-only
 * query that eurlex_get_document and the eurlex://document/{celexNumber} resource
 * run beside their other metadata queries.
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
  /** The clause that sets the date (`Article 113(a)`), numbered as CELLAR records it. */
  provision?: string;
  type?: EffectType;
}

/** The citation facts of an act; each is absent when CELLAR records none. */
export interface ActCitation {
  dates_of_effect?: DateOfEffect[];
  eli?: string;
  oj_reference?: string;
  transposition_deadlines?: string[];
}

/** Official Journal facts as the citation query aggregates them. */
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
const COMMENT_ON_DATE = '<http://publications.europa.eu/ontology/annotation#comment_on_date>';
/** The languages of the Official Journal before the 1973 English edition. */
const ORIGINAL_LANGUAGES = ['DEU', 'FRA', 'ITA', 'NLD'];
/** The first day of the English edition, before which pages come from the original languages. */
const ENGLISH_EDITION_START = '1973-01-01';

/**
 * Whether the act named by `actCelex` can predate the 1973 English edition: its
 * CELEX year is before 1973, or unknown. Only such an act reads the
 * original-language pages, a join that costs a measurable share of the citation query.
 */
function mayPredateEnglishEdition(actCelex: string | undefined): boolean {
  const year = actCelex?.slice(1, 5) ?? '';
  return !isDigits(year) || year < ENGLISH_EDITION_START.slice(0, 4);
}

/**
 * The citation query: the served work's ELI (a consolidated text's own
 * point-in-time ELI), and the act's typed entry-into-force dates, transposition
 * deadlines, and Official Journal facts — the issue it was published in, its
 * act-by-act publication, and the page ranges of its English and, for an act that
 * can predate the English edition, original-language manifestations. `actCelex`
 * is the act's CELEX, when known. Read the row with {@link readActCitation}.
 *
 * It projects aggregates only, with no `GROUP BY`, so it returns exactly one row
 * whatever the act records. Its `OPTIONAL`s multiply one another's rows; folded
 * into the core metadata query they also multiplied that query's rows, which cost
 * more than running the two apart, concurrently. Each entry-into-force date is
 * joined to its `owl:Axiom` annotation inside the same `OPTIONAL`: the date's
 * `type_of_date` and, when recorded, its `comment_on_date`, which names the clause
 * setting the date. Each date aggregates as `date|type|comment`, the comment
 * `ENCODE_FOR_URI`-encoded because it holds spaces and `|`, the separators the
 * reader splits on. Every composite is built with `STR()` and `COALESCE()` inside
 * `CONCAT`, so an unbound part reads as empty rather than dropping the row; an act
 * with no value yields `"|"`-only strings the reader discards. The issue aggregate
 * is a `MIN` over a date-led string, so the earliest of several issues (a
 * 2005–2011 class `M` reprint) is the one cited.
 */
export function actCitationQuery(
  servedWork: string,
  actWork: string,
  actCelex: string | undefined,
): string {
  const originalPages = mayPredateEnglishEdition(actCelex);
  const originalLanguages = ORIGINAL_LANGUAGES.map(
    (code) => `<${LANGUAGE_AUTHORITY_URI}${code}>`,
  ).join(', ');
  return `
SELECT
  (MIN(STR(?eliValue)) AS ?eli)
  (GROUP_CONCAT(DISTINCT CONCAT(STR(?entryIntoForceDate), "|", COALESCE(STR(?effectType), ""), "|", COALESCE(ENCODE_FOR_URI(STR(?effectComment)), "")); separator=" ") AS ?datesOfEffect)
  (GROUP_CONCAT(DISTINCT STR(?transpositionDate); separator=" ") AS ?transposition)
  (MIN(CONCAT(COALESCE(STR(?ojIssueDate), ""), "|", COALESCE(STR(?ojIssueCollection), ""), "|", COALESCE(STR(?ojIssueNumber), ""), "|", COALESCE(STR(?ojIssueClass), ""))) AS ?ojIssue)
  (MIN(CONCAT(COALESCE(STR(?ojActDate), ""), "|", COALESCE(STR(?ojActCollection), ""), "|", COALESCE(STR(?ojActYear), ""), "|", COALESCE(STR(?ojActNumber), ""))) AS ?ojAct)
  (GROUP_CONCAT(DISTINCT CONCAT(STR(?ojEnglishFirst), "|", COALESCE(STR(?ojEnglishLast), "")); separator=" ") AS ?ojEnglishPages)${
    originalPages
      ? `
  (GROUP_CONCAT(DISTINCT CONCAT(STR(?ojOriginalFirst), "|", COALESCE(STR(?ojOriginalLast), "")); separator=" ") AS ?ojOriginalPages)`
      : ''
  }
WHERE {
  OPTIONAL {
    <${actWork}> cdm:resource_legal_date_entry-into-force ?entryIntoForceDate .
    OPTIONAL {
      ?effectAxiom <${OWL}annotatedSource> <${actWork}> ;
        <${OWL}annotatedProperty> cdm:resource_legal_date_entry-into-force ;
        <${OWL}annotatedTarget> ?entryIntoForceDate ;
        ${TYPE_OF_DATE} ?effectType .
      OPTIONAL { ?effectAxiom ${COMMENT_ON_DATE} ?effectComment . }
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
  }
}`;
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
 * A `comment_on_date`'s `{CODE|uri}` tokens: `fd_335` codes (`{V|…/fd_335/V}`,
 * "see") and references to other documents (`{32005D1212(01)|…/celex/…}`).
 */
const COMMENT_TOKEN = /\{([^{}|]*)\|[^{}]*\}/g;
/** One dotted part of a provision number: `93`, `6a`. */
const NUMBER_PART = /^\d+[a-z]{0,2}$/;
/** One parenthesised subdivision with its `)` split off: `(a`, `(ii`. */
const SUBDIVISION = /^\([a-z0-9]{1,4}$/;
/** An annex number, arabic or roman, with an optional letter. */
const ANNEX_NUMBER = /^[0-9IVXLC]+[a-z]?$/;
/** Provisions compared with their numbers read as numbers: Article 2 before Article 10. */
const PROVISION_ORDER = new Intl.Collator('en', { numeric: true });

/**
 * Whether `ref` is a provision number as CELLAR writes it: dotted numbers, each with
 * up to two letters, then parenthesised subdivisions — `2`, `93.1`, `6a`,
 * `113(a)`, `33.2(a)(ii)`. Each part is checked on its own, so no pattern nests a
 * quantifier.
 */
function isProvisionNumber(ref: string): boolean {
  const open = ref.indexOf('(');
  const numbers = open === -1 ? ref : ref.slice(0, open);
  if (!numbers.split('.').every((part) => NUMBER_PART.test(part))) return false;
  if (open === -1) return true;
  const subdivisions = ref.slice(open).split(')');
  return subdivisions.pop() === '' && subdivisions.every((part) => SUBDIVISION.test(part));
}

/**
 * The clause a comment names after its one `{V}` ("see") code, when the rest of the
 * comment is exactly one article (`{ART} 113(a)`), the sole article
 * (`{ARTUNIQUE}`), an annex (`{ANN}`, `{ANN} II`), or a point (`{PT} 3`); the number
 * stays as CELLAR records it. Anything else names no single provision of the act —
 * another act, an OJ reference, several provisions, "see the text" — and yields
 * none. `comment` has its tokens reduced to `{CODE}`.
 */
function provisionOf(comment: string): string | undefined {
  const sides = comment.split('{V}');
  if (sides.length !== 2) return;
  const [code, ref, ...rest] = (sides[1] as string).trim().split(/\s+/);
  if (rest.length > 0) return;
  if (code === '{ARTUNIQUE}') return ref === undefined ? 'Sole article' : undefined;
  if (code === '{ANN}') {
    if (ref === undefined) return 'Annex';
    return ANNEX_NUMBER.test(ref) ? `Annex ${ref}` : undefined;
  }
  if (ref === undefined || !isProvisionNumber(ref)) return;
  if (code === '{ART}') return `Article ${ref}`;
  if (code === '{PT}') return `Point ${ref}`;
  return;
}

/**
 * The dated entries of the `?datesOfEffect` aggregate, each `date|type|comment`
 * with the comment URI-encoded: one per date, type, and provision, sorted by date
 * and, on one date, in {@link EFFECT_TYPE_VALUES} order with an untyped entry last,
 * then by provision with an entry naming none last. A date whose code maps to no
 * type is listed without one. An `MA` (application) date whose comment carries
 * `{MA/PART}` is a partial application; no other comment changes a type, since
 * other codes in a comment label the clause it cites rather than the date.
 */
function readDatesOfEffect(value: string | undefined): DateOfEffect[] {
  const byKey = new Map<string, DateOfEffect>();
  for (const item of (value ?? '').split(' ')) {
    const first = item.indexOf('|');
    const date = (first === -1 ? item : item.slice(0, first)).slice(0, 10);
    if (!date) continue;
    const last = item.lastIndexOf('|');
    const comment =
      first === -1 ? '' : decodeURIComponent(item.slice(last + 1)).replace(COMMENT_TOKEN, '{$1}');
    const recorded = first === -1 ? undefined : effectTypeOf(item.slice(first + 1, last));
    const type =
      recorded === 'application' && comment.includes('{MA/PART}')
        ? 'partial_application'
        : recorded;
    const provision = provisionOf(comment);
    byKey.set(`${date}|${type ?? ''}|${provision ?? ''}`, {
      date,
      ...(type ? { type } : {}),
      ...(provision ? { provision } : {}),
    });
  }
  const rank = (entry: DateOfEffect) =>
    entry.type ? EFFECT_TYPE_VALUES.indexOf(entry.type) : EFFECT_TYPE_VALUES.length;
  const byProvision = (a: DateOfEffect, b: DateOfEffect) =>
    a.provision === undefined || b.provision === undefined
      ? Number(a.provision === undefined) - Number(b.provision === undefined)
      : PROVISION_ORDER.compare(a.provision, b.provision);
  return [...byKey.values()].sort(
    (a, b) => a.date.localeCompare(b.date) || rank(a) - rank(b) || byProvision(a, b),
  );
}

/** The citation facts of the citation query's row ({@link actCitationQuery}). */
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
