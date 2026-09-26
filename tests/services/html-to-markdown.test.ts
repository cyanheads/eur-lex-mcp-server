/**
 * @fileoverview Tests for server-side HTML→Markdown conversion of EU act bodies
 * (issue #13). Verifies the core craft requirement: numbering layout tables flatten
 * to readable inline-marked text, genuine data tables convert to GFM, nesting is
 * handled, chrome is stripped, and no raw HTML leaks; that no single
 * node-html-markdown call receives a whole act body (#127); and every act
 * fixture's output, pinned by snapshot. Fixture-driven, no network.
 * @module tests/services/html-to-markdown.test
 */

import { NodeHtmlMarkdown } from 'node-html-markdown';
import { describe, expect, it, vi } from 'vitest';
import { htmlToMarkdown } from '@/services/eurlex-content/html-to-markdown.js';
import { AI_ACT_HEADINGS, actHtml } from '../fixtures/eurlex-act-headings.js';
import { ACT_XHTML, NESTED_TABLE_XHTML } from '../fixtures/eurlex-act-html.js';
import { AMENDING_HTML, CRR2_EXCERPT_HTML } from '../fixtures/eurlex-amending-act.js';
import { CONSOLIDATED_ACT_HTML } from '../fixtures/eurlex-consolidated-act.js';
import { LEGACY_ACT_HTML } from '../fixtures/eurlex-legacy-act.js';

describe('htmlToMarkdown', () => {
  const md = htmlToMarkdown(ACT_XHTML);

  it('leaks no raw HTML for layout content (no <table>/<div>/<td>/<tr>/<p>)', () => {
    expect(md).not.toMatch(/<table|<div|<td|<tr|<p[ >]|<\/p>/i);
  });

  it('flattens recital numbering tables to inline-marked text, not 2-column GFM rows', () => {
    expect(md).toContain('(1) The protection of natural persons');
    expect(md).toContain('(2) This Regulation respects the fundamental rights');
    // The recital marker must NOT have become its own GFM table cell.
    expect(md).not.toMatch(/\|\s*\(1\)\s*\|/);
  });

  it('renders article numbered paragraphs as readable text (digit-dot escaped, not a list)', () => {
    // node-html-markdown escapes "1." → "1\." so legal paragraph numbers are not
    // re-numbered as a Markdown ordered list; either form is acceptable here.
    expect(md).toMatch(/1\\?\.\s+This Regulation lays down rules/);
  });

  it('converts genuine oj-table data tables to GFM tables (header + separator + rows)', () => {
    expect(md).toMatch(/\|\s*CN code\s*\|\s*Description\s*\|/);
    expect(md).toMatch(/\|\s*-+\s*\|\s*-+\s*\|/);
    expect(md).toContain('0203');
    expect(md).toContain('Meat of swine');
  });

  it('strips chrome: the masthead table, inline <style>, and the document <head>', () => {
    expect(md).not.toContain('Official Journal of the European Union');
    expect(md).not.toContain('font-size');
    expect(md).not.toContain('L_2016119EN');
  });

  it('neutralizes intra-document fragment anchors to plain text (no dead links)', () => {
    expect(md).not.toContain('](#');
    expect(md).not.toContain('ntr1');
    // The visible footnote marker text survives the anchor unwrap.
    expect(md).toMatch(/Committee\s*\(1\)/);
  });

  it('keeps a genuine table nested inside a numbered point as GFM while flattening the marker', () => {
    const nested = htmlToMarkdown(NESTED_TABLE_XHTML);
    expect(nested).toMatch(/7\\?\.\s+The indication shall be given in the following terms:/);
    expect(nested).toMatch(/\|\s*Language\s*\|\s*Term\s*\|/);
    expect(nested).toContain('formed meat');
    expect(nested).not.toMatch(/<table|<td|<div|<tr/i);
  });

  it('returns an empty string for empty input', () => {
    expect(htmlToMarkdown('')).toBe('');
  });
});

