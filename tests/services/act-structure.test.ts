/**
 * @fileoverview Tests for the #12 act-structure parser — parseActStructure (HTML /
 * markdown rendered-text path and Formex XML element path) and extractSections
 * (offset slicing, Roman↔Arabic equivalence, misses, degradation). Fixtures mirror
 * the CELLAR layout confirmed live against GDPR (32016R0679): headings render on
 * their own line, recitals as parenthesized `(N)` in the preamble.
 * @module tests/services/act-structure.test
 */

import { describe, expect, it } from 'vitest';
import {
  type ActHeading,
  extractSections,
  outermostSections,
  parseActStructure,
} from '@/services/eurlex-content/act-structure.js';
import { FORMEX_DOC_2 } from '../fixtures/eurlex-formex-multipart.js';

/** A structured act: two preamble recitals, two chapters, three articles, one annex. */
const STRUCTURED_HTML = [
  '<html><body>',
  '<p class="oj-doc-ti">REGULATION (EU) 2016/679</p>',
  '<p class="oj-normal">(1)</p>',
  '<p class="oj-normal">The protection of natural persons is a fundamental right.</p>',
  '<p class="oj-normal">(2)</p>',
  '<p class="oj-normal">This Regulation respects fundamental rights and freedoms.</p>',
  '<p class="oj-ti-grseq">CHAPTER I</p>',
  '<p class="oj-ti-grseq">General provisions</p>',
  '<p class="oj-ti-art">Article 1</p>',
  '<p class="oj-sti-art">Subject-matter and objectives</p>',
  '<p class="oj-normal">This Regulation lays down rules relating to the protection of natural persons.</p>',
  '<p class="oj-ti-art">Article 2</p>',
  '<p class="oj-sti-art">Material scope</p>',
  '<p class="oj-normal">This Regulation applies to the processing of personal data.</p>',
  '<p class="oj-ti-grseq">CHAPTER II</p>',
  '<p class="oj-ti-grseq">Principles</p>',
  '<p class="oj-ti-art">Article 5</p>',
  '<p class="oj-sti-art">Principles relating to processing of personal data</p>',
  '<p class="oj-normal">Personal data shall be processed lawfully, fairly and transparently.</p>',
  '<p class="oj-ti-grseq">ANNEX I</p>',
  '<p class="oj-ti-grseq">Correlation table</p>',
  '<p class="oj-normal">Annex body content here.</p>',
  '</body></html>',
].join('\n');

/** The same act as rendered markdown (no DOM classes survive conversion). */
const STRUCTURED_MD = [
  '# REGULATION (EU) 2016/679',
  '',
  '(1)',
  '',
  'The protection of natural persons is a fundamental right.',
  '',
  '(2)',
  '',
  'This Regulation respects fundamental rights.',
  '',
  'CHAPTER I',
  '',
  'General provisions',
  '',
  'Article 1',
  '',
  'Subject-matter and objectives',
  '',
  'This Regulation lays down rules.',
  '',
  'Article 2',
  '',
  'Material scope',
  '',
  'This Regulation applies to processing.',
].join('\n');

/** A judgment — no chapter/article/annex structure at all. */
const UNSTRUCTURED_HTML = [
  '<html><body>',
  '<p>JUDGMENT OF THE COURT (Grand Chamber)</p>',
  '<p>In Case C-123/45,</p>',
  '<p>APPLICANT v RESPONDENT,</p>',
  '<p>gives the following Judgment.</p>',
  '<p>On those grounds, the Court hereby rules that the action is dismissed.</p>',
  '</body></html>',
].join('\n');

/**
 * Titles carrying character references — both single-encoded (ordinary markup an
 * act escapes) and double-encoded (`&amp;lt;`, meaning the literal characters
 * `&lt;`). Only the heading-classification path decodes these; the body text the
 * selectors slice is read from the original string.
 */
const ENTITY_HTML = [
  '<html><body>',
  '<p class="oj-ti-art">Article&nbsp;1</p>',
  '<p class="oj-sti-art">Markup &amp;lt;b&amp;gt; and &amp;#60; stay escaped</p>',
  '<p class="oj-normal">Body of Article 1.</p>',
  '<p class="oj-ti-art">Article 2</p>',
  '<p class="oj-sti-art">Rights &amp; freedoms, &lt;scope&gt;, &#8217;quoted&#8217;</p>',
  '<p class="oj-normal">Body of Article 2.</p>',
  '</body></html>',
].join('\n');

