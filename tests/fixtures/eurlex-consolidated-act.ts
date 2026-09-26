/**
 * @fileoverview A consolidated-text act body (#120). EUR-Lex consolidated versions
 * (`0YYYYTNNNN-YYYYMMDD`) lay points out as CSS-grid divs rather than the OJ
 * numbering tables: a paragraph number is a `span.no-parag` before a
 * `div.norm.inline-element` holding a `<p>` or bare text, and each point is a
 * `div.grid-container.grid-list` row with its label in `.grid-list-column-1` and its
 * text — a `<p>`, a `<div class="list">`, or prose followed by nested rows — in
 * `.grid-list-column-2`. Mirrors `02016R0679-20160504`, abridged; NOT live content.
 * @module tests/fixtures/eurlex-consolidated-act
 */

/** One grid-list row: the label cell, then the text cell's inner HTML. */
const row = (label: string, text: string) =>
  [
    '<div class="grid-container grid-list">',
    '   <div class="list grid-list-column-1">',
    `      <span>${label} </span>`,
    '   </div>',
    '   <div class="grid-list-column-2">',
    `      ${text}`,
    '   </div>',
    '</div>',
  ].join('\n');

/** A consolidated body: bare-text and `<p>` paragraph numbers, `<p>`, `div.list`, and nested rows. */
export const CONSOLIDATED_ACT_HTML = [
  '<html><head><title>02016R0679-20160504</title></head><body>',
  '<div class="eli-subdivision" id="art_1">',
  '   <p class="title-article-norm">Article 1</p>',
  '   <div class="eli-title"><p class="stitle-article-norm">Subject-matter and objectives</p></div>',
  '   <div class="norm">',
  '      <span class="no-parag">1.  </span>',
  '      <div class="norm inline-element">This Regulation lays down rules relating to the protection of natural persons.</div>',
  '   </div>',
  '</div>',
  '<div class="eli-subdivision" id="art_30">',
  '   <p class="title-article-norm">Article 30</p>',
  '   <div class="eli-title"><p class="stitle-article-norm">Records of processing activities</p></div>',
  '   <div class="norm">',
  '      <span class="no-parag">1.  </span>',
  '      <div class="norm inline-element">',
  '         <p class="norm inline-element">Each controller shall maintain a record of processing activities.</p>',
  row('(a)', '<p class="norm">the name and contact details of the controller;</p>'),
  row(
    '(b)',
    [
      '<p class="norm">the purposes of the processing, including:</p>',
      row('(i)', '<p class="norm">the first purpose;</p>'),
      row('(ii)', '<p class="norm">the second purpose;</p>'),
    ].join('\n'),
  ),
  '      </div>',
  '   </div>',
  '   <div class="norm">',
  '      <span class="no-parag">2.  </span>',
  '      <div class="norm inline-element">',
  '         <p class="norm inline-element">Members shall be appointed by:</p>',
  row('—', '<div class="list">their parliament;</div>'),
  row('—', '<div class="list">their government.</div>'),
  '      </div>',
  '   </div>',
  '</div>',
  '</body></html>',
].join('\n');
