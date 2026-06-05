#!/usr/bin/env node
/**
 * @fileoverview eur-lex-mcp-server MCP server entry point.
 * Provides access to the EU CELLAR repository and EUR-Lex content API.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from './config/server-config.js';
import { allPromptDefinitions } from './mcp-server/prompts/definitions/index.js';
import { allResourceDefinitions } from './mcp-server/resources/definitions/index.js';
import { allToolDefinitions } from './mcp-server/tools/definitions/index.js';
import { initCellarSparqlService } from './services/cellar-sparql/cellar-sparql-service.js';
import { initEurLexContentService } from './services/eurlex-content/eurlex-content-service.js';

await createApp({
  tools: allToolDefinitions,
  resources: allResourceDefinitions,
  prompts: allPromptDefinitions,
  instructions:
    'EUR-Lex MCP server provides access to the EU CELLAR semantic repository (2.7M+ EU legal works).\n' +
    '- Use eurlex_browse_subjects first to resolve subject keywords to EuroVoc concept URIs before filtering searches.\n' +
    '- Use eurlex_lookup_celex to validate an identifier before calling eurlex_get_document.\n' +
    '- CELEX format: {sector}{year}{type}{number} — e.g. 32016R0679 (GDPR), 62024CJ0629 (case).\n' +
    '- Document text comes from the EUR-Lex REST API; metadata and relations come from CELLAR SPARQL.\n' +
    '- eurlex_query_sparql is an escape hatch for CDM ontology traversal not covered by curated tools.',
  setup(core) {
    const serverConfig = getServerConfig();
    initCellarSparqlService(core.config, core.storage, serverConfig);
    initEurLexContentService(core.config, core.storage, serverConfig);
  },
});
