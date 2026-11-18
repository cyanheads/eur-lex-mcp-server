/**
 * @fileoverview Reads a resource the way a client does: one resources/read request to
 * the resource served by the framework, which parses the URI's variables and fills a
 * declared `errors[]` entry's recovery into the error, neither of which a direct
 * handler call does.
 * @module tests/helpers/resource-wire
 */

import { createWorkerHandler } from '@cyanheads/mcp-ts-core/worker';

// Reserved per-request `_meta` keys of MCP protocol revision 2026-07-28.
const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_CAPABILITIES_META_KEY = 'io.modelcontextprotocol/clientCapabilities';
const CLIENT_INFO_META_KEY = 'io.modelcontextprotocol/clientInfo';

type WorkerOptions = NonNullable<Parameters<typeof createWorkerHandler>[0]>;

/** A resources/read response: the read's contents, or the error a client receives. */
export interface WireRead {
  error?: {
    code: number;
    message?: string;
    data?: {
      reason?: string;
      celexNumber?: string;
      recovery?: { hint?: string };
      issues?: { path: (string | number)[]; message: string }[];
    };
  };
  result?: { contents: { text: string }[] };
}

/**
 * A reader of `resource` over the wire. `decodeResourceParams` mirrors `src/index.ts`,
 * so reads run the configuration that ships.
 */
export function resourceReader(
  resource: NonNullable<WorkerOptions['resources']>[number],
): (uri: string) => Promise<WireRead> {
  const worker = createWorkerHandler({
    name: 'eur-lex-mcp-server',
    title: 'eur-lex-mcp-server',
    resources: [resource],
    decodeResourceParams: true,
  });
  type FetchArgs = Parameters<typeof worker.fetch>;
  return async (uri) => {
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
    const response = await worker.fetch(
      request,
      {} as FetchArgs[1],
      { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as FetchArgs[2],
    );
    return (await response.json()) as WireRead;
  };
}
