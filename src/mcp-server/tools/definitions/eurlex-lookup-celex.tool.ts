/**
 * @fileoverview eurlex_lookup_celex — Resolve an EU legal citation (CELEX number, ELI URI, ECLI, OJ citation, or Official Journal reference) to a canonical CELLAR work.
 * @module mcp-server/tools/definitions/eurlex-lookup-celex
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { echoValue } from '@/mcp-server/tools/echo-value.js';
import { enumInput } from '@/mcp-server/tools/enum-input.js';
import { renderNoticeBlockquote } from '@/mcp-server/tools/markdown-render.js';
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
  extractCelex,
  isEliUri,
  isPrefixedCaseNumber,
  normalizeCelex,
  normalizeEli,
  resolveEliToWork,
} from '@/services/cellar-sparql/eli-resolution.js';
import {
  type OjReference,
  type OjResolution,
  parseOjReference,
  resolveOjReference,
} from '@/services/cellar-sparql/oj-reference.js';
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

/** The identifier_type members: a forced lookup branch, or auto-detection. */
const IDENTIFIER_TYPES = ['celex', 'eli', 'ecli', 'auto'] as const;

/** The lookup branch an identifier takes. */
type LookupType = Exclude<(typeof IDENTIFIER_TYPES)[number], 'auto'>;

/** Detect an ECLI by its scheme prefix, in any letter case. */
function isEcli(identifier: string): boolean {
  return /^ecli:/i.test(identifier.trim());
}

function detectIdentifierType(identifier: string): LookupType | null {
  if (isEcli(identifier)) return 'ecli';
  if (isCelex(identifier)) return 'celex';
  if (isEliUri(identifier)) return 'eli';
  return null;
}

/**
 * The canonical form of a pasted citation (#147), for the lookup branch it will
 * take: a forced type normalizes as that type; under auto, a wrapped CELEX
 * (`CELEX:` prefix, EUR-Lex URL, `resource/celex` alias) and an ELI in any accepted
 * form are recognized first, and a bare value is uppercased only when it then reads
 * as a CELEX and holds a digit — `CELEX_PATTERN` admits an all-letter word, so
 * `privacy` must stay as given and keep raising ambiguous_identifier.
 */
function normalizeIdentifier(identifier: string, identifierType: LookupType | 'auto'): string {
  switch (identifierType) {
    case 'celex':
      return normalizeCelex(identifier);
    case 'eli':
      return normalizeEli(identifier);
    case 'ecli':
      return identifier;
  }
  const celex = extractCelex(identifier);
  if (celex) return celex;
  const eli = normalizeEli(identifier);
  if (isEliUri(eli)) return eli;
  if (isEcli(identifier)) return identifier;
  const upper = identifier.toUpperCase();
  return /\d/.test(identifier) && isCelex(upper) ? upper : identifier;
}

/**
 * The act-type word of an OJ citation, first occurrence. The two-word forms come
 * first, so "Framework Decision" is never read as a plain Decision.
 */
const CITATION_ACT_TYPE =
  /\b(framework\s+decision|joint\s+action|common\s+position|regulation|directive|decision)\b/i;

/**
 * What follows the act type: an optional `(domain)`, an optional `No` marker, the
 * two numbers, an optional `/domain` suffix, and optionally either the ` of …` that
 * opens the act's full title or the act's parenthesized OJ reference
 * (`Directive 95/46/EC (OJ L 281, 23.11.1995, p. 31)`, #171), whose content is not
 * read: the citation already names one act. Anything else after the numbers — a
 * second citation joined by "and", a stray character — leaves the citation
 * unparsed. The reference's `[^()]*` stops at the first parenthesis and the pattern
 * is anchored, so a reference with no closer fails in one linear pass.
 */
const CITATION_NUMBERS =
  /^\s*(?:\((EU|EC|EEC|Euratom|CFSP|JHA|ECSC)\)\s*)?(No\.?\s*)?(\d{1,4})\/(\d{1,4})(?:\/(EU|EC|EEC|Euratom|CFSP|JHA|ECSC))?(?:\s+of\s.*|\s*\(OJ\s[^()]*\))?$/i;

/** CELEX type letter per act type; an ECSC Decision is `S` instead (see {@link citationCelex}). */
const CITATION_TYPE_LETTER: Record<string, string> = {
  regulation: 'R',
  directive: 'L',
  decision: 'D',
  'framework decision': 'F',
  'joint action': 'E',
  'common position': 'E',
};

