/**
 * @fileoverview eurlex_lookup_celex — Resolve an EU legal citation (CELEX number, ELI URI, or ECLI) to a canonical CELLAR work.
 * @module mcp-server/tools/definitions/eurlex-lookup-celex
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  DERIVATIVE_RESOURCE_TYPES,
  resolveResourceTypeLabel,
} from '@/services/cellar-sparql/cdm-labels.js';
import {
  CellarSparqlService,
  getCellarSparqlService,
} from '@/services/cellar-sparql/cellar-sparql-service.js';
import {
  CELEX_PATTERN,
  celexLiteral,
  escapeSparqlLiteral,
  isEliUri,
  resolveEliToWork,
} from '@/services/cellar-sparql/eli-resolution.js';
import type { SparqlBinding } from '@/services/cellar-sparql/types.js';
import {
  canonicalAliasPattern,
  isCanonicalRow,
  resolvedWorkRow,
} from '@/services/cellar-sparql/work-resolution.js';

/**
 * Detect CELEX number format, using the same structural floor the CELEX-typed
 * inputs elsewhere validate against. The former local pattern opened on `[1-9]`,
 * so it excluded sector 0 and a consolidated CELEX such as
 * `02016R0679-20160504` was detected as neither CELEX nor ELI under
 * identifier_type "auto".
 */
function isCelex(identifier: string): boolean {
  return CELEX_PATTERN.test(identifier.trim());
}

type IdentifierType = 'celex' | 'eli' | 'ecli' | 'auto';

/** Detect an ECLI by its scheme prefix, in any letter case. */
function isEcli(identifier: string): boolean {
  return /^ecli:/i.test(identifier.trim());
}

function detectIdentifierType(identifier: string): IdentifierType | null {
  if (isEcli(identifier)) return 'ecli';
  if (isCelex(identifier)) return 'celex';
  if (isEliUri(identifier)) return 'eli';
  return null;
}

/**
 * ECLI lookup query. CELLAR stores `cdm:case-law_ecli` as an `xsd:string`-typed
 * literal, so the match is a typed exact join — an untyped literal matches nothing,
 * and a `STR()` comparison scans. `literals` must be pre-escaped; each becomes one
 * typed candidate, and `?ecli` reports which one a row matched. `?canonicalAlias`
 * marks each row's work that carries its CELEX alias (#97).
 */
function buildEcliQuery(literals: readonly string[]): string {
  const values = literals.map((literal) => `"${literal}"^^xsd:string`).join(' ');
  return `
SELECT ?work ?celexNumber ?type ?date ?ecli ?canonicalAlias WHERE {
  VALUES ?ecli { ${values} }
  ?work cdm:case-law_ecli ?ecli .
  ?work cdm:resource_legal_id_celex ?celexNumber .
  ${canonicalAliasPattern('?celexNumber')}
  OPTIONAL { ?work cdm:work_has_resource-type ?type . }
  OPTIONAL { ?work cdm:work_date_document ?date . }
} LIMIT 100`;
}

/**
 * CELEX lookup query: every work holding the CELEX, bound back to ?celexNumber so
 * every branch projects the same row shape, with `?canonicalAlias` on the work the
 * CELEX resolves to (#97). The `LIMIT` covers every row of every work — a few types
 * each, and no CELEX has been seen with more than four works — so no work's rows are
 * cut before the resolved one is picked.
 */
function buildCelexQuery(celex: string): string {
  const literal = celexLiteral(celex);
  return `
SELECT ?work ?celexNumber ?type ?date ?ecli ?canonicalAlias WHERE {
  ?work cdm:resource_legal_id_celex ${literal} .
  BIND(${literal} AS ?celexNumber)
  ${canonicalAliasPattern(literal)}
  OPTIONAL { ?work cdm:work_has_resource-type ?type . }
  OPTIONAL { ?work cdm:work_date_document ?date . }
  OPTIONAL { ?work cdm:case-law_ecli ?ecli . }
} LIMIT 100`;
}

