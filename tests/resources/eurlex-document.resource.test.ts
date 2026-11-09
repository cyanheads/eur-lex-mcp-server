/**
 * @fileoverview Tests for eurlex://document/{celexNumber} resource.
 * @module tests/resources/eurlex-document.resource.test
 */

import {
  JsonRpcErrorCode,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { createWorkerHandler } from '@cyanheads/mcp-ts-core/worker';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eurlex_document_resource } from '@/mcp-server/resources/definitions/eurlex-document.resource.js';
import { escapeSparqlLiteral } from '@/services/cellar-sparql/eli-resolution.js';
import {
  ACTS,
  fakeConsolidationCellar,
  isConsolidationLookup,
  isProcedureLookup,
  WORK,
} from '../fixtures/cellar-consolidations.js';
import {
  addressedWorks,
  agentRows,
  CELLAR,
  canonicalWork,
  celexWorkRows,
  fixtureWork,
  isResolutionQuery,
  resolutionRows,
} from '../fixtures/cellar-works.js';
import { queryRoles, roles } from '../helpers/query-roles.js';

/** The metadata queries every read sends after resolution (#96, #173). */
const READ_ROLES = ['core', 'citation', 'agents', 'legal_basis', 'eurovoc'] as const;

// Reserved per-request `_meta` keys of MCP protocol revision 2026-07-28.
const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_CAPABILITIES_META_KEY = 'io.modelcontextprotocol/clientCapabilities';
const CLIENT_INFO_META_KEY = 'io.modelcontextprotocol/clientInfo';

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
  return b;
}

/**
 * Resolve every CELEX to one work, return `creators` (authority code plus its English
 * label, when it has one) from the agent query, and a Regulation-typed row from every
 * other query.
 */
function mockAgents(creators: [code: string, label?: string][]): void {
  mockQuery.mockImplementation(async (sparql: string) => {
    if (isResolutionQuery(sparql)) return resolutionRows(sparql);
    if (sparql.includes('cdm:work_created_by_agent')) {
      return creators.map(([value, label]) => ({
        agent: { type: 'uri', value },
        role: { type: 'literal', value: 'creator' },
        ...(label ? { agentLabel: { type: 'literal', value: label } } : {}),
      }));
    }
    return [
      makeMetaBinding({
        celex: 'unused',
        type: 'http://publications.europa.eu/resource/authority/resource-type/REG',
      }),
    ];
  });
}

/** A resources/read response: the read's contents, or the error a client receives. */
interface WireRead {
  error?: {
    code: number;
    data?: { reason?: string; celexNumber?: string; recovery?: { hint?: string } };
  };
  result?: { contents: { text: string }[] };
}

const worker = createWorkerHandler({
  name: 'eur-lex-mcp-server',
  title: 'eur-lex-mcp-server',
  resources: [eurlex_document_resource],
});

/**
 * Read `uri` the way a client does: one resources/read request to the resource
 * served by the framework, which parses the URI's variables and fills a declared
 * `errors[]` entry's recovery into the error — neither of which a direct handler
 * call does.
 */
async function readOverWire(uri: string): Promise<WireRead> {
  const revision = '2026-07-28';
  const request = new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': revision,
      'mcp-method': 'resources/read',
      'mcp-name': uri,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'resources/read',
      params: {
        uri,
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: revision,
          [CLIENT_CAPABILITIES_META_KEY]: {},
          [CLIENT_INFO_META_KEY]: { name: 'test-client', version: '1.0.0' },
        },
      },
    }),
  });
  type FetchArgs = Parameters<typeof worker.fetch>;
  const response = await worker.fetch(
    request,
    {} as FetchArgs[1],
    { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as FetchArgs[2],
  );
  return (await response.json()) as WireRead;
}

