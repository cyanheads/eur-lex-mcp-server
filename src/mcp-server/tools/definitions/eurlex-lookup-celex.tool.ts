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

/** Detect CELEX number format: starts with a sector digit. */
function isCelex(identifier: string): boolean {
  return /^[1-9]\d{4}[A-Z]+\d+/.test(identifier.trim());
}

/** Detect ELI URI format: starts with http://data.europa.eu/eli/ */
function isEliUri(identifier: string): boolean {
  return identifier.trim().startsWith('http://data.europa.eu/eli/');
}

type IdentifierType = 'celex' | 'eli' | 'auto';

function detectIdentifierType(identifier: string): IdentifierType | null {
  if (isCelex(identifier)) return 'celex';
  if (isEliUri(identifier)) return 'eli';
  return null;
}

const ELI_NAMESPACE = 'http://data.europa.eu/eli/';

/**
 * A bare work-level ELI — `…/eli/{type}/{year}/{number}` with no manifestation
 * suffix (no `/oj`, no `/YYYY-MM-DD` consolidation date). CELLAR stores the
 * canonical OJ-manifestation literal (`…/{number}/oj`) rather than the bare
 * work-level form, so these never match on exact lookup and must be normalized
 * to their `/oj` form to resolve.
 */
function isBareWorkLevelEli(eli: string): boolean {
  if (!eli.startsWith(ELI_NAMESPACE)) return false;
  const path = eli.slice(ELI_NAMESPACE.length).replace(/\/+$/, '');
  return /^[^/]+\/\d{4}\/[^/]+$/.test(path);
}

/** Escape backslashes then double-quotes for safe interpolation into a SPARQL string literal. */
function escapeSparqlLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * ELI exact-match query: resolve the single work whose canonical ELI literal
 * (`cdm:resource_legal_eli`, an `xsd:anyURI` literal) equals `safeEli`, reading
 * its CELEX, type, and date. `safeEli` must be pre-escaped.
 */
function buildEliQuery(safeEli: string): string {
  return `
SELECT ?work ?celexNumber ?type ?date WHERE {
  ?work cdm:resource_legal_eli "${safeEli}"^^xsd:anyURI .
  ?work cdm:resource_legal_id_celex ?celexNumber .
  OPTIONAL { ?work cdm:work_has_resource-type ?type . }
  OPTIONAL { ?work cdm:work_date_document ?date . }
} LIMIT 5`;
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
      when: 'The identifier resolves to no CELLAR work — check the CELEX/ELI format and try again.',
      recovery:
        'Verify the CELEX or ELI format, or try eurlex_search_documents to find the work by keyword.',
    },
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

    let sparql: string;
    if (effectiveType === 'celex') {
      sparql = `
SELECT ?work ?celexNumber ?type ?date WHERE {
  ?work cdm:resource_legal_id_celex ?celexNumber .
  OPTIONAL { ?work cdm:work_has_resource-type ?type . }
  OPTIONAL { ?work cdm:work_date_document ?date . }
  FILTER(STR(?celexNumber) = "${escapeSparqlLiteral(identifier)}")
} LIMIT 5`;
    } else {
      sparql = buildEliQuery(escapeSparqlLiteral(identifier));
    }

    let bindings = await svc.query(sparql, ctx);

    // CELLAR stores only the OJ-manifestation ELI literal (…/{number}/oj), so a
    // bare work-level ELI (…/{type}/{year}/{number}) — the most common citation
    // form — misses on exact match. Retry once with /oj appended: a deterministic,
    // one-to-one normalization to the same act's canonical manifestation. Gated to
    // bare work-level ELIs, so a manifestation-suffixed ELI (e.g. a /YYYY-MM-DD
    // consolidated version) never silently falls back to the original act.
    let bareEliRetry = false;
    if (bindings.length === 0 && effectiveType === 'eli' && isBareWorkLevelEli(identifier)) {
      const ojEli = `${identifier.replace(/\/+$/, '')}/oj`;
      bindings = await svc.query(buildEliQuery(escapeSparqlLiteral(ojEli)), ctx);
      bareEliRetry = true;
    }

    ctx.log.info('Citation lookup', {
      identifier,
      type: effectiveType,
      bareEliRetry,
      resultCount: bindings.length,
    });

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
