/**
 * @fileoverview eurlex_get_document serving an xml body CELLAR holds only as a
 * zipped Formex 4 package (#108), through the real content service and its body
 * cache: the assembled body on both surfaces (outline, paging, selection, the
 * character cap), and the unavailable outcomes with their closing lines. CELLAR
 * SPARQL is mocked and `fetch` is stubbed; no test touches the live network.
 * @module tests/tools/eurlex-get-document.formex-package.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eurlex_get_document } from '@/mcp-server/tools/definitions/eurlex-get-document.tool.js';
import { initEurLexContentService } from '@/services/eurlex-content/eurlex-content-service.js';
import { FORMEX_PACKAGE_MAX_BYTES } from '@/services/eurlex-content/formex-package.js';
import { isResolutionQuery, resolutionRows } from '../fixtures/cellar-works.js';
import {
  actByActPackage,
  buildZip,
  PACKAGE_ACT,
  type ZipFixtureEntry,
} from '../fixtures/formex-zip.js';

const mockSparqlQuery = vi.fn();

vi.mock('@/services/cellar-sparql/cellar-sparql-service.js', () => ({
  getCellarSparqlService: () => ({ query: mockSparqlQuery }),
  CellarSparqlService: {
    bindingValue: (binding: Record<string, { value?: string }> | undefined, field: string) =>
      binding?.[field]?.value,
    parseBoolean: () => undefined,
  },
}));

const CELEX = '32024R1689';
const ZIP = 'application/zip;mtype=fmx4';
const ACT = 'L_202401689EN.000101.fmx.xml';

describe('eurlex_get_document on a zipped Formex package (#108)', () => {
  const mockFetch = vi.fn();
  let packageEntries: ZipFixtureEntry[];
  let packageStatus: number;

  beforeEach(() => {
    mockSparqlQuery.mockReset();
    mockSparqlQuery.mockImplementation(async (q: string) =>
      isResolutionQuery(q) ? resolutionRows(q) : [],
    );
    packageEntries = actByActPackage();
    packageStatus = 200;
    mockFetch.mockReset();
    mockFetch.mockImplementation((_url: string, init: { headers: Record<string, string> }) =>
      Promise.resolve(
        init.headers.Accept === ZIP && packageStatus === 200
          ? new Response(buildZip(packageEntries), { status: 200 })
          : new Response('does not hold a content datastream', { status: 404 }),
      ),
    );
    vi.stubGlobal('fetch', mockFetch);
    initEurLexContentService({} as AppConfig, {} as StorageService, {
      cellarSparqlEndpoint: 'http://publications.europa.eu/webapi/rdf/sparql',
      eurLexContentBaseUrl: 'http://publications.europa.eu',
      sparqlQueryTimeoutMs: 5_000,
      maxSparqlResults: 100,
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const call = async (args: Record<string, unknown>) => {
    const response = await runToolContract(eurlex_get_document, {
      celex_number: CELEX,
      format: 'xml',
      ...args,
    });
    const text = response.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    return { text, result: eurlex_get_document.output.parse(response.structuredContent) };
  };

  it('outlines the assembled act on both surfaces from one package request', async () => {
    const { result, text } = await call({ outline: true });

    expect(result.content_status).toBe('available');
    expect(result.outline?.map((h) => h.label)).toEqual(['CHAPTER I', 'Article 1', 'Article 2']);
    for (const label of ['CHAPTER I', 'Article 1', 'Article 2']) expect(text).toContain(label);
    expect(
      mockFetch.mock.calls.map((c) => (c[1] as { headers: Record<string, string> }).headers.Accept),
    ).toEqual(['application/xml;type=fmx4', ZIP]);
  });

  it('pages the assembled body from the cache with the same total and offsets', async () => {
    const first = await call({ limit: 500 });
    const second = await call({ offset: 500, limit: 500 });
    const whole = await call({ content_mode: 'full' });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(first.result.content?.startsWith('<?xml version="1.0"')).toBe(true);
    expect(first.result.content).toContain('zipped Formex 4 package');
    expect(second.result.content_chars_total).toBe(first.result.content_chars_total);
    expect(second.result.content).toBe(whole.result.content?.slice(500, 1000));
    expect(first.result.has_more).toBe(true);
    expect(first.text).toContain('offset=500');
    expect(second.text).toContain(second.result.content?.slice(0, 80) ?? '<missing>');
  });

  it('selects a chapter and an article nested in it, each with its own address', async () => {
    const { result, text } = await call({ select: { chapters: 'I', articles: '2' } });

    const [chapter, article] = result.selected_sections ?? [];
    expect(result.selected_sections?.map((s) => s.label)).toEqual(['CHAPTER I', 'Article 2']);
    const whole = (await call({ content_mode: 'full' })).result.content ?? '';
    expect(whole.slice(chapter!.offset, chapter!.offset + chapter!.chars)).toContain('Article 1');
    expect(article!.offset).toBeGreaterThan(chapter!.offset);
    expect(article!.offset + article!.chars).toBeLessThanOrEqual(chapter!.offset + chapter!.chars);
    expect(whole.slice(article!.offset, article!.offset + article!.chars)).toMatch(
      /^<TI\.ART>Article 2<\/TI\.ART>.*Scope/,
    );
    expect(result.content).toBe(whole.slice(chapter!.offset, chapter!.offset + chapter!.chars));
    expect(text).toContain('Section addresses');
    expect(text).toContain(`Article 2 — offset ${article!.offset}`);
  });

  it('reads an offset past the end as an empty window', async () => {
    const total = (await call({})).result.content_chars_total ?? 0;
    const past = await call({ offset: total + 10 });

    expect(past.result.content).toBeUndefined();
    expect(past.result.has_more).toBe(false);
    expect(past.text).toContain('past the end of the');
  });

  it('caps a package body larger than one window and pages the rest', async () => {
    const big = PACKAGE_ACT.replace(
      '</ENACTING.TERMS>',
      `<P>${'harmonised rules '.repeat(8_000)}</P></ENACTING.TERMS>`,
    );
    packageEntries = actByActPackage({ [ACT]: { name: ACT, content: big, method: 'stored' } });

    const { result } = await call({ content_mode: 'full', limit: 100_000 });

    expect(result.content?.length).toBe(100_000);
    expect(result.content_chars_total).toBeGreaterThan(100_000);
    expect(result.has_more).toBe(true);
  });

  it('closes a package over the size cap as multipart_incomplete on both surfaces', async () => {
    packageEntries = actByActPackage({
      [ACT]: { name: ACT, content: PACKAGE_ACT, declaredSize: FORMEX_PACKAGE_MAX_BYTES + 1 },
    });

    const { result, text } = await call({});

    expect(result.content_status).toBe('unavailable');
    expect(result.content_unavailability_reason).toBe('multipart_incomplete');
    expect(text).toContain('**Content unavailable because:** multipart_incomplete');
    expect(text.split('\n').at(-1)).toMatch(
      /Formex 4 body comes in parts that could not all be read/,
    );
    expect(text).not.toMatch(/requested language/);
  });

  it('closes a work with no Formex in any form as no_representation, naming the language', async () => {
    packageStatus = 404;

    const { result, text } = await call({ celex_number: '31995L0046' });

    expect(result.content_unavailability_reason).toBe('no_representation');
    expect(text.split('\n').at(-1)).toBe(
      '*No xml body exists for this work in the requested language.*',
    );
  });
});
