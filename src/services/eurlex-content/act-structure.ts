/**
 * @fileoverview Bespoke structural parser for EU act bodies — detects
 * chapter / section / article / annex / recital headings and addresses them by
 * character offset into the same content string the paging floor windows. Powers
 * `eurlex_get_document`'s outline mode and structural selectors (issue #12).
 *
 * Two code paths, keyed off the requested content format:
 *  - **html / markdown** — text-pattern matching on the RENDERED TEXT, line by
 *    line. CELLAR's CONVEX HTML carries semantic markers (`<p class="oj-ti-art">`),
 *    but {@link ./html-to-markdown} renders through the default `NodeHtmlMarkdown`
 *    translator, which discards the class — only the visible text ("Article 1")
 *    survives. So detection keys off the visible-text patterns (`Article N`,
 *    `CHAPTER <roman>`, `ANNEX …`, recital `(N)` or `N)`) that appear in BOTH strings, so
 *    the emitted offsets stay valid against whichever string is being paged. In
 *    HTML a block tag also ends a line, since a legacy `text/html` body writes its
 *    whole text on one line (#126).
 *  - **xml (Formex 4)** — element matching (`<TI.ART>` numbered by its
 *    `<ARTICLE IDENTIFIER>`, `<TITLE><TI><P>CHAPTER …` / `Section …`, the keyword
 *    optionally wrapped in `<HT>` formatting, and `<NO.P>(N)</NO.P>`), a separate
 *    path since Formex is dense single-line XML with no rendered-text line
 *    anchors. Annex detection is not attempted for Formex — that selector
 *    degrades to the floor.
 *
 * Heading words are read in the language the body is served in (#107): each of
 * the 24 has its own keywords and number order ({@link HEADING_FORMS}), and every
 * heading is reported with the English label and a language-neutral number in
 * every format, so a selector — which may use the served language's kind words —
 * means the same thing in every language and format.
 *
 * An amending act's quoted text — the articles it inserts into another act — is
 * not its own structure (#106): Formex marks it `<QUOT.S>`, CONVEX HTML puts it in
 * a numbering table's cells, and a Markdown body takes the verdict of its source
 * HTML heading by heading, the two heading sequences aligned in order.
 *
 * Case law has none of an act's headings, so a sector-6 body takes its own parser
 * (#117, {@link parseDocumentStructure}): the top-level section headings its markup
 * marks, and a judgment's or order's operative part.
 *
 * Detection is best-effort by design: a body with no parseable structure
 * (malformed conversions, case law with no heading markup) yields an empty
 * result, never an error. The paging floor (`offset`/`limit`, `full`) remains the
 * always-available escape hatch.
 * @module services/eurlex-content/act-structure
 */

import type { ContentFormat, EurLexLanguage } from './eurlex-content-service.js';

/**
 * The structural unit kinds detected in a body: an act's chapters, sections,
 * articles, annexes, and recitals, and a case-law record's section headings and
 * operative part (#117).
 */
export type SectionKind =
  | 'chapter'
  | 'section'
  | 'article'
  | 'annex'
  | 'recital'
  | 'heading'
  | 'operative_part';

/** One detected heading, addressable by character offset into the content string. */
export interface ActHeading {
  /** Structural unit kind. */
  kind: SectionKind;
  /**
   * Human label — "Article 17", "CHAPTER IV", "Section 1", "ANNEX I", "Recital 5" —
   * in English whatever the body's language or format. Only a Formex article with
   * no number to read keeps its own heading text ("Final provision"). A case-law
   * heading keeps its text as served ("Legal context", "Sur les dépens"); the
   * operative part is "Operative part".
   */
  label: string;
  /**
   * Numbering token — "17", "6A", "IV", "I", or "" for a lone unnumbered ANNEX.
   * The same in every language: Roman numerals in Latin letters, and French
   * "premier" as "1". A case-law heading is numbered by its 1-based position, and
   * the operative part carries "".
   */
  number: string;
  /** Character offset of the heading within the content string of the requested format. */
  offset: number;
  /** Descriptive title where the act supplies one (article subtitle, chapter/annex title). */
  title?: string;
}

/**
 * Comma-separated selector strings, one optional field per addressable kind; a
 * case-law heading is addressed by its position, and the operative part by a flag.
 */
export interface SectionSelectors {
  annexes?: string;
  articles?: string;
  chapters?: string;
  headings?: string;
  operative_part?: boolean;
  recitals?: string;
}

/**
 * One selected section's own address in the source body. A selection is a set of
 * slices rather than a contiguous window, so each section carries its own span —
 * which is also what keeps it individually reachable through the paging floor
 * after a capped response drops its text (#12, #80). A section nested inside
 * another selected section keeps its own address too, though its text rides in
 * the enclosing slice (#88).
 */
export interface SelectedSection {
  /** Source characters the section spans — `offset + chars` is its end. */
  chars: number;
  /** Section descriptor, e.g. "Article 17". */
  label: string;
  /** Character offset of the section's heading in the content string. */
  offset: number;
}

/** Outcome of a structural selection — the sliced text plus hit/miss bookkeeping. */
export interface SelectionResult {
  /** Descriptors of the sections that were found and sliced. */
  matched: string[];
  /** Descriptors of the sections that could not be located. */
  missed: string[];
  /** Human descriptors of every requested section, e.g. ["Article 17", "CHAPTER IV"]. */
  requested: string[];
  /**
   * Source address of each distinct located section, in document order — nested
   * ones included. {@link outermostSections} picks the slices that fed `text`.
   */
  sections: SelectedSection[];
  /**
   * The outermost matched sections joined in document order, so every source
   * character appears at most once. Empty when nothing matched.
   */
  text: string;
}

/**
 * Nesting rank — a section ends at the next heading whose rank is the same or
 * broader (numerically ≤). Chapters and annexes are top-level siblings; sections
 * nest in chapters; articles nest in sections; recitals are the finest preamble
 * unit. A case-law heading and the operative part are siblings, so a headed
 * section ends at the next heading or at the operative part, which runs to the
 * end of the body (#117).
 */
const RANK: Record<SectionKind, number> = {
  chapter: 1,
  annex: 1,
  heading: 1,
  operative_part: 1,
  section: 2,
  article: 3,
  recital: 4,
};

/** Human label for a kind + number. A case-law heading is labeled with its own text instead. */
function labelFor(kind: Exclude<SectionKind, 'heading'>, number: string): string {
  switch (kind) {
    case 'operative_part':
      return 'Operative part';
    case 'article':
      return `Article ${number}`;
    case 'chapter':
      return `CHAPTER ${number}`;
    case 'section':
      return `Section ${number}`;
    case 'annex':
      return number ? `ANNEX ${number}` : 'ANNEX';
    case 'recital':
      return `Recital ${number}`;
  }
}

/**
 * Parse the structural outline of an act body. Returns headings ordered by their
 * character offset into `content`. An empty array means no structure was detected
 * (the caller degrades to the paging floor). `language` is the language the body
 * was served in — after any English fallback — since heading words are read in
 * that language only.
 *
 * Headings of quoted amending text — the articles an amending act inserts into
 * another act — are not the act's own and are skipped (#106). A Markdown body
 * carries no cue for them, so `sourceHtml`, the HTML it was rendered from, decides
 * which of its headings are quoted; without it every Markdown heading is kept.
 */
export function parseActStructure(
  content: string,
  format: ContentFormat,
  language: EurLexLanguage,
  sourceHtml?: string,
): ActHeading[] {
  const vocabulary = vocabularyFor(language);
  if (format === 'xml') return parseFormexStructure(content, vocabulary);
  return format === 'markdown'
    ? parseTextStructure(content, vocabulary, false, sourceHtml)
    : parseTextStructure(content, vocabulary, true, undefined);
}

/**
 * Collapse each run of consecutive recitals into one entry spanning the run —
 * `Recitals 1–173` at the first recital's offset — for an outline that leads
 * with the enacting terms rather than the preamble (#118). A lone recital keeps
 * its own entry. Selection still resolves against the uncollapsed headings.
 */
