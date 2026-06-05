/**
 * @fileoverview Barrel export for all EUR-Lex MCP resource definitions.
 * @module mcp-server/resources/definitions/index
 */

import { eurlex_document_resource } from './eurlex-document.resource.js';
import { eurlex_document_relations_resource } from './eurlex-document-relations.resource.js';

export const allResourceDefinitions = [
  eurlex_document_resource,
  eurlex_document_relations_resource,
];
