/**
 * @fileoverview Tests for eurlex_get_document tool.
 * @module tests/tools/eurlex-get-document.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eurlex_get_document } from '@/mcp-server/tools/definitions/eurlex-get-document.tool.js';
import { parseActStructure } from '@/services/eurlex-content/act-structure.js';
import { EURLEX_LANGUAGES } from '@/services/eurlex-content/eurlex-content-service.js';
import { htmlToMarkdown } from '@/services/eurlex-content/html-to-markdown.js';
import {
  ACTS,
  fakeConsolidationCellar,
  isConsolidationLookup,
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
import { AI_ACT_HEADINGS, actHtml } from '../fixtures/eurlex-act-headings.js';
import { AMENDING_FORMEX, AMENDING_HTML } from '../fixtures/eurlex-amending-act.js';
import { CONSOLIDATED_ACT_HTML } from '../fixtures/eurlex-consolidated-act.js';
import { LEGACY_ACT_HTML, LEGACY_TWO_CHAPTER_ACT_HTML } from '../fixtures/eurlex-legacy-act.js';

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

vi.mock('@/services/eurlex-content/eurlex-content-service.js', async (importOriginal) => ({
  ...(await importOriginal()),
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

  describe('legal_basis and eurovoc_subjects resolve inline (#67)', () => {
    const core = makeMetaBinding({ celex: '32016R0679' });
    const LB = 'http://publications.europa.eu/resource/cellar/fc797fa2-af0e-4cbd-8e74-5ed41139e4dc';
    /** Route each dimension query to its own rows, as the live service would. */
    const routeQueries = (rows: {
      legalBasis?: Record<string, { type: string; value: string }>[];
      eurovoc?: Record<string, { type: string; value: string }>[];
    }) =>
      mockSparqlQuery.mockImplementation(async (sparql: string) => {
        if (isResolutionQuery(sparql)) return resolutionRows(sparql);
        if (sparql.includes('cdm:resource_legal_based_on_resource_legal'))
          return rows.legalBasis ?? [];
        if (sparql.includes('cdm:work_is_about_concept_eurovoc')) return rows.eurovoc ?? [];
        if (sparql.includes('cdm:work_created_by_agent')) return [];
        return [core];
      });

    it('returns CELEX beside each legal basis URI and a label beside each concept, on both surfaces', async () => {
      const ctx = createMockContext({ errors: eurlex_get_document.errors });
      routeQueries({
        legalBasis: [
          {
            legalBasis: { type: 'uri', value: LB },
            celex: { type: 'literal', value: '12012E016' },
          },
        ],
        eurovoc: [
          {
            eurovoc: { type: 'uri', value: 'http://eurovoc.europa.eu/5181' },
            label: { type: 'literal', value: 'data protection' },
          },
          {
            eurovoc: { type: 'uri', value: 'http://eurovoc.europa.eu/2828' },
            label: { type: 'literal', value: 'protection of privacy' },
          },
        ],
      });

      const input = eurlex_get_document.input.parse({
        celex_number: '32016R0679',
        content_mode: 'metadata_only',
      });
      const result = await eurlex_get_document.handler(input, ctx);

      expect(result.legal_basis).toEqual([{ work_uri: LB, celex_number: '12012E016' }]);
      expect(result.eurovoc_subjects).toEqual([
        { concept_uri: 'http://eurovoc.europa.eu/5181', label: 'data protection' },
        { concept_uri: 'http://eurovoc.europa.eu/2828', label: 'protection of privacy' },
      ]);

      const queries = mockSparqlQuery.mock.calls.map((c) => c[0] as string);
      const legalBasisQuery = queries.find((q) =>
        q.includes('cdm:resource_legal_based_on_resource_legal'),
      );
      expect(legalBasisQuery).toContain(
        'OPTIONAL { ?legalBasis cdm:resource_legal_id_celex ?celexValue . }',
      );
      expect(legalBasisQuery).toContain('GROUP BY ?legalBasis');
      const eurovocQuery = queries.find((q) => q.includes('cdm:work_is_about_concept_eurovoc'));
      expect(eurovocQuery).toContain('?eurovoc skos:prefLabel ?labelValue');
      expect(eurovocQuery).toContain('FILTER(LANG(?labelValue) = "en")');
      expect(eurovocQuery).toContain('GROUP BY ?eurovoc');

      const text = (eurlex_get_document.format!(result)[0] as { text: string }).text;
      expect(text).toContain(`**Legal Basis:** 12012E016 (${LB})`);
      expect(text).toContain('data protection (http://eurovoc.europa.eu/5181)');
      expect(text).toContain('protection of privacy (http://eurovoc.europa.eu/2828)');
    });

    it('keeps a URI whose CELEX or label is unbound and omits the optional property', async () => {
      const ctx = createMockContext({ errors: eurlex_get_document.errors });
      routeQueries({
        legalBasis: [{ legalBasis: { type: 'uri', value: LB } }],
        eurovoc: [{ eurovoc: { type: 'uri', value: 'http://eurovoc.europa.eu/9999' } }],
      });

      const input = eurlex_get_document.input.parse({
        celex_number: '32016R0679',
        content_mode: 'metadata_only',
      });
      const result = await eurlex_get_document.handler(input, ctx);

      expect(result.legal_basis).toEqual([{ work_uri: LB }]);
      expect(result.legal_basis?.[0]).not.toHaveProperty('celex_number');
      expect(result.eurovoc_subjects).toEqual([{ concept_uri: 'http://eurovoc.europa.eu/9999' }]);
      expect(result.eurovoc_subjects?.[0]).not.toHaveProperty('label');

      const text = (eurlex_get_document.format!(result)[0] as { text: string }).text;
      expect(text).toContain(`**Legal Basis:** ${LB}`);
      expect(text).toContain('**EuroVoc Subjects:** http://eurovoc.europa.eu/9999');
    });

    it('omits both fields for a document with no legal basis and no subjects', async () => {
      const ctx = createMockContext({ errors: eurlex_get_document.errors });
      routeQueries({});

      const input = eurlex_get_document.input.parse({
        celex_number: '12012E016',
        content_mode: 'metadata_only',
      });
      const result = await eurlex_get_document.handler(input, ctx);

      expect(result).not.toHaveProperty('legal_basis');
      expect(result).not.toHaveProperty('eurovoc_subjects');
      const text = (eurlex_get_document.format!(result)[0] as { text: string }).text;
      expect(text).not.toContain('**Legal Basis:**');
      expect(text).not.toContain('**EuroVoc Subjects:**');
    });

    it('filters EuroVoc labels by the requested language', async () => {
      const ctx = createMockContext({ errors: eurlex_get_document.errors });
      routeQueries({});

      const input = eurlex_get_document.input.parse({
        celex_number: '32016R0679',
        language: 'fr',
        content_mode: 'metadata_only',
      });
      await eurlex_get_document.handler(input, ctx);

      const eurovocQuery = mockSparqlQuery.mock.calls
        .map((c) => c[0] as string)
        .find((q) => q.includes('cdm:work_is_about_concept_eurovoc'));
      expect(eurovocQuery).toContain('FILTER(LANG(?labelValue) = "fr")');
    });
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

    expect(result.legal_basis).toEqual([{ work_uri: 'http://lb1' }, { work_uri: 'http://lb2' }]);
    expect(result.eurovoc_subjects).toEqual([
      { concept_uri: 'http://ev1' },
      { concept_uri: 'http://ev2' },
    ]);
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
    expect(result.requested_language).toBe('FR');
    expect(result.content_status).toBe('available');

    const text = (eurlex_get_document.format!(result)[0] as { text: string }).text;
    expect(text).toContain('**Requested language:** FR');
    expect(text).toContain('**Effective content language:** EN');
    expect(text).toContain('**Content status:** available');
  });

  it('accepts every supported language case-insensitively and normalizes to uppercase', () => {
    for (const language of EURLEX_LANGUAGES) {
      expect(
        eurlex_get_document.input.parse({
          celex_number: '32016R0679',
          language: language.toLowerCase(),
        }).language,
      ).toBe(language);
    }
  });

  it.each(['ZZ', 'ENG', 'e'])(
    'rejects unsupported language %s before the handler runs',
    (language) => {
      expect(() =>
        eurlex_get_document.input.parse({ celex_number: '32016R0679', language }),
      ).toThrow();
      expect(mockSparqlQuery).not.toHaveBeenCalled();
      expect(mockFetchContent).not.toHaveBeenCalled();
    },
  );

  it('advertises the case-insensitive supported-language constraint to MCP clients', () => {
    const schema = z.toJSONSchema(eurlex_get_document.input, { io: 'input' });
    const languageSchema = schema.properties?.language as { pattern?: string };

    expect(languageSchema.pattern).toBeDefined();
    const advertisedConstraint = new RegExp(languageSchema.pattern ?? '');
    expect(advertisedConstraint.test('eN')).toBe(true);
    expect(advertisedConstraint.test('Fr')).toBe(true);
    expect(advertisedConstraint.test('ZZ')).toBe(false);
    expect(advertisedConstraint.test('ENG')).toBe(false);
  });

  it('advertises only reachable document error reasons', () => {
    expect(eurlex_get_document.errors?.map((entry) => entry.reason)).toEqual([
      'invalid_identifier_args',
      'not_found',
      'content_challenge',
    ]);
  });

  it('returns content_available: false when content fetch fails', async () => {
    const ctx = createMockContext({ errors: eurlex_get_document.errors });
    mockSparqlQuery.mockResolvedValue([makeMetaBinding({ celex: '32016R0679' })]);
    mockFetchContent.mockResolvedValue({
      content: '',
      contentAvailable: false,
      format: 'html',
      language: 'EN',
      unavailabilityReason: 'upstream_failure',
    });

    const input = eurlex_get_document.input.parse({ celex_number: '32016R0679' });
    const result = await eurlex_get_document.handler(input, ctx);

    expect(result.content_available).toBe(false);
    expect(result.content).toBeUndefined();
    expect(result.content_status).toBe('unavailable');
    expect(result.content_unavailability_reason).toBe('upstream_failure');

    const text = (eurlex_get_document.format!(result)[0] as { text: string }).text;
    expect(text).toContain('**Content status:** unavailable');
    expect(text).toContain('upstream_failure');
  });

  describe('an unavailable body, per reason (#108)', () => {
    const REASONS = ['no_representation', 'upstream_failure', 'multipart_incomplete'] as const;

    async function unavailable(
      reason: (typeof REASONS)[number],
      language: 'EN' | 'FR' = 'EN',
      format: 'html' | 'xml' = 'xml',
    ) {
      const ctx = createMockContext({ errors: eurlex_get_document.errors });
      mockSparqlQuery.mockResolvedValue([makeMetaBinding({ celex: '32024R1689' })]);
      mockFetchContent.mockResolvedValue({
        content: '',
        contentAvailable: false,
        format,
        language,
        unavailabilityReason: reason,
      });
      const input = eurlex_get_document.input.parse({
        celex_number: '32024R1689',
        language,
        format,
      });
      const result = await eurlex_get_document.handler(input, ctx);
      const text = (eurlex_get_document.format!(result)[0] as { text: string }).text;
      return { result, closing: text.split('\n').at(-1) ?? '' };
    }

    it.each(REASONS)('keeps structuredContent to status and reason for %s', async (reason) => {
      const { result } = await unavailable(reason);
      expect(result).toMatchObject({
        content_available: false,
        content_status: 'unavailable',
        content_unavailability_reason: reason,
        content_format: 'xml',
        language: 'EN',
      });
      expect(result.content).toBeUndefined();
      expect(result.content_chars_total).toBeUndefined();
    });

    it('closes each reason with its own line, and only no_representation names the language', async () => {
      const closings = await Promise.all(
        REASONS.map(async (reason) => (await unavailable(reason)).closing),
      );

      expect(new Set(closings).size).toBe(3);
      for (const closing of closings) expect(closing).toMatch(/^\*.+\*$/);
      const [none, failed, incomplete] = closings;
      expect(none).toMatch(/requested language/);
      expect(none).toContain('xml');
      expect(failed).not.toMatch(/language/i);
      expect(failed).toMatch(/retry/i);
      expect(incomplete).not.toMatch(/language/i);
      expect(incomplete).toMatch(/Formex/);
    });

    it('says no_representation covered the English fallback when another language was asked for', async () => {
      const english = (await unavailable('no_representation', 'EN', 'html')).closing;
      const french = (await unavailable('no_representation', 'FR', 'html')).closing;

      expect(english).not.toMatch(/English/);
      expect(french).toMatch(/requested language or in English/);
      expect(french).toContain('html');
    });
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
    const sparql = mockSparqlQuery.mock.calls
      .map((c) => c[0] as string)
      .find((q) => q.includes('cdm:expression_title')) as string;
    expect(sparql).toContain('cdm:expression_belongs_to_work');
    expect(sparql).toContain('cdm:expression_title');
    // Obsolete work-level pattern must be gone.
    expect(sparql).not.toContain('cdm:work_title');
  });

  // --- Title in the served language (#133) ---

  describe('title in the served language (#133)', () => {
    const EN_TITLE = 'Regulation (EU) 2016/679 of the European Parliament and of the Council';
    const FR_TITLE = 'Règlement (UE) 2016/679 du Parlement européen et du Conseil';
    const literal = (value: string) => ({ type: 'literal', value });

    /** Answer the core query with the given titles and every other metadata query with nothing. */
    const routeTitles = (titles: { title?: string; languageTitle?: string }) =>
      mockSparqlQuery.mockImplementation(async (sparql: string) => {
        if (isResolutionQuery(sparql)) return resolutionRows(sparql);
        if (!sparql.includes('cdm:expression_belongs_to_work')) return [];
        return [
          {
            ...(titles.title ? { title: literal(titles.title) } : {}),
            ...(titles.languageTitle ? { languageTitle: literal(titles.languageTitle) } : {}),
          },
        ];
      });
    const titleQueries = () =>
      mockSparqlQuery.mock.calls
        .map((c) => c[0] as string)
        .filter((q) => q.includes('cdm:expression_title'));
    const getTitle = async (args: Record<string, unknown>) => {
      const result = await runToolContract(eurlex_get_document, {
        celex_number: '32016R0679',
        ...args,
      });
      const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
      return { title: eurlex_get_document.output.parse(result.structuredContent).title, text };
    };

    it.each([
      ['fr', 'FRA'],
      ['de', 'DEU'],
      ['ga', 'GLE'],
    ])(
      'reads the %s expression title beside the English one, in the one core query',
      async (language, code) => {
        routeTitles({ title: EN_TITLE, languageTitle: FR_TITLE });
        const { title, text } = await getTitle({ language, content_mode: 'metadata_only' });

        expect(title).toBe(FR_TITLE);
        expect(text).toContain(`## 32016R0679 — ${FR_TITLE}`);
        const [query, ...others] = titleQueries();
        expect(others).toEqual([]);
        expect(query).toContain(
          `?languageExpr cdm:expression_uses_language <http://publications.europa.eu/resource/authority/language/${code}> .`,
        );
        expect(query).toContain('?languageExpr cdm:expression_title ?languageTitleValue .');
        expect(query).toContain('(MAX(STR(?languageTitleValue)) AS ?languageTitle)');
        expect(query).toContain('?expr cdm:expression_uses_language <');
      },
    );

    it('picks the served-language title deterministically, never by SAMPLE', async () => {
      routeTitles({ title: EN_TITLE, languageTitle: FR_TITLE });
      await getTitle({ language: 'fr', content_mode: 'metadata_only' });
      const [query] = titleQueries();
      // A work with several French titles yields the greatest one on every call.
      expect(query).toMatch(/\(MAX\(STR\(\?languageTitleValue\)\) AS \?languageTitle\)/);
      expect(query).not.toContain('SAMPLE(?languageTitleValue)');
      expect(query).toMatch(/GROUP BY \?type \?date \?title \?inForce/);
      expect(query).not.toMatch(/GROUP BY[^\n]*\?languageTitle/);
    });

    it('falls back to the English title when the requested language records none', async () => {
      routeTitles({ title: EN_TITLE });
      const { title } = await getTitle({ language: 'fr', content_mode: 'metadata_only' });
      expect(title).toBe(EN_TITLE);
    });

    it('titles the body served in the requested language with that language', async () => {
      routeTitles({ title: EN_TITLE, languageTitle: FR_TITLE });
      mockFetchContent.mockResolvedValue({
        content: '<html>Texte</html>',
        contentAvailable: true,
        format: 'html',
        language: 'FR',
      });
      const { title } = await getTitle({ language: 'fr' });
      expect(title).toBe(FR_TITLE);
    });

    it('titles a body that fell back to English in English', async () => {
      routeTitles({ title: EN_TITLE, languageTitle: FR_TITLE });
      mockFetchContent.mockResolvedValue({
        content: '<html>Text</html>',
        contentAvailable: true,
        format: 'html',
        language: 'EN',
        languageFallback: 'Requested language FR unavailable; returned English content.',
      });
      const { title } = await getTitle({ language: 'fr' });
      expect(title).toBe(EN_TITLE);
    });

    it('asks English for no second title', async () => {
      routeTitles({ title: EN_TITLE });
      const { title } = await getTitle({ content_mode: 'metadata_only' });
      expect(title).toBe(EN_TITLE);
      const [query] = titleQueries();
      expect(query).not.toContain('?languageExpr');
      expect(query).not.toContain('languageTitle');
    });
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
    expect(result.content_status).toBe('not_requested');
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

  it('caps an oversized full request at the body ceiling and reconstructs the rest through paged calls', async () => {
    const body = `${'A'.repeat(100_000)}${'B'.repeat(25_000)}`;
    mockSparqlQuery.mockResolvedValue([makeMetaBinding({ celex: '32016R0679' })]);
    mockFetchContent.mockResolvedValue({
      content: body,
      contentAvailable: true,
      format: 'html',
      language: 'EN',
    });

    const fullCtx = createMockContext({ errors: eurlex_get_document.errors });
    const first = await eurlex_get_document.handler(
      eurlex_get_document.input.parse({
        celex_number: '32016R0679',
        content_mode: 'full',
      }),
      fullCtx,
    );

    expect(first.content).toBe(body.slice(0, 100_000));
    expect(first.content_offset).toBe(0);
    expect(first.content_chars_returned).toBe(100_000);
    expect(first.content_chars_total).toBe(125_000);
    expect(first.has_more).toBe(true);
    expect(getEnrichment(fullCtx)).toMatchObject({
      truncated: true,
      shown: 100_000,
      cap: 100_000,
      notice: expect.stringContaining('content_mode="paged"'),
    });

    const tail = await eurlex_get_document.handler(
      eurlex_get_document.input.parse({
        celex_number: '32016R0679',
        content_mode: 'paged',
        offset: 100_000,
        limit: 100_000,
      }),
      createMockContext({ errors: eurlex_get_document.errors }),
    );
    expect((first.content ?? '') + (tail.content ?? '')).toBe(body);
    expect(tail.content_offset).toBe(100_000);
    expect(tail.content_chars_returned).toBe(25_000);
    expect(tail.has_more).toBe(false);

    const text = (eurlex_get_document.format!(first)[0] as { text: string }).text;
    expect(text).toContain(first.content!);
    expect(text).not.toContain(body);
    expect(text).toContain('content_mode="paged"');
    expect(text).toContain('offset=100000');
  });

  it('returns a full body exactly at the ceiling without continuation', async () => {
    const body = 'E'.repeat(100_000);
    mockSparqlQuery.mockResolvedValue([makeMetaBinding({ celex: '32016R0679' })]);
    mockFetchContent.mockResolvedValue({
      content: body,
      contentAvailable: true,
      format: 'html',
      language: 'EN',
    });

    const result = await eurlex_get_document.handler(
      eurlex_get_document.input.parse({
        celex_number: '32016R0679',
        content_mode: 'full',
      }),
      createMockContext({ errors: eurlex_get_document.errors }),
    );

    expect(result.content).toBe(body);
    expect(result.content_chars_returned).toBe(100_000);
    expect(result.has_more).toBe(false);
  });

  it('content_mode "paged" returns contiguous windows that reconstruct the full body; has_more flips on the last page', async () => {
    const body = 'abcdefghij'.repeat(2_500); // 25,000 chars
    mockSparqlQuery.mockResolvedValue([makeMetaBinding({ celex: '32016R0679' })]);
    mockFetchContent.mockResolvedValue({
      content: body,
      contentAvailable: true,
      format: 'html',
      language: 'EN',
    });

    const page = async (offset: number) => {
      const ctx = createMockContext({ errors: eurlex_get_document.errors });
      const result = await eurlex_get_document.handler(
        eurlex_get_document.input.parse({
          celex_number: '32016R0679',
          content_mode: 'paged',
          offset,
          limit: 10_000,
        }),
        ctx,
      );
      return { result, enrichment: getEnrichment(ctx) };
    };

    const { result: p1, enrichment: enrichment1 } = await page(0);
    expect(p1.content_offset).toBe(0);
    expect(p1.content_chars_returned).toBe(10_000);
    expect(p1.content_chars_total).toBe(25_000);
    expect(p1.has_more).toBe(true);
    expect(enrichment1).toMatchObject({
      truncated: true,
      shown: 10_000,
      cap: 10_000,
      notice: expect.stringContaining('offset=10000'),
    });

    // Page 2 starts exactly where page 1 ended — no gap, no overlap.
    const next2 = (p1.content_offset ?? 0) + (p1.content_chars_returned ?? 0);
    expect(next2).toBe(10_000);
    const { result: p2, enrichment: enrichment2 } = await page(next2);
    expect(p2.content_offset).toBe(10_000);
    expect(p2.content_chars_returned).toBe(10_000);
    expect(p2.has_more).toBe(true);
    expect(enrichment2).toMatchObject({
      truncated: true,
      shown: 10_000,
      cap: 10_000,
      notice: expect.stringContaining('offset=20000'),
    });

    // Final page.
    const next3 = (p2.content_offset ?? 0) + (p2.content_chars_returned ?? 0);
    expect(next3).toBe(20_000);
    const { result: p3, enrichment: enrichment3 } = await page(next3);
    expect(p3.content_offset).toBe(20_000);
    expect(p3.content_chars_returned).toBe(5_000);
    expect(p3.has_more).toBe(false);
    expect(enrichment3.truncated).toBeUndefined();

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
      legal_basis: [{ work_uri: 'http://lb1', celex_number: '12012E016' }],
      eurovoc_subjects: [
        { concept_uri: 'http://ev1', label: 'data protection' },
        { concept_uri: 'http://ev2' },
      ],
      content_mode: 'paged',
      content_available: false,
      content_status: 'unavailable' as const,
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
    const subjects = Array.from({ length: 9 }, (_, i) => ({
      concept_uri: `http://eurovoc.europa.eu/${1000 + i}`,
    }));
    const output = {
      celex_number: '32016R0679',
      eurovoc_subjects: subjects,
      content_mode: 'metadata_only',
      content_available: false,
      content_status: 'not_requested' as const,
      has_more: false,
      language: 'EN',
      content_format: 'html',
    };
    const text = (eurlex_get_document.format!(output)[0] as { text: string }).text;
    for (const s of subjects) expect(text).toContain(s.concept_uri);
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
      content_status: 'available' as const,
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

  it.each(['html', 'xml'] as const)(
    'format presents %s source literally inside a dynamically safe tilde fence',
    (contentFormat) => {
      const body =
        '  <tag data-x="&copy;">*bold* _under_ `code`</tag>\n| a | b |\n~~~~~~\n  tail  ';
      const output = {
        celex_number: '32016R0679',
        content_mode: 'paged',
        content_available: true,
        content_status: 'available' as const,
        content: body,
        content_offset: 0,
        content_chars_returned: body.length,
        content_chars_total: body.length,
        has_more: false,
        language: 'EN',
        content_format: contentFormat,
      };

      const text = (eurlex_get_document.format!(output)[0] as { text: string }).text;
      const opening = text.match(/^(~+)(?:html|xml)$/m);
      expect(opening?.[1]?.length).toBeGreaterThan(6);
      const fence = opening?.[1] ?? '';
      expect(text).toContain(`${fence}${contentFormat}\n${body}\n${fence}`);
      expect(text).not.toContain(`\n---\n\n${body}`);
    },
  );

  it('format continues to render Markdown body content as Markdown', () => {
    const body = '## Article 1\n\n| A | B |\n| - | - |\n| 1 | 2 |';
    const output = {
      celex_number: '32016R0679',
      content_mode: 'paged',
      content_available: true,
      content_status: 'available' as const,
      content: body,
      content_offset: 0,
      content_chars_returned: body.length,
      content_chars_total: body.length,
      has_more: false,
      language: 'EN',
      content_format: 'markdown',
    };

    const text = (eurlex_get_document.format!(output)[0] as { text: string }).text;
    expect(text).toContain(`\n---\n\n${body}`);
    expect(text).not.toMatch(/^~+markdown$/m);
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
        content_status: 'available' as const,
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

    // --- #80: a selection is a set of disjoint slices, so it needs its own bound
    // and its own navigation. The cap matches paged/full (#74); has_more stays
    // false because its contiguous-continuation recipe cannot resume across
    // disjoint slices; each matched section carries its own source address so
    // every section remains individually reachable through the paging floor (#12).

    /** A structured act whose two articles together exceed the body cap. */
    const OVERSIZED_BODY = [
      '<p class="oj-ti-grseq">CHAPTER I</p>',
      '<p class="oj-ti-grseq">General provisions</p>',
      '<p class="oj-ti-art">Article 1</p>',
      '<p class="oj-sti-art">Subject-matter</p>',
      `<p class="oj-normal">${'x'.repeat(60_000)}</p>`,
      '<p class="oj-ti-art">Article 2</p>',
      '<p class="oj-sti-art">Scope</p>',
      `<p class="oj-normal">${'y'.repeat(60_000)}</p>`,
    ].join('\n');

    const mockBody = (content: string) => {
      // Every requested CELEX resolves to one work; the metadata rows are shared.
      mockSparqlQuery.mockImplementation(async (q: string) =>
        isResolutionQuery(q) ? resolutionRows(q) : [makeMetaBinding({ celex: '32016R0679' })],
      );
      mockFetchContent.mockResolvedValue({
        content,
        contentAvailable: true,
        format: 'html',
        language: 'EN',
      });
    };

    /** Run a select call and return both the result and what it enriched. */
    const runSelect = async (
      content: string,
      select: Record<string, string>,
      celex = '32016R0679',
    ) => {
      mockBody(content);
      const ctx = createMockContext({ errors: eurlex_get_document.errors });
      const result = await eurlex_get_document.handler(
        eurlex_get_document.input.parse({ celex_number: celex, select }),
        ctx,
      );
      return { result, enrichment: getEnrichment(ctx) };
    };

    it('#80: caps an oversized selection at the body ceiling and keeps has_more false', async () => {
      const { result } = await runSelect(OVERSIZED_BODY, { articles: '1,2' });

      expect(OVERSIZED_BODY.length).toBeGreaterThan(100_000);
      expect(result.content!.length).toBe(100_000);
      expect(result.content_chars_returned).toBe(100_000);
      expect(result.content_chars_total).toBe(OVERSIZED_BODY.length);
      // The selection matched both articles; the cap limited the text, not the match.
      expect(result.selection?.matched).toEqual(['Article 1', 'Article 2']);
      // has_more's documented recipe (offset = content_offset + content_chars_returned)
      // describes a contiguous window, so it must not claim resumability here.
      expect(result.has_more).toBe(false);
      expect(result.content_offset).toBeUndefined();
      // The tail of the second article really was cut.
      expect(result.content).not.toContain(OVERSIZED_BODY.slice(-200));
    });

    it('#80: discloses the cut through the truncated enrichment even though has_more is false', async () => {
      const { result, enrichment } = await runSelect(OVERSIZED_BODY, { articles: '1,2' });

      expect(result.has_more).toBe(false);
      expect(enrichment).toMatchObject({
        truncated: true,
        shown: 100_000,
        cap: 100_000,
        notice: expect.stringContaining('selected_sections'),
      });
    });

    it("#80: carries each matched section's own source offset and length on selected_sections", async () => {
      const { result } = await runSelect(OVERSIZED_BODY, { articles: '1,2' });

      expect(result.selected_sections?.map((s) => s.label)).toEqual(['Article 1', 'Article 2']);
      for (const section of result.selected_sections ?? []) {
        expect(section.chars).toBeGreaterThan(0);
        // Each address points at its own heading in the source body.
        expect(OVERSIZED_BODY.slice(section.offset, section.offset + 60)).toContain(section.label);
      }
      // Disjoint slices, ascending — not one contiguous span.
      const [first, second] = result.selected_sections ?? [];
      expect(second!.offset).toBeGreaterThan(first!.offset + first!.chars - 1);
    });

    it('#80: a section cut by the cap is still individually reachable through the paging floor (#12)', async () => {
      const { result } = await runSelect(OVERSIZED_BODY, { articles: '1,2' });
      const cutSection = result.selected_sections!.at(-1)!;

      mockBody(OVERSIZED_BODY);
      const reread = await eurlex_get_document.handler(
        eurlex_get_document.input.parse({
          celex_number: '32016R0679',
          content_mode: 'paged',
          offset: cutSection.offset,
          limit: cutSection.chars,
        }),
        createMockContext({ errors: eurlex_get_document.errors }),
      );

      // The advertised address reproduces the section's source span exactly.
      expect(reread.content).toBe(
        OVERSIZED_BODY.slice(cutSection.offset, cutSection.offset + cutSection.chars),
      );
      expect(reread.content).toContain('Article 2');
      expect(reread.content).toContain(OVERSIZED_BODY.slice(-200));
    });

    it('#80: a selection exactly at the ceiling is returned whole with no truncation notice', async () => {
      const prefix = '<p class="oj-doc-ti">REGULATION</p>\n';
      const head =
        '<p class="oj-ti-art">Article 1</p>\n<p class="oj-sti-art">Subject-matter</p>\n<p class="oj-normal">';
      const tail = '</p>';
      const atCapBody = `${prefix}${head}${'x'.repeat(100_000 - head.length - tail.length)}${tail}`;

      const { result, enrichment } = await runSelect(atCapBody, { articles: '1' });

      expect(result.content!.length).toBe(100_000);
      expect(result.content_chars_returned).toBe(100_000);
      expect(result.selected_sections).toEqual([
        { label: 'Article 1', offset: prefix.length, chars: 100_000 },
      ]);
      expect(enrichment.truncated).toBeUndefined();
    });

    it('#80: an under-cap selection reports no truncation and addresses every distinct slice', async () => {
      mockStructured();
      const ctx = createMockContext({ errors: eurlex_get_document.errors });
      const result = await eurlex_get_document.handler(
        eurlex_get_document.input.parse({
          celex_number: '32016R0679',
          select: { chapters: 'I', articles: '2,2' },
        }),
        ctx,
      );

      expect(getEnrichment(ctx).truncated).toBeUndefined();
      expect(result.content_chars_returned).toBe(result.content!.length);
      expect(result.content_chars_returned).toBeLessThan(100_000);
      expect(result.has_more).toBe(false);
      // One address per distinct located section, in document order — the
      // twice-requested article collapses to a single entry. It sits inside
      // CHAPTER I, so its text rides once in the chapter's slice (#88).
      expect(result.selected_sections?.map((s) => s.label)).toEqual(['CHAPTER I', 'Article 2']);
      expect(result.selection?.matched).toEqual(['CHAPTER I', 'Article 2', 'Article 2']);
      expect(result.content!.split('This Regulation applies broadly.')).toHaveLength(2);
    });

    // --- #88: a section nested inside another selected section is carried once,
    // inside the enclosing slice. It keeps its own selected_sections address, and
    // only the slices content actually carries are counted or charged to the cap.

    it('#88: a chapter plus an article inside it returns exactly the chapter, in both channels', async () => {
      mockStructured();
      const chapterOnly = await runSelect(STRUCTURED_BODY, { chapters: 'I' });

      mockStructured();
      const result = await runToolContract(eurlex_get_document, {
        celex_number: '32016R0679',
        select: { chapters: 'I', articles: '1' },
      });
      expect(result.isError).toBeFalsy();
      const structured = eurlex_get_document.output.parse(result.structuredContent);

      expect(structured.content).toBe(chapterOnly.result.content);
      expect(structured.content!.split('Subject-matter')).toHaveLength(2);
      expect(structured.content_chars_returned).toBe(chapterOnly.result.content_chars_returned);
      expect(structured.selection?.matched).toEqual(['CHAPTER I', 'Article 1']);
      // The nested article keeps its own address inside the chapter's span.
      const [chapter, article] = structured.selected_sections ?? [];
      expect([chapter?.label, article?.label]).toEqual(['CHAPTER I', 'Article 1']);
      expect(article!.offset).toBeGreaterThan(chapter!.offset);
      expect(article!.offset + article!.chars).toBeLessThanOrEqual(
        chapter!.offset + chapter!.chars,
      );
      expect(structured.has_more).toBe(false);
      expect(structured.content_offset).toBeUndefined();

      const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
      expect(text).toContain(
        `${structured.content_chars_returned} characters from 1 disjoint section (1 nested section carried inside it)`,
      );
      expect(text).toContain(`Article 1 — offset ${article!.offset}, ${article!.chars} chars`);
    });

    it('#88: adjacent sections stay separate slices and the Body line counts both', async () => {
      const { result } = await runSelect(STRUCTURED_BODY, { articles: '1,2' });
      const text = (eurlex_get_document.format!(result)[0] as { text: string }).text;

      expect(result.content).toContain('Subject-matter');
      expect(result.content).toContain('Scope');
      expect(text).toContain('from 2 disjoint sections of a');
      expect(text).not.toContain('nested');
    });

    /**
     * CHAPTER III spans ~95,000 characters and holds Article 14 (~10,000 of them);
     * Article 33 sits in CHAPTER IV. Counting Article 14 twice pushes the join past
     * the cap and cuts Article 33; counting it once fits.
     */
    const CAP_CROSSING_BODY = [
      '<p class="oj-ti-grseq">CHAPTER III</p>',
      '<p class="oj-ti-grseq">Rights of the data subject</p>',
      '<p class="oj-ti-art">Article 13</p>',
      `<p class="oj-normal">${'m'.repeat(84_000)}</p>`,
      '<p class="oj-ti-art">Article 14</p>',
      '<p class="oj-sti-art">Information to be provided</p>',
      `<p class="oj-normal">${'f'.repeat(10_000)}</p>`,
      '<p class="oj-ti-grseq">CHAPTER IV</p>',
      '<p class="oj-ti-grseq">Controller and processor</p>',
      '<p class="oj-ti-art">Article 33</p>',
      '<p class="oj-sti-art">Notification of a breach</p>',
      '<p class="oj-normal">Article thirty-three body.</p>',
    ].join('\n');

    it('#88: an overlap no longer pushes a fitting selection past the cap', async () => {
      const withoutOverlap = await runSelect(CAP_CROSSING_BODY, {
        chapters: 'III',
        articles: '33',
      });
      const { result, enrichment } = await runSelect(CAP_CROSSING_BODY, {
        chapters: 'III',
        articles: '14,33',
      });

      expect(withoutOverlap.result.content_chars_returned).toBeLessThan(100_000);
      expect(result.content).toBe(withoutOverlap.result.content);
      expect(result.content).toContain('Article thirty-three body.');
      expect(enrichment.truncated).toBeUndefined();
      expect(result.selected_sections?.map((s) => s.label)).toEqual([
        'CHAPTER III',
        'Article 14',
        'Article 33',
      ]);
      const text = (eurlex_get_document.format!(result)[0] as { text: string }).text;
      expect(text).toContain('from 2 disjoint sections (1 nested section carried inside them)');
    });

    it('#88: a still-oversized overlap discloses a pre-cap total that counts each character once', async () => {
      const chaptersOnly = await runSelect(OVERSIZED_BODY, { chapters: 'I' });
      const { result, enrichment } = await runSelect(OVERSIZED_BODY, {
        chapters: 'I',
        articles: '1,2',
      });

      // The chapter alone is over the cap; its two nested articles add nothing.
      expect(result.content).toBe(chaptersOnly.result.content);
      expect(result.content!.length).toBe(100_000);
      expect(enrichment.truncated).toBe(true);
      expect(enrichment.notice).toBe(chaptersOnly.enrichment.notice);
      const chapter = result.selected_sections![0]!;
      const onceTotal = OVERSIZED_BODY.slice(chapter.offset, chapter.offset + chapter.chars).trim()
        .length;
      expect(enrichment.notice).toContain(`total ${onceTotal} characters`);
      // Every nested section stays individually addressable after the cut.
      expect(result.selected_sections?.map((s) => s.label)).toEqual([
        'CHAPTER I',
        'Article 1',
        'Article 2',
      ]);
    });

    it('#80: a selection that matches nothing addresses no sections and discloses no cut', async () => {
      const { result, enrichment } = await runSelect(STRUCTURED_BODY, { articles: '99' });

      expect(result.selection?.missed).toEqual(['Article 99']);
      expect(result.selected_sections).toEqual([]);
      expect(result.content).toBeUndefined();
      expect(result.content_chars_returned).toBe(0);
      expect(enrichment.truncated).toBeUndefined();
    });

    it('#80: an unstructured act addresses no sections and still degrades to the floor', async () => {
      const { result } = await runSelect(UNSTRUCTURED_BODY, { articles: '1' }, '62024CJ0629');

      expect(result.structure_detected).toBe(false);
      expect(result.selected_sections).toEqual([]);
      expect(result.has_more).toBe(false);
    });

    it('#80: format renders selection navigation from the per-section addresses, not a contiguous span', async () => {
      const { result } = await runSelect(OVERSIZED_BODY, { articles: '1,2' });
      const text = (eurlex_get_document.format!(result)[0] as { text: string }).text;

      // The old rendering claimed a contiguous "characters 0–539833" window over
      // text assembled from disjoint slices.
      expect(text).not.toMatch(/characters \d+–\d+/);
      expect(text).toContain('disjoint');
      // Each matched section's own address reaches the text channel too.
      for (const section of result.selected_sections ?? []) {
        expect(text).toContain(`${section.label} — offset ${section.offset}, ${section.chars}`);
      }
      // Both channels carry the same capped body — no second, differently sized cut.
      expect(text).toContain(result.content!);
      expect(text).not.toContain(OVERSIZED_BODY.slice(-200));
    });

    it('#80: format renders an outline as a structure line, never a zero-length body window', async () => {
      mockStructured();
      const ctx = createMockContext({ errors: eurlex_get_document.errors });
      const result = await eurlex_get_document.handler(
        eurlex_get_document.input.parse({ celex_number: '32016R0679', outline: true }),
        ctx,
      );
      const text = (eurlex_get_document.format!(result)[0] as { text: string }).text;

      expect(result.content_chars_returned).toBe(0);
      expect(text).not.toContain('characters 0–0');
      expect(text).not.toMatch(/characters \d+–\d+/);
      expect(text).toContain('structure only');
      expect(text).toContain(`${STRUCTURED_BODY.length}-character`);
    });

    it('format renders a selection miss notice pointing at the paging floor', () => {
      const output = {
        celex_number: '32016R0679',
        content_mode: 'paged',
        content_available: true,
        content_status: 'available' as const,
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

  // --- #107: headings are read in the language the body is served in ---

  describe('outline and select in the served language (#107)', () => {
    /** Mock one body served in `language`, whatever was requested. */
    const serve = (content: string, language: string, format = 'html') => {
      mockSparqlQuery.mockImplementation(async (q: string) =>
        isResolutionQuery(q) ? resolutionRows(q) : [makeMetaBinding({ celex: '32024R1689' })],
      );
      mockFetchContent.mockResolvedValue({ content, contentAvailable: true, format, language });
    };
    const call = async (args: Record<string, unknown>) => {
      const ctx = createMockContext({ errors: eurlex_get_document.errors });
      const result = await eurlex_get_document.handler(
        eurlex_get_document.input.parse({ celex_number: '32024R1689', ...args }),
        ctx,
      );
      const text = (eurlex_get_document.format!(result)[0] as { text: string }).text;
      return { result, text, enrichment: getEnrichment(ctx) };
    };

    it('outlines a French act, "Article premier" as article 1, on both surfaces', async () => {
      serve(actHtml(AI_ACT_HEADINGS.FR), 'FR');
      const { result, text } = await call({ language: 'fr', outline: true });

      expect(result.structure_detected).toBe(true);
      // The recitals collapse into one English-labelled entry by default (#118).
      expect(result.outline?.map((h) => `${h.kind} ${h.number}`)).toEqual([
        'recital 1–2',
        'chapter I',
        'section 1',
        'article 1',
        'article 2',
        'chapter IV',
        'annex I',
      ]);
      expect(text).toContain('7 sections detected');
      expect(text).toContain('[recital 1–2] Recitals 1–2');
      expect(text).toContain('[article 1] Article 1: Subject matter');
      expect(text).toContain('[annex I] ANNEX I: List of legislation');
    });

    it('selects sections of a German act on both surfaces', async () => {
      const body = actHtml(AI_ACT_HEADINGS.DE);
      serve(body, 'DE');
      const { result, text } = await call({
        language: 'DE',
        select: { articles: '1', chapters: '4', annexes: 'I' },
      });

      expect(result.selection).toEqual({
        requested: ['Article 1', 'CHAPTER 4', 'ANNEX I'],
        matched: ['Article 1', 'CHAPTER IV', 'ANNEX I'],
        missed: [],
      });
      expect(result.content).toContain('Artikel 1');
      expect(result.content).not.toContain('Artikel 2');
      // The annex runs to the end of the body; its address stops there.
      const annex = result.selected_sections?.at(-1);
      expect(annex!.offset + annex!.chars).toBe(body.length);
      expect(text).toContain('Returned: Article 1, CHAPTER IV, ANNEX I.');
      expect(text).toContain('Section addresses');
    });

    it('reads the headings of the English fallback when the requested language is unavailable', async () => {
      // French and English share "Article", not "CHAPTER": read as French, the
      // English chapter and annex would be lost.
      serve(actHtml(AI_ACT_HEADINGS.EN), 'EN');
      const { result } = await call({ language: 'FR', outline: true });

      expect(result.requested_language).toBe('FR');
      expect(result.outline?.filter((h) => h.kind !== 'recital').map((h) => h.label)).toEqual([
        'CHAPTER I',
        'Section 1',
        'Article 1',
        'Article 2',
        'CHAPTER IV',
        'ANNEX I',
      ]);
    });

    it('selects "Article premier" by number in a French Formex body', async () => {
      const formex =
        '<ARTICLE IDENTIFIER="001"><TI.ART>Article premier</TI.ART><ALINEA>Un.</ALINEA></ARTICLE><ARTICLE IDENTIFIER="002"><TI.ART>Article 2</TI.ART><ALINEA>Deux.</ALINEA></ARTICLE>';
      serve(formex, 'FR', 'xml');
      const { result, text } = await call({
        language: 'FR',
        format: 'xml',
        select: { articles: '1' },
      });

      // Labelled in English, as in html and markdown, whatever the heading text.
      expect(result.selection?.matched).toEqual(['Article 1']);
      expect(result.selected_sections?.map((s) => s.label)).toEqual(['Article 1']);
      expect(result.content).toContain('Article premier');
      expect(result.content).toContain('Un.');
      expect(result.content).not.toContain('Deux.');
      expect(text).toContain('Returned: Article 1.');
    });

    it('reads a selector written with the served language’s kind words, on both surfaces', async () => {
      serve(actHtml(AI_ACT_HEADINGS.DE), 'DE');
      const { result, text } = await call({
        language: 'DE',
        select: { articles: 'Artikel 2', chapters: 'Kapitel IV' },
      });
      expect(result.selection).toEqual({
        requested: ['Article 2', 'CHAPTER IV'],
        matched: ['Article 2', 'CHAPTER IV'],
        missed: [],
      });
      expect(result.content).toContain('Artikel 2');
      expect(result.content).not.toContain('Artikel 1');
      expect(text).toContain('Returned: Article 2, CHAPTER IV.');
    });

    it('reports an unstructured body and unknown sections as misses, with no body', async () => {
      serve('<p>URTEIL DES GERICHTSHOFS</p>\n<p>Die Klage wird abgewiesen.</p>', 'DE');
      const outline = await call({ language: 'DE', outline: true });
      expect(outline.result.outline).toEqual([]);
      expect(outline.result.structure_detected).toBe(false);
      expect(outline.text).toContain('No act structure detected');

      serve(actHtml(AI_ACT_HEADINGS.DE), 'DE');
      // Another language's kind word is not read, so the token is no number here.
      const { result, text } = await call({
        language: 'DE',
        select: { articles: '99,cikk 1' },
      });
      expect(result.selection?.missed).toEqual(['Article 99', 'Article CIKK 1']);
      expect(result.content).toBeUndefined();
      expect(text).toContain('no such section in this act');
    });

    it('caps a selection in any language at the body ceiling', async () => {
      const body = actHtml(AI_ACT_HEADINGS.HU).replace(
        'Body one.',
        `Body one. ${'x'.repeat(120_000)}`,
      );
      serve(body, 'HU');
      const { result, enrichment } = await call({ language: 'HU', select: { chapters: 'I' } });

      expect(result.selection?.matched).toEqual(['CHAPTER I']);
      expect(result.content_chars_returned).toBe(100_000);
      expect(enrichment).toMatchObject({ truncated: true, cap: 100_000 });
    });
  });

  // --- #106 quoted amending text, #118 collapsed recitals ---

  describe('quoted amending text (#106) and the recital run (#118)', () => {
    /** Mock one body; a Markdown body carries its headings, read against the HTML it was rendered from. */
    const serve = (content: string, format = 'html', sourceHtml?: string) => {
      mockSparqlQuery.mockImplementation(async (q: string) =>
        isResolutionQuery(q) ? resolutionRows(q) : [makeMetaBinding({ celex: '32015R2120' })],
      );
      mockFetchContent.mockResolvedValue({
        content,
        contentAvailable: true,
        format,
        language: 'EN',
        ...(sourceHtml
          ? { headings: parseActStructure(content, 'markdown', 'EN', sourceHtml) }
          : {}),
      });
    };
    /** Run through the full contract, returning both surfaces and the enrichment. */
    const call = async (args: Record<string, unknown>) => {
      const response = await runToolContract(eurlex_get_document, {
        celex_number: '32015R2120',
        ...args,
      });
      expect(response.isError).toBeFalsy();
      const text = response.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
      return { result: eurlex_get_document.output.parse(response.structuredContent), text };
    };
    const AMENDING_MD = htmlToMarkdown(AMENDING_HTML);
    const OWN = ['Recitals 1–2', 'Article 1', 'Article 2', 'Article 3', 'ANNEX'];

    it.each([
      ['html', AMENDING_HTML, undefined, OWN],
      ['markdown', AMENDING_MD, AMENDING_HTML, OWN],
      ['xml', AMENDING_FORMEX, undefined, OWN.slice(0, -1)],
    ] as const)(
      '%s: outlines only the act’s own headings, on both surfaces',
      async (format, content, html, own) => {
        serve(content, format, html);
        const { result, text } = await call({ format, outline: true });

        expect(result.outline?.map((h) => h.label)).toEqual(own);
        for (const h of result.outline ?? []) {
          expect(text).toContain(`\`offset ${h.offset}\` — [${h.kind} ${h.number}] ${h.label}`);
        }
        expect(text).not.toMatch(/Article 6B|Article 19|Section 4|ANNEX II/i);
      },
    );

    it('markdown: the amending article spans its quoted text and a quoted-only number misses', async () => {
      serve(AMENDING_MD, 'markdown', AMENDING_HTML);
      const { result, text } = await call({
        format: 'markdown',
        select: { articles: '2,19' },
      });

      expect(result.selection).toEqual({
        requested: ['Article 2', 'Article 19'],
        matched: ['Article 2'],
        missed: ['Article 19'],
      });
      expect(result.content).toContain('Quoted nineteen.');
      expect(result.content).toContain('Amending article tail.');
      expect(result.content).not.toContain('Body three.');
      // The address runs to the act's own Article 3.
      const [section] = result.selected_sections ?? [];
      expect(AMENDING_MD.slice(section!.offset + section!.chars)).toMatch(/^Article 3\n/);
      expect(text).toContain('Not found: Article 19 — no such section in this act');
    });

    it('caps an amending article widened past the body ceiling, addressing it whole', async () => {
      const long = AMENDING_HTML.replace('Quoted six a.', `Quoted six a. ${'q'.repeat(120_000)}`);
      serve(long);
      const { result, text } = await call({ select: { articles: '2' } });

      expect(result.content_chars_returned).toBe(100_000);
      expect(result.has_more).toBe(false);
      const [section] = result.selected_sections ?? [];
      expect(section!.chars).toBeGreaterThan(120_000);
      expect(long.slice(section!.offset + section!.chars)).toMatch(
        /^<p class="oj-ti-art">Article 3/,
      );
      expect(text).toContain('Capped at 100000 characters');
    });

    /** A preamble of `n` recitals in CONVEX numbering tables, then one chapter and article. */
    const withRecitals = (n: number) =>
      [
        '<p class="oj-doc-ti">REGULATION (EU) 2016/679</p>',
        ...Array.from({ length: n }, (_, i) =>
          [
            '<table width="100%" border="0"><col width="4%"/><col width="96%"/><tbody><tr>',
            `<td valign="top"><p class="oj-normal">(${i + 1})</p></td>`,
            `<td valign="top"><p class="oj-normal">Recital body ${i + 1}.</p></td>`,
            '</tr></tbody></table>',
          ].join('\n'),
        ),
        '<p class="oj-ti-section-1">CHAPTER I</p>',
        '<p class="oj-ti-section-2">General provisions</p>',
        '<p class="oj-ti-art">Article 1</p>',
        '<p class="oj-sti-art">Subject-matter</p>',
        '<p class="oj-normal">Article body.</p>',
      ].join('\n');

    it('collapses the recital run into one entry at recital 1, on both surfaces', async () => {
      const body = withRecitals(5);
      serve(body);
      const { result, text } = await call({ outline: true });

      const [run, ...rest] = result.outline ?? [];
      expect(run).toEqual({
        kind: 'recital',
        number: '1–5',
        label: 'Recitals 1–5',
        // The cell and its paragraph share a line, so the paragraph tag starts the
        // recital's line in html (#126).
        offset: body.indexOf('<p class="oj-normal">(1)</p>'),
      });
      expect(rest.map((h) => h.label)).toEqual(['CHAPTER I', 'Article 1']);
      expect(text).toContain(`\`offset ${run!.offset}\` — [recital 1–5] Recitals 1–5`);
      expect(text).toContain('3 sections detected');
    });

    it('lists every recital with include_recitals: true', async () => {
      serve(withRecitals(5));
      const { result, text } = await call({ outline: true, include_recitals: true });

      expect(result.outline?.map((h) => h.label)).toEqual([
        'Recital 1',
        'Recital 2',
        'Recital 3',
        'Recital 4',
        'Recital 5',
        'CHAPTER I',
        'Article 1',
      ]);
      expect(text).toContain('[recital 3] Recital 3');
      expect(text).not.toContain('Recitals 1–5');
    });

    it('keeps a lone recital as its own entry, and an outline without recitals unchanged', async () => {
      serve(withRecitals(1));
      expect((await call({ outline: true })).result.outline?.[0]).toMatchObject({
        number: '1',
        label: 'Recital 1',
      });

      serve(withRecitals(0));
      const without = (await call({ outline: true })).result.outline;
      serve(withRecitals(0));
      expect((await call({ outline: true, include_recitals: true })).result.outline).toEqual(
        without,
      );
      expect(without?.map((h) => h.label)).toEqual(['CHAPTER I', 'Article 1']);
    });

    it('select still reaches a single recital while the outline collapses them', async () => {
      const body = withRecitals(5);
      serve(body);
      const { result } = await call({ select: { recitals: '5' } });

      expect(result.selection?.matched).toEqual(['Recital 5']);
      expect(result.content).toContain('Recital body 5.');
      expect(result.content).not.toContain('Recital body 4.');
      expect(result.content).not.toContain('CHAPTER I');
    });

    it('returns an empty outline for an unstructured body either way', async () => {
      serve('<p>JUDGMENT OF THE COURT</p>\n<p>(1) The action is dismissed.</p>');
      const { result, text } = await call({ outline: true, include_recitals: true });
      expect(result.outline).toEqual([]);
      expect(text).toContain('No act structure detected');
    });

    it('ignores include_recitals outside outline mode, even past the end of the body', async () => {
      const body = withRecitals(3);
      serve(body);
      const { result, text } = await call({ include_recitals: true, offset: body.length + 10 });

      expect(result.outline).toBeUndefined();
      expect(result.content).toBeUndefined();
      expect(result.content_offset).toBe(body.length);
      expect(result.has_more).toBe(false);
      expect(text).toContain('past the end');
    });

    it('rejects a non-boolean include_recitals', () => {
      expect(() =>
        eurlex_get_document.input.parse({ celex_number: '32016R0679', include_recitals: 'yes' }),
      ).toThrow();
    });

    it('states that select ignores offset/limit and is capped', () => {
      const shape = eurlex_get_document.input.shape;
      expect(shape.select.description).toContain('offset and limit do not apply');
      expect(shape.select.description).toContain('capped at 100000 characters');
      expect(shape.select.description).toContain('selected_sections');
      expect(shape.limit.description).toContain('select ignores it');
    });
  });

  // --- #127 a Markdown body's headings come from the content service ---

  describe('Markdown headings from the content service (#127)', () => {
    const CONTENT = 'REGULATION\n\nArticle 1\n\nBody one.\n\nArticle 2\n\nBody two.';
    const serve = (headings: unknown[] | undefined, format = 'markdown') => {
      mockSparqlQuery.mockImplementation(async (q: string) =>
        isResolutionQuery(q) ? resolutionRows(q) : [makeMetaBinding({ celex: '32016R0679' })],
      );
      mockFetchContent.mockResolvedValue({
        content: CONTENT,
        contentAvailable: true,
        format,
        language: 'EN',
        ...(headings ? { headings } : {}),
      });
    };
    const call = async (args: Record<string, unknown>) => {
      const response = await runToolContract(eurlex_get_document, {
        celex_number: '32016R0679',
        ...args,
      });
      expect(response.isError).toBeFalsy();
      const text = response.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
      return { result: eurlex_get_document.output.parse(response.structuredContent), text };
    };
    /** Differs from what the body parses to, so a reparse would show. */
    const SERVED = [
      {
        kind: 'article',
        label: 'Article 7',
        number: '7',
        offset: CONTENT.indexOf('Article 2'),
        title: 'Served',
      },
    ];

    it('outlines the served heading list rather than reparsing the body, on both surfaces', async () => {
      serve(SERVED);
      const { result, text } = await call({ format: 'markdown', outline: true });

      expect(result.outline).toEqual(SERVED);
      expect(result.structure_detected).toBe(true);
      expect(result.content_chars_total).toBe(CONTENT.length);
      expect(text).toContain(`\`offset ${SERVED[0]?.offset}\` — [article 7] Article 7: Served`);
      expect(text).not.toContain('Article 1');
    });

    it('selects against the served heading list, on both surfaces', async () => {
      serve(SERVED);
      const { result, text } = await call({ format: 'markdown', select: { articles: '7,1' } });

      expect(result.selection).toEqual({
        requested: ['Article 7', 'Article 1'],
        matched: ['Article 7'],
        missed: ['Article 1'],
      });
      expect(result.content).toBe('Article 2\n\nBody two.');
      expect(text).toContain('Not found: Article 1');
    });

    it('reports an empty served heading list as no structure, on both surfaces', async () => {
      serve([]);
      const { result, text } = await call({ format: 'markdown', outline: true });

      expect(result.outline).toEqual([]);
      expect(result.structure_detected).toBe(false);
      expect(text).toContain('No act structure detected in the');
    });

    it('parses an html body itself, which arrives without headings', async () => {
      serve(undefined, 'html');
      const { result } = await call({ format: 'html', outline: true });

      expect(result.outline?.map((h) => h.label)).toEqual(['Article 1', 'Article 2']);
    });
  });

  // --- #120 legacy chrome and consolidated labels, #126 one-line legacy html ---

  describe('legacy text/html and consolidated bodies (#120, #126)', () => {
    const serve = (content: string, format = 'html', sourceHtml?: string) => {
      mockSparqlQuery.mockImplementation(async (q: string) =>
        isResolutionQuery(q) ? resolutionRows(q) : [makeMetaBinding({ celex: '31995L0046' })],
      );
      mockFetchContent.mockResolvedValue({
        content,
        contentAvailable: true,
        format,
        language: 'EN',
        ...(sourceHtml
          ? { headings: parseActStructure(content, 'markdown', 'EN', sourceHtml) }
          : {}),
      });
    };
    const call = async (args: Record<string, unknown>) => {
      const response = await runToolContract(eurlex_get_document, {
        celex_number: '31995L0046',
        ...args,
      });
      expect(response.isError).toBeFalsy();
      const text = response.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
      return { result: eurlex_get_document.output.parse(response.structuredContent), text };
    };
    const LEGACY_MD = htmlToMarkdown(LEGACY_ACT_HTML);
    const LEGACY_OUTLINE = [
      'Recitals 1–2',
      'CHAPTER I',
      'Article 1',
      'Article 2',
      'Section I',
      'Article 6',
      'ANNEX',
    ];

    it.each([
      ['html', LEGACY_ACT_HTML, undefined],
      ['markdown', LEGACY_MD, LEGACY_ACT_HTML],
    ] as const)('%s: outlines a legacy body, on both surfaces', async (format, content, html) => {
      serve(content, format, html);
      const { result, text } = await call({ format, outline: true });

      expect(result.structure_detected).toBe(true);
      expect(result.outline?.map((h) => h.label)).toEqual(LEGACY_OUTLINE);
      for (const h of result.outline ?? []) {
        expect(text).toContain(`\`offset ${h.offset}\` — [${h.kind} ${h.number}] ${h.label}`);
      }
      expect(result.outline?.find((h) => h.label === 'Article 6')?.title).toBe('"Mere conduit"');
    });

    it('html: selects a legacy article at its own paragraph tag, on both surfaces', async () => {
      serve(LEGACY_ACT_HTML);
      const { result, text } = await call({ select: { articles: '2,99' } });

      expect(result.selection).toEqual({
        requested: ['Article 2', 'Article 99'],
        matched: ['Article 2'],
        missed: ['Article 99'],
      });
      expect(result.content?.startsWith('<p>Article 2 </p><p>Definitions</p>')).toBe(true);
      const [section] = result.selected_sections ?? [];
      expect(section?.offset).toBe(LEGACY_ACT_HTML.indexOf('<p>Article 2 </p>'));
      expect(text).toContain('<p>Article 2 </p><p>Definitions</p>');
      expect(text).toContain('Not found: Article 99 — no such section in this act');
    });

    it.each([
      ['html', LEGACY_TWO_CHAPTER_ACT_HTML, undefined],
      ['markdown', htmlToMarkdown(LEGACY_TWO_CHAPTER_ACT_HTML), LEGACY_TWO_CHAPTER_ACT_HTML],
    ] as const)(
      '%s: selects a legacy chapter headed with its inline title, on both surfaces (#130)',
      async (format, content, html) => {
        serve(content, format, html);
        const { result, text } = await call({ format, select: { chapters: 'II' } });

        expect(result.selection).toEqual({
          requested: ['CHAPTER II'],
          matched: ['CHAPTER II'],
          missed: [],
        });
        expect(result.content).toMatch(/^(?:<p>)?CHAPTER II GENERAL RULES ON THE LAWFULNESS/);
        expect(result.content).toContain('Article 7');
        expect(result.content).not.toContain('ANNEX');
        expect(text).toContain('CHAPTER II GENERAL RULES ON THE LAWFULNESS');
      },
    );

    it('html: a one-line body with no headings outlines as empty, on both surfaces', async () => {
      serve('<html><body><p>Judgment of the Court</p><p>(1) The request.</p></body></html>');
      const { result, text } = await call({ outline: true });

      expect(result.structure_detected).toBe(false);
      expect(result.outline).toEqual([]);
      expect(text).toContain('No act structure detected');
    });

    it('markdown: a legacy body opens at its CELEX heading, on both surfaces', async () => {
      serve(LEGACY_MD, 'markdown', LEGACY_ACT_HTML);
      const { result, text } = await call({
        format: 'markdown',
        content_mode: 'paged',
        limit: 200,
      });

      expect(result.content?.startsWith('# 31995L0046\n')).toBe(true);
      expect(text).toContain('# 31995L0046');
      expect(text).not.toContain('Avis juridique');
    });

    it('markdown: a consolidated article reads each point on its label’s line', async () => {
      serve(htmlToMarkdown(CONSOLIDATED_ACT_HTML), 'markdown', CONSOLIDATED_ACT_HTML);
      const { result, text } = await call({ format: 'markdown', select: { articles: '30' } });

      expect(result.selection?.matched).toEqual(['Article 30']);
      for (const line of [
        '(a) the name and contact details of the controller;',
        '(i) the first purpose;',
        '— their government.',
      ]) {
        expect(result.content).toContain(line);
        expect(text).toContain(line);
      }
      expect(result.content).not.toMatch(/^\(\w+\) *$/m);
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
    /** An agent-query row for a `cdm:work_created_by_agent` value and its English label. */
    const creator = (value: string, label?: string): SparqlRows[number] => ({
      agent: { type: 'uri', value },
      role: { type: 'literal', value: 'creator' },
      ...(label ? { agentLabel: { type: 'literal', value: label } } : {}),
    });

    /**
     * Route the shared SPARQL mock by query content. The handler issues a CELEX
     * resolution (#97), a core metadata query plus one query per multi-valued
     * dimension (#33), a work_uri deref (#34), and a consolidation lookup (#109), so a
     * single blanket return can't exercise them independently.
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
        if (isResolutionQuery(query)) return Promise.resolve(resolutionRows(query));
        if (query.includes('cdm:resource_legal_eli')) return Promise.resolve(routes.eli ?? []);
        if (query.includes('cdm:act_consolidated_based_on_resource_legal'))
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
        author: [
          creator(`${CB}/EP`, 'European Parliament'),
          creator(`${CB}/CONSIL`, 'Council of the European Union'),
        ],
      });

      const input = eurlex_get_document.input.parse({
        celex_number: '32016R0679',
        content_mode: 'metadata_only',
      });
      const result = await eurlex_get_document.handler(input, ctx);

      // Full set present regardless of order; primary is one of them.
      const authors = ['European Parliament', 'Council of the European Union'];
      expect(result.author_institutions).toEqual(expect.arrayContaining(authors));
      expect(result.author_institutions).toHaveLength(2);
      expect(authors).toContain(result.author_institution);

      // format() surfaces the full set (parity).
      const text = (eurlex_get_document.format!(result)[0] as { text: string }).text;
      expect(text).toContain('European Parliament');
      expect(text).toContain('Council of the European Union');
    });

    // --- #103: every authority-code author renders as its English prefLabel ---

    it.each([
      [
        '22026A00757',
        [
          ['corporate-body/EURUN', 'European Union'],
          ['country/AUT', 'Austria'],
          ['country/SWE', 'Sweden'],
        ],
      ],
      ['71991L0683NLD_87862', [['country/NLD', 'Netherlands']]],
      [
        '91980E001013',
        [
          ['corporate-body/EP', 'European Parliament'],
          ['fd_013/VAN-MIERT', 'VAN MIERT'],
        ],
      ],
      ['51988AC0454', [['corporate-body/EESC', 'European Economic and Social Committee']]],
    ])('#103: %s names its authors by label on both channels', async (celex, codes) => {
      const AUTHORITY = 'http://publications.europa.eu/resource/authority/';
      routeSparql({
        core: [makeMetaBinding({ celex, title: 'A work' })],
        author: codes.map(([code, label]) => creator(`${AUTHORITY}${code}`, label)),
      });

      const result = await runToolContract(eurlex_get_document, {
        celex_number: celex,
        content_mode: 'metadata_only',
      });
      const structured = eurlex_get_document.output.parse(result.structuredContent);
      const labels = codes.map(([, label]) => label as string);
      expect(structured.author_institutions).toEqual(labels);
      expect(structured.author_institution).toBe(labels[0]);
      const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
      expect(text).toContain(`**Authors:** ${labels.join(', ')}`);
      const authorLines = text.split('\n').filter((line) => line.startsWith('**Author'));
      for (const [code] of codes) {
        const bare = (code as string).split('/').pop() as string;
        expect(structured.author_institutions).not.toContain(bare);
        for (const line of authorLines) expect(line).not.toMatch(new RegExp(`\\b${bare}\\b`));
      }
    });

    // --- #95: sector-6 works name their authoring court, not its authority code ---

    it.each([
      ['62012CJ0131', 'CJ', 'Court of Justice'],
      ['62019TJ0795', 'GCEU', 'General Court'],
      ['62006FO0063', 'CST', 'Civil Service Tribunal'],
      ['62004TB0293', 'CFI', 'Court of First Instance'],
    ])('#95: %s names its author %s as "%s" in both channels', async (celex, code, name) => {
      routeSparql({
        core: [makeMetaBinding({ celex, title: 'Case-law work' })],
        author: [creator(`${CB}/${code}`, name)],
      });

      const result = await runToolContract(eurlex_get_document, {
        celex_number: celex,
        content_mode: 'metadata_only',
      });
      expect(result.isError).toBeFalsy();
      const structured = eurlex_get_document.output.parse(result.structuredContent);
      expect(structured.author_institution).toBe(name);
      expect(structured.author_institutions).toEqual([name]);

      const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
      expect(text).toContain(`**Author:** ${name}`);
      expect(text).toContain(`**Authors:** ${name}`);
      expect(text).not.toContain(`**Author:** ${code}`);
    });

    it('#33: captures the full set for every dimension — no cross-product truncation (REACH-shape)', async () => {
      const ctx = createMockContext({ errors: eurlex_get_document.errors });
      // 2 authors × 2 legal bases × 8 EuroVoc = 32 cross-product rows — over the old
      // LIMIT-20 cap. Per-dimension queries capture each in full.
      const eurovoc = Array.from({ length: 8 }, (_, i) => row('eurovoc', `http://eurovoc/${i}`));
      routeSparql({
        core: [makeMetaBinding({ celex: '32006R1907', title: 'REACH' })],
        author: [
          creator(`${CB}/EP`, 'European Parliament'),
          creator(`${CB}/CONSIL`, 'Council of the European Union'),
        ],
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
      const err = await Promise.resolve(eurlex_get_document.handler(input, ctx)).catch(
        (e: unknown) => e,
      );
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

    /** The consolidation lookup's one row: the newest consolidation in effect. */
    const currentRow = (baseCelex: string, celex: string, date: string): SparqlRows[number] => ({
      baseWork: { type: 'uri', value: `${CELLAR}${baseCelex}` },
      currentCelex: { type: 'literal', value: celex },
      currentDate: { type: 'literal', value: date },
    });

    it('#29: flags a superseded base act with its newest consolidated version', async () => {
      const ctx = createMockContext({ errors: eurlex_get_document.errors });
      routeSparql({
        core: [makeMetaBinding({ celex: '32014R0833' })],
        consolidation: [currentRow('32014R0833', '02014R0833-20260424', '2026-04-24')],
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
        if (query.includes('cdm:act_consolidated_based_on_resource_legal')) {
          return Promise.resolve([currentRow('32014R0833', '02014R0833-20260424', '2026-04-24')]);
        }
        // Metadata keys off the served CELEX, resolved to its work.
        if (isResolutionQuery(query)) return Promise.resolve(resolutionRows(query));
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
      expect(result.work_uri).toBe(`${CELLAR}02014R0833-20260424`); // its resolved work
      expect(result.requested_celex).toBe('32014R0833'); // original echoed
      expect(result.is_superseded).toBe(false); // the served text is the newest (#109)
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

    it('rejects an embedded newline in celex_number at the schema (#69)', () => {
      // The CELEX shape gate refuses the control character outright, so no query
      // is built from it at all.
      expect(() =>
        eurlex_get_document.input.parse({
          celex_number: '32016R0679\nGDPR',
          content_mode: 'metadata_only',
        }),
      ).toThrow();
      expect(mockSparqlQuery).not.toHaveBeenCalled();
    });

    it('escapes an embedded newline in celex_number and returns the tool own not_found', async () => {
      const ctx = createMockContext({ errors: eurlex_get_document.errors });
      mockSparqlQuery.mockResolvedValue([]); // identifier matches no work

      // Escaping is the second line of defense behind that schema gate, so exercise
      // it directly: parse a well-formed payload, then substitute the hostile
      // identifier the handler must still neutralize on its own.
      const input = {
        ...eurlex_get_document.input.parse({
          celex_number: '32016R0679',
          content_mode: 'metadata_only',
        }),
        celex_number: '32016R0679\nGDPR',
      };
      const err = await Promise.resolve(eurlex_get_document.handler(input, ctx)).catch(
        (e: unknown) => e,
      );

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
      const err = await Promise.resolve(eurlex_get_document.handler(input, ctx)).catch(
        (e: unknown) => e,
      );

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

  // --- #92: typed exact CELEX triple ---

  describe('typed CELEX triple (#92)', () => {
    /**
     * CELLAR types every `cdm:resource_legal_id_celex` literal as `xsd:string`, so
     * the typed literal resolves from the index while `FILTER(STR(?c) = "…")` scans.
     * The CELEX reaches CELLAR typed in the two queries keyed on it — the resolution
     * to its work (#97) and the consolidation lookup (#109) — and every metadata
     * query keys on the resolved work's IRI instead.
     */
    it('types the CELEX where it is the key and keys the metadata on the resolved work', async () => {
      const ctx = createMockContext({ errors: eurlex_get_document.errors });
      mockSparqlQuery.mockImplementation(async (q: string) =>
        isResolutionQuery(q) ? resolutionRows(q) : [makeMetaBinding({ celex: '32016R0679' })],
      );

      const input = eurlex_get_document.input.parse({
        celex_number: '32016R0679',
        content_mode: 'metadata_only',
      });
      const result = await eurlex_get_document.handler(input, ctx);

      const queries = mockSparqlQuery.mock.calls.map((c) => c[0] as string);
      const keyed = queries.filter((q) => q.includes('"32016R0679"'));
      expect(keyed).toHaveLength(2);
      expect(keyed.find(isResolutionQuery)).toContain(
        'VALUES ?celexNumber { "32016R0679"^^xsd:string }',
      );
      expect(keyed.find((q) => q.includes('act_consolidated_based_on'))).toContain(
        'cdm:resource_legal_id_celex "32016R0679"^^xsd:string .',
      );
      const byWork = queries.filter((q) => q.includes(`<${CELLAR}32016R0679>`));
      expect(byWork).toHaveLength(4);
      expect(queries.join('\n')).not.toMatch(/STR\(\?\w+\)\s*=/);
      expect(result.celex_number).toBe('32016R0679');
      expect(result.work_uri).toBe(`${CELLAR}32016R0679`);
    });

    it('types both the requested and the served CELEX on the resolve "current_consolidated" path', async () => {
      const ctx = createMockContext({ errors: eurlex_get_document.errors });
      mockSparqlQuery.mockImplementation(async (q: string) => {
        if (q.includes('act_consolidated_based_on')) {
          return [
            {
              baseWork: { type: 'uri', value: `${CELLAR}32016R0679` },
              currentCelex: { type: 'literal', value: '02016R0679-20160504' },
              currentDate: { type: 'literal', value: '2016-05-04' },
            },
          ];
        }
        return isResolutionQuery(q) ? resolutionRows(q) : [];
      });

      const input = eurlex_get_document.input.parse({
        celex_number: '32016R0679',
        content_mode: 'metadata_only',
        resolve: 'current_consolidated',
      });
      await eurlex_get_document.handler(input, ctx);

      const queries = mockSparqlQuery.mock.calls.map((c) => c[0] as string);
      expect(queries[0]).toContain('cdm:resource_legal_id_celex "32016R0679"^^xsd:string .');
      expect(queries.find(isResolutionQuery)).toContain(
        'VALUES ?celexNumber { "02016R0679-20160504"^^xsd:string }',
      );
      // The consolidation's own identity comes from its work; its act metadata from
      // the base act's work (#110): the core query names both.
      expect(queries.filter((q) => q.includes(`<${CELLAR}02016R0679-20160504>`))).toHaveLength(1);
      expect(queries.filter((q) => q.includes(`<${CELLAR}32016R0679>`))).toHaveLength(4);
      expect(queries.join('\n')).not.toMatch(/STR\(\?\w+\)\s*=/);
    });
  });

  // --- #69: CELEX shape gate at the schema layer ---

  describe('CELEX shape validation (#69)', () => {
    it.each([
      ['a bare zero', '0'],
      ['a stray word', 'hello'],
      ['whitespace only', '   '],
    ])('rejects %s before any CELLAR request', (_label, value) => {
      expect(() => eurlex_get_document.input.parse({ celex_number: value })).toThrow();
      expect(mockSparqlQuery).not.toHaveBeenCalled();
    });

    it.each([
      ['sector 0, consolidated version', '02016R0679-20160504'],
      ['sector 1, treaty reference with slashes', '11957A/PRO/CJ/09'],
      ['sector 2, external relations', '22001D0815'],
      ['sector 3, regulation', '32016R0679'],
      ['sector 3, corrigendum marker', '32016R0679R(02)'],
      ['sector 4, complementary legislation', '42002D0234'],
      ['sector 5, preparatory act', '52016PC0001'],
      ['sector 6, case law', '62024CJ0629'],
      ['sector 7, national implementing measure', '72014L0056FIN_240353'],
      ['sector 8, national case law', '82003PT1111(51)'],
      ['sector 9, parliamentary question', '91980E001013'],
      ['sector C, OJ C series', 'C/2026/01104'],
      ['sector E, EFTA document', 'E2016C0186'],
    ])('accepts a real %s', (_label, celex) => {
      expect(() => eurlex_get_document.input.parse({ celex_number: celex })).not.toThrow();
    });

    it('still routes celex_number "" to the handler and its identifier guard', async () => {
      const ctx = createMockContext({ errors: eurlex_get_document.errors });

      // The blank-field convention survives the new pattern: "" is a union member,
      // so a form client's empty box reaches the handler's friendly guard rather
      // than a schema rejection.
      const input = eurlex_get_document.input.parse({ celex_number: '' });
      await expect(eurlex_get_document.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'invalid_identifier_args' },
      });
      expect(mockSparqlQuery).not.toHaveBeenCalled();
    });
  });

  // --- CELEX input normalization ---

  describe('CELEX normalization', () => {
    it('trims surrounding whitespace before validating', () => {
      expect(eurlex_get_document.input.parse({ celex_number: ' 32016R0679 ' }).celex_number).toBe(
        '32016R0679',
      );
    });

    it('uppercases a lowercase CELEX before validating', () => {
      expect(eurlex_get_document.input.parse({ celex_number: '32016r0679' }).celex_number).toBe(
        '32016R0679',
      );
    });

    /**
     * A whitespace-only value is not the `''` union member, so it takes the regex
     * branch, trims to `''` there, and fails the six-character floor — a schema
     * rejection, not the handler's identifier guard.
     */
    it('still rejects a whitespace-only celex_number at the schema', () => {
      expect(() => eurlex_get_document.input.parse({ celex_number: '   ' })).toThrow();
      expect(mockSparqlQuery).not.toHaveBeenCalled();
    });

    it('hands the handler the normalized CELEX', async () => {
      const ctx = createMockContext({ errors: eurlex_get_document.errors });
      mockSparqlQuery.mockResolvedValue([makeMetaBinding({ celex: '32016R0679' })]);
      mockFetchContent.mockResolvedValue({
        content: 'body',
        contentAvailable: true,
        format: 'html',
        language: 'EN',
      });

      const input = eurlex_get_document.input.parse({ celex_number: '   32016r0679   ' });
      const result = await eurlex_get_document.handler(input, ctx);

      expect(result.celex_number).toBe('32016R0679');
      expect(
        mockSparqlQuery.mock.calls.map((c) => c[0] as string).find(isResolutionQuery),
      ).toContain('VALUES ?celexNumber { "32016R0679"^^xsd:string }');
    });
  });

  // --- #97 / #96: resolved work and its agents, against a CELLAR-shaped fake ---

  describe('fixture works (#97, #96)', () => {
    type Row = Record<string, { type: string; value: string }>;
    const uri = (value: string) => ({ type: 'uri', value });
    const literal = (value: string) => ({ type: 'literal', value });
    const T181_COPY = fixtureWork('62022TJ0181', 0);

    /** Per-work dimension values: only the canonical work's belong in the output. */
    const SUBJECTS: Record<string, string> = {
      [canonicalWork('62022TJ0181')]: 'http://eurovoc.europa.eu/canonical',
      [T181_COPY]: 'http://eurovoc.europa.eu/copy-only',
      [fixtureWork('62022TJ0181', 2)]: 'http://eurovoc.europa.eu/alias-only',
    };
    const BASES: Record<string, string> = {
      [canonicalWork('62022TJ0181')]: `${CELLAR}basis-of-canonical`,
      [T181_COPY]: `${CELLAR}basis-of-copy`,
    };

    /** Answer every query the handler issues from the fixture works it addresses. */
    const fakeCellar = async (q: string): Promise<Row[]> => {
      const works = addressedWorks(q);
      if (q.includes('AS ?celexCount')) {
        // The work_uri dereference: the lowest CELEX and the count, one row (#104).
        const [lowest] = works.map(({ celex }) => celex).toSorted();
        return [
          {
            ...(lowest ? { celex: literal(lowest) } : {}),
            celexCount: literal(String(works.length)),
          },
        ];
      }
      if (q.includes('cdm:work_created_by_agent')) return agentRows(q);
      if (q.includes('cdm:resource_legal_based_on_resource_legal')) {
        return works.flatMap(({ work }) =>
          BASES[work.uri] ? [{ legalBasis: uri(BASES[work.uri] as string) }] : [],
        );
      }
      if (q.includes('cdm:work_is_about_concept_eurovoc')) {
        return works.flatMap(({ work }) =>
          SUBJECTS[work.uri] ? [{ eurovoc: uri(SUBJECTS[work.uri] as string) }] : [],
        );
      }
      if (q.includes('cdm:expression_belongs_to_work')) {
        return works.map(({ celex, work }) => ({
          work: uri(work.uri),
          celexNumber: literal(celex),
          title: literal(`${celex} title`),
        }));
      }
      return celexWorkRows(q);
    };

    const getDocument = (args: Record<string, unknown>) => {
      mockSparqlQuery.mockImplementation(fakeCellar);
      return runToolContract(eurlex_get_document, { content_mode: 'metadata_only', ...args });
    };
    const textOf = (result: Awaited<ReturnType<typeof getDocument>>) =>
      result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');

    it('#97: resolves 62022TJ0181 to its canonical work and reads metadata from that work alone', async () => {
      const result = await getDocument({ celex_number: '62022TJ0181' });

      const structured = eurlex_get_document.output.parse(result.structuredContent);
      expect(structured.work_uri).toBe(canonicalWork('62022TJ0181'));
      expect(structured.eurovoc_subjects).toEqual([
        { concept_uri: 'http://eurovoc.europa.eu/canonical' },
      ]);
      expect(structured.legal_basis).toEqual([{ work_uri: `${CELLAR}basis-of-canonical` }]);
      expect(textOf(result)).toContain(`**Work URI:** ${canonicalWork('62022TJ0181')}`);
      expect(textOf(result)).not.toContain('copy-only');
    });

    it('#97: a work_uri naming a copy serves the canonical work of its CELEX', async () => {
      const result = await getDocument({ work_uri: T181_COPY });

      const structured = eurlex_get_document.output.parse(result.structuredContent);
      expect(structured.celex_number).toBe('62022TJ0181');
      expect(structured.work_uri).toBe(canonicalWork('62022TJ0181'));
    });

    it('#97: 51988DC0713 resolves to its canonical work, not its sector-5 twin', async () => {
      const result = await getDocument({ celex_number: '51988DC0713' });
      expect(eurlex_get_document.output.parse(result.structuredContent).work_uri).toBe(
        canonicalWork('51988DC0713'),
      );
    });

    it('#96: 62012CJ0131 names the court as author and its Advocate General separately', async () => {
      const result = await getDocument({ celex_number: '62012CJ0131' });

      const structured = eurlex_get_document.output.parse(result.structuredContent);
      expect(structured.author_institution).toBe('Court of Justice');
      expect(structured.author_institutions).toEqual(['Court of Justice']);
      expect(structured.advocates_general).toEqual(['Jääskinen']);
      const text = textOf(result);
      expect(text).toContain('**Authors:** Court of Justice');
      expect(text).toContain('**Advocates General:** Jääskinen');
      expect(text).not.toContain('233d79cc');
    });

    it('#96: an AG opinion whose only author is its AG carries no author_institution', async () => {
      const result = await getDocument({ celex_number: '62024CC0505' });

      const structured = eurlex_get_document.output.parse(result.structuredContent);
      expect(structured.author_institution).toBeUndefined();
      expect(structured.author_institutions).toBeUndefined();
      expect(structured.advocates_general).toEqual(['Biondi']);
      const text = textOf(result);
      expect(text).not.toContain('**Author:**');
      expect(text).toContain('**Advocates General:** Biondi');
      expect(text).not.toContain('76d5fb73');
    });

    it('#96: a national-court decision names the court by cdm:court_national_name', async () => {
      const result = await getDocument({ celex_number: '82003PT1111(51)' });

      const structured = eurlex_get_document.output.parse(result.structuredContent);
      expect(structured.author_institutions).toEqual(['Supremo Tribunal de Justiça']);
      expect(structured.author_institution).toBe('Supremo Tribunal de Justiça');
      expect(structured.advocates_general).toBeUndefined();
      expect(textOf(result)).not.toContain('06234cad');
    });

    it('#96: lists every Advocate General of a work with several, in a stable order', async () => {
      const result = await getDocument({ celex_number: '61983CJ0271' });

      const structured = eurlex_get_document.output.parse(result.structuredContent);
      expect(structured.advocates_general).toEqual(['Mischo', 'VerLoren van Themaat']);
      expect(structured.author_institutions).toEqual(['Court of Justice']);
      expect(textOf(result)).toContain('**Advocates General:** Mischo, VerLoren van Themaat');
    });

    it('#96: leaves a co-legislated act unchanged and without advocates_general', async () => {
      const result = await getDocument({ celex_number: '32016R0679' });

      const structured = eurlex_get_document.output.parse(result.structuredContent);
      expect(structured.author_institution).toBe('Council of the European Union');
      expect(structured.author_institutions).toEqual([
        'Council of the European Union',
        'European Parliament',
      ]);
      expect(structured).not.toHaveProperty('advocates_general');
      expect(textOf(result)).not.toContain('Advocates General');
    });
  });

  // --- Consolidated texts and their base acts (#109, #110) ---

  describe('consolidated texts (#109, #110)', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-09-25T12:00:00Z'));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    const getDocument = (args: Record<string, unknown>) => {
      mockSparqlQuery.mockImplementation(fakeConsolidationCellar);
      return runToolContract(eurlex_get_document, { content_mode: 'metadata_only', ...args });
    };
    const structuredOf = (result: Awaited<ReturnType<typeof getDocument>>) =>
      eurlex_get_document.output.parse(result.structuredContent);
    const textOf = (result: Awaited<ReturnType<typeof getDocument>>) =>
      result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');

    it('serves a consolidated text under its own CELEX, work, title, date, and type', async () => {
      const result = await getDocument({ celex_number: '02024R1689-20240712' });

      const structured = structuredOf(result);
      expect(structured.celex_number).toBe('02024R1689-20240712');
      expect(structured.work_uri).toBe(ACTS['02024R1689-20240712']?.uri);
      expect(structured.title).toBe('Consolidated text of 2024-07-12');
      expect(structured.date).toBe('2024-07-12');
      expect(structured.resource_type).toBe('Consolidated Text');
      expect(textOf(result)).toContain('## 02024R1689-20240712 — Consolidated text of 2024-07-12');
    });

    it('flags a base act with a consolidated version as superseded, in both channels', async () => {
      const result = await getDocument({ celex_number: '32016R0679' });

      const structured = structuredOf(result);
      expect(structured.is_superseded).toBe(true);
      expect(structured.current_consolidated_celex).toBe('02016R0679-20160504');
      expect(structured.consolidated_as_of).toBe('2016-05-04');
      expect(textOf(result)).toContain('**Current consolidated:** 02016R0679-20160504');
      expect(textOf(result)).toContain('**Consolidated as of:** 2016-05-04');
    });

    // --- #109: is_superseded describes the served text ---

    it('#109: resolve "current_consolidated" serves the newest version and reports it as current', async () => {
      const result = await getDocument({
        celex_number: '32024R1689',
        resolve: 'current_consolidated',
      });

      const structured = structuredOf(result);
      expect(structured.celex_number).toBe('02024R1689-20260727');
      expect(structured.requested_celex).toBe('32024R1689');
      expect(structured.is_superseded).toBe(false);
      expect(structured.current_consolidated_celex).toBe('02024R1689-20260727');
      expect(structured.consolidated_as_of).toBe('2026-07-27');
      expect(textOf(result)).toContain(
        '**Superseded:** false — this is the newest consolidated version.',
      );
    });

    it('#109: a stale base act names the newer version and says it is not a repeal', async () => {
      const result = await getDocument({ celex_number: '32016R0679' });

      expect(textOf(result)).toContain(
        '**Superseded:** true — consolidated version 02016R0679-20160504 (2016-05-04) is newer than this text; not a repeal (see In Force).',
      );
    });

    it('#109: an older consolidated text requested directly is superseded by the newest', async () => {
      const older = structuredOf(await getDocument({ celex_number: '02024R1689-20240712' }));
      expect(older.is_superseded).toBe(true);
      expect(older.current_consolidated_celex).toBe('02024R1689-20260727');
      expect(older.consolidated_as_of).toBe('2026-07-27');

      const newest = await getDocument({ celex_number: '02024R1689-20260727' });
      expect(structuredOf(newest).is_superseded).toBe(false);
      expect(structuredOf(newest).current_consolidated_celex).toBe('02024R1689-20260727');
      expect(textOf(newest)).toContain(
        '**Superseded:** false — this is the newest consolidated version.',
      );
    });

    it.each([
      ['22006A0901(01)', '02006A0901(01)-20090301', '2009-03-01'],
      // Numbered differently from the act: ordered by consolidation date, not CELEX.
      ['32000O0007', '02000O0007-20120101', '2012-01-01'],
      // 02002L0087-20270130 is dated after today and never the current version.
      ['32002L0087', '02002L0087-20240109', '2024-01-09'],
    ])(
      '#109: %s finds its current consolidated version %s through the based-on link',
      async (celex, current, asOf) => {
        const structured = structuredOf(await getDocument({ celex_number: celex }));

        expect(structured.is_superseded).toBe(true);
        expect(structured.current_consolidated_celex).toBe(current);
        expect(structured.consolidated_as_of).toBe(asOf);
      },
    );

    it('#109: a future-dated consolidated text is not superseded, and names the current version', async () => {
      const result = await getDocument({ celex_number: '02002L0087-20270130' });

      const structured = structuredOf(result);
      expect(structured.is_superseded).toBe(false);
      expect(structured.current_consolidated_celex).toBe('02002L0087-20240109');
      expect(structured.consolidated_as_of).toBe('2024-01-09');
      expect(textOf(result)).toContain(
        '**Superseded:** false — this consolidated version is dated after the current one, 02002L0087-20240109 (2024-01-09), and does not apply yet.',
      );
    });

    it('#109: resolve "current_consolidated" on a consolidated CELEX serves its base act\'s newest version', async () => {
      const structured = structuredOf(
        await getDocument({ celex_number: '02024R1689-20240712', resolve: 'current_consolidated' }),
      );

      expect(structured.celex_number).toBe('02024R1689-20260727');
      expect(structured.requested_celex).toBe('02024R1689-20240712');
      expect(structured.is_superseded).toBe(false);
    });

    const noticeOf = (result: Awaited<ReturnType<typeof getDocument>>) =>
      (result.structuredContent as { notice?: string }).notice;

    it('#109: an act whose only consolidated version is dated in the future carries no staleness fields or notice', async () => {
      const result = await getDocument({ celex_number: '32021D1442' });

      const structured = structuredOf(result);
      expect(structured).not.toHaveProperty('is_superseded');
      expect(structured).not.toHaveProperty('current_consolidated_celex');
      expect(noticeOf(result)).toBeUndefined();
    });

    it('#109: a future-dated consolidated text with no version in effect says it does not apply yet, in both channels', async () => {
      const result = await getDocument({ celex_number: '02021D1442-20261001' });

      const structured = structuredOf(result);
      expect(structured.celex_number).toBe('02021D1442-20261001');
      expect(structured.base_act_celex).toBe('32021D1442');
      expect(structured).not.toHaveProperty('is_superseded');
      expect(structured).not.toHaveProperty('current_consolidated_celex');
      const notice = noticeOf(result);
      expect(notice).toBe(
        'Consolidated version 02021D1442-20261001 is dated 2026-10-01 and does not apply yet; no consolidated version of its base act (32021D1442) is in effect.',
      );
      expect(textOf(result)).toContain(notice as string);
      expect(textOf(result)).not.toContain('Superseded');
    });

    it('#109: resolve "current_consolidated" on that future-dated text serves it with the same notice', async () => {
      const result = await getDocument({
        celex_number: '02021D1442-20261001',
        resolve: 'current_consolidated',
      });

      expect(structuredOf(result).celex_number).toBe('02021D1442-20261001');
      expect(structuredOf(result)).not.toHaveProperty('requested_celex');
      expect(noticeOf(result)).toContain('does not apply yet');
    });

    it('#109: resolve "current_consolidated" with only a future-dated version serves the base act and says so, in both channels', async () => {
      const result = await getDocument({
        celex_number: '32021D1442',
        resolve: 'current_consolidated',
      });

      const structured = structuredOf(result);
      expect(structured.celex_number).toBe('32021D1442');
      expect(structured).not.toHaveProperty('requested_celex');
      expect(structured).not.toHaveProperty('is_superseded');
      const notice = noticeOf(result);
      expect(notice).toBe(
        'No consolidated version of 32021D1442 is in effect yet (02021D1442-20261001 applies from 2026-10-01), so resolve "current_consolidated" served the base act.',
      );
      expect(textOf(result)).toContain(notice as string);
    });

    it('#109: the resolve notice rides behind the paging guidance when the body is also cut', async () => {
      mockFetchContent.mockResolvedValue({
        content: 'x'.repeat(50),
        contentAvailable: true,
        format: 'html',
        language: 'EN',
      });
      const result = await getDocument({
        celex_number: '32021D1442',
        resolve: 'current_consolidated',
        content_mode: 'paged',
        limit: 10,
      });

      const structured = result.structuredContent as { notice?: string; truncated?: boolean };
      expect(structured.truncated).toBe(true);
      expect(structured.notice).toContain('offset=10');
      expect(structured.notice).toContain('No consolidated version of 32021D1442 is in effect yet');
      expect(textOf(result)).toContain(structured.notice as string);
    });

    it('#109: once that version takes effect, resolve serves it with no notice', async () => {
      vi.setSystemTime(new Date('2026-10-01T00:30:00Z'));
      const result = await getDocument({
        celex_number: '32021D1442',
        resolve: 'current_consolidated',
      });

      const structured = structuredOf(result);
      expect(structured.celex_number).toBe('02021D1442-20261001');
      expect(structured.requested_celex).toBe('32021D1442');
      expect(structured.is_superseded).toBe(false);
      expect(noticeOf(result)).toBeUndefined();
    });

    it('#109: resolve on an act with no consolidated version at all serves it with no notice', async () => {
      const result = await getDocument({
        celex_number: '32026R2099',
        resolve: 'current_consolidated',
      });

      expect(structuredOf(result).celex_number).toBe('32026R2099');
      expect(noticeOf(result)).toBeUndefined();
    });

    it('#109: an act with no consolidated version carries none of the staleness fields', async () => {
      const result = await getDocument({ celex_number: '32026R2099' });

      const structured = structuredOf(result);
      expect(structured).not.toHaveProperty('is_superseded');
      expect(structured).not.toHaveProperty('current_consolidated_celex');
      expect(structured).not.toHaveProperty('consolidated_as_of');
      expect(textOf(result)).not.toContain('Superseded');
    });

    it('#109: the lookup keys on the typed CELEX, follows the based-on link, and excludes future dates', async () => {
      await getDocument({ celex_number: '32002L0087' });

      const lookup = mockSparqlQuery.mock.calls
        .map((c) => c[0] as string)
        .find(isConsolidationLookup) as string;
      expect(lookup).toContain('?baseWork cdm:resource_legal_id_celex "32002L0087"^^xsd:string .');
      expect(lookup).toContain('cdm:act_consolidated_based_on_resource_legal ?baseWork');
      expect(lookup).toContain('FILTER(STR(?currentDate) <= "2026-09-25")');
      expect(lookup).toContain('ORDER BY DESC(STR(?currentDate)) DESC(?currentCelex)');
      expect(lookup).not.toContain('act_consolidated_consolidates');
      // The future-dated arm rides the same query, filtered to dates after today.
      expect(lookup).toContain('FILTER(STR(?pendingDate) > "2026-09-25")');
    });

    it('#109: a base-act request issues no added query — the lookup replaces the old probe', async () => {
      await getDocument({ celex_number: '32024R1689' });

      const queries = mockSparqlQuery.mock.calls.map((c) => c[0] as string);
      // Resolution, the consolidation lookup, core, agents, legal basis, EuroVoc.
      expect(queries).toHaveLength(6);
      expect(queries.filter(isConsolidationLookup)).toHaveLength(1);
    });

    it('#109: a consolidated-CELEX request runs its lookup concurrently with CELEX resolution', async () => {
      let markLookup!: () => void;
      const lookupIssued = new Promise<void>((resolve) => {
        markLookup = resolve;
      });
      mockSparqlQuery.mockImplementation(async (q: string) => {
        if (isConsolidationLookup(q)) markLookup();
        if (isResolutionQuery(q)) {
          // Resolution completes only once the lookup is already in flight.
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

      const result = await runToolContract(eurlex_get_document, {
        celex_number: '02024R1689-20240712',
        content_mode: 'metadata_only',
      });
      expect(result.isError).toBeFalsy();
      // Resolution, lookup, core, agents, legal basis, EuroVoc: one query added.
      expect(mockSparqlQuery).toHaveBeenCalledTimes(6);
    });

    it('#109: propagates a caller cancellation raised by the lookup on a consolidated CELEX', async () => {
      const ctx = createMockContext({ errors: eurlex_get_document.errors });
      mockSparqlQuery.mockImplementation((q: string) =>
        isConsolidationLookup(q)
          ? Promise.reject(new DOMException('The operation was aborted.', 'AbortError'))
          : fakeConsolidationCellar(q),
      );

      const input = eurlex_get_document.input.parse({
        celex_number: '02024R1689-20240712',
        content_mode: 'metadata_only',
      });
      await expect(eurlex_get_document.handler(input, ctx)).rejects.toThrow(/aborted/);
    });

    // --- #110: a consolidated text reads its base act's metadata ---

    const expectAiActBase = (result: Awaited<ReturnType<typeof getDocument>>) => {
      const structured = structuredOf(result);
      expect(structured.base_act_celex).toBe('32024R1689');
      expect(structured.author_institutions).toEqual(
        expect.arrayContaining(['European Parliament', 'Council of the European Union']),
      );
      expect(structured.author_institutions).toHaveLength(2);
      expect(structured.in_force).toBe(true);
      expect(structured.eurovoc_subjects).toHaveLength(7);
      expect(structured.legal_basis).toHaveLength(2);
      const text = textOf(result);
      expect(text).toContain('**Base act:** 32024R1689');
      expect(text).toContain('**In Force:** true');
      expect(text).not.toContain('OP_DATPRO');
      expect(JSON.stringify(structured)).not.toContain('OP_DATPRO');
    };

    it("#110: a consolidated text reports its base act's authors, in-force status, subjects, and legal bases", async () => {
      const result = await getDocument({ celex_number: '02024R1689-20260727' });

      expectAiActBase(result);
      const structured = structuredOf(result);
      // Its own identity fields stay the consolidation's.
      expect(structured.celex_number).toBe('02024R1689-20260727');
      expect(structured.work_uri).toBe(ACTS['02024R1689-20260727']?.uri);
      expect(structured.resource_type).toBe('Consolidated Text');
      expect(structured.date).toBe('2026-07-27');
    });

    it('#110: resolve "current_consolidated" on the base act carries the same base-act fields', async () => {
      expectAiActBase(
        await getDocument({ celex_number: '32024R1689', resolve: 'current_consolidated' }),
      );
    });

    it('#110: the base act CELEX comes from the link, not the consolidated CELEX', async () => {
      const structured = structuredOf(await getDocument({ celex_number: '02003T0000-20040501' }));
      expect(structured.base_act_celex).toBe('12003T/TXT');
    });

    it("#110: in_force is the base act's, including false", async () => {
      const result = await getDocument({ celex_number: '01995R1422-20060701' });
      expect(structuredOf(result).base_act_celex).toBe('31995R1422');
      expect(structuredOf(result).in_force).toBe(false);
      expect(textOf(result)).toContain('**In Force:** false');
      // #111: so is the reason it is not in force.
      expect(structuredOf(result).repealed_by).toEqual(['32006R0951']);
      expect(structuredOf(result).end_of_validity).toBe('2006-06-30');
    });

    it('#110: a base act carries no base_act_celex and keeps its own metadata', async () => {
      const result = await getDocument({ celex_number: '32024R1689' });

      const structured = structuredOf(result);
      expect(structured).not.toHaveProperty('base_act_celex');
      expect(structured.work_uri).toBe(WORK.aiAct);
      expect(structured.author_institutions).toHaveLength(2);
      expect(textOf(result)).not.toContain('**Base act:**');
    });

    it.each([
      ['no based-on link', '02099R9999-20200101'],
      ['a base work with no CELEX', '02098R9998-20200101'],
    ])('#110: a consolidated text with %s reads its own metadata', async (_label, celex) => {
      const result = await getDocument({ celex_number: celex });

      const structured = structuredOf(result);
      expect(structured).not.toHaveProperty('base_act_celex');
      expect(structured.author_institutions).toEqual(['Provisional data']);
      expect(structured).not.toHaveProperty('in_force');
    });

    it('propagates a caller cancellation raised by the consolidation lookup on a base act', async () => {
      const ctx = createMockContext({ errors: eurlex_get_document.errors });
      mockSparqlQuery.mockImplementation((q: string) =>
        q.includes('act_consolidated_') && !isResolutionQuery(q)
          ? Promise.reject(new DOMException('The operation was aborted.', 'AbortError'))
          : fakeConsolidationCellar(q),
      );

      const input = eurlex_get_document.input.parse({
        celex_number: '32016R0679',
        content_mode: 'metadata_only',
      });
      await expect(eurlex_get_document.handler(input, ctx)).rejects.toThrow(/aborted/);
    });
  });

  // --- #111: why an act is not in force ---

  describe('why an act is not in force (#111)', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-09-25T12:00:00Z'));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    const getDocument = (celex: string) => {
      mockSparqlQuery.mockImplementation(fakeConsolidationCellar);
      return runToolContract(eurlex_get_document, {
        celex_number: celex,
        content_mode: 'metadata_only',
      });
    };
    const structuredOf = (result: Awaited<ReturnType<typeof getDocument>>) =>
      eurlex_get_document.output.parse(result.structuredContent);
    const textOf = (result: Awaited<ReturnType<typeof getDocument>>) =>
      result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    const REASON_FIELDS = ['repealed_by', 'entry_into_force', 'end_of_validity'] as const;
    const REASON_LINES = ['**Repealed by:**', '**Entry into force:**', '**End of validity:**'];

    const expectNoReasons = (result: Awaited<ReturnType<typeof getDocument>>) => {
      const structured = structuredOf(result);
      for (const field of REASON_FIELDS) expect(structured).not.toHaveProperty(field);
      for (const line of REASON_LINES) expect(textOf(result)).not.toContain(line);
    };

    it.each([
      ['32016R0679', 'in force'],
      ['32003R1882', 'in force, though the target of three partial repeals'],
    ])('%s (%s) carries none of the reason fields', async (celex) => {
      const result = await getDocument(celex);
      expect(structuredOf(result).in_force).toBe(true);
      expect(textOf(result)).toContain('**In Force:** true');
      expectNoReasons(result);
    });

    it('a base-act request still issues six queries — the reasons ride the core query', async () => {
      await getDocument('31995L0046');
      // Resolution, consolidation lookup, core, agents, legal bases, EuroVoc.
      expect(mockSparqlQuery).toHaveBeenCalledTimes(6);
    });

    it('propagates a caller cancellation raised by the core metadata query', async () => {
      const ctx = createMockContext({ errors: eurlex_get_document.errors });
      mockSparqlQuery.mockImplementation((q: string) =>
        q.includes('cdm:expression_belongs_to_work')
          ? Promise.reject(new DOMException('The operation was aborted.', 'AbortError'))
          : fakeConsolidationCellar(q),
      );
      const input = eurlex_get_document.input.parse({
        celex_number: '31995L0046',
        content_mode: 'metadata_only',
      });
      await expect(eurlex_get_document.handler(input, ctx)).rejects.toThrow(/aborted/);
    });

    it('31995L0046: names its repealing act and end of validity, in both channels', async () => {
      const result = await getDocument('31995L0046');

      const structured = structuredOf(result);
      expect(structured.in_force).toBe(false);
      expect(structured.repealed_by).toEqual(['32016R0679']);
      expect(structured.end_of_validity).toBe('2018-05-24');
      expect(structured).not.toHaveProperty('entry_into_force');
      const text = textOf(result);
      expect(text).toContain('**In Force:** false');
      expect(text).toContain('**Repealed by:** 32016R0679');
      expect(text).toContain('**End of validity:** 2018-05-24');
      expect(text).not.toContain('**Entry into force:**');
    });

    it('32026R2099 before 2026-10-12: names its earliest entry into force, omitting the open-ended validity', async () => {
      const result = await getDocument('32026R2099');

      const structured = structuredOf(result);
      expect(structured.in_force).toBe(false);
      expect(structured.entry_into_force).toBe('2026-10-12');
      expect(structured).not.toHaveProperty('repealed_by');
      expect(structured).not.toHaveProperty('end_of_validity');
      expect(textOf(result)).toContain('**Entry into force:** 2026-10-12');
      expect(textOf(result)).not.toContain('9999-12-31');
    });

    it.each([
      ['on', '2026-10-12T00:30:00Z'],
      ['after', '2026-11-01T12:00:00Z'],
    ])(
      '32026R2099 %s its entry-into-force date (UTC) no longer reports it',
      async (_label, now) => {
        vi.setSystemTime(new Date(now));
        expectNoReasons(await getDocument('32026R2099'));
      },
    );

    it('reads "today" as the UTC date, not the local one', async () => {
      // 23:30 on 2026-10-11 UTC is already 2026-10-12 in UTC+1 and later zones.
      vi.setSystemTime(new Date('2026-10-11T23:30:00Z'));
      expect(structuredOf(await getDocument('32026R2099')).entry_into_force).toBe('2026-10-12');
    });

    it('32026R1975: a pending act reports its entry into force and a future end of validity', async () => {
      const result = await getDocument('32026R1975');

      const structured = structuredOf(result);
      expect(structured.in_force).toBe(false);
      expect(structured.entry_into_force).toBe('2026-09-29');
      expect(structured.end_of_validity).toBe('2030-12-31');
      expect(structured).not.toHaveProperty('repealed_by');
      const text = textOf(result);
      expect(text).toContain('**Entry into force:** 2026-09-29');
      expect(text).toContain('**End of validity:** 2030-12-31');
    });

    it.each([
      ['32000D0670', '2002-12-31'],
      ['32020D1531', '2024-03-17'],
    ])(
      '%s: a real end of validity recorded beside 9999-12-31 is reported, in both channels',
      async (celex, date) => {
        const result = await getDocument(celex);

        const structured = structuredOf(result);
        expect(structured.in_force).toBe(false);
        expect(structured.end_of_validity).toBe(date);
        expect(textOf(result)).toContain(`**End of validity:** ${date}`);
        expect(textOf(result)).not.toContain('9999-12-31');
      },
    );

    it('excludes the open-ended placeholder inside the end-of-validity OPTIONAL', async () => {
      await getDocument('32000D0670');

      const core = mockSparqlQuery.mock.calls
        .map((c) => c[0] as string)
        .find((q) => q.includes('cdm:expression_belongs_to_work')) as string;
      expect(core).toMatch(
        /OPTIONAL \{[^{}]*cdm:resource_legal_date_end-of-validity \?(\w+) \.[^{}]*FILTER\(STR\(\?\1\) != "9999-12-31"\)[^{}]*\}/,
      );
    });

    it('a repeal edge with no CELEX and an open-ended validity yield no reason fields', async () => {
      const result = await getDocument('31990R0001');
      expect(structuredOf(result).in_force).toBe(false);
      expectNoReasons(result);
    });

    it("a consolidated text reports its base act's reasons", async () => {
      const result = await getDocument('01995L0046-20180525');

      const structured = structuredOf(result);
      expect(structured.base_act_celex).toBe('31995L0046');
      expect(structured.in_force).toBe(false);
      expect(structured.repealed_by).toEqual(['32016R0679']);
      expect(structured.end_of_validity).toBe('2018-05-24');
      expect(textOf(result)).toContain('**Repealed by:** 32016R0679');
    });

    it('sorts several repealing acts and reads the dates as string aggregates', async () => {
      mockSparqlQuery.mockImplementation(async (q: string) => {
        const rows = await fakeConsolidationCellar(q);
        if (!q.includes('cdm:expression_belongs_to_work')) return rows;
        return rows.map((r) => ({
          ...r,
          inForce: { type: 'literal', value: '0' },
          repealedBy: { type: 'literal', value: '32012R0528 32008R1101 32009R0217' },
        }));
      });
      const result = await runToolContract(eurlex_get_document, {
        celex_number: '32003R1882',
        content_mode: 'metadata_only',
      });

      expect(structuredOf(result).repealed_by).toEqual(['32008R1101', '32009R0217', '32012R0528']);
      expect(textOf(result)).toContain('**Repealed by:** 32008R1101, 32009R0217, 32012R0528');
      // CELLAR computes a grouped MAX over an OPTIONAL xsd:date wrongly; STR() avoids it.
      const core = mockSparqlQuery.mock.calls
        .map((c) => c[0] as string)
        .find((q) => q.includes('cdm:expression_belongs_to_work'));
      expect(core).toMatch(/MIN\(STR\(\?\w+\)\) AS \?entryIntoForce/);
      expect(core).toMatch(/MAX\(STR\(\?\w+\)\) AS \?endOfValidity/);
    });
  });

  // --- #104: a work_uri carrying several CELEX ---

  describe('a work_uri carrying several CELEX (#104)', () => {
    const NIM_WORK = `${CELLAR}002d2e00-f978-11e4-a4c8-01aa75ed71a1`;
    const GDPR_WORK = `${CELLAR}3e485e15-11bd-11e6-ba9a-01aa75ed71a1`;
    const TWO_CELEX_WORK = `${CELLAR}fixture-two-celex`;
    const EMPTY_WORK = `${CELLAR}fixture-celexless`;
    /** The 30 CELEX the national measure carried on 2026-09-25, lowest first. */
    const NIM_CELEX = [
      '71989L0391',
      '71997L0081',
      '71999L0070',
      '72000L0078',
      '72003L0088',
      '72004L0113',
      '72006L0011',
      '72006L0054',
      '72009L0071',
      '72010L0018',
      '72011L0070',
      '72013L0053',
      '72013L0054',
      '72013L0059',
      '72014L0028',
      '72014L0047',
      '72014L0087',
      '72014L0090',
      '72015L0849',
      '72016L0680',
      '72016L0797',
      '72018L0843',
      '72019L0001',
      '72019L0633',
      '72019L0997',
      '72019L1152',
      '72019L1158',
      '72019L1937',
      '72022L2041',
      '72024L1346',
    ].map((core) => `${core}CZE_225030`);
    const LOWEST = '71989L0391CZE_225030';

    const literal = (value: string) => ({ type: 'literal', value });

    /**
     * Answer the work_uri dereference the way CELLAR evaluates it: an aggregate reads
     * every CELEX of the work, while a plain SELECT gets them in endpoint order,
     * which differs from call to call.
     */
    let endpointShift = 0;
    const derefRows = (query: string, celexes: string[]) => {
      if (query.includes('MIN(STR(')) {
        const [lowest] = celexes.toSorted();
        return [
          {
            ...(lowest ? { celex: literal(lowest) } : {}),
            celexCount: literal(String(celexes.length)),
          },
        ];
      }
      const shift = celexes.length > 0 ? endpointShift++ % celexes.length : 0;
      const rows = [...celexes.slice(shift), ...celexes.slice(0, shift)].map((c) => ({
        celex: literal(c),
      }));
      return /LIMIT 1\b/.test(query) ? rows.slice(0, 1) : rows;
    };

    const WORKS: Record<string, string[]> = {
      [NIM_WORK]: NIM_CELEX,
      [TWO_CELEX_WORK]: ['72019L1158DEU_1', '72019L1152DEU_1'],
      [GDPR_WORK]: ['32016R0679'],
      [EMPTY_WORK]: [],
    };
    const cellar = async (query: string) => {
      if (isResolutionQuery(query)) return resolutionRows(query);
      for (const [work, celexes] of Object.entries(WORKS)) {
        if (query.includes(`<${work}> cdm:resource_legal_id_celex`)) {
          return derefRows(query, celexes);
        }
      }
      if (query.includes('cdm:expression_belongs_to_work')) {
        return [makeMetaBinding({ celex: 'n/a', title: 'National measure' })];
      }
      return [];
    };

    beforeEach(() => {
      endpointShift = 7;
      mockSparqlQuery.mockImplementation(cellar);
    });

    const getByWork = (workUri: string, args: Record<string, unknown> = {}) =>
      runToolContract(eurlex_get_document, {
        work_uri: workUri,
        content_mode: 'metadata_only',
        ...args,
      });
    const textOf = (result: Awaited<ReturnType<typeof getByWork>>) =>
      result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    const noticeOf = (result: Awaited<ReturnType<typeof getByWork>>) =>
      (result.structuredContent as { notice?: string }).notice;

    it('a single-CELEX work_uri serves its CELEX with no notice', async () => {
      const result = await getByWork(GDPR_WORK);

      expect(result.isError).toBeFalsy();
      const structured = eurlex_get_document.output.parse(result.structuredContent);
      expect(structured.celex_number).toBe('32016R0679');
      expect(noticeOf(result)).toBeUndefined();
      expect(textOf(result)).not.toContain('CELEX numbers');
    });

    it('a work_uri with no CELEX still fails not_found', async () => {
      const ctx = createMockContext({ errors: eurlex_get_document.errors });
      const input = eurlex_get_document.input.parse({ work_uri: EMPTY_WORK });
      await expect(eurlex_get_document.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'not_found' },
      });
    });

    it('propagates a caller cancellation raised by the dereference', async () => {
      mockSparqlQuery.mockImplementation((q: string) =>
        q.includes(`<${NIM_WORK}> cdm:resource_legal_id_celex`)
          ? Promise.reject(new DOMException('The operation was aborted.', 'AbortError'))
          : cellar(q),
      );
      const ctx = createMockContext({ errors: eurlex_get_document.errors });
      const input = eurlex_get_document.input.parse({ work_uri: NIM_WORK });
      await expect(eurlex_get_document.handler(input, ctx)).rejects.toThrow(/aborted/);
    });

    it('serves the lowest CELEX on every call, whatever the endpoint row order', async () => {
      const served: string[] = [];
      for (let call = 0; call < 3; call++) {
        const result = await getByWork(NIM_WORK);
        served.push(eurlex_get_document.output.parse(result.structuredContent).celex_number);
      }
      expect(served).toEqual([LOWEST, LOWEST, LOWEST]);
      mockFetchContent.mockResolvedValue({
        content: 'body',
        contentAvailable: true,
        format: 'html',
        language: 'EN',
      });
      await getByWork(NIM_WORK, { content_mode: 'paged' });
      expect(mockFetchContent).toHaveBeenCalledWith(LOWEST, 'EN', 'html', expect.anything());
    });

    it('names the count and the served CELEX in a notice, on both channels', async () => {
      const result = await getByWork(NIM_WORK);

      const notice = noticeOf(result);
      expect(notice).toContain('30 CELEX numbers');
      expect(notice).toContain(LOWEST);
      expect(notice).toContain('celex_number');
      expect(textOf(result)).toContain(notice as string);
      expect(textOf(result)).toContain(`## ${LOWEST}`);
    });

    it('notices a work carrying exactly two CELEX', async () => {
      const result = await getByWork(TWO_CELEX_WORK);
      expect(eurlex_get_document.output.parse(result.structuredContent).celex_number).toBe(
        '72019L1152DEU_1',
      );
      expect(noticeOf(result)).toContain('2 CELEX numbers');
    });

    it('keeps the paging guidance when the body window is also cut', async () => {
      mockFetchContent.mockResolvedValue({
        content: 'x'.repeat(50),
        contentAvailable: true,
        format: 'html',
        language: 'EN',
      });
      const result = await getByWork(NIM_WORK, { content_mode: 'paged', limit: 10 });

      const structured = result.structuredContent as { notice?: string; truncated?: boolean };
      expect(structured.truncated).toBe(true);
      expect(structured.notice).toContain('offset=10');
      expect(structured.notice).toContain('30 CELEX numbers');
      expect(textOf(result)).toContain(structured.notice as string);
    });

    it('a celex_number request carries no notice and never dereferences a work', async () => {
      const result = await runToolContract(eurlex_get_document, {
        celex_number: '72019L1152CZE_225030',
        content_mode: 'metadata_only',
      });
      expect(noticeOf(result)).toBeUndefined();
      expect(mockSparqlQuery.mock.calls.some((c) => (c[0] as string).includes(NIM_WORK))).toBe(
        false,
      );
    });
  });
});
