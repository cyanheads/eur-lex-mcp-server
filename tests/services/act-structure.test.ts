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
  });

  it('tolerates selector tokens that carry the kind word (e.g. "Article 1")', () => {
    const result = extractSections(html, headings, { articles: 'Article 1' });
    expect(result.matched).toEqual(['Article 1']);
  });
});
