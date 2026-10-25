/**
 * @fileoverview Whole-row relation paging through the actual CELLAR service and wire contract.
 * @module tests/tools/eurlex-get-relations-budget
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { eurlex_get_relations } from '@/mcp-server/tools/definitions/eurlex-get-relations.tool.js';
import { initCellarSparqlService } from '@/services/cellar-sparql/cellar-sparql-service.js';
import { RELATION_TYPES } from '@/services/cellar-sparql/relation-traversal.js';
import { readCommonMark } from '../helpers/commonmark.js';

afterEach(() => vi.unstubAllGlobals());

/** The actual CELLAR service, pointed at a stubbed endpoint with a 100-row ceiling. */
function initService() {
  initCellarSparqlService({} as AppConfig, {} as StorageService, {
    cellarSparqlEndpoint: 'http://cellar.test/sparql',
    eurLexContentBaseUrl: 'http://content.test',
    sparqlQueryTimeoutMs: 5000,
    maxSparqlResults: 100,
  });
}

it('walks actual-service multi-direction pages to exhaustion and preserves omitted/all equivalence', async () => {
  initService();
  const title = 'é漢😀"\\\r\n'.repeat(300);
  const bindings = (direction: string, count: number) =>
    Array.from({ length: count }, (_, i) => ({
      relatedWork: { type: 'uri', value: `http://example.test/shared-${i}` },
      direction: { type: 'literal', value: direction },
      relatedTitleMax: { type: 'literal', value: title },
    }));
  const arms = [bindings('incoming', 31), bindings('outgoing', 4)];
  const queries: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const query = new URLSearchParams(String(init.body)).get('query') ?? '';
      queries.push(query);
      const match = /LIMIT (\d+) OFFSET (\d+)/.exec(query);
      const rows =
        query.includes('cdm:work_cites_work') && match
          ? arms.flatMap((arm) => arm.slice(Number(match[2]), Number(match[2]) + Number(match[1])))
          : [];
      return new Response(
        JSON.stringify({
          head: { vars: ['relatedWork', 'direction', 'relatedTitleMax'] },
          results: { bindings: rows },
        }),
      );
    }),
  );
  const input = { work_uri: 'http://example.test/source' };
  const first = await runToolContract(eurlex_get_relations, input);
  const explicit = await runToolContract(eurlex_get_relations, {
    ...input,
    relation_types: [...RELATION_TYPES],
  });
  expect(explicit).toEqual(first);
  const keys: string[] = [];
  let offset = 0;
  let calls = 0;
  for (; calls < 40; calls++) {
    const result = await runToolContract(eurlex_get_relations, { ...input, offset });
    expect(result.isError).not.toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result.structuredContent), 'utf8')).toBeLessThanOrEqual(
      64000,
    );
    expect(Buffer.byteLength(JSON.stringify(result.content), 'utf8')).toBeLessThanOrEqual(64000);
    const page = result.structuredContent as {
      relations: { direction: string; related_work_uri: string; related_title: string }[];
      next_offset?: number;
      has_more: boolean;
      cap?: number;
    };
    for (const row of page.relations) {
      keys.push(`${row.direction}:${row.related_work_uri}`);
      expect(row.related_title).toBe(title);
      // content[] carries the title escaped; a CommonMark reader gets it back, CRLF as LF.
      expect(
        result.content.some(
          (block) =>
            block.type === 'text' &&
            readCommonMark(block.text).includes(title.replace(/\r\n/g, '\n')),
        ),
      ).toBe(true);
    }
    if (offset >= 4) expect(page.relations.every((row) => row.direction === 'incoming')).toBe(true);
    if (!page.has_more) break;
    if (page.next_offset === undefined) throw new Error('Missing continuation');
    expect(page.next_offset).toBe(offset + (page.cap ?? 100));
    offset = page.next_offset;
  }
  expect(calls).toBeGreaterThan(1);
  expect(calls).toBeLessThan(40);
  expect(keys.toSorted()).toEqual(
    [
      ...Array.from({ length: 31 }, (_, i) => `incoming:http://example.test/shared-${i}`),
      ...Array.from({ length: 4 }, (_, i) => `outgoing:http://example.test/shared-${i}`),
    ].toSorted(),
  );
  expect(new Set(keys).size).toBe(35);
  expect(queries.every((query) => query.startsWith('PREFIX'))).toBe(true);
});

it('reads all of an edge’s provisions through the actual service, past its row ceiling (#168)', async () => {
  initService();
  const fd = 'http://publications.europa.eu/resource/authority/fd_370';
  const amended = 'http://example.test/32013R0575';
  // 755 designators on one edge, each recorded twice, as 32024R1623 amends 32013R0575.
  const locations = Array.from(
    { length: 755 },
    (_, i) => `{AR|${fd}/AR} ${i + 1} {PA|${fd}/PA} ${(i % 9) + 1}`,
  );
  const sent: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      if (new URL(url).hostname !== 'cellar.test') throw new Error(`Unexpected host: ${url}`);
      const query = new URLSearchParams(String(init.body)).get('query') ?? '';
      sent.push(query);
      const bindings = query.includes('?location')
        ? [...locations, ...locations].map((location) => ({
            relatedWork: { type: 'uri', value: amended },
            location: { type: 'literal', value: location },
          }))
        : query.includes('cdm:resource_legal_amends_resource_legal ?relatedWork')
          ? [
              {
                relatedWork: { type: 'uri', value: amended },
                direction: { type: 'literal', value: 'outgoing' },
                relatedCelexSample: { type: 'literal', value: '32013R0575' },
              },
            ]
          : [];
      return new Response(JSON.stringify({ head: { vars: [] }, results: { bindings } }));
    }),
  );

  const result = await runToolContract(eurlex_get_relations, {
    work_uri: 'http://example.test/32024R1623',
    relation_types: ['amends'],
  });

  const page = eurlex_get_relations.output.parse(result.structuredContent);
  const provisions = page.relations[0]?.provisions ?? [];
  expect(provisions).toHaveLength(755);
  expect(provisions).toContain('AR 43 PA 7');
  expect(provisions.some((p) => p.includes('{'))).toBe(false);
  const followUp = sent.find((query) => query.includes('?location')) ?? '';
  // The internal path leaves the LIMIT-less follow-up uncapped.
  expect(followUp).not.toMatch(/LIMIT/);
  expect(followUp.startsWith('PREFIX')).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(result.structuredContent), 'utf8')).toBeLessThanOrEqual(
    64000,
  );
  expect(Buffer.byteLength(JSON.stringify(result.content), 'utf8')).toBeLessThanOrEqual(64000);
});
