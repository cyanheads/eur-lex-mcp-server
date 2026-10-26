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
  name: 'eur-lex-mcp-server',
  title: 'eur-lex-mcp-server',
  tools: allToolDefinitions,
  resources: allResourceDefinitions,
  prompts: allPromptDefinitions,
  skills: 'skills',
  sessionMode: 'stateless',
  instructions: `EUR-Lex MCP server provides access to the EU CELLAR semantic repository (2.7M+ EU legal works) and the EUR-Lex content API.

Workflow orientation:
- Subject search: resolve a keyword to EuroVoc concept URIs with eurlex_browse_subjects, then pass a returned URI to the eurovoc_concept filter of eurlex_search_documents (that filter accepts only EuroVoc http://eurovoc.europa.eu/ URIs).
- Legislation vs case law: eurlex_search_documents covers legislation, treaties, and preparatory acts; eurlex_get_cases covers CJEU and General Court case law with court, case-number, and AG-opinion parameters. Both return CELEX numbers and work URIs.
- Full text: fetch metadata and body for a CELEX, ELI, or work URI with eurlex_get_document, which also reports its ELI and Official Journal reference.
- Relationships: eurlex_get_relations returns the one-hop amendment, repeal, consolidation, national-transposition, and citation edges of an act, its legal basis and the works adopted under it, the proposal it adopts (or, for a proposal, the act that adopted it), and the rulings interpreting it (or, for a ruling, the acts it interprets); amendment, repeal, interpretation, and adoption edges carry the provisions they target, and its article filter narrows the interpreting rulings to one article; fetch a linked consolidated version with eurlex_get_document. For multi-hop traversal beyond the curated tools, use eurlex_query_sparql (read-only SELECT).
- eurlex_lookup_celex confirms that a CELEX, ELI, or ECLI resolves to a real CELLAR work before you fetch or traverse it, and turns an OJ citation that names its act type and year ("Regulation (EU) 2016/679", "Directive 95/46/EC") into its CELEX, as it does an Official Journal reference naming the issue, date, and first page ("OJ L 119, 4.5.2016, p. 1") or the act-by-act number ("OJ L, 2024/1689, 12.7.2024").

Identifiers: CELEX format {sector}{year}{type}{number} — e.g. 32016R0679 (GDPR), 62024CJ0629 (case). ELI format http://data.europa.eu/eli/{type}/{year}/{number} — the /oj suffix is optional. ECLI is the citation form of case law, e.g. ECLI:EU:C:2014:317; eurlex_get_cases returns it per case, and eurlex_lookup_celex resolves one to its CELEX.
Document text comes from the EUR-Lex REST API; metadata and relations come from CELLAR SPARQL.`,
  setup(core) {
    const serverConfig = getServerConfig();
    initCellarSparqlService(core.config, core.storage, serverConfig);
    initEurLexContentService(core.config, core.storage, serverConfig);
  },
});
