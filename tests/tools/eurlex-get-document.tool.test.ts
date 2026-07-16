/**
 * @fileoverview Tests for eurlex_get_document tool.
 * @module tests/tools/eurlex-get-document.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eurlex_get_document } from '@/mcp-server/tools/definitions/eurlex-get-document.tool.js';

// --- Service mocks ---
const mockSparqlQuery = vi.fn();
const mockFetchContent = vi.fn();

vi.mock('@/services/cellar-sparql/cellar-sparql-service.js', () => ({
  getCellarSparqlService: () => ({ query: mockSparqlQuery }),
  CellarSparqlService: {
    bindingValue: (binding: Record<string, { value?: string }> | undefined, field: string) =>
      binding?.[field]?.value,
    parseBoolean: (lexical: string | undefined) =>
      lexical === 'true' || lexical === '1'
        ? true
        : lexical === 'false' || lexical === '0'
          ? false
          : undefined,
  },
}));

vi.mock('@/services/eurlex-content/eurlex-content-service.js', () => ({
  getEurLexContentService: () => ({ fetchContent: mockFetchContent }),
}));

/** Build a metadata binding for a document. */
function makeMetaBinding(opts: {
  celex: string;
  workUri?: string;
  type?: string;
  date?: string;
  title?: string;
  inForce?: string;
  author?: string;
  legalBasis?: string;
  eurovoc?: string;
}): Record<string, { type: string; value: string }> {
  const b: Record<string, { type: string; value: string }> = {
    celexNumber: { type: 'literal', value: opts.celex },
    work: {
      type: 'uri',
      value: opts.workUri ?? `http://publications.europa.eu/resource/cellar/${opts.celex}`,
    },
  };
  if (opts.type) b.type = { type: 'uri', value: opts.type };
  if (opts.date) b.date = { type: 'literal', value: opts.date };
  if (opts.title) b.title = { type: 'literal', value: opts.title };
  if (opts.inForce !== undefined) b.inForce = { type: 'literal', value: opts.inForce };
  if (opts.author) b.author = { type: 'uri', value: opts.author };
  if (opts.legalBasis) b.legalBasis = { type: 'uri', value: opts.legalBasis };
  if (opts.eurovoc) b.eurovoc = { type: 'uri', value: opts.eurovoc };
  return b;
}