export function collapseRecitals(headings: readonly ActHeading[]): ActHeading[] {
  const out: ActHeading[] = [];
  for (let i = 0; i < headings.length; i++) {
    const first = headings[i] as ActHeading;
    let last = first;
    while (first.kind === 'recital' && headings[i + 1]?.kind === 'recital') {
      last = headings[++i] as ActHeading;
    }
    if (last === first) {
      out.push(first);
      continue;
    }
    const number = `${first.number}–${last.number}`;
    out.push({ kind: 'recital', number, label: `Recitals ${number}`, offset: first.offset });
  }
  return out;
}

/**
 * A reader of how many elements the `tags` pattern opens enclose a position, for
 * positions asked in ascending order. `tags` captures the closing slash in group 1;
 * a self-closing tag encloses nothing, and a stray closer never takes the depth
 * below zero. The tags are found in one pass, and each question only reads forward.
 */
function nestingDepth(content: string, tags: RegExp): (at: number) => number {
  const events = Array.from(content.matchAll(tags), (m) => ({
    at: m.index,
    delta: m[1] ? -1 : m[0].endsWith('/>') ? 0 : 1,
  }));
  let next = 0;
  let depth = 0;
  return (at) => {
    for (let event = events[next]; event && event.at < at; event = events[++next]) {
      depth = Math.max(0, depth + event.delta);
    }
    return depth;
  };
}

// --- Heading vocabulary ---

/** An act's numbered heading kinds, each written with a keyword and a number. */
type NumberedKind = 'article' | 'chapter' | 'section' | 'annex';

/**
 * How one language writes its numbered headings in the Official Journal. `#` marks
 * where the number sits: most languages put the keyword first ("Artikel 1"), and
 * Estonian, Finnish, Hungarian, Lithuanian, and Latvian put the number first in
 * some or all ("1. cikk", "I LUKU").
 */
type HeadingForms = Record<NumberedKind, string> & {
  /** A word the language writes in place of the first article's number. */
  articleOne?: string;
};

/**
 * Heading forms per language, as `32024R1689` writes them in each (#107). The
 * number accepts the forms every language shares on top: a trailing period
 * ("Članak 1.", "I. FEJEZET", and Markdown's escaped `1\.`), the Portuguese
 * ordinal ("Artigo 1.º", `1. o` once its superscript is stripped), and Greek
 * capital Ι/Χ standing in for the Roman I/X ("ΚΕΦΑΛΑΙΟ ΙV").
 */
const HEADING_FORMS: Record<EurLexLanguage, HeadingForms> = {
  EN: { article: 'Article #', chapter: 'CHAPTER #', section: 'SECTION #', annex: 'ANNEX #' },
  FR: {
    article: 'Article #',
    chapter: 'CHAPITRE #',
    section: 'SECTION #',
    annex: 'ANNEXE #',
    articleOne: 'premier',
  },
  DE: { article: 'Artikel #', chapter: 'KAPITEL #', section: 'ABSCHNITT #', annex: 'ANHANG #' },
  ES: { article: 'Artículo #', chapter: 'CAPÍTULO #', section: 'SECCIÓN #', annex: 'ANEXO #' },
  IT: { article: 'Articolo #', chapter: 'CAPO #', section: 'SEZIONE #', annex: 'ALLEGATO #' },
  PL: { article: 'Artykuł #', chapter: 'ROZDZIAŁ #', section: 'SEKCJA #', annex: 'ZAŁĄCZNIK #' },
  PT: { article: 'Artigo #', chapter: 'CAPÍTULO #', section: 'SECÇÃO #', annex: 'ANEXO #' },
  NL: { article: 'Artikel #', chapter: 'HOOFDSTUK #', section: 'AFDELING #', annex: 'BIJLAGE #' },
  CS: { article: 'Článek #', chapter: 'KAPITOLA #', section: 'ODDÍL #', annex: 'PŘÍLOHA #' },
  DA: { article: 'Artikel #', chapter: 'KAPITEL #', section: 'AFDELING #', annex: 'BILAG #' },
  EL: { article: 'Άρθρο #', chapter: 'ΚΕΦΑΛΑΙΟ #', section: 'ΤΜΗΜΑ #', annex: 'ΠΑΡΑΡΤΗΜΑ #' },
  ET: { article: 'Artikkel #', chapter: '# PEATÜKK', section: '# JAGU', annex: '# LISA' },
  FI: { article: '# artikla', chapter: '# LUKU', section: '# JAKSO', annex: 'LIITE #' },
  HU: { article: '# cikk', chapter: '# FEJEZET', section: '# SZAKASZ', annex: '# MELLÉKLET' },
  LT: {
    article: '# straipsnis',
    chapter: '# SKYRIUS',
    section: '# SKIRSNIS',
    annex: '# PRIEDAS',
  },
  LV: { article: '# pants', chapter: '# NODAĻA', section: '# IEDAĻA', annex: '# PIELIKUMS' },
  MT: { article: 'Artikolu #', chapter: 'KAPITOLU #', section: 'TAQSIMA #', annex: 'ANNESS #' },
  RO: {
    article: 'Articolul #',
    chapter: 'CAPITOLUL #',
    section: 'SECȚIUNEA #',
    annex: 'ANEXA #',
  },
  SK: { article: 'Článok #', chapter: 'KAPITOLA #', section: 'ODDIEL #', annex: 'PRÍLOHA #' },
  SL: { article: 'Člen #', chapter: 'POGLAVJE #', section: 'ODDELEK #', annex: 'PRILOGA #' },
  SV: { article: 'Artikel #', chapter: 'KAPITEL #', section: 'AVSNITT #', annex: 'BILAGA #' },
  BG: { article: 'Член #', chapter: 'ГЛАВА #', section: 'РАЗДЕЛ #', annex: 'ПРИЛОЖЕНИЕ #' },
  HR: {
    article: 'Članak #',
    chapter: 'POGLAVLJE #',
    section: 'ODJELJAK #',
    annex: 'PRILOG #',
  },
  GA: {
    article: 'Airteagal #',
    chapter: 'CAIBIDIL #',
    section: 'ROINN #',
    annex: 'IARSCRÍBHINN #',
  },
};

/** One language's heading patterns, compiled from its {@link HEADING_FORMS}. */
interface Vocabulary {
  /** The word for one (French "premier"), read as article number 1. */
  articleOne: string | undefined;
  /** Sticky Formex chapter/section matcher; see {@link formexHeadingPattern}. */
  formexHeading: RegExp;
  /** Whole-line matchers for the rendered-text path. */
  lines: {
    annex: RegExp;
    article: RegExp;
    chapter: RegExp;
    section: RegExp;
  };
  /** One of the language's heading keywords, as a whole word ("Artikel", "cikk"). */
  selectorWord: RegExp;
}

/** Roman numerals, with the Greek capitals Ι (iota) and Χ (chi) the Greek text writes for I and X. */
const ROMAN = '[IVXLCDMΙΧ]+';

/** A trailing period after a number, escaped as `\.` where Markdown renders it line-initial. */
const PERIOD = '(?:\\\\?\\.)?';

/** Where the number sits in a form, and the keyword around it. */
function splitForm(form: string): { keyword: string; numberFirst: boolean } {
  return { keyword: form.replace('#', '').trim(), numberFirst: form.startsWith('#') };
}

/** Greek capital vowels and their accented (tonos) forms. */
const GREEK_TONOS: Record<string, string> = {
  Α: 'Ά',
  Ε: 'Έ',
  Η: 'Ή',
  Ι: 'Ί',
  Ο: 'Ό',
  Υ: 'Ύ',
  Ω: 'Ώ',
};

/**
 * A keyword as a pattern source. Greek capitals drop the accent their lower case
 * carries (`ΤΜΗΜΑ` / `Τμήμα`), and Formex writes some headings in title case, so
 * each unaccented Greek capital vowel also admits its accented form.
 */
function keywordSource(keyword: string): string {
  return keyword
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/[ΑΕΗΙΟΥΩ]/g, (vowel) => `[${vowel}${GREEK_TONOS[vowel]}]`);
}

