/**
 * @fileoverview Tests for the #12 act-structure parser — parseActStructure (HTML /
 * markdown rendered-text path and Formex XML element path, each in the served
 * language's heading vocabulary) and extractSections
 * (offset slicing, Roman↔Arabic equivalence, misses, degradation). Fixtures mirror
 * the CELLAR layout confirmed live against GDPR (32016R0679): headings render on
 * their own line, recitals as parenthesized `(N)` in the preamble.
 * @module tests/services/act-structure.test
 */

import { describe, expect, it } from 'vitest';
import {
  type ActHeading,
  collapseRecitals,
  extractSections,
  outermostSections,
  parseActStructure,
} from '@/services/eurlex-content/act-structure.js';
import { EURLEX_LANGUAGES } from '@/services/eurlex-content/eurlex-content-service.js';
import { htmlToMarkdown } from '@/services/eurlex-content/html-to-markdown.js';
import { AI_ACT_HEADINGS, actHtml } from '../fixtures/eurlex-act-headings.js';
import {
  AMENDING_FORMEX,
  AMENDING_HTML,
  CRR2_EXCERPT_HTML,
} from '../fixtures/eurlex-amending-act.js';
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
      const headings = parseActStructure(STRUCTURED_HTML, 'html', 'EN');
      expect(countKinds(headings)).toEqual({ recital: 2, chapter: 2, article: 3, annex: 1 });
    });

    it('emits offsets in ascending document order, each landing on its heading text', () => {
      const headings = parseActStructure(STRUCTURED_HTML, 'html', 'EN');
      const offsets = headings.map((h) => h.offset);
      expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);
      const article1 = headings.find((h) => h.kind === 'article' && h.number === '1');
      expect(article1).toBeDefined();
      expect(STRUCTURED_HTML.slice(article1!.offset)).toMatch(/^<p[^>]*>Article 1</);
    });

    it('captures the descriptive title from the line after the heading', () => {
      const headings = parseActStructure(STRUCTURED_HTML, 'html', 'EN');
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
      const headings = parseActStructure(GATING_HTML, 'html', 'EN');
      // Two preamble recitals; the (1) after Article 1 is a sub-point, not a third recital.
      expect(countKinds(headings)).toEqual({ recital: 2, article: 1 });
    });

    it('returns an empty outline for an act with no detectable structure (case law)', () => {
      expect(parseActStructure(UNSTRUCTURED_HTML, 'html', 'EN')).toEqual([]);
    });
  });

  describe('markdown path', () => {
    it('detects structure from rendered markdown text without DOM classes', () => {
      const headings = parseActStructure(STRUCTURED_MD, 'markdown', 'EN');
      expect(countKinds(headings)).toEqual({ recital: 2, chapter: 1, article: 2 });
      expect(headings.find((h) => h.kind === 'article' && h.number === '1')?.title).toBe(
        'Subject-matter and objectives',
      );
    });
  });

  describe('character references in heading text (#79)', () => {
    /** Title of the article numbered `n` in ENTITY_HTML. */
    const titleOf = (n: string, content = ENTITY_HTML, format: 'html' | 'xml' = 'html') =>
      parseActStructure(content, format, 'EN').find((h) => h.kind === 'article' && h.number === n)
        ?.title;

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
      expect(() => parseActStructure(html, 'html', 'EN')).not.toThrow();
      expect(titleOf('4', html)).toBe('Overflow &#99999999; and &#xFFFFFFFF; survive');
    });

    it('decodes a non-breaking space inside the heading itself so the pattern still matches', () => {
      expect(parseActStructure(ENTITY_HTML, 'html', 'EN').map((h) => h.label)).toEqual([
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

  describe('Formex quotation marks (#99)', () => {
    /** Formex article with the given subtitle markup. */
    const article = (label: string, subtitle: string) =>
      `<ARTICLE><TI.ART>${label}</TI.ART><STI.ART>${subtitle}</STI.ART><ALINEA>Body.</ALINEA></ARTICLE>`;
    /** Subtitle of the first article in a Formex fragment. */
    const subtitle = (formex: string) =>
      parseActStructure(formex, 'xml', 'EN').find((h) => h.kind === 'article')?.title;
    const quote = (name: 'START' | 'END', code: string, id: string) =>
      `<QUOT.${name} CODE="${code}" ID="${id}" REF.${name === 'START' ? 'END' : 'START'}="${id}"/>`;

    it.each([
      [
        'English',
        'Article 17',
        `Right to erasure (${quote('START', '2018', 'QS0048')}right to be forgotten${quote('END', '2019', 'QE0048')})`,
        'Right to erasure (‘right to be forgotten’)',
      ],
      [
        'French',
        'Article 17',
        `Droit à l'effacement (${quote('START', '00AB', 'QS0046')}droit à l'oubli${quote('END', '00BB', 'QE0046')})`,
        "Droit à l'effacement («droit à l'oubli»)",
      ],
      [
        'German',
        'Artikel 17',
        `Recht auf Löschung (${quote('START', '201E', 'QS0055')}Recht auf Vergessenwerden${quote('END', '201C', 'QE0055')})`,
        'Recht auf Löschung („Recht auf Vergessenwerden“)',
      ],
    ])(
      'renders GDPR Article 17’s %s marks as the HTML title does',
      (_lang, label, markup, title) => {
        // The markup CELLAR serves for 32016R0679 in each language.
        expect(subtitle(article(label, markup))).toBe(title);
      },
    );

    it('renders the paired element form, inside a <P>', () => {
      // 32018R1725 Article 19 writes each mark as an empty start/end tag pair.
      const markup =
        '<P>Right to erasure (<QUOT.START CODE="2018" ID="QS0044" REF.END="QE0044"></QUOT.START>right to be forgotten<QUOT.END CODE="2019" ID="QE0044" REF.START="QS0044"></QUOT.END>)</P>';
      expect(subtitle(article('Article 19', markup))).toBe(
        'Right to erasure (‘right to be forgotten’)',
      );
    });

    it('adds no padding around a mark', () => {
      expect(
        subtitle(article('Article 1', '(<QUOT.START CODE="2018"/>x<QUOT.END CODE="2019"/>)')),
      ).toBe('(‘x’)');
    });

    it('renders marks in a chapter subtitle, and numbers an article through them', () => {
      const formex = [
        '<DIVISION><TITLE><TI><P>CHAPTER I</P></TI><STI><P>The <QUOT.START CODE="201C"/>general<QUOT.END CODE="201D"/> part</P></STI></TITLE>',
        '<ARTICLE><TI.ART>Article <QUOT.START CODE="2018"/>2<QUOT.END CODE="2019"/></TI.ART></ARTICLE></DIVISION>',
      ].join('');
      const headings = parseActStructure(formex, 'xml', 'EN');
      expect(headings.find((h) => h.kind === 'chapter')?.title).toBe('The “general” part');
      expect(headings.find((h) => h.kind === 'article')?.label).toBe('Article 2');
    });

    it.each([
      ['missing', '<QUOT.START/>x<QUOT.END ID="QE1"></QUOT.END>'],
      ['non-hex', '<QUOT.START CODE="ZZ18"/>x<QUOT.END CODE="20 19"></QUOT.END>'],
      ['out-of-range', '<QUOT.START CODE="110000"/>x<QUOT.END CODE="FFFFFFF"></QUOT.END>'],
      ['surrogate or control', '<QUOT.START CODE="D800"/>x<QUOT.END CODE="0007"></QUOT.END>'],
    ])('renders a %s CODE as before and keeps detecting structure', (_label, marks) => {
      const formex = [
        article('Article 1', `Scope (${marks})`),
        article('Article 2', 'Definitions'),
      ].join('');
      const headings = parseActStructure(formex, 'xml', 'EN');
      expect(headings.map((h) => [h.label, h.title])).toEqual([
        ['Article 1', 'Scope ( x )'],
        ['Article 2', 'Definitions'],
      ]);
    });

    it('decodes a mark once, so the character it names never starts a reference', () => {
      // CODE 0026 names "&": followed by "lt;" it must stay the four characters "&lt;".
      expect(subtitle(article('Article 1', 'A <QUOT.START CODE="0026"/>lt; B'))).toBe('A &lt; B');
    });
  });

  describe('Formex XML path', () => {
    it('detects articles and recitals from Formex elements, with the STI.ART subtitle', () => {
      const headings = parseActStructure(FORMEX_DOC_2, 'xml', 'EN');
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
      const headings = parseActStructure(FORMEX_DOC_2, 'xml', 'EN');
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
      const headings = parseActStructure(WRAPPED_FORMEX, 'xml', 'EN');
      const chapters = headings.filter((h) => h.kind === 'chapter');
      expect(chapters.map((h) => [h.label, h.title])).toEqual([
        ['CHAPTER I', 'General provisions'],
        ['CHAPTER III', 'Rights of the data subject'],
      ]);
      // Each offset lands on the heading's own <TI>.
      for (const h of chapters) expect(WRAPPED_FORMEX.slice(h.offset)).toMatch(/^<TI><P><HT/);
    });

    it('detects title-case sections under one or two nested <HT> wrappers', () => {
      const sections = parseActStructure(WRAPPED_FORMEX, 'xml', 'EN').filter(
        (h) => h.kind === 'section',
      );
      expect(sections.map((h) => [h.label, h.title])).toEqual([
        ['Section 1', 'Transparency and modalities'],
        ['Section 2', 'Information and access'],
      ]);
    });

    it('orders the wrapped headings with the articles and recitals, and skips the act title', () => {
      expect(parseActStructure(WRAPPED_FORMEX, 'xml', 'EN').map((h) => h.label)).toEqual([
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
      const headings = parseActStructure(WRAPPED_FORMEX, 'xml', 'EN');
      const result = extractSections(WRAPPED_FORMEX, headings, { chapters: 'III' }, 'EN');
      expect(result.matched).toEqual(['CHAPTER III']);
      expect(result.missed).toEqual([]);
      expect(result.text).toContain('Article 12');
      expect(result.text).toContain('Article 13');
      expect(result.text).not.toContain('Article 1<');
    });

    it('skips a keyword run into a longer word, and a wrapper that is not <HT>', () => {
      const formex =
        '<TI><P><HT TYPE="BOLD">CHAPTERS I to III</HT></P></TI><TI><P><HTML>CHAPTER I</HTML></P></TI>';
      expect(parseActStructure(formex, 'xml', 'EN')).toEqual([]);
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
      parseActStructure(text, 'xml', 'EN');
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
      parseActStructure(content, 'xml', 'EN').filter((h) => h.kind === 'article');

    it('reads number, label, offset, and subtitle from each article shape', () => {
      expect(articles(ARTICLE_EDGE_FORMEX)).toEqual([
        { kind: 'article', number: '1', label: 'Article 1', offset: 9, title: 'Spaced subtitle' },
        { kind: 'article', number: '2', label: 'Article 2', offset: 91 },
        { kind: 'article', number: '3A', label: 'Article 3A', offset: 155, title: 'Wrapped title' },
        { kind: 'article', number: '4', label: 'Article 4', offset: 277 },
        { kind: 'article', number: '', label: 'Final provision', offset: 351, title: 'Unnumbered' },
        { kind: 'article', number: '6', label: 'Article 6', offset: 431, title: 'Six' },
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
      'unclosed <QUOT.START> openers inside a closed heading (#99)': (n) =>
        `<TI.ART>${fill('<QUOT.START CODE="2018" ', n - 17)}</TI.ART>`,
      'paired <QUOT.START> openers missing their closer (#99)': (n) =>
        `<TI.ART>${fill('<QUOT.START CODE="2018">', n - 17)}</TI.ART>`,
    };

    it.each(Object.entries(ADVERSARIAL_ARTICLES))('stays linear on %s', (_label, build) =>
      expectLinearParse(build),
    );
  });
});

describe('extractSections', () => {
  const html = STRUCTURED_HTML;
  const headings = parseActStructure(STRUCTURED_HTML, 'html', 'EN');

  it('slices a single article from its heading to the next same-or-broader heading', () => {
    const result = extractSections(html, headings, { articles: '1' }, 'EN');
    expect(result.requested).toEqual(['Article 1']);
    expect(result.matched).toEqual(['Article 1']);
    expect(result.missed).toEqual([]);
    expect(result.text).toContain('Article 1');
    expect(result.text).toContain('Subject-matter and objectives');
    // Article 1 ends at Article 2 (same rank), so its neighbor is not included.
    expect(result.text).not.toContain('Material scope');
  });

  it('returns multiple selected sections in document order regardless of request order', () => {
    const result = extractSections(html, headings, { articles: '5', chapters: 'I' }, 'EN');
    // CHAPTER I precedes Article 5 in the document.
    expect(result.matched).toEqual(['CHAPTER I', 'Article 5']);
  });

  it('treats Roman and Arabic chapter numbers as equivalent', () => {
    const result = extractSections(html, headings, { chapters: '2' }, 'EN');
    expect(result.matched).toEqual(['CHAPTER II']);
    expect(result.text).toContain('Principles');
  });

  it('a chapter slice spans its nested articles up to the next chapter', () => {
    const result = extractSections(html, headings, { chapters: 'I' }, 'EN');
    // CHAPTER I holds Articles 1 and 2, ending at CHAPTER II.
    expect(result.text).toContain('Article 1');
    expect(result.text).toContain('Article 2');
    expect(result.text).not.toContain('Article 5');
    expect(result.text).not.toContain('CHAPTER II');
  });

  it('reports a miss without returning any text', () => {
    const result = extractSections(html, headings, { articles: '99' }, 'EN');
    expect(result.matched).toEqual([]);
    expect(result.missed).toEqual(['Article 99']);
    expect(result.text).toBe('');
  });

  it('reports every request as missed with empty text when no structure was detected', () => {
    const emptyHeadings = parseActStructure(UNSTRUCTURED_HTML, 'html', 'EN');
    const result = extractSections(
      UNSTRUCTURED_HTML,
      emptyHeadings,
      { articles: '1', chapters: 'I' },
      'EN',
    );
    expect(result.matched).toEqual([]);
    expect(result.missed).toEqual(['Article 1', 'CHAPTER I']);
    expect(result.text).toBe('');
  });

  it('deduplicates a section requested twice — text appears once', () => {
    const result = extractSections(html, headings, { articles: '1,1' }, 'EN');
    expect(result.requested).toEqual(['Article 1', 'Article 1']);
    expect(result.matched).toEqual(['Article 1', 'Article 1']);
    const occurrences = result.text.split('Subject-matter and objectives').length - 1;
    expect(occurrences).toBe(1);
    // One address per slice that fed the text, not per request (#80).
    expect(result.sections).toHaveLength(1);
  });

  it('addresses each sliced section by its own source span (#80)', () => {
    const result = extractSections(html, headings, { articles: '5', chapters: 'I' }, 'EN');

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
    const result = extractSections(html, headings, { articles: 'Article 1' }, 'EN');
    expect(result.matched).toEqual(['Article 1']);
  });

  it('slices the original body, so character references reach the caller undecoded (#79)', () => {
    // Decoding happens only on the classification path; the returned text is a
    // slice of the source string, so the act's own escaping survives verbatim.
    const entityHeadings = parseActStructure(ENTITY_HTML, 'html', 'EN');
    const result = extractSections(ENTITY_HTML, entityHeadings, { articles: '1' }, 'EN');
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
  const headings = parseActStructure(NESTED_HTML, 'html', 'EN');
  const select = (selectors: Parameters<typeof extractSections>[2]) =>
    extractSections(NESTED_HTML, headings, selectors, 'EN');
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

describe('headings in every EUR-Lex language (#107)', () => {
  type Row = [kind: string, number: string, title: string | undefined];
  const rows = (headings: readonly ActHeading[]): Row[] =>
    headings.map((h) => [h.kind, h.number, h.title]);

  /** The outline of {@link actHtml} in any language: numbers and titles as in English. */
  const EXPECTED: Row[] = [
    ['recital', '1', undefined],
    ['recital', '2', undefined],
    ['chapter', 'I', 'General provisions'],
    ['section', '1', 'Classification'],
    ['article', '1', 'Subject matter'],
    ['article', '2', 'Scope'],
    ['chapter', 'IV', 'Transparency'],
    ['annex', 'I', 'List of legislation'],
  ];

  /** Visible characters of a line, for comparing HTML and Markdown renderings. */
  const bare = (line: string) => line.replace(/<[^<>]*>|\\|\s/g, '');

  describe.each(['html', 'markdown'] as const)('%s', (format) => {
    const bodyIn = (language: (typeof EURLEX_LANGUAGES)[number]) => {
      const html = actHtml(AI_ACT_HEADINGS[language]);
      return format === 'html' ? html : htmlToMarkdown(html);
    };

    it.each(EURLEX_LANGUAGES)('%s: detects every heading kind, numbered as in English', (lang) => {
      const content = bodyIn(lang);
      const headings = parseActStructure(content, format, lang);
      expect(rows(headings)).toEqual(EXPECTED);
      // Each offset lands on the line carrying that heading's own text.
      const markup = AI_ACT_HEADINGS[lang];
      const lineAt = (h: ActHeading | undefined) =>
        bare(content.slice(h?.offset ?? 0).split('\n')[0] ?? '');
      expect(lineAt(headings.find((h) => h.kind === 'article'))).toBe(bare(markup.article1));
      expect(lineAt(headings.find((h) => h.kind === 'annex'))).toBe(bare(markup.annex1));
    });

    it.each(EURLEX_LANGUAGES)('%s: selects article 1, chapter IV, and annex I', (lang) => {
      const content = bodyIn(lang);
      const result = extractSections(
        content,
        parseActStructure(content, format, lang),
        { articles: '1', chapters: 'IV', annexes: 'I' },
        lang,
      );
      expect(result.matched).toEqual(['Article 1', 'CHAPTER IV', 'ANNEX I']);
      expect(result.missed).toEqual([]);
      expect(result.text).toContain('Body one.');
      expect(result.text).toContain('Body four.');
      expect(result.text).toContain('Annex body.');
      expect(result.text).not.toContain('Body two.');
    });
  });

  it('labels every language’s headings in the English form the selectors use', () => {
    const headings = parseActStructure(actHtml(AI_ACT_HEADINGS.HU), 'html', 'HU');
    expect(headings.map((h) => h.label)).toEqual([
      'Recital 1',
      'Recital 2',
      'CHAPTER I',
      'Section 1',
      'Article 1',
      'Article 2',
      'CHAPTER IV',
      'ANNEX I',
    ]);
  });

  it('reads headings in the served language only', () => {
    // Every language shares the `(N)` recital marker, but a recital alone is not
    // structure: another language's headings are not read at all.
    expect(parseActStructure(actHtml(AI_ACT_HEADINGS.DE), 'html', 'FR')).toEqual([]);
    expect(parseActStructure(actHtml(AI_ACT_HEADINGS.EN), 'html', 'DE')).toEqual([]);
    expect(parseActStructure(actHtml(AI_ACT_HEADINGS.FI), 'html', 'ET')).toEqual([]);
  });

  it('reads a selector written with the served language’s own kind words', () => {
    const de = actHtml(AI_ACT_HEADINGS.DE);
    const deHeadings = parseActStructure(de, 'html', 'DE');
    expect(
      extractSections(
        de,
        deHeadings,
        { articles: 'Artikel 1', chapters: 'kapitel IV', annexes: 'ANHANG I' },
        'DE',
      ),
    ).toMatchObject({
      requested: ['Article 1', 'CHAPTER IV', 'ANNEX I'],
      matched: ['Article 1', 'CHAPTER IV', 'ANNEX I'],
      missed: [],
    });
    // Number-first languages write the kind word after the number, often with a period.
    const hu = actHtml(AI_ACT_HEADINGS.HU);
    expect(
      extractSections(
        hu,
        parseActStructure(hu, 'html', 'HU'),
        { articles: '1. cikk', chapters: 'IV. FEJEZET' },
        'HU',
      ),
    ).toMatchObject({ requested: ['Article 1', 'CHAPTER IV'], missed: [] });
    // French writes the first article "premier".
    const fr = actHtml(AI_ACT_HEADINGS.FR);
    expect(
      extractSections(
        fr,
        parseActStructure(fr, 'html', 'FR'),
        { articles: 'Article premier' },
        'FR',
      ).matched,
    ).toEqual(['Article 1']);
    // English kind words are read in every language; another language's are not.
    expect(extractSections(de, deHeadings, { articles: 'Article 2' }, 'DE').matched).toEqual([
      'Article 2',
    ]);
    expect(extractSections(de, deHeadings, { articles: 'cikk 1' }, 'DE').missed).toEqual([
      'Article CIKK 1',
    ]);
  });

  it.each([
    [
      'one token with a whitespace run before a non-keyword',
      (n: number) => `1${' '.repeat(n - 2)}x`,
    ],
    [
      'one token with a whitespace run before a keyword',
      (n: number) => `1${' '.repeat(n - 5)}cikk`,
    ],
    ['kind-word tokens repeated', (n: number) => '1. cikk,'.repeat(Math.ceil(n / 8)).slice(0, n)],
  ])('reads a caller-sized selector in linear time: %s', (_label, build) => {
    // Best of seven at 5k, 20k, and 80k characters: linear grows ~16×, quadratic
    // ~256×, so the 80k/5k ratio stays under 64 (5k floored at 0.1 ms), and the 80k
    // read stays under an absolute bound.
    const hu = actHtml(AI_ACT_HEADINGS.HU);
    const headings = parseActStructure(hu, 'html', 'HU');
    const time = (n: number) => {
      const articles = build(n);
      let best = Number.POSITIVE_INFINITY;
      for (let round = 0; round < 7; round++) {
        const start = performance.now();
        extractSections(hu, headings, { articles }, 'HU');
        best = Math.min(best, performance.now() - start);
      }
      return best;
    };
    const t5k = time(5_000);
    time(20_000);
    const t80k = time(80_000);
    expect(t80k / Math.max(t5k, 0.1)).toBeLessThan(64);
    expect(t80k).toBeLessThan(40);
  });

  it('reads Greek capital iota and chi as the Roman numerals they stand in for', () => {
    const html = [
      '<p class="oj-ti-section-1">ΚΕΦΑΛΑΙΟ ΙΧ</p>',
      '<p class="oj-ti-art">Άρθρο 1</p>',
      '<p class="oj-ti-section-1">ΚΕΦΑΛΑΙΟ ΧΙ</p>',
      '<p class="oj-doc-ti">ΠΑΡΑΡΤΗΜΑ ΙΙΙ</p>',
    ].join('\n');
    const headings = parseActStructure(html, 'html', 'EL');
    expect(headings.map((h) => h.label)).toEqual([
      'CHAPTER IX',
      'Article 1',
      'CHAPTER XI',
      'ANNEX III',
    ]);
    // A selector written with the Greek letters reaches the same chapter.
    expect(extractSections(html, headings, { chapters: 'ΧΙ' }, 'EL').matched).toEqual([
      'CHAPTER XI',
    ]);
    expect(extractSections(html, headings, { chapters: '9,3' }, 'EL')).toMatchObject({
      matched: ['CHAPTER IX'],
      missed: ['CHAPTER 3'],
    });
  });

  it('reads a trailing period and the Portuguese ordinal on any number', () => {
    const html = [
      '<p class="oj-ti-art">Članak 12.</p>',
      '<p class="oj-ti-section-1">POGLAVLJE XII.</p>',
      '<p class="oj-doc-ti">PRILOG IV.</p>',
    ].join('\n');
    expect(rows(parseActStructure(html, 'html', 'HR'))).toEqual([
      ['article', '12', undefined],
      ['chapter', 'XII', undefined],
      ['annex', 'IV', undefined],
    ]);
    const pt = '<p class="oj-ti-art">Artigo 10.<span class="oj-super">o</span></p>';
    expect(rows(parseActStructure(pt, 'html', 'PT'))).toEqual([['article', '10', undefined]]);
    expect(rows(parseActStructure(htmlToMarkdown(pt), 'markdown', 'PT'))).toEqual([
      ['article', '10', undefined],
    ]);
  });

  it('reads "premier" as article 1 only in French, and only as the article number', () => {
    const html = (heading: string) => `<p class="oj-ti-art">${heading}</p>`;
    expect(rows(parseActStructure(html('Article premier'), 'html', 'FR'))).toEqual([
      ['article', '1', undefined],
    ]);
    expect(parseActStructure(html('Article premier'), 'html', 'EN')).toEqual([]);
    expect(parseActStructure(html('CHAPITRE premier'), 'html', 'FR')).toEqual([]);
  });

  it('still rejects a heading keyword run on into prose', () => {
    const html = [
      '<p>Artikel 5 dieser Verordnung gilt.</p>',
      '<p>1. cikk szerinti eljárás</p>',
      '<p>I LUKU koskee</p>',
      '<p>1 artiklan mukaisesti</p>',
    ].join('\n');
    expect(parseActStructure(html, 'html', 'DE')).toEqual([]);
    expect(parseActStructure(html, 'html', 'HU')).toEqual([]);
    expect(parseActStructure(html, 'html', 'FI')).toEqual([]);
  });

  describe('Formex', () => {
    /** Trimmed from the French GDPR (32016R0679) Formex: chapter keywords italic, sections title-case. */
    const FR_FORMEX = [
      '<ACT><PREAMBLE><GR.CONSID><CONSID><NP><NO.P>(1)</NO.P><TXT>Considérant.</TXT></NP></CONSID></GR.CONSID></PREAMBLE>',
      '<ENACTING.TERMS><DIVISION><TITLE><TI><P><HT TYPE="ITALIC">CHAPITRE I</HT></P></TI><STI><P>Dispositions générales</P></STI></TITLE>',
      '<ARTICLE IDENTIFIER="001"><TI.ART>Article premier</TI.ART><STI.ART>Objet et objectifs</STI.ART><ALINEA>Un.</ALINEA></ARTICLE>',
      '<ARTICLE IDENTIFIER="002"><TI.ART>Article 2</TI.ART><STI.ART>Champ d’application</STI.ART><ALINEA>Deux.</ALINEA></ARTICLE>',
      '</DIVISION><DIVISION><TITLE><TI><P><HT TYPE="ITALIC">CHAPITRE III</HT></P></TI><STI><P>Droits</P></STI></TITLE>',
      '<DIVISION><TITLE><TI><P><HT TYPE="EXPANDED">Section 1</HT></P></TI><STI><P>Transparence</P></STI></TITLE>',
      '<ARTICLE IDENTIFIER="012"><TI.ART>Article 12</TI.ART><ALINEA>Douze.</ALINEA></ARTICLE>',
      '</DIVISION></DIVISION></ENACTING.TERMS></ACT>',
    ].join('');

    it('numbers an article from its IDENTIFIER, so "Article premier" is article 1', () => {
      const headings = parseActStructure(FR_FORMEX, 'xml', 'FR');
      expect(headings.map((h) => [h.kind, h.number, h.label])).toEqual([
        ['recital', '1', 'Recital 1'],
        ['chapter', 'I', 'CHAPTER I'],
        ['article', '1', 'Article 1'],
        ['article', '2', 'Article 2'],
        ['chapter', 'III', 'CHAPTER III'],
        ['section', '1', 'Section 1'],
        ['article', '12', 'Article 12'],
      ]);
      const result = extractSections(FR_FORMEX, headings, { articles: '1', chapters: 'I' }, 'FR');
      expect(result.matched).toEqual(['CHAPTER I', 'Article 1']);
      expect(result.text).toContain('Un.');
      expect(result.text).toContain('Deux.');
      expect(result.text).not.toContain('Douze.');
    });

    it('labels an article in English whatever its heading text, as html does', () => {
      // The Hungarian 32015R2120 Formex: numbered by IDENTIFIER, or from the text without one.
      const formex = [
        '<ARTICLE IDENTIFIER="004"><TI.ART>4. cikk</TI.ART><STI.ART>Átláthatóság</STI.ART><ALINEA>Négy.</ALINEA></ARTICLE>',
        '<ARTICLE><TI.ART>5. cikk</TI.ART><ALINEA>Öt.</ALINEA></ARTICLE>',
      ].join('');
      const headings = parseActStructure(formex, 'xml', 'HU');
      expect(headings.map((h) => [h.number, h.label, h.title])).toEqual([
        ['4', 'Article 4', 'Átláthatóság'],
        ['5', 'Article 5', undefined],
      ]);
      expect(extractSections(formex, headings, { articles: '4,5' }, 'HU')).toMatchObject({
        requested: ['Article 4', 'Article 5'],
        matched: ['Article 4', 'Article 5'],
        sections: [{ label: 'Article 4' }, { label: 'Article 5' }],
      });
    });

    it('reads number-first chapter and section titles (Hungarian)', () => {
      // The Hungarian GDPR writes `I. FEJEZET` and the section in lower case, `1. szakasz`.
      const formex = [
        '<DIVISION><TITLE><TI><P><HT TYPE="ITALIC">I. FEJEZET</HT></P></TI><STI><P>Általános rendelkezések</P></STI></TITLE>',
        '<DIVISION><TITLE><TI><P><HT TYPE="EXPANDED">1. szakasz</HT></P></TI><STI><P>Átláthatóság</P></STI></TITLE>',
        '<ARTICLE IDENTIFIER="001"><TI.ART>1. cikk</TI.ART></ARTICLE></DIVISION></DIVISION>',
        '<TI><P>2016/679 rendelet</P></TI><TI><P>I. FEJEZETBEN</P></TI>',
      ].join('');
      expect(rows(parseActStructure(formex, 'xml', 'HU'))).toEqual([
        ['chapter', 'I', 'Általános rendelkezések'],
        ['section', '1', 'Átláthatóság'],
        ['article', '1', undefined],
      ]);
    });

    it('reads Greek title-case keywords, whose lower case keeps the accent upper case drops', () => {
      // The Greek GDPR writes chapters `ΚΕΦΑΛΑΙΟ ΙΧ` and sections `Τμήμα 1`.
      const formex = [
        '<TI><P><HT TYPE="ITALIC">ΚΕΦΑΛΑΙΟ ΙΧ</HT></P></TI>',
        '<TI><P><HT TYPE="EXPANDED">Τμήμα 1</HT></P></TI>',
        '<TI><P>Κεφάλαιο ΧΙ</P></TI>',
      ].join('');
      expect(rows(parseActStructure(formex, 'xml', 'EL'))).toEqual([
        ['chapter', 'IX', undefined],
        ['section', '1', undefined],
        ['chapter', 'XI', undefined],
      ]);
    });

    it('normalizes an IDENTIFIER and falls back to the heading text without a usable one', () => {
      const formex = [
        '<ARTICLE IDENTIFIER="006A"><TI.ART><QUOT.START CODE="2018"/>Article 6a</TI.ART></ARTICLE>',
        '<ARTICLE IDENTIFIER="019">\n <TI.ART>Article 19</TI.ART></ARTICLE>',
        '<ARTICLE><TI.ART>Article 20</TI.ART></ARTICLE>',
        '<ARTICLE IDENTIFIER="A-1"><TI.ART>Article 21</TI.ART></ARTICLE>',
        '<ARTICLE IDENTIFIER="030"><ALINEA>No heading.</ALINEA></ARTICLE><TI.ART>Article 22</TI.ART>',
        '<ARTICLE IDENTIFIER="001"><TI.ART>Artikel eins</TI.ART></ARTICLE>',
      ].join('');
      expect(parseActStructure(formex, 'xml', 'EN').map((h) => [h.number, h.label])).toEqual([
        ['6A', 'Article 6A'],
        ['19', 'Article 19'],
        ['20', 'Article 20'],
        ['21', 'Article 21'],
        ['22', 'Article 22'],
        ['1', 'Article 1'],
      ]);
    });

    it('keys the chapter keyword by language, as the text path does', () => {
      expect(parseActStructure(FR_FORMEX, 'xml', 'EN').filter((h) => h.kind === 'chapter')).toEqual(
        [],
      );
    });
  });

  /** Build a string of exactly `n` characters by repeating `unit`. */
  const fill = (unit: string, n: number) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);

  /**
   * Best-of-seven parse time at 5k, 20k, and 80k characters. A linear scan grows
   * about 16× from 5k to 80k and a quadratic one about 256×, so the 80k/5k ratio
   * must stay under 64 — with the 5k time floored at 0.1 ms, so a sub-timer-noise
   * small input cannot inflate it — and the 80k parse under an absolute bound.
   */
  const expectLinearScaling = (
    build: (n: number) => string,
    format: 'html' | 'markdown' | 'xml',
    language: (typeof EURLEX_LANGUAGES)[number],
  ) => {
    const time = (n: number) => {
      const text = build(n);
      let best = Number.POSITIVE_INFINITY;
      for (let round = 0; round < 7; round++) {
        const start = performance.now();
        parseActStructure(text, format, language);
        best = Math.min(best, performance.now() - start);
      }
      return best;
    };
    const t5k = time(5_000);
    time(20_000);
    const t80k = time(80_000);
    expect(t80k / Math.max(t5k, 0.1)).toBeLessThan(64);
    expect(t80k).toBeLessThan(40);
  };

  const ADVERSARIAL: [
    string,
    (n: number) => string,
    'html' | 'xml',
    (typeof EURLEX_LANGUAGES)[number],
  ][] = [
    ['a number-first opener repeated on one line', (n) => fill('1. ', n), 'html', 'HU'],
    ['a number-first heading on every line', (n) => fill('1. cikk\n', n), 'html', 'HU'],
    ['a keyword repeated on one line', (n) => fill('Artikel ', n), 'html', 'DE'],
    ['an annex keyword and delimiter repeated', (n) => fill('LIITE I — ', n), 'html', 'FI'],
    ['Greek numerals with no keyword', (n) => `ΚΕΦΑΛΑΙΟ ${fill('ΙΧ', n - 9)}`, 'html', 'EL'],
    ['periods and escapes after a number', (n) => `Članak 1${fill('\\.', n - 8)}`, 'html', 'HR'],
    [
      'unclosed <ARTICLE IDENTIFIER openers',
      (n) => fill('<ARTICLE IDENTIFIER="001" ', n),
      'xml',
      'FR',
    ],
    [
      'one unclosed <ARTICLE tag repeating its IDENTIFIER',
      (n) => `<ARTICLE ${fill('IDENTIFIER="1" ', n - 9)}`,
      'xml',
      'FR',
    ],
    [
      'one <ARTICLE tag repeating an unclosed IDENTIFIER quote',
      (n) => `<ARTICLE ${fill('IDENTIFIER="', n - 10)}>`,
      'xml',
      'FR',
    ],
    [
      '<ARTICLE> openers with no <TI.ART>',
      (n) => fill('<ARTICLE IDENTIFIER="001">  ', n),
      'xml',
      'FR',
    ],
    [
      '<ARTICLE> openers before one <TI.ART>',
      (n) => `${fill('<ARTICLE IDENTIFIER="001">', n - 8)}<TI.ART>`,
      'xml',
      'FR',
    ],
    ['number-first <TI><P> openers with no keyword', (n) => fill('<TI><P>I. ', n), 'xml', 'HU'],
    [
      'nested <HT> before a number-first keyword',
      (n) => `<TI><P>${fill('<HT>', n - 20)}I. FEJEZET`,
      'xml',
      'HU',
    ],
    [
      'an unclosed number-first heading, repeated',
      (n) => fill('<TI><P>I. FEJEZET ', n),
      'xml',
      'HU',
    ],
  ];

  it.each(ADVERSARIAL)('stays linear on %s', (_label, build, format, language) =>
    expectLinearScaling(build, format, language),
  );
});

describe('collapseRecitals (#118)', () => {
  const at = (kind: ActHeading['kind'], number: string, offset: number): ActHeading => ({
    kind,
    number,
    label: `${kind} ${number}`,
    offset,
  });

  it('collapses each run of consecutive recitals, keeping a lone one and everything else', () => {
    const headings = [
      at('recital', '1', 0),
      at('recital', '2', 10),
      at('recital', '3', 20),
      at('article', '1', 30),
      at('recital', '9', 40),
      at('chapter', 'II', 50),
      at('recital', '10', 60),
      at('recital', '11', 70),
    ];
    expect(collapseRecitals(headings)).toEqual([
      { kind: 'recital', number: '1–3', label: 'Recitals 1–3', offset: 0 },
      headings[3],
      headings[4],
      headings[5],
      { kind: 'recital', number: '10–11', label: 'Recitals 10–11', offset: 60 },
    ]);
  });

  it('returns an empty outline, and one without recitals, unchanged', () => {
    expect(collapseRecitals([])).toEqual([]);
    const outline = [at('chapter', 'I', 0), at('article', '1', 5)];
    expect(collapseRecitals(outline)).toEqual(outline);
  });

  it('collapses the recitals of a parsed act, in any language', () => {
    const headings = parseActStructure(actHtml(AI_ACT_HEADINGS.FI), 'html', 'FI');
    expect(collapseRecitals(headings).map((h) => h.label)).toEqual([
      'Recitals 1–2',
      'CHAPTER I',
      'Section 1',
      'Article 1',
      'Article 2',
      'CHAPTER IV',
      'ANNEX I',
    ]);
  });
});

describe('quoted amending text is not the act’s own structure (#106)', () => {
  const labels = (headings: readonly ActHeading[]) => headings.map((h) => h.label);
  const OWN = ['Recital 1', 'Recital 2', 'Article 1', 'Article 2', 'Article 3', 'ANNEX'];
  const AMENDING_MD = htmlToMarkdown(AMENDING_HTML);

  it('keeps the act’s own headings and its table-cell recitals', () => {
    // CONVEX lays every recital out as a numbering-table cell, so the table rule
    // must never reach a recital.
    expect(labels(parseActStructure(AMENDING_HTML, 'html', 'EN'))).toEqual(
      expect.arrayContaining(OWN),
    );
    // Formex annexes are not detected at all.
    expect(labels(parseActStructure(AMENDING_FORMEX, 'xml', 'EN'))).toEqual(
      expect.arrayContaining(OWN.filter((l) => l !== 'ANNEX')),
    );
  });

  it('html: skips heading lines inside a numbering table, nested ones included', () => {
    const headings = parseActStructure(AMENDING_HTML, 'html', 'EN');
    // Article 6b sits one table deep; SECTION 4, Article 19, and ANNEX II sit in
    // the outer cell after a nested table closes.
    expect(labels(headings)).toEqual(OWN);
    expect(headings.find((h) => h.label === 'Article 2')?.title).toBe(
      'Amendments to Regulation (EU) No 531/2012',
    );
  });

  it('xml: skips headings whose opener sits inside <QUOT.S>, nested ones included', () => {
    const headings = parseActStructure(AMENDING_FORMEX, 'xml', 'EN');
    // Section 4 and Article 19 follow a closed LEVEL="2" quote, still inside LEVEL="1".
    expect(labels(headings)).toEqual(OWN.filter((l) => l !== 'ANNEX'));
    expect(headings.map((h) => h.number)).toEqual(['1', '2', '1', '2', '3']);
  });

  it('markdown: keeps a heading only where the source HTML keeps the same one', () => {
    // The Markdown drops the tables, so without its HTML every quoted heading reads as own.
    expect(labels(parseActStructure(AMENDING_MD, 'markdown', 'EN'))).toContain('Article 6B');
    const headings = parseActStructure(AMENDING_MD, 'markdown', 'EN', AMENDING_HTML);
    expect(labels(headings)).toEqual(OWN);
    // Offsets stay native to the Markdown string (#12).
    const article3 = headings.find((h) => h.label === 'Article 3');
    expect(AMENDING_MD.slice(article3!.offset)).toMatch(/^Article 3\n/);
  });

  /**
   * Parse a Markdown body with and without its HTML; `expected` names what the
   * HTML's verdict leaves. Selecting Article 2 shows whether the amending article
   * spans its quoted text, which a quoted heading kept as own would cut short.
   */
  const alignedOutline = (html: string) => {
    const md = htmlToMarkdown(html);
    const headings = parseActStructure(md, 'markdown', 'EN', html);
    return { md, headings, article2: extractSections(md, headings, { articles: '2,19' }, 'EN') };
  };

  it('markdown: aligns past a quoted HTML heading whose mark sits on its own line', () => {
    // CONVEX writes some quoted headings with the opening ‘ on a line of its own:
    // the HTML reads SECTION 4 alone on its line, the Markdown joins it to the mark.
    const html = AMENDING_HTML.replace(
      '<span class="oj-italic">SECTION 4</span>',
      '‘\n<span class="oj-italic">SECTION 4</span>',
    );
    const { md, headings, article2 } = alignedOutline(html);
    expect(md).toContain('‘ SECTION 4');
    expect(labels(headings)).toEqual(OWN);
    expect(article2).toMatchObject({ matched: ['Article 2'], missed: ['Article 19'] });
    expect(article2.text).toContain('Amending article tail.');
  });

  it('markdown: aligns past HTML headings in a table the Markdown renders as a grid', () => {
    // A correlation table's cells are headings to the HTML line scan and a GFM row
    // ("| Article 1 | Article 7 |") to the Markdown.
    const html = AMENDING_HTML.replace(
      '<p class="oj-normal">Body one.</p>',
      [
        '<p class="oj-normal">Body one.</p>',
        '<table class="oj-table"><tbody><tr><td>',
        '<p class="oj-tbl-txt">Article 1</p>',
        '</td><td>',
        '<p class="oj-tbl-txt">Article 7</p>',
        '</td></tr></tbody></table>',
      ].join('\n'),
    );
    const { md, headings, article2 } = alignedOutline(html);
    expect(md).toMatch(/\| Article 1 +\| Article 7 +\|/);
    expect(labels(headings)).toEqual(OWN);
    expect(article2.text).toContain('Amending article tail.');
  });

  it('markdown: an amending act excerpt (32019R0876) outlines its own articles only', () => {
    const html = CRR2_EXCERPT_HTML;
    expect(labels(parseActStructure(html, 'html', 'EN'))).toEqual(['Article 1', 'Article 2']);
    const { md, headings } = alignedOutline(html);
    expect(md).toContain('‘ Section 3');
    expect(labels(headings)).toEqual(['Article 1', 'Article 2']);
    const own = extractSections(md, headings, { articles: '2' }, 'EN');
    expect(own.text).toMatch(/^Article\s2\s+Amendments to Regulation \(EU\) No 648\/2012/);
    expect(extractSections(md, headings, { articles: '274' }, 'EN').missed).toEqual([
      'Article 274',
    ]);
  });

  it.each([
    [
      'a Markdown heading has no HTML counterpart',
      AMENDING_HTML.replace('<p class="oj-doc-ti">ANNEX</p>\n', ''),
      AMENDING_MD,
    ],
    [
      'an HTML heading outside any table would be passed over',
      AMENDING_HTML,
      AMENDING_MD.replace(/^Article 3\n/m, ''),
    ],
    [
      'an HTML heading outside any table is left over',
      AMENDING_HTML,
      AMENDING_MD.replace(/^ANNEX\n/m, ''),
    ],
  ])('markdown: keeps every heading when %s', (_label, html, md) => {
    // The verdicts cannot be placed, and the ones that could be would drop the
    // quoted headings on a guess that leaves the act's own unaccounted for, so
    // nothing is dropped.
    expect(parseActStructure(html, 'html', 'EN').length).toBeGreaterThan(0);
    const headings = parseActStructure(md, 'markdown', 'EN', html);
    expect(labels(headings)).toEqual(labels(parseActStructure(md, 'markdown', 'EN')));
    expect(labels(headings)).toContain('Article 6B');
  });

  it.each([
    ['html', AMENDING_HTML, undefined],
    ['xml', AMENDING_FORMEX, undefined],
    ['markdown', AMENDING_MD, AMENDING_HTML],
  ] as const)(
    '%s: an amending article spans its quoted text; a quoted-only number misses',
    (format, content, html) => {
      const headings = parseActStructure(content, format, 'EN', html);
      const amending = extractSections(content, headings, { articles: '2' }, 'EN');
      expect(amending.matched).toEqual(['Article 2']);
      expect(amending.text).toContain('Quoted six a.');
      expect(amending.text).toContain('Quoted nineteen.');
      expect(amending.text).toContain('Amending article tail.');
      expect(amending.text).not.toContain('Body three.');

      const quoted = extractSections(content, headings, { articles: '6b,19', annexes: 'II' }, 'EN');
      expect(quoted).toMatchObject({
        matched: [],
        missed: ['Article 6B', 'Article 19', 'ANNEX II'],
      });
      expect(quoted.text).toBe('');
    },
  );

  /** Build a string of exactly `n` characters by repeating `unit`. */
  const fill = (unit: string, n: number) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);

  /**
   * Best-of-seven parse time at 5k, 20k, and 80k characters: the 80k/5k ratio stays
   * under 64 (linear grows ~16×, quadratic ~256×), the 5k time floored at 0.1 ms,
   * and the 80k parse under an absolute bound. A Markdown case parses its source
   * HTML too, built at the same size.
   */
  const expectLinearScaling = (
    build: (n: number) => string,
    format: 'html' | 'markdown' | 'xml',
    buildHtml?: (n: number) => string,
  ) => {
    const time = (n: number) => {
      const text = build(n);
      const html = buildHtml?.(n);
      let best = Number.POSITIVE_INFINITY;
      for (let round = 0; round < 7; round++) {
        const start = performance.now();
        parseActStructure(text, format, 'EN', html);
        best = Math.min(best, performance.now() - start);
      }
      return best;
    };
    const t5k = time(5_000);
    time(20_000);
    const t80k = time(80_000);
    expect(t80k / Math.max(t5k, 0.1)).toBeLessThan(64);
    expect(t80k).toBeLessThan(40);
  };

  const ADVERSARIAL: [
    string,
    (n: number) => string,
    'html' | 'markdown' | 'xml',
    ((n: number) => string)?,
  ][] = [
    ['unclosed <table openers on one line', (n) => fill('<table ', n), 'html'],
    [
      'nested <table> openers, a heading inside each',
      (n) => fill('<table>\nArticle 1\n', n),
      'html',
    ],
    ['stray </table> closers before each heading', (n) => fill('</table>\nArticle 1\n', n), 'html'],
    [
      'a heading line led by unclosed tag openers',
      (n) => `${fill('<p <td ', n - 9)}Article 1`,
      'html',
    ],
    ['overlapping <tab<table prefixes', (n) => fill('<tab<table<tbody', n), 'html'],
    [
      'Markdown headings with their HTML in nested tables',
      (n) => fill('Article 1\n', n),
      'markdown',
      (n) => fill('<table><p>Article 1</p>\n', n),
    ],
    [
      'Markdown headings whose HTML sequence disagrees',
      (n) => fill('Article 1\n', n),
      'markdown',
      (n) => fill('<p>Article 2</p>\n', n),
    ],
    [
      'Markdown headings behind a run of in-table HTML headings',
      (n) => fill('Article 1\n', n),
      'markdown',
      (n) => `${fill('<table><p>Article 2</p>\n', n - 17)}<p>Article 1</p>\n`,
    ],
    [
      'Markdown headings aligned past an in-table HTML heading each',
      (n) => fill(`Article 1\n${' '.repeat(39)}`, n),
      'markdown',
      (n) => fill('<table><p>Article 2</p>\n</table><p>Article 1</p>\n', n),
    ],
    ['unclosed <QUOT.S openers', (n) => fill('<QUOT.S LEVEL="1" ', n), 'xml'],
    [
      'nested <QUOT.S> openers, an article inside each',
      (n) => fill('<QUOT.S><TI.ART>Article 1</TI.ART>', n),
      'xml',
    ],
    ['overlapping <QUOT.START / <QUOT.S prefixes', (n) => fill('<QUOT.START<QUOT.S', n), 'xml'],
    [
      'stray </QUOT.S> closers before each title',
      (n) => fill('</QUOT.S><TI><P>CHAPTER I</P></TI>', n),
      'xml',
    ],
  ];

  it.each(ADVERSARIAL)('stays linear on %s', (_label, build, format, buildHtml) =>
    expectLinearScaling(build, format, buildHtml),
  );

  it('applies in the served language (#107): a German amending act', () => {
    const german = AMENDING_HTML.replaceAll('Article ', 'Artikel ')
      .replace('SECTION 4', 'ABSCHNITT 4')
      .replaceAll('ANNEX', 'ANHANG');
    const md = htmlToMarkdown(german);
    for (const headings of [
      parseActStructure(german, 'html', 'DE'),
      parseActStructure(md, 'markdown', 'DE', german),
    ]) {
      expect(labels(headings)).toEqual(OWN);
    }
  });
});
