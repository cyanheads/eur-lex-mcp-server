/**
 * @fileoverview Server-specific configuration for eur-lex-mcp-server.
 * Parses environment variables for CELLAR SPARQL and EUR-Lex content API settings.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  cellarSparqlEndpoint: z
    .string()
    .url()
    .default('http://publications.europa.eu/webapi/rdf/sparql')
    .describe('CELLAR SPARQL endpoint URL (Virtuoso)'),
  eurLexContentBaseUrl: z
    .string()
    .url()
    .default('https://eur-lex.europa.eu')
    .describe('EUR-Lex content API base URL'),
  sparqlQueryTimeoutMs: z.coerce
    .number()
    .int()
    .positive()
    .default(55_000)
    .describe('Client-side timeout for SPARQL requests in milliseconds'),
  maxSparqlResults: z.coerce
    .number()
    .int()
    .positive()
    .max(100)
    .default(100)
    .describe('Enforced ceiling on LIMIT in all generated SPARQL queries'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    cellarSparqlEndpoint: 'CELLAR_SPARQL_ENDPOINT',
    eurLexContentBaseUrl: 'EURLEX_CONTENT_BASE_URL',
    sparqlQueryTimeoutMs: 'SPARQL_QUERY_TIMEOUT_MS',
    maxSparqlResults: 'MAX_SPARQL_RESULTS',
  });
  return _config;
}