/**
 * A heading standing ALONE on its line — the OJ layout puts the descriptive title
 * on the following line, and requiring the heading alone rejects prose
 * cross-references ("Chapter V on the transfer of personal data…"); a chapter or
 * section may also carry a title in capitals ({@link titledPattern}). A keyword
 * after its number may carry a case ending, which the languages writing the number
 * first attach to it ("34 artiklan", #131). `number` is the number's pattern
 * source, with one capture group.
 */
function linePattern(form: string, number: string): RegExp {
  const { keyword, numberFirst } = splitForm(form);
  const word = keywordSource(keyword);
  return new RegExp(
    numberFirst ? `^${number}\\s+${word}\\p{Ll}*\\s*$` : `^${word}\\s+${number}\\s*$`,
    'u',
  );
}

/**
 * CHAPTER and SECTION also accept a title after the heading on the same line,
 * captured in group 2, as legacy `text/html` acts write it ("CHAPTER I GENERAL
 * PROVISIONS", "I JAKSO TIETOJEN LAATUA KOSKEVAT PERIAATTEET", #130). The pattern
 * is case-insensitive for the keyword, and under that flag `\p{Lu}` and `\p{Ll}`
 * match either case, so whether the title is in capitals is decided apart, by
 * {@link isCapitalized}.
 */
function titledPattern(form: string, number: string): RegExp {
  const { keyword, numberFirst } = splitForm(form);
  const word = keywordSource(keyword);
  const title = '(?:\\s+(.*?))?';
  return new RegExp(
    numberFirst ? `^${number}\\s+${word}${title}\\s*$` : `^${word}\\s+${number}${title}\\s*$`,
    'iu',
  );
}

/**
 * True when text has a capital letter and no lower-case one, in any script — Greek
 * and Cyrillic have case like Latin. German `ß` has no traditional capital, so an
 * all-caps title may keep it. A prose cross-reference ("Chapter V on the transfer
 * of…") always runs into lower case, so an inline heading title must pass this.
 */
function isCapitalized(text: string): boolean {
  return /\p{Lu}/u.test(text) && !/\p{Ll}/u.test(text.replaceAll('ß', ''));
}

/**
 * ANNEX also stands alone unnumbered, and accepts a delimited inline title, which
 * some acts use ("ANNEX I — Requirements"). A keyword-first number must end at a
 * space or the line end, so "ANNEX Ia" is not ANNEX I.
 */
function annexPattern(form: string): RegExp {
  const { keyword, numberFirst } = splitForm(form);
  const word = keywordSource(keyword);
  const number = `(${ROMAN}|\\d+|[A-Z])${PERIOD}`;
  const title = '(?:\\s*[-–—:.]\\s*(.*))?';
  return new RegExp(
    numberFirst
      ? `^(?:${number}\\s+)?${word}${title}\\s*$`
      : `^${word}(?:\\s+${number}(?=\\s|$))?${title}\\s*$`,
    'u',
  );
}

/**
 * The Formex chapter/section keyword and number, matched where a title paragraph
 * opens. Inline formatting may wrap the keyword — GDPR writes
 * `<HT TYPE="ITALIC">CHAPTER I</HT>` and `<HT TYPE="EXPANDED">Section 1</HT>` —
 * and wrappers nest, so any run of `<HT …>` openers is skipped first (#90).
 * Case-insensitive for title-case sections ("Section 1", "1. szakasz"). The
 * matched kind is the named group that captured the number. Sticky: it only
 * ever reads forward from `lastIndex`.
 */
function formexHeadingPattern(forms: HeadingForms): RegExp {
  const branch = (form: string, group: 'chapter' | 'section') => {
    const { keyword, numberFirst } = splitForm(form);
    const number = `(?<${group}>[IVXLCDMΙΧ0-9]+)`;
    const word = keywordSource(keyword);
    // A number-first keyword must end there, as the keyword-first one must be
    // followed by its number: "I. FEJEZETBEN" is prose, not CHAPTER I.
    return numberFirst ? `${number}\\.?\\s+${word}(?!\\p{L})` : `${word}\\s+${number}`;
  };
  return new RegExp(
    `\\s*(?:<HT\\b[^>]*>\\s*)*(?:${branch(forms.chapter, 'chapter')}|${branch(forms.section, 'section')})`,
    'iuy',
  );
}

const vocabularies = new Map<EurLexLanguage, Vocabulary>();

/** The compiled heading patterns of a language, built on first use. */
function vocabularyFor(language: EurLexLanguage): Vocabulary {
  const cached = vocabularies.get(language);
  if (cached) return cached;
  const forms = HEADING_FORMS[language];
  const one = forms.articleOne ? `|${forms.articleOne}` : '';
  const numeral = `(${ROMAN}|\\d+)${PERIOD}`;
  const words = (['article', 'chapter', 'section', 'annex'] as const)
    .map((kind) => keywordSource(splitForm(forms[kind]).keyword))
    .join('|');
  const vocabulary: Vocabulary = {
    articleOne: forms.articleOne,
    formexHeading: formexHeadingPattern(forms),
    selectorWord: new RegExp(`^(?:${words})$`, 'iu'),
    lines: {
      article: linePattern(forms.article, `(\\d+[a-z]?${one})(?:\\\\?\\.(?:\\s*[oº])?)?`),
      chapter: titledPattern(forms.chapter, numeral),
      section: titledPattern(forms.section, numeral),
      annex: annexPattern(forms.annex),
    },
  };
  vocabularies.set(language, vocabulary);
  return vocabulary;
}

/**
 * A numbering token in its language-neutral form: upper case, with the Greek
 * capitals Ι and Χ read as the Roman I and X they stand in for.
 */
function neutralNumber(token: string): string {
  return token.toUpperCase().replace(/[ΙΧ]/g, (letter) => (letter === 'Ι' ? 'I' : 'X'));
}

// --- HTML / Markdown: rendered-text line matching ---

interface RawLine {
  offset: number;
  raw: string;
  visible: string;
}

/**
 * A block-level HTML tag, open or close: paragraph, division, line break, heading,
 * list item, and table, row, cell, and table-section tags. `[^<>]` keeps each match
 * attempt inside one tag, so a run of unclosed openers costs one pass.
 */
const BLOCK_TAG_RE =
  /<\/?(?:p|div|br|h[1-6]|li|table|thead|tbody|tfoot|tr|td|th)(?=[\s/>])[^<>]*>/gi;

/**
 * Split into lines, preserving each line's character offset in the source string.
 * In an HTML body a block tag also ends a line (#126): a legacy `text/html` act
 * writes its whole text as one line of `<p>…</p>` paragraphs, so no heading would
 * otherwise stand alone on its line. A tag preceded only by whitespace on its line
 * does not split it, so a CONVEX line — one indented tag per line — keeps its
 * offset. Each segment keeps its offset in the string as served, which is never
 * rewritten (#12, #48).
 */
function splitLines(content: string, html: boolean): RawLine[] {
  const out: RawLine[] = [];
  const push = (raw: string, offset: number) =>
    out.push({ raw, visible: visibleText(raw), offset });
  let offset = 0;
  for (const line of content.split('\n')) {
    let start = 0;
    if (html) {
      const lead = line.search(/\S/);
      for (const tag of line.matchAll(BLOCK_TAG_RE)) {
        if (tag.index <= lead) continue;
        push(line.slice(start, tag.index), offset + start);
        start = tag.index;
      }
    }
    push(line.slice(start), offset + start);
    offset += line.length + 1; // + 1 for the consumed '\n'
  }
  return out;
}

/**
 * An HTML `<table>` or `</table>` tag, the closing slash in group 1. `[^<>]` keeps
 * each match attempt inside one tag, so a run of unclosed openers costs one pass.
 */
const TABLE_TAG_RE = /<(\/?)table(?=[\s/>])[^<>]*>/gi;

/** The whitespace and tags a line opens with, before its first visible character. Sticky. */
const LEADING_MARKUP_RE = /(?:\s|<[^<>]*>)*/y;

/**
 * Strip HTML tags and decode common entities to the human-visible text of a line.
 * A tag match stops at the next `<`, so a run of `<` with no `>` after it fails
 * each attempt at once instead of rescanning to the end of the text per opener.
 */
