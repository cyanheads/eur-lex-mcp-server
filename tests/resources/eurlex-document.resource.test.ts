/**
 * @fileoverview Tests for eurlex://document/{celexNumber} resource.
 * @module tests/resources/eurlex-document.resource.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eurlex_document_resource } from '@/mcp-server/resources/definitions/eurlex-document.resource.js';
import { escapeSparqlLiteral } from '@/services/cellar-sparql/eli-resolution.js';

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
  beforeEach(() => {
    mockQuery.mockReset();
  });

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

    const params = eurlex_document_resource.params!.parse({ celexNumber: '32016R0679' });
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

  // --- #67: legal basis and EuroVoc subjects resolve inline ---

  it('returns legal_basis with CELEX and eurovoc_subjects with English labels', async () => {
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const LB = 'http://publications.europa.eu/resource/cellar/fc797fa2-af0e-4cbd-8e74-5ed41139e4dc';
    mockQuery.mockImplementation(async (sparql: string) => {
      if (sparql.includes('cdm:resource_legal_based_on_resource_legal')) {
        return [
          {
            legalBasis: { type: 'uri', value: LB },
            celex: { type: 'literal', value: '12012E016' },
          },
        ];
      }
      if (sparql.includes('cdm:work_is_about_concept_eurovoc')) {
        return [
          {
            eurovoc: { type: 'uri', value: 'http://eurovoc.europa.eu/5181' },
            label: { type: 'literal', value: 'data protection' },
          },
          { eurovoc: { type: 'uri', value: 'http://eurovoc.europa.eu/9999' } },
        ];
      }
      return [makeMetaBinding({ celex: '32016R0679' })];
    });

    const params = eurlex_document_resource.params!.parse({ celexNumber: '32016R0679' });
    const result = (await eurlex_document_resource.handler(params, ctx)) as Record<string, unknown>;

    expect(result.legal_basis).toEqual([{ work_uri: LB, celex_number: '12012E016' }]);
    expect(result.eurovoc_subjects).toEqual([
      { concept_uri: 'http://eurovoc.europa.eu/5181', label: 'data protection' },
      { concept_uri: 'http://eurovoc.europa.eu/9999' },
    ]);
    const eurovocQuery = mockQuery.mock.calls
      .map((c) => c[0] as string)
      .find((q) => q.includes('cdm:work_is_about_concept_eurovoc'));
    expect(eurovocQuery).toContain('FILTER(LANG(?labelValue) = "en")');
    expect(eurovocQuery).toContain('GROUP BY ?eurovoc');
  });

  it('omits legal_basis and eurovoc_subjects when the work records neither', async () => {
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    mockQuery.mockImplementation(async (sparql: string) =>
      sparql.includes('SELECT ?work ') ? [makeMetaBinding({ celex: '12012E016' })] : [],
    );

    const params = eurlex_document_resource.params!.parse({ celexNumber: '12012E016' });
    const result = await eurlex_document_resource.handler(params, ctx);

    expect(result).not.toHaveProperty('legal_basis');
    expect(result).not.toHaveProperty('eurovoc_subjects');
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

    const params = eurlex_document_resource.params!.parse({ celexNumber: '32016R0679' });
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

    const params = eurlex_document_resource.params!.parse({ celexNumber: '32024R2822' });
    const result = (await eurlex_document_resource.handler(params, ctx)) as Record<string, unknown>;

    expect(result.author_institution).toBe('European Commission');
    expect(result.author_institutions).toEqual(['European Commission']);
  });

  it('returns sparse result when only required fields are present', async () => {
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    mockQuery.mockResolvedValue([makeMetaBinding({ celex: '32016R0679' })]);

    const params = eurlex_document_resource.params!.parse({ celexNumber: '32016R0679' });
    const result = await eurlex_document_resource.handler(params, ctx);

    expect((result as Record<string, unknown>).celex_number).toBe('32016R0679');
    expect((result as Record<string, unknown>).title).toBeUndefined();
    expect((result as Record<string, unknown>).date).toBeUndefined();
    expect((result as Record<string, unknown>).in_force).toBeUndefined();
  });

  it('converts inForce string binding to boolean correctly', async () => {
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    mockQuery.mockResolvedValue([makeMetaBinding({ celex: '32016R0679', inForce: 'false' })]);

    const params = eurlex_document_resource.params!.parse({ celexNumber: '32016R0679' });
    const result = await eurlex_document_resource.handler(params, ctx);

    expect((result as Record<string, unknown>).in_force).toBe(false);
  });

  // --- #20: CELLAR serializes xsd:boolean as the lexical "1"/"0" ---

  it('parses in_force from the xsd:boolean lexical "1"', async () => {
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    mockQuery.mockResolvedValue([makeMetaBinding({ celex: '32016R0679', inForce: '1' })]);

    const params = eurlex_document_resource.params!.parse({ celexNumber: '32016R0679' });
    const result = await eurlex_document_resource.handler(params, ctx);

    expect((result as Record<string, unknown>).in_force).toBe(true);
  });

  // --- Title traversal (issue #7) ---

  it('uses the expression-level title traversal, not the obsolete work_title pattern', async () => {
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    mockQuery.mockResolvedValue([
      makeMetaBinding({ celex: '32016R0679', title: 'General Data Protection Regulation' }),
    ]);

    const params = eurlex_document_resource.params!.parse({ celexNumber: '32016R0679' });
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

    const params = eurlex_document_resource.params!.parse({ celexNumber: '99999X0000' });
    await expect(eurlex_document_resource.handler(params, ctx)).rejects.toThrow('No CELLAR work');
  });

  // --- #61: SPARQL literal escaping routes through the shared helper ---
  //
  // The former hand-rolled `celexNumber.replace(/"/g, '\\"')` was a quote-only
  // pass with no backslash pass. A CELEX ending in `\` then escaped the closing
  // quote, the literal never terminated, and Virtuoso's raw SP030 compiler error
  // — carrying the internal query text and PREFIX block — reached the client in
  // place of this resource's own not_found.

  it('escapes a trailing backslash so the SPARQL literal terminates (#61)', async () => {
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    mockQuery.mockResolvedValue([]);

    const celexNumber = '32016R0679\\';
    // The CELEX shape gate refuses the backslash outright, so no query is built
    // from it; escaping below is the second line of defense behind that gate.
    expect(() => eurlex_document_resource.params!.parse({ celexNumber })).toThrow();
    // The resource's own declared error, not a leaked backend compiler error.
    await expect(eurlex_document_resource.handler({ celexNumber }, ctx)).rejects.toThrow(
      'No CELLAR work',
    );

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    // The literal carries exactly what the shared helper produces.
    expect(sparql).toContain(
      `cdm:resource_legal_id_celex "${escapeSparqlLiteral(celexNumber)}"^^xsd:string .`,
    );
    // The unterminated form the quote-only pass produced is gone.
    expect(sparql).not.toContain(String.raw`"32016R0679\"^^`);
  });

  it('escapes an embedded quote-and-backslash sequence (#61)', async () => {
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    mockQuery.mockResolvedValue([]);

    const celexNumber = '32016R0679\\" x';
    expect(() => eurlex_document_resource.params!.parse({ celexNumber })).toThrow();
    await expect(eurlex_document_resource.handler({ celexNumber }, ctx)).rejects.toThrow(
      'No CELLAR work',
    );

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sparql).toContain(
      `cdm:resource_legal_id_celex "${escapeSparqlLiteral(celexNumber)}"^^xsd:string .`,
    );
    // Every backslash and quote from the input is escaped, so the only unescaped
    // double quotes in the literal are its own delimiters.
    expect(sparql).not.toContain(String.raw`"32016R0679\\" x"^^`);
  });

  it('leaves an ordinary CELEX byte-identical through the shared helper (#61)', async () => {
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    mockQuery.mockResolvedValue([makeMetaBinding({ celex: '32016R0679' })]);

    const params = eurlex_document_resource.params!.parse({ celexNumber: '32016R0679' });
    await eurlex_document_resource.handler(params, ctx);

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    // No regression for the overwhelmingly common input: escaping is a no-op.
    expect(sparql).toContain('cdm:resource_legal_id_celex "32016R0679"^^xsd:string .');
  });

  // --- #92: typed exact CELEX triple ---

  it('binds the CELEX as a typed exact triple in the metadata and both dimension queries (#92)', async () => {
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    mockQuery.mockResolvedValue([makeMetaBinding({ celex: '62012CJ0131' })]);

    const params = eurlex_document_resource.params!.parse({ celexNumber: '62012CJ0131' });
    const result = (await eurlex_document_resource.handler(params, ctx)) as Record<string, unknown>;

    const queries = mockQuery.mock.calls.map((c) => c[0] as string);
    expect(queries).toHaveLength(3);
    for (const q of queries) {
      expect(q).toContain('cdm:resource_legal_id_celex "62012CJ0131"^^xsd:string .');
      expect(q).not.toMatch(/STR\(\?\w+\)\s*=/);
    }
    expect(queries[0]).toContain('BIND("62012CJ0131"^^xsd:string AS ?celexNumber)');
    expect(result.celex_number).toBe('62012CJ0131');
  });

  // --- #69: CELEX shape gate on the path parameter ---

  describe('CELEX shape validation (#69)', () => {
    it.each([
      ['a bare zero', '0'],
      ['a stray word', 'hello'],
      ['whitespace only', '   '],
      ['an empty path segment', ''],
      ['a value with an embedded newline', '32016R0679\nGDPR'],
    ])('rejects %s before any CELLAR request', (_label, value) => {
      expect(() => eurlex_document_resource.params!.parse({ celexNumber: value })).toThrow();
      expect(mockQuery).not.toHaveBeenCalled();
    });

    /**
     * Slash-bearing CELEX values (11957A/PRO/CJ/09, C/2026/01104) are deliberately
     * absent: the SDK expands `{celexNumber}` to `([^/]+)`, so `eurlex://document/
     * 11957A/PRO/CJ/09` can never match this template regardless of what the schema
     * accepts. Those values stay on the eurlex_get_document tool's table, which is
     * the reachable surface for them.
     */
    it.each([
      ['sector 0, consolidated version', '02016R0679-20160504'],
      ['sector 3, regulation', '32016R0679'],
      ['sector 3, corrigendum marker', '32016R0679R(02)'],
      ['sector 6, case law', '62024CJ0629'],
      ['sector 7, national implementing measure', '72014L0056FIN_240353'],
      ['sector E, EFTA document', 'E2016C0186'],
    ])('accepts a real %s', (_label, celex) => {
      expect(() => eurlex_document_resource.params!.parse({ celexNumber: celex })).not.toThrow();
    });
  });

  // --- CELEX input normalization on the path parameter ---

  describe('CELEX normalization', () => {
    it('trims surrounding whitespace before validating', () => {
      expect(
        eurlex_document_resource.params!.parse({ celexNumber: '   32016R0679   ' }).celexNumber,
      ).toBe('32016R0679');
    });

    it('uppercases a lowercase CELEX before validating', () => {
      expect(
        eurlex_document_resource.params!.parse({ celexNumber: '32016r0679' }).celexNumber,
      ).toBe('32016R0679');
    });

    it('still rejects a whitespace-only value, which trims to empty', () => {
      expect(() => eurlex_document_resource.params!.parse({ celexNumber: '   ' })).toThrow();
    });

    it('hands the handler the normalized CELEX', async () => {
      const ctx = createMockContext({ tenantId: 'test-tenant' });
      mockQuery.mockResolvedValue([makeMetaBinding({ celex: '32016R0679' })]);

      const params = eurlex_document_resource.params!.parse({ celexNumber: ' 32016r0679 ' });
      await eurlex_document_resource.handler(params, ctx);

      expect(mockQuery.mock.calls[0]?.[0] as string).toContain(
        'cdm:resource_legal_id_celex "32016R0679"^^xsd:string .',
      );
    });
  });
});