/**
 * The CELEX an OJ citation names, or undefined when the identifier is no citation
 * this tool parses (#114). A citation carrying its act type and year maps one-to-one
 * to `3{year}{letter}{number}`, the number zero-padded to four digits:
 *
 * - `No` before the numbers means number/year (`Regulation (EC) No 1049/2001`, the
 *   form used before 2015); without it the order is year/number (`Directive
 *   95/46/EC`, `Regulation (EU) 2016/679`). The marker, not number plausibility,
 *   sets the order: `No 596/2014` and `2015/596` are two different acts.
 * - A two-digit year is 19YY.
 * - The act type sets the letter; the ECSC domain turns a Decision into `S`. An
 *   institution or an Implementing/Delegated qualifier before the act type changes
 *   nothing, so only letters and spaces may precede it.
 *
 * A citation without its act type is not parsed: `95/46/EC` is both Directive
 * 31995L0046 and Commission Decision 31995D0046. Nor is one without a year
 * (`Regulation No 17`).
 */
function citationCelex(identifier: string): string | undefined {
  const actType = CITATION_ACT_TYPE.exec(identifier);
  if (!actType || !/^[\p{L}\s]*$/u.test(identifier.slice(0, actType.index))) return undefined;
  const numbers = CITATION_NUMBERS.exec(identifier.slice(actType.index + actType[0].length));
  if (!numbers) return undefined;
  const [, domainBefore, numberMarker, first = '', second = '', domainAfter] = numbers;
  const [yearText, number] = numberMarker ? [second, first] : [first, second];
  if (yearText.length !== 2 && yearText.length !== 4) return undefined;
  const year = yearText.length === 2 ? `19${yearText}` : yearText;
  const type = actType[1]?.toLowerCase().replace(/\s+/g, ' ') ?? '';
  const ecsc = [domainBefore, domainAfter].some((domain) => domain?.toUpperCase() === 'ECSC');
  const letter = type === 'decision' && ecsc ? 'S' : CITATION_TYPE_LETTER[type];
  return `3${year}${letter}${number.padStart(4, '0')}`;
}

/** The identifier a miss notice names: the CELEX, ELI, or ECLI looked up. */
const IDENTIFIER_LABEL = { celex: 'CELEX', eli: 'ELI', ecli: 'ECLI' } as const;

/** Why an OJ reference matched nothing, for its miss notice. */
function ojMissReason(
  reference: OjReference,
  resolution: Exclude<OjResolution, { kind: 'one' | 'several' }>,
): string {
  const subject = reference.kind === 'act' ? 'act' : 'issue';
  switch (resolution.kind) {
    case 'not_held':
      return reference.kind === 'act'
        ? 'CELLAR holds no act under that number'
        : 'CELLAR holds no such issue';
    case 'other_date':
      return resolution.publishedOn
        ? `that ${subject} was published on ${resolution.publishedOn}, not on the date cited`
        : `no ${subject} it can name was published on the date cited`;
    case 'no_act_on_page':
      return 'no act with a CELEX starts on that page of the issue';
  }
}

/**
 * The notice of an OJ reference that names no single act (#170): the CELEX of each
 * act starting on the cited page, or why nothing matched — no such issue or act, a
 * cited date that is not its publication date, or no act starting on that page.
 */