function visibleText(line: string): string {
  return decodeEntities(line.replace(/<[^<>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Named references worth resolving in OJ heading text. A Map, not an object
 * literal: the reference name comes from the document, and an object lookup
 * walks the prototype chain, so `&constructor;` would resolve to `Object` and
 * stringify into the heading. A Map resolves these five names and nothing else;
 * legacy `text/html` bodies write straight quotes as `&quot;` (#126).
 */
const NAMED_ENTITIES = new Map<string, string>([
  ['amp', '&'],
  ['gt', '>'],
  ['lt', '<'],
  ['nbsp', ' '],
  ['quot', '"'],
]);

/** Highest Unicode code point `String.fromCodePoint` accepts. */
const MAX_CODE_POINT = 0x10ffff;

/**
 * Decode every character reference in ONE pass, so each is decoded exactly once
 * (#79). A sequential replace chain decodes `&amp;` into an `&` that the later
 * passes read as the start of a fresh reference, turning the act's own escaped
 * `&amp;lt;b&amp;gt;` into real `<b>` markup. Scanning once leaves the `&` this
 * replacement produced untouched. An unknown name or an out-of-range code point
 * is left verbatim rather than dropped or thrown on.
 */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (reference, body: string) => {
    if (body[0] !== '#') return NAMED_ENTITIES.get(body.toLowerCase()) ?? reference;
    const hex = body[1] === 'x' || body[1] === 'X';
    const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
    return code <= MAX_CODE_POINT ? String.fromCodePoint(code) : reference;
  });
}

/**
 * A preamble recital marker, `(N)` in every language, or `N)` as legacy Finnish
 * and Swedish bodies write it (#131).
 */
const RECITAL_RE = /^\(?(\d+)\)(?:\s|$)/;

/** Classify a line's visible text as a structural (non-recital) heading, or null. */
function classifyStructural(
  v: string,
  { lines, articleOne }: Vocabulary,
): { kind: NumberedKind; number: string; title?: string } | null {
  const article = lines.article.exec(v);
  if (article) {
    const number = article[1] ?? '';
    return { kind: 'article', number: number === articleOne ? '1' : neutralNumber(number) };
  }
  for (const kind of ['chapter', 'section'] as const) {
    const heading = lines[kind].exec(v);
    const title = heading?.[2];
    if (heading && (title === undefined || isCapitalized(title))) {
      return { kind, number: neutralNumber(heading[1] ?? ''), ...(title ? { title } : {}) };
    }
  }
  const annex = lines.annex.exec(v);
  if (annex) {
    const title = annex[2]?.trim();
    return {
      kind: 'annex',
      number: neutralNumber(annex[1] ?? ''),
      ...(title ? { title } : {}),
    };
  }
  return null;
}

/** A structural heading line, flagged when its text sits inside an HTML `<table>`. */
type HeadingLine = ActHeading & { inTable: boolean; lineIndex: number };

/**
 * Every structural (non-recital) heading line, in document order. CONVEX lays an
 * amending point out as a numbering table and puts the headings it quotes in the
 * table's cells, while the act's own headings never sit in one, so `inTable` marks
 * a quoted heading. The depth is read where the line's visible text starts.
 */
function headingLines(content: string, lines: readonly RawLine[], vocabulary: Vocabulary) {
  const tableDepth = nestingDepth(content, TABLE_TAG_RE);
  const found: HeadingLine[] = [];
  lines.forEach((ln, i) => {
    const c = classifyStructural(ln.visible, vocabulary);
    if (!c) return;
    LEADING_MARKUP_RE.lastIndex = 0;
    LEADING_MARKUP_RE.exec(ln.raw);
    found.push({
      kind: c.kind,
      number: c.number,
      label: labelFor(c.kind, c.number),
      offset: ln.offset,
      lineIndex: i,
      inTable: tableDepth(ln.offset + LEADING_MARKUP_RE.lastIndex) > 0,
      ...(c.title ? { title: c.title } : {}),
    });
  });
  return found;
}

/**
 * Which Markdown headings are quoted, read from the HTML the Markdown was rendered
 * from. The conversion flattens the numbering tables, and it can also lose an
 * in-table heading the HTML detects: a quoted heading whose opening `‘` sits on a
 * line of its own renders as `‘ Section 3`, and a genuine table's cells render as
 * a GFM row. So the two sequences are aligned in order, each Markdown heading
 * taking the verdict of the next HTML heading of the same kind and number, and an
 * HTML heading may be passed over only when it sits in a table. When a Markdown
 * heading has no counterpart, or an HTML heading outside any table would be passed
 * over, the verdicts cannot be placed and every Markdown heading is kept, as it was
 * before quoted text was recognized. Both sequences are read once, forward only.
 */
function markdownQuoted(found: readonly HeadingLine[], html: string, vocabulary: Vocabulary) {
  const source = headingLines(html, splitLines(html, true), vocabulary);
  const keepAll = () => found.map(() => false);
  const quoted: boolean[] = [];
  let next = 0;
  for (const heading of found) {
    let counterpart = source[next];
    while (
      counterpart &&
      (counterpart.kind !== heading.kind || counterpart.number !== heading.number)
    ) {
      if (!counterpart.inTable) return keepAll();
      counterpart = source[++next];
    }
    if (!counterpart) return keepAll();
    quoted.push(counterpart.inTable);
    next++;
  }
  return source.slice(next).every((h) => h.inTable) ? quoted : keepAll();
}

function parseTextStructure(
  content: string,
  vocabulary: Vocabulary,
  html: boolean,
  sourceHtml: string | undefined,
): ActHeading[] {
  const lines = splitLines(content, html);
  const found = headingLines(content, lines, vocabulary);
  const quoted =
    sourceHtml === undefined
      ? found.map((h) => h.inTable)
      : markdownQuoted(found, sourceHtml, vocabulary);
  const structural = found.filter((_, i) => !quoted[i]);

  // No chapter/section/article/annex heading anywhere → not a structured act
  // (e.g. case law). Bare recital-looking markers alone don't constitute
  // detectable structure, so return nothing and let the caller degrade.
  if (structural.length === 0) return [];

  // Titles: the OJ layout puts an article's subtitle / a chapter's title on the
  // line after the heading. Take the first following non-empty line that isn't
  // itself a heading.
  for (const h of structural) {
    if (h.title) continue;
    for (let j = h.lineIndex + 1; j < lines.length; j++) {
      const line = lines[j];
      if (!line) continue;
      const v = line.visible;
      if (!v) continue;
      if (!classifyStructural(v, vocabulary) && v.length <= 200) h.title = v;
      break;
    }
  }

  // Recitals: `(N)` or `N)` markers in the preamble, before the enacting
  // terms begin. After the first article/chapter/section, such markers are
  // numbered sub-points, not recitals — so gate on the first enacting offset.
  const firstEnacting = Math.min(
    ...structural
      .filter((h) => h.kind === 'article' || h.kind === 'chapter' || h.kind === 'section')
      .map((h) => h.offset),
  );
  const recitals: ActHeading[] = [];
  if (Number.isFinite(firstEnacting)) {
    for (const ln of lines) {
      if (ln.offset >= firstEnacting) break;
      const m = RECITAL_RE.exec(ln.visible);
      if (m) {
        const n = m[1] ?? '';
        recitals.push({ kind: 'recital', number: n, label: `Recital ${n}`, offset: ln.offset });
      }
    }
  }

  const all: ActHeading[] = [
    ...structural.map(({ lineIndex: _lineIndex, inTable: _inTable, ...h }) => h),
    ...recitals,
  ];
  all.sort((a, b) => a.offset - b.offset);
  return all;
}

// --- Formex 4 XML: element matching ---

/**
 * A Formex quotation mark, self-closing (`<QUOT.START CODE="2018" …/>`) or as an
 * empty start/end pair (`<QUOT.START CODE="2018" …></QUOT.START>`), and likewise
 * `QUOT.END`. `[^<>]` keeps each match attempt inside one tag, so a run of
 * unclosed openers costs one pass.
 */
const FORMEX_QUOT_RE = /<(QUOT\.(?:START|END))\b([^<>]*?)(?:\/>|><\/\1>)/g;

/**
 * The character reference for a quotation mark's `CODE` — the mark's code point in
 * hex — or undefined when the code is missing, not hex, beyond Unicode, or names a
 * surrogate or control character.
 */
function quoteMarkReference(attributes: string): string | undefined {
  const code = /\bCODE="([0-9A-F]{1,6})"/i.exec(attributes)?.[1];
  if (!code) return;
  const point = Number.parseInt(code, 16);
  if (point > MAX_CODE_POINT || /[\p{Cc}\p{Cs}]/u.test(String.fromCodePoint(point))) return;
  return `&#x${code};`;
}

/**
 * Strip tags/entities from a Formex element's inner text. Formex writes a quotation
 * mark as an element naming its character by `CODE` (#99); a valid one becomes a
 * character reference in place, with no padding, so the single decoding pass
 * renders it and a mark that is itself `&` never starts a second reference (#79).
 * A mark with an unusable `CODE` is left to the tag stripper, as before.
 */
function formexText(inner: string): string {
  return visibleText(
    inner.replace(
      FORMEX_QUOT_RE,
      (element, _name, attributes: string) => quoteMarkReference(attributes) ?? element,
    ),
  );
}

/** Where a Formex article heading opens. */
const FORMEX_TI_ART_OPEN_RE = /<TI\.ART>/g;

/** A `<STI.ART>` subtitle directly after an article's `</TI.ART>`. Sticky. */
const FORMEX_STI_ART_OPEN_RE = /\s*<STI\.ART>/y;

/** Where a Formex title paragraph opens — the only place a chapter/section heading starts. */
const FORMEX_TI_OPEN_RE = /<TI>\s*<P>/g;

/**
 * An `<ARTICLE>` opener followed directly by the article's `<TI.ART>`, capturing
 * its attributes. `[^<>]` keeps each match attempt inside one tag, so a run of
 * unclosed openers costs one pass; the `IDENTIFIER` is read from the captured
 * attributes afterwards, since finding it inside this pattern would rescan the
 * rest of an unclosed tag once per attribute.
 */
const FORMEX_ARTICLE_OPEN_RE = /<ARTICLE\b([^<>]*)>\s*(?=<TI\.ART>)/g;

/**
 * Article number of each `<TI.ART>` whose `<ARTICLE>` names one, keyed by the
 * heading's offset. The `IDENTIFIER` is language-neutral where the heading text
 * is not ("Article premier", "1. cikk"): zero-padded digits and an optional letter
 * suffix, `001` → `1`, `006A` → `6A`. Any other shape is skipped, leaving that
 * heading to be numbered from its text.
 */
function formexArticleNumbers(content: string): Map<number, string> {
  const numbers = new Map<number, string>();
  for (const m of content.matchAll(FORMEX_ARTICLE_OPEN_RE)) {
    const identifier = /\bIDENTIFIER="([^"]*)"/.exec(m[1] ?? '')?.[1] ?? '';
    const id = /^0*(\d+)([A-Z]*)$/i.exec(identifier);
    if (id) numbers.set(m.index + m[0].length, `${Number(id[1])}${(id[2] ?? '').toUpperCase()}`);
  }
  return numbers;
}

/** A `<STI>` subtitle directly after a heading's `</TI>`. Sticky, like the heading. */
const FORMEX_STI_OPEN_RE = /\s*<STI>/y;

/**
 * Return a finder for the first index of `needle` at or after a position. The
 * heading scan asks with a position that only moves forward, so the finder
 * answers from its previous search whenever that answer still holds, and a run
 * of openers with no closer costs one pass over the text rather than one per
 * opener. A backward position falls back to a fresh search.
 */
function forwardFinder(text: string, needle: string): (from: number) => number {
  let searchedFrom = Number.POSITIVE_INFINITY;
  let found = -1;
  return (from) => {
    if (from >= searchedFrom && (found === -1 || found >= from)) return found;
    searchedFrom = from;
    found = text.indexOf(needle, from);
    return found;
  };
}

/**
 * A Formex `<QUOT.S>` or `</QUOT.S>` tag — the container for quoted structure,
 * not the `QUOT.START` mark — with the closing slash in group 1.
 */
const FORMEX_QUOT_S_TAG_RE = /<(\/?)QUOT\.S(?=[\s/>])[^<>]*>/g;

function parseFormexStructure(content: string, vocabulary: Vocabulary): ActHeading[] {
  const headings: ActHeading[] = [];

  // Articles: <TI.ART>Article 17</TI.ART> optionally followed by <STI.ART>title</STI.ART>.
  // Each heading runs to the first </TI.ART> after its opener, and its subtitle to
  // the first </STI.ART>, both through forward-only finders (#94). An opener inside
  // the previous heading or its subtitle belongs to that heading's text, not a new
  // one, so the scan resumes past the span the previous heading consumed. The
  // number comes from the enclosing <ARTICLE IDENTIFIER> where it names one (#107).
  // An opener inside <QUOT.S> heads text the act quotes into another act, not
  // one of its own articles, and is skipped (#106).
  const articleNumbers = formexArticleNumbers(content);
  const nextTiArtClose = forwardFinder(content, '</TI.ART>');
  const nextStiArtClose = forwardFinder(content, '</STI.ART>');
  const articleQuoteDepth = nestingDepth(content, FORMEX_QUOT_S_TAG_RE);
  let consumedTo = 0;
  for (const open of content.matchAll(FORMEX_TI_ART_OPEN_RE)) {
    if (open.index < consumedTo || articleQuoteDepth(open.index) > 0) continue;
    const labelStart = open.index + open[0].length;
    const tiClose = nextTiArtClose(labelStart);
    if (tiClose === -1) break; // no </TI.ART> anywhere past here, so no later heading closes either
    consumedTo = tiClose + '</TI.ART>'.length;

    FORMEX_STI_ART_OPEN_RE.lastIndex = consumedTo;
    const stiOpen = FORMEX_STI_ART_OPEN_RE.exec(content);
    const stiClose = stiOpen ? nextStiArtClose(FORMEX_STI_ART_OPEN_RE.lastIndex) : -1;
    let title: string | undefined;
    if (stiClose !== -1) {
      title = formexText(content.slice(FORMEX_STI_ART_OPEN_RE.lastIndex, stiClose));
      consumedTo = stiClose + '</STI.ART>'.length;
    }

    // The label is the English one the text path and the selectors use; only an
    // article with no number to read keeps its own heading text.
    const text = formexText(content.slice(labelStart, tiClose));
    const number =
      articleNumbers.get(open.index) ?? (text.match(/(\d+[a-z]?)/)?.[1] ?? '').toUpperCase();
    headings.push({
      kind: 'article',
      number,
      label: number || !text ? labelFor('article', number) : text,
      offset: open.index,
      ...(title ? { title } : {}),
    });
  }

  // Chapters / sections: a <TITLE> whose <TI><P> reads "CHAPTER I" / "Section 1"
  // in the served language, closed by </TI>, with the descriptive title in a
  // sibling <STI> directly after. (The document-level title uses <TI><P> too, but
  // its text isn't a chapter/section heading, so it's skipped.) Each heading is
  // bounded by its own </TI> and </STI> through forward-only finders rather than a
  // lazy scan to the closer, which re-read the rest of the document once per
  // unclosed opener. A title inside <QUOT.S> is quoted, like a quoted article.
  const headingRe = vocabulary.formexHeading;
  const nextTiClose = forwardFinder(content, '</TI>');
  const nextStiClose = forwardFinder(content, '</STI>');
  const titleQuoteDepth = nestingDepth(content, FORMEX_QUOT_S_TAG_RE);
  for (const open of content.matchAll(FORMEX_TI_OPEN_RE)) {
    if (titleQuoteDepth(open.index) > 0) continue;
    headingRe.lastIndex = open.index + open[0].length;
    const head = headingRe.exec(content);
    if (!head) continue;
    const tiClose = nextTiClose(headingRe.lastIndex);
    if (tiClose === -1) break; // no </TI> anywhere past here, so no later heading closes either
    const chapter = head.groups?.chapter;
    const kind: NumberedKind = chapter === undefined ? 'section' : 'chapter';
    const number = neutralNumber(chapter ?? head.groups?.section ?? '');

    FORMEX_STI_OPEN_RE.lastIndex = tiClose + '</TI>'.length;
    const stiOpen = FORMEX_STI_OPEN_RE.exec(content);
    const stiClose = stiOpen ? nextStiClose(FORMEX_STI_OPEN_RE.lastIndex) : -1;
    const title =
      stiClose === -1
        ? undefined
        : formexText(content.slice(FORMEX_STI_OPEN_RE.lastIndex, stiClose));

    headings.push({
      kind,
      number,
      label: labelFor(kind, number),
      offset: open.index,
      ...(title ? { title } : {}),
    });
  }

  // Recitals: <NO.P>(N)</NO.P> — parenthesized, in the <GR.CONSID> preamble. Gate
  // on the first article offset so numbered article sub-points aren't miscounted.
  const firstArticleOffset = headings
    .filter((h) => h.kind === 'article')
    .reduce((min, h) => Math.min(min, h.offset), Number.POSITIVE_INFINITY);
  for (const m of content.matchAll(/<NO\.P>\s*\((\d+)\)\s*<\/NO\.P>/gi)) {
    const at = m.index ?? 0;
    if (at >= firstArticleOffset) break;
    const n = m[1] ?? '';
    headings.push({ kind: 'recital', number: n, label: `Recital ${n}`, offset: at });
  }

  headings.sort((a, b) => a.offset - b.offset);
  return headings;
}

// --- Case law (#117) ---

/**
 * A work's structure, read by the parser its CELEX calls for. A sector-6 work is
 * case law: its top-level section headings and, when the CELEX names a judgment or
 * an order (descriptor `J` or `O`, as in `62012CJ0131` and `62023CO0141`), its
 * operative part; an AG opinion (`62023CC0135`) has headings only. Any other work
 * is an act, read by {@link parseActStructure}. The parser is a function of the
 * CELEX alone, so a Markdown heading list cached under its CELEX (#129) is always
 * the one this reads.
 */
export function parseDocumentStructure(
  celex: string,
  content: string,
  format: ContentFormat,
  language: EurLexLanguage,
  sourceHtml?: string,
): ActHeading[] {
  if (!isCaseLawCelex(celex)) return parseActStructure(content, format, language, sourceHtml);
  const ruling = RULING_CELEX_RE.test(celex);
  if (format === 'xml') return formexCaseLawStructure(content, ruling);
  const formula = operativeFormula(language);
  return format === 'html'
    ? htmlLandmarks(content, formula, ruling).map(({ atx: _atx, text: _text, ...h }) => h)
    : markdownCaseLawStructure(content, sourceHtml, formula, ruling);
}

/** True for a sector-6 CELEX: case law of the EU courts. */
export function isCaseLawCelex(celex: string): boolean {
  return celex.startsWith('6');
}

/** A judgment's or order's CELEX: sector 6, the year, the court letter, then `J` or `O`. */
const RULING_CELEX_RE = /^6\d{4}[A-Z][JO]/;

/**
 * How a judgment's or order's operative part opens in each language, as pattern
 * sources matched case-insensitively at the start of a paragraph: "On those
 * grounds, the Court (Grand Chamber) hereby rules:", "hereby:", or "hereby
 * orders:". Dutch has no lead-in phrase, so its ruling opens with the court and
 * the verb: "Het Hof (Vierde kamer) verklaart voor recht:", each gap bounded so a long
 * paragraph with no period is not backtracked over quadratically. EN, FR, and DE are read
 * from `62012CJ0131`, EN also from `62014TJ0353`, `62023CO0141`, and `62025TJ0069`,
 * FR also from `62025TJ0069`, ES, IT, NL, PL, SV, LT, HR, and EL from
 * `62019CJ0311`, and PT, DA, FI, HU, ET, BG, and HR again from `62018CJ0311`. Croatian
 * writes the formula both as "Slijedom navedenog" and "Slijedom navedenoga"
 * (`62018CJ0311`). The rest are the Court's standard wording, best-effort.
 */
const OPERATIVE_FORMULAS: Record<EurLexLanguage, readonly string[]> = {
  EN: ['On those grounds', 'On these grounds'],
  FR: ['Par ces motifs'],
  DE: ['Aus diesen Gründen'],
  ES: ['En virtud de todo lo expuesto', 'Por todo lo expuesto'],
  IT: ['Per questi motivi'],
  PL: ['Z powyższych względów'],
  PT: ['Pelos fundamentos expostos'],
  NL: [
    'Om die redenen',
    'Het (?:Hof|Gerecht)\\b[^.]{0,100}\\b(?:verklaart|beschikt|rechtdoende)\\b[^.]{0,100}:$',
    'De (?:vice-?)?president\\b[^.]{0,100}\\bbeschikt:$',
  ],
  CS: ['Z těchto důvodů'],
  DA: ['På grundlag af disse præmisser'],
  EL: ['Για τους λόγους αυτούς'],
  ET: ['Esitatud põhjendustest lähtudes'],
  FI: ['Näillä perusteilla'],
  HU: ['A fenti indokok alapján'],
  LT: ['Remdamasis šiais motyvais'],
  LV: ['Ar šādu pamatojumu'],
  MT: ['Għal dawn il-motivi'],
  RO: ['Pentru aceste motive'],
  SK: ['Z týchto dôvodov'],
  SL: ['Iz teh razlogov'],
  SV: ['Mot denna bakgrund', 'På dessa grunder'],
  BG: ['По изложените съображения'],
  HR: ['Slijedom navedenoga?'],
  GA: ['Ar na forais sin'],
};

const formulas = new Map<EurLexLanguage, RegExp>();

/** A paragraph opening with the language's operative formula, built on first use. */
function operativeFormula(language: EurLexLanguage): RegExp {
  const cached = formulas.get(language);
  if (cached) return cached;
  const formula = new RegExp(`^(?:${OPERATIVE_FORMULAS[language].join('|')})(?!\\p{L})`, 'iu');
  formulas.set(language, formula);
  return formula;
}

/**
 * A case-law landmark in an HTML body, with what a Markdown rendering of the body
 * shows for it: a heading element renders as an ATX heading line (`## Grounds`),
 * and `text` is its visible text as {@link landmarkText} reads a line.
 */
interface Landmark extends ActHeading {
  atx: boolean;
  text: string;
}

/**
 * The classes of a top-level section heading, one per generation of CELLAR's html:
 * `title-grseq-2` in CONVEX xhtml, `coj-sum-title-1` in the `coj-` CONVEX xhtml
 * (which writes the document header in it too), and `C04Titre1` in the text/html
 * Word export of recent General Court judgments. A legacy text/html body writes its
 * sections as `<h2>`.
 */
const CASE_HEADING_CLASSES = new Set(['title-grseq-2', 'coj-sum-title-1', 'C04Titre1']);

/**
 * A paragraph or `<h2>` opener, the tag in group 1 and its attributes in group 2.
 * `[^<>]` keeps each match attempt inside one tag.
 */
const CASE_BLOCK_OPEN_RE = /<(p|h2)\b([^<>]*)>/gi;

/** A paragraph or `<h2>` closer, the tag in group 1. */
const CASE_BLOCK_CLOSE_RE = /<\/(p|h2)\s*>/gi;

/** A block's `class` attribute value. */
const CLASS_ATTRIBUTE_RE = /\bclass\s*=\s*"([^"]*)"/i;

