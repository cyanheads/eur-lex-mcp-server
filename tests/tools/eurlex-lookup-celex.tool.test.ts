/**
 * @fileoverview Tests for eurlex_lookup_celex tool.
 * @module tests/tools/eurlex-lookup-celex.tool.test
 */

import type { z } from '@cyanheads/mcp-ts-core';
import {
  JsonRpcErrorCode,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eurlex_lookup_celex } from '@/mcp-server/tools/definitions/eurlex-lookup-celex.tool.js';
import { escapeSparqlLiteral } from '@/services/cellar-sparql/eli-resolution.js';
import { CELEX_WORKS, CELLAR, canonicalWork, celexWorkRows } from '../fixtures/cellar-works.js';
import { readCommonMark } from '../helpers/commonmark.js';
import { bestCpuMs, CPU_TIMED_TEST_TIMEOUT_MS } from '../helpers/cpu-time.js';

// --- Service mock ---
const mockQuery = vi.fn();
vi.mock('@/services/cellar-sparql/cellar-sparql-service.js', () => ({
  getCellarSparqlService: () => ({ query: mockQuery }),
  CellarSparqlService: {
    bindingValue: (binding: Record<string, { value?: string }> | undefined, field: string) =>
      binding?.[field]?.value,
  },
}));

/**
 * A lookup row. `canonical` binds `?canonicalAlias`, as CELLAR does on the work that
 * is `owl:sameAs` the CELEX's alias IRI.
 */
function makeBinding(
  celex: string,
  opts: { workUri?: string; type?: string; date?: string; ecli?: string; canonical?: boolean } = {},
): Record<string, { type: string; value: string }> {
  return {
    celexNumber: { type: 'literal', value: celex },
    work: {
      type: 'uri',
      value: opts.workUri ?? `http://publications.europa.eu/resource/cellar/${celex}`,
    },
    ...(opts.type ? { type: { type: 'uri', value: opts.type } } : {}),
    ...(opts.date ? { date: { type: 'literal', value: opts.date } } : {}),
    ...(opts.ecli ? { ecli: { type: 'literal', value: opts.ecli } } : {}),
    ...(opts.canonical
      ? {
          canonicalAlias: {
            type: 'uri',
            value: `http://publications.europa.eu/resource/celex/${celex}`,
          },
        }
      : {}),
  };
}

const RESOURCE_TYPE = 'http://publications.europa.eu/resource/authority/resource-type/';

