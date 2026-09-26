/**
 * @fileoverview Tests for the case-law outline (#117): parseDocumentStructure on a
 * sector-6 body — top-level section headings from each generation's markup, the
 * operative part of a judgment or order, the same outline in html, Markdown, and
 * Formex — and extractSections over it. Fixtures are trimmed live bodies.
 * @module tests/services/act-structure.case-law.test
 */

import { describe, expect, it } from 'vitest';
import {
  type ActHeading,
  extractSections,
  parseActStructure,
  parseDocumentStructure,
} from '@/services/eurlex-content/act-structure.js';
import type { EurLexLanguage } from '@/services/eurlex-content/eurlex-content-service.js';
import { htmlToMarkdown } from '@/services/eurlex-content/html-to-markdown.js';
import { AI_ACT_HEADINGS, actHtml } from '../fixtures/eurlex-act-headings.js';
import {
  AG_OPINION_COJ,
  AG_OPINION_LEGACY,
  GC_JUDGMENT_CONVEX,
  GC_JUDGMENT_WORD,
  JUDGMENT_COJ,
  JUDGMENT_COJ_NL,
  JUDGMENT_CONVEX_DE,
  JUDGMENT_CONVEX_EN,
  JUDGMENT_CONVEX_FR,
  JUDGMENT_FORMEX,
  LEGACY_JUDGMENT,
  LEGACY_ORDER,
  ORDER_WORD,
} from '../fixtures/eurlex-case-law.js';

const GOOGLE_SPAIN_EN = [
  'Legal context',
  'The dispute in the main proceedings and the questions referred for a preliminary ruling',
  'Consideration of the questions referred',
  'Costs',
];

/** The outline as [kind, number, label] triples. */
const entries = (headings: readonly ActHeading[]) =>
  headings.map((h) => [h.kind, h.number, h.label]);

/** The expected outline: headings numbered from 1, then the operative part when there is one. */
const outline = (labels: readonly string[], operative: boolean) => [
  ...labels.map((label, i) => ['heading', String(i + 1), label]),
  ...(operative ? [['operative_part', '', 'Operative part']] : []),
];

/** Each case-law body, its CELEX and served language, and the outline it carries. */
const BODIES: [string, string, EurLexLanguage, string, readonly string[], boolean][] = [
  ['62012CJ0131 EN (CONVEX)', '62012CJ0131', 'EN', JUDGMENT_CONVEX_EN, GOOGLE_SPAIN_EN, true],
  [
    '62012CJ0131 FR (CONVEX)',
    '62012CJ0131',
    'FR',
    JUDGMENT_CONVEX_FR,
    [
      'Le cadre juridique',
      'Le litige au principal et les questions préjudicielles',
      'Sur les questions préjudicielles',
      'Sur les dépens',
    ],
    true,
  ],
  [
    '62012CJ0131 DE (CONVEX)',
    '62012CJ0131',
    'DE',
    JUDGMENT_CONVEX_DE,
    ['Rechtlicher Rahmen', 'Ausgangsverfahren und Vorlagefragen', 'Zu den Vorlagefragen', 'Kosten'],
    true,
  ],
  [
    '62014TJ0353 (GC, CONVEX)',
    '62014TJ0353',
    'EN',
    GC_JUDGMENT_CONVEX,
    ['Background to the dispute', 'Procedure and forms of order sought', 'Law'],
    true,
  ],
  ['62019CJ0311 (coj-)', '62019CJ0311', 'EN', JUDGMENT_COJ, GOOGLE_SPAIN_EN, true],
  [
    '62019CJ0311 NL (coj-, a ruling with no lead-in phrase)',
    '62019CJ0311',
    'NL',
    JUDGMENT_COJ_NL,
    [
      'Toepasselijke bepalingen',
      'Hoofdgeding en prejudiciële vragen',
      'Beantwoording van de prejudiciële vragen',
      'Kosten',
    ],
    true,
  ],
  [
    '62023CC0135 (AG opinion, coj-)',
    '62023CC0135',
    'EN',
    AG_OPINION_COJ,
    [
      'Introduction',
      'Legal context',
      'Facts, procedure and question referred for a preliminary ruling',
      'Analysis',
      'Conclusion',
    ],
    false,
  ],
  [
    '62025TJ0069 (Word export)',
    '62025TJ0069',
    'EN',
    GC_JUDGMENT_WORD,
    [
      'Legal context',
      'The dispute in the main proceedings and the question referred for a preliminary ruling',
      'Consideration of the question referred',
      'Costs',
    ],
    true,
  ],
  ['62023CO0141 (order, Word export)', '62023CO0141', 'EN', ORDER_WORD, [], true],
  [
    '61962CJ0026 (legacy text/html)',
    '61962CJ0026',
    'EN',
    LEGACY_JUDGMENT,
    ['Keywords', 'Summary', 'Parties', 'Subject of the case', 'Grounds', 'Decision on costs'],
    true,
  ],
  [
    '61975CO0054 (legacy order, contents listing the first heading)',
    '61975CO0054',
    'EN',
    LEGACY_ORDER,
    ['Parties', 'Grounds', 'Decision on costs'],
    true,
  ],
  [
    '62006CC0341 (legacy AG opinion, title only)',
    '62006CC0341',
    'EN',
    AG_OPINION_LEGACY,
    [],
    false,
  ],
];