/**
 * A `coj-sum-title-1` heading's content opens with a bold span. The document header
 * lines in that class — court, date, Advocate General — do not.
 */
const COJ_BOLD_OPEN_RE = /^\s*<span\b[^<>]*\bclass\s*=\s*"[^"]*\bcoj-bold\b/i;

/** The first numbered paragraph: `id="point1"` in CONVEX, `NAME="point1"` in the Word export. */
const FIRST_POINT_RE = /\b(?:id|name)\s*=\s*"point1"/i;

/** The legacy text/html anchor opening a judgment's operative part, `<a name="DI"/>`. */
const LEGACY_OPERATIVE_ANCHOR_RE = /<a\s[^<>]*\bname\s*=\s*"DI"[^<>]*>/gi;

/**
 * The legacy text/html anchor opening an AG opinion's text, `<a name="OP"/>`, which
 * the `<h2>` naming the document ("Opinion of the Advocate-General") follows.
 */
const LEGACY_OPINION_ANCHOR_RE = /<a\s[^<>]*\bname\s*=\s*"OP"[^<>]*>/i;

/**
 * Return a finder for the first `</p>` or `</h2>` at or after a position, for
 * positions asked in ascending order per tag. The closers are found in one pass, and
 * each question only reads forward.
 */
function blockCloser(content: string): (tag: 'p' | 'h2', from: number) => number {
  const closers = { p: [] as number[], h2: [] as number[] };
  for (const m of content.matchAll(CASE_BLOCK_CLOSE_RE)) {
    closers[(m[1] ?? '').toLowerCase() === 'h2' ? 'h2' : 'p'].push(m.index);
  }
  const next = { p: 0, h2: 0 };
  return (tag, from) => {
    const list = closers[tag];
    while ((list[next[tag]] ?? Number.POSITIVE_INFINITY) < from) next[tag]++;
    return list[next[tag]] ?? -1;
  };
}

