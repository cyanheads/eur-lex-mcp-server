/**
 * @fileoverview eurlex_lookup_celex — Resolve an EU legal citation (CELEX number or ELI URI) to a canonical CELLAR work.
 * @module mcp-server/tools/definitions/eurlex-lookup-celex
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  CellarSparqlService,
  getCellarSparqlService,
} from '@/services/cellar-sparql/cellar-sparql-service.js';
import {
  escapeSparqlLiteral,
  isEliUri,
  resolveEliToWork,
} from '@/services/cellar-sparql/eli-resolution.js';
import type { SparqlBinding } from '@/services/cellar-sparql/types.js';

/** Detect CELEX number format: starts with a sector digit. */
function isCelex(identifier: string): boolean {
  return /^[1-9]\d{4}[A-Z]+\d+/.test(identifier.trim());
}

type IdentifierType = 'celex' | 'eli' | 'auto';

function detectIdentifierType(identifier: string): IdentifierType | null {
  if (isCelex(identifier)) return 'celex';
  if (isEliUri(identifier)) return 'eli';
  return null;
}

export const eurlex_lookup_celex = tool('eurlex_lookup_celex', {
  title: 'Resolve EU Legal Citation',
  description:
    'Resolve an EU legal citation — a CELEX number or an ELI URI — to the canonical CELLAR work. ' +
    'Returns the work URI, confirmed CELEX number, document type, document date, and whether the work exists in the CELLAR corpus. ' +
    'Use this to validate identifiers before passing them to eurlex_get_document or eurlex_get_relations. ' +
    'CELEX format: {sector}{year}{type}{number} e.g. 32016R0679 (GDPR). ' +
    'ELI format: http://data.europa.eu/eli/{type}/{year}/{number} — the /oj suffix is optional.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    identifier: z
      .string()
      .min(1)
      .describe(
        'The EU legal citation to resolve: a CELEX number (e.g. 32016R0679) or a work-level ELI URI (e.g. http://data.europa.eu/eli/reg/2016/679, with or without the /oj suffix).',
      ),
    identifier_type: z
      .enum(['celex', 'eli', 'auto'])
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
        'True when the identifier resolves to a CELLAR work; false when a well-formed CELEX/ELI matches no work in the corpus. A malformed or undetectable identifier raises ambiguous_identifier instead.',
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
      reason: 'ambiguous_identifier',
      code: JsonRpcErrorCode.ValidationError,
      when: 'identifier_type is "auto" and the identifier format could not be determined.',
      recovery: 'Supply identifier_type explicitly as "celex" or "eli" to resolve the ambiguity.',
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

    // ELI resolution (exact-match on cdm:resource_legal_eli, with the bare
    // work-level /oj retry) is shared with eurlex_get_document — see
    // services/cellar-sparql/eli-resolution.ts. The CELEX branch stays here: a
    // direct exact-string match on the CELEX literal.
    let binding: SparqlBinding | null;
    if (effectiveType === 'celex') {
      const celexQuery = `
SELECT ?work ?celexNumber ?type ?date WHERE {
  ?work cdm:resource_legal_id_celex ?celexNumber .
  OPTIONAL { ?work cdm:work_has_resource-type ?type . }
  OPTIONAL { ?work cdm:work_date_document ?date . }
  FILTER(STR(?celexNumber) = "${escapeSparqlLiteral(identifier)}")
} LIMIT 5`;
      const bindings = await svc.query(celexQuery, ctx);
      binding = bindings[0] ?? null;
    } else {
      binding = await resolveEliToWork(svc, identifier, ctx);
    }

    ctx.log.info('Citation lookup', {
      identifier,
      type: effectiveType,
      found: binding !== null,
    });

    if (!binding) {
      // A well-formed identifier that resolves to no work is a clean negative,
      // not an error — the documented "validate before fetch" role depends on a
      // boolean here. Malformed/undetectable input already errored above with
      // ambiguous_identifier.
      return { found: false };
    }

    return {
      found: true,
      work_uri: CellarSparqlService.bindingValue(binding, 'work'),
      celex_number: CellarSparqlService.bindingValue(binding, 'celexNumber'),
      resource_type: CellarSparqlService.bindingValue(binding, 'type'),
      date: CellarSparqlService.bindingValue(binding, 'date'),
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
