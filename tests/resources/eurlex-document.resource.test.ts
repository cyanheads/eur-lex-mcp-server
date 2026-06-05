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
    });
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

  // --- Error path: not found ---

  it('throws notFound when CELEX resolves to no bindings', async () => {
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    mockQuery.mockResolvedValue([]);

    const params = eurlex_document_resource.params.parse({ celexNumber: '99999X0000' });
    await expect(eurlex_document_resource.handler(params, ctx)).rejects.toThrow('No CELLAR work');
  });
});