/**
 * A position moved back to the start of its line when only spaces precede it there,
 * as an act heading's offset is: CONVEX writes one indented tag per line.
 */
function lineAnchored(content: string, at: number): number {
  let start = at;
  while (start > 0 && (content[start - 1] === ' ' || content[start - 1] === '\t')) start--;
  return start === 0 || content[start - 1] === '\n' ? start : at;
}

/** The outermost `<table>` still open at a position, or undefined outside any table. */
function outermostOpenTable(content: string, at: number): number | undefined {
  const open: number[] = [];
  for (const tag of content.matchAll(TABLE_TAG_RE)) {
    if (tag.index >= at) break;
    if (tag[1]) open.pop();
    else if (!tag[0].endsWith('/>')) open.push(tag.index);
  }
  return open[0];
}

/**
 * Text as a Markdown line and the HTML element it renders both read: no ATX marker,
 * backslash escapes, or emphasis marks, and whitespace collapsed.
 */
function landmarkText(text: string): string {
  return text
    .replace(/^\s*#{1,6}\s+/, '')
    .replace(/\\(.)/g, '$1')
    .replace(/[*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A judgment's or order's operative part, opening at `offset`. */
function operativePart(offset: number): ActHeading {
  return { kind: 'operative_part', number: '', label: labelFor('operative_part', ''), offset };
}

/** Headings before the operative part, numbered by position, then the operative part. */
function sequence<T extends ActHeading>(headings: readonly T[], operative: T | undefined): T[] {
  const kept = operative ? headings.filter((h) => h.offset < operative.offset) : [...headings];
  kept.forEach((h, i) => {
    h.number = String(i + 1);
  });
  return operative ? [...kept, operative] : kept;
}

/**
 * The landmarks of a case-law HTML body. Each heading is a block of heading markup
 * ({@link CASE_HEADING_CLASSES}, `<h2>`), labeled with its visible text. A `coj-`
 * heading must open with a bold span, which leaves out the document header, and in
 * a judgment or order the first one before paragraph 1 is the document's title
 * ("Judgment", "Arrêt"), not a section. In an AG opinion, a first heading that is
 * the `<h2>` directly after the legacy `<a name="OP"/>` anchor is the document's
 * title ("Opinion of the Advocate-General") and would span the whole opinion, so it
 * is left out too. The operative part is the legacy
 * `<a name="DI"/>` anchor, else the last paragraph opening with the served
 * language's formula; CONVEX lays that paragraph out in a table cell, which a
 * quoted heading of an amending act also sits in (#106), so a table does not
 * disqualify it here, and the part starts at the outermost table holding it. A
 * heading after the operative part's start belongs to it, as the legacy `<h2>`
 * after the anchor does. Every closer is found in one forward pass.
 */
function htmlLandmarks(content: string, formula: RegExp, ruling: boolean): Landmark[] {
  const closerOf = blockCloser(content);
  const headings: (Landmark & { coj: boolean })[] = [];
  let lastFormula: number | undefined;
  let formulaText = '';
  for (const open of content.matchAll(CASE_BLOCK_OPEN_RE)) {
    const tag = (open[1] ?? '').toLowerCase() === 'h2' ? 'h2' : 'p';
    const start = open.index + open[0].length;
    const end = closerOf(tag, start);
    if (end === -1) continue;
    const inner = content.slice(start, end);
    const classes = CLASS_ATTRIBUTE_RE.exec(open[2] ?? '')?.[1]?.split(/\s+/) ?? [];
    const coj = classes.includes('coj-sum-title-1');
    const heading =
      tag === 'h2' ||
      (classes.some((c) => CASE_HEADING_CLASSES.has(c)) && (!coj || COJ_BOLD_OPEN_RE.test(inner)));
    if (!heading && !ruling) continue;
    const text = visibleText(inner);
    if (heading && text) {
      headings.push({
        kind: 'heading',
        number: '',
        label: text,
        offset: lineAnchored(content, open.index),
        atx: tag === 'h2',
        text: landmarkText(text),
        coj,
      });
    } else if (!heading && formula.test(text)) {
      lastFormula = open.index;
      formulaText = text;
    }
  }

  let operative: Landmark | undefined;
  const anchor = ruling ? [...content.matchAll(LEGACY_OPERATIVE_ANCHOR_RE)].at(-1) : undefined;
  if (anchor) {
    const title = headings.find((h) => h.offset > anchor.index);
    operative = {
      ...operativePart(lineAnchored(content, anchor.index)),
      atx: title?.atx ?? false,
      text: title?.text ?? '',
    };
  } else if (lastFormula !== undefined) {
    operative = {
      ...operativePart(
        lineAnchored(content, outermostOpenTable(content, lastFormula) ?? lastFormula),
      ),
      atx: false,
      text: landmarkText(formulaText),
    };
  }

  const pointOne = FIRST_POINT_RE.exec(content)?.index;
  const firstCoj = headings.find((h) => h.coj);
  const [first] = headings;
  const opinionAnchor = ruling ? undefined : LEGACY_OPINION_ANCHOR_RE.exec(content);
  const opinionTextStart = opinionAnchor ? opinionAnchor.index + opinionAnchor[0].length : -1;
  const documentTitle =
    ruling && firstCoj && pointOne !== undefined && firstCoj.offset < pointOne
      ? firstCoj
      : first?.atx &&
          opinionTextStart !== -1 &&
          first.offset >= opinionTextStart &&
          content.slice(opinionTextStart, first.offset).trim() === ''
        ? first
        : undefined;
  const sections = headings
    .filter((h) => h !== documentTitle)
    .map(({ coj: _coj, ...h }): Landmark => h);
  return sequence(sections, operative);
}

/** An ATX heading line in Markdown. */
const ATX_LINE_RE = /^\s*#{1,6}\s/;

/**
 * The landmarks of a case-law Markdown body. Conversion drops the markup that marks
 * them, so they are read from the HTML the Markdown was rendered from and found in
 * the Markdown in order, each at the next line after the previous one that reads
 * the same (an ATX heading line for an HTML heading element); an in-order match
 * passes over a table of contents listing the same words, as legacy bodies carry
 * one. Numbers are the HTML's, so `select` names the same heading in either format;
 * a landmark with no such line is left out. Without the HTML, or when the operative
 * part was not found that way, it is the last line opening with the formula.
 */
function markdownCaseLawStructure(
  markdown: string,
  sourceHtml: string | undefined,
  formula: RegExp,
  ruling: boolean,
): ActHeading[] {
  const lines: { atx: boolean; offset: number; text: string }[] = [];
  let offset = 0;
  for (const line of markdown.split('\n')) {
    lines.push({ atx: ATX_LINE_RE.test(line), offset, text: landmarkText(line) });
    offset += line.length + 1;
  }
  const byText = Map.groupBy(lines.keys(), (i) => lines[i]?.text ?? '');

  const found: ActHeading[] = [];
  let cursor = -1;
  for (const landmark of sourceHtml === undefined
    ? []
    : htmlLandmarks(sourceHtml, formula, ruling)) {
    if (!landmark.text) continue;
    const index = byText
      .get(landmark.text)
      ?.find((i) => i > cursor && (!landmark.atx || lines[i]?.atx));
    const line = index === undefined ? undefined : lines[index];
    if (index === undefined || !line) continue;
    cursor = index;
    found.push({
      kind: landmark.kind,
      number: landmark.number,
      label: landmark.label,
      offset: line.offset,
    });
  }
  if (!ruling || found.some((h) => h.kind === 'operative_part')) return found;

  const formulaLine = lines.findLast((l) => formula.test(l.text));
  if (!formulaLine) return found;
  return [...found.filter((h) => h.offset < formulaLine.offset), operativePart(formulaLine.offset)];
}

/** A Formex top-level section, `<GR.SEQ LEVEL="2">`. */
const FORMEX_SECTION_OPEN_RE = /<GR\.SEQ\b[^<>]*\bLEVEL="2"[^<>]*>/g;

/** The `<TITLE><TI>` directly opening a Formex section. Sticky. */
const FORMEX_SECTION_TITLE_RE = /\s*<TITLE>\s*<TI>/y;

/** A Formex judgment's or order's operative part, `<JURISDICTION>`. */
const FORMEX_JURISDICTION_RE = /<JURISDICTION\b[^<>]*>/g;

/**
 * The landmarks of a case-law Formex body: each `<GR.SEQ LEVEL="2">` labeled by its
 * `<TITLE><TI>` text, the document's own `LEVEL="1"` "Judgment" left out, and a
 * judgment's or order's `<JURISDICTION>`. Each title runs to the first `</TI>` after
 * it, through a forward-only finder.
 */
function formexCaseLawStructure(content: string, ruling: boolean): ActHeading[] {
  const nextTiClose = forwardFinder(content, '</TI>');
  const headings: ActHeading[] = [];
  for (const open of content.matchAll(FORMEX_SECTION_OPEN_RE)) {
    FORMEX_SECTION_TITLE_RE.lastIndex = open.index + open[0].length;
    if (!FORMEX_SECTION_TITLE_RE.exec(content)) continue;
    const close = nextTiClose(FORMEX_SECTION_TITLE_RE.lastIndex);
    if (close === -1) break;
    const label = formexText(content.slice(FORMEX_SECTION_TITLE_RE.lastIndex, close));
    if (label) headings.push({ kind: 'heading', number: '', label, offset: open.index });
  }
  const jurisdiction = ruling ? [...content.matchAll(FORMEX_JURISDICTION_RE)].at(-1) : undefined;
  return sequence(headings, jurisdiction && operativePart(jurisdiction.index));
}

// --- Selection ---

/**
 * Normalize a selector token to the language-neutral number headings carry: drop
 * a leading English kind word, then a kind word of the served language where that
 * language writes it, before the number or after it ("Artikel 1", "1. cikk"), and
 * a trailing period. The token is split into words rather than matched with a
 * whitespace-spanning pattern, so a caller-sized token is read in one pass.
 */
function normalizeToken(
  token: string,
  kind: SectionKind,
  { articleOne, selectorWord }: Vocabulary,
): string {
  const words = token
    .trim()
    .replace(/^(article|chapter|section|annex|recital|heading)\s+/i, '')
    .split(/\s+/);
  if (words.length > 1 && selectorWord.test(words[0] ?? '')) words.shift();
  else if (words.length > 1 && selectorWord.test(words.at(-1) ?? '')) words.pop();
  const number = words.join(' ').replace(/\.$/, '');
  return kind === 'article' && number.toLowerCase() === articleOne ? '1' : neutralNumber(number);
}

const ROMAN_VALUES: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };

/** Convert a Roman numeral to an integer, or null when not a clean Roman numeral. */
function romanToInt(s: string): number | null {
  if (!/^[IVXLCDM]+$/.test(s)) return null;
  let total = 0;
  let prev = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    const val = ROMAN_VALUES[s[i] ?? ''] ?? 0;
    if (val < prev) total -= val;
    else {
      total += val;
      prev = val;
    }
  }
  return total;
}

/** True when two numbering tokens denote the same unit (handles Roman ↔ Arabic). */
function numbersEquivalent(a: string, b: string): boolean {
  if (a === b) return true;
  const ra = romanToInt(a);
  const rb = romanToInt(b);
  const na = ra ?? (/^\d+$/.test(a) ? Number(a) : null);
  const nb = rb ?? (/^\d+$/.test(b) ? Number(b) : null);
  return na !== null && nb !== null && na === nb;
}

/** Split a comma-separated selector string into normalized tokens. */
function parseTokens(raw: string | undefined, kind: SectionKind, vocabulary: Vocabulary): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((t) => normalizeToken(t, kind, vocabulary))
    .filter(Boolean);
}

/**
 * The sections not contained in another section of the list — the slices a
 * selection's text is built from. `sections` must be in document order.
 *
 * A section spans from its heading to the next heading of the same or broader
 * rank, so any two spans are nested or disjoint, never partially overlapping:
 * every heading between a section's start and its end is narrower, so its own
 * span closes no later. Containment is therefore the whole test, and one pass that
 * tracks the furthest end seen so far finds it (#88).
 */
export function outermostSections<T extends { chars: number; offset: number }>(
  sections: readonly T[],
): T[] {
  const outer: T[] = [];
  let coveredTo = -1;
  for (const section of sections) {
    const end = section.offset + section.chars;
    if (end <= coveredTo) continue;
    outer.push(section);
    coveredTo = end;
  }
  return outer;
}

/**
 * Extract the requested sections from the content, in document order. For each
 * requested section, slices from its heading to the next same-or-broader heading.
 * Reports which requests matched and which missed — a miss is never an error.
 * `language` is the language the body was served in, whose kind words a selector
 * may use alongside the English ones; every descriptor is reported in English.
 */
export function extractSections(
  content: string,
  headings: readonly ActHeading[],
  selectors: SectionSelectors,
  language: EurLexLanguage,
): SelectionResult {
  const vocabulary = vocabularyFor(language);
  const requests: { kind: SectionKind; token: string; descriptor: string }[] = [];
  const add = (kind: SectionKind, raw: string | undefined, wordLabel: string) => {
    for (const token of parseTokens(raw, kind, vocabulary)) {
      requests.push({ kind, token, descriptor: `${wordLabel} ${token}` });
    }
  };
  add('article', selectors.articles, 'Article');
  add('chapter', selectors.chapters, 'CHAPTER');
  add('recital', selectors.recitals, 'Recital');
  add('annex', selectors.annexes, 'ANNEX');
  add('heading', selectors.headings, 'Heading');
  if (selectors.operative_part) {
    requests.push({
      kind: 'operative_part',
      token: '',
      descriptor: labelFor('operative_part', ''),
    });
  }

  const matched: { descriptor: string; offset: number; end: number }[] = [];
  const missed: string[] = [];

  for (const req of requests) {
    const idx = headings.findIndex(
      (h) => h.kind === req.kind && numbersEquivalent(h.number, req.token),
    );
    const heading = idx === -1 ? undefined : headings[idx];
    if (!heading) {
      missed.push(req.descriptor);
      continue;
    }
    const start = heading.offset;
    const rank = RANK[req.kind];
    let end = content.length;
    for (let j = idx + 1; j < headings.length; j++) {
      const next = headings[j];
      if (next && RANK[next.kind] <= rank) {
        end = next.offset;
        break;
      }
    }
    matched.push({ descriptor: heading.label, offset: start, end });
  }

  // Address every distinct located section in document order — a section
  // requested twice resolves to one heading offset, so it is addressed once.
  matched.sort((a, b) => a.offset - b.offset);
  const seen = new Set<number>();
  const sections: SelectedSection[] = [];
  for (const s of matched) {
    if (seen.has(s.offset)) continue;
    seen.add(s.offset);
    sections.push({ label: s.descriptor, offset: s.offset, chars: s.end - s.offset });
  }

  // Slice only the outermost spans (#88): an article selected alongside the
  // chapter holding it is already inside the chapter's slice, so slicing it too
  // would emit its text twice and charge it twice against the body cap.
  return {
    text: outermostSections(sections)
      .map((s) => content.slice(s.offset, s.offset + s.chars).trim())
      .join('\n\n'),
    requested: requests.map((r) => r.descriptor),
    matched: matched.map((s) => s.descriptor),
    missed,
    sections,
  };
}
