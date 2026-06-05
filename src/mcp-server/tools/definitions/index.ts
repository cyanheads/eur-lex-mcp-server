/**
 * @fileoverview Barrel export for all EUR-Lex MCP tool definitions.
 * @module mcp-server/tools/definitions/index
 */

import { eurlex_browse_subjects } from './eurlex-browse-subjects.tool.js';
import { eurlex_get_cases } from './eurlex-get-cases.tool.js';
import { eurlex_get_document } from './eurlex-get-document.tool.js';
import { eurlex_get_relations } from './eurlex-get-relations.tool.js';
import { eurlex_lookup_celex } from './eurlex-lookup-celex.tool.js';
import { eurlex_query_sparql } from './eurlex-query-sparql.tool.js';
import { eurlex_search_documents } from './eurlex-search-documents.tool.js';

export const allToolDefinitions = [
  eurlex_lookup_celex,
  eurlex_browse_subjects,
  eurlex_search_documents,
  eurlex_get_cases,
  eurlex_get_document,
  eurlex_get_relations,
  eurlex_query_sparql,
];
