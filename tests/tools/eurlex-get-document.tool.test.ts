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
    // Second query: metadata keyed by the resolved CELEX.
    mockSparqlQuery
      .mockResolvedValueOnce([makeMetaBinding({ celex: '32016R0679' })])
      .mockResolvedValueOnce([
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

  // --- Format ---

  it('format renders celex, date, type, language, and content_available flag', () => {
    const output = {
      celex_number: '32016R0679',
      work_uri: 'http://publications.europa.eu/resource/cellar/gdpr',
      title: 'GDPR',
      date: '2016-04-27',
      resource_type: 'http://publications.europa.eu/resource/authority/resource-type/REG',
      in_force: true,
      legal_basis: ['http://lb1'],
      eurovoc_subjects: ['http://ev1', 'http://ev2'],
      content_available: false,
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
    expect(text).toContain('false'); // content_available
  });

  it('format truncates large content at 8000 chars', () => {
    const longContent = 'x'.repeat(9000);
    const output = {
      celex_number: '32016R0679',
      content_available: true,
      content: longContent,
      language: 'EN',
      content_format: 'html',
    };
    const blocks = eurlex_get_document.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Content truncated');
  });
});
