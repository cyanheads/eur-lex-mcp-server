/**
 * @fileoverview A miniature amending act in the layout CELLAR serves for
 * Regulation (EU) 2015/2120 (`32015R2120`), in CONVEX XHTML and Formex 4: the
 * act's own Articles 1–3 and annex, where Article 2 inserts Articles 6a/6b and
 * replaces a Section 4 holding Article 19 in another act. CONVEX lays each
 * amending point out as a 4%/96% numbering table and puts the quoted headings in
 * its cells (a nested point one table deeper); Formex wraps the quoted structure in
 * `<QUOT.S>`. Recitals sit in numbering tables too, as in every CONVEX act. Body
 * lines are unique so a selection's text shows which sections it spans. Trimmed
 * by hand from the live markup, not a network snapshot. {@link CRR2_EXCERPT_HTML}
 * keeps the live `32019R0876` markup of a quoted heading whose opening mark sits
 * on a line of its own.
 * @module tests/fixtures/eurlex-amending-act
 */

/** One CONVEX numbering-table row: the point marker beside its content lines. */
function numberingTable(marker: string, content: string[]): string[] {
  return [
    '<table width="100%" border="0" cellspacing="0" cellpadding="0">',
    '<col width="4%"/>',
    '<col width="96%"/>',
    '<tbody>',
    '<tr>',
    '<td valign="top">',
    `<p class="oj-normal">${marker}</p>`,
    '</td>',
    '<td valign="top">',
    ...content,
    '</td>',
    '</tr>',
    '</tbody>',
    '</table>',
  ];
}

export const AMENDING_HTML = [
  '<html><body>',
  '<p class="oj-doc-ti">REGULATION (EU) 2015/2120</p>',
  ...numberingTable('(1)', ['<p class="oj-normal">Recital one.</p>']),
  ...numberingTable('(2)', ['<p class="oj-normal">Recital two.</p>']),
  '<p class="oj-ti-art">Article 1</p>',
  '<p class="oj-sti-art">Subject matter</p>',
  '<p class="oj-normal">Body one.</p>',
  '<p class="oj-ti-art">Article 2</p>',
  '<p class="oj-sti-art">Amendments to Regulation (EU) No 531/2012</p>',
  '<p class="oj-normal">Regulation (EU) No 531/2012 is amended as follows:</p>',
  ...numberingTable('(1)', [
    '<p class="oj-normal">the following Articles are inserted:</p>',
    '<div id="006A">',
    '<p class="oj-ti-art">‘Article 6a</p>',
    '<p class="oj-sti-art">Abolition of retail roaming surcharges</p>',
    '<p class="oj-normal">Quoted six a.</p>',
    '</div>',
    '<div id="006B">',
    '<p class="oj-ti-art">Article 6b</p>',
    '<p class="oj-sti-art">Fair use</p>',
    '<p class="oj-normal">Quoted six b.</p>',
    '</div>',
  ]),
  ...numberingTable('(2)', [
    '<p class="oj-normal">Section 4 is amended as follows:</p>',
    ...numberingTable('(a)', ['<p class="oj-normal">the heading is replaced:</p>']),
    '<p class="oj-ti-section-1">',
    '<span class="oj-italic">SECTION 4</span>',
    '</p>',
    '<p class="oj-ti-section-2">Final provisions</p>',
    '<p class="oj-ti-art">Article 19</p>',
    '<p class="oj-sti-art">Review</p>',
    '<p class="oj-normal">Quoted nineteen.</p>',
    '<p class="oj-doc-ti">ANNEX II</p>',
    '<p class="oj-normal">Quoted annex.’</p>',
  ]),
  '<p class="oj-normal">Amending article tail.</p>',
  '<p class="oj-ti-art">Article 3</p>',
  '<p class="oj-sti-art">Entry into force</p>',
  '<p class="oj-normal">Body three.</p>',
  '<p class="oj-doc-ti">ANNEX</p>',
  '<p class="oj-normal">Annex body.</p>',
  '</body></html>',
].join('\n');

/**
 * An excerpt of Regulation (EU) 2019/876 (`32019R0876`, CRR2) as CONVEX serves it:
 * its own Articles 1 and 2, where Article 1 replaces Articles 1 and 2 and Section 3
 * of Regulation (EU) No 575/2013. The markup is the live markup, cut down to the
 * headings and a line of text each: the quoted `‘Article 1` carries its mark on
 * the heading line, while the quoted Section 3 carries it on a line of its own, so
 * the HTML detects that heading and its Markdown rendering (`‘ Section 3`) does
 * not. Heading words and numbers are joined by a no-break space, as in the source.
 */