function ojReferenceNotice(
  citation: string,
  reference: OjReference,
  resolution: Exclude<OjResolution, { kind: 'one' }>,
): string {
  const quoted = `"${echoValue(citation)}"`;
  if (resolution.kind === 'several') {
    return `OJ reference ${quoted} names the first page of ${resolution.celex.length} acts: ${resolution.celex.join(', ')}. Pass the CELEX of the one you want here or to eurlex_get_document.`;
  }
  return `No CELLAR work matches OJ reference ${quoted}: ${ojMissReason(reference, resolution)}. An OJ reference resolves when it names the issue, its publication date, and the first page of an act (e.g. "OJ L 119, 4.5.2016, p. 1"), or an act-by-act number (e.g. "OJ L, 2024/1689, 12.7.2024"). To find the act by title words, use eurlex_search_documents with keyword.`;
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
    'Resolve an EU legal citation — a CELEX number, ELI URI, ECLI, an OJ citation naming its act type and year (e.g. "Regulation (EU) 2016/679", "Directive 95/46/EC"), or an Official Journal reference naming its issue, date, and first page (e.g. "OJ L 119, 4.5.2016, p. 1") — to its canonical CELLAR work, confirming it exists before you fetch or traverse it. Returns the work URI, confirmed CELEX number, document type, date, and the ECLI of a case that carries one. A CELEX that CELLAR holds under several works resolves to the one the EUR-Lex content resolver serves. An ECLI shared by several records (a judgment and its abstract or extract, or a joined AG opinion) resolves to the primary record with the lowest CELEX. An OJ reference whose first page starts several acts returns found false, its notice naming each CELEX.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    identifier: z
      .string()
      .min(1)
      .describe(
        'The EU legal citation to resolve: a CELEX number (e.g. 32016R0679), a work-level ELI URI (e.g. http://data.europa.eu/eli/reg/2016/679, with or without the /oj suffix), an ECLI (e.g. ECLI:EU:C:2014:317), or an OJ citation that names its act type and year, resolved to the CELEX it names under identifier_type "auto": Regulation (EU) 2016/679, Regulation (EC) No 1049/2001, Directive 95/46/EC, Decision No 1313/2013/EU, Council Framework Decision 2002/584/JHA, Council Joint Action 2008/124/CFSP, Common Position 2003/444/CFSP. "No" before the numbers means number/year, otherwise year/number; a two-digit year is 19YY. A citation without its act type (95/46/EC) or year (Regulation No 17) is not parsed; one followed by its parenthesized OJ reference (Directive 95/46/EC (OJ L 281, 23.11.1995, p. 31)) resolves as the citation. An Official Journal reference resolves, also under "auto", to the act starting on the page it cites: OJ L 281, 23.11.1995, p. 31 (also "of 23.11.1995", a page range, a class letter as in OJ L 42I, OJ C, and before 1968 the series-less OJ 13, 21.2.1962, p. 204/62), the year-first OJ 1995 L 281, p. 31, and the act-by-act OJ L, 2024/1689, 12.7.2024 or OJ C, C/2024/2664, 29.4.2024; the cited date must be the publication date. A reference without its year or first page (OJ L 281, OJ L 119/1) is not parsed. A CELEX is also read in lowercase, after a CELEX: prefix, from a EUR-Lex page URL carrying uri=CELEX:… (e.g. https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32016R0679), or from a publications.europa.eu/resource/celex/ URI; an ELI over https, on the eur-lex.europa.eu host, without a scheme, with a trailing slash, or with a language segment after /oj or a date (…/oj/eng). A case number (C-131/12) names several records rather than one work and returns found false with a pointer to eurlex_get_cases.',
      ),
    identifier_type: enumInput(
      IDENTIFIER_TYPES,
      z
        .enum(IDENTIFIER_TYPES)
        .default('auto')
        .describe(
          'Format of the identifier. "auto" detects a CELEX, an ELI URI, an ECLI (by its ECLI: prefix, in any letter case), an OJ citation, or an Official Journal reference; "celex", "eli", or "ecli" forces that lookup. An OJ citation or reference is recognized only under "auto".',
        ),
    ),
  }),
  output: z.object({
    found: z
      .boolean()
      .describe(
        'True when the identifier resolves to a CELLAR work; false when a well-formed CELEX, ELI, ECLI, OJ citation, or Official Journal reference matches no work in the corpus, when an OJ reference\'s first page starts several acts, or when the identifier is a case number, with a notice naming what was tried. Only an identifier_type "auto" value that, after trimming, is neither an ECLI, an ELI, a CELEX in any accepted form, an OJ citation naming its act type and year, nor an OJ reference naming its issue, year, and first page raises ambiguous_identifier instead.',
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

  // A miss is a result, not an error: found false plus a notice on both surfaces.
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Present only when found is false: the CELEX, ELI, ECLI, or OJ reference looked up, the accepted forms, and the search to use instead; for an OJ reference whose first page starts several acts, the CELEX of each.',
      ),
  },
  enrichmentTrailer: { notice: { render: (notice) => renderNoticeBlockquote(String(notice)) } },

  errors: [
    {
      reason: 'ambiguous_identifier',
      code: JsonRpcErrorCode.ValidationError,
      when: 'identifier_type is "auto" and the identifier, after trimming, is neither an ECLI (ECLI: prefix), an ELI, a CELEX (bare, after a CELEX: prefix, or in a EUR-Lex URL), a prefixed case number, an OJ citation naming its act type and year (e.g. "Regulation No 17" names no year), nor an Official Journal reference naming its issue, year, and first page (e.g. "OJ L 281" names neither), so no lookup branch applies.',
      recovery:
        'Pass a CELEX (32016R0679), an ELI URI (http://data.europa.eu/eli/reg/2016/679), an ECLI (ECLI:EU:C:2014:317), an OJ citation with its act type and year ("Regulation (EU) 2016/679", "Directive 95/46/EC"), or an OJ reference with its issue, date, and first page ("OJ L 119, 4.5.2016, p. 1"); to find an act by title words, use eurlex_search_documents with keyword.',
    },
    {
      reason: 'sparql_error',
      code: JsonRpcErrorCode.ValidationError,
      when: 'CELLAR rejected the lookup query this call sent. The same call fails the same way again.',
      recovery:
        'Pass the identifier in another of its forms (its bare CELEX in place of an ELI, ECLI, or OJ citation), or set identifier_type to the form it is.',
      thrownBy: 'service',
    },
    {
      reason: 'sparql_timeout',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The lookup query ran past the client timeout, or CELLAR refused it as too costly to run. It is not retried.',
      recovery:
        'Look the identifier up again shortly, or pass its bare CELEX with identifier_type "celex" for a single exact match.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const svc = getCellarSparqlService();
    const citation = input.identifier.trim();

    // A prefixed case number is never a CELEX and names several records (the
    // judgment, the AG opinion, orders), so no single work answers it (#147).
    if (isPrefixedCaseNumber(citation)) {
      ctx.enrich.notice(
        `"${echoValue(citation)}" is a case number, which names every record filed under the case (the judgment, the Advocate General's opinion, orders) rather than one work. List them with eurlex_get_cases case_number, then pass the CELEX of the record you want here or to eurlex_get_document.`,
      );
      return { found: false };
    }

    let identifier = normalizeIdentifier(citation, input.identifier_type);
    let effectiveType: LookupType;

    if (input.identifier_type === 'auto') {
      const detected = detectIdentifierType(identifier);
      // An OJ citation resolves through the CELEX branch, under the CELEX it names.
      const citedCelex = detected ? undefined : citationCelex(identifier);
      // An OJ reference is tried last: every pattern opens on `OJ `, which no other form starts with.
      const ojReference = detected || citedCelex ? undefined : parseOjReference(identifier);
      if (detected) {
        effectiveType = detected;
      } else if (citedCelex) {
        effectiveType = 'celex';
        identifier = citedCelex;
      } else if (ojReference) {
        /**
         * One act on the cited page resolves through the CELEX branch, so the output
         * is that CELEX lookup's; several, or none, is a result naming what CELLAR
         * holds (#170).
         */
        const resolution = await resolveOjReference(svc, ojReference, ctx);
        if (resolution.kind !== 'one') {
          ctx.log.info('OJ reference lookup', { citation, resolution: resolution.kind });
          ctx.enrich.notice(ojReferenceNotice(citation, ojReference, resolution));
          return { found: false };
        }
        effectiveType = 'celex';
        identifier = resolution.celex;
      } else {
        throw ctx.fail(
          'ambiguous_identifier',
          `Cannot determine format of identifier: ${echoValue(identifier)}`,
        );
      }
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
      ...(identifier === citation ? {} : { citation }),
      type: effectiveType,
      found: binding !== null,
    });

    if (!binding) {
      /**
       * A well-formed identifier that resolves to no work is a clean negative, not an
       * error — the documented "validate before fetch" role depends on a boolean here.
       * Malformed/undetectable input already errored above with ambiguous_identifier.
       * The notice names what was tried and where to go next (#114).
       */
      const tried = `${IDENTIFIER_LABEL[effectiveType]} ${echoValue(identifier)}`;
      const parsedFrom = identifier === citation ? '' : ` (parsed from "${echoValue(citation)}")`;
      ctx.enrich.notice(
        `No CELLAR work matches ${tried}${parsedFrom}. A CELEX reads {sector}{year}{type}{number} (e.g. 32016R0679); an OJ citation resolves when it names its act type and year (e.g. "Regulation (EU) 2016/679"). To find the act by title words or a partial CELEX, use eurlex_search_documents with keyword.`,
      );
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

  // Every value is CELLAR's, escaped so a CommonMark parse reads it back as written.
  format: (result) => {
    const lines: string[] = [`## CELLAR Work Resolved\n**Found:** ${result.found}`];
    const field = (label: string, value: string | undefined) => {
      if (value) lines.push(`**${label}:** ${escapeMarkdownInline(value)}`);
    };
    field('CELEX', result.celex_number);
    field('ECLI', result.ecli);
    field('Work URI', result.work_uri);
    field('Type', result.resource_type);
    field('Date', result.date);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