const DERIVATIVE_TYPES: ReadonlySet<string> = new Set(DERIVATIVE_RESOURCE_TYPES);

/**
 * Pick the CELEX an ECLI resolves to, returning that CELEX's rows. One ECLI can reach
 * several works: works sharing one CELEX, `_RES`/`_SUM` siblings that repeat their
 * parent's ECLI, an `_EXT` extract, or the separate CELEX of a joined AG opinion. Rows
 * matching the caller's exact spelling win over rows reached only through the
 * uppercase form; CELEX numbers carrying a derivative type are then set aside, and the
 * lowest CELEX left wins (#84). A derivative record is chosen only when the ECLI
 * reaches nothing else, so an ECLI CELLAR holds never reads as absent.
 */
function selectEcliCelexRows(bindings: SparqlBinding[], exactEcli: string): SparqlBinding[] {
  const value = (b: SparqlBinding, field: string) => CellarSparqlService.bindingValue(b, field);
  const exact = bindings.filter((b) => value(b, 'ecli') === exactEcli);
  const pool = exact.length > 0 ? exact : bindings;
  const derivativeCelex = new Set(
    pool
      .filter((b) => DERIVATIVE_TYPES.has(value(b, 'type') ?? ''))
      .map((b) => value(b, 'celexNumber')),
  );
  const primary = pool.filter((b) => !derivativeCelex.has(value(b, 'celexNumber')));
  const candidates = primary.length > 0 ? primary : pool;
  const celex = (b: SparqlBinding) => value(b, 'celexNumber') ?? '';
  const [lowest] = candidates.map(celex).sort();
  return candidates.filter((b) => celex(b) === lowest);
}