describe('eurlex_document_resource', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  // --- Happy path ---

  it('returns metadata snapshot for a valid CELEX number', async () => {
    const ctx = createMockContext({
      tenantId: 'test-tenant',
      errors: eurlex_document_resource.errors,
    });
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

  it('reads CELLAR’s undated placeholder as no date, in the result and over the wire (#184)', async () => {
    mockQuery.mockResolvedValue([
      makeMetaBinding({ celex: '71995L0046BEL_101325', date: '1001-01-01', title: 'Loi' }),
    ]);

    const params = eurlex_document_resource.params!.parse({ celexNumber: '71995L0046BEL_101325' });
    const result = await eurlex_document_resource.handler(
      params,
      createMockContext({ tenantId: 'test-tenant', errors: eurlex_document_resource.errors }),
    );
    expect(result).toMatchObject({ celex_number: '71995L0046BEL_101325', title: 'Loi' });
    expect(result).not.toHaveProperty('date');

    const { result: read, error } = await readOverWire('eurlex://document/71995L0046BEL_101325');
    expect(error).toBeUndefined();
    const text = read?.contents[0]?.text ?? '';
    expect(JSON.parse(text)).toMatchObject({ celex_number: '71995L0046BEL_101325', title: 'Loi' });
    expect(text).not.toContain('1001-01-01');
  });

  // --- #67: legal basis and EuroVoc subjects resolve inline ---

  it('returns legal_basis with CELEX and eurovoc_subjects with English labels', async () => {
    const ctx = createMockContext({
      tenantId: 'test-tenant',
      errors: eurlex_document_resource.errors,
    });
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
    const ctx = createMockContext({
      tenantId: 'test-tenant',
      errors: eurlex_document_resource.errors,
    });
    mockQuery.mockImplementation(async (sparql: string) =>
      isResolutionQuery(sparql) ? resolutionRows(sparql) : [],
    );

    const params = eurlex_document_resource.params!.parse({ celexNumber: '12012E016' });
    const result = await eurlex_document_resource.handler(params, ctx);

    expect(result).not.toHaveProperty('legal_basis');
    expect(result).not.toHaveProperty('eurovoc_subjects');
  });

  // --- #35: metadata authorities resolve to human-readable labels ---

  it('resolves resource_type and author URIs to labels, matching eurlex_get_document', async () => {
    const ctx = createMockContext({
      tenantId: 'test-tenant',
      errors: eurlex_document_resource.errors,
    });
    const CB = 'http://publications.europa.eu/resource/authority/corporate-body';
    // A co-legislated act: the agent query returns one row per author. CONSIL is
    // first, so it is the primary — matching the tool's output for GDPR.
    mockAgents([
      [`${CB}/CONSIL`, 'Council of the European Union'],
      [`${CB}/EP`, 'European Parliament'],
    ]);

    const params = eurlex_document_resource.params!.parse({ celexNumber: '32016R0679' });
    const result = (await eurlex_document_resource.handler(params, ctx)) as Record<string, unknown>;

    // No raw authority URIs leak: type and author are human-readable labels.
    expect(result.resource_type).toBe('Regulation');
    expect(result.author_institution).toBe('Council of the European Union');
    expect(result.author_institutions).toEqual([
      'Council of the European Union',
      'European Parliament',
    ]);
    // The label fields are not overloaded with the raw URIs.
    expect(result.resource_type).not.toContain('http');
    expect(result.author_institution).not.toContain('http');
  });

  it.each([
    [
      '22026A00757',
      [
        ['corporate-body/EURUN', 'European Union'],
        ['corporate-body/EURUN', 'European Union'],
        ['country/AUT', 'Austria'],
      ],
      ['European Union', 'Austria'],
    ],
    ['71991L0683NLD_87862', [['country/NLD', 'Netherlands']], ['Netherlands']],
    [
      '91980E001013',
      [
        ['corporate-body/EP', 'European Parliament'],
        ['fd_013/VAN-MIERT', 'VAN MIERT'],
      ],
      ['European Parliament', 'VAN MIERT'],
    ],
    [
      '51988AC0454',
      [['corporate-body/EESC', 'European Economic and Social Committee']],
      ['European Economic and Social Committee'],
    ],
  ] as [string, [string, string][], string[]][])(
    '#103: %s names its authority-code authors by English label, once each',
    async (celex, codes, labels) => {
      const ctx = createMockContext({
        tenantId: 'test-tenant',
        errors: eurlex_document_resource.errors,
      });
      const AUTHORITY = 'http://publications.europa.eu/resource/authority/';
      mockAgents(codes.map(([code, label]) => [`${AUTHORITY}${code}`, label]));

      const params = eurlex_document_resource.params!.parse({ celexNumber: celex });
      const result = (await eurlex_document_resource.handler(params, ctx)) as Record<
        string,
        unknown
      >;

      expect(result.author_institutions).toEqual(labels);
      expect(result.author_institution).toBe(labels[0]);
    },
  );

  it('#103: renders an authority code with no English label as its last path segment', async () => {
    const ctx = createMockContext({
      tenantId: 'test-tenant',
      errors: eurlex_document_resource.errors,
    });
    mockAgents([['http://publications.europa.eu/resource/agent/UNLABELLED']]);

    const params = eurlex_document_resource.params!.parse({ celexNumber: '32024R2822' });
    const result = (await eurlex_document_resource.handler(params, ctx)) as Record<string, unknown>;

    expect(result.author_institutions).toEqual(['UNLABELLED']);
  });

  it('surfaces a single author as both the primary and the one-element institutions list', async () => {
    const ctx = createMockContext({
      tenantId: 'test-tenant',
      errors: eurlex_document_resource.errors,
    });
    const CB = 'http://publications.europa.eu/resource/authority/corporate-body';
    mockAgents([[`${CB}/COM`, 'European Commission']]);

    const params = eurlex_document_resource.params!.parse({ celexNumber: '32024R2822' });
    const result = (await eurlex_document_resource.handler(params, ctx)) as Record<string, unknown>;

    expect(result.author_institution).toBe('European Commission');
    expect(result.author_institutions).toEqual(['European Commission']);
  });

  it('returns sparse result when only required fields are present', async () => {
    const ctx = createMockContext({
      tenantId: 'test-tenant',
      errors: eurlex_document_resource.errors,
    });
    mockQuery.mockResolvedValue([makeMetaBinding({ celex: '32016R0679' })]);

    const params = eurlex_document_resource.params!.parse({ celexNumber: '32016R0679' });
    const result = await eurlex_document_resource.handler(params, ctx);

    expect((result as Record<string, unknown>).celex_number).toBe('32016R0679');
    expect((result as Record<string, unknown>).title).toBeUndefined();
    expect((result as Record<string, unknown>).date).toBeUndefined();
    expect((result as Record<string, unknown>).in_force).toBeUndefined();
  });

  it('converts inForce string binding to boolean correctly', async () => {
    const ctx = createMockContext({
      tenantId: 'test-tenant',
      errors: eurlex_document_resource.errors,
    });
    mockQuery.mockResolvedValue([makeMetaBinding({ celex: '32016R0679', inForce: 'false' })]);

    const params = eurlex_document_resource.params!.parse({ celexNumber: '32016R0679' });
    const result = await eurlex_document_resource.handler(params, ctx);

    expect((result as Record<string, unknown>).in_force).toBe(false);
  });

  // --- #20: CELLAR serializes xsd:boolean as the lexical "1"/"0" ---

  it('parses in_force from the xsd:boolean lexical "1"', async () => {
    const ctx = createMockContext({
      tenantId: 'test-tenant',
      errors: eurlex_document_resource.errors,
    });
    mockQuery.mockResolvedValue([makeMetaBinding({ celex: '32016R0679', inForce: '1' })]);

    const params = eurlex_document_resource.params!.parse({ celexNumber: '32016R0679' });
    const result = await eurlex_document_resource.handler(params, ctx);

    expect((result as Record<string, unknown>).in_force).toBe(true);
  });

  // --- Title traversal (issue #7) ---

  it('uses the expression-level title traversal, not the obsolete work_title pattern', async () => {
    const ctx = createMockContext({
      tenantId: 'test-tenant',
      errors: eurlex_document_resource.errors,
    });
    mockQuery.mockResolvedValue([
      makeMetaBinding({ celex: '32016R0679', title: 'General Data Protection Regulation' }),
    ]);

    const params = eurlex_document_resource.params!.parse({ celexNumber: '32016R0679' });
    const result = await eurlex_document_resource.handler(params, ctx);

    expect((result as Record<string, unknown>).title).toBe('General Data Protection Regulation');
    const sparql = mockQuery.mock.calls
      .map((c) => c[0] as string)
      .find((q) => q.includes('cdm:expression_title')) as string;
    expect(sparql).toContain('cdm:expression_belongs_to_work');
    expect(sparql).toContain('cdm:expression_title');
    expect(sparql).not.toContain('cdm:work_title');
  });

  // --- Error path: not found ---

  it('throws notFound when CELEX resolves to no bindings', async () => {
    const ctx = createMockContext({
      tenantId: 'test-tenant',
      errors: eurlex_document_resource.errors,
    });
    mockQuery.mockResolvedValue([]);

    const params = eurlex_document_resource.params!.parse({ celexNumber: '99999X0000' });
    await expect(eurlex_document_resource.handler(params, ctx)).rejects.toThrow('No CELLAR work');
  });

  it('fails a missing CELEX as its declared not_found, with a recovery naming the lookup tool', async () => {
    mockQuery.mockResolvedValue([]);

    const { error } = await readOverWire('eurlex://document/99999X0000');

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'not_found', celexNumber: '99999X0000' },
    });
    expect(error?.data?.recovery?.hint).toContain('eurlex_lookup_celex');
  });

  describe('#196 a CELEX one numbering convention away from a held CELEX', () => {
    const literal = (value: string) => ({ type: 'literal', value });

    /**
     * CELLAR holding no work for the CELEX read, answering the base-act query with
     * `bases`; every other query, the consolidation lookup beside the resolution
     * included, finds nothing.
     */
    const routeMiss = (bases: Record<string, { type: string; value: string }>[]) =>
      mockQuery.mockImplementation(async (q: string) =>
        q.includes('VALUES ?baseCelex') ? bases : [],
      );

    const queries = () => mockQuery.mock.calls.map((c) => c[0] as string);
    const isHeldQuery = (q: string) =>
      q.includes('VALUES ?baseCelex') || q.includes('VALUES ?heldCelex');

    type MissRead = {
      error?: {
        code: number;
        data?: { celexNumber?: string; held_celex?: string[]; reason?: string };
        message: string;
      };
    };

    it('names each held CELEX in the message and data.held_celex beside celexNumber', async () => {
      routeMiss([
        {
          baseCelex: literal('32006R1907'),
          baseWorkUri: literal(`${CELLAR}32006R1907`),
          carriesCore: literal('1'),
          current: literal('2026-06-22|02006R1907-20260622'),
          inEffect: literal('2025-10-23|02006R1907-20251023'),
        },
      ]);

      const { error } = (await readOverWire('eurlex://document/02006R1907-20260101')) as MissRead;

      expect(error?.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error?.data).toMatchObject({
        reason: 'not_found',
        celexNumber: '02006R1907-20260101',
        held_celex: ['02006R1907-20251023', '02006R1907-20260622'],
      });
      expect(error?.message).toBe(
        'No CELLAR work found for CELEX: 02006R1907-20260101. CELLAR holds 02006R1907-20251023, the consolidated version of 32006R1907 in effect on 2026-01-01, and 02006R1907-20260622, its current one.',
      );
      // One held query beside the resolution and the consolidation lookup it runs with.
      expect(queries().filter(isHeldQuery)).toHaveLength(1);
      expect(queryRoles(queries().filter((q) => !isHeldQuery(q)))).toEqual(
        roles('resolution', 'consolidation'),
      );
    });

    it('keeps the not_found of a CELEX whose forms CELLAR does not hold', async () => {
      routeMiss([]);

      const { error } = (await readOverWire('eurlex://document/52026AG9999')) as MissRead;

      expect(error?.message).toBe('No CELLAR work found for CELEX: 52026AG9999');
      expect(error?.data).toMatchObject({ reason: 'not_found', celexNumber: '52026AG9999' });
      expect(error?.data).not.toHaveProperty('held_celex');
    });
  });

  it.each([
    [
      'sparql_error',
      JsonRpcErrorCode.ValidationError,
      () =>
        validationError('CELLAR SPARQL error: Virtuoso 37000 Error SQ156: compiler error', {
          reason: 'sparql_error',
          retryable: false,
        }),
    ],
    [
      'sparql_timeout',
      JsonRpcErrorCode.ServiceUnavailable,
      () =>
        serviceUnavailable('CELLAR SPARQL query timed out on Virtuoso', {
          reason: 'sparql_timeout',
          retryable: false,
        }),
    ],
  ])(
    'fails a CELLAR %s with a recovery through eurlex_get_document',
    async (reason, code, failure) => {
      mockQuery.mockRejectedValue(failure());

      const { error } = await readOverWire('eurlex://document/32016R0679');

      expect(error).toMatchObject({ code, data: { reason } });
      const hint = error?.data?.recovery?.hint;
      expect(hint).toContain('eurlex_get_document');
      expect(hint).toContain('content_mode "metadata_only"');
    },
  );

  // --- #61: SPARQL literal escaping routes through the shared helper ---
  //
  // The former hand-rolled `celexNumber.replace(/"/g, '\\"')` was a quote-only
  // pass with no backslash pass. A CELEX ending in `\` then escaped the closing
  // quote, the literal never terminated, and Virtuoso's raw SP030 compiler error
  // — carrying the internal query text and PREFIX block — reached the client in
  // place of this resource's own not_found.

  it('escapes a trailing backslash so the SPARQL literal terminates (#61)', async () => {
    const ctx = createMockContext({
      tenantId: 'test-tenant',
      errors: eurlex_document_resource.errors,
    });
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
      `VALUES ?celexNumber { "${escapeSparqlLiteral(celexNumber)}"^^xsd:string }`,
    );
    // The unterminated form the quote-only pass produced is gone.
    expect(sparql).not.toContain(String.raw`"32016R0679\"^^`);
  });

  it('escapes an embedded quote-and-backslash sequence (#61)', async () => {
    const ctx = createMockContext({
      tenantId: 'test-tenant',
      errors: eurlex_document_resource.errors,
    });
    mockQuery.mockResolvedValue([]);

    const celexNumber = '32016R0679\\" x';
    expect(() => eurlex_document_resource.params!.parse({ celexNumber })).toThrow();
    await expect(eurlex_document_resource.handler({ celexNumber }, ctx)).rejects.toThrow(
      'No CELLAR work',
    );

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sparql).toContain(
      `VALUES ?celexNumber { "${escapeSparqlLiteral(celexNumber)}"^^xsd:string }`,
    );
    // Every backslash and quote from the input is escaped, so the only unescaped
    // double quotes in the literal are its own delimiters.
    expect(sparql).not.toContain(String.raw`"32016R0679\\" x"^^`);
  });

  it('leaves an ordinary CELEX byte-identical through the shared helper (#61)', async () => {
    const ctx = createMockContext({
      tenantId: 'test-tenant',
      errors: eurlex_document_resource.errors,
    });
    mockQuery.mockResolvedValue([makeMetaBinding({ celex: '32016R0679' })]);

    const params = eurlex_document_resource.params!.parse({ celexNumber: '32016R0679' });
    await eurlex_document_resource.handler(params, ctx);

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    // No regression for the overwhelmingly common input: escaping is a no-op.
    expect(sparql).toContain('VALUES ?celexNumber { "32016R0679"^^xsd:string }');
  });

  // --- #92 / #97: the typed CELEX resolves once; metadata keys on the work ---

  it('types the CELEX in the resolution and keys all five metadata queries on the resolved work', async () => {
    const ctx = createMockContext({
      tenantId: 'test-tenant',
      errors: eurlex_document_resource.errors,
    });
    mockQuery.mockImplementation(async (q: string) =>
      isResolutionQuery(q) ? resolutionRows(q) : [makeMetaBinding({ celex: '62012CJ0131' })],
    );

    const params = eurlex_document_resource.params!.parse({ celexNumber: '62012CJ0131' });
    const result = (await eurlex_document_resource.handler(params, ctx)) as Record<string, unknown>;

    const queries = mockQuery.mock.calls.map((c) => c[0] as string);
    expect(queryRoles(queries)).toEqual(roles('resolution', ...READ_ROLES));
    expect(queries[0]).toContain('VALUES ?celexNumber { "62012CJ0131"^^xsd:string }');
    const work = `<${CELLAR}62012CJ0131>`;
    for (const q of queries.slice(1)) {
      expect(q).toContain(work);
      expect(q).not.toContain('"62012CJ0131"');
    }
    expect(queries.join('\n')).not.toMatch(/STR\(\?\w+\)\s*=/);
    expect(result.celex_number).toBe('62012CJ0131');
    expect(result.work_uri).toBe(`${CELLAR}62012CJ0131`);
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

    it.each(['CELEX:32016R0679', 'celex:32016r0679', 'CELEX%3A32016R0679'])(
      'reads eurlex://document/%s as the CELEX it prefixes (#147)',
      async (celexNumber) => {
        mockQuery.mockImplementation(async (q: string) =>
          isResolutionQuery(q) ? resolutionRows(q) : [],
        );

        const { result, error } = await readOverWire(`eurlex://document/${celexNumber}`);

        expect(error).toBeUndefined();
        expect(JSON.parse(result?.contents[0]?.text ?? '{}')).toMatchObject({
          celex_number: '32016R0679',
          work_uri: `${CELLAR}32016R0679`,
        });
      },
    );

    it('still rejects a whitespace-only value, which trims to empty', () => {
      expect(() => eurlex_document_resource.params!.parse({ celexNumber: '   ' })).toThrow();
    });

    it('hands the handler the normalized CELEX', async () => {
      const ctx = createMockContext({
        tenantId: 'test-tenant',
        errors: eurlex_document_resource.errors,
      });
      mockQuery.mockResolvedValue([makeMetaBinding({ celex: '32016R0679' })]);

      const params = eurlex_document_resource.params!.parse({ celexNumber: ' 32016r0679 ' });
      await eurlex_document_resource.handler(params, ctx);

      expect(mockQuery.mock.calls[0]?.[0] as string).toContain(
        'VALUES ?celexNumber { "32016R0679"^^xsd:string }',
      );
    });
  });

  // --- #97 / #96: resolved work and its agents, against a CELLAR-shaped fake ---

  describe('fixture works (#97, #96)', () => {
    type Row = Record<string, { type: string; value: string }>;
    const T181_COPY = fixtureWork('62022TJ0181', 0);

    /** Answer every query the handler issues from the fixture works it addresses. */
    const fakeCellar = async (q: string): Promise<Row[]> => {
      const works = addressedWorks(q);
      if (q.includes('cdm:case-law_delivered_by_advocate-general')) return agentRows(q);
      if (q.includes('cdm:resource_legal_based_on_resource_legal')) return [];
      if (q.includes('cdm:work_is_about_concept_eurovoc')) {
        return works.map(({ work }) => ({
          eurovoc: {
            type: 'uri',
            value: work.canonical
              ? 'http://eurovoc.europa.eu/canonical'
              : 'http://eurovoc.europa.eu/copy-only',
          },
        }));
      }
      if (q.includes('cdm:work_has_resource-type')) {
        const authors = q.includes('cdm:work_created_by_agent') ? agentRows(q) : [{}];
        return works.flatMap(({ celex, work }) =>
          authors.map((author) => ({
            work: { type: 'uri', value: work.uri },
            celexNumber: { type: 'literal', value: celex },
            ...author,
          })),
        );
      }
      return celexWorkRows(q);
    };

    const read = async (celexNumber: string) => {
      mockQuery.mockImplementation(fakeCellar);
      const params = eurlex_document_resource.params!.parse({ celexNumber });
      return (await eurlex_document_resource.handler(
        params,
        createMockContext({ tenantId: 'test-tenant', errors: eurlex_document_resource.errors }),
      )) as Record<string, unknown>;
    };

    it('#97: resolves 62022TJ0181 to its canonical work and reads its subjects alone', async () => {
      const result = await read('62022TJ0181');

      expect(result.work_uri).toBe(canonicalWork('62022TJ0181'));
      expect(result.work_uri).not.toBe(T181_COPY);
      expect(result.eurovoc_subjects).toEqual([
        { concept_uri: 'http://eurovoc.europa.eu/canonical' },
      ]);
    });

    it('#96: 62012CJ0131 names the court as author and its Advocate General separately', async () => {
      const result = await read('62012CJ0131');

      expect(result.work_uri).toBe(canonicalWork('62012CJ0131'));
      expect(result.author_institution).toBe('Court of Justice');
      expect(result.author_institutions).toEqual(['Court of Justice']);
      expect(result.advocates_general).toEqual(['Jääskinen']);
      expect(JSON.stringify(result)).not.toContain('233d79cc');
    });

    it('#96: an AG-only author leaves no author_institution; the AG is listed', async () => {
      const result = await read('62024CC0505');

      expect(result).not.toHaveProperty('author_institution');
      expect(result).not.toHaveProperty('author_institutions');
      expect(result.advocates_general).toEqual(['Biondi']);
    });

    it('#96: a national-court decision names the court', async () => {
      const result = await read('82003PT1111(51)');

      expect(result.author_institutions).toEqual(['Supremo Tribunal de Justiça']);
      expect(result).not.toHaveProperty('advocates_general');
    });

    it('#96: lists every Advocate General of a work with several', async () => {
      const result = await read('61983CJ0271');
      expect(result.advocates_general).toEqual(['Mischo', 'VerLoren van Themaat']);
    });

    it('#96: leaves a co-legislated act unchanged and without advocates_general', async () => {
      const result = await read('32016R0679');

      expect(result.author_institution).toBe('Council of the European Union');
      expect(result.author_institutions).toEqual([
        'Council of the European Union',
        'European Parliament',
      ]);
      expect(result).not.toHaveProperty('advocates_general');
    });
  });

  // --- Consolidated texts (#110) ---

  describe('consolidated texts (#110)', () => {
    const read = async (celex: string) => {
      mockQuery.mockImplementation(fakeConsolidationCellar);
      const ctx = createMockContext({ errors: eurlex_document_resource.errors });
      const params = eurlex_document_resource.params!.parse({ celexNumber: celex });
      return (await eurlex_document_resource.handler(params, ctx)) as Record<string, unknown>;
    };

    it("reads a consolidated text's authors, in-force status, subjects, and legal bases from its base act", async () => {
      const result = await read('02024R1689-20260727');

      expect(result.base_act_celex).toBe('32024R1689');
      expect(result.author_institutions).toEqual(
        expect.arrayContaining(['European Parliament', 'Council of the European Union']),
      );
      expect(result.author_institutions).toHaveLength(2);
      expect(result.in_force).toBe(true);
      expect(result.eurovoc_subjects).toHaveLength(7);
      expect(result.legal_basis).toHaveLength(2);
      expect(JSON.stringify(result)).not.toContain('OP_DATPRO');
      expect(JSON.stringify(result)).not.toContain('Provisional data');
    });

    it('#103: a consolidated text with no based-on link names its own author by label', async () => {
      const result = await read('02099R9999-20200101');

      expect(result).not.toHaveProperty('base_act_celex');
      expect(result.author_institutions).toEqual(['Provisional data']);
    });

    it('leaves a base act unchanged, with no base_act_celex and no lookup', async () => {
      const result = await read('32024R1689');

      expect(result).not.toHaveProperty('base_act_celex');
      expect(result.work_uri).toBe(WORK.aiAct);
      const queries = mockQuery.mock.calls.map((c) => c[0] as string);
      expect(queryRoles(queries)).toEqual(roles('resolution', ...READ_ROLES, 'procedures'));
    });

    it('runs the base lookup concurrently with CELEX resolution for a sector-0 CELEX', async () => {
      let markLookup!: () => void;
      const lookupIssued = new Promise<void>((resolve) => {
        markLookup = resolve;
      });
      mockQuery.mockImplementation(async (q: string) => {
        if (isConsolidationLookup(q)) markLookup();
        if (isResolutionQuery(q)) {
          await Promise.race([
            lookupIssued,
            new Promise((_, reject) =>
              setTimeout(
                () => reject(new Error('lookup was not issued alongside resolution')),
                200,
              ),
            ),
          ]);
        }
        return fakeConsolidationCellar(q);
      });

      const params = eurlex_document_resource.params!.parse({ celexNumber: '02024R1689-20240712' });
      const result = (await eurlex_document_resource.handler(
        params,
        createMockContext({ errors: eurlex_document_resource.errors }),
      )) as Record<string, unknown>;
      expect(result.base_act_celex).toBe('32024R1689');
    });

    it('keeps a consolidated text under its own CELEX, work, title, date, and type', async () => {
      const result = await read('02024R1689-20260727');

      expect(result.celex_number).toBe('02024R1689-20260727');
      expect(result.work_uri).toBe(ACTS['02024R1689-20260727']?.uri);
      expect(result.title).toBe('Consolidated text of 2026-07-27');
      expect(result.date).toBe('2026-07-27');
      expect(result.resource_type).toBe('Consolidated Text');
    });
  });

  // --- #169: the citation facts, read as eurlex_get_document reads them ---

  describe('citation facts (#169)', () => {
    const read = async (celex: string) => {
      mockQuery.mockImplementation(fakeConsolidationCellar);
      const ctx = createMockContext({ errors: eurlex_document_resource.errors });
      const params = eurlex_document_resource.params!.parse({ celexNumber: celex });
      return (await eurlex_document_resource.handler(params, ctx)) as Record<string, unknown>;
    };

    const FIELDS = ['eli', 'oj_reference', 'dates_of_effect', 'transposition_deadlines'];
    // Three of its application dates are partial, each set by a point of Article 113 (#181).
    const AI_ACT_DATES = [
      { date: '2024-08-01', type: 'entry_into_force', provision: 'Article 113' },
      { date: '2025-02-02', type: 'partial_application', provision: 'Article 113(a)' },
      { date: '2025-08-02', type: 'partial_application', provision: 'Article 113(b)' },
      { date: '2026-08-02', type: 'application', provision: 'Article 113' },
      { date: '2027-08-02', type: 'partial_application', provision: 'Article 113(c)' },
    ];

    it.each<[string, Record<string, unknown>]>([
      [
        '32019L1937',
        {
          eli: 'http://data.europa.eu/eli/dir/2019/1937/oj',
          oj_reference: 'OJ L 305, 26.11.2019, p. 17–56',
          dates_of_effect: [{ date: '2019-12-16', type: 'entry_into_force' }],
          transposition_deadlines: ['2021-12-17', '2023-12-17'],
        },
      ],
      [
        '32024R1689',
        {
          eli: 'http://data.europa.eu/eli/reg/2024/1689/oj',
          oj_reference: 'OJ L, 2024/1689, 12.7.2024',
          dates_of_effect: AI_ACT_DATES,
        },
      ],
      // The v0.20.0 output of four more acts, as read live on 2026-11-03.
      [
        '32016R0679',
        {
          eli: 'http://data.europa.eu/eli/reg/2016/679/oj',
          oj_reference: 'OJ L 119, 4.5.2016, p. 1–88',
          dates_of_effect: [
            { date: '2016-05-24', type: 'entry_into_force' },
            { date: '2018-05-25', type: 'application' },
          ],
        },
      ],
      [
        '32022L2555',
        {
          eli: 'http://data.europa.eu/eli/dir/2022/2555/oj',
          oj_reference: 'OJ L 333, 27.12.2022, p. 80–152',
          dates_of_effect: [{ date: '2023-01-16', type: 'entry_into_force' }],
          transposition_deadlines: ['2024-10-17', '2024-10-18'],
        },
      ],
      [
        '31962R0017',
        {
          eli: 'http://data.europa.eu/eli/reg/1962/17/oj',
          oj_reference: 'OJ 13, 21.2.1962, p. 204–211',
          dates_of_effect: [{ date: '1962-03-13', type: 'entry_into_force' }],
        },
      ],
      ['12001C', { oj_reference: 'OJ C 80, 10.3.2001' }],
      /*
       * Consolidated texts: the ELI is the served text's own, the other three its
       * base act's — the fixture answers each pattern from the work it names.
       */
      [
        '01995L0046-20180525',
        {
          oj_reference: 'OJ L 281, 23.11.1995, p. 31–50',
          dates_of_effect: [{ date: '1995-12-13', type: 'entry_into_force' }],
          transposition_deadlines: ['1998-10-24'],
        },
      ],
      [
        '02024R1689-20260727',
        { oj_reference: 'OJ L, 2024/1689, 12.7.2024', dates_of_effect: AI_ACT_DATES },
      ],
      [
        '02016R0679-20160504',
        {
          eli: 'http://data.europa.eu/eli/reg/2016/679/2016-05-04',
          oj_reference: 'OJ L 119, 4.5.2016, p. 1–88',
          dates_of_effect: [
            { date: '2016-05-24', type: 'entry_into_force' },
            { date: '2018-05-25', type: 'application' },
          ],
        },
      ],
      ['52012PC0011', {}],
    ])('%s returns the citation facts eurlex_get_document returns', async (celex, expected) => {
      const result = await read(celex);
      const facts = Object.fromEntries(
        FIELDS.filter((f) => f in result).map((f) => [f, result[f]]),
      );
      expect(facts).toEqual(expected);
    });

    it('reads the facts with their own query, beside an ungrouped core query (#173)', async () => {
      const result = await read('32016R0679');
      expect(result.oj_reference).toBe('OJ L 119, 4.5.2016, p. 1–88');
      const queries = mockQuery.mock.calls.map((c) => c[0] as string);
      expect(queryRoles(queries)).toEqual(roles('resolution', ...READ_ROLES, 'procedures'));
      const core = queries.find((q) => q.includes('cdm:work_has_resource-type')) as string;
      for (const pattern of [
        'GROUP BY',
        'cdm:resource_legal_eli',
        'type_of_date',
        'official-journal',
        'AS ?datesOfEffect)',
      ]) {
        expect(core).not.toContain(pattern);
      }
      const citation = queries.find((q) => q.includes('AS ?datesOfEffect)')) as string;
      expect(citation).not.toContain('GROUP BY');
      expect(citation).not.toContain('cdm:work_has_resource-type');
    });

    it.each([
      ['core', 'cdm:work_has_resource-type'],
      ['citation', 'AS ?datesOfEffect)'],
      ['procedure', 'cdm:procedure_code_interinstitutional_reference_procedure'],
    ])('propagates a caller cancellation raised by the %s query', async (_label, marker) => {
      mockQuery.mockImplementation((q: string) =>
        q.includes(marker)
          ? Promise.reject(new DOMException('The operation was aborted.', 'AbortError'))
          : fakeConsolidationCellar(q),
      );
      const params = eurlex_document_resource.params!.parse({ celexNumber: '32016R0679' });
      await expect(
        eurlex_document_resource.handler(
          params,
          createMockContext({ errors: eurlex_document_resource.errors }),
        ),
      ).rejects.toThrow(/aborted/);
      expect(mockQuery.mock.calls.some(([q]) => (q as string).includes(marker))).toBe(true);
    });
  });

  // --- #187: CELLAR's no-date values, dropped as eurlex_get_document drops them ---

  describe('no-date values (#187)', () => {
    const read = async (celex: string) => {
      mockQuery.mockImplementation(fakeConsolidationCellar);
      const ctx = createMockContext({ errors: eurlex_document_resource.errors });
      const params = eurlex_document_resource.params!.parse({ celexNumber: celex });
      return (await eurlex_document_resource.handler(params, ctx)) as Record<string, unknown>;
    };

    it.each<[string, Record<string, unknown>]>([
      [
        '32017R0745',
        {
          dates_of_effect: [
            { date: '2017-05-25', type: 'entry_into_force', provision: 'Article 123.1' },
            { date: '2017-11-26', type: 'partial_application' },
            { date: '2018-05-26', type: 'partial_application', provision: 'Article 123.3(c)' },
            { date: '2019-05-26', type: 'partial_application', provision: 'Article 123.3(i)' },
            { date: '2020-04-24', type: 'partial_application', provision: 'Article 123.3(j)' },
            { date: '2021-05-26', type: 'application', provision: 'Article 123.2' },
            { date: '2021-05-26', type: 'partial_application' },
            { date: '2023-05-26', type: 'partial_application' },
            { date: '2025-05-26', type: 'partial_application' },
            { date: '2027-05-26', type: 'partial_application', provision: 'Article 123.3(g)' },
          ],
        },
      ],
      [
        '32016L0802',
        {
          dates_of_effect: [
            { date: '2016-06-10', type: 'entry_into_force', provision: 'Article 20' },
          ],
        },
      ],
      [
        '32025L0872',
        {
          dates_of_effect: [
            { date: '2025-05-07', type: 'entry_into_force', provision: 'Article 3' },
          ],
          transposition_deadlines: ['2025-12-31', '2026-01-01', '2027-12-31', '2028-01-01'],
        },
      ],
      ['31980D0032', {}],
    ])('%s lists real dates only', async (celex, expected) => {
      const result = await read(celex);
      const facts = Object.fromEntries(
        ['dates_of_effect', 'transposition_deadlines']
          .filter((f) => f in result)
          .map((f) => [f, result[f]]),
      );
      expect(facts).toEqual(expected);
      expect(JSON.stringify(result)).not.toMatch(/1001-01-01|1002-02-02/);
    });

    it('sends no query for the amending acts of a date-setting article (#188)', async () => {
      await read('32024R1689');
      expect(queryRoles(mockQuery.mock.calls.map((c) => c[0] as string))).toEqual(
        roles('resolution', ...READ_ROLES, 'procedures'),
      );
    });
  });

  // --- #180: the legislative procedures, read as eurlex_get_document reads them ---

  describe('legislative procedures (#180)', () => {
    const read = async (celex: string) => {
      mockQuery.mockImplementation(fakeConsolidationCellar);
      const ctx = createMockContext({ errors: eurlex_document_resource.errors });
      const params = eurlex_document_resource.params!.parse({ celexNumber: celex });
      return (await eurlex_document_resource.handler(params, ctx)) as Record<string, unknown>;
    };
    const sent = () => mockQuery.mock.calls.map((c) => c[0] as string);

    it.each([
      [
        '52017PC0010',
        [{ reference: '2017/0003(COD)', status: 'withdrawn', withdrawal_date: '2025-10-06' }],
      ],
      [
        '32024R1689',
        [{ reference: '2021/0106(COD)', status: 'adopted', adopted_acts: ['32024R1689'] }],
      ],
      [
        '52023PC0331',
        [
          { reference: '2018/0135(CNS)', status: 'adopted', adopted_acts: ['32020D2053'] },
          { reference: '2021/0430(CNS)', status: 'pending' },
        ],
      ],
      /** A consolidated text carries its base act's. */
      [
        '02016R0679-20160504',
        [{ reference: '2012/0011(COD)', status: 'adopted', adopted_acts: ['32016R0679'] }],
      ],
    ])('%s returns the procedures eurlex_get_document returns', async (celex, procedures) => {
      const result = await read(celex);
      expect(result.procedures).toEqual(procedures);
    });

    it('a consolidated text sends one added query, keyed on its base act', async () => {
      await read('02016R0679-20160504');
      expect(queryRoles(sent())).toEqual(
        roles('resolution', 'consolidation', ...READ_ROLES, 'procedures'),
      );
      expect(sent().find(isProcedureLookup)).toContain(
        `<${WORK.gdpr}> cdm:work_part_of_dossier ?procedure .`,
      );
    });

    it('31962R0017 belongs to no procedure and carries no procedures field', async () => {
      const result = await read('31962R0017');
      expect(result).not.toHaveProperty('procedures');
      expect(sent().filter(isProcedureLookup)).toHaveLength(1);
    });

    it('case law sends no procedure query and carries no procedures field', async () => {
      const result = await read('62012CJ0131');
      expect(result).not.toHaveProperty('procedures');
      expect(queryRoles(sent())).toEqual(roles('resolution', ...READ_ROLES));
    });
  });
});