describe('block-by-block translation (#127)', () => {
  /** Every input node-html-markdown receives during one conversion. */
  const translateInputs = (html: string) => {
    const spy = vi.spyOn(NodeHtmlMarkdown.prototype, 'translate');
    try {
      const md = htmlToMarkdown(html);
      return { md, inputs: spy.mock.calls.map(([input]) => String(input)) };
    } finally {
      spy.mockRestore();
    }
  };

  it.each([
    ['OJ act', actHtml(AI_ACT_HEADINGS.EN), 'REGULATION (EU) 2024/1689', 'Annex body.'],
    ['consolidated act', CONSOLIDATED_ACT_HTML, 'Article 1', 'their government.'],
    ['legacy text/html act', LEGACY_ACT_HTML, '31995L0046', '"Mere conduit"'],
    // A flattened numbering table is descended into like any other division.
    ['amending point', CRR2_EXCERPT_HTML, 'Articles 1 and 2 are replaced', 'Supervisory powers'],
  ])('never hands node-html-markdown the whole %s body', (_name, html, first, last) => {
    const { md, inputs } = translateInputs(html);
    expect(md).toContain(first);
    expect(md).toContain(last);
    expect(inputs.length).toBeGreaterThan(1);
    expect(inputs.filter((input) => input.includes(first) && input.includes(last))).toEqual([]);
  });

  it('descends through nested divisions to translate each block alone', () => {
    const { md, inputs } = translateInputs(
      '<body><div id="outer"><div id="inner"><p>First.</p><div><p>Second.</p><p>Third.</p></div></div></div></body>',
    );
    expect(md).toBe('First.\n\nSecond.\n\nThird.');
    expect(inputs).toEqual(['<p>First.</p>', '<p>Second.</p>', '<p>Third.</p>']);
  });

  it('keeps inline content beside a block in one paragraph', () => {
    const { md, inputs } = translateInputs(
      '<body><div>Lead <b>bold</b> tail<p>Block.</p>After <i>it</i>.</div></body>',
    );
    expect(md).toBe('Lead **bold** tail\n\nBlock.\n\nAfter _it_.');
    expect(inputs).toEqual(['Lead <b>bold</b> tail', '<p>Block.</p>', 'After <i>it</i>.']);
  });
});

describe('conversion output on every act fixture', () => {
  /** Line-end whitespace and blank-line runs carry no Markdown meaning here. */
  const normalize = (md: string) => md.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n');

  it.each([
    ['OJ act', ACT_XHTML],
    ['nested data table', NESTED_TABLE_XHTML],
    ['consolidated act', CONSOLIDATED_ACT_HTML],
    ['legacy text/html act', LEGACY_ACT_HTML],
    ['amending act', AMENDING_HTML],
    ['CRR2 excerpt', CRR2_EXCERPT_HTML],
    ['AI Act headings (EN)', actHtml(AI_ACT_HEADINGS.EN)],
    ['AI Act headings (HU)', actHtml(AI_ACT_HEADINGS.HU)],
  ])('%s', (_name, html) => {
    expect(normalize(htmlToMarkdown(html))).toMatchSnapshot();
  });
});

describe('OJ CONVEX conversion (#120)', () => {
  it('renders an OJ act byte for byte as before the consolidated-label pass', () => {
    expect(htmlToMarkdown(ACT_XHTML)).toBe(
      [
        'REGULATION (EU) 2016/679',
        'Having regard to the opinion of the Committee(1),',
        '(1) The protection of natural persons in relation to the processing of personal data is a fundamental right.',
        '(2) This Regulation respects the fundamental rights and freedoms enshrined in the Charter.',
        'Article 1',
        '1\\. This Regulation lays down rules relating to the protection of natural persons.',
        [
          '| CN code | Description            |',
          '| ------- | ---------------------- |',
          '| 0203    | Meat of swine          |',
          '| 0204    | Meat of sheep or goats |',
        ].join('\n'),
      ].join('\n\n'),
    );
    expect(htmlToMarkdown(NESTED_TABLE_XHTML)).toBe(
      [
        '7\\. The indication shall be given in the following terms:',
        '',
        '| Language | Term        |',
        '| -------- | ----------- |',
        '| English  | formed meat |',
      ].join('\n'),
    );
  });
});

describe('legacy text/html page chrome (#120)', () => {
  const md = htmlToMarkdown(LEGACY_ACT_HTML);

  it('opens at the CELEX heading, with the legal-notice banner stripped', () => {
    expect(md.startsWith('# 31995L0046\n')).toBe(true);
    expect(md).not.toContain('Avis juridique');
    expect(md).not.toContain('legal%5Fnotice');
    expect(md).not.toContain('_|_');
  });

  it('keeps the title block and the act text after the banner', () => {
    expect(md).toContain('**Directive 95/46/EC of the European Parliament');
    expect(md).toContain('_Official Journal L 281 , 23/11/1995 P. 0031 - 0050_');
    expect(md).toMatch(/\nArticle 2 \n\nDefinitions\n/);
    expect(md).toContain('"Mere conduit"');
  });
});

