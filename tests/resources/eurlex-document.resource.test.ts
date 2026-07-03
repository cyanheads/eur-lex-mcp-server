/**
 * @fileoverview Tests for eurlex://document/{celexNumber} resource.
 * @module tests/resources/eurlex-document.resource.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eurlex_document_resource } from '@/mcp-server/resources/definitions/eurlex-document.resource.js';

// --- Service mock ---
const mockQuery = vi.fn();
vi.mock('@/services/cellar-sparql/cellar-sparql-service.js', () => ({
  getCellarSparqlService: () => ({ query: mockQuery }),
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

function makeMetaBinding(opts: {
  celex: string;
  workUri?: string;
  type?: string;
  date?: string;
  title?: string;
  inForce?: string;
  author?: string;
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
  return b;
}

describe('eurlex_document_resource', () => {
  beforeEach(() => mockQuery.mockReset());

  // --- Happy path ---

  it('returns metadata snapshot for a valid CELEX number', async () => {
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    mockQuery.mockResolvedValue([
      makeMetaBinding({
        celex: '32016R0679',
        date: '2016-04-27',
        title: 'General Data Protection Regulation',
        type: 'http://publications.europa.eu/resource/authority/resource-type/REG',
        inForce: 'true',
      }),
    ]);

    const params = eurlex_document_resource.params.parse({ celexNumber: '32016R0679' });
    const result = await eurlex_document_resource.handler(params, ctx);

    expect(result).toMatchObject({
      celex_number: '32016R0679',
      date: '2016-04-27',
      title: 'General Data Protection Regulation',
      in_force: true,
      // #35: the raw resource-type URI resolves to a human-readable label.
      resource_type: 'Regulation',
    });
  });

  // --- #35: metadata authorities resolve to human-readable labels ---

  it('resolves resource_type and author URIs to labels, matching eurlex_get_document', async () => {
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const CB = 'http://publications.europa.eu/resource/authority/corporate-body';
    // A co-legislated act: the metadata query returns one row per author. CONSIL
    // is first, so it is the primary — matching the tool's output for GDPR.
    mockQuery.mockResolvedValue([
      makeMetaBinding({
        celex: '32016R0679',
        type: 'http://publications.europa.eu/resource/authority/resource-type/REG',
        author: `${CB}/CONSIL`,
      }),
      makeMetaBinding({
        celex: '32016R0679',
        type: 'http://publications.europa.eu/resource/authority/resource-type/REG',
        author: `${CB}/EP`,
      }),
    ]);

    const params = eurlex_document_resource.params.parse({ celexNumber: '32016R0679' });
    const result = (await eurlex_document_resource.handler(params, ctx)) as Record<string, unknown>;

    // No raw authority URIs leak: type and author are human-readable labels.
    expect(result.resource_type).toBe('Regulation');
    expect(result.author_institution).toBe('Council of the EU');
    expect(result.author_institutions).toEqual(['Council of the EU', 'European Parliament']);
    // The label fields are not overloaded with the raw URIs.
    expect(result.resource_type).not.toContain('http');
    expect(result.author_institution).not.toContain('http');
  });

  it('surfaces a single author as both the primary and the one-element institutions list', async () => {
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const CB = 'http://publications.europa.eu/resource/authority/corporate-body';
    mockQuery.mockResolvedValue([
      makeMetaBinding({
        celex: '32024R2822',
        type: 'http://publications.europa.eu/resource/authority/resource-type/REG',
        author: `${CB}/COM`,
      }),
    ]);

    const params = eurlex_document_resource.params.parse({ celexNumber: '32024R2822' });
    const result = (await eurlex_document_resource.handler(params, ctx)) as Record<string, unknown>;

    expect(result.author_institution).toBe('European Commission');
    expect(result.author_institutions).toEqual(['European Commission']);
  });

  it('returns sparse result when only required fields are present', async () => {
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    mockQuery.mockResolvedValue([makeMetaBinding({ celex: '32016R0679' })]);

    const params = eurlex_document_resource.params.parse({ celexNumber: '32016R0679' });
    const result = await eurlex_document_resource.handler(params, ctx);

    expect((result as Record<string, unknown>).celex_number).toBe('32016R0679');
    expect((result as Record<string, unknown>).title).toBeUndefined();
    expect((result as Record<string, unknown>).date).toBeUndefined();
    expect((result as Record<string, unknown>).in_force).toBeUndefined();
  });

  it('converts inForce string binding to boolean correctly', async () => {
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    mockQuery.mockResolvedValue([makeMetaBinding({ celex: '32016R0679', inForce: 'false' })]);

    const params = eurlex_document_resource.params.parse({ celexNumber: '32016R0679' });
    const result = await eurlex_document_resource.handler(params, ctx);

    expect((result as Record<string, unknown>).in_force).toBe(false);
  });

  // --- #20: CELLAR serializes xsd:boolean as the lexical "1"/"0" ---

  it('parses in_force from the xsd:boolean lexical "1"', async () => {
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    mockQuery.mockResolvedValue([makeMetaBinding({ celex: '32016R0679', inForce: '1' })]);

    const params = eurlex_document_resource.params.parse({ celexNumber: '32016R0679' });
    const result = await eurlex_document_resource.handler(params, ctx);

    expect((result as Record<string, unknown>).in_force).toBe(true);
  });

  // --- Title traversal (issue #7) ---

  it('uses the expression-level title traversal, not the obsolete work_title pattern', async () => {
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    mockQuery.mockResolvedValue([
      makeMetaBinding({ celex: '32016R0679', title: 'General Data Protection Regulation' }),
    ]);

    const params = eurlex_document_resource.params.parse({ celexNumber: '32016R0679' });
    const result = await eurlex_document_resource.handler(params, ctx);

    expect((result as Record<string, unknown>).title).toBe('General Data Protection Regulation');
    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sparql).toContain('cdm:expression_belongs_to_work');
    expect(sparql).toContain('cdm:expression_title');
    expect(sparql).not.toContain('cdm:work_title');
  });

  // --- Error path: not found ---

  it('throws notFound when CELEX resolves to no bindings', async () => {
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    mockQuery.mockResolvedValue([]);

    const params = eurlex_document_resource.params.parse({ celexNumber: '99999X0000' });
    await expect(eurlex_document_resource.handler(params, ctx)).rejects.toThrow('No CELLAR work');
  });
});