describe('eurlex_lookup_celex', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  // --- Happy paths ---

  it('resolves a CELEX number to a work', async () => {
    const ctx = createMockContext({ errors: eurlex_lookup_celex.errors });
    mockQuery.mockResolvedValue([
      makeBinding('32016R0679', {
        type: 'http://publications.europa.eu/resource/authority/resource-type/REG',
        date: '2016-04-27',
      }),
    ]);

    const input = eurlex_lookup_celex.input.parse({ identifier: '32016R0679' });
    const result = await eurlex_lookup_celex.handler(input, ctx);

    expect(result.found).toBe(true);
    expect(result.celex_number).toBe('32016R0679');
    expect(result.date).toBe('2016-04-27');
  });

  it('reads CELLAR’s undated placeholder as no date on both surfaces (#184)', async () => {
    mockQuery.mockResolvedValue([
      makeBinding('71995L0046BEL_101325', { date: '1001-01-01', canonical: true }),
    ]);

    const result = await runToolContract(eurlex_lookup_celex, {
      identifier: '71995L0046BEL_101325',
    });

    expect(result.isError).toBeFalsy();
    const structured = eurlex_lookup_celex.output.parse(result.structuredContent);
    expect(structured).toMatchObject({ found: true, celex_number: '71995L0046BEL_101325' });
    expect(structured.date).toBeUndefined();
    const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(text).toContain('**CELEX:**');
    expect(text).not.toContain('**Date:**');
    expect(text).not.toContain('1001-01-01');
  });

  describe('resource_type label (#58)', () => {
    it('resolves a mapped CDM resource-type URI to its label on both surfaces', async () => {
      const ctx = createMockContext({ errors: eurlex_lookup_celex.errors });
      mockQuery.mockResolvedValue([
        makeBinding('32016R0679', {
          type: 'http://publications.europa.eu/resource/authority/resource-type/REG',
        }),
      ]);

      const input = eurlex_lookup_celex.input.parse({ identifier: '32016R0679' });
      const result = await eurlex_lookup_celex.handler(input, ctx);

      expect(result.resource_type).toBe('Regulation');
      const text = (eurlex_lookup_celex.format!(result)[0] as { text: string }).text;
      expect(text).toContain('**Type:** Regulation');
      expect(text).not.toContain('resource-type/REG');
    });

    it('labels a consolidated text rather than exposing its authority code (#86)', async () => {
      const ctx = createMockContext({ errors: eurlex_lookup_celex.errors });
      mockQuery.mockResolvedValue([
        makeBinding('02016R0679-20160504', {
          type: 'http://publications.europa.eu/resource/authority/resource-type/CONS_TEXT',
        }),
      ]);

      const input = eurlex_lookup_celex.input.parse({ identifier: '02016R0679-20160504' });
      const result = await eurlex_lookup_celex.handler(input, ctx);

      // CONS_TEXT is what every consolidated CELEX resolves to, so the raw code was
      // the common answer here, not a long-tail one.
      expect(result.resource_type).toBe('Consolidated Text');
      expect(result.resource_type).not.toBe('CONS_TEXT');
    });

    it('falls back to the authority code for an unmapped resource-type URI', async () => {
      const ctx = createMockContext({ errors: eurlex_lookup_celex.errors });
      // A type CELLAR adds after the label map was written (fabricated here) keeps
      // its code, so an unlabelled type still resolves to something.
      mockQuery.mockResolvedValue([
        makeBinding('32015B0367', {
          type: 'http://publications.europa.eu/resource/authority/resource-type/NEW_TYPE_2099',
        }),
      ]);

      const input = eurlex_lookup_celex.input.parse({ identifier: '32015B0367' });
      const result = await eurlex_lookup_celex.handler(input, ctx);

      expect(result.resource_type).toBe('NEW_TYPE_2099');
    });

    it('omits resource_type when the work carries none', async () => {
      const ctx = createMockContext({ errors: eurlex_lookup_celex.errors });
      mockQuery.mockResolvedValue([makeBinding('32016R0679')]);

      const input = eurlex_lookup_celex.input.parse({ identifier: '32016R0679' });
      const result = await eurlex_lookup_celex.handler(input, ctx);

      expect(result.resource_type).toBeUndefined();
      expect((eurlex_lookup_celex.format!(result)[0] as { text: string }).text).not.toContain(
        '**Type:**',
      );
    });
  });

  it('auto-detects CELEX format when identifier_type is "auto"', async () => {
    const ctx = createMockContext({ errors: eurlex_lookup_celex.errors });
    mockQuery.mockResolvedValue([makeBinding('32016R0679')]);

    const input = eurlex_lookup_celex.input.parse({
      identifier: '32016R0679',
      identifier_type: 'auto',
    });
    const result = await eurlex_lookup_celex.handler(input, ctx);

    expect(result.found).toBe(true);
    // Auto-detected as celex; SPARQL should filter by exact CELEX string
    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sparql).toContain('32016R0679');
  });

  it('resolves an ELI URI to the same work and CELEX as the CELEX lookup', async () => {
    const ctx = createMockContext({ errors: eurlex_lookup_celex.errors });
    const gdprWork =
      'http://publications.europa.eu/resource/cellar/3e485e15-11bd-11e6-ba9a-01aa75ed71a1';
    mockQuery.mockResolvedValue([
      makeBinding('32016R0679', {
        workUri: gdprWork,
        type: 'http://publications.europa.eu/resource/authority/resource-type/REG',
        date: '2016-04-27',
      }),
    ]);

    const input = eurlex_lookup_celex.input.parse({
      identifier: 'http://data.europa.eu/eli/reg/2016/679/oj',
      identifier_type: 'auto',
    });
    const result = await eurlex_lookup_celex.handler(input, ctx);

    // Auto-detected as ELI; resolves to GDPR's canonical work + CELEX.
    expect(result.found).toBe(true);
    expect(result.work_uri).toBe(gdprWork);
    expect(result.celex_number).toBe('32016R0679');

    // ELI branch exact-matches cdm:resource_legal_eli as an xsd:anyURI literal,
    // not the old broken work-URI substring scan.
    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sparql).toContain('cdm:resource_legal_eli');
    expect(sparql).toContain('"http://data.europa.eu/eli/reg/2016/679/oj"^^xsd:anyURI');
    expect(sparql).not.toContain('CONTAINS(STR(?work)');
  });

  it('resolves a bare work-level ELI by retrying with /oj, one-to-one to the same work', async () => {
    const ctx = createMockContext({ errors: eurlex_lookup_celex.errors });
    const gdprWork =
      'http://publications.europa.eu/resource/cellar/3e485e15-11bd-11e6-ba9a-01aa75ed71a1';
    // CELLAR stores only the /oj manifestation literal: the bare work-level ELI
    // misses (first call), the /oj retry resolves the single work (second call).
    mockQuery.mockResolvedValueOnce([]).mockResolvedValueOnce([
      makeBinding('32016R0679', {
        workUri: gdprWork,
        type: 'http://publications.europa.eu/resource/authority/resource-type/REG',
        date: '2016-04-27',
      }),
    ]);

    const input = eurlex_lookup_celex.input.parse({
      identifier: 'http://data.europa.eu/eli/reg/2016/679',
      identifier_type: 'auto',
    });
    const result = await eurlex_lookup_celex.handler(input, ctx);

    // Resolves to GDPR's canonical work + CELEX via the /oj normalization.
    expect(result.found).toBe(true);
    expect(result.work_uri).toBe(gdprWork);
    expect(result.celex_number).toBe('32016R0679');

    // Exactly two queries: bare exact-match (miss), then the /oj retry.
    expect(mockQuery).toHaveBeenCalledTimes(2);
    const firstSparql = mockQuery.mock.calls[0]?.[0] as string;
    const retrySparql = mockQuery.mock.calls[1]?.[0] as string;
    expect(firstSparql).toContain('"http://data.europa.eu/eli/reg/2016/679"^^xsd:anyURI');
    // The retry is an exact-match on the specific /oj literal — the same
    // one-to-one mechanism as a direct ELI lookup, never a substring scan.
    expect(retrySparql).toContain('"http://data.europa.eu/eli/reg/2016/679/oj"^^xsd:anyURI');
    expect(retrySparql).toContain('cdm:resource_legal_eli');
    expect(retrySparql).not.toContain('CONTAINS');
  });

  it('handles sparse binding (no type or date)', async () => {
    const ctx = createMockContext({ errors: eurlex_lookup_celex.errors });
    mockQuery.mockResolvedValue([makeBinding('32016R0679')]);

    const input = eurlex_lookup_celex.input.parse({ identifier: '32016R0679' });
    const result = await eurlex_lookup_celex.handler(input, ctx);

    expect(result.found).toBe(true);
    expect(result.resource_type).toBeUndefined();
    expect(result.date).toBeUndefined();
  });

  // --- Error contract: ambiguous_identifier ---

  it('throws ctx.fail("ambiguous_identifier") for unrecognized format with auto-detection', async () => {
    const ctx = createMockContext({ errors: eurlex_lookup_celex.errors });

    // This string matches neither CELEX nor ELI patterns
    const input = eurlex_lookup_celex.input.parse({
      identifier: 'completely-unrecognized-identifier-string',
      identifier_type: 'auto',
    });
    await expect(eurlex_lookup_celex.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'ambiguous_identifier' },
    });
    // Should not have called the SPARQL service
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('bounds the identifier the ambiguous_identifier message echoes (#135)', async () => {
    const ctx = createMockContext({ errors: eurlex_lookup_celex.errors });
    const identifier = `x ${'y'.repeat(50_000)}`;

    await expect(
      eurlex_lookup_celex.handler(eurlex_lookup_celex.input.parse({ identifier }), ctx),
    ).rejects.toMatchObject({
      data: { reason: 'ambiguous_identifier' },
      message: `Cannot determine format of identifier: ${identifier.slice(0, 100)}…`,
    });
  });

  it('no longer advertises the "oj" identifier_type — the enum rejects it', () => {
    expect(() =>
      eurlex_lookup_celex.input.parse({ identifier: 'OJ L 119', identifier_type: 'oj' }),
    ).toThrow();
  });

  // --- #143: identifier_type case and separator variants ---

  it.each([
    ['CELEX', 'celex'],
    ['Eli', 'eli'],
    [' ECLI ', 'ecli'],
    ['AUTO', 'auto'],
  ])('serves identifier_type %j as %s (#143)', (value, member) => {
    expect(
      eurlex_lookup_celex.input.parse({ identifier: '32016R0679', identifier_type: value })
        .identifier_type,
    ).toBe(member);
  });

  it('forces the CELEX branch for identifier_type "CELEX" (#143)', async () => {
    // Under auto this citation resolves to 32016R0679; forced, it is read as a CELEX.
    mockQuery.mockImplementation(async (q: string) =>
      q.includes('"32016R0679"^^xsd:string')
        ? [makeBinding('32016R0679', { canonical: true })]
        : [],
    );
    const result = await runToolContract(eurlex_lookup_celex, {
      identifier: 'Regulation (EU) 2016/679',
      identifier_type: 'CELEX',
    });
    expect(result.structuredContent).toMatchObject({ found: false });
    expect((result.structuredContent as { notice?: string }).notice).toContain(
      'No CELLAR work matches CELEX REGULATION (EU) 2016/679 (parsed from "Regulation (EU) 2016/679")',
    );
  });

  it('keeps the auto default and the enum rejection (#143)', () => {
    expect(eurlex_lookup_celex.input.parse({ identifier: 'x' }).identifier_type).toBe('auto');
    const result = eurlex_lookup_celex.input.safeParse({ identifier: 'x', identifier_type: 'url' });
    expect(result.error?.issues[0]?.message).toBe(
      'Invalid option: expected one of "celex"|"eli"|"ecli"|"auto"',
    );
  });

  // --- #22: well-formed-but-nonexistent identifiers return found: false (no throw) ---

  it('returns found: false (no throw) when a well-formed CELEX resolves to no work', async () => {
    const ctx = createMockContext({ errors: eurlex_lookup_celex.errors });
    mockQuery.mockResolvedValue([]);

    const input = eurlex_lookup_celex.input.parse({ identifier: '32016R9999' });
    const result = await eurlex_lookup_celex.handler(input, ctx);

    expect(result.found).toBe(false);
    expect(result.work_uri).toBeUndefined();
    expect(result.celex_number).toBeUndefined();
  });

  it('returns found: false for an ELI that resolves to no work', async () => {
    const ctx = createMockContext({ errors: eurlex_lookup_celex.errors });
    mockQuery.mockResolvedValue([]);

    const input = eurlex_lookup_celex.input.parse({
      identifier: 'http://data.europa.eu/eli/reg/9999/99999/oj',
      identifier_type: 'eli',
    });
    const result = await eurlex_lookup_celex.handler(input, ctx);
    expect(result.found).toBe(false);
  });

  it('does not retry a manifestation-suffixed ELI — found: false without a fallback query', async () => {
    const ctx = createMockContext({ errors: eurlex_lookup_celex.errors });
    mockQuery.mockResolvedValue([]);

    // A consolidated-version ELI (/YYYY-MM-DD) is not bare work-level: if it
    // misses, the lookup must NOT silently resolve the original /oj act instead.
    const input = eurlex_lookup_celex.input.parse({
      identifier: 'http://data.europa.eu/eli/reg/2016/679/2018-05-25',
      identifier_type: 'eli',
    });
    const result = await eurlex_lookup_celex.handler(input, ctx);
    expect(result.found).toBe(false);
    // Single query — the /oj retry never fired for a manifestation-suffixed ELI.
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('returns found: false when a bare work-level ELI has no matching act (after /oj retry)', async () => {
    const ctx = createMockContext({ errors: eurlex_lookup_celex.errors });
    mockQuery.mockResolvedValue([]);

    const input = eurlex_lookup_celex.input.parse({
      identifier: 'http://data.europa.eu/eli/reg/9999/99999',
      identifier_type: 'eli',
    });
    const result = await eurlex_lookup_celex.handler(input, ctx);
    expect(result.found).toBe(false);
    // The /oj retry fired (bare work-level) but also missed — never fabricates a match.
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  describe('#196 a CELEX one numbering convention away from a held CELEX', () => {
    type Row = Record<string, { type: string; value: string }>;
    const literal = (value: string) => ({ type: 'literal', value });

    /** A base act's row in the held-versions query: each version as `date|CELEX`. */
    const baseRow = (celex: string, versions: { current?: string; inEffect?: string }): Row => ({
      baseCelex: literal(celex),
      baseWorkUri: literal(`${CELLAR}${celex}`),
      carriesCore: literal('1'),
      ...(versions.current ? { current: literal(versions.current) } : {}),
      ...(versions.inEffect ? { inEffect: literal(versions.inEffect) } : {}),
    });

    /**
     * CELLAR answering the held-forms query with the CELEX of `held` it lists and the
     * base-act query with `bases`; every lookup query misses.
     */
    const routeMiss = ({ held = [], bases = [] }: { held?: string[]; bases?: Row[] }) =>
      mockQuery.mockImplementation(async (q: string) => {
        if (q.includes('VALUES ?heldCelex')) {
          return held
            .filter((c) => q.includes(`"${c}"^^xsd:string`))
            .map((c) => ({ heldCelex: literal(c) }));
        }
        if (q.includes('VALUES ?baseCelex')) return bases;
        return [];
      });

    const heldQueries = () =>
      mockQuery.mock.calls
        .map((c) => c[0] as string)
        .filter((q) => q.includes('VALUES ?heldCelex') || q.includes('VALUES ?baseCelex'));

    const lookup = async (identifier: string) => {
      const response = await runToolContract(eurlex_lookup_celex, { identifier });
      const text = response.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
      return { response, text, structured: response.structuredContent as Record<string, unknown> };
    };

    const MISS_ADVICE =
      'A CELEX reads {sector}{year}{type}{number} (e.g. 32016R0679); an OJ citation resolves when it names its act type and year (e.g. "Regulation (EU) 2016/679"). To find the act by title words or a partial CELEX, use eurlex_search_documents with keyword.';
    const ONE = 'Pass that CELEX here or to eurlex_get_document.';
    const SEVERAL = 'Pass the CELEX of the one you want here or to eurlex_get_document.';

    it.each([
      [
        '02014R0833',
        { bases: [baseRow('32014R0833', { current: '2026-07-24|02014R0833-20260724' })] },
        `CELLAR holds 02014R0833-20260724, the current consolidated version of 32014R0833. ${ONE}`,
      ],
      [
        '02006R1907-20260101',
        {
          bases: [
            baseRow('32006R1907', {
              current: '2026-06-22|02006R1907-20260622',
              inEffect: '2025-10-23|02006R1907-20251023',
            }),
          ],
        },
        `CELLAR holds 02006R1907-20251023, the consolidated version of 32006R1907 in effect on 2026-01-01, and 02006R1907-20260622, its current one. ${SEVERAL}`,
      ],
      [
        '52026AG0012',
        { held: ['52026AG0012(01)', '52026AG0012(02)'] },
        `CELLAR holds 52026AG0012(01) and 52026AG0012(02). ${SEVERAL}`,
      ],
      ['62009CJ0197(01)', { held: ['62009CJ0197'] }, `CELLAR holds 62009CJ0197. ${ONE}`],
      ['32023R138', { held: ['32023R0138'] }, `CELLAR holds 32023R0138. ${ONE}`],
    ])(
      'keeps found: false for %s and names what CELLAR holds in the notice on both surfaces',
      async (identifier, cellar, named) => {
        routeMiss(cellar);
        const { response, text, structured } = await lookup(identifier);
        expect(response.isError).toBeFalsy();
        const notice = `No CELLAR work matches CELEX ${identifier}. ${named}`;
        expect(structured).toEqual({ found: false, notice });
        expect(readCommonMark(text)).toContain(notice);
        expect(heldQueries()).toHaveLength(1);
      },
    );

    it('keeps the notice of a CELEX whose forms CELLAR does not hold', async () => {
      routeMiss({});
      const { structured } = await lookup('52026AG9999');
      expect(structured).toEqual({
        found: false,
        notice: `No CELLAR work matches CELEX 52026AG9999. ${MISS_ADVICE}`,
      });
    });

    it('says the forms went unchecked when CELLAR does not answer the held-CELEX query', async () => {
      routeMiss({});
      mockQuery.mockImplementation(async (q: string) => {
        if (q.includes('VALUES ?heldCelex')) {
          throw serviceUnavailable('CELLAR SPARQL queries ran past the time budget', {
            reason: 'sparql_timeout',
            retryable: true,
          });
        }
        return [];
      });
      const { response, structured } = await lookup('52026AG0012');
      expect(response.isError).toBeFalsy();
      expect(structured).toEqual({
        found: false,
        notice: `No CELLAR work matches CELEX 52026AG0012. ${MISS_ADVICE} CELLAR did not answer whether it holds a CELEX one numbering convention away; call again to check.`,
      });
    });

    it.each([
      ['a CELEX year past next year', '043443136', 'CELEX 043443136'],
      ['a consolidated CELEX dated past next year', '02099R9999', 'CELEX 02099R9999'],
      ['an ECLI', 'ECLI:EU:C:2099:1', 'ECLI ECLI:EU:C:2099:1'],
      [
        'an ELI',
        'http://data.europa.eu/eli/reg/2026/12/oj',
        'ELI http://data.europa.eu/eli/reg/2026/12/oj',
      ],
    ])('sends no held-CELEX query for the miss of %s', async (_label, identifier, tried) => {
      routeMiss({ held: ['52026AG0012(01)'] });
      const { structured } = await lookup(identifier);
      expect(structured).toEqual({
        found: false,
        notice: `No CELLAR work matches ${tried}. ${MISS_ADVICE}`,
      });
      expect(heldQueries()).toEqual([]);
    });
  });

  // --- Format ---

  it('format renders found, celex, work_uri, type, and date', () => {
    const output = {
      found: true,
      work_uri: 'http://publications.europa.eu/resource/cellar/gdpr',
      celex_number: '32016R0679',
      resource_type: 'Regulation',
      date: '2016-04-27',
    };
    const blocks = eurlex_lookup_celex.format!(output);
    expect(blocks[0]?.type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('32016R0679');
    expect(text).toContain('2016-04-27');
    expect(text).toContain('Regulation');
  });

  it('format renders found flag with sparse output (no optional fields)', () => {
    const output = { found: true };
    const blocks = eurlex_lookup_celex.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('**Found:** true');
  });

  it('format renders found: false for a well-formed-but-nonexistent identifier', () => {
    const blocks = eurlex_lookup_celex.format!({ found: false });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('**Found:** false');
  });

  // --- #93: case-law and national-decision types carry labels ---

  it('labels a national-court decision rather than exposing its DEC_NC code (#93)', async () => {
    const ctx = createMockContext({ errors: eurlex_lookup_celex.errors });
    mockQuery.mockResolvedValue([
      makeBinding('81987NL1021(01)', { type: `${RESOURCE_TYPE}DEC_NC` }),
    ]);

    const input = eurlex_lookup_celex.input.parse({ identifier: '81987NL1021(01)' });
    const result = await eurlex_lookup_celex.handler(input, ctx);

    expect(result.resource_type).toBe(
      'Decision by National Courts in the Field of European Union Law',
    );
    expect((eurlex_lookup_celex.format!(result)[0] as { text: string }).text).toContain(
      '**Type:** Decision by National Courts in the Field of European Union Law',
    );
  });

  // --- #92: typed exact CELEX triple ---

  describe('typed CELEX triple (#92)', () => {
    it('binds the CELEX as a typed exact triple and projects it back as celexNumber', async () => {
      const ctx = createMockContext({ errors: eurlex_lookup_celex.errors });
      mockQuery.mockResolvedValue([makeBinding('32016R0679')]);

      const input = eurlex_lookup_celex.input.parse({ identifier: '32016R0679' });
      const result = await eurlex_lookup_celex.handler(input, ctx);

      const sparql = mockQuery.mock.calls[0]?.[0] as string;
      expect(sparql).toContain('?work cdm:resource_legal_id_celex "32016R0679"^^xsd:string .');
      expect(sparql).toContain('BIND("32016R0679"^^xsd:string AS ?celexNumber)');
      expect(sparql).not.toMatch(/STR\(\?\w+\)\s*=/);
      expect(result.celex_number).toBe('32016R0679');
    });

    it('returns the canonical one of several works sharing one CELEX (#97)', async () => {
      const ctx = createMockContext({ errors: eurlex_lookup_celex.errors });
      // 62012CJ0131 is held by two CELLAR works (live).
      const judgmentWork =
        'http://publications.europa.eu/resource/cellar/09eb0861-da7a-11e3-8cd4-01aa75ed71a1';
      mockQuery.mockResolvedValue([
        makeBinding('62012CJ0131', {
          workUri:
            'http://publications.europa.eu/resource/cellar/57f6959c-51b3-4ab5-9164-ce6ca914c502',
          type: `${RESOURCE_TYPE}JUDG_EXTRACT`,
        }),
        makeBinding('62012CJ0131', {
          workUri: judgmentWork,
          type: `${RESOURCE_TYPE}JUDG`,
          canonical: true,
        }),
      ]);

      const input = eurlex_lookup_celex.input.parse({ identifier: '62012CJ0131' });
      const result = await eurlex_lookup_celex.handler(input, ctx);

      expect(result.work_uri).toBe(judgmentWork);
      expect(result.resource_type).toBe('Judgment');
    });

    it('carries a parenthesized corrigendum CELEX through the typed literal unchanged', async () => {
      const ctx = createMockContext({ errors: eurlex_lookup_celex.errors });
      mockQuery.mockResolvedValue([]);

      const input = eurlex_lookup_celex.input.parse({ identifier: '32016R0679R(02)' });
      const result = await eurlex_lookup_celex.handler(input, ctx);

      expect(mockQuery.mock.calls[0]?.[0] as string).toContain(
        'cdm:resource_legal_id_celex "32016R0679R(02)"^^xsd:string .',
      );
      expect(result).toEqual({ found: false });
    });
  });

  // --- #69: auto-detection reuses the shared CELEX shape ---

  describe('sector coverage in auto-detection (#69)', () => {
    it('detects a sector-0 consolidated CELEX rather than throwing ambiguous_identifier', async () => {
      const ctx = createMockContext({ errors: eurlex_lookup_celex.errors });
      mockQuery.mockResolvedValue([makeBinding('02016R0679-20160504')]);

      const input = eurlex_lookup_celex.input.parse({
        identifier: '02016R0679-20160504',
        identifier_type: 'auto',
      });
      const result = await eurlex_lookup_celex.handler(input, ctx);

      expect(result.found).toBe(true);
      expect(result.celex_number).toBe('02016R0679-20160504');
      // The CELEX branch ran: an exact-match on the CELEX literal, not an ELI lookup.
      const sparql = mockQuery.mock.calls[0]?.[0] as string;
      expect(sparql).toContain('cdm:resource_legal_id_celex "02016R0679-20160504"^^xsd:string .');
    });

    it.each([
      ['sector 1, treaty reference with slashes', '11957A/PRO/CJ/09'],
      ['sector 6, case law', '62024CJ0629'],
      ['sector 7, national implementing measure', '72014L0056FIN_240353'],
      ['sector C, OJ C series', 'C/2026/01104'],
      ['sector E, EFTA document', 'E2016C0186'],
    ])('detects %s through auto', async (_label, celex) => {
      const ctx = createMockContext({ errors: eurlex_lookup_celex.errors });
      mockQuery.mockResolvedValue([makeBinding(celex)]);

      const input = eurlex_lookup_celex.input.parse({ identifier: celex, identifier_type: 'auto' });
      const result = await eurlex_lookup_celex.handler(input, ctx);

      expect(result.found).toBe(true);
      expect(mockQuery.mock.calls[0]?.[0] as string).toContain('cdm:resource_legal_id_celex');
    });

    it('leaves ELI detection unaffected through auto and through the explicit type', async () => {
      const eli = 'http://data.europa.eu/eli/reg/2016/679';

      const autoCtx = createMockContext({ errors: eurlex_lookup_celex.errors });
      mockQuery.mockResolvedValue([makeBinding('32016R0679')]);
      const autoInput = eurlex_lookup_celex.input.parse({
        identifier: eli,
        identifier_type: 'auto',
      });
      await eurlex_lookup_celex.handler(autoInput, autoCtx);
      expect(mockQuery.mock.calls[0]?.[0] as string).toContain('cdm:resource_legal_eli');

      mockQuery.mockClear();
      const explicitCtx = createMockContext({ errors: eurlex_lookup_celex.errors });
      const explicitInput = eurlex_lookup_celex.input.parse({
        identifier: eli,
        identifier_type: 'eli',
      });
      await eurlex_lookup_celex.handler(explicitInput, explicitCtx);
      expect(mockQuery.mock.calls[0]?.[0] as string).toContain('cdm:resource_legal_eli');
    });

    it('still throws ambiguous_identifier for a value that is neither shape', async () => {
      const ctx = createMockContext({ errors: eurlex_lookup_celex.errors });

      const input = eurlex_lookup_celex.input.parse({
        identifier: 'not an identifier',
        identifier_type: 'auto',
      });
      await expect(eurlex_lookup_celex.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'ambiguous_identifier' },
      });
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  // --- #84: ECLI resolution and the ecli output field ---

  describe('ECLI identifiers (#84)', () => {
    async function lookup(
      identifier: string,
      identifierType: 'auto' | 'ecli' | 'celex' = 'auto',
    ): Promise<{
      result: Awaited<ReturnType<typeof eurlex_lookup_celex.handler>>;
      sparql: string;
    }> {
      const ctx = createMockContext({ errors: eurlex_lookup_celex.errors });
      const input = eurlex_lookup_celex.input.parse({
        identifier,
        identifier_type: identifierType,
      });
      const result = await eurlex_lookup_celex.handler(input, ctx);
      return { result, sparql: mockQuery.mock.calls[0]?.[0] as string };
    }

    it.each([
      ['auto', 'auto'],
      ['explicit ecli', 'ecli'],
    ] as const)(
      'resolves ECLI:EU:C:2014:317 to 62012CJ0131 under %s with a typed exact match',
      async (_label, type) => {
        // Live shape: the ECLI binds two work URIs that share one CELEX; the titled
        // one carries the CELEX alias.
        mockQuery.mockResolvedValue([
          makeBinding('62012CJ0131', {
            workUri: 'http://publications.europa.eu/resource/cellar/09eb0861-titled',
            type: `${RESOURCE_TYPE}JUDG`,
            date: '2014-05-13',
            ecli: 'ECLI:EU:C:2014:317',
            canonical: true,
          }),
          makeBinding('62012CJ0131', {
            workUri: 'http://publications.europa.eu/resource/cellar/57f6959c-member',
            type: `${RESOURCE_TYPE}JUDG`,
            ecli: 'ECLI:EU:C:2014:317',
          }),
        ]);

        const { result, sparql } = await lookup('ECLI:EU:C:2014:317', type);

        expect(result).toEqual({
          found: true,
          work_uri: 'http://publications.europa.eu/resource/cellar/09eb0861-titled',
          celex_number: '62012CJ0131',
          resource_type: 'Judgment',
          date: '2014-05-13',
          ecli: 'ECLI:EU:C:2014:317',
        });
        expect(mockQuery).toHaveBeenCalledTimes(1);
        expect(sparql).toContain('?work cdm:case-law_ecli ?ecli .');
        expect(sparql).toContain('"ECLI:EU:C:2014:317"^^xsd:string');
        expect(sparql).not.toContain('STR(?ecli)');
      },
    );

    it('resolves a shared ECLI to the primary judgment, not its extract or abstract', async () => {
      // ECLI:EU:T:2022:186 (live): the abstract sorts first as served here, and the
      // judgment CELEX is held by two works (JUDG and JUDG_EXTRACT).
      mockQuery.mockResolvedValue([
        makeBinding('62017TJ0350_RES', {
          type: `${RESOURCE_TYPE}ABSTRACT_JUR`,
          ecli: 'ECLI:EU:T:2022:186',
        }),
        makeBinding('62017TJ0350_EXT', {
          type: `${RESOURCE_TYPE}JUDG_EXTRACT`,
          ecli: 'ECLI:EU:T:2022:186',
        }),
        makeBinding('62017TJ0350', {
          type: `${RESOURCE_TYPE}JUDG`,
          ecli: 'ECLI:EU:T:2022:186',
          canonical: true,
        }),
        makeBinding('62017TJ0350', {
          workUri: 'http://publications.europa.eu/resource/cellar/extract-work',
          type: `${RESOURCE_TYPE}JUDG_EXTRACT`,
          ecli: 'ECLI:EU:T:2022:186',
        }),
      ]);

      const { result } = await lookup('ECLI:EU:T:2022:186');

      expect(result.celex_number).toBe('62017TJ0350');
      expect(result.resource_type).toBe('Judgment');
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('resolves a joined AG opinion ECLI to the lowest CELEX', async () => {
      mockQuery.mockResolvedValue([
        makeBinding('62013CC0613', { type: `${RESOURCE_TYPE}OPIN_AG`, ecli: 'ECLI:EU:C:2015:785' }),
        makeBinding('62013CC0609', {
          type: `${RESOURCE_TYPE}OPIN_AG`,
          ecli: 'ECLI:EU:C:2015:785',
          canonical: true,
        }),
      ]);

      const { result } = await lookup('ECLI:EU:C:2015:785');
      expect(result.celex_number).toBe('62013CC0609');
    });

    it('falls back to a derivative record when the ECLI reaches nothing else', async () => {
      mockQuery.mockResolvedValue([
        makeBinding('62020CJ0001_SUM', {
          type: `${RESOURCE_TYPE}SUM_JUR`,
          ecli: 'ECLI:EU:C:2021:1',
          canonical: true,
        }),
      ]);

      const { result } = await lookup('ECLI:EU:C:2021:1');
      expect(result.found).toBe(true);
      expect(result.celex_number).toBe('62020CJ0001_SUM');
    });

    it('trims the ECLI and escapes it into the literal', async () => {
      mockQuery.mockResolvedValue([]);

      const raw = 'ECLI:EU:C:2014:317"\\';
      const { sparql } = await lookup(`  ${raw}\t`, 'ecli');

      expect(sparql).toContain(`"${escapeSparqlLiteral(raw)}"^^xsd:string`);
      expect(sparql).not.toContain(`"${raw}"`);
    });

    it('resolves a lowercase EU ECLI through its uppercase form, detected under auto', async () => {
      mockQuery.mockResolvedValue([
        makeBinding('62012CJ0131', {
          type: `${RESOURCE_TYPE}JUDG`,
          ecli: 'ECLI:EU:C:2014:317',
          canonical: true,
        }),
      ]);

      const { result, sparql } = await lookup('  ecli:eu:c:2014:317 ');

      expect(result.celex_number).toBe('62012CJ0131');
      // The stored form is returned, not the caller's spelling.
      expect(result.ecli).toBe('ECLI:EU:C:2014:317');
      expect(sparql).toContain('"ecli:eu:c:2014:317"^^xsd:string');
      expect(sparql).toContain('"ECLI:EU:C:2014:317"^^xsd:string');
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('prefers an exact-case match over its uppercase form for a mixed-case national ECLI', async () => {
      // Hypothetical collision: the uppercase spelling names a different, lower CELEX.
      mockQuery.mockResolvedValue([
        makeBinding('72015FI0001', { ecli: 'ECLI:FI:HELHO:2015:1766', canonical: true }),
        makeBinding('82015FI1209(51)', { ecli: 'ECLI:FI:HelHO:2015:1766', canonical: true }),
      ]);

      const { result, sparql } = await lookup('ECLI:FI:HelHO:2015:1766');

      expect(result.celex_number).toBe('82015FI1209(51)');
      expect(result.ecli).toBe('ECLI:FI:HelHO:2015:1766');
      expect(sparql).toContain('"ECLI:FI:HelHO:2015:1766"^^xsd:string');
    });

    it('sends a single literal when the ECLI is already uppercase', async () => {
      mockQuery.mockResolvedValue([]);
      const { sparql } = await lookup('ECLI:EU:C:2014:317');
      expect(sparql.match(/\^\^xsd:string/g)).toHaveLength(1);
    });

    it('returns found: false for a well-formed ECLI that matches no work', async () => {
      mockQuery.mockResolvedValue([]);

      const { result } = await lookup('ECLI:EU:C:2099:1');
      expect(result).toEqual({ found: false });
    });

    it('returns the ECLI of a case resolved by CELEX, and omits it where the work has none', async () => {
      mockQuery.mockResolvedValue([
        makeBinding('62012CJ0131', { type: `${RESOURCE_TYPE}JUDG`, ecli: 'ECLI:EU:C:2014:317' }),
      ]);
      const { result, sparql } = await lookup('62012CJ0131');
      expect(result.ecli).toBe('ECLI:EU:C:2014:317');
      expect(sparql).toContain('OPTIONAL { ?work cdm:case-law_ecli ?ecli . }');

      mockQuery.mockReset();
      mockQuery.mockResolvedValue([makeBinding('32016R0679', { type: `${RESOURCE_TYPE}REG` })]);
      const { result: act } = await lookup('32016R0679');
      expect(act.found).toBe(true);
      expect('ecli' in act).toBe(false);
    });

    it('carries the ECLI on both structuredContent and content[]', async () => {
      mockQuery.mockResolvedValue([
        makeBinding('62012CJ0131', { type: `${RESOURCE_TYPE}JUDG`, ecli: 'ECLI:EU:C:2014:317' }),
      ]);

      const result = await runToolContract(eurlex_lookup_celex, {
        identifier: 'ECLI:EU:C:2014:317',
      });

      expect(result.isError).toBeFalsy();
      const structured = eurlex_lookup_celex.output.parse(result.structuredContent);
      expect(structured.ecli).toBe('ECLI:EU:C:2014:317');
      expect(structured.celex_number).toBe('62012CJ0131');
      const text = result.content
        .map((block) => (block as { text?: string }).text ?? '')
        .join('\n');
      expect(text).toContain('**ECLI:** ECLI:EU:C:2014:317');
      expect(text).toContain('**CELEX:** 62012CJ0131');
    });

    it('names the ECLI form in the ambiguous_identifier recovery', async () => {
      const result = await runToolContract(eurlex_lookup_celex, {
        identifier: 'not an identifier',
        identifier_type: 'auto',
      });
      const structured = result.structuredContent as {
        error?: { data?: { reason?: string; recovery?: { hint?: string } } };
      };
      expect(structured.error?.data?.reason).toBe('ambiguous_identifier');
      expect(structured.error?.data?.recovery?.hint).toContain('ECLI:EU:C:2014:317');
    });
  });

  // --- #97: a CELEX held by several works resolves to its canonical work ---

  describe('CELEX held by several works (#97)', () => {
    const judgment = () => ({ type: { type: 'uri', value: `${RESOURCE_TYPE}JUDG` } });

    it.each([
      ['62022TJ0181', 'a do_not_index copy and a _EXT alias'],
      ['62012CJ0131', 'a do_not_index copy'],
      ['51988DC0713', 'a sector-5 do_not_index twin'],
      ['62015TO0235(01)', 'two copies of a parenthesized CELEX'],
    ])('resolves %s (%s) to the work owl:sameAs its CELEX IRI', async (celex) => {
      mockQuery.mockImplementation(async (q: string) => celexWorkRows(q, CELEX_WORKS, judgment));

      const result = await runToolContract(eurlex_lookup_celex, { identifier: celex });

      const structured = eurlex_lookup_celex.output.parse(result.structuredContent);
      expect(structured.work_uri).toBe(canonicalWork(celex));
      expect(structured.celex_number).toBe(celex);
      const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
      expect(text).toContain(`**Work URI:** ${canonicalWork(celex)}`);
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('leaves a CELEX held by one work unchanged', async () => {
      mockQuery.mockImplementation(async (q: string) => celexWorkRows(q, CELEX_WORKS, judgment));

      const result = await runToolContract(eurlex_lookup_celex, { identifier: '32016R0679' });

      expect(eurlex_lookup_celex.output.parse(result.structuredContent)).toEqual({
        found: true,
        work_uri: canonicalWork('32016R0679'),
        celex_number: '32016R0679',
        resource_type: 'Judgment',
      });
    });

    it('falls back to the lowest work URI when no work carries the CELEX alias', async () => {
      const works = {
        '62099TJ0001': [
          { uri: `${CELLAR}zz-last`, canonical: false },
          { uri: `${CELLAR}aa-first`, canonical: false },
        ],
      };
      mockQuery.mockImplementation(async (q: string) => celexWorkRows(q, works));

      const input = eurlex_lookup_celex.input.parse({ identifier: '62099TJ0001' });
      const result = await eurlex_lookup_celex.handler(
        input,
        createMockContext({ errors: eurlex_lookup_celex.errors }),
      );

      expect(result.work_uri).toBe(`${CELLAR}aa-first`);
    });

    it('builds the alias IRI with ENCODE_FOR_URI so a parenthesized CELEX matches %28/%29', async () => {
      mockQuery.mockResolvedValue([]);

      await eurlex_lookup_celex.handler(
        eurlex_lookup_celex.input.parse({ identifier: '62015TO0235(01)' }),
        createMockContext({ errors: eurlex_lookup_celex.errors }),
      );

      const sparql = mockQuery.mock.calls[0]?.[0] as string;
      expect(sparql).toContain('<http://www.w3.org/2002/07/owl#sameAs>');
      expect(sparql).toContain('ENCODE_FOR_URI(STR("62015TO0235(01)"^^xsd:string))');
      expect(sparql).toContain('"http://publications.europa.eu/resource/celex/"');
    });

    /** ECLI rows as CELLAR returns them for the given works, all carrying `ecli`. */
    const ecliRows = (
      q: string,
      ecli: string,
      rows: { celex: string; uri: string; canonical: boolean; type: string }[],
    ) =>
      rows.map((r) => ({
        celexNumber: { type: 'literal', value: r.celex },
        work: { type: 'uri', value: r.uri },
        type: { type: 'uri', value: `${RESOURCE_TYPE}${r.type}` },
        ecli: { type: 'literal', value: ecli },
        ...(r.canonical && q.includes('owl#sameAs')
          ? { canonicalAlias: { type: 'uri', value: `celex-alias:${r.celex}` } }
          : {}),
      }));

    it('keeps the #84 CELEX choice for ECLI:EU:T:2024:668, then resolves that CELEX to its canonical work', async () => {
      mockQuery.mockImplementation(async (q: string) =>
        q.includes('VALUES ?ecli')
          ? ecliRows(q, 'ECLI:EU:T:2024:668', [
              {
                celex: '62022TJ0181',
                uri: `${CELLAR}ca51f381-8097-11ef-a67d-01aa75ed71a1`,
                canonical: false,
                type: 'JUDG',
              },
              {
                celex: '62022TJ0181_RES',
                uri: `${CELLAR}b23c5fa4-res`,
                canonical: true,
                type: 'ABSTRACT_JUR',
              },
              {
                celex: '62022TJ0181',
                uri: canonicalWork('62022TJ0181'),
                canonical: true,
                type: 'JUDG',
              },
              {
                celex: '62022TJ0181',
                uri: `${CELLAR}736c7d97-2efc-4194-9590-481bd3d19eeb`,
                canonical: false,
                type: 'JUDG',
              },
            ])
          : [],
      );

      const result = await runToolContract(eurlex_lookup_celex, {
        identifier: 'ECLI:EU:T:2024:668',
      });

      const structured = eurlex_lookup_celex.output.parse(result.structuredContent);
      expect(structured.celex_number).toBe('62022TJ0181');
      expect(structured.work_uri).toBe(canonicalWork('62022TJ0181'));
      expect(structured.ecli).toBe('ECLI:EU:T:2024:668');
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('resolves the chosen CELEX by its own works when the ECLI reaches none of them canonically', async () => {
      // Live: ECLI:EU:T:2015:587 sits on the two copies of 62015TO0235(01) only; the
      // canonical work carries no ECLI.
      mockQuery.mockImplementation(async (q: string) =>
        q.includes('VALUES ?ecli')
          ? ecliRows(q, 'ECLI:EU:T:2015:587', [
              {
                celex: '62015TO0235(01)',
                uri: `${CELLAR}ad35bf3b-5ca8-11e5-afbf-01aa75ed71a1`,
                canonical: false,
                type: 'ORDER',
              },
              {
                celex: '62015TO0235(01)',
                uri: `${CELLAR}4a758329-a866-4fee-8d78-e26719d9f4c5`,
                canonical: false,
                type: 'ORDER',
              },
            ])
          : celexWorkRows(q, CELEX_WORKS, () => ({
              type: { type: 'uri', value: `${RESOURCE_TYPE}ORDER` },
            })),
      );

      const result = await runToolContract(eurlex_lookup_celex, {
        identifier: 'ECLI:EU:T:2015:587',
      });

      const structured = eurlex_lookup_celex.output.parse(result.structuredContent);
      expect(structured.celex_number).toBe('62015TO0235(01)');
      expect(structured.work_uri).toBe(canonicalWork('62015TO0235(01)'));
      expect(structured.ecli).toBe('ECLI:EU:T:2015:587');
      expect(structured.resource_type).toBe('Order');
    });

    it('reports the ECLI a CELEX lookup finds on any of its works, in one query', async () => {
      // Live: 62015TO0235(01)'s canonical work carries no ECLI; its two copies carry
      // ECLI:EU:T:2015:587. The ECLI names the case, so the lookup still reports it.
      mockQuery.mockImplementation(async (q: string) =>
        celexWorkRows(q, CELEX_WORKS, (work) => ({
          type: { type: 'uri', value: `${RESOURCE_TYPE}ORDER` },
          ...(work.canonical ? {} : { ecli: { type: 'literal', value: 'ECLI:EU:T:2015:587' } }),
        })),
      );

      const result = await runToolContract(eurlex_lookup_celex, { identifier: '62015TO0235(01)' });

      const structured = eurlex_lookup_celex.output.parse(result.structuredContent);
      expect(structured.work_uri).toBe(canonicalWork('62015TO0235(01)'));
      expect(structured.ecli).toBe('ECLI:EU:T:2015:587');
      const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
      expect(text).toContain('**ECLI:** ECLI:EU:T:2015:587');
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('prefers the resolved work’s own ECLI over one on another work of the CELEX', async () => {
      mockQuery.mockImplementation(async (q: string) =>
        celexWorkRows(q, CELEX_WORKS, (work) => ({
          ecli: {
            type: 'literal',
            value: work.canonical ? 'ECLI:EU:T:2024:668' : 'ECLI:EU:T:0000:1',
          },
        })),
      );

      const result = await eurlex_lookup_celex.handler(
        eurlex_lookup_celex.input.parse({ identifier: '62022TJ0181' }),
        createMockContext({ errors: eurlex_lookup_celex.errors }),
      );

      expect(result.work_uri).toBe(canonicalWork('62022TJ0181'));
      expect(result.ecli).toBe('ECLI:EU:T:2024:668');
    });
  });

  // --- #114: OJ citations under auto, and a notice on a miss ---

  describe('OJ citations (#114)', () => {
    /** CELLAR holds exactly `celex`: the typed CELEX lookup answers only for that literal. */
    function holds(celex: string): void {
      mockQuery.mockImplementation(async (q: string) =>
        q.includes(`"${celex}"^^xsd:string`)
          ? [makeBinding(celex, { type: `${RESOURCE_TYPE}REG`, canonical: true })]
          : [],
      );
    }

    async function resolve(identifier: string, identifierType?: 'auto' | 'celex') {
      const ctx = createMockContext({ errors: eurlex_lookup_celex.errors });
      const result = await eurlex_lookup_celex.handler(
        eurlex_lookup_celex.input.parse({
          identifier,
          ...(identifierType ? { identifier_type: identifierType } : {}),
        }),
        ctx,
      );
      const queries = mockQuery.mock.calls.map((c) => c[0] as string);
      return { result, ctx, queries };
    }

    it.each([
      ['Regulation (EU) 2016/679', '32016R0679'],
      ['Regulation (EC) No 1049/2001', '32001R1049'],
      ['Council Regulation (EEC) No 1612/68', '31968R1612'],
      ['Directive 95/46/EC', '31995L0046'],
      ['Directive 2011/83/EU', '32011L0083'],
      ['Directive (EU) 2016/680', '32016L0680'],
      ['Council Directive 2013/59/Euratom', '32013L0059'],
      ['Decision (EU) 2015/1814', '32015D1814'],
      ['Decision No 1313/2013/EU', '32013D1313'],
      ['Council Decision 2010/413/CFSP', '32010D0413'],
      ['Framework Decision 2002/584/JHA', '32002F0584'],
      ['Joint Action 2008/124/CFSP', '32008E0124'],
      ['Common Position 2003/444/CFSP', '32003E0444'],
      ['Decision No 3632/93/ECSC', '31993S3632'],
    ])('resolves %j to %s under auto', async (citation, celex) => {
      holds(celex);
      const { result, queries } = await resolve(citation);

      expect(result).toMatchObject({ found: true, celex_number: celex });
      expect(queries).toHaveLength(1);
      expect(queries[0]).toContain(`?work cdm:resource_legal_id_celex "${celex}"^^xsd:string .`);
    });

    it.each([
      ['Regulation (EU) No 596/2014', '32014R0596'],
      ['Regulation (EU) 2015/596', '32015R0596'],
      ['Regulation (EC) No 46/95', '31995R0046'],
      ['Commission Implementing Regulation (EU) No 540/2011', '32011R0540'],
      ['Commission Delegated Regulation (EU) 2019/980', '32019R0980'],
      ['Council Framework Decision 2002/584/JHA', '32002F0584'],
      ['Commission Decision No 3632/93/ECSC', '31993S3632'],
      ['directive 95/46/ec', '31995L0046'],
      ['Regulation (EC) No. 1049/2001', '32001R1049'],
      [
        'Regulation (EU) 2016/679 of the European Parliament and of the Council of 27 April 2016',
        '32016R0679',
      ],
    ])(
      'orders the numbers by the No marker and ignores qualifiers: %j → %s',
      async (citation, celex) => {
        holds(celex);
        const { result } = await resolve(citation);
        expect(result).toMatchObject({ found: true, celex_number: celex });
      },
    );

    it('reads Directive 95/46/EC as the directive, never the Commission Decision of the same number', async () => {
      holds('31995D0046');
      const { result, queries } = await resolve('Directive 95/46/EC');

      expect(result.found).toBe(false);
      expect(queries.join('\n')).toContain('"31995L0046"^^xsd:string');
      expect(queries.join('\n')).not.toContain('31995D0046');
    });

    it.each([
      'Regulation No 17',
      'Regulation (EU) 2016/679 and Directive (EU) 2016/680',
      'Directive 95/46/XYZ',
      'Regulation 2016/679a',
      'Directive 199/46/EC',
      'Article 5 of Regulation (EU) 2016/679',
      'Regulation (EU) 2016/679; Directive',
    ])('raises ambiguous_identifier for %j with no CELLAR call', async (identifier) => {
      await expect(resolve(identifier)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'ambiguous_identifier' },
      });
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('recovers from ambiguous_identifier with the accepted forms and the search, not identifier_type', async () => {
      const result = await runToolContract(eurlex_lookup_celex, { identifier: 'Regulation No 17' });
      const structured = result.structuredContent as {
        error?: { data?: { reason?: string; recovery?: { hint?: string } } };
      };
      const hint = structured.error?.data?.recovery?.hint ?? '';

      expect(structured.error?.data?.reason).toBe('ambiguous_identifier');
      expect(hint).not.toContain('identifier_type');
      expect(hint).toContain('Regulation (EU) 2016/679');
      expect(hint).toContain('eurlex_search_documents');
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('parses a citation only under auto', async () => {
      holds('32016R0679');
      const { result, ctx } = await resolve('Regulation (EU) 2016/679', 'celex');

      // A forced CELEX is normalized as a CELEX — uppercased — never parsed as a citation.
      expect(result.found).toBe(false);
      expect(getEnrichment(ctx).notice).toContain(
        'No CELLAR work matches CELEX REGULATION (EU) 2016/679 (parsed from "Regulation (EU) 2016/679")',
      );
    });

    it('returns found: false with the notice and no other field for a CELEX no work carries', async () => {
      mockQuery.mockResolvedValue([]);
      const result = await runToolContract(eurlex_lookup_celex, { identifier: '32016R9999' });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as Record<string, unknown>;
      expect(Object.keys(structured).sort()).toEqual(['found', 'notice']);
      expect(structured.found).toBe(false);
      const notice = String(structured.notice);
      expect(notice).toContain('CELEX 32016R9999');
      expect(notice).toContain('{sector}{year}{type}{number}');
      expect(notice).toContain('32016R0679');
      expect(notice).toContain('eurlex_search_documents with keyword');
      const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
      expect(text).toContain('CELEX 32016R9999');
    });

    it('names the parsed CELEX and the citation in the notice of a citation miss', async () => {
      mockQuery.mockResolvedValue([]);
      const { result, ctx } = await resolve('Regulation (EU) 2016/9999');

      expect(result).toEqual({ found: false });
      expect(getEnrichment(ctx).notice).toContain(
        'CELEX 32016R9999 (parsed from "Regulation (EU) 2016/9999")',
      );
    });

    it.each([
      [
        'http://data.europa.eu/eli/reg/9999/99999/oj',
        'ELI http://data.europa.eu/eli/reg/9999/99999/oj',
      ],
      ['ECLI:EU:C:2099:1', 'ECLI ECLI:EU:C:2099:1'],
    ])('names the identifier tried in the notice of a miss on %s', async (identifier, tried) => {
      mockQuery.mockResolvedValue([]);
      const { result, ctx } = await resolve(identifier);

      expect(result).toEqual({ found: false });
      expect(getEnrichment(ctx).notice).toContain(`No CELLAR work matches ${tried}.`);
    });

    it('adds no notice to a hit, so CELEX, ELI, and ECLI output is unchanged', async () => {
      holds('32016R0679');
      const result = await runToolContract(eurlex_lookup_celex, { identifier: '32016R0679' });

      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured).not.toHaveProperty('notice');
      expect(structured).toMatchObject({ found: true, celex_number: '32016R0679' });
    });

    // --- #171: a citation followed by its parenthesized OJ reference ---

    it.each([
      ['Directive 95/46/EC (OJ L 281, 23.11.1995, p. 31)', 'Directive 95/46/EC', '31995L0046'],
      [
        'Regulation (EU) 2016/679 (OJ L 119, 4.5.2016, p. 1)',
        'Regulation (EU) 2016/679',
        '32016R0679',
      ],
      [
        'Regulation (EU) 2016/679 (oj l 119, 4.5.2016, p. 1–88)',
        'Regulation (EU) 2016/679',
        '32016R0679',
      ],
    ])(
      'resolves %j as the bare citation, ignoring the reference (#171)',
      async (citation, bare, celex) => {
        holds(celex);
        const withReference = await runToolContract(eurlex_lookup_celex, { identifier: citation });
        const referenceQueries = mockQuery.mock.calls.map((c) => c[0] as string);
        mockQuery.mockClear();
        const bareCitation = await runToolContract(eurlex_lookup_celex, { identifier: bare });

        expect(withReference.structuredContent).toMatchObject({ found: true, celex_number: celex });
        expect(withReference.structuredContent).toEqual(bareCitation.structuredContent);
        expect(withReference.content).toEqual(bareCitation.content);
        expect(referenceQueries).toEqual(mockQuery.mock.calls.map((c) => c[0] as string));
        expect(referenceQueries).toHaveLength(1);
      },
    );

    // --- #172: a citation ending its sentence ---

    it.each([
      ['Directive 95/46/EC.', 'Directive 95/46/EC', '31995L0046'],
      ['Regulation (EC) No 1049/2001.', 'Regulation (EC) No 1049/2001', '32001R1049'],
      ['Regulation (EU) 2016/679.', 'Regulation (EU) 2016/679', '32016R0679'],
      ['Directive 95/46/EC (OJ L 281, 23.11.1995, p. 31).', 'Directive 95/46/EC', '31995L0046'],
    ])(
      'resolves %j as the citation without its closing period (#172)',
      async (citation, bare, celex) => {
        holds(celex);
        const withPeriod = await runToolContract(eurlex_lookup_celex, { identifier: citation });
        const periodQueries = mockQuery.mock.calls.map((c) => c[0] as string);
        mockQuery.mockClear();
        const bareCitation = await runToolContract(eurlex_lookup_celex, { identifier: bare });

        expect(withPeriod.structuredContent).toMatchObject({ found: true, celex_number: celex });
        expect(withPeriod.structuredContent).toEqual(bareCitation.structuredContent);
        expect(withPeriod.content).toEqual(bareCitation.content);
        expect(periodQueries).toEqual(mockQuery.mock.calls.map((c) => c[0] as string));
      },
    );

    it('names the citation as given, period included, in the notice of a miss (#172)', async () => {
      mockQuery.mockResolvedValue([]);
      const { result, ctx } = await resolve('Regulation (EU) 2016/9999.');

      expect(result).toEqual({ found: false });
      expect(getEnrichment(ctx).notice).toContain(
        'CELEX 32016R9999 (parsed from "Regulation (EU) 2016/9999.")',
      );
    });

    it.each(['Regulation No 17.', 'Directive 95/46/E.C.', 'Directive 95/46/EC..'])(
      'still raises ambiguous_identifier for %j once its one closing period is dropped (#172)',
      async (identifier) => {
        await expect(resolve(identifier)).rejects.toMatchObject({
          data: { reason: 'ambiguous_identifier' },
        });
        expect(mockQuery).not.toHaveBeenCalled();
      },
    );

    it('keeps resolving a reference after the act title (#171)', async () => {
      holds('32016R0679');
      const { result, queries } = await resolve(
        'Regulation (EU) 2016/679 of 27 April 2016 (OJ L 119, 4.5.2016, p. 1)',
      );

      expect(result).toMatchObject({ found: true, celex_number: '32016R0679' });
      expect(queries).toHaveLength(1);
    });

    it.each([
      'Directive 95/46/EC and Directive 2002/58/EC',
      'Directive 95/46/EC (OJ L 281, 23.11.1995, p. 31) and Directive 2002/58/EC',
      'Directive 95/46/EC (L 281, 23.11.1995, p. 31)',
      'Directive 95/46/EC (OJ L 281, 23.11.1995, p. 31',
      'Directive 95/46/EC (OJ L 281 (corrigendum), p. 31)',
    ])('still raises ambiguous_identifier for %j (#171)', async (identifier) => {
      await expect(resolve(identifier)).rejects.toMatchObject({
        data: { reason: 'ambiguous_identifier' },
      });
      expect(mockQuery).not.toHaveBeenCalled();
    });

    /**
     * The citation numbers pattern now admits a parenthesized reference after the
     * numbers. Timed through the handler, which runs every auto-branch parser on the
     * input, across a 64× span on a reference opener with no closer, a whitespace run
     * before the parenthesis, and the two line-break shapes.
     */
    it.each<[string, (n: number) => string]>([
      ['an unclosed reference', (n) => `Directive 95/46/EC (OJ ${'x'.repeat(n)}`],
      ['a whitespace run before an opener', (n) => `Directive 95/46/EC${' '.repeat(n)}(`],
      ['nested openers', (n) => `Directive 95/46/EC (OJ ${'('.repeat(n)})`],
      [
        'one long line ending in a break',
        (n) => `Directive 95/46/EC (OJ ${'§1 x'.repeat(n / 4)}\ny`,
      ],
      ['breaks throughout', (n) => `Directive 95/46/EC (OJ ${'  \r\n'.repeat(n / 4)}`],
    ])(
      'parses a citation in linear time: %s (#171)',
      async (_label, shape) => {
        const ctx = createMockContext({ errors: eurlex_lookup_celex.errors });
        const timings: number[] = [];
        for (const size of [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000]) {
          const input = eurlex_lookup_celex.input.parse({ identifier: shape(size) });
          const cpu = await bestCpuMs(() =>
            Promise.resolve(eurlex_lookup_celex.handler(input, ctx)).catch(() => undefined),
          );
          expect(cpu, `${size} characters: ${cpu.toFixed(3)} ms CPU`).toBeLessThan(150);
          timings.push(cpu);
        }
        const [first = 0] = timings;
        const last = timings.at(-1) ?? 0;
        expect(last / Math.max(first, 0.01), JSON.stringify(timings)).toBeLessThan(256);
        expect(mockQuery).not.toHaveBeenCalled();
      },
      CPU_TIMED_TEST_TIMEOUT_MS,
    );
  });

  // --- #170: Official Journal references ---

  describe('Official Journal references (#170)', () => {
    const literal = (value: string) => ({ type: 'literal', value });

    /** A grouped issue row, as the OJ issue query returns it. */
    function issueRow(published: string, celex?: string, english = true, englishPaged = true) {
      return {
        published: literal(published),
        englishPaged: literal(englishPaged ? '1' : '0'),
        ...(celex ? { celex: literal(celex), english: literal(english ? '1' : '0') } : {}),
      };
    }

    /**
     * OJ issues as CELLAR holds them (measured live, 2026-10-24): the rows the issue
     * query returns for `page`, the one first page each holds here. Any other page
     * answers the issue's date with no CELEX.
     */
    const OJ_ISSUES: Record<string, { page: number; rows: ReturnType<typeof issueRow>[] }> = {
      'oj:JOL_1995_281_R': { page: 31, rows: [issueRow('1995-11-23', '31995L0046')] },
      'oj:JOL_1996_281_R': { page: 0, rows: [issueRow('1996-10-31')] },
      'oj:JOL_2016_119_R': { page: 1, rows: [issueRow('2016-05-04', '32016R0679')] },
      'oj:JOL_2022_042_I': { page: 1, rows: [issueRow('2022-02-23', '32022R0259')] },
      'oj:JOC_2012_326_R': { page: 47, rows: [issueRow('2012-10-26', '12012E/TXT')] },
      'oj:JOP_1962_013_R': {
        page: 204,
        rows: [issueRow('1962-02-21', '31962R0017', false, false)],
      },
      'oj:JOL_2018_127_R': {
        page: 2,
        rows: [
          issueRow('2018-05-23', '32016R0679R(02)'),
          issueRow('2018-05-23', '32017R0821R(01)', false),
        ],
      },
      'oj:JOL_2018_012_R': {
        page: 1,
        rows: [issueRow('2018-01-17', '22018X0117(01)'), issueRow('2018-01-17', '22018X0117(02)')],
      },
      'oj:JOC_1990_277_R': { page: 3, rows: [issueRow('1990-11-05', '51990PC0314(01)')] },
    };
    const ACT_RECORDS: Record<string, { celex: string; published: string }> = {
      'oj:L_202401689': { celex: '32024R1689', published: '2024-07-12' },
      'oj:C_202402664': { celex: '52023AP0365', published: '2024-04-29' },
    };
    const HELD_CELEX = new Set([
      ...Object.values(OJ_ISSUES).flatMap(({ rows }) => rows.flatMap((r) => r.celex?.value ?? [])),
      ...Object.values(ACT_RECORDS).map((act) => act.celex),
    ]);

    /**
     * CELLAR answering the OJ issue query for the cited page only (the query filters
     * on it), the act-by-act query, and the typed CELEX lookup for every CELEX above.
     */
    function holdsOj(): void {
      mockQuery.mockImplementation(async (q: string) => {
        const id = /cdm:work_id_document "(oj:[^"]+)"\^\^xsd:string/.exec(q)?.[1];
        if (id) {
          const act = ACT_RECORDS[id];
          if (act) return [{ celex: literal(act.celex), published: literal(act.published) }];
          const issue = OJ_ISSUES[id];
          if (!issue) return [];
          const page = Number(/FILTER\(xsd:integer\(\?page\) = (\d+)\)/.exec(q)?.[1]);
          if (page === issue.page) return issue.rows;
          const [{ published, englishPaged } = issueRow('')] = issue.rows;
          return [{ published, englishPaged }];
        }
        const celex = /resource_legal_id_celex "([^"]+)"\^\^xsd:string/.exec(q)?.[1];
        return celex && HELD_CELEX.has(celex)
          ? [
              makeBinding(celex, {
                type: `${RESOURCE_TYPE}REG`,
                date: '2016-04-27',
                canonical: true,
              }),
            ]
          : [];
      });
    }

    async function lookup(identifier: string, identifierType?: 'auto' | 'celex') {
      const result = await runToolContract(eurlex_lookup_celex, {
        identifier,
        ...(identifierType ? { identifier_type: identifierType } : {}),
      });
      const structured = result.structuredContent as Record<string, unknown> & {
        error?: { data?: { reason?: string; recovery?: { hint?: string } } };
      };
      const queries = mockQuery.mock.calls.map((c) => c[0] as string);
      return { result, structured, queries };
    }

    beforeEach(holdsOj);

    it.each([
      ['OJ L 281, 23.11.1995, p. 31', '31995L0046'],
      ['OJ L 281 of 23.11.1995, p. 31–50', '31995L0046'],
      ['OJ L 42I, 23.2.2022, p. 1', '32022R0259'],
      ['OJ C 326, 26.10.2012, p. 47', '12012E/TXT'],
      ['OJ 13, 21.2.1962, p. 204/62', '31962R0017'],
      ['OJ 13, 21.2.1962, p. 204–211', '31962R0017'],
      ['OJ 1995 L 281, p. 31', '31995L0046'],
      ['OJ 1995 L 281/31', '31995L0046'],
      ['OJ L 119, 4.5.2016, p. 1–88', '32016R0679'],
      ['OJ L, 2024/1689, 12.7.2024', '32024R1689'],
      ['OJ C, C/2024/2664, 29.4.2024', '52023AP0365'],
      ['(OJ L 281, 23.11.1995, p. 31).', '31995L0046'],
      ['oj l 281, 23.11.1995, p. 31', '31995L0046'],
      ['OJ L 127, 23.5.2018, p. 2', '32016R0679R(02)'],
      // #172: the spellings EUR-Lex act texts and the Court use.
      ['OJ No L 281, 23. 11. 1995, p. 31.', '31995L0046'],
      ['[1995] OJ L281/31', '31995L0046'],
      ['OJ L 119, 4.5.2016, pp. 1–88', '32016R0679'],
      ['OJ L 2024/1689', '32024R1689'],
      ['OJ No C 277, 5. 11. 1990, p. 3', '51990PC0314(01)'],
    ])('resolves %j to %s with the output of that CELEX lookup', async (reference, celex) => {
      const viaReference = await lookup(reference);
      mockQuery.mockClear();
      const viaCelex = await lookup(celex);

      expect(viaReference.structured).toMatchObject({ found: true, celex_number: celex });
      expect(viaReference.structured).toEqual(viaCelex.structured);
      expect(viaReference.result.content).toEqual(viaCelex.result.content);
      // One OJ query, then exactly the query the CELEX lookup sends.
      expect(viaReference.queries).toHaveLength(2);
      expect(viaReference.queries[0]).toContain('cdm:work_id_document');
      expect(viaReference.queries[1]).toBe(viaCelex.queries[0]);
    });

    it('names each CELEX when the page starts several acts, on both surfaces', async () => {
      const { result, structured, queries } = await lookup('OJ L 12, 17.1.2018, p. 1');

      expect(result.isError).toBeFalsy();
      expect(Object.keys(structured).sort()).toEqual(['found', 'notice']);
      expect(structured.found).toBe(false);
      expect(structured.notice).toBe(
        'OJ reference "OJ L 12, 17.1.2018, p. 1" names the first page of 2 acts: 22018X0117(01), 22018X0117(02). Pass the CELEX of the one you want here or to eurlex_get_document.',
      );
      const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
      expect(readCommonMark(text)).toContain(structured.notice as string);
      expect(queries).toHaveLength(1);
    });

    it.each([
      [
        'a date that is not the issue’s',
        'OJ L 281, 23.11.1996, p. 31',
        'that issue was published on 1996-10-31, not on the date cited',
      ],
      [
        'a page no act starts on',
        'OJ L 281, 23.11.1995, p. 35',
        'no act with a CELEX starts on that page of the issue',
      ],
      ['an issue CELLAR does not hold', 'OJ L 999, 1.1.2018, p. 1', 'CELLAR holds no such issue'],
      [
        'an act-by-act date that is not the act’s',
        'OJ L, 2024/1689, 13.7.2024',
        'that act was published on 2024-07-12, not on the date cited',
      ],
      [
        'an act-by-act number no act carries',
        'OJ L, 2024/9999',
        'CELLAR holds no act under that number',
      ],
    ])('returns found: false with the notice for %s', async (_label, reference, reason) => {
      const { result, structured, queries } = await lookup(reference);

      expect(result.isError).toBeFalsy();
      expect(Object.keys(structured).sort()).toEqual(['found', 'notice']);
      const notice = String(structured.notice);
      expect(notice).toContain(`No CELLAR work matches OJ reference "${reference}": ${reason}.`);
      expect(notice).toContain('"OJ L 119, 4.5.2016, p. 1"');
      expect(notice).toContain('eurlex_search_documents with keyword');
      const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
      expect(readCommonMark(text)).toContain(notice);
      expect(queries).toHaveLength(1);
    });

    it.each(['OJ L 281', 'OJ L 119/1', 'OJ:L:2016:119:TOC', 'OJ 281, 23.11.1995, p. 31'])(
      'raises ambiguous_identifier for %j with no CELLAR call, naming the OJ reference form',
      async (identifier) => {
        const { structured, queries } = await lookup(identifier);

        expect(structured.error?.data?.reason).toBe('ambiguous_identifier');
        expect(structured.error?.data?.recovery?.hint).toContain('"OJ L 119, 4.5.2016, p. 1"');
        expect(queries).toEqual([]);
      },
    );

    it('parses an OJ reference only under auto', async () => {
      const { structured, queries } = await lookup('OJ L 281, 23.11.1995, p. 31', 'celex');

      expect(structured.found).toBe(false);
      expect(queries.join('\n')).not.toContain('work_id_document');
    });
  });

  // --- Outcomes the OJ spelling (#172) and Commission document (#179) readers keep ---

  describe('outcomes kept beside the newer readers (#172, #179)', () => {
    async function lookup(identifier: string, identifierType?: 'auto' | 'celex') {
      mockQuery.mockResolvedValue([]);
      const result = await runToolContract(eurlex_lookup_celex, {
        identifier,
        ...(identifierType ? { identifier_type: identifierType } : {}),
      });
      const structured = result.structuredContent as Record<string, unknown> & {
        error?: { data?: { reason?: string } };
      };
      return { structured, queries: mockQuery.mock.calls.map((c) => c[0] as string) };
    }

    it.each([
      ['a CELEX with a trailing period', '32016R0679.'],
      ['an OJ reference with no page', 'OJ No C 166, 3. 7. 1995'],
      [
        'two OJ references joined by "and"',
        'OJ No C 277, 5. 11. 1990, p. 3 and OJ No C 159, 17. 6. 1991, p 38',
      ],
      ['a year in round brackets', '(1995) OJ L281/31'],
      ['a bracketed year and a date', '[1995] OJ L 281, 23.11.1995, p. 31'],
      ['a slashed date', 'OJ L 281, 23/11/1995, p. 31'],
      ['a month-name date', 'OJ L 281, 23 November 1995, p. 31'],
      ['an issue and page with no year', 'OJ L 119/1'],
      ['an L-style number under C', 'OJ C 2024/2664'],
      ['a Commission decision number', 'C(2021) 4500 final'],
      ['a document number and a procedure together', 'COM(2021) 206 final – 2021/0106(COD)'],
    ])('raises ambiguous_identifier for %s with no CELLAR call', async (_label, identifier) => {
      const { structured, queries } = await lookup(identifier);

      expect(structured.error?.data?.reason).toBe('ambiguous_identifier');
      expect(queries).toEqual([]);
    });

    it('looks up an ECLI with a trailing period as typed, period included', async () => {
      const { structured, queries } = await lookup('ECLI:EU:C:2014:317.');

      expect(structured.found).toBe(false);
      expect(queries).toHaveLength(1);
      expect(queries[0]).toContain('"ECLI:EU:C:2014:317."^^xsd:string');
    });

    it.each([
      ['C(2021)4500', undefined],
      ['2021/0106', undefined],
      ['CELEX:COM(2021)206', undefined],
      ['COM(2021)206', 'celex' as const],
      ['COM/2021/206', 'celex' as const],
      ['2021/0106(COD)', 'celex' as const],
    ])(
      'looks %s (identifier_type %s) up as a CELEX, a miss',
      async (identifier, identifierType) => {
        const { structured, queries } = await lookup(identifier, identifierType);
        const celex = identifier.replace(/^CELEX:/, '');

        expect(structured.found).toBe(false);
        expect(structured.notice).toContain(`No CELLAR work matches CELEX ${celex}`);
        expect(queries).toHaveLength(1);
        expect(queries[0]).toContain(`?work cdm:resource_legal_id_celex "${celex}"^^xsd:string .`);
      },
    );
  });

  // --- #179: Commission document numbers and procedure references ---

  describe('Commission document numbers and procedure references (#179)', () => {
    /** The `comnat:` document ids CELLAR holds here, with the CELEX of the work carrying each. */
    const DOCUMENT_IDS: Record<string, string> = {
      'comnat:COM_2021_0206_FIN': '52021PC0206',
      'comnat:COM_2020_0066_FIN': '52020DC0066',
      'comnat:SWD_2021_0084_FIN': '52021SC0084',
      'comnat:JOIN_2020_0018_FIN': '52020JC0018',
      'comnat:SEC_2008_0085_FIN': '52008SC0085',
      'comnat:COM_2021_0278_FIN': '52021PC0278',
      'comnat:COM_2021_0278_FIN2': '52021PC0278R(01)',
      'comnat:COM_1990_0314_FIN': '51990DC0314',
      'comnat:COM_1990_0314(01)_FIN': '51990PC0314(01)',
      'comnat:COM_1990_0314(02)_FIN': '51990PC0314(02)',
      'comnat:COM_1990_0314(03)_FIN': '51990PC0314(03)',
      'comnat:COM_1990_0314(04)_FIN': '51990PC0314(04)',
    };
    /**
     * The procedure reference literals CELLAR holds here: one dossier each, with its
     * initiating act's CELEX, in the order CELLAR returns them, which is not CELEX order.
     */
    const PROCEDURES: Record<string, (string | undefined)[]> = {
      '2021/0106/COD': ['52021PC0206'],
      '2008/0264/CNS': ['52008PC0889'],
      '2008/0264/COD': ['52006PC0812'],
      '2000/0247/ACC': ['52000PC0641', '52000PC0609', '52000PC0640', '52000PC0616'],
      '2013/2145(BUD)': ['52013DC0450'],
      '2023/0077B/COD': ['52023PC0177'],
      '2022/132A/COD': [undefined],
      '2021/0053/COD': [undefined],
      '2016/0282/COD': ['52016PC0605', undefined],
      '2014/0204/NLE': [undefined],
      '1981/1012/CNS': [undefined],
      '1979/1030/CNS': [undefined, undefined],
      '2002/0296/CNS': [undefined],
    };
    /**
     * The CELEX of each act a dossier produced (#190), per dossier in `PROCEDURES`
     * order and in the order CELLAR returns them, as CELLAR held them on 2026-11-09.
     */
    const PRODUCED: Record<string, string[][]> = {
      '2021/0106/COD': [['32024R1689']],
      '2000/0247/ACC': [['32000R2228'], ['32000R2313'], ['32000R2227'], []],
      '2016/0282/COD': [['32018R1046', '32017R2393'], ['32017R2393']],
      '2014/0204/NLE': [['32014R0747']],
      '1981/1012/CNS': [['31982R3082', '31985R3307', '31981R3577']],
      '1979/1030/CNS': [['31980R3308'], []],
      '2002/0296/CNS': [['32004R0139', '32004R0139R(03)']],
    };
    const HELD_CELEX = new Set([
      ...Object.values(DOCUMENT_IDS),
      ...Object.values(PROCEDURES).flatMap((initiators) => initiators.flatMap((c) => c ?? [])),
    ]);

    /**
     * CELLAR matching typed literals exactly, as it does for each of these lookups. Neither
     * query sorts, so the rows arrive in no CELEX order: a document number's opposite the
     * VALUES list, a procedure's as `PROCEDURES` lists them. A procedure query that reads
     * the produced acts answers one row per dossier and produced act, as CELLAR does.
     */
    function holdsPreparatory(): void {
      mockQuery.mockImplementation(async (q: string) => {
        const literals = [...q.matchAll(/"([^"]+)"\^\^xsd:string/g)].map((m) => m[1] ?? '');
        if (q.includes('cdm:work_id_document ?documentId')) {
          return literals
            .flatMap((id) =>
              DOCUMENT_IDS[id] ? [{ celex: { type: 'literal', value: DOCUMENT_IDS[id] } }] : [],
            )
            .reverse();
        }
        if (q.includes('cdm:procedure_code_interinstitutional_reference_procedure')) {
          const readsProduced = q.includes('cdm:dossier_produces_resource_legal');
          return literals.flatMap((reference) =>
            (PROCEDURES[reference] ?? []).flatMap((celex, i) => {
              const row = {
                dossier: {
                  type: 'uri',
                  value: `http://publications.europa.eu/resource/cellar/${reference}-${i}`,
                },
                ...(celex ? { celex: { type: 'literal', value: celex } } : {}),
              };
              const produced = readsProduced ? (PRODUCED[reference]?.[i] ?? []) : [];
              return produced.length === 0
                ? [row]
                : produced.map((act) => ({
                    ...row,
                    producedCelex: { type: 'literal', value: act },
                  }));
            }),
          );
        }
        const [celex] = literals;
        return celex && HELD_CELEX.has(celex)
          ? [
              makeBinding(celex, {
                type: `${RESOURCE_TYPE}PROP_REG`,
                date: '2021-04-21',
                canonical: true,
              }),
            ]
          : [];
      });
    }

    async function lookup(identifier: string) {
      const result = await runToolContract(eurlex_lookup_celex, { identifier });
      const structured = result.structuredContent as Record<string, unknown> & {
        error?: { data?: { reason?: string } };
      };
      const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
      return { result, structured, text, queries: mockQuery.mock.calls.map((c) => c[0] as string) };
    }

    beforeEach(holdsPreparatory);

    it.each([
      ['COM(2021) 206 final', '52021PC0206'],
      ['COM(2021)206', '52021PC0206'],
      ['COM/2021/206 final', '52021PC0206'],
      ['COM/2021/206', '52021PC0206'],
      ['COM (2021) 0206', '52021PC0206'],
      ['com(2021) 206 final.', '52021PC0206'],
      ['COM(2020) 66', '52020DC0066'],
      ['SWD(2021) 84 final', '52021SC0084'],
      ['JOIN(2020) 18 final', '52020JC0018'],
      ['SEC(2008) 85', '52008SC0085'],
      ['COM(2021) 278 final/2', '52021PC0278R(01)'],
      ['2021/0106(COD)', '52021PC0206'],
      ['2021/106 (COD)', '52021PC0206'],
      ['2021/0106/COD', '52021PC0206'],
      ['2021/0106(COD).', '52021PC0206'],
      ['2008/0264(CNS)', '52008PC0889'],
      ['2008/0264(COD)', '52006PC0812'],
      ['2013/2145(BUD)', '52013DC0450'],
      ['2023/0077B(COD)', '52023PC0177'],
      // A second dossier with no initiating act, whose produced act is the first's too (#190).
      ['2016/0282(COD)', '52016PC0605'],
    ])(
      'resolves %j to %s with the output of that CELEX lookup and no notice',
      async (identifier, celex) => {
        const viaReference = await lookup(identifier);
        mockQuery.mockClear();
        const viaCelex = await lookup(celex);

        expect(viaReference.structured).toMatchObject({ found: true, celex_number: celex });
        expect(viaReference.structured).not.toHaveProperty('notice');
        expect(viaReference.structured).toEqual(viaCelex.structured);
        expect(viaReference.result.content).toEqual(viaCelex.result.content);
        // One lookup of the number or reference, then exactly the query the CELEX lookup sends.
        expect(viaReference.queries).toHaveLength(2);
        expect(viaReference.queries[0]).toMatch(
          /cdm:work_id_document \?documentId|cdm:procedure_code_interinstitutional_reference_procedure/,
        );
        expect(viaReference.queries[1]).toBe(viaCelex.queries[0]);
      },
    );

    it.each([
      [
        'COM(90) 314 final',
        'Commission document "COM(90) 314 final" (read as COM(1990) 314 final) names 5 works: 51990DC0314, 51990PC0314(01), 51990PC0314(02), 51990PC0314(03), 51990PC0314(04). Pass the CELEX of the one you want here or to eurlex_get_document.',
      ],
      [
        '2000/0247(ACC)',
        'Procedure "2000/0247(ACC)" names 4 initiating acts: 52000PC0609, 52000PC0616, 52000PC0640, 52000PC0641. Pass the CELEX of the one you want here or to eurlex_get_document.',
      ],
    ])(
      'names each CELEX %j reaches, on both surfaces, in one query',
      async (identifier, notice) => {
        const { result, structured, text, queries } = await lookup(identifier);

        expect(result.isError).toBeFalsy();
        expect(Object.keys(structured).sort()).toEqual(['found', 'notice']);
        expect(structured.found).toBe(false);
        expect(structured.notice).toBe(notice);
        expect(readCommonMark(text)).toContain(notice);
        expect(queries).toHaveLength(1);
      },
    );

    it.each([
      [
        'a document number no work carries',
        'COM(2021) 9999 final',
        'Commission document "COM(2021) 9999 final": CELLAR holds no work under that number',
      ],
      [
        'a procedure CELLAR holds no dossier for',
        '2021/2040(INI)',
        'procedure "2021/2040(INI)": CELLAR holds no such procedure',
      ],
      [
        'a procedure with no initiating act',
        '2021/0053(COD)',
        'procedure "2021/0053(COD)": CELLAR records no initiating act with a CELEX for that procedure',
      ],
      [
        'a lettered procedure with no initiating act',
        '2022/132A(COD)',
        'procedure "2022/132A(COD)" (read as 2022/0132A(COD)): CELLAR records no initiating act with a CELEX for that procedure',
      ],
    ])('returns found: false with the notice for %s', async (_label, identifier, reason) => {
      const { result, structured, text, queries } = await lookup(identifier);

      expect(result.isError).toBeFalsy();
      expect(Object.keys(structured).sort()).toEqual(['found', 'notice']);
      const notice = String(structured.notice);
      expect(notice).toContain(`No CELLAR work matches ${reason}.`);
      expect(notice).toContain('"COM(2021) 206 final"');
      expect(notice).toContain('"2021/0106(COD)"');
      expect(notice).toContain('eurlex_search_documents with keyword');
      expect(readCommonMark(text)).toContain(notice);
      expect(queries).toHaveLength(1);
    });

    it('keeps the full v0.20.1 notice for a procedure with no initiating act that produced nothing', async () => {
      const { structured, text, queries } = await lookup('2021/0053(COD)');

      expect(structured.notice).toBe(
        'No CELLAR work matches procedure "2021/0053(COD)": CELLAR records no initiating act with a CELEX for that procedure. A Commission document resolves when it names its series (COM, SEC, SWD, or JOIN), year, and number (e.g. "COM(2021) 206 final"), and a procedure reference when it names its year, number, and type (e.g. "2021/0106(COD)"). To find the act by title words, use eurlex_search_documents with keyword.',
      );
      expect(readCommonMark(text)).toContain(String(structured.notice));
      expect(queries).toHaveLength(1);
    });

    // --- #190: the acts a procedure with no initiating act produced ---

    it.each([
      [
        '2014/0204(NLE)',
        'No initiating act with a CELEX is recorded for procedure "2014/0204(NLE)"; it produced 32014R0747. Pass that CELEX here or to eurlex_get_document.',
      ],
      [
        '1981/1012(CNS)',
        'No initiating act with a CELEX is recorded for procedure "1981/1012(CNS)"; it produced 3 acts: 31981R3577, 31982R3082, 31985R3307. Pass the CELEX of the one you want here or to eurlex_get_document.',
      ],
      [
        '1981/1012/CNS',
        'No initiating act with a CELEX is recorded for procedure "1981/1012/CNS" (read as 1981/1012(CNS)); it produced 3 acts: 31981R3577, 31982R3082, 31985R3307. Pass the CELEX of the one you want here or to eurlex_get_document.',
      ],
      [
        '1979/1030(CNS)',
        'No initiating act with a CELEX is recorded for procedure "1979/1030(CNS)"; it produced 31980R3308. Pass that CELEX here or to eurlex_get_document.',
      ],
      [
        '2002/0296(CNS)',
        'No initiating act with a CELEX is recorded for procedure "2002/0296(CNS)"; it produced 2 acts: 32004R0139, 32004R0139R(03). Pass the CELEX of the one you want here or to eurlex_get_document.',
      ],
    ])(
      'names the acts %j produced, found false, on both surfaces, in one query (#190)',
      async (identifier, notice) => {
        const { result, structured, text, queries } = await lookup(identifier);

        expect(result.isError).toBeFalsy();
        expect(Object.keys(structured).sort()).toEqual(['found', 'notice']);
        expect(structured.found).toBe(false);
        expect(structured.notice).toBe(notice);
        expect(readCommonMark(text)).toContain(notice);
        expect(text).toContain('**Found:** false');
        expect(queries).toHaveLength(1);
      },
    );

    it('sends the typed reference literals, never the procedure alias', async () => {
      const { queries } = await lookup('2021/106 (COD)');

      expect(queries[0]).toContain(
        'VALUES ?reference { "2021/0106/COD"^^xsd:string "2021/0106(COD)"^^xsd:string }',
      );
      expect(queries[0]).not.toContain('resource/procedure');
    });

    it('names the Commission document and procedure forms in the ambiguous_identifier recovery', async () => {
      const { structured } = await lookup('C(2021) 4500 final');
      const hint =
        (structured.error?.data as { recovery?: { hint?: string } } | undefined)?.recovery?.hint ??
        '';

      expect(structured.error?.data?.reason).toBe('ambiguous_identifier');
      expect(hint).toContain('"COM(2021) 206 final"');
      expect(hint).toContain('"2021/0106(COD)"');
    });
  });

  // --- Markdown safety of content[] ---

  describe('content[] reads back as structuredContent', () => {
    function contentText(result: { content: unknown[] }): string[] {
      return result.content.map((b) => (b as { text?: string }).text ?? '');
    }

    it('escapes CELLAR values in the resolved-work block', async () => {
      const values = {
        celex: '3*2016*R_0679 `x`',
        ecli: 'ECLI:EU:C:2014:317 [x](y) <b>z</b>',
        work: 'http://publications.europa.eu/resource/cellar/a_b|c\\',
        type: '# Heading | 1. *x*',
        date: '- 2016-04-27 ~~x~~',
      };
      mockQuery.mockResolvedValue([
        {
          celexNumber: { type: 'literal', value: values.celex },
          work: { type: 'uri', value: values.work },
          type: { type: 'uri', value: `${RESOURCE_TYPE}${values.type}` },
          date: { type: 'literal', value: values.date },
          ecli: { type: 'literal', value: values.ecli },
        },
      ]);

      const result = await runToolContract(eurlex_lookup_celex, { identifier: '32016R0679' });
      const [block = ''] = contentText(result);
      const read = readCommonMark(block);

      expect(result.structuredContent).toMatchObject({
        celex_number: values.celex,
        ecli: values.ecli,
        work_uri: values.work,
        resource_type: values.type,
        date: values.date,
      });
      expect(read).toContain(`⟨strong⟩CELEX:⟨/strong⟩ ${values.celex}\n`);
      expect(read).toContain(`⟨strong⟩ECLI:⟨/strong⟩ ${values.ecli}\n`);
      expect(read).toContain(`⟨strong⟩Work URI:⟨/strong⟩ ${values.work}\n`);
      expect(read).toContain(`⟨strong⟩Type:⟨/strong⟩ ${values.type}\n`);
      expect(read).toContain(`⟨strong⟩Date:⟨/strong⟩ ${values.date}`);
    });

    it('leaves the parentheses and hyphens of real identifiers unescaped', async () => {
      mockQuery.mockResolvedValue([
        makeBinding('32016R0679R(02)', {
          workUri:
            'http://publications.europa.eu/resource/cellar/3e485e15-11bd-11e6-ba9a-01aa75ed71a1',
        }),
      ]);

      const result = await runToolContract(eurlex_lookup_celex, {
        identifier: '32016R0679R(02)',
      });
      const [block = ''] = contentText(result);

      expect(block).toContain('**CELEX:** 32016R0679R(02)');
      expect(block).toContain(
        '**Work URI:** http://publications.europa.eu/resource/cellar/3e485e15-11bd-11e6-ba9a-01aa75ed71a1',
      );
    });

    it.each([
      ['a citation miss', 'Regulation (EU) 2016/9999 of *the* [x](y) <b>Council</b> | _a_ \\'],
      ['a case number', 'Case C-131/12'],
      ['an OJ reference over two lines', 'OJ L 999,\n1.1.2018, p. 1'],
    ])('renders the notice of %s so it reads back as written', async (_label, identifier) => {
      mockQuery.mockResolvedValue([]);
      const result = await runToolContract(eurlex_lookup_celex, { identifier });
      const notice = String((result.structuredContent as { notice?: string }).notice);
      const trailer = contentText(result).at(-1) ?? '';

      expect(notice).toContain(`"${identifier.trim()}"`);
      expect(readCommonMark(trailer)).toBe(`⟨blockquote_open⟩\n\n${notice}\n\n⟨blockquote_close⟩`);
    });
  });

  // --- #147: pasted citation forms ---

  describe('pasted citation forms (#147)', () => {
    const GDPR_OJ_ELI = 'http://data.europa.eu/eli/reg/2016/679/oj';
    const GDPR_PIT_ELI = 'http://data.europa.eu/eli/reg/2016/679/2016-05-04';

    /**
     * CELLAR holds exactly these CELEX and ELI literals: a typed CELEX lookup or an
     * ELI exact match answers only for its own literal.
     */
    function holds(): void {
      mockQuery.mockImplementation(async (q: string) => {
        for (const celex of [
          '32016R0679',
          '02016R0679-20160504',
          '32016R0679R(02)',
          '31995L0046',
        ]) {
          if (q.includes(`"${celex}"^^xsd:string`)) {
            return [makeBinding(celex, { type: `${RESOURCE_TYPE}REG`, canonical: true })];
          }
        }
        if (q.includes(`"${GDPR_OJ_ELI}"^^xsd:anyURI`)) return [makeBinding('32016R0679')];
        if (q.includes(`"${GDPR_PIT_ELI}"^^xsd:anyURI`))
          return [makeBinding('02016R0679-20160504')];
        return [];
      });
    }

    async function lookup(identifier: string, identifierType?: 'auto' | 'celex' | 'eli') {
      const result = await runToolContract(eurlex_lookup_celex, {
        identifier,
        ...(identifierType ? { identifier_type: identifierType } : {}),
      });
      const structured = result.structuredContent as Record<string, unknown> & {
        error?: { data?: { reason?: string } };
      };
      const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
      const queries = mockQuery.mock.calls.map((c) => c[0] as string);
      return { structured, text, queries };
    }

    beforeEach(holds);

    it.each([
      ['a lowercase CELEX', '32016r0679', '32016R0679'],
      ['a lowercase consolidated CELEX', '02016r0679-20160504', '02016R0679-20160504'],
      ['a lowercase corrigendum', '32016r0679r(02)', '32016R0679R(02)'],
      ['a CELEX: prefix', 'CELEX:32016R0679', '32016R0679'],
      ['a celex: prefix', 'celex:32016R0679', '32016R0679'],
      ['an encoded prefix', 'CELEX%3A32016R0679', '32016R0679'],
      [
        'a legal-content URL',
        'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32016R0679',
        '32016R0679',
      ],
      [
        'a TXT/HTML URL with parameters and a fragment',
        'https://eur-lex.europa.eu/legal-content/FR/TXT/HTML/?uri=CELEX%3A32016R0679&qid=1#d1e40',
        '32016R0679',
      ],
      [
        'a URL naming an encoded corrigendum',
        'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32016R0679R%2802%29',
        '32016R0679R(02)',
      ],
      [
        'the legacy LexUriServ URL',
        'https://eur-lex.europa.eu/LexUriServ/LexUriServ.do?uri=CELEX:31995L0046:EN:HTML',
        '31995L0046',
      ],
      [
        'a resource/celex alias URI',
        'http://publications.europa.eu/resource/celex/32016R0679',
        '32016R0679',
      ],
      ['an https ELI', 'https://data.europa.eu/eli/reg/2016/679/oj', '32016R0679'],
      ['an https bare work ELI', 'https://data.europa.eu/eli/reg/2016/679', '32016R0679'],
      ['an eur-lex ELI', 'https://eur-lex.europa.eu/eli/reg/2016/679/oj', '32016R0679'],
      ['a scheme-less ELI', 'data.europa.eu/eli/reg/2016/679/oj', '32016R0679'],
      ['an upper-case-host ELI', 'HTTP://DATA.EUROPA.EU/eli/reg/2016/679/oj', '32016R0679'],
      ['a trailing-slash ELI', 'http://data.europa.eu/eli/reg/2016/679/oj/', '32016R0679'],
      ['a language-suffixed ELI', 'http://data.europa.eu/eli/reg/2016/679/oj/eng', '32016R0679'],
      [
        'a point-in-time ELI with a language',
        'http://data.europa.eu/eli/reg/2016/679/2016-05-04/eng',
        '02016R0679-20160504',
      ],
    ])('resolves %s under auto', async (_label, identifier, celex) => {
      const { structured, text } = await lookup(identifier);

      expect(structured).toMatchObject({ found: true, celex_number: celex });
      expect(text).toContain(`**CELEX:** ${celex}`);
    });

    it.each([
      ['a lowercase CELEX', '32016r0679', '32016R0679'],
      ['a CELEX: prefix', 'CELEX:32016R0679', '32016R0679'],
      [
        'a legal-content URL',
        'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32016R0679',
        '32016R0679',
      ],
    ])('resolves %s under identifier_type "celex"', async (_label, identifier, celex) => {
      const { structured } = await lookup(identifier, 'celex');
      expect(structured).toMatchObject({ found: true, celex_number: celex });
    });

    it.each([
      ['an https ELI', 'https://data.europa.eu/eli/reg/2016/679/oj'],
      ['a language-suffixed eur-lex ELI', 'https://eur-lex.europa.eu/eli/reg/2016/679/oj/fra'],
      ['a trailing-slash ELI', 'http://data.europa.eu/eli/reg/2016/679/oj/'],
    ])('resolves %s under identifier_type "eli"', async (_label, identifier) => {
      const { structured } = await lookup(identifier, 'eli');
      expect(structured).toMatchObject({ found: true, celex_number: '32016R0679' });
    });

    it('echoes the normalized CELEX and the pasted form in the notice of a miss', async () => {
      const { structured, text } = await lookup('celex:32016r9999');

      expect(structured.found).toBe(false);
      expect(structured.notice).toContain('CELEX 32016R9999 (parsed from "celex:32016r9999")');
      expect(text).toContain('CELEX 32016R9999 (parsed from "celex:32016r9999")');
    });

    it.each([
      ['C-131/12', undefined],
      ['Case C-131/12', undefined],
      ['T-1/99 P', undefined],
      ['C-131/12', 'celex' as const],
    ])(
      'answers the case number %s (identifier_type %s) with found: false and the eurlex_get_cases route, no CELLAR call',
      async (identifier, identifierType) => {
        const { structured, text, queries } = await lookup(identifier, identifierType);

        expect(structured.error).toBeUndefined();
        expect(structured.found).toBe(false);
        expect(structured.notice).toContain('eurlex_get_cases');
        expect(structured.notice).toContain('case_number');
        expect(structured.notice).toContain(`"${identifier}"`);
        expect(text).toContain(structured.notice as string);
        expect(queries).toEqual([]);
      },
    );

    it.each([
      ['a word', 'privacy'],
      ['a bare EuroVoc code', '3030'],
      ['a prefixed EuroVoc code', 'eurovoc:3030'],
      ['a prefix-less case number', '26/62'],
      [
        'a EUR-Lex URL naming no CELEX',
        'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=OJ:L:2016:119:TOC',
      ],
    ])('keeps ambiguous_identifier for %s, with no CELLAR call', async (_label, identifier) => {
      const { structured, queries } = await lookup(identifier);

      expect(structured.error?.data?.reason).toBe('ambiguous_identifier');
      expect(queries).toEqual([]);
    });

    it('keeps an ELI format segment as given: a miss on that literal', async () => {
      const eli = 'http://data.europa.eu/eli/reg/2016/679/oj/eng/pdf';
      const { structured } = await lookup(eli);

      expect(structured.found).toBe(false);
      expect(structured.notice).toContain(`No CELLAR work matches ELI ${eli}.`);
    });
  });

  // --- #194: the keys callers guess for identifier ---

  describe('input aliases (#194)', () => {
    const contentText = (result: { content: unknown[] }) =>
      result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    const sentQueries = () => mockQuery.mock.calls.map((c) => c[0] as string);

    /** Call the tool with arguments as a client sends them, keys the schema omits included. */
    const callTool = (args: Record<string, unknown>) =>
      runToolContract(eurlex_lookup_celex, args as z.input<typeof eurlex_lookup_celex.input>);

    /** CELLAR holds the GDPR and Directive 95/46/EC alone. */
    beforeEach(() => {
      mockQuery.mockImplementation(async (q: string) => {
        for (const [celex, type] of [
          ['32016R0679', 'REG'],
          ['31995L0046', 'DIR'],
        ] as const) {
          if (q.includes(`"${celex}"^^xsd:string`)) {
            return [makeBinding(celex, { type: `${RESOURCE_TYPE}${type}`, canonical: true })];
          }
        }
        return [];
      });
    });

    it.each([
      ['celex', '32016R0679', '32016R0679'],
      ['celex_number', 'celex:32016r0679', '32016R0679'],
      ['celexNumber', '32016R0679', '32016R0679'],
      ['citation', 'Regulation (EU) 2016/679', '32016R0679'],
      ['reference', 'Directive 95/46/EC', '31995L0046'],
      ['query', 'Regulation (EU) 2016/679', '32016R0679'],
    ])(
      'serves %s as identifier: the same lookup, result, and content[]',
      async (alias, value, celex) => {
        const viaTarget = await callTool({ identifier: value });
        const targetQueries = sentQueries();
        mockQuery.mockClear();

        const viaAlias = await callTool({ [alias]: value });

        expect(viaAlias.isError).toBeFalsy();
        expect(viaAlias.structuredContent).toMatchObject({ found: true, celex_number: celex });
        expect(viaAlias.structuredContent).toStrictEqual(viaTarget.structuredContent);
        expect(viaAlias.content).toStrictEqual(viaTarget.content);
        expect(sentQueries()).toStrictEqual(targetQueries);
        expect(targetQueries.length).toBeGreaterThan(0);
      },
    );

    it('serves an alias under a forced identifier_type', async () => {
      const result = await callTool({ celex: '32016R0679', identifier_type: 'celex' });

      expect(result.structuredContent).toMatchObject({ found: true, celex_number: '32016R0679' });
      expect(contentText(result)).toContain('**CELEX:** 32016R0679');
    });

    it.each(['celex', 'celex_number', 'celexNumber', 'citation', 'reference', 'query'])(
      'rejects %s sent beside identifier with the alias hint, before any CELLAR request',
      async (alias) => {
        const hint = `${alias} is an alias of identifier; send one of them, not both.`;

        const result = await callTool({ identifier: '32016R0679', [alias]: '32016R0679' });

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: { code: JsonRpcErrorCode.InvalidParams, data: { recovery: { hint } } },
        });
        expect(contentText(result)).toContain(hint);
        expect(mockQuery).not.toHaveBeenCalled();
      },
    );

    it.each([
      [
        // The first declared alias is moved onto identifier, so the hint reports that too.
        'two aliases',
        { celex: '32016R0679', query: '32016R0679' },
        'celex and query are aliases of identifier; send one of them, not both. Validated celex as identifier.',
      ],
      [
        'two aliases beside identifier',
        { identifier: '32016R0679', celex: '32016R0679', query: '32016R0679' },
        'celex and query are aliases of identifier; send only one of them.',
      ],
    ])('rejects %s with the alias hint naming each', async (_label, args, hint) => {
      const result = await callTool(args);

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams, data: { recovery: { hint } } },
      });
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });
});

// --- CELLAR failures carry this tool's own recovery ---

describe('eurlex_lookup_celex CELLAR failures', () => {
  beforeEach(() => {
    mockQuery.mockReset();
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
  ])('fails %s with recovery naming identifier_type', async (reason, code, failure) => {
    mockQuery.mockRejectedValue(failure());

    const result = await runToolContract(eurlex_lookup_celex, { identifier: 'ECLI:EU:C:2014:317' });

    expect(result.isError).toBe(true);
    const error = (
      result.structuredContent as {
        error: { code: number; data: { reason: string; recovery?: { hint?: string } } };
      }
    ).error;
    expect(error.code).toBe(code);
    expect(error.data.reason).toBe(reason);
    const hint = error.data.recovery?.hint ?? '';
    expect(hint).toContain('identifier_type');
    expect(hint).toBe(eurlex_lookup_celex.errors?.find((e) => e.reason === reason)?.recovery);
    const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(text).toContain(hint);
  });
});

// --- #177: a timeout is retryable, and identifier_type "celex" is offered only to another form ---

describe('eurlex_lookup_celex sparql_timeout recovery (#177)', () => {
  const CONTRACT = eurlex_lookup_celex.errors?.find((e) => e.reason === 'sparql_timeout')?.recovery;
  const CELEX_ALTERNATIVE =
    ' When you know its CELEX, pass it with identifier_type "celex" for a single exact-match query.';
  const BUDGET_SPENT = 'CELLAR SPARQL queries for this request ran past the time budget they share';
  const budgetSpent = () =>
    serviceUnavailable(BUDGET_SPENT, { reason: 'sparql_timeout', retryable: true });

  beforeEach(() => {
    mockQuery.mockReset();
  });

  /** The wire error data and content[] text of one lookup. */
  async function timedOut(identifier: string) {
    const result = await runToolContract(eurlex_lookup_celex, { identifier });
    expect(result.isError).toBe(true);
    const error = (
      result.structuredContent as {
        error: { data: { reason: string; retryable?: boolean; recovery?: { hint?: string } } };
      }
    ).error;
    const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    return { data: error.data, text };
  }

  it.each([
    ['a CELEX', '32016R0679', ''],
    ['an OJ citation, looked up as the CELEX it names', 'Regulation (EU) 2016/679', ''],
    ['an ELI', 'http://data.europa.eu/eli/reg/2016/679', CELEX_ALTERNATIVE],
    ['an ECLI', 'ECLI:EU:C:2014:317', CELEX_ALTERNATIVE],
    ['an Official Journal reference', 'OJ L 119, 4.5.2016, p. 1', CELEX_ALTERNATIVE],
    ['a Commission document number', 'COM(2021) 206 final', CELEX_ALTERNATIVE],
  ])('answers %s', async (_label, identifier, alternative) => {
    mockQuery.mockRejectedValue(budgetSpent());

    const { data, text } = await timedOut(identifier);

    expect(data).toMatchObject({ reason: 'sparql_timeout', retryable: true });
    expect(data.recovery?.hint).toBe(`${CONTRACT}${alternative}`);
    expect(text).toContain(`Recovery: ${CONTRACT}${alternative}`);
    expect(text.trimEnd().endsWith('(reason sparql_timeout · retryable)')).toBe(true);
  });

  it('never offers identifier_type in the hint every caller receives', () => {
    expect(CONTRACT).not.toContain('identifier_type');
  });

  it('keeps the contract recovery for the CELEX query an ECLI resolves to', async () => {
    // The ECLI's only row is not the CELEX's canonical work, so its CELEX is looked up next.
    mockQuery.mockImplementation((query: string) =>
      query.includes('VALUES ?ecli')
        ? Promise.resolve([makeBinding('62012CJ0131', { ecli: 'ECLI:EU:C:2014:317' })])
        : Promise.reject(budgetSpent()),
    );

    const { data } = await timedOut('ECLI:EU:C:2014:317');

    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(data).toMatchObject({ reason: 'sparql_timeout', retryable: true });
    expect(data.recovery?.hint).toBe(CONTRACT);
  });
});