/** `(N)` markers both before AND after the enacting terms begin. */
const GATING_HTML = [
  '<html><body>',
  '<p>(1)</p>',
  '<p>First recital.</p>',
  '<p>(2)</p>',
  '<p>Second recital.</p>',
  '<p class="oj-ti-art">Article 1</p>',
  '<p>Definitions</p>',
  '<p>(1)</p>',
  '<p>This parenthesized point is a numbered sub-point inside the article, not a recital.</p>',
  '</body></html>',
].join('\n');

function countKinds(headings: readonly ActHeading[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const h of headings) counts[h.kind] = (counts[h.kind] ?? 0) + 1;
  return counts;
}

describe('parseActStructure', () => {
  describe('HTML / rendered-text path', () => {
    it('detects chapters, articles, annexes, and preamble recitals', () => {
      const headings = parseActStructure(STRUCTURED_HTML, 'html');
      expect(countKinds(headings)).toEqual({ recital: 2, chapter: 2, article: 3, annex: 1 });
    });

    it('emits offsets in ascending document order, each landing on its heading text', () => {
      const headings = parseActStructure(STRUCTURED_HTML, 'html');
      const offsets = headings.map((h) => h.offset);
      expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);
      const article1 = headings.find((h) => h.kind === 'article' && h.number === '1');
      expect(article1).toBeDefined();
      expect(STRUCTURED_HTML.slice(article1!.offset)).toMatch(/^<p[^>]*>Article 1</);
    });

    it('captures the descriptive title from the line after the heading', () => {
      const headings = parseActStructure(STRUCTURED_HTML, 'html');
      expect(headings.find((h) => h.kind === 'article' && h.number === '1')?.title).toBe(
        'Subject-matter and objectives',
      );
      expect(headings.find((h) => h.kind === 'chapter' && h.number === 'I')?.title).toBe(
        'General provisions',
      );
      expect(headings.find((h) => h.kind === 'annex' && h.number === 'I')?.title).toBe(
        'Correlation table',
      );
    });

    it('counts parenthesized markers before the enacting terms as recitals only', () => {
      const headings = parseActStructure(GATING_HTML, 'html');
      // Two preamble recitals; the (1) after Article 1 is a sub-point, not a third recital.
      expect(countKinds(headings)).toEqual({ recital: 2, article: 1 });
    });

    it('returns an empty outline for an act with no detectable structure (case law)', () => {
      expect(parseActStructure(UNSTRUCTURED_HTML, 'html')).toEqual([]);
    });
  });

  describe('markdown path', () => {
    it('detects structure from rendered markdown text without DOM classes', () => {
      const headings = parseActStructure(STRUCTURED_MD, 'markdown');
      expect(countKinds(headings)).toEqual({ recital: 2, chapter: 1, article: 2 });
      expect(headings.find((h) => h.kind === 'article' && h.number === '1')?.title).toBe(
        'Subject-matter and objectives',
      );
    });
  });

  describe('character references in heading text (#79)', () => {
    /** Title of the article numbered `n` in ENTITY_HTML. */
    const titleOf = (n: string, content = ENTITY_HTML, format: 'html' | 'xml' = 'html') =>
      parseActStructure(content, format).find((h) => h.kind === 'article' && h.number === n)?.title;

    it('decodes each reference exactly once, leaving a double-encoded one escaped', () => {
      // `&amp;lt;b&amp;gt;` is the act writing the literal characters `&lt;b&gt;`.
      // Decoding `&amp;` first and `&lt;` after collapses it to real markup.
      expect(titleOf('1')).toBe('Markup &lt;b&gt; and &#60; stay escaped');
    });

    it('still decodes ordinary single-encoded references', () => {
      expect(titleOf('2')).toBe('Rights & freedoms, <scope>, ’quoted’');
    });

    it('decodes a hexadecimal character reference', () => {
      const html = [
        '<p class="oj-ti-art">Article 3</p>',
        '<p class="oj-sti-art">Angle &#x3C;bracket&#x3E; and &#X41;</p>',
      ].join('\n');
      expect(titleOf('3', html)).toBe('Angle <bracket> and A');
    });

    it('leaves an out-of-range numeric reference verbatim instead of throwing', () => {
      const html = [
        '<p class="oj-ti-art">Article 4</p>',
        '<p class="oj-sti-art">Overflow &#99999999; and &#xFFFFFFFF; survive</p>',
      ].join('\n');
      expect(() => parseActStructure(html, 'html')).not.toThrow();
      expect(titleOf('4', html)).toBe('Overflow &#99999999; and &#xFFFFFFFF; survive');
    });

    it('decodes a non-breaking space inside the heading itself so the pattern still matches', () => {
      expect(parseActStructure(ENTITY_HTML, 'html').map((h) => h.label)).toEqual([
        'Article 1',
        'Article 2',
      ]);
    });

    it('applies the same single decoding on the Formex subtitle path', () => {
      const formex =
        '<ARTICLE><TI.ART>Article 1</TI.ART><STI.ART>Scope of &amp;lt;TAG&amp;gt;</STI.ART></ARTICLE>';
      expect(titleOf('1', formex, 'xml')).toBe('Scope of &lt;TAG&gt;');
    });

    it('leaves a reference named after an Object prototype member verbatim', () => {
      // `&constructor;` matches the named-reference pattern, so a lookup that
      // walks the prototype chain answers with Object itself and stringifies it
      // into the title. Only the four mapped names may ever resolve.
      const html = [
        '<p class="oj-ti-art">Article 5</p>',
        '<p class="oj-sti-art">Escape &constructor; and &valueof; unchanged</p>',
      ].join('\n');
      expect(titleOf('5', html)).toBe('Escape &constructor; and &valueof; unchanged');
    });
  });

  describe('Formex XML path', () => {
    it('detects articles and recitals from Formex elements, with the STI.ART subtitle', () => {
      const headings = parseActStructure(FORMEX_DOC_2, 'xml');
      const kinds = countKinds(headings);
      expect(kinds.article).toBeGreaterThanOrEqual(1);
      expect(kinds.recital).toBeGreaterThanOrEqual(1);
      const article1 = headings.find((h) => h.kind === 'article' && h.number === '1');
      expect(article1?.title).toBe('Subject-matter and objectives');
      // Recitals precede the article.
      const recital = headings.find((h) => h.kind === 'recital');
      expect(recital!.offset).toBeLessThan(article1!.offset);
    });

    it('detects a Formex chapter from its <TITLE><TI><P>CHAPTER…</P>', () => {
      const headings = parseActStructure(FORMEX_DOC_2, 'xml');
      const chapter = headings.find((h) => h.kind === 'chapter');
      expect(chapter?.number).toBe('I');
      expect(chapter?.title).toBe('General provisions');
    });
  });

  describe('Formex headings wrapped in inline formatting (#90)', () => {
    /**
     * The markup GDPR (32016R0679) carries live: every chapter keyword sits inside
     * `<HT TYPE="ITALIC">`, every section keyword inside `<HT TYPE="EXPANDED">` in
     * title case, and each subtitle inside two nested `<HT>` elements.
     */
    const WRAPPED_FORMEX = [
      '<ACT><TITLE><TI><P><HT TYPE="UC">Regulation</HT> (EU) 2016/679</P></TI></TITLE>',
      '<PREAMBLE><GR.CONSID><CONSID><NP><NO.P>(1)</NO.P><TXT>Recital.</TXT></NP></CONSID></GR.CONSID></PREAMBLE>',
      '<ENACTING.TERMS>',
      '<DIVISION><TITLE><TI><P><HT TYPE="ITALIC">CHAPTER I</HT></P></TI><STI><P><HT TYPE="BOLD"><HT TYPE="ITALIC">General provisions</HT></HT></P></STI></TITLE>',
      '<ARTICLE IDENTIFIER="001"><TI.ART>Article 1</TI.ART><STI.ART>Subject-matter</STI.ART><ALINEA>One.</ALINEA></ARTICLE>',
      '</DIVISION>',
      '<DIVISION><TITLE><TI><P><HT TYPE="ITALIC">CHAPTER III</HT></P></TI><STI><P><HT TYPE="BOLD"><HT TYPE="ITALIC">Rights of the data subject</HT></HT></P></STI></TITLE>',
      '<DIVISION><TITLE><TI><P><HT TYPE="EXPANDED">Section 1</HT></P></TI><STI><P><HT TYPE="BOLD"><HT TYPE="EXPANDED">Transparency and modalities</HT></HT></P></STI></TITLE>',
      '<ARTICLE IDENTIFIER="012"><TI.ART>Article 12</TI.ART><STI.ART>Transparent information</STI.ART><ALINEA>Twelve.</ALINEA></ARTICLE>',
      '</DIVISION>',
      '<DIVISION><TITLE><TI><P><HT TYPE="BOLD"><HT TYPE="EXPANDED">Section 2</HT></HT></P></TI><STI><P>Information and access</P></STI></TITLE>',
      '<ARTICLE IDENTIFIER="013"><TI.ART>Article 13</TI.ART><ALINEA>Thirteen.</ALINEA></ARTICLE>',
      '</DIVISION></DIVISION>',
      '</ENACTING.TERMS></ACT>',
    ].join('');

    it('detects an <HT>-wrapped chapter and strips nested <HT> from its <STI> title', () => {
      const headings = parseActStructure(WRAPPED_FORMEX, 'xml');
      const chapters = headings.filter((h) => h.kind === 'chapter');
      expect(chapters.map((h) => [h.label, h.title])).toEqual([
        ['CHAPTER I', 'General provisions'],
        ['CHAPTER III', 'Rights of the data subject'],
      ]);
      // Each offset lands on the heading's own <TI>.
      for (const h of chapters) expect(WRAPPED_FORMEX.slice(h.offset)).toMatch(/^<TI><P><HT/);
    });

    it('detects title-case sections under one or two nested <HT> wrappers', () => {
      const sections = parseActStructure(WRAPPED_FORMEX, 'xml').filter((h) => h.kind === 'section');
      expect(sections.map((h) => [h.label, h.title])).toEqual([
        ['Section 1', 'Transparency and modalities'],
        ['Section 2', 'Information and access'],
      ]);
    });

    it('orders the wrapped headings with the articles and recitals, and skips the act title', () => {
      expect(parseActStructure(WRAPPED_FORMEX, 'xml').map((h) => h.label)).toEqual([
        'Recital 1',
        'CHAPTER I',
        'Article 1',
        'CHAPTER III',
        'Section 1',
        'Article 12',
        'Section 2',
        'Article 13',
      ]);
    });

    it('selects an <HT>-wrapped chapter by number in the XML body', () => {
      const headings = parseActStructure(WRAPPED_FORMEX, 'xml');
      const result = extractSections(WRAPPED_FORMEX, headings, { chapters: 'III' });
      expect(result.matched).toEqual(['CHAPTER III']);
      expect(result.missed).toEqual([]);
      expect(result.text).toContain('Article 12');
      expect(result.text).toContain('Article 13');
      expect(result.text).not.toContain('Article 1<');
    });

    it('skips a keyword run into a longer word, and a wrapper that is not <HT>', () => {
      const formex =
        '<TI><P><HT TYPE="BOLD">CHAPTERS I to III</HT></P></TI><TI><P><HTML>CHAPTER I</HTML></P></TI>';
      expect(parseActStructure(formex, 'xml')).toEqual([]);
    });
  });

  /** Build a string of exactly `n` characters by repeating `unit`. */
  const fill = (unit: string, n: number) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);

  /**
   * A 120k-character parse must finish in under 20 ms on its best of five rounds.
   * The linear scan takes under 3 ms there even with every core busy; the lazy
   * regexes it replaced took 60–380 ms on these shapes, re-reading the rest of the
   * document once per unclosed opener. The best round discards
   * scheduler and GC stalls, and a single absolute bound avoids timing a sub-0.1 ms
   * small input, whose ratio one stall could swing past any threshold.
   */
  const expectLinearParse = (build: (n: number) => string) => {
    const text = build(120_000);
    let best = Number.POSITIVE_INFINITY;
    for (let round = 0; round < 5; round++) {
      const start = performance.now();
      parseActStructure(text, 'xml');
      best = Math.min(best, performance.now() - start);
    }
    expect(best).toBeLessThan(20);
  };

  describe('Formex heading scan stays linear on adversarial input (#90)', () => {
    const ADVERSARIAL: Record<string, (n: number) => string> = {
      'repeated <HT openers with no closer': (n) => `<TI><P>${fill('<HT', n - 7)}`,
      'repeated <TI><P><HT openers': (n) => fill('<TI><P><HT TYPE="X"', n),
      'nested <HT><HT>… before the keyword': (n) => `<TI><P>${fill('<HT>', n - 16)}CHAPTER I`,
      'an unclosed <TI><P> heading, repeated': (n) => fill('<TI><P>CHAPTER I ', n),
      'an unclosed <TI><P><HT> heading, repeated': (n) => fill('<TI><P><HT>CHAPTER I ', n),
      'an unclosed <STI> subtitle, repeated': (n) => fill('<TI><P>CHAPTER I</P></TI><STI><P>xx', n),
    };

    it.each(Object.entries(ADVERSARIAL))('%s', (_label, build) => expectLinearParse(build));
  });

  describe('Formex article headings (#94)', () => {
    /**
     * Article markup in every shape the scan must keep reading the same way:
     * whitespace before `<STI.ART>`, an empty subtitle, `<HT>`-wrapped label and
     * subtitle, no subtitle, an unnumbered heading, an opener nested inside a
     * heading, an opener inside a subtitle, an unclosed subtitle, and a trailing
     * opener with no closer.
     */
    const ARTICLE_EDGE_FORMEX = [
      '<ARTICLE><TI.ART>Article 1</TI.ART> \n <STI.ART>Spaced subtitle</STI.ART></ARTICLE>',
      '<ARTICLE><TI.ART>Article 2</TI.ART><STI.ART></STI.ART></ARTICLE>',
      '<ARTICLE><TI.ART><HT TYPE="BOLD">Article</HT> 3a</TI.ART><STI.ART><HT TYPE="ITALIC">Wrapped</HT> title</STI.ART></ARTICLE>',
      '<ARTICLE><TI.ART>Article 4</TI.ART><ALINEA>No subtitle.</ALINEA></ARTICLE>',
      '<ARTICLE><TI.ART>Final provision</TI.ART><STI.ART>Unnumbered</STI.ART></ARTICLE>',
      '<ARTICLE><TI.ART>Article 6 <TI.ART>inner</TI.ART><STI.ART>Six</STI.ART></ARTICLE>',
      '<ARTICLE><TI.ART>Article 7</TI.ART><STI.ART>Cites <TI.ART>Article 8</TI.ART> inline</STI.ART></ARTICLE>',
      '<ARTICLE><TI.ART>Article 9</TI.ART><STI.ART>Unclosed subtitle</ARTICLE>',
      '<ARTICLE><TI.ART>Article 10</TI.ART></ARTICLE><TI.ART>Article 11 unterminated',
    ].join('');

    const articles = (content: string) =>
      parseActStructure(content, 'xml').filter((h) => h.kind === 'article');

    it('reads number, label, offset, and subtitle from each article shape', () => {
      expect(articles(ARTICLE_EDGE_FORMEX)).toEqual([
        { kind: 'article', number: '1', label: 'Article 1', offset: 9, title: 'Spaced subtitle' },
        { kind: 'article', number: '2', label: 'Article 2', offset: 91 },
        { kind: 'article', number: '3A', label: 'Article 3a', offset: 155, title: 'Wrapped title' },
        { kind: 'article', number: '4', label: 'Article 4', offset: 277 },
        { kind: 'article', number: '', label: 'Final provision', offset: 351, title: 'Unnumbered' },
        { kind: 'article', number: '6', label: 'Article 6 inner', offset: 431, title: 'Six' },
        {
          kind: 'article',
          number: '7',
          label: 'Article 7',
          offset: 512,
          title: 'Cites Article 8 inline',
        },
        { kind: 'article', number: '9', label: 'Article 9', offset: 615 },
        { kind: 'article', number: '10', label: 'Article 10', offset: 686 },
      ]);
    });

    it('reads the article of a live GDPR Formex document', () => {
      expect(articles(FORMEX_DOC_2)).toEqual([
        {
          kind: 'article',
          number: '1',
          label: 'Article 1',
          offset: 1313,
          title: 'Subject-matter and objectives',
        },
      ]);
    });

    const ADVERSARIAL_ARTICLES: Record<string, (n: number) => string> = {
      'repeated <TI.ART> openers with no closer': (n) => fill('<TI.ART>Article 1 ', n),
      'nested <TI.ART> openers with no closer': (n) => fill('<TI.ART>', n),
      'interleaved unclosed <TI.ART> and <STI.ART> openers': (n) =>
        fill('<TI.ART>Article 1<STI.ART>Title ', n),
      'a closed heading before an unclosed <STI.ART>, repeated': (n) =>
        fill('<TI.ART>Article 1</TI.ART><STI.ART>xx', n),
      'an unclosed <STI.ART> nesting the next <TI.ART>, repeated': (n) =>
        fill('<TI.ART>Article 1</TI.ART><STI.ART><TI.ART>', n),
    };

    it.each(Object.entries(ADVERSARIAL_ARTICLES))('stays linear on %s', (_label, build) =>
      expectLinearParse(build),
    );
  });
});