describe('case-law outline (#117)', () => {
  describe.each(BODIES)('%s', (_name, celex, language, html, labels, operative) => {
    const md = htmlToMarkdown(html);

    it('lists every top-level heading, then the operative part of a judgment or order', () => {
      expect(entries(parseDocumentStructure(celex, html, 'html', language))).toEqual(
        outline(labels, operative),
      );
    });

    it('gives the Markdown body the same outline, read against its source HTML', () => {
      const headings = parseDocumentStructure(celex, md, 'markdown', language, html);
      expect(entries(headings)).toEqual(outline(labels, operative));
      // Each Markdown offset lands on the line that carries the landmark.
      for (const h of headings.filter((x) => x.kind === 'heading')) {
        expect(md.slice(h.offset).replace(/^#+ |\*\*/g, '')).toMatch(
          new RegExp(`^${h.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
        );
      }
    });

    it('lands each html heading offset on the start of its heading line', () => {
      for (const h of parseDocumentStructure(celex, html, 'html', language)) {
        const before = html.slice(0, h.offset);
        expect(before === '' || before.endsWith('\n') || before.endsWith('>')).toBe(true);
        if (h.kind === 'heading') expect(html.slice(h.offset)).toMatch(/^\s*<(?:p|P|h2)\b/);
      }
    });
  });

  it('keeps the CONVEX formula found in a layout-table cell, starting the part at that table', () => {
    const headings = parseDocumentStructure('62012CJ0131', JUDGMENT_CONVEX_EN, 'html', 'EN');
    const operative = headings.find((h) => h.kind === 'operative_part');
    const formula = JUDGMENT_CONVEX_EN.indexOf('On those grounds, the Court (Grand Chamber)');
    expect(operative).toBeDefined();
    // The act parser's #106 rule reads a table cell as quoted text; this one is not dropped.
    expect(JUDGMENT_CONVEX_EN.slice(operative!.offset, formula)).toMatch(
      /^\s*<table\b[\s\S]*<td\b[\s\S]*<p class="normal">$/,
    );
    expect(JUDGMENT_CONVEX_EN.slice(0, operative!.offset)).toContain('Since these proceedings');
  });

  it('places the legacy operative part at its <a name="DI"/> anchor, past the contents link', () => {
    const operative = parseDocumentStructure('61962CJ0026', LEGACY_JUDGMENT, 'html', 'EN').at(-1)!;
    expect(operative.kind).toBe('operative_part');
    expect(LEGACY_JUDGMENT.slice(operative.offset)).toMatch(/^<a name="DI"\/><h2>Operative part/);
    expect(LEGACY_JUDGMENT.indexOf('href="#DI"')).toBeLessThan(operative.offset);

    const md = htmlToMarkdown(LEGACY_JUDGMENT);
    const inMd = parseDocumentStructure('61962CJ0026', md, 'markdown', 'EN', LEGACY_JUDGMENT);
    expect(md.slice(inMd.at(-1)!.offset)).toMatch(/^## Operative part/);
    // The table of contents renders the same words as a plain line before it.
    expect(md.indexOf('Operative part')).toBeLessThan(inMd.at(-1)!.offset);
  });

  it('lands each legacy Markdown heading on its ATX line, past a contents line reading the same', () => {
    const md = htmlToMarkdown(LEGACY_ORDER);
    const headings = parseDocumentStructure('61975CO0054', md, 'markdown', 'EN', LEGACY_ORDER);
    // The contents list renders "Parties" as a plain line before the heading.
    expect(md).toMatch(/^Parties\s*$[\s\S]*^## Parties$/m);
    for (const h of headings) {
      const label = h.kind === 'operative_part' ? 'Operative part' : h.label;
      expect(md.slice(h.offset)).toMatch(new RegExp(`^## ${label}\\n`));
    }
  });

  it('leaves out the <h2> naming a legacy AG opinion, after its <a name="OP"/> anchor', () => {
    expect(AG_OPINION_LEGACY).toContain(
      '<a name="OP"/>\n            <h2 class="rech">Opinion of the Advocate-General</h2>',
    );
    const md = htmlToMarkdown(AG_OPINION_LEGACY);
    expect(md).toContain('## Opinion of the Advocate-General');
    expect(parseDocumentStructure('62006CC0341', AG_OPINION_LEGACY, 'html', 'EN')).toEqual([]);
    expect(parseDocumentStructure('62006CC0341', md, 'markdown', 'EN', AG_OPINION_LEGACY)).toEqual(
      [],
    );
    // Without the anchor, the same <h2> is an ordinary section heading.
    const unanchored = AG_OPINION_LEGACY.replace('<a name="OP"/>', '');
    expect(entries(parseDocumentStructure('62006CC0341', unanchored, 'html', 'EN'))).toEqual(
      outline(['Opinion of the Advocate-General'], false),
    );
  });

  it('never lists the document header lines as headings', () => {
    const judgment = parseDocumentStructure('62019CJ0311', JUDGMENT_COJ, 'html', 'EN');
    const opinion = parseDocumentStructure('62023CC0135', AG_OPINION_COJ, 'html', 'EN');
    const labels = [...judgment, ...opinion].map((h) => h.label);
    for (const header of [
      'JUDGMENT OF THE COURT (Fourth Chamber)',
      'Judgment',
      'OPINION OF ADVOCATE GENERAL',
      'SZPUNAR',
    ]) {
      expect(JUDGMENT_COJ + AG_OPINION_COJ).toContain(header);
      expect(labels).not.toContain(header);
    }
    expect(labels.some((l) => /3 December 2020|delivered on/.test(l))).toBe(false);
    // An opinion's first heading, before its point 1, is a section, not a title.
    expect(opinion[0]?.label).toBe('Introduction');
  });

  it('gives an AG opinion no operative part, even over a paragraph opening with the formula', () => {
    const html = `${AG_OPINION_COJ}<p class="coj-normal">On those grounds, I propose that the Court answer:</p>`;
    expect(
      parseDocumentStructure('62023CC0135', html, 'html', 'EN').some(
        (h) => h.kind === 'operative_part',
      ),
    ).toBe(false);
  });

  it('reads the formula in the language served', () => {
    const french = parseDocumentStructure('62012CJ0131', JUDGMENT_CONVEX_FR, 'html', 'EN');
    expect(french.some((h) => h.kind === 'operative_part')).toBe(false);
    const upper =
      '<p class="title-grseq-2">Costs</p>\n<p>ON THOSE GROUNDS, THE COURT hereby rules:</p>';
    expect(entries(parseDocumentStructure('61975CJ0001', upper, 'html', 'EN'))).toEqual(
      outline(['Costs'], true),
    );
    const glued = '<p class="title-grseq-2">Costs</p>\n<p>On those groundsless words</p>';
    expect(entries(parseDocumentStructure('61975CJ0001', glued, 'html', 'EN'))).toEqual(
      outline(['Costs'], false),
    );
  });

  it('takes a Dutch paragraph for the ruling only when it names the court, the verb, and a colon', () => {
    const grounds =
      '<p class="coj-sum-title-1"><span class="coj-bold">Kosten</span></p>\n<p>Het Hof heeft reeds geoordeeld dat die regeling verenigbaar is.</p>';
    expect(entries(parseDocumentStructure('62019CJ0311', grounds, 'html', 'NL'))).toEqual(
      outline(['Kosten'], false),
    );
    const order = `${grounds}\n<p>De vicepresident van het Hof beschikt:</p>`;
    expect(entries(parseDocumentStructure('62023CO0141', order, 'html', 'NL'))).toEqual(
      outline(['Kosten'], true),
    );
  });

  it.each([
    'Slijedom navedenoga, Sud (veliko vijeće) odlučuje:',
    'Slijedom navedenog, Sud (deseto vijeće) odlučuje:',
  ])('takes the Croatian ruling with or without the final vowel: %s', (ruling) => {
    const html = `<p class="coj-sum-title-1"><span class="coj-bold">Troškovi</span></p>\n<p>${ruling}</p>`;
    expect(entries(parseDocumentStructure('62018CJ0311', html, 'html', 'HR'))).toEqual(
      outline(['Troškovi'], true),
    );
  });

  it('bounds the Dutch formula on a long paragraph with no period', { timeout: 30_000 }, () => {
    // A quadratic pattern takes ~1.9 s on this paragraph; the bound is over 10x below that.
    const paragraph = `<p>Het Hof ${'verklaart '.repeat(12_600)}</p>`;
    let best = Number.POSITIVE_INFINITY;
    for (let round = 0; round < 3 && best >= 150; round++) {
      const start = performance.now();
      parseDocumentStructure('62019CJ0311', paragraph, 'html', 'NL');
      best = Math.min(best, performance.now() - start);
    }
    expect(best).toBeLessThan(150);
  });

  describe('a judgment quoting the formula before its ruling', () => {
    const html = [
      '<p class="title-grseq-2">Grounds</p>',
      '<p>On those grounds, the Court held in its earlier judgment that the measure was lawful.</p>',
      '<p class="title-grseq-2">Costs</p>',
      '<p>Since these proceedings are, for the parties, a step in the action pending before the court.</p>',
      '<p>On those grounds, the Court hereby rules:</p>',
      '<p>1. The measure is valid.</p>',
    ].join('\n');
    const ruling = 'On those grounds, the Court hereby rules:';

    it('opens the operative part at the last paragraph opening with the formula', () => {
      const headings = parseDocumentStructure('62012CJ0131', html, 'html', 'EN');
      expect(entries(headings)).toEqual(outline(['Grounds', 'Costs'], true));
      expect(html.slice(headings.at(-1)!.offset)).toMatch(new RegExp(`^<p>${ruling}`));
    });

    it('does the same in Markdown, with and without its source HTML', () => {
      const md = htmlToMarkdown(html);
      const withSource = parseDocumentStructure('62012CJ0131', md, 'markdown', 'EN', html);
      expect(entries(withSource)).toEqual(outline(['Grounds', 'Costs'], true));
      const alone = parseDocumentStructure('62012CJ0131', md, 'markdown', 'EN');
      expect(entries(alone)).toEqual(outline([], true));
      for (const headings of [withSource, alone]) {
        expect(md.slice(headings.at(-1)!.offset)).toMatch(new RegExp(`^${ruling}`));
      }
    });
  });

  it('anchors a heading on a CRLF line at the start of that line', () => {
    const html =
      '<body>\r\n      <p class="title-grseq-2">\r\n         <span class="bold">Costs</span>\r\n      </p>\r\n';
    const [costs] = parseDocumentStructure('62012CJ0131', html, 'html', 'EN');
    expect(costs?.offset).toBe(html.indexOf('      <p'));
  });

  it('reads a Markdown body with no source HTML for its operative part alone', () => {
    const md = htmlToMarkdown(JUDGMENT_CONVEX_EN);
    const headings = parseDocumentStructure('62012CJ0131', md, 'markdown', 'EN');
    expect(entries(headings)).toEqual(outline([], true));
    expect(md.slice(headings[0]!.offset)).toMatch(/^On those grounds, the Court \(Grand Chamber\)/);
  });

  it('gives the Formex body the html outline, at its <GR.SEQ LEVEL="2"> and <JURISDICTION>', () => {
    const headings = parseDocumentStructure('62012CJ0131', JUDGMENT_FORMEX, 'xml', 'EN');
    expect(entries(headings)).toEqual(outline(GOOGLE_SPAIN_EN, true));
    for (const h of headings.slice(0, -1)) {
      expect(JUDGMENT_FORMEX.slice(h.offset)).toMatch(/^<GR\.SEQ LEVEL="2">/);
    }
    expect(JUDGMENT_FORMEX.slice(headings.at(-1)!.offset)).toMatch(/^<JURISDICTION>/);
    // The document's own LEVEL="1" "Judgment" is not a section.
    expect(JUDGMENT_FORMEX).toContain('<GR.SEQ LEVEL="1"><TITLE><TI><P><HT TYPE="BOLD">Judgment');
  });

  it('reads an act with the act parser, whatever its body says', () => {
    const act = actHtml(AI_ACT_HEADINGS.EN);
    expect(parseDocumentStructure('32024R1689', act, 'html', 'EN')).toEqual(
      parseActStructure(act, 'html', 'EN'),
    );
    expect(parseDocumentStructure('32024R1689', JUDGMENT_CONVEX_EN, 'html', 'EN')).toEqual([]);
  });

  it('stays linear on unclosed heading openers', () => {
    const text = '<p class="title-grseq-2"><h2>'.repeat(4000);
    let best = Number.POSITIVE_INFINITY;
    for (let round = 0; round < 5; round++) {
      const start = performance.now();
      parseDocumentStructure('62012CJ0131', text, 'html', 'EN');
      best = Math.min(best, performance.now() - start);
    }
    expect(best).toBeLessThan(20);
  });
});

describe('case-law selection (#117)', () => {
  const html = JUDGMENT_CONVEX_EN;
  const headings = parseDocumentStructure('62012CJ0131', html, 'html', 'EN');

  it('returns the ruling alone, from its formula to the end, without the costs paragraph', () => {
    const result = extractSections(html, headings, { operative_part: true }, 'EN');
    expect(result).toMatchObject({
      requested: ['Operative part'],
      matched: ['Operative part'],
      missed: [],
    });
    expect(result.text).toContain('On those grounds, the Court (Grand Chamber) hereby rules:');
    expect(result.text).toContain('of Directive 95/46/EC of the European Parliament');
    expect(result.text).not.toContain('Since these proceedings');
    expect(result.sections[0]!.offset + result.sections[0]!.chars).toBe(html.length);
  });

  it('ends a headed section at the next heading', () => {
    const result = extractSections(html, headings, { headings: '2' }, 'EN');
    expect(result).toMatchObject({
      requested: ['Heading 2'],
      matched: [GOOGLE_SPAIN_EN[1]],
      missed: [],
    });
    expect(result.text).toContain('The dispute in the main proceedings');
    expect(result.text).not.toContain('Consideration of the questions referred');
  });

  it('ends the last headed section at the operative part', () => {
    const result = extractSections(html, headings, { headings: '4' }, 'EN');
    expect(result.text).toContain('Since these proceedings');
    expect(result.text).not.toContain('On those grounds');
  });

  it('selects the same sections from the Markdown body', () => {
    const md = htmlToMarkdown(html);
    const inMd = parseDocumentStructure('62012CJ0131', md, 'markdown', 'EN', html);
    const result = extractSections(md, inMd, { headings: '2,4', operative_part: true }, 'EN');
    expect(result.matched).toEqual([GOOGLE_SPAIN_EN[1], 'Costs', 'Operative part']);
    expect(result.text).not.toContain('Consideration of the questions referred');
    expect(result.text).toMatch(/Costs\n\n100 Since these proceedings[\s\S]*\n\nOn those grounds/);
  });

  it('reports a heading past the last and an absent operative part as misses', () => {
    const result = extractSections(html, headings, { headings: '9' }, 'EN');
    expect(result).toMatchObject({ matched: [], missed: ['Heading 9'], text: '' });
    const opinion = parseDocumentStructure('62023CC0135', AG_OPINION_COJ, 'html', 'EN');
    expect(extractSections(AG_OPINION_COJ, opinion, { operative_part: true }, 'EN')).toMatchObject({
      matched: [],
      missed: ['Operative part'],
      text: '',
    });
  });

  it('leaves the act selectors to act headings', () => {
    const result = extractSections(html, headings, { articles: '1', operative_part: false }, 'EN');
    expect(result).toMatchObject({ requested: ['Article 1'], matched: [], missed: ['Article 1'] });
  });
});
