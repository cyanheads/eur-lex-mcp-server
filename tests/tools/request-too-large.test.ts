/**
 * @fileoverview The `request_too_large` contract on every definition whose CELLAR
 * query grows with its input (#206). Each declares the reason, and an input long enough
 * to size its query past CELLAR's 8,192-byte request limit reaches the caller as that
 * reason with the definition's own recovery, with no request over the limit sent. The
 * byte boundary itself is tested once, at the service seam
 * (`tests/services/cellar-sparql-service.test.ts`).
 * @module tests/tools/request-too-large.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eurlex_document_resource } from '@/mcp-server/resources/definitions/eurlex-document.resource.js';
import { eurlex_browse_subjects } from '@/mcp-server/tools/definitions/eurlex-browse-subjects.tool.js';
import { eurlex_get_cases } from '@/mcp-server/tools/definitions/eurlex-get-cases.tool.js';
import { eurlex_get_document } from '@/mcp-server/tools/definitions/eurlex-get-document.tool.js';
import { eurlex_lookup_celex } from '@/mcp-server/tools/definitions/eurlex-lookup-celex.tool.js';
import { eurlex_query_sparql } from '@/mcp-server/tools/definitions/eurlex-query-sparql.tool.js';
import { eurlex_search_documents } from '@/mcp-server/tools/definitions/eurlex-search-documents.tool.js';
import { initCellarSparqlService } from '@/services/cellar-sparql/cellar-sparql-service.js';
import { initEurLexContentService } from '@/services/eurlex-content/eurlex-content-service.js';
import { resourceReader } from '../helpers/resource-wire.js';

/** A definition's declared failure modes, as both tools and resources carry them. */
interface Contract {
  errors?: readonly { reason: string; code: number; when: string; recovery: string }[];
}

type ToolResult = Awaited<ReturnType<typeof runToolContract>>;

/*
 * Title words with no digit, so no CELEX arm applies and the keyword reaches each
 * search query as a full-text phrase: 9,599 one-byte characters, past the limit
 * wherever a query carries the phrase once.
 */
const WORDS = 'data protection '.repeat(600).trim();

/** Every tool whose query grows with its input, each with one input long enough to pass the limit. */
const TOOLS: [name: string, definition: Contract, call: () => Promise<ToolResult>][] = [
  [
    'eurlex_query_sparql',
    eurlex_query_sparql,
    // Issue #206's reproduction: a short SELECT and an 8,300-character comment line.
    () =>
      runToolContract(eurlex_query_sparql, {
        sparql_query: `SELECT ?s WHERE { ?s ?p ?o } LIMIT 1\n# ${'x'.repeat(8_300)}`,
      }),
  ],
  [
    'eurlex_lookup_celex',
    eurlex_lookup_celex,
    () =>
      runToolContract(eurlex_lookup_celex, { identifier: `ECLI:EU:C:2014:${'3'.repeat(9_000)}` }),
  ],
  [
    'eurlex_get_document',
    eurlex_get_document,
    () => runToolContract(eurlex_get_document, { celex_number: `32016R${'0'.repeat(9_000)}` }),
  ],
  [
    'eurlex_search_documents',
    eurlex_search_documents,
    () => runToolContract(eurlex_search_documents, { keyword: WORDS }),
  ],
  [
    'eurlex_get_cases',
    eurlex_get_cases,
    () => runToolContract(eurlex_get_cases, { keyword: WORDS }),
  ],
  [
    'eurlex_browse_subjects',
    eurlex_browse_subjects,
    () => runToolContract(eurlex_browse_subjects, { keyword: WORDS }),
  ],
];

const DEFINITIONS: [name: string, definition: Contract][] = [
  ...TOOLS.map(([name, definition]): [string, Contract] => [name, definition]),
  ['eurlex://document/{celexNumber}', eurlex_document_resource],
];

/**
 * What each definition's `request_too_large` recovery names, written out here so a
 * recovery reworded with another definition's inputs fails: the inputs that size its
 * query, and for the two keyword searches the partial CELEX each gives as its example.
 */
