/**
 * @fileoverview Representative EUR-Lex/CELLAR CONVEX XHTML fragments for testing
 * server-side HTML→Markdown conversion (issue #13). Mirrors the real document
 * structure: a masthead table, recitals and article paragraphs laid out in 4%/96%
 * numbering tables, a genuine data table tagged `class="oj-table"`, a genuine table
 * nested inside a numbered point, and a footnote-reference anchor. NOT live content.
 * @module tests/fixtures/eurlex-act-html
 */

/**
 * A small but structurally faithful act body: OJ masthead + title + two recitals +
 * an article paragraph (all numbering layout tables) + a genuine `oj-table` data
 * table, plus a `<head>`/`<style>` and a footnote-reference anchor to be stripped.
 */
export const ACT_XHTML = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <title>L_2016119EN.01000101.xml</title>
  <style>.oj-normal{font-size:10pt}</style>
</head>
<body>
  <table width="100%" border="0"><col width="10%"/><col width="10%"/><col width="60%"/><col width="20%"/>
    <tbody><tr>
      <td><p class="oj-hd-date">4.5.2016</p></td>
      <td><p class="oj-hd-lg">EN</p></td>
      <td><p class="oj-hd-ti">Official Journal of the European Union</p></td>
      <td><p class="oj-hd-oj">L 119/1</p></td>
    </tr></tbody>
  </table>
  <hr class="oj-separator"/>
  <p class="oj-doc-ti">REGULATION (EU) 2016/679</p>
  <p class="oj-normal">Having regard to the opinion of the Committee<a id="ntc1" href="#ntr1">(<span class="oj-super">1</span>)</a>,</p>
  <table width="100%" border="0"><col width="4%"/><col width="96%"/>
    <tbody><tr>
      <td valign="top"><p class="oj-normal">(1)</p></td>
      <td valign="top"><p class="oj-normal">The protection of natural persons in relation to the processing of personal data is a fundamental right.</p></td>
    </tr></tbody>
  </table>
  <table width="100%" border="0"><col width="4%"/><col width="96%"/>
    <tbody><tr>
      <td valign="top"><p class="oj-normal">(2)</p></td>
      <td valign="top"><p class="oj-normal">This Regulation respects the fundamental rights and freedoms enshrined in the Charter.</p></td>
    </tr></tbody>
  </table>
  <p class="oj-ti-art">Article 1</p>
  <table width="100%" border="0"><col width="4%"/><col width="96%"/>
    <tbody><tr>
      <td valign="top"><p class="oj-normal">1.</p></td>
      <td valign="top"><p class="oj-normal">This Regulation lays down rules relating to the protection of natural persons.</p></td>
    </tr></tbody>
  </table>
  <table width="100%" border="0" class="oj-table"><col width="50%"/><col width="50%"/>
    <tbody>
      <tr class="oj-table"><td class="oj-table"><p class="oj-tbl-hdr">CN code</p></td><td class="oj-table"><p class="oj-tbl-hdr">Description</p></td></tr>
      <tr class="oj-table"><td class="oj-table"><p class="oj-tbl-txt">0203</p></td><td class="oj-table"><p class="oj-tbl-txt">Meat of swine</p></td></tr>
      <tr class="oj-table"><td class="oj-table"><p class="oj-tbl-txt">0204</p></td><td class="oj-table"><p class="oj-tbl-txt">Meat of sheep or goats</p></td></tr>
    </tbody>
  </table>
</body>
</html>`;

/**
 * A numbered point (`7.`) whose prose cell wraps a genuine `oj-table` — the
 * harder layout-inside-genuine and genuine-inside-layout nesting: the marker must
 * flatten to text while the inner data table survives as GFM.
 */
export const NESTED_TABLE_XHTML = `<html><body>
  <table width="100%" border="0"><col width="4%"/><col width="96%"/>
    <tbody><tr>
      <td valign="top"><p class="oj-normal">7.</p></td>
      <td valign="top">
        <p class="oj-normal">The indication shall be given in the following terms:</p>
        <table width="100%" border="0" class="oj-table"><col width="30%"/><col width="70%"/>
          <tbody>
            <tr class="oj-table"><td class="oj-table"><p class="oj-tbl-hdr">Language</p></td><td class="oj-table"><p class="oj-tbl-hdr">Term</p></td></tr>
            <tr class="oj-table"><td class="oj-table"><p class="oj-tbl-txt">English</p></td><td class="oj-table"><p class="oj-tbl-txt">formed meat</p></td></tr>
          </tbody>
        </table>
      </td>
    </tr></tbody>
  </table>
</body></html>`;
