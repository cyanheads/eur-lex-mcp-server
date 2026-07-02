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
 *  - **xml (Formex 4)** — element matching (`<TI.ART>`, `<TITLE><TI><P>CHAPTER …`,
 *    `<NO.P>(N)</NO.P>`), a separate path since Formex is dense single-line XML
 *    with no rendered-text line anchors. Annex/section detection is not attempted
 *    for Formex — those selectors degrade to the floor.
 *
 * Detection is best-effort by design: an act with no parseable structure (case
 * law, malformed conversions) yields an empty result, never an error. The paging
 * floor (`offset`/`limit`, `full`) remains the always-available escape hatch.
 * @module services/eurlex-content/act-structure
 */

import type { ContentFormat } from './eurlex-content-service.js';

/** The structural unit kinds detected in an EU act body. */
export type SectionKind = 'chapter' | 'section' | 'article' | 'annex' | 'recital';

/** One detected heading, addressable by character offset into the content string. */
export interface ActHeading {
  /** Structural unit kind. */
  kind: SectionKind;
  /** Human label — "Article 17", "CHAPTER IV", "Section 1", "ANNEX I", "Recital 5". */
  label: string;
  /** Numbering token as rendered — "17", "IV", "I", or "" for a lone unnumbered ANNEX. */
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

/** Outcome of a structural selection — the sliced text plus hit/miss bookkeeping. */
export interface SelectionResult {
  /** Descriptors of the sections that were found and sliced. */
  matched: string[];
  /** Descriptors of the sections that could not be located. */
  missed: string[];
  /** Human descriptors of every requested section, e.g. ["Article 17", "CHAPTER IV"]. */
  requested: string[];
  /** Concatenated text of the matched sections, in document order. Empty when nothing matched. */
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
 * (the caller degrades to the paging floor).
 */
export function parseActStructure(content: string, format: ContentFormat): ActHeading[] {
  return format === 'xml' ? parseFormexStructure(content) : parseTextStructure(content);
}

// --- HTML / Markdown: rendered-text line matching ---

interface RawLine {
  offset: number;
  visible: string;
}

/** Split into lines, preserving each line's character offset in the source string. */
function splitLines(content: string): RawLine[] {
  const out: RawLine[] = [];
  let offset = 0;
  for (const raw of content.split('\n')) {
    out.push({ visible: visibleText(raw), offset });
    offset += raw.length + 1; // + 1 for the consumed '\n'
  }
  return out;
}

/** Strip HTML tags and decode common entities to the human-visible text of a line. */
function visibleText(line: string): string {
  return decodeEntities(line.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

/**
 * Heading patterns. Each keyword-and-number must stand ALONE on the line — the OJ
 * layout puts the descriptive title on the following line, and requiring the
 * heading alone rejects prose cross-references ("Chapter V on the transfer of
 * personal data…") that would otherwise match. ANNEX also accepts a delimited
 * inline title, which some acts use ("ANNEX I — Requirements").
 */
const ARTICLE_RE = /^Article\s+(\d+[a-z]?)\s*$/;
const CHAPTER_RE = /^CHAPTER\s+([IVXLCDM]+|\d+)\s*$/i;
const SECTION_RE = /^SECTION\s+([IVXLCDM]+|\d+)\s*$/i;
const ANNEX_RE = /^ANNEX(?:\s+([IVXLCDM]+|\d+|[A-Z])(?=\s|$))?(?:\s*[-–—:.]\s*(.*))?\s*$/;
const RECITAL_RE = /^\((\d+)\)(?:\s|$)/;

/** Classify a line's visible text as a structural (non-recital) heading, or null. */
function classifyStructural(
  v: string,
): { kind: SectionKind; number: string; title?: string } | null {
  const article = ARTICLE_RE.exec(v);
  if (article) return { kind: 'article', number: (article[1] ?? '').toUpperCase() };
  const chapter = CHAPTER_RE.exec(v);
  if (chapter) return { kind: 'chapter', number: (chapter[1] ?? '').toUpperCase() };
  const section = SECTION_RE.exec(v);
  if (section) return { kind: 'section', number: (section[1] ?? '').toUpperCase() };
  const annex = ANNEX_RE.exec(v);
  if (annex) {
    const title = annex[2]?.trim();
    return {
      kind: 'annex',
      number: (annex[1] ?? '').toUpperCase(),
      ...(title ? { title } : {}),
    };
  }
  return null;
}

function parseTextStructure(content: string): ActHeading[] {
  const lines = splitLines(content);
  const structural: (ActHeading & { lineIndex: number })[] = [];
  lines.forEach((ln, i) => {
    const c = classifyStructural(ln.visible);
    if (c) {
      structural.push({
        kind: c.kind,
        number: c.number,
        label: labelFor(c.kind, c.number),
        offset: ln.offset,
        lineIndex: i,
        ...(c.title ? { title: c.title } : {}),
      });
    }
  });

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
      if (!classifyStructural(v) && v.length <= 200) h.title = v;
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
    ...structural.map(({ lineIndex: _lineIndex, ...h }) => h),
    ...recitals,
  ];
  all.sort((a, b) => a.offset - b.offset);
  return all;
}

// --- Formex 4 XML: element matching ---

/** Strip tags/entities from a Formex element's inner text. */
function formexText(inner: string): string {
  return visibleText(inner);
}

function parseFormexStructure(content: string): ActHeading[] {
  const headings: ActHeading[] = [];

  // Articles: <TI.ART>Article 17</TI.ART> optionally followed by <STI.ART>title</STI.ART>.
  for (const m of content.matchAll(
    /<TI\.ART>([\s\S]*?)<\/TI\.ART>(?:\s*<STI\.ART>([\s\S]*?)<\/STI\.ART>)?/gi,
  )) {
    const label = formexText(m[1] ?? '');
    const number = (label.match(/(\d+[a-z]?)/)?.[1] ?? '').toUpperCase();
    const title = m[2] ? formexText(m[2]) : undefined;
    headings.push({
      kind: 'article',
      number,
      label: label || labelFor('article', number),
      offset: m.index ?? 0,
      ...(title ? { title } : {}),
    });
  }

  // Chapters / sections: a <TITLE> whose <TI><P> reads "CHAPTER I" / "SECTION 1",
  // with the descriptive title in the sibling <STI><P>. (The document-level title
  // uses <TI><P> too, but its text isn't CHAPTER/SECTION-prefixed, so it's skipped.)
  for (const m of content.matchAll(
    /<TI>\s*<P>\s*((?:CHAPTER|SECTION)\s+[IVXLCDM0-9]+)[\s\S]*?<\/P>\s*<\/TI>(?:\s*<STI>\s*<P>([\s\S]*?)<\/P>\s*<\/STI>)?/gi,
  )) {
    const head = formexText(m[1] ?? '');
    const parts = /^(CHAPTER|SECTION)\s+([IVXLCDM0-9]+)/i.exec(head);
    if (!parts) continue;
    const kind: SectionKind = (parts[1] ?? '').toUpperCase() === 'CHAPTER' ? 'chapter' : 'section';
    const number = (parts[2] ?? '').toUpperCase();
    const title = m[2] ? formexText(m[2]) : undefined;
    headings.push({
      kind,
      number,
      label: labelFor(kind, number),
      offset: m.index ?? 0,
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

/** Normalize a selector token: trim, uppercase, and drop a leading kind word. */
function normalizeToken(token: string): string {
  return token
    .trim()
    .replace(/^(article|chapter|section|annex|recital)\s+/i, '')
    .toUpperCase();
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
function parseTokens(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((t) => normalizeToken(t))
    .filter(Boolean);
}

/**
 * Extract the requested sections from the content, in document order. For each
 * requested section, slices from its heading to the next same-or-broader heading.
 * Reports which requests matched and which missed — a miss is never an error.
 */
export function extractSections(
  content: string,
  headings: readonly ActHeading[],
  selectors: SectionSelectors,
): SelectionResult {
  const requests: { kind: SectionKind; token: string; descriptor: string }[] = [];
  const add = (kind: SectionKind, raw: string | undefined, wordLabel: string) => {
    for (const token of parseTokens(raw)) {
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

  // Emit matched sections in document order, de-duplicated by offset (a chapter
  // request and an article request inside it could overlap — keep each once).
  matched.sort((a, b) => a.offset - b.offset);
  const seen = new Set<number>();
  const text = matched
    .filter((s) => {
      if (seen.has(s.offset)) return false;
      seen.add(s.offset);
      return true;
    })
    .map((s) => content.slice(s.offset, s.end).trim())
    .join('\n\n');

  return {
    text,
    requested: requests.map((r) => r.descriptor),
    matched: matched.map((s) => s.descriptor),
    missed,
  };
}