export const CRR2_EXCERPT_HTML = [
  '<div class="eli-subdivision" id="art_1">',
  '<p id="d1e710-1-1" class="oj-ti-art">Article 1</p>',
  '<div class="eli-title" id="art_1.tit_1">',
  '<p class="oj-sti-art">Amendments to Regulation (EU) No 575/2013</p>',
  '</div>',
  '<p class="oj-normal">Regulation (EU) No 575/2013 is amended as follows:</p>',
  ...numberingTable('(1)', [
    '<p class="oj-normal">Articles 1 and 2 are replaced by the following:</p>',
    '<div id="001">',
    '<p id="d1e727-1-1" class="oj-ti-art">‘Article 1</p>',
    '<p class="oj-sti-art">Scope</p>',
    '<p class="oj-normal">This Regulation lays down uniform rules.</p>',
    '</div>',
    '<div id="002">',
    '<p id="d1e771-1-1" class="oj-ti-art">Article 2</p>',
    '<p class="oj-sti-art">Supervisory powers</p>',
    '<p class="oj-normal">1.   For the purpose of ensuring compliance with this Regulation.’;</p>',
    '</div>',
  ]),
  ...numberingTable('(74)', [
    '<p class="oj-normal">in Chapter 6 of Title II of Part Three, Sections 3, 4 and 5 are replaced by the following:</p>',
    '<div id="sct_3">',
    '<p id="d1e6999-1-1" class="oj-ti-section-1">',
    '‘',
    '<span class="oj-expanded">Section 3</span>',
    '</p>',
    '<div class="eli-title" id="sct_3.tit_1">',
    '<p id="L_2019150EN.01000101-d-005" class="oj-ti-section-2">',
    '<span class="oj-bold">',
    '<span class="oj-expanded">Standardised approach for counterparty credit risk</span>',
    '</span>',
    '</p>',
    '</div>',
    '<div id="274">',
    '<p id="d1e7010-1-1" class="oj-ti-art">Article 274</p>',
    '<p class="oj-sti-art">Exposure value</p>',
    '<p class="oj-normal">1.   An institution may calculate a single exposure value.’;</p>',
    '</div>',
    '</div>',
  ]),
  '</div>',
  '<div class="eli-subdivision" id="art_2">',
  '<p id="d1e28023-1-1" class="oj-ti-art">Article 2</p>',
  '<div class="eli-title" id="art_2.tit_1">',
  '<p class="oj-sti-art">Amendments to Regulation (EU) No 648/2012</p>',
  '</div>',
  '<p class="oj-normal">Regulation (EU) No 648/2012 is amended as follows:</p>',
  '</div>',
].join('\n');

const quoteStart = (id: string) => `<QUOT.START CODE="2018" ID="${id}" REF.END="${id}"/>`;

export const AMENDING_FORMEX = [
  '<ACT><PREAMBLE><GR.CONSID>',
  '<CONSID><NP><NO.P>(1)</NO.P><TXT>Recital one.</TXT></NP></CONSID>',
  '<CONSID><NP><NO.P>(2)</NO.P><TXT>Recital two.</TXT></NP></CONSID>',
  '</GR.CONSID></PREAMBLE><ENACTING.TERMS>',
  '<ARTICLE IDENTIFIER="001"><TI.ART>Article 1</TI.ART><STI.ART>Subject matter</STI.ART><ALINEA>Body one.</ALINEA></ARTICLE>',
  '<ARTICLE IDENTIFIER="002"><TI.ART>Article 2</TI.ART><STI.ART>Amendments to Regulation (EU) No 531/2012</STI.ART>',
  '<ALINEA><P>Regulation (EU) No 531/2012 is amended as follows:</P><LIST TYPE="ARAB">',
  '<ITEM><NP><NO.P>(1)</NO.P><TXT>the following Articles are inserted:</TXT><P><QUOT.S LEVEL="1">',
  `<ARTICLE IDENTIFIER="006A"><TI.ART>${quoteStart('QS1')}Article 6a</TI.ART><STI.ART>Abolition of retail roaming surcharges</STI.ART><ALINEA>Quoted six a.</ALINEA></ARTICLE>`,
  '<ARTICLE IDENTIFIER="006B"><TI.ART>Article 6b</TI.ART><STI.ART>Fair use</STI.ART><ALINEA>Quoted six b.</ALINEA></ARTICLE>',
  '</QUOT.S></P></NP></ITEM>',
  '<ITEM><NP><NO.P>(2)</NO.P><TXT>Section 4 is replaced by the following:</TXT><P><QUOT.S LEVEL="1">',
  `<P>${quoteStart('QS2')}In point (a), the words <QUOT.S LEVEL="2"><P>“Member State”</P></QUOT.S> are replaced.</P>`,
  '<DIVISION><TITLE><TI><P><HT TYPE="EXPANDED">Section 4</HT></P></TI><STI><P>Final provisions</P></STI></TITLE>',
  '<ARTICLE IDENTIFIER="019"><TI.ART>Article 19</TI.ART><STI.ART>Review</STI.ART><ALINEA>Quoted nineteen.</ALINEA></ARTICLE>',
  '</DIVISION></QUOT.S></P></NP></ITEM>',
  '</LIST><P>Amending article tail.</P></ALINEA></ARTICLE>',
  '<ARTICLE IDENTIFIER="003"><TI.ART>Article 3</TI.ART><STI.ART>Entry into force</STI.ART><ALINEA>Body three.</ALINEA></ARTICLE>',
  '</ENACTING.TERMS></ACT>',
].join('');