describe('consolidated-text point labels (#120)', () => {
  const md = htmlToMarkdown(CONSOLIDATED_ACT_HTML);
  const lines = md.split('\n').filter((line) => line.trim() !== '');

  it('joins each paragraph number and point label to the text after it', () => {
    expect(lines).toEqual([
      'Article 1',
      'Subject-matter and objectives',
      '1\\. This Regulation lays down rules relating to the protection of natural persons.',
      'Article 30',
      'Records of processing activities',
      '1\\. Each controller shall maintain a record of processing activities.',
      '(a) the name and contact details of the controller;',
      '(b) the purposes of the processing, including:',
      '(i) the first purpose;',
      '(ii) the second purpose;',
      '2\\. Members shall be appointed by:',
      '— their parliament;',
      '— their government.',
    ]);
  });

  it('leaves no line holding only a label, nested rows included', () => {
    expect(lines.filter((line) => /^(?:\(\w+\)|\d+\\?\.|—)\s*$/.test(line))).toEqual([]);
  });

  it('leaves a grid row without a text cell, and a trailing number, as they were', () => {
    const noText = htmlToMarkdown(
      '<div class="grid-container grid-list"><div class="grid-list-column-1"><span>(a) </span></div></div><p>After.</p>',
    );
    expect(noText).toBe('(a)\n\nAfter.');
    const trailing = htmlToMarkdown('<div class="norm"><span class="no-parag">3. </span></div>');
    expect(trailing).toBe('3\\.');
  });

  it('keeps a number already running into inline text on its line', () => {
    expect(htmlToMarkdown('<p><span class="no-parag">4. </span>Inline text.</p>')).toBe(
      '4\\. Inline text.',
    );
  });

  it('keeps a linked amendment marker in a label, and escapes a numbered label', () => {
    const row = (label: string, text: string) =>
      `<div class="grid-container grid-list"><div class="list grid-list-column-1"><span>${label} </span></div><div class="grid-list-column-2"><p class="norm">${text}</p></div></div>`;
    const md = htmlToMarkdown(
      [
        row('1.', 'the first definition;'),
        row(
          '<span><a href="http://publications.europa.eu/resource/celex/32019R0876">►M8</a> (v)</span>',
          'the amended point.',
        ),
      ].join('\n'),
    );
    expect(md).toBe(
      [
        '1\\. the first definition;',
        '[►M8](http://publications.europa.eu/resource/celex/32019R0876) (v) the amended point.',
      ].join('\n\n'),
    );
  });

  it('escapes a label that reads as markup', () => {
    const md = htmlToMarkdown(
      '<div class="grid-container grid-list"><div class="grid-list-column-1"><span>&lt;b&gt; </span></div><div class="grid-list-column-2"><p>text</p></div></div>',
    );
    expect(md).toBe('<b> text');
  });

  const fill = (unit: string, n: number) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
  const ROW_OPEN =
    '<div class="grid-container grid-list"><div class="grid-list-column-1"><span>(a) </span></div><div class="grid-list-column-2"><p>x</p>';

  it.each([
    [
      'sibling paragraph numbers',
      (n: number) => `<div>${fill('<span class="no-parag">1. </span><div>t</div>', n)}</div>`,
    ],
    ['sibling grid rows', (n: number) => `<div>${fill(`${ROW_OPEN}</div></div>`, n)}</div>`],
    [
      'nested grid rows',
      (n: number) => {
        const depth = Math.floor(n / (ROW_OPEN.length + 12));
        return ROW_OPEN.repeat(depth) + '</div></div>'.repeat(depth);
      },
    ],
  ])('joins labels in linear time: %s', (_label, build) => {
    // Best of seven at 5k, 20k, and 80k characters: linear grows ~16×, quadratic
    // ~256×, so the 80k/5k ratio stays under 64 (5k floored at 0.1 ms), and the 80k
    // conversion stays under an absolute bound.
    const time = (n: number) => {
      const html = build(n);
      let best = Number.POSITIVE_INFINITY;
      for (let round = 0; round < 7; round++) {
        const start = performance.now();
        htmlToMarkdown(html);
        best = Math.min(best, performance.now() - start);
      }
      return best;
    };
    const t5k = time(5_000);
    time(20_000);
    const t80k = time(80_000);
    expect(t80k / Math.max(t5k, 0.1)).toBeLessThan(64);
    expect(t80k).toBeLessThan(100);
  });
});
