/**
 * @fileoverview eurlex_lookup_celex — Resolve any EU legal citation to a canonical CELLAR work.
 * @module mcp-server/tools/definitions/eurlex-lookup-celex
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  CellarSparqlService,
  getCellarSparqlService,
} from '@/services/cellar-sparql/cellar-sparql-service.js';

/** Detect CELEX number format: starts with a sector digit. */
function isCelex(identifier: string): boolean {
  return /^[1-9]\d{4}[A-Z]+\d+/.test(identifier.trim());
}

/** Detect ELI URI format: starts with http://data.europa.eu/eli/ */
function isEliUri(identifier: string): boolean {
  return identifier.trim().startsWith('http://data.europa.eu/eli/');
}

/** Detect Official Journal reference format: e.g. OJ L 119, 4.5.2016 or L:2016:119 */
function isOjRef(identifier: string): boolean {
  return /^OJ\s+[LC]\s+\d+/i.test(identifier.trim()) || /^[LC]:\d{4}:\d+/.test(identifier.trim());
}

type IdentifierType = 'celex' | 'eli' | 'oj' | 'auto';

function detectIdentifierType(identifier: string): IdentifierType | null {
  if (isCelex(identifier)) return 'celex';
  if (isEliUri(identifier)) return 'eli';
  if (isOjRef(identifier)) return 'oj';
  return null;
}

export const eurlex_lookup_celex = tool('eurlex_lookup_celex', {
  title: 'Resolve EU Legal Citation',
  description:
    'Resolve any EU legal citation — CELEX number, ELI URI, or Official Journal reference — to the canonical CELLAR work. ' +
    'Returns the work URI, confirmed CELEX number, document type, document date, and whether the work exists in the CELLAR corpus. ' +
    'Use this to validate identifiers before passing them to eurlex_get_document or eurlex_get_relations. ' +
    'CELEX format: {sector}{year}{type}{number} e.g. 32016R0679 (GDPR). ' +
    'ELI format: http://data.europa.eu/eli/{type}/{year}/{number}/oj. ' +
    'OJ format: OJ L 119 or L:2016:119.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    identifier: z
      .string()
      .min(1)
      .describe(
        'The EU legal citation to resolve: a CELEX number (e.g. 32016R0679), ELI URI, or Official Journal reference (e.g. OJ L 119).',
      ),
    identifier_type: z
      .enum(['celex', 'eli', 'oj', 'auto'])
      .default('auto')
      .describe(
        'Format of the identifier. Use "auto" to let the server detect the format automatically. ' +
          'Supply explicitly if auto-detection fails or if the identifier is ambiguous.',
      ),
  }),
  output: z.object({
    found: z
      .boolean()
      .describe(
        'Always true on success (the tool throws not_found when the identifier does not resolve). Present as a discriminator for downstream logic.',
      ),
    work_uri: z.string().optional().describe('CELLAR work URI (stable resource identifier).'),
    celex_number: z.string().optional().describe('Confirmed CELEX number for the resolved work.'),
    resource_type: z
      .string()
      .optional()
      .describe(
        'CDM resource type URI indicating the document category (e.g. .../resource-type/REG for Regulation). Absent for some works.',
      ),
    date: z.string().optional().describe('Document date in ISO 8601 format (YYYY-MM-DD).'),
  }),

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The identifier resolves to no CELLAR work — check the CELEX/ELI/OJ format and try again.',
      recovery:
        'Verify the CELEX number format or try eurlex_search_documents to find the work by keyword.',
    },
    {
      reason: 'ambiguous_identifier',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'identifier_type is "auto" and the identifier format could not be determined.',
      recovery:
        'Supply identifier_type explicitly as "celex", "eli", or "oj" to resolve the ambiguity.',
    },
  ],

  async handler(input, ctx) {
    const svc = getCellarSparqlService();
    const identifier = input.identifier.trim();
    let effectiveType: IdentifierType;

    if (input.identifier_type === 'auto') {
      const detected = detectIdentifierType(identifier);
      if (!detected) {
        throw ctx.fail(
          'ambiguous_identifier',
          `Cannot determine format of identifier: ${identifier}`,
          {
            ...ctx.recoveryFor('ambiguous_identifier'),
          },
        );
      }
      effectiveType = detected;
    } else {
      effectiveType = input.identifier_type;
    }

    let sparql: string;
    if (effectiveType === 'celex') {
      sparql = `
SELECT ?work ?celexNumber ?type ?date WHERE {
  ?work cdm:resource_legal_id_celex ?celexNumber .
  OPTIONAL { ?work cdm:work_has_resource-type ?type . }
  OPTIONAL { ?work cdm:work_date_document ?date . }
  FILTER(STR(?celexNumber) = "${identifier}")
} LIMIT 5`;
    } else if (effectiveType === 'eli') {
      // ELI URIs are mapped via cdm:work_id_document_official-journal or owl:sameAs
      sparql = `
SELECT ?work ?celexNumber ?type ?date WHERE {
  ?work cdm:resource_legal_id_celex ?celexNumber .
  OPTIONAL { ?work cdm:work_has_resource-type ?type . }
  OPTIONAL { ?work cdm:work_date_document ?date . }
  FILTER(CONTAINS(STR(?work), "${identifier.replace(/"/g, '\\"')}"))
} LIMIT 5`;
    } else {
      // OJ reference: extract year and number for a loose filter on CELEX
      sparql = `
SELECT ?work ?celexNumber ?type ?date WHERE {
  ?work cdm:resource_legal_id_celex ?celexNumber .
  OPTIONAL { ?work cdm:work_has_resource-type ?type . }
  OPTIONAL { ?work cdm:work_date_document ?date . }
  FILTER(CONTAINS(LCASE(STR(?celexNumber)), LCASE("${identifier.replace(/"/g, '\\"')}")))
} LIMIT 5`;
    }

    const bindings = await svc.query(sparql, ctx);
    ctx.log.info('CELEX lookup', { identifier, type: effectiveType, resultCount: bindings.length });

    if (bindings.length === 0) {
      throw ctx.fail('not_found', `No CELLAR work found for identifier: ${identifier}`, {
        ...ctx.recoveryFor('not_found'),
      });
    }

    const first = bindings[0];
    return {
      found: true,
      work_uri: CellarSparqlService.bindingValue(first, 'work'),
      celex_number: CellarSparqlService.bindingValue(first, 'celexNumber'),
      resource_type: CellarSparqlService.bindingValue(first, 'type'),
      date: CellarSparqlService.bindingValue(first, 'date'),
    };
  },

  format: (result) => {
    const lines: string[] = [`## CELLAR Work Resolved\n**Found:** ${result.found}`];
    if (result.celex_number) lines.push(`**CELEX:** ${result.celex_number}`);
    if (result.work_uri) lines.push(`**Work URI:** ${result.work_uri}`);
    if (result.resource_type) lines.push(`**Type:** ${result.resource_type}`);
    if (result.date) lines.push(`**Date:** ${result.date}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