describe('extractSections', () => {
  const html = STRUCTURED_HTML;
  const headings = parseActStructure(STRUCTURED_HTML, 'html');

  it('slices a single article from its heading to the next same-or-broader heading', () => {
    const result = extractSections(html, headings, { articles: '1' });
    expect(result.requested).toEqual(['Article 1']);
    expect(result.matched).toEqual(['Article 1']);
    expect(result.missed).toEqual([]);
    expect(result.text).toContain('Article 1');
    expect(result.text).toContain('Subject-matter and objectives');
    // Article 1 ends at Article 2 (same rank), so its neighbor is not included.
    expect(result.text).not.toContain('Material scope');
  });

  it('returns multiple selected sections in document order regardless of request order', () => {
    const result = extractSections(html, headings, { articles: '5', chapters: 'I' });
    // CHAPTER I precedes Article 5 in the document.
    expect(result.matched).toEqual(['CHAPTER I', 'Article 5']);
  });

  it('treats Roman and Arabic chapter numbers as equivalent', () => {
    const result = extractSections(html, headings, { chapters: '2' });
    expect(result.matched).toEqual(['CHAPTER II']);
    expect(result.text).toContain('Principles');
  });

  it('a chapter slice spans its nested articles up to the next chapter', () => {
    const result = extractSections(html, headings, { chapters: 'I' });
    // CHAPTER I holds Articles 1 and 2, ending at CHAPTER II.
    expect(result.text).toContain('Article 1');
    expect(result.text).toContain('Article 2');
    expect(result.text).not.toContain('Article 5');
    expect(result.text).not.toContain('CHAPTER II');
  });

  it('reports a miss without returning any text', () => {
    const result = extractSections(html, headings, { articles: '99' });
    expect(result.matched).toEqual([]);
    expect(result.missed).toEqual(['Article 99']);
    expect(result.text).toBe('');
  });

  it('reports every request as missed with empty text when no structure was detected', () => {
    const emptyHeadings = parseActStructure(UNSTRUCTURED_HTML, 'html');
    const result = extractSections(UNSTRUCTURED_HTML, emptyHeadings, {
      articles: '1',
      chapters: 'I',
    });
    expect(result.matched).toEqual([]);
    expect(result.missed).toEqual(['Article 1', 'CHAPTER I']);
    expect(result.text).toBe('');
  });

  it('deduplicates a section requested twice — text appears once', () => {
    const result = extractSections(html, headings, { articles: '1,1' });
    expect(result.requested).toEqual(['Article 1', 'Article 1']);
    expect(result.matched).toEqual(['Article 1', 'Article 1']);
    const occurrences = result.text.split('Subject-matter and objectives').length - 1;
    expect(occurrences).toBe(1);
    // One address per slice that fed the text, not per request (#80).
    expect(result.sections).toHaveLength(1);
  });

  it('addresses each sliced section by its own source span (#80)', () => {
    const result = extractSections(html, headings, { articles: '5', chapters: 'I' });

    expect(result.sections.map((s) => s.label)).toEqual(['CHAPTER I', 'Article 5']);

    // Each address re-cuts its own slice out of the source string, which is what
    // lets a caller re-read one section through the paging floor.
    const spans = result.sections.map((s) => html.slice(s.offset, s.offset + s.chars));
    expect(spans[0]).toContain('CHAPTER I');
    expect(spans[0]).toContain('Article 2'); // nested inside the chapter
    expect(spans[0]).not.toContain('Article 5');
    expect(spans[1]).toContain('Article 5');
    expect(result.text).toBe(spans.map((s) => s.trim()).join('\n\n'));

    // Disjoint and ascending — the chapter ends before the article's own slice.
    const [chapter, article] = result.sections;
    expect(chapter!.offset + chapter!.chars).toBeLessThanOrEqual(article!.offset);
  });

  it('tolerates selector tokens that carry the kind word (e.g. "Article 1")', () => {
    const result = extractSections(html, headings, { articles: 'Article 1' });
    expect(result.matched).toEqual(['Article 1']);
  });

  it('slices the original body, so character references reach the caller undecoded (#79)', () => {
    // Decoding happens only on the classification path; the returned text is a
    // slice of the source string, so the act's own escaping survives verbatim.
    const entityHeadings = parseActStructure(ENTITY_HTML, 'html');
    const result = extractSections(ENTITY_HTML, entityHeadings, { articles: '1' });
    expect(result.text).toContain('&amp;lt;b&amp;gt;');
    expect(result.text).not.toContain('<b>');
  });
});