const RECOVERY_NAMES: [name: string, definition: Contract, names: string[], example?: string][] = [
  ['eurlex_query_sparql', eurlex_query_sparql, ['query']],
  ['eurlex_lookup_celex', eurlex_lookup_celex, ['identifier']],
  ['eurlex_get_document', eurlex_get_document, ['celex_number', 'eli_uri', 'work_uri']],
  [
    'eurlex_search_documents',
    eurlex_search_documents,
    ['keyword', 'author_institution', 'eurovoc_concept'],
    'R0679',
  ],
  ['eurlex_get_cases', eurlex_get_cases, ['keyword', 'case_number'], 'C0131'],
  ['eurlex_browse_subjects', eurlex_browse_subjects, ['keyword']],
  ['eurlex://document/{celexNumber}', eurlex_document_resource, ['CELEX number']],
];

/** Inputs some of these definitions take and others do not. */
const INPUT_NAMES = [
  'keyword',
  'case_number',
  'author_institution',
  'eurovoc_concept',
  'celex_number',
  'eli_uri',
  'work_uri',
];

/** The partial CELEX each keyword search's recovery gives as its example. */
const EXAMPLES = ['R0679', 'C0131'];

/** The recovery a definition declares for `request_too_large`. */
function declaredRecovery(definition: Contract): string {
  const recovery = definition.errors?.find((e) => e.reason === 'request_too_large')?.recovery;
  expect(recovery).toBeDefined();
  return recovery ?? '';
}

const readOverWire = resourceReader(eurlex_document_resource);

describe('request_too_large on every definition whose query grows with its input (#206)', () => {
  /** Every body POSTed to CELLAR, each answered with no rows. */
  let bodies: string[];

  beforeEach(() => {
    const serverConfig = {
      cellarSparqlEndpoint: 'http://cellar.test/sparql',
      eurLexContentBaseUrl: 'http://content.test',
      sparqlQueryTimeoutMs: 5_000,
      maxSparqlResults: 100,
    };
    initCellarSparqlService({} as AppConfig, {} as StorageService, serverConfig);
    // eurlex_get_document reads its content service up front; no content request is made.
    initEurLexContentService({} as AppConfig, {} as StorageService, serverConfig);
    bodies = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { body: string }) => {
        if (new URL(url).origin !== 'http://cellar.test') throw new Error(`unmocked fetch: ${url}`);
        bodies.push(init.body);
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ head: { vars: [] }, results: { bindings: [] } }),
        };
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(DEFINITIONS)(
    '%s declares request_too_large as a service-thrown input error naming the limit',
    (_name, definition) => {
      const entry = definition.errors?.find((e) => e.reason === 'request_too_large');

      expect(entry).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        thrownBy: 'service',
      });
      expect(entry?.when).toContain('8,192 bytes');
      expect(entry?.recovery).toContain('8,192');
    },
  );

  it.each(RECOVERY_NAMES)(
    '%s names its own inputs in its request_too_large recovery, and no other definition’s',
    (_name, definition, names, example) => {
      const recovery = declaredRecovery(definition);

      const named = (word: string) => new RegExp(`\\b${word}\\b`).test(recovery);
      for (const name of names) expect(recovery).toContain(name);
      expect(INPUT_NAMES.filter((name) => !names.includes(name) && named(name))).toEqual([]);
      // Whole words only: the document resource's example, 32016R0679, holds R0679.
      expect(EXAMPLES.filter(named)).toEqual(example ? [example] : []);
    },
  );

  it.each(TOOLS)(
    '%s answers an oversized input with request_too_large and its own recovery, in both channels',
    async (_name, definition, call) => {
      const recovery = declaredRecovery(definition);

      const result = await call();

      expect(result.isError).toBe(true);
      expect((result.structuredContent as { error: unknown }).error).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: {
          reason: 'request_too_large',
          retryable: false,
          limitBytes: 8_192,
          recovery: { hint: recovery },
        },
      });
      const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
      expect(text).toContain(`Recovery: ${recovery}`);
      expect(text.trimEnd().endsWith('(reason request_too_large · not retryable)')).toBe(true);
      expect(bodies.filter((body) => body.length > 8_192).map((body) => body.length)).toEqual([]);
    },
  );

  it('eurlex://document/{celexNumber} answers an oversized CELEX with request_too_large and its own recovery', async () => {
    const recovery = declaredRecovery(eurlex_document_resource);

    const read = await readOverWire(`eurlex://document/32016R${'0'.repeat(9_000)}`);

    expect(read.error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'request_too_large',
        retryable: false,
        limitBytes: 8_192,
        recovery: { hint: recovery },
      },
    });
    expect(bodies.filter((body) => body.length > 8_192).map((body) => body.length)).toEqual([]);
  });
});
