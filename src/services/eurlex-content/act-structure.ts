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
 *    `CHAPTER <roman>`, `ANNEX …`, recital `(N)`) that appear in BOTH strings, so
 *    the emitted offsets stay valid against whichever string is being paged.
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
 * Detection is best-effort by design: an act with no parseable structure (case
 * law, malformed conversions) yields an empty result, never an error. The paging
 * floor (`offset`/`limit`, `full`) remains the always-available escape hatch.
 * @module services/eurlex-content/act-structure
 */

import type { ContentFormat, EurLexLanguage } from './eurlex-content-service.js';

/** The structural unit kinds detected in an EU act body. */
export type SectionKind = 'chapter' | 'section' | 'article' | 'annex' | 'recital';

/** One detected heading, addressable by character offset into the content string. */
export interface ActHeading {
  /** Structural unit kind. */
  kind: SectionKind;
  /**
   * Human label — "Article 17", "CHAPTER IV", "Section 1", "ANNEX I", "Recital 5" —
   * in English whatever the body's language or format. Only a Formex article with
   * no number to read keeps its own heading text ("Final provision").
   */
  label: string;
  /**
   * Numbering token — "17", "6A", "IV", "I", or "" for a lone unnumbered ANNEX.
   * The same in every language: Roman numerals in Latin letters, and French
   * "premier" as "1".
   */
  number: string;
  /** Character offset of the heading within the content string of the requested format. */
  offset: number;
  /** Descriptive title where the act supplies one (article subtitle, chapter/annex title). */
  title?: string;
}

/** Comma-separated selector strings, one optional field per addressable kind. */
export interface SectionSelectors {
  annexes?: string;
  articles?: string;
  chapters?: string;
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
 * unit.
 */
const RANK: Record<SectionKind, number> = {
  chapter: 1,
  annex: 1,
  section: 2,
  article: 3,
  recital: 4,
};

/** Human label for a kind + number. */
function labelFor(kind: SectionKind, number: string): string {
  switch (kind) {
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
  return parseTextStructure(content, vocabulary, format === 'markdown' ? sourceHtml : undefined);
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

/** The numbered heading kinds, each written with a keyword and a number. */
type NumberedKind = Exclude<SectionKind, 'recital'>;

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
 * cross-references ("Chapter V on the transfer of personal data…"). `number` is
 * the number's pattern source, with one capture group.
 */
function linePattern(form: string, number: string, flags: string): RegExp {
  const { keyword, numberFirst } = splitForm(form);
  const word = keywordSource(keyword);
  return new RegExp(
    numberFirst ? `^${number}\\s+${word}\\s*$` : `^${word}\\s+${number}\\s*$`,
    flags,
  );
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
      article: linePattern(forms.article, `(\\d+[a-z]?${one})(?:\\\\?\\.(?:\\s*[oº])?)?`, 'u'),
      chapter: linePattern(forms.chapter, numeral, 'iu'),
      section: linePattern(forms.section, numeral, 'iu'),
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

/** Split into lines, preserving each line's character offset in the source string. */
function splitLines(content: string): RawLine[] {
  const out: RawLine[] = [];
  let offset = 0;
  for (const raw of content.split('\n')) {
    out.push({ raw, visible: visibleText(raw), offset });
    offset += raw.length + 1; // + 1 for the consumed '\n'
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
 * stringify into the heading. A Map resolves these four names and nothing else.
 */
const NAMED_ENTITIES = new Map<string, string>([
  ['amp', '&'],
  ['gt', '>'],
  ['lt', '<'],
  ['nbsp', ' '],
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

/** A preamble recital marker, `(N)`, the same in every language. */
const RECITAL_RE = /^\((\d+)\)(?:\s|$)/;

/** Classify a line's visible text as a structural (non-recital) heading, or null. */
function classifyStructural(
  v: string,
  { lines, articleOne }: Vocabulary,
): { kind: SectionKind; number: string; title?: string } | null {
  const article = lines.article.exec(v);
  if (article) {
    const number = article[1] ?? '';
    return { kind: 'article', number: number === articleOne ? '1' : neutralNumber(number) };
  }
  const chapter = lines.chapter.exec(v);
  if (chapter) return { kind: 'chapter', number: neutralNumber(chapter[1] ?? '') };
  const section = lines.section.exec(v);
  if (section) return { kind: 'section', number: neutralNumber(section[1] ?? '') };
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
  const source = headingLines(html, splitLines(html), vocabulary);
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
  sourceHtml: string | undefined,
): ActHeading[] {
  const lines = splitLines(content);
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

  // Recitals: parenthesized `(N)` markers in the preamble, before the enacting
  // terms begin. After the first article/chapter/section, `(N)` markers are
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
    const kind: SectionKind = chapter === undefined ? 'section' : 'chapter';
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
    .replace(/^(article|chapter|section|annex|recital)\s+/i, '')
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
