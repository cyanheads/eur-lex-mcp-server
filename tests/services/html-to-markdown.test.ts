/**
 * @fileoverview Tests for server-side HTML→Markdown conversion of EU act bodies
 * (issue #13). Verifies the core craft requirement: numbering layout tables flatten
 * to readable inline-marked text, genuine data tables convert to GFM, nesting is
 * handled, chrome is stripped, and no raw HTML leaks. Fixture-driven, no network.
 * @module tests/services/html-to-markdown.test
 */

import { describe, expect, it } from 'vitest';
import { htmlToMarkdown } from '@/services/eurlex-content/html-to-markdown.js';
import { ACT_XHTML, NESTED_TABLE_XHTML } from '../fixtures/eurlex-act-html.js';

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
