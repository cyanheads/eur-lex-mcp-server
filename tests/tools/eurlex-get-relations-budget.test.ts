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

afterEach(() => vi.unstubAllGlobals());

it('walks actual-service multi-direction pages to exhaustion and preserves omitted/all equivalence', async () => {
  initCellarSparqlService({} as AppConfig, {} as StorageService, {
    cellarSparqlEndpoint: 'http://cellar.test/sparql',
    eurLexContentBaseUrl: 'http://content.test',
    sparqlQueryTimeoutMs: 5000,
    maxSparqlResults: 100,
  });
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
      expect(
        result.content.some((block) => block.type === 'text' && block.text.includes(title)),
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
