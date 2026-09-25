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
 *  - **xml (Formex 4)** — element matching (`<TI.ART>`, `<TITLE><TI><P>CHAPTER …` /
 *    `Section …`, the keyword optionally wrapped in `<HT>` formatting, and
 *    `<NO.P>(N)</NO.P>`), a separate path since Formex is dense single-line XML
 *    with no rendered-text line anchors. Annex detection is not attempted for
 *    Formex — that selector degrades to the floor.
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

/** Where a Formex article heading opens. */
const FORMEX_TI_ART_OPEN_RE = /<TI\.ART>/g;

/** A `<STI.ART>` subtitle directly after an article's `</TI.ART>`. Sticky. */
const FORMEX_STI_ART_OPEN_RE = /\s*<STI\.ART>/y;

/** Where a Formex title paragraph opens — the only place a chapter/section heading starts. */
const FORMEX_TI_OPEN_RE = /<TI>\s*<P>/g;

/**
 * The heading keyword and number, matched where the title paragraph opens. Inline
 * formatting may wrap the keyword — GDPR writes `<HT TYPE="ITALIC">CHAPTER I</HT>`
 * and `<HT TYPE="EXPANDED">Section 1</HT>` — and wrappers nest, so any run of
 * `<HT …>` openers is skipped first (#90). Case-insensitive for the title-case
 * "Section". Sticky: it only ever reads forward from `lastIndex`.
 */
const FORMEX_HEADING_RE = /\s*(?:<HT\b[^>]*>\s*)*(CHAPTER|SECTION)\s+([IVXLCDM0-9]+)/iy;

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

function parseFormexStructure(content: string): ActHeading[] {
  const headings: ActHeading[] = [];

  // Articles: <TI.ART>Article 17</TI.ART> optionally followed by <STI.ART>title</STI.ART>.
  // Each heading runs to the first </TI.ART> after its opener, and its subtitle to
  // the first </STI.ART>, both through forward-only finders (#94). An opener inside
  // the previous heading or its subtitle belongs to that heading's text, not a new
  // one, so the scan resumes past the span the previous heading consumed.
  const nextTiArtClose = forwardFinder(content, '</TI.ART>');
  const nextStiArtClose = forwardFinder(content, '</STI.ART>');
  let consumedTo = 0;
  for (const open of content.matchAll(FORMEX_TI_ART_OPEN_RE)) {
    if (open.index < consumedTo) continue;
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

    const label = formexText(content.slice(labelStart, tiClose));
    const number = (label.match(/(\d+[a-z]?)/)?.[1] ?? '').toUpperCase();
    headings.push({
      kind: 'article',
      number,
      label: label || labelFor('article', number),
      offset: open.index,
      ...(title ? { title } : {}),
    });
  }

  // Chapters / sections: a <TITLE> whose <TI><P> reads "CHAPTER I" / "Section 1",
  // closed by </TI>, with the descriptive title in a sibling <STI> directly after.
  // (The document-level title uses <TI><P> too, but its text isn't CHAPTER/
  // SECTION-prefixed, so it's skipped.) Each heading is bounded by its own </TI>
  // and </STI> through forward-only finders rather than a lazy scan to the closer,
  // which re-read the rest of the document once per unclosed opener.
  const nextTiClose = forwardFinder(content, '</TI>');
  const nextStiClose = forwardFinder(content, '</STI>');
  for (const open of content.matchAll(FORMEX_TI_OPEN_RE)) {
    FORMEX_HEADING_RE.lastIndex = open.index + open[0].length;
    const head = FORMEX_HEADING_RE.exec(content);
    if (!head) continue;
    const tiClose = nextTiClose(FORMEX_HEADING_RE.lastIndex);
    if (tiClose === -1) break; // no </TI> anywhere past here, so no later heading closes either
    const kind: SectionKind = (head[1] ?? '').toUpperCase() === 'CHAPTER' ? 'chapter' : 'section';
    const number = (head[2] ?? '').toUpperCase();

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