export const eurlex_lookup_celex = tool('eurlex_lookup_celex', {
  title: 'Resolve EU Legal Citation',
  description:
    'Resolve an EU legal citation — a CELEX number, ELI URI, or ECLI — to its canonical CELLAR work, confirming it exists before you fetch or traverse it. Returns the work URI, confirmed CELEX number, document type, date, and the ECLI of a case that carries one. A CELEX that CELLAR holds under several works resolves to the one the EUR-Lex content resolver serves. An ECLI shared by several records (a judgment and its abstract or extract, or a joined AG opinion) resolves to the primary record with the lowest CELEX.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    identifier: z
      .string()
      .min(1)
      .describe(
        'The EU legal citation to resolve: a CELEX number (e.g. 32016R0679), a work-level ELI URI (e.g. http://data.europa.eu/eli/reg/2016/679, with or without the /oj suffix), or an ECLI (e.g. ECLI:EU:C:2014:317).',
      ),
    identifier_type: z
      .enum(['celex', 'eli', 'ecli', 'auto'])
      .default('auto')
      .describe(
        'Format of the identifier. "auto" detects it automatically (an ECLI by its ECLI: prefix, in any letter case); supply "celex", "eli", or "ecli" explicitly if detection fails.',
      ),
  }),
  output: z.object({
    found: z
      .boolean()
      .describe(
        'True when the identifier resolves to a CELLAR work; false when a well-formed CELEX, ELI, or ECLI matches no work in the corpus. Only an identifier_type "auto" value that, after trimming, is neither an ECLI, an ELI URI, nor CELEX-shaped (uppercase) raises ambiguous_identifier instead.',
      ),
    work_uri: z.string().optional().describe('CELLAR work URI (stable resource identifier).'),
    celex_number: z.string().optional().describe('Confirmed CELEX number for the resolved work.'),
    ecli: z
      .string()
      .optional()
      .describe(
        'European Case Law Identifier of the case (e.g. "ECLI:EU:C:2014:317"), as CELLAR stores it — the resolved work\'s own, or the one another work holding the same CELEX records. Present for case law that carries one; absent for legislation and judicial notices.',
      ),
    resource_type: z
      .string()
      .optional()
      .describe(
        'Human-readable document category resolved from the CDM resource type (e.g. "Regulation", "Directive", "Judgment"). An authority value with no known label falls back to its code (e.g. "BUDGET"). Absent for some works.',
      ),
    date: z.string().optional().describe('Document date in ISO 8601 format (YYYY-MM-DD).'),
  }),

  errors: [
    {
      reason: 'ambiguous_identifier',
      code: JsonRpcErrorCode.ValidationError,
      when: 'identifier_type is "auto" and the identifier, after trimming, is neither an ECLI (ECLI: prefix), an ELI URI, nor CELEX-shaped (uppercase), so no lookup branch applies.',
      recovery:
        'Supply identifier_type explicitly as "celex", "eli", or "ecli" to resolve the ambiguity.',
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
    // typed exact triple on the CELEX literal (#92), resolved to one work by the
    // shared canonical-work rule (#97). No work carrying an ELI carries an ECLI
    // (legislation is cited by ELI, case law by ECLI), so only the CELEX and ECLI
    // branches bind one.
    let binding: SparqlBinding | null;
    if (effectiveType === 'celex') {
      /**
       * An ECLI names the case, not one copy of it: the canonical work can carry none
       * while its `do_not_index` copies do. The query already returns a row per work,
       * each with its own ECLI, so the resolved work's ECLI is kept when it has one
       * and otherwise the lowest ECLI any work of the CELEX records is reported.
       */
      const rows = await svc.query(buildCelexQuery(identifier), ctx);
      const resolved = resolvedWorkRow(rows);
      const [caseEcli] = rows
        .flatMap((b) => b.ecli ?? [])
        .sort((a, b) => (a.value < b.value ? -1 : 1));
      binding = resolved && !resolved.ecli && caseEcli ? { ...resolved, ecli: caseEcli } : resolved;
    } else if (effectiveType === 'ecli') {
      /**
       * Every EU ECLI in CELLAR is uppercase, so a lowercase EU ECLI resolves
       * through its uppercase form. National ECLIs keep mixed case
       * (`ECLI:FI:HelHO:2015:1766`), so the caller's exact spelling is also sent and
       * preferred — both candidates go in one query.
       *
       * #84 picks the CELEX; the canonical-work rule then picks the work within it
       * (#97). When none of that CELEX's ECLI rows is its canonical work — the
       * canonical work can carry no ECLI while its copies do — the CELEX is resolved
       * on its own works, keeping the ECLI the lookup matched.
       */
      const candidates = [...new Set([identifier, identifier.toUpperCase()])];
      const bindings = await svc.query(buildEcliQuery(candidates.map(escapeSparqlLiteral)), ctx);
      const celexRows = selectEcliCelexRows(bindings, identifier);
      const [first] = celexRows;
      if (!first || celexRows.some(isCanonicalRow)) {
        binding = resolvedWorkRow(celexRows);
      } else {
        const celex = CellarSparqlService.bindingValue(first, 'celexNumber') ?? '';
        const resolved = resolvedWorkRow(await svc.query(buildCelexQuery(celex), ctx));
        binding = resolved && { ...resolved, ...(first.ecli ? { ecli: first.ecli } : {}) };
      }
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

    const typeUri = CellarSparqlService.bindingValue(binding, 'type');
    const ecli = CellarSparqlService.bindingValue(binding, 'ecli');
    return {
      found: true,
      work_uri: CellarSparqlService.bindingValue(binding, 'work'),
      celex_number: CellarSparqlService.bindingValue(binding, 'celexNumber'),
      ...(ecli ? { ecli } : {}),
      ...(typeUri ? { resource_type: resolveResourceTypeLabel(typeUri) } : {}),
      date: CellarSparqlService.bindingValue(binding, 'date'),
    };
  },

  format: (result) => {
    const lines: string[] = [`## CELLAR Work Resolved\n**Found:** ${result.found}`];
    if (result.celex_number) lines.push(`**CELEX:** ${result.celex_number}`);
    if (result.ecli) lines.push(`**ECLI:** ${result.ecli}`);
    if (result.work_uri) lines.push(`**Work URI:** ${result.work_uri}`);
    if (result.resource_type) lines.push(`**Type:** ${result.resource_type}`);
    if (result.date) lines.push(`**Date:** ${result.date}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