describe('eurlex_get_document', () => {
  beforeEach(() => {
    mockSparqlQuery.mockReset();
    mockFetchContent.mockReset();
  });

  // --- Happy path: full metadata + content ---

  it('returns metadata and content for a valid CELEX number', async () => {
    const ctx = createMockContext({ errors: eurlex_get_document.errors });
    mockSparqlQuery.mockResolvedValue([
      makeMetaBinding({
        celex: '32016R0679',
        date: '2016-04-27',
        title: 'General Data Protection Regulation',
        type: 'http://publications.europa.eu/resource/authority/resource-type/REG',
        inForce: 'true',
      }),
    ]);
    mockFetchContent.mockResolvedValue({
      content: '<html>GDPR full text</html>',
      contentAvailable: true,
      format: 'html',
      language: 'EN',
    });

    const input = eurlex_get_document.input.parse({ celex_number: '32016R0679' });
    const result = await eurlex_get_document.handler(input, ctx);

    expect(result.celex_number).toBe('32016R0679');
    expect(result.title).toBe('General Data Protection Regulation');
    expect(result.date).toBe('2016-04-27');
    expect(result.in_force).toBe(true);
    expect(result.content_available).toBe(true);
    expect(result.content).toBe('<html>GDPR full text</html>');
    expect(result.language).toBe('EN');
    expect(result.content_format).toBe('html');
    // Default "paged" mode returns a small body whole, with the navigation floor populated.
    expect(result.content_mode).toBe('paged');
    expect(result.content_chars_total).toBe('<html>GDPR full text</html>'.length);
    expect(result.content_chars_returned).toBe('<html>GDPR full text</html>'.length);
    expect(result.content_offset).toBe(0);
    expect(result.has_more).toBe(false);
  });

  // --- #20: in_force parses CELLAR's xsd:boolean lexical "1"/"0" ---

  it('parses in_force=true from the xsd:boolean lexical "1" and renders it', async () => {
    const ctx = createMockContext({ errors: eurlex_get_document.errors });
    // CELLAR serializes cdm:resource_legal_in-force as the lexical "1", not "true".
    mockSparqlQuery.mockResolvedValue([makeMetaBinding({ celex: '32016R0679', inForce: '1' })]);

    const input = eurlex_get_document.input.parse({
      celex_number: '32016R0679',
      content_mode: 'metadata_only',
    });
    const result = await eurlex_get_document.handler(input, ctx);

    expect(result.in_force).toBe(true);
    // The markdown formatter renders the parsed boolean downstream.
    const text = (eurlex_get_document.format!(result)[0] as { text: string }).text;
    expect(text).toContain('**In Force:** true');
  });

  it('parses in_force=false from the xsd:boolean lexical "0"', async () => {
    const ctx = createMockContext({ errors: eurlex_get_document.errors });
    mockSparqlQuery.mockResolvedValue([makeMetaBinding({ celex: '32014L0000', inForce: '0' })]);

    const input = eurlex_get_document.input.parse({
      celex_number: '32014L0000',
      content_mode: 'metadata_only',
    });
    const result = await eurlex_get_document.handler(input, ctx);

    expect(result.in_force).toBe(false);
  });

  it('aggregates legal_basis and eurovoc_subjects from multi-row result', async () => {
    const ctx = createMockContext({ errors: eurlex_get_document.errors });
    const base = makeMetaBinding({ celex: '32016R0679' });
    mockSparqlQuery.mockResolvedValue([
      {
        ...base,
        legalBasis: { type: 'uri', value: 'http://lb1' },
        eurovoc: { type: 'uri', value: 'http://ev1' },
      },
      {
        ...base,
        legalBasis: { type: 'uri', value: 'http://lb2' },
        eurovoc: { type: 'uri', value: 'http://ev2' },
      },
      // Duplicate — should be deduplicated
      {
        ...base,
        legalBasis: { type: 'uri', value: 'http://lb1' },
        eurovoc: { type: 'uri', value: 'http://ev1' },
      },
    ]);
    mockFetchContent.mockResolvedValue({
      content: '',
      contentAvailable: false,
      format: 'html',
      language: 'EN',
    });

    const input = eurlex_get_document.input.parse({ celex_number: '32016R0679' });
    const result = await eurlex_get_document.handler(input, ctx);

    expect(result.legal_basis).toHaveLength(2);
    expect(result.eurovoc_subjects).toHaveLength(2);
  });

  it('includes language_fallback when content service reports fallback', async () => {
    const ctx = createMockContext({ errors: eurlex_get_document.errors });
    mockSparqlQuery.mockResolvedValue([makeMetaBinding({ celex: '32016R0679' })]);
    mockFetchContent.mockResolvedValue({
      content: '<html>EN fallback</html>',
      contentAvailable: true,
      format: 'html',
      language: 'EN',
      languageFallback: 'Requested language FR unavailable; returned English content.',
    });

    const input = eurlex_get_document.input.parse({ celex_number: '32016R0679', language: 'FR' });
    const result = await eurlex_get_document.handler(input, ctx);

    expect(result.language_fallback).toContain('FR');
    expect(result.language).toBe('EN');
  });

  it('returns content_available: false when content fetch fails', async () => {
    const ctx = createMockContext({ errors: eurlex_get_document.errors });
    mockSparqlQuery.mockResolvedValue([makeMetaBinding({ celex: '32016R0679' })]);
    mockFetchContent.mockResolvedValue({
      content: '',
      contentAvailable: false,
      format: 'html',
      language: 'EN',
    });

    const input = eurlex_get_document.input.parse({ celex_number: '32016R0679' });
    const result = await eurlex_get_document.handler(input, ctx);

    expect(result.content_available).toBe(false);
    expect(result.content).toBeUndefined();
  });

  // --- Title traversal (issue #7) ---

  it('uses the expression-level title traversal, not the obsolete work_title pattern', async () => {
    const ctx = createMockContext({ errors: eurlex_get_document.errors });
    mockSparqlQuery.mockResolvedValue([
      makeMetaBinding({ celex: '32016R0679', title: 'General Data Protection Regulation' }),
    ]);
    mockFetchContent.mockResolvedValue({
      content: '',
      contentAvailable: false,
      format: 'html',
      language: 'EN',
    });

    const input = eurlex_get_document.input.parse({ celex_number: '32016R0679' });
    const result = await eurlex_get_document.handler(input, ctx);

    // Title from the English expression is surfaced.
    expect(result.title).toBe('General Data Protection Regulation');
    const sparql = mockSparqlQuery.mock.calls[0]?.[0] as string;
    expect(sparql).toContain('cdm:expression_belongs_to_work');
    expect(sparql).toContain('cdm:expression_title');
    // Obsolete work-level pattern must be gone.
    expect(sparql).not.toContain('cdm:work_title');
  });

  // --- ELI URI alternative (issue #8) ---

  it('resolves an eli_uri to the same document as the equivalent CELEX', async () => {
    const ctx = createMockContext({ errors: eurlex_get_document.errors });
    // First query: ELI → work resolution (yields GDPR's work + CELEX).
    // Remaining queries (core metadata + per-dimension + staleness) all key off
    // the resolved CELEX; the shared default binding carries no consolidatedCelex,
    // so the staleness probe cleanly yields nothing.
    mockSparqlQuery
      .mockResolvedValueOnce([makeMetaBinding({ celex: '32016R0679' })])
      .mockResolvedValue([
        makeMetaBinding({
          celex: '32016R0679',
          date: '2016-04-27',
          title: 'General Data Protection Regulation',
          type: 'http://publications.europa.eu/resource/authority/resource-type/REG',
          inForce: 'true',
        }),
      ]);
    mockFetchContent.mockResolvedValue({
      content: '<html>GDPR full text</html>',
      contentAvailable: true,
      format: 'html',
      language: 'EN',
    });

    const input = eurlex_get_document.input.parse({
      eli_uri: 'http://data.europa.eu/eli/reg/2016/679/oj',
    });
    const result = await eurlex_get_document.handler(input, ctx);

    // Same work as the celex_number: '32016R0679' path.
    expect(result.celex_number).toBe('32016R0679');
    expect(result.title).toBe('General Data Protection Regulation');
    expect(result.content).toBe('<html>GDPR full text</html>');

    // First call exact-matches the ELI literal; content is fetched by the resolved CELEX.
    const eliSparql = mockSparqlQuery.mock.calls[0]?.[0] as string;
    expect(eliSparql).toContain('cdm:resource_legal_eli');
    expect(eliSparql).toContain('"http://data.europa.eu/eli/reg/2016/679/oj"^^xsd:anyURI');
    expect(mockFetchContent).toHaveBeenCalledWith('32016R0679', 'EN', 'html', expect.anything());
  });

  it('throws ctx.fail("not_found") when an eli_uri resolves to no work', async () => {
    const ctx = createMockContext({ errors: eurlex_get_document.errors });
    mockSparqlQuery.mockResolvedValue([]);

    const input = eurlex_get_document.input.parse({
      eli_uri: 'http://data.europa.eu/eli/reg/9999/99999/oj',
    });
    await expect(eurlex_get_document.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'not_found' },
    });
  });

  // --- Input guard: exactly one identifier (issue #8) ---

  it('throws ctx.fail("invalid_identifier_args") when neither celex_number nor eli_uri is given', async () => {
    const ctx = createMockContext({ errors: eurlex_get_document.errors });
    const input = eurlex_get_document.input.parse({});
    await expect(eurlex_get_document.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_identifier_args' },
    });
    expect(mockSparqlQuery).not.toHaveBeenCalled();
  });

  it('throws ctx.fail("invalid_identifier_args") when both celex_number and eli_uri are given', async () => {
    const ctx = createMockContext({ errors: eurlex_get_document.errors });
    const input = eurlex_get_document.input.parse({
      celex_number: '32016R0679',
      eli_uri: 'http://data.europa.eu/eli/reg/2016/679/oj',
    });
    await expect(eurlex_get_document.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_identifier_args' },
    });
    expect(mockSparqlQuery).not.toHaveBeenCalled();
  });

  // --- Error contract: not_found ---

  it('throws ctx.fail("not_found") when CELEX resolves to no bindings', async () => {
    const ctx = createMockContext({ errors: eurlex_get_document.errors });
    mockSparqlQuery.mockResolvedValue([]);

    const input = eurlex_get_document.input.parse({ celex_number: '99999X0000' });
    await expect(eurlex_get_document.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'not_found' },
    });
  });

  // --- Content shaping floor (issue #12) ---

  it('content_mode "metadata_only" returns metadata with no body and skips the content fetch', async () => {
    const ctx = createMockContext({ errors: eurlex_get_document.errors });
    mockSparqlQuery.mockResolvedValue([
      makeMetaBinding({ celex: '32016R0679', title: 'GDPR', date: '2016-04-27' }),
    ]);

    const input = eurlex_get_document.input.parse({
      celex_number: '32016R0679',
      content_mode: 'metadata_only',
    });
    const result = await eurlex_get_document.handler(input, ctx);

    expect(result.title).toBe('GDPR');
    expect(result.content_mode).toBe('metadata_only');
    expect(result.content).toBeUndefined();
    expect(result.content_available).toBe(false);
    expect(result.has_more).toBe(false);
    expect(result.content_chars_total).toBeUndefined();
    // No body fetch is attempted — the whole point of metadata_only.
    expect(mockFetchContent).not.toHaveBeenCalled();
  });

  it('content_mode "full" returns the entire body with content_chars_total set and has_more false', async () => {
    const ctx = createMockContext({ errors: eurlex_get_document.errors });
    const body = 'A'.repeat(50_000);
    mockSparqlQuery.mockResolvedValue([makeMetaBinding({ celex: '32016R0679' })]);
    mockFetchContent.mockResolvedValue({
      content: body,
      contentAvailable: true,
      format: 'html',
      language: 'EN',
    });

    const input = eurlex_get_document.input.parse({
      celex_number: '32016R0679',
      content_mode: 'full',
    });
    const result = await eurlex_get_document.handler(input, ctx);

    expect(result.content).toBe(body);
    expect(result.content_chars_total).toBe(50_000);
    expect(result.content_chars_returned).toBe(50_000);
    expect(result.content_offset).toBe(0);
    expect(result.has_more).toBe(false);
  });

  it('content_mode "paged" returns contiguous windows that reconstruct the full body; has_more flips on the last page', async () => {
    const ctx = createMockContext({ errors: eurlex_get_document.errors });
    const body = 'abcdefghij'.repeat(2_500); // 25,000 chars
    mockSparqlQuery.mockResolvedValue([makeMetaBinding({ celex: '32016R0679' })]);
    mockFetchContent.mockResolvedValue({
      content: body,
      contentAvailable: true,
      format: 'html',
      language: 'EN',
    });

    const page = (offset: number) =>
      eurlex_get_document.handler(
        eurlex_get_document.input.parse({
          celex_number: '32016R0679',
          content_mode: 'paged',
          offset,
          limit: 10_000,
        }),
        ctx,
      );

    const p1 = await page(0);
    expect(p1.content_offset).toBe(0);
    expect(p1.content_chars_returned).toBe(10_000);
    expect(p1.content_chars_total).toBe(25_000);
    expect(p1.has_more).toBe(true);

    // Page 2 starts exactly where page 1 ended — no gap, no overlap.
    const next2 = (p1.content_offset ?? 0) + (p1.content_chars_returned ?? 0);
    expect(next2).toBe(10_000);
    const p2 = await page(next2);
    expect(p2.content_offset).toBe(10_000);
    expect(p2.content_chars_returned).toBe(10_000);
    expect(p2.has_more).toBe(true);

    // Final page.
    const next3 = (p2.content_offset ?? 0) + (p2.content_chars_returned ?? 0);
    expect(next3).toBe(20_000);
    const p3 = await page(next3);
    expect(p3.content_offset).toBe(20_000);
    expect(p3.content_chars_returned).toBe(5_000);
    expect(p3.has_more).toBe(false);

    // Contiguous pages reconstruct 100% of the act, and the last page's tail is the true end.
    const reconstructed = (p1.content ?? '') + (p2.content ?? '') + (p3.content ?? '');
    expect(reconstructed).toBe(body);
    expect(p3.content?.endsWith(body.slice(-100))).toBe(true);
    expect((p3.content_offset ?? 0) + (p3.content_chars_returned ?? 0)).toBe(
      p3.content_chars_total,
    );
  });

  it('a small act returns its whole body in one page with has_more false (default paged mode)', async () => {
    const ctx = createMockContext({ errors: eurlex_get_document.errors });
    const body = '<html>Short act</html>';
    mockSparqlQuery.mockResolvedValue([makeMetaBinding({ celex: '32013R0001' })]);
    mockFetchContent.mockResolvedValue({
      content: body,
      contentAvailable: true,
      format: 'html',
      language: 'EN',
    });

    const input = eurlex_get_document.input.parse({ celex_number: '32013R0001' }); // default content_mode
    const result = await eurlex_get_document.handler(input, ctx);

    expect(result.content_mode).toBe('paged');
    expect(result.content).toBe(body);
    expect(result.content_chars_total).toBe(body.length);
    expect(result.content_chars_returned).toBe(body.length);
    expect(result.has_more).toBe(false);
  });

  it('paged offset past the end returns an empty window with has_more false (clamped, not an error)', async () => {
    const ctx = createMockContext({ errors: eurlex_get_document.errors });
    const body = 'z'.repeat(1_000);
    mockSparqlQuery.mockResolvedValue([makeMetaBinding({ celex: '32016R0679' })]);
    mockFetchContent.mockResolvedValue({
      content: body,
      contentAvailable: true,
      format: 'html',
      language: 'EN',
    });

    const input = eurlex_get_document.input.parse({
      celex_number: '32016R0679',
      content_mode: 'paged',
      offset: 5_000,
      limit: 10_000,
    });
    const result = await eurlex_get_document.handler(input, ctx);

    expect(result.content).toBeUndefined();
    expect(result.content_offset).toBe(1_000); // clamped to total
    expect(result.content_chars_returned).toBe(0);
    expect(result.has_more).toBe(false);
    expect(result.content_chars_total).toBe(1_000);
  });

  // --- Format: unified sizing across structuredContent and the text view ---

  it('format renders metadata and an unavailable-content note', () => {
    const output = {
      celex_number: '32016R0679',
      work_uri: 'http://publications.europa.eu/resource/cellar/gdpr',
      title: 'GDPR',
      date: '2016-04-27',
      resource_type: 'http://publications.europa.eu/resource/authority/resource-type/REG',
      in_force: true,
      legal_basis: ['http://lb1'],
      eurovoc_subjects: ['http://ev1', 'http://ev2'],
      content_mode: 'paged',
      content_available: false,
      has_more: false,
      language: 'EN',
      content_format: 'html',
    };
    const blocks = eurlex_get_document.format!(output);
    expect(blocks[0]?.type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('32016R0679');
    expect(text).toContain('2016-04-27');
    expect(text).toContain('EN');
    expect(text).toContain('html');
    expect(text).toContain('not available');
  });

  // --- #41: EuroVoc subjects render in full (no first-5 cut) for format parity ---

  it('format renders every EuroVoc subject, not a truncated first 5 (#41)', () => {
    // A real act (GDPR) carries 9 subjects; structuredContent has all of them, so
    // the text channel must too — the old .slice(0, 5) + "(+N more)" cut lost the
    // rest for content[]-only clients.
    const subjects = Array.from({ length: 9 }, (_, i) => `http://eurovoc.europa.eu/${1000 + i}`);
    const output = {
      celex_number: '32016R0679',
      eurovoc_subjects: subjects,
      content_mode: 'metadata_only',
      content_available: false,
      has_more: false,
      language: 'EN',
      content_format: 'html',
    };
    const text = (eurlex_get_document.format!(output)[0] as { text: string }).text;
    for (const s of subjects) expect(text).toContain(s);
    // No "(+N more)" truncation notice, and the 6th subject (first one the old cut
    // dropped) is present.
    expect(text).not.toContain('more)');
    expect(text).toContain('http://eurovoc.europa.eu/1005');
  });

  it('format() and structuredContent.content honor the same window (no separate 8000-char cut)', async () => {
    const ctx = createMockContext({ errors: eurlex_get_document.errors });
    const body = 'Q'.repeat(12_000); // larger than the removed 8000-char format() cut
    mockSparqlQuery.mockResolvedValue([makeMetaBinding({ celex: '32016R0679' })]);
    mockFetchContent.mockResolvedValue({
      content: body,
      contentAvailable: true,
      format: 'html',
      language: 'EN',
    });

    const input = eurlex_get_document.input.parse({
      celex_number: '32016R0679',
      content_mode: 'paged',
      offset: 0,
      limit: 9_000,
    });
    const result = await eurlex_get_document.handler(input, ctx);
    expect(result.content_chars_returned).toBe(9_000);

    const text = (eurlex_get_document.format!(result)[0] as { text: string }).text;
    // The text view carries exactly the structured window — no old cut, no full body.
    expect(text).toContain(result.content!);
    expect(result.content?.length).toBe(9_000);
    expect(text).not.toContain('truncated');
    expect(text).toContain('characters 0');
    expect(text).toContain('of 12000');
    expect(text).toContain('offset=9000');
  });

  // --- Markdown format composes with pagination across both render channels (issue #13) ---

  it('paginates server-converted Markdown and carries the window into both channels', async () => {
    const ctx = createMockContext({ errors: eurlex_get_document.errors });
    const md = `## Heading\n\n${'(1) The protection of natural persons is a fundamental right. '.repeat(1_000)}`;
    mockSparqlQuery.mockResolvedValue([makeMetaBinding({ celex: '32016R0679' })]);
    mockFetchContent.mockResolvedValue({
      content: md,
      contentAvailable: true,
      format: 'markdown',
      language: 'EN',
    });

    const input = eurlex_get_document.input.parse({
      celex_number: '32016R0679',
      format: 'markdown',
      content_mode: 'paged',
      offset: 0,
      limit: 5_000,
    });
    const result = await eurlex_get_document.handler(input, ctx);

    // content_format reports markdown; the body fetched as markdown is windowed like any other.
    expect(result.content_format).toBe('markdown');
    expect(result.content_chars_total).toBe(md.length);
    expect(result.content_chars_returned).toBe(5_000);
    expect(result.has_more).toBe(true);
    // The fetchContent call carried 'markdown' through to the content service.
    expect(mockFetchContent).toHaveBeenCalledWith(
      '32016R0679',
      'EN',
      'markdown',
      expect.anything(),
    );

    // Both channels carry the same markdown window: structuredContent.content and the format() text block.
    const text = (eurlex_get_document.format!(result)[0] as { text: string }).text;
    expect(text).toContain(result.content!);
    expect(result.content?.length).toBe(5_000);
  });

  it('format renders a "full" body verbatim with no truncation', () => {
    const body = 'x'.repeat(9_000);
    const output = {
      celex_number: '32016R0679',
      content_mode: 'full',
      content_available: true,
      content: body,
      content_offset: 0,
      content_chars_returned: 9_000,
      content_chars_total: 9_000,
      has_more: false,
      language: 'EN',
      content_format: 'html',
    };
    const blocks = eurlex_get_document.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).not.toContain('truncated');
    expect(text).toContain(body); // full body present, uncut
    expect(text).toContain('full body');
  });

  // --- Outline mode and structural selectors (issue #12) ---

  describe('outline mode and structural selectors', () => {
    // A structured body: one chapter with two articles. Each heading on its own
    // line, mirroring the CELLAR layout confirmed live against GDPR.
    const STRUCTURED_BODY = [
      '<p class="oj-ti-grseq">CHAPTER I</p>',
      '<p class="oj-ti-grseq">General provisions</p>',
      '<p class="oj-ti-art">Article 1</p>',
      '<p class="oj-sti-art">Subject-matter</p>',
      '<p class="oj-normal">This Regulation lays down rules.</p>',
      '<p class="oj-ti-art">Article 2</p>',
      '<p class="oj-sti-art">Scope</p>',
      '<p class="oj-normal">This Regulation applies broadly.</p>',
    ].join('\n');
    const UNSTRUCTURED_BODY = '<p>JUDGMENT OF THE COURT</p>\n<p>The action is dismissed.</p>';

    const mockStructured = () => {
      mockSparqlQuery.mockResolvedValue([makeMetaBinding({ celex: '32016R0679' })]);
      mockFetchContent.mockResolvedValue({
        content: STRUCTURED_BODY,
        contentAvailable: true,
        format: 'html',
        language: 'EN',
      });
    };

    it('outline: true returns the heading list with offsets and no body', async () => {
      const ctx = createMockContext({ errors: eurlex_get_document.errors });
      mockStructured();

      const input = eurlex_get_document.input.parse({
        celex_number: '32016R0679',
        outline: true,
      });
      const result = await eurlex_get_document.handler(input, ctx);

      expect(result.structure_detected).toBe(true);
      expect(result.outline?.map((h) => h.label)).toEqual(['CHAPTER I', 'Article 1', 'Article 2']);
      expect(result.outline?.every((h) => typeof h.offset === 'number')).toBe(true);
      // Structure-only: no body text, but the full size is still reported.
      expect(result.content).toBeUndefined();
      expect(result.content_chars_total).toBe(STRUCTURED_BODY.length);
      expect(result.content_available).toBe(true);
      expect(result.has_more).toBe(false);
    });

    it('outline: true on an unstructured act returns an empty outline, not an error', async () => {
      const ctx = createMockContext({ errors: eurlex_get_document.errors });
      mockSparqlQuery.mockResolvedValue([makeMetaBinding({ celex: '62024CJ0629' })]);
      mockFetchContent.mockResolvedValue({
        content: UNSTRUCTURED_BODY,
        contentAvailable: true,
        format: 'html',
        language: 'EN',
      });

      const input = eurlex_get_document.input.parse({
        celex_number: '62024CJ0629',
        outline: true,
      });
      const result = await eurlex_get_document.handler(input, ctx);

      expect(result.outline).toEqual([]);
      expect(result.structure_detected).toBe(false);
      expect(result.content).toBeUndefined();
    });

    it('select returns only the requested section as content with selection metadata', async () => {
      const ctx = createMockContext({ errors: eurlex_get_document.errors });
      mockStructured();

      const input = eurlex_get_document.input.parse({
        celex_number: '32016R0679',
        select: { articles: '1' },
      });
      const result = await eurlex_get_document.handler(input, ctx);

      expect(result.structure_detected).toBe(true);
      expect(result.selection).toEqual({
        requested: ['Article 1'],
        matched: ['Article 1'],
        missed: [],
      });
      expect(result.content).toContain('Article 1');
      expect(result.content).toContain('Subject-matter');
      // The neighbor article is not bled into the slice.
      expect(result.content).not.toContain('Article 2');
      expect(result.content_chars_returned).toBe(result.content!.length);
      expect(result.has_more).toBe(false);
    });

    it('select reports a miss with no body and never the wrong section', async () => {
      const ctx = createMockContext({ errors: eurlex_get_document.errors });
      mockStructured();

      const input = eurlex_get_document.input.parse({
        celex_number: '32016R0679',
        select: { articles: '99' },
      });
      const result = await eurlex_get_document.handler(input, ctx);

      expect(result.selection).toEqual({
        requested: ['Article 99'],
        matched: [],
        missed: ['Article 99'],
      });
      expect(result.content).toBeUndefined();
      expect(result.content_chars_returned).toBe(0);
      expect(result.structure_detected).toBe(true);
    });

    it('select on an unstructured act reports all missed and structure_detected false', async () => {
      const ctx = createMockContext({ errors: eurlex_get_document.errors });
      mockSparqlQuery.mockResolvedValue([makeMetaBinding({ celex: '62024CJ0629' })]);
      mockFetchContent.mockResolvedValue({
        content: UNSTRUCTURED_BODY,
        contentAvailable: true,
        format: 'html',
        language: 'EN',
      });

      const input = eurlex_get_document.input.parse({
        celex_number: '62024CJ0629',
        select: { articles: '1', chapters: 'I' },
      });
      const result = await eurlex_get_document.handler(input, ctx);

      expect(result.structure_detected).toBe(false);
      expect(result.selection?.missed).toEqual(['Article 1', 'CHAPTER I']);
      expect(result.content).toBeUndefined();
    });

    it('outline takes precedence over select when both are set', async () => {
      const ctx = createMockContext({ errors: eurlex_get_document.errors });
      mockStructured();

      const input = eurlex_get_document.input.parse({
        celex_number: '32016R0679',
        outline: true,
        select: { articles: '1' },
      });
      const result = await eurlex_get_document.handler(input, ctx);

      expect(result.outline).toBeDefined();
      expect(result.selection).toBeUndefined();
    });

    it('outline is ignored in metadata_only mode — no fetch, no outline', async () => {
      const ctx = createMockContext({ errors: eurlex_get_document.errors });
      mockSparqlQuery.mockResolvedValue([makeMetaBinding({ celex: '32016R0679' })]);

      const input = eurlex_get_document.input.parse({
        celex_number: '32016R0679',
        content_mode: 'metadata_only',
        outline: true,
      });
      const result = await eurlex_get_document.handler(input, ctx);

      expect(result.outline).toBeUndefined();
      expect(result.structure_detected).toBeUndefined();
      expect(mockFetchContent).not.toHaveBeenCalled();
    });

    it('outline composes with the requested format (select passes markdown through)', async () => {
      const ctx = createMockContext({ errors: eurlex_get_document.errors });
      mockSparqlQuery.mockResolvedValue([makeMetaBinding({ celex: '32016R0679' })]);
      mockFetchContent.mockResolvedValue({
        content: STRUCTURED_BODY,
        contentAvailable: true,
        format: 'markdown',
        language: 'EN',
      });

      const input = eurlex_get_document.input.parse({
        celex_number: '32016R0679',
        format: 'markdown',
        outline: true,
      });
      const result = await eurlex_get_document.handler(input, ctx);

      expect(result.content_format).toBe('markdown');
      expect(result.outline?.length).toBeGreaterThan(0);
      expect(mockFetchContent).toHaveBeenCalledWith(
        '32016R0679',
        'EN',
        'markdown',
        expect.anything(),
      );
    });

    it('format renders the outline as a heading list with offsets', () => {
      const output = {
        celex_number: '32016R0679',
        content_mode: 'paged',
        content_available: true,
        has_more: false,
        language: 'EN',
        content_format: 'html',
        content_chars_total: 500,
        structure_detected: true,
        outline: [
          {
            kind: 'chapter',
            number: 'I',
            label: 'CHAPTER I',
            title: 'General provisions',
            offset: 0,
          },
          { kind: 'article', number: '1', label: 'Article 1', offset: 42 },
        ],
      };
      const text = (eurlex_get_document.format!(output)[0] as { text: string }).text;
      expect(text).toContain('Outline');
      expect(text).toContain('CHAPTER I');
      expect(text).toContain('offset 0');
      expect(text).toContain('Article 1');
    });

    it('format renders a selection miss notice pointing at the paging floor', () => {
      const output = {
        celex_number: '32016R0679',
        content_mode: 'paged',
        content_available: true,
        has_more: false,
        language: 'EN',
        content_format: 'html',
        content_chars_total: 500,
        structure_detected: true,
        selection: { requested: ['Article 99'], matched: [], missed: ['Article 99'] },
      };
      const text = (eurlex_get_document.format!(output)[0] as { text: string }).text;
      expect(text).toContain('Selection');
      expect(text).toContain('Not found: Article 99');
      expect(text).toContain('content_mode "full"');
    });
  });

  // --- #33 authors, #34 work_uri, #29 staleness/resolve ---

  describe('authors (#33), work_uri (#34), staleness + resolve (#29)', () => {
    type SparqlRows = Array<Record<string, { type: string; value: string }>>;
    const CB = 'http://publications.europa.eu/resource/authority/corporate-body';
    /** A single-column binding row (dimension / consolidation / deref queries). */
    const row = (field: string, value: string): SparqlRows[number] => ({
      [field]: { type: 'uri', value },
    });

    /**
     * Route the shared SPARQL mock by query content. The handler now issues a core
     * metadata query plus one query per multi-valued dimension (#33), a work_uri
     * deref (#34), and a consolidation probe (#29), so a single blanket return can't
     * exercise them independently.
     */
    const routeSparql = (routes: {
      eli?: SparqlRows;
      workUriDeref?: SparqlRows;
      core?: SparqlRows;
      author?: SparqlRows;
      legalBasis?: SparqlRows;
      eurovoc?: SparqlRows;
      consolidation?: SparqlRows;
    }) => {
      mockSparqlQuery.mockImplementation((query: string) => {
        if (query.includes('cdm:resource_legal_eli')) return Promise.resolve(routes.eli ?? []);
        if (query.includes('cdm:act_consolidated_consolidates_resource_legal'))
          return Promise.resolve(routes.consolidation ?? []);
        if (query.includes('cdm:work_created_by_agent'))
          return Promise.resolve(routes.author ?? []);
        if (query.includes('cdm:resource_legal_based_on_resource_legal'))
          return Promise.resolve(routes.legalBasis ?? []);
        if (query.includes('cdm:work_is_about_concept_eurovoc'))
          return Promise.resolve(routes.eurovoc ?? []);
        if (query.includes('cdm:expression_belongs_to_work'))
          return Promise.resolve(routes.core ?? []);
        return Promise.resolve(routes.workUriDeref ?? []); // work_uri → CELEX deref
      });
    };

    // --- #33: co-legislator authors and no cross-product truncation ---

    it('#33: surfaces all co-legislator authors, not just the first', async () => {
      const ctx = createMockContext({ errors: eurlex_get_document.errors });
      routeSparql({
        core: [makeMetaBinding({ celex: '32016R0679', title: 'GDPR' })],
        author: [row('author', `${CB}/EP`), row('author', `${CB}/CONSIL`)],
      });

      const input = eurlex_get_document.input.parse({
        celex_number: '32016R0679',
        content_mode: 'metadata_only',
      });
      const result = await eurlex_get_document.handler(input, ctx);

      // Full set present regardless of order; primary is one of them.
      expect(result.author_institutions).toEqual(
        expect.arrayContaining(['European Parliament', 'Council of the EU']),
      );
      expect(result.author_institutions).toHaveLength(2);
      expect(['European Parliament', 'Council of the EU']).toContain(result.author_institution);

      // format() surfaces the full set (parity).
      const text = (eurlex_get_document.format!(result)[0] as { text: string }).text;
      expect(text).toContain('European Parliament');
      expect(text).toContain('Council of the EU');
    });

    it('#33: captures the full set for every dimension — no cross-product truncation (REACH-shape)', async () => {
      const ctx = createMockContext({ errors: eurlex_get_document.errors });
      // 2 authors × 2 legal bases × 8 EuroVoc = 32 cross-product rows — over the old
      // LIMIT-20 cap. Per-dimension queries capture each in full.
      const eurovoc = Array.from({ length: 8 }, (_, i) => row('eurovoc', `http://eurovoc/${i}`));
      routeSparql({
        core: [makeMetaBinding({ celex: '32006R1907', title: 'REACH' })],
        author: [row('author', `${CB}/EP`), row('author', `${CB}/CONSIL`)],
        legalBasis: [row('legalBasis', 'http://lb/1'), row('legalBasis', 'http://lb/2')],
        eurovoc,
      });

      const input = eurlex_get_document.input.parse({
        celex_number: '32006R1907',
        content_mode: 'metadata_only',
      });
      const result = await eurlex_get_document.handler(input, ctx);

      expect(result.eurovoc_subjects).toHaveLength(8);
      expect(result.legal_basis).toHaveLength(2);
      expect(result.author_institutions).toHaveLength(2);
    });

    // --- #34: fetch by CELLAR work_uri ---

    it('#34: fetches a document by CELLAR work_uri (dereferences to CELEX)', async () => {
      const ctx = createMockContext({ errors: eurlex_get_document.errors });
      routeSparql({
        workUriDeref: [{ celex: { type: 'literal', value: '32024R2822' } }],
        core: [makeMetaBinding({ celex: '32024R2822', title: 'Regulation (EU) 2024/2822' })],
      });
      mockFetchContent.mockResolvedValue({
        content: '<html>2822</html>',
        contentAvailable: true,
        format: 'html',
        language: 'EN',
      });

      const input = eurlex_get_document.input.parse({
        work_uri:
          'http://publications.europa.eu/resource/cellar/bd40f370-a54d-11ef-85f0-01aa75ed71a1',
      });
      const result = await eurlex_get_document.handler(input, ctx);

      expect(result.celex_number).toBe('32024R2822');
      expect(result.title).toBe('Regulation (EU) 2024/2822');
      expect(result.content).toBe('<html>2822</html>');
      // The deref query interpolated the work URI inside <...> and read the CELEX.
      const derefQuery = mockSparqlQuery.mock.calls
        .map((c) => c[0] as string)
        .find((q) => q.includes('/resource/cellar/bd40f370'));
      expect(derefQuery).toContain('cdm:resource_legal_id_celex');
      // Content was fetched by the resolved CELEX, not the work URI.
      expect(mockFetchContent).toHaveBeenCalledWith('32024R2822', 'EN', 'html', expect.anything());
    });

    it('#34: a CELLAR work with no CELEX throws not_found with an honest message, not a mislabeled ELI', async () => {
      const ctx = createMockContext({ errors: eurlex_get_document.errors });
      routeSparql({ workUriDeref: [] }); // deref resolves no CELEX

      const input = eurlex_get_document.input.parse({
        work_uri: 'http://publications.europa.eu/resource/cellar/no-celex-uuid',
      });
      const err = await eurlex_get_document.handler(input, ctx).catch((e: unknown) => e);
      expect(err).toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'not_found' },
      });
      expect((err as Error).message).toMatch(/no CELEX number/i);
      // Must NOT label a cellar URI an "ELI".
      expect((err as Error).message).not.toMatch(/\bELI\b/i);
    });

    it('#34: providing more than one identifier throws invalid_identifier_args before any query', async () => {
      const ctx = createMockContext({ errors: eurlex_get_document.errors });
      const input = eurlex_get_document.input.parse({
        celex_number: '32016R0679',
        work_uri: 'http://publications.europa.eu/resource/cellar/uuid',
      });
      await expect(eurlex_get_document.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'invalid_identifier_args' },
      });
      expect(mockSparqlQuery).not.toHaveBeenCalled();
    });

    // --- #29: staleness signal + opt-in resolve ---

    it('#29: flags a superseded base act — newest same-act consolidation wins, other acts filtered out', async () => {
      const ctx = createMockContext({ errors: eurlex_get_document.errors });
      routeSparql({
        core: [makeMetaBinding({ celex: '32014R0833' })],
        // Query orders DESC(?consolidatedCelex); newest same-act first, then older,
        // then a different act's consolidation (a graph artifact to be filtered).
        consolidation: [
          row('consolidatedCelex', '02014R0833-20260424'),
          row('consolidatedCelex', '02014R0833-20220101'),
          row('consolidatedCelex', '01995L0046-20180525'),
        ],
      });

      const input = eurlex_get_document.input.parse({
        celex_number: '32014R0833',
        content_mode: 'metadata_only',
      });
      const result = await eurlex_get_document.handler(input, ctx);

      expect(result.is_superseded).toBe(true);
      expect(result.current_consolidated_celex).toBe('02014R0833-20260424');
      expect(result.consolidated_as_of).toBe('2026-04-24');
      // format() surfaces the staleness fields (parity).
      const text = (eurlex_get_document.format!(result)[0] as { text: string }).text;
      expect(text).toContain('Superseded');
      expect(text).toContain('02014R0833-20260424');
      expect(text).toContain('2026-04-24');
    });

    it('#29: omits staleness when the requested CELEX is itself a consolidated version (no probe issued)', async () => {
      const ctx = createMockContext({ errors: eurlex_get_document.errors });
      routeSparql({
        core: [makeMetaBinding({ celex: '02014R0833-20260424' })],
        consolidation: [row('consolidatedCelex', '02014R0833-20260424')],
      });

      const input = eurlex_get_document.input.parse({
        celex_number: '02014R0833-20260424',
        content_mode: 'metadata_only',
      });
      const result = await eurlex_get_document.handler(input, ctx);

      expect(result.is_superseded).toBeUndefined();
      expect(result.current_consolidated_celex).toBeUndefined();
      // Short-circuits before issuing the consolidation query.
      const probed = mockSparqlQuery.mock.calls
        .map((c) => c[0] as string)
        .some((q) => q.includes('act_consolidated_consolidates'));
      expect(probed).toBe(false);
    });

    it('#29: omits staleness for a base act with no consolidated versions', async () => {
      const ctx = createMockContext({ errors: eurlex_get_document.errors });
      routeSparql({
        core: [makeMetaBinding({ celex: '32024R2822' })],
        consolidation: [],
      });

      const input = eurlex_get_document.input.parse({
        celex_number: '32024R2822',
        content_mode: 'metadata_only',
      });
      const result = await eurlex_get_document.handler(input, ctx);

      expect(result.is_superseded).toBeUndefined();
      expect(result.current_consolidated_celex).toBeUndefined();
      expect(result.consolidated_as_of).toBeUndefined();
    });

    it('#29: resolve "current_consolidated" serves the consolidated work and reports served + requested CELEX', async () => {
      const ctx = createMockContext({ errors: eurlex_get_document.errors });
      mockSparqlQuery.mockImplementation((query: string) => {
        if (query.includes('cdm:act_consolidated_consolidates_resource_legal')) {
          return Promise.resolve([
            { consolidatedCelex: { type: 'literal', value: '02014R0833-20260424' } },
          ]);
        }
        if (query.includes('cdm:expression_belongs_to_work')) {
          // Core metadata keys off the served CELEX (the FILTER literal).
          const celex = /"([^"]+)"/.exec(query)?.[1] ?? '';
          return Promise.resolve([makeMetaBinding({ celex })]);
        }
        return Promise.resolve([]);
      });
      mockFetchContent.mockResolvedValue({
        content: '<html>consolidated</html>',
        contentAvailable: true,
        format: 'html',
        language: 'EN',
      });

      const input = eurlex_get_document.input.parse({
        celex_number: '32014R0833',
        resolve: 'current_consolidated',
      });
      const result = await eurlex_get_document.handler(input, ctx);

      expect(result.celex_number).toBe('02014R0833-20260424'); // served consolidated
      expect(result.requested_celex).toBe('32014R0833'); // original echoed
      expect(result.is_superseded).toBe(true);
      expect(result.current_consolidated_celex).toBe('02014R0833-20260424');
      expect(result.content).toBe('<html>consolidated</html>');
      // Content fetched for the CONSOLIDATED celex, not the requested base.
      expect(mockFetchContent).toHaveBeenCalledWith(
        '02014R0833-20260424',
        'EN',
        'html',
        expect.anything(),
      );
      const text = (eurlex_get_document.format!(result)[0] as { text: string }).text;
      expect(text).toContain('Requested CELEX');
      expect(text).toContain('32014R0833');
    });

    it('#29: resolve "current_consolidated" is a no-op when no newer consolidated version exists', async () => {
      const ctx = createMockContext({ errors: eurlex_get_document.errors });
      routeSparql({
        core: [makeMetaBinding({ celex: '32024R2822' })],
        consolidation: [],
      });
      mockFetchContent.mockResolvedValue({
        content: '<html>as enacted</html>',
        contentAvailable: true,
        format: 'html',
        language: 'EN',
      });

      const input = eurlex_get_document.input.parse({
        celex_number: '32024R2822',
        resolve: 'current_consolidated',
      });
      const result = await eurlex_get_document.handler(input, ctx);

      expect(result.celex_number).toBe('32024R2822'); // served as requested
      expect(result.requested_celex).toBeUndefined(); // no redirect
      expect(result.is_superseded).toBeUndefined();
      expect(mockFetchContent).toHaveBeenCalledWith('32024R2822', 'EN', 'html', expect.anything());
    });
  });

  // --- #53: control characters in an identifier must not reach the query raw ---

  describe('control characters in an identifier (#53)', () => {
    const WORK_URI =
      'http://publications.europa.eu/resource/cellar/3e485e15-11bd-11e6-ba9a-01aa75ed71a1';

    /**
     * These assert on the SPARQL text the service actually receives, not just on the
     * thrown error. A mocked query returns whatever it is told to regardless of what
     * was asked, so "handler throws not_found" passes just as well against the raw
     * unescaped identifier that made the real endpoint reject the query — the leak
     * is only visible in the query text.
     */
    const queriesIssued = () => mockSparqlQuery.mock.calls.map((c) => c[0] as string);

    it('escapes an embedded newline in celex_number and returns the tool own not_found', async () => {
      const ctx = createMockContext({ errors: eurlex_get_document.errors });
      mockSparqlQuery.mockResolvedValue([]); // identifier matches no work

      const input = eurlex_get_document.input.parse({
        celex_number: '32016R0679\nGDPR',
        content_mode: 'metadata_only',
      });
      const err = await eurlex_get_document.handler(input, ctx).catch((e: unknown) => e);

      const queries = queriesIssued();
      expect(queries.length).toBeGreaterThan(0);
      // The raw newline would end the short literal and make the query unparseable.
      for (const q of queries) expect(q).not.toContain('32016R0679\nGDPR');
      expect(queries.some((q) => q.includes(String.raw`32016R0679\nGDPR`))).toBe(true);

      // A valid query that matches nothing is the tool's own not_found — not a
      // backend compiler error carrying the internal query text.
      expect(err).toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'not_found' },
      });
    });

    it('escapes an embedded newline in eli_uri', async () => {
      const ctx = createMockContext({ errors: eurlex_get_document.errors });
      mockSparqlQuery.mockResolvedValue([]); // ELI resolves to no work

      const input = eurlex_get_document.input.parse({
        eli_uri: 'http://data.europa.eu/eli/reg/2016/679\nX',
        content_mode: 'metadata_only',
      });
      const err = await eurlex_get_document.handler(input, ctx).catch((e: unknown) => e);

      const queries = queriesIssued();
      expect(queries.length).toBeGreaterThan(0);
      for (const q of queries) expect(q).not.toContain('679\nX');
      expect(queries.some((q) => q.includes(String.raw`679\nX`))).toBe(true);

      expect(err).toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'not_found' },
      });
    });

    /**
     * work_uri is interpolated into a `<…>` IRI rather than a literal, so escaping
     * does not apply — the schema has to reject the value outright. The guard this
     * replaced tested only for a literal space, so a tab or newline passed it and
     * built a malformed IRI (both confirmed live to leak Virtuoso's error).
     */
    it.each([
      ['a newline', `${WORK_URI}\nX`],
      ['a tab', `${WORK_URI}\tX`],
      ['a carriage return', `${WORK_URI}\rX`],
      ['a space', `${WORK_URI} X`],
      ['an opening angle bracket', `${WORK_URI}<X`],
      ['a closing angle bracket', `${WORK_URI}>X`],
      ['a double quote', `${WORK_URI}"X`],
    ])('rejects a work_uri containing %s at the schema, before any query', (_label, uri) => {
      expect(() => eurlex_get_document.input.parse({ work_uri: uri })).toThrow();
      expect(mockSparqlQuery).not.toHaveBeenCalled();
    });

    it('still accepts a legitimate work_uri', () => {
      expect(() => eurlex_get_document.input.parse({ work_uri: WORK_URI })).not.toThrow();
    });
  });
});
