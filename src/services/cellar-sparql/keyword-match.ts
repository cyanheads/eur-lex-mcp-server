/**
 * @fileoverview The keyword graph pattern shared by eurlex_search_documents and
 * eurlex_get_cases: an English-title arm on the Virtuoso full-text index, plus a
 * CELEX arm chosen from the keyword's shape.
 * @module services/cellar-sparql/keyword-match
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { ENG_LANGUAGE_URI } from './cdm-labels.js';
import { CellarSparqlService } from './cellar-sparql-service.js';
import { CELEX_PATTERN, celexLiteral, escapeSparqlLiteral } from './eli-resolution.js';

/** Every character a CELEX holds — the charset of {@link CELEX_PATTERN}. */
const CELEX_CHARSET = /^[0-9A-Z()/_-]+$/;

/**
 * Highest sibling ordinal a whole-CELEX keyword reaches, for both the numbered
 * `(nn)` form and the corrigendum `R(nn)` form. A live survey of every sector-3 and
 * sector-6 CELEX (2026-09-25) found sector-6 `(nn)` up to `(20)` and `R(nn)` at
 * `R(01)` only; sector 3 runs `R(nn)` to `R(30)` and `(nn)` to `(61)`, with under
 * 1% of its corrigenda and 8% of its numbered siblings past 20.
 */
const MAX_SIBLING_ORDINAL = 20;

/**
 * Case-law suffixes CELLAR files beside a record and beside each numbered sibling:
 * judicial information notice, abstract, summary, and extract. The first three are
 * derivative types eurlex_get_cases admits only under include_derivative; an `_EXT`
 * extract is a primary record.
 */
const RECORD_SUFFIXES = ['_INF', '_RES', '_SUM', '_EXT'] as const;

/**
 * The keyword reduced to letters, digits, and single spaces: the phrase the title
 * arm quotes for `bif:contains`, which it cannot break out of. Empty when the
 * keyword holds no letter or digit — then no title matches it, and no CELEX either,
 * since every CELEX holds a four-digit year — so callers reject such a keyword
 * before building a query.
 */
export function keywordTitlePhrase(keyword: string): string {
  return keyword
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The graph pattern binding `?work` to the works a keyword matches. The keyword
 * must hold a letter or digit ({@link keywordTitlePhrase} non-empty).
 *
 * The title arm drives the match off the `bif:contains` full-text index (issue #17).
 * The CELEX arm depends on the uppercased keyword, since CELLAR stores CELEX in
 * upper case (#105):
 *
 * - **None** when the keyword has no digit or a character outside `[0-9A-Z()/_-]`.
 *   Every CELEX opens with a sector character and a four-digit year, so a digit-free
 *   keyword could only hit type letters or suffixes (`R`, `PC`) across the whole
 *   corpus, and a keyword with any other character is in no CELEX at all.
 * - **Exact** when some work carries the keyword as its whole CELEX: the typed
 *   literals of that CELEX and of each sibling in {@link celexFamily} some work
 *   carries, each an index lookup, plus the corrigenda that
 *   `cdm:resource_legal_corrects_resource_legal` links to the CELEX. Whether the
 *   keyword is whole is CELLAR's answer, not the pattern's: `02016R0679` and
 *   `72014L0056` are CELEX-shaped prefixes of real values that no work carries.
 * - **Substring** otherwise, unchanged: a scan of every CELEX literal, so a partial
 *   CELEX (`2016R0679`) still reaches its consolidated versions.
 *
 * The family lookup is the one CELLAR call made here; it propagates any failure,
 * cancellation included, rather than falling back to the substring scan.
 */
export async function keywordMatchPattern(
  svc: Pick<CellarSparqlService, 'query'>,
  keyword: string,
  ctx: Context,
): Promise<string> {
  const titleArm = `{
    ?kwExpr cdm:expression_title ?kwTitle .
    ?kwTitle bif:contains "'${keywordTitlePhrase(keyword)}'" .
    ?kwExpr cdm:expression_uses_language <${ENG_LANGUAGE_URI}> .
    ?kwExpr cdm:expression_belongs_to_work ?work .
  }`;
  const celexArm = await celexKeywordArm(svc, keyword, ctx);
  return celexArm ? `${titleArm} UNION {\n    ${celexArm}\n  }` : titleArm;
}

/**
 * A CELEX followed by the siblings CELLAR files under longer CELEX that begin with
 * it: numbered `(01)`–`(20)`, corrigenda `R(01)`–`R(20)`, and the `_INF`, `_RES`,
 * `_SUM`, and `_EXT` records of the CELEX and of each numbered sibling. Before #105
 * a whole-CELEX keyword reached these through the substring scan; the bounded list
 * reaches them by index lookups instead — `62023CO0097` its `(01)` and `(02)`
 * orders, `32016R0679` its `R(01)`–`R(03)`. Longer forms (`(21)`, `R(21)`, a
 * corrigendum of a numbered sibling) are left out.
 */
function celexFamily(celex: string): string[] {
  const ordinals = Array.from(
    { length: MAX_SIBLING_ORDINAL },
    (_, i) => `(${String(i + 1).padStart(2, '0')})`,
  );
  return [
    celex,
    ...ordinals.map((ordinal) => `${celex}${ordinal}`),
    ...ordinals.map((ordinal) => `${celex}R${ordinal}`),
    ...['', ...ordinals].flatMap((ordinal) =>
      RECORD_SUFFIXES.map((suffix) => `${celex}${ordinal}${suffix}`),
    ),
  ];
}

async function celexKeywordArm(
  svc: Pick<CellarSparqlService, 'query'>,
  keyword: string,
  ctx: Context,
): Promise<string> {
  const upper = keyword.toUpperCase();
  if (!/\d/.test(upper) || !CELEX_CHARSET.test(upper)) return '';

  if (CELEX_PATTERN.test(upper)) {
    const carried = await svc.query(
      `SELECT DISTINCT ?kwCelex WHERE {
  VALUES ?kwCelex { ${celexFamily(upper).map(celexLiteral).join(' ')} }
  ?kwWork cdm:resource_legal_id_celex ?kwCelex .
}`,
      ctx,
    );
    const carriedCelex = carried.flatMap(
      (b) => CellarSparqlService.bindingValue(b, 'kwCelex') ?? [],
    );
    if (carriedCelex.includes(upper)) {
      return `{ VALUES ?kwCelex { ${carriedCelex.map(celexLiteral).join(' ')} }
      ?work cdm:resource_legal_id_celex ?kwCelex . }
    UNION
    { ?kwBase cdm:resource_legal_id_celex ${celexLiteral(upper)} .
      ?work cdm:resource_legal_corrects_resource_legal ?kwBase . }`;
    }
  }

  return `?work cdm:resource_legal_id_celex ?kwCelex .
    FILTER(CONTAINS(LCASE(STR(?kwCelex)), "${escapeSparqlLiteral(keyword.toLowerCase())}"))`;
}