describe('extractSections — nested and overlapping selections (#88)', () => {
  /**
   * Three chapters, the second split into two sections, and an annex. Every body
   * line is unique, so counting one shows whether a source character was emitted
   * more than once. CHAPTER III's last article ends where the chapter does.
   */
  const NESTED_HTML = [
    '<p>(1)</p>',
    '<p>Recital one.</p>',
    '<p class="oj-ti-section-1">CHAPTER I</p>',
    '<p>General provisions</p>',
    '<p class="oj-ti-art">Article 1</p>',
    '<p>Subject-matter</p>',
    '<p>Body one.</p>',
    '<p class="oj-ti-art">Article 2</p>',
    '<p>Scope</p>',
    '<p>Body two.</p>',
    '<p class="oj-ti-section-1">CHAPTER II</p>',
    '<p>Rights</p>',
    '<p class="oj-ti-section-1">Section 1</p>',
    '<p>Transparency</p>',
    '<p class="oj-ti-art">Article 3</p>',
    '<p>Information</p>',
    '<p>Body three.</p>',
    '<p class="oj-ti-art">Article 4</p>',
    '<p>Access</p>',
    '<p>Body four.</p>',
    '<p class="oj-ti-section-1">Section 2</p>',
    '<p>Rectification</p>',
    '<p class="oj-ti-art">Article 5</p>',
    '<p>Erasure</p>',
    '<p>Body five.</p>',
    '<p class="oj-ti-section-1">CHAPTER III</p>',
    '<p>Final provisions</p>',
    '<p class="oj-ti-art">Article 6</p>',
    '<p>Entry into force</p>',
    '<p>Body six.</p>',
    '<p class="oj-ti-section-1">ANNEX I</p>',
    '<p>Correlation table</p>',
    '<p>Annex body.</p>',
  ].join('\n');
  const headings = parseActStructure(NESTED_HTML, 'html');
  const select = (selectors: Parameters<typeof extractSections>[2]) =>
    extractSections(NESTED_HTML, headings, selectors);
  const BODIES = ['Body one.', 'Body two.', 'Body three.', 'Body four.', 'Body five.', 'Body six.'];
  /** Every body line appears at most once — no source character is emitted twice. */
  const expectEachBodyAtMostOnce = (text: string) => {
    for (const body of BODIES) expect(text.split(body).length - 1).toBeLessThanOrEqual(1);
  };

  it('carries an article inside its selected chapter once, with the chapter slice unchanged', () => {
    const result = select({ chapters: 'I', articles: '1' });

    expect(result.text).toBe(select({ chapters: 'I' }).text);
    expectEachBodyAtMostOnce(result.text);
    expect(result.matched).toEqual(['CHAPTER I', 'Article 1']);
    // The nested article keeps its own address, and that address still re-cuts it.
    expect(result.sections.map((s) => s.label)).toEqual(['CHAPTER I', 'Article 1']);
    const [chapter, article] = result.sections;
    expect(article!.offset).toBeGreaterThan(chapter!.offset);
    expect(article!.offset + article!.chars).toBeLessThanOrEqual(chapter!.offset + chapter!.chars);
    const reread = NESTED_HTML.slice(article!.offset, article!.offset + article!.chars);
    expect(reread).toContain('Body one.');
    expect(reread).not.toContain('Body two.');
    expect(outermostSections(result.sections).map((s) => s.label)).toEqual(['CHAPTER I']);
  });

  it('carries articles two levels down (chapter ⊃ section ⊃ article) once', () => {
    const result = select({ chapters: 'II', articles: '3,5' });

    expect(result.text).toBe(select({ chapters: 'II' }).text);
    expectEachBodyAtMostOnce(result.text);
    expect(result.sections.map((s) => s.label)).toEqual(['CHAPTER II', 'Article 3', 'Article 5']);
    expect(outermostSections(result.sections)).toHaveLength(1);
  });

  it('carries nested articles once across two selected chapter ranges, which stay separate slices', () => {
    const result = select({ chapters: 'I,II', articles: '2,4' });

    expect(result.text).toBe(select({ chapters: 'I,II' }).text);
    expectEachBodyAtMostOnce(result.text);
    expect(result.sections.map((s) => s.label)).toEqual([
      'CHAPTER I',
      'Article 2',
      'CHAPTER II',
      'Article 4',
    ]);
    // The two chapters are adjacent, not merged: two slices joined in order.
    const slices = outermostSections(result.sections);
    expect(slices.map((s) => s.label)).toEqual(['CHAPTER I', 'CHAPTER II']);
    expect(result.text).toBe(
      slices.map((s) => NESTED_HTML.slice(s.offset, s.offset + s.chars).trim()).join('\n\n'),
    );
  });

  it('drops a nested article whose span ends exactly where its chapter ends', () => {
    const result = select({ articles: '6', chapters: 'III' });

    const [chapter, article] = result.sections;
    expect(article!.offset + article!.chars).toBe(chapter!.offset + chapter!.chars);
    expect(result.text).toBe(select({ chapters: 'III' }).text);
    expectEachBodyAtMostOnce(result.text);
  });

  it('drops a nested article requested before its chapter and more than once', () => {
    const result = select({ articles: '4,4', chapters: 'II' });

    expect(result.text).toBe(select({ chapters: 'II' }).text);
    // matched is unchanged: one entry per request, in document order.
    expect(result.matched).toEqual(['CHAPTER II', 'Article 4', 'Article 4']);
    expect(result.sections.map((s) => s.label)).toEqual(['CHAPTER II', 'Article 4']);
  });

  it('keeps adjacent sections as separate slices, unchanged', () => {
    const articles = select({ articles: '1,2' });
    expect(outermostSections(articles.sections).map((s) => s.label)).toEqual([
      'Article 1',
      'Article 2',
    ]);
    expect(articles.text).toBe(
      `${select({ articles: '1' }).text}\n\n${select({ articles: '2' }).text}`,
    );

    const chapters = select({ chapters: 'I,II' });
    expect(outermostSections(chapters.sections)).toHaveLength(2);
    expect(chapters.text).toBe(
      `${select({ chapters: 'I' }).text}\n\n${select({ chapters: 'II' }).text}`,
    );
  });

  it('carries a disjoint section beside a nested pair, in document order', () => {
    const result = select({ chapters: 'I', articles: '1,5', annexes: 'I' });

    expect(result.text).toBe(
      [select({ chapters: 'I' }), select({ articles: '5' }), select({ annexes: 'I' })]
        .map((r) => r.text)
        .join('\n\n'),
    );
    expect(outermostSections(result.sections).map((s) => s.label)).toEqual([
      'CHAPTER I',
      'Article 5',
      'ANNEX I',
    ]);
    expectEachBodyAtMostOnce(result.text);
  });
});
