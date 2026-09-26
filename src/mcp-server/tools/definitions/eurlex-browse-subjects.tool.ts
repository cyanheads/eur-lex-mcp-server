/**
 * @fileoverview eurlex_browse_subjects — Search the EuroVoc multilingual thesaurus.
 * @module mcp-server/tools/definitions/eurlex-browse-subjects
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { echoValue } from '@/mcp-server/tools/echo-value.js';
import {
  CellarSparqlService,
  getCellarSparqlService,
} from '@/services/cellar-sparql/cellar-sparql-service.js';
import { escapeSparqlLiteral } from '@/services/cellar-sparql/eli-resolution.js';

/**
 * Namespace of actual EuroVoc concepts. CELLAR's skos:Concept space also holds
 * other Publications Office authority concepts (class-sum-leg, fd_*, …) whose
 * URIs the eurlex_search_documents `eurovoc_concept` filter accepts but cannot
 * match — only `http://eurovoc.europa.eu/` concepts are bound by
 * `cdm:work_is_about_concept_eurovoc`. Results are restricted to this namespace
 * so every URI returned is usable in that filter (#11).
 */
const EUROVOC_CONCEPT_NAMESPACE = 'http://eurovoc.europa.eu/';

export const eurlex_browse_subjects = tool('eurlex_browse_subjects', {
  title: 'Browse EuroVoc Subjects',
  description:
    'Search the EuroVoc thesaurus, resolving a keyword into concept URIs usable in the eurovoc_concept subject filter of eurlex_search_documents. Matches both preferred and alternative (non-preferred) labels, so a common synonym reaches the concept it stands for. Returns each concept URI, its preferred label in the requested language, code, broader (parent) label, and the alternative label that matched when one did. Concepts with an exact label match come first, then those whose label or one of its words starts with the keyword, then other substring matches, each group ordered by preferred label.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  input: z.object({
    keyword: z
      .string()
      .min(1)
      .describe(
        'Search term matched against EuroVoc preferred and alternative concept labels (e.g. "privacy", "agriculture", "product liability").',
      ),
    language: z
      .string()
      .regex(/^[A-Za-z]{2,3}$/)
      .default('en')
      .describe(
        'Language code for concept labels (e.g. "en", "fr", "de"). Case-insensitive — "EN" and "en" behave identically. Defaults to English.',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Pagination offset — number of concepts to skip. Defaults to 0.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(20)
      .describe('Maximum number of EuroVoc concepts to return (1–50). Defaults to 20.'),
  }),
  output: z.object({
    concepts: z
      .array(
        z
          .object({
            concept_uri: z
              .string()
              .describe('Full URI for the EuroVoc concept, usable in the eurovoc_concept filter.'),
            pref_label: z
              .string()
              .describe('Preferred label for the concept in the requested language.'),
            concept_code: z.string().optional().describe('Numeric EuroVoc concept code.'),
            broader_label: z
              .string()
              .optional()
              .describe('Preferred label of the broader (parent) concept, if available.'),
            matched_label: z
              .string()
              .optional()
              .describe(
                'Alternative (non-preferred) EuroVoc label that matched the keyword, when one did — the closest match (exact, then word start, then substring), alphabetical among equals. Absent when the keyword matched the preferred label alone.',
              ),
          })
          .describe('A single EuroVoc concept with its URI, label, code, and hierarchy context.'),
      )
      .describe(
        'Matching EuroVoc concepts, exact label matches first, then word-start matches, then other substring matches, each group ordered by preferred label.',
      ),
    total: z.number().describe('Number of concepts returned in this response.'),
    offset: z.number().describe('Pagination offset used for this response.'),
    has_more: z
      .boolean()
      .describe('True only when CELLAR returned an additional valid row beyond this page.'),
    next_offset: z
      .number()
      .optional()
      .describe('Offset for the next page. Present only when has_more is true.'),
  }),

  enrichment: {
    truncated: z
      .boolean()
      .optional()
      .describe('True when an additional CELLAR row proves more concepts exist beyond this page.'),
    shown: z.number().optional().describe('Number of concepts returned in this response.'),
    cap: z.number().optional().describe('The limit that was applied to this response.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance for the next call: on an empty first page, the keyword and language that matched nothing and how to broaden them; on a page with more rows, the offset to continue from.',
      ),
  },

  async handler(input, ctx) {
    const svc = getCellarSparqlService();
    const pageLimit = Math.min(input.limit, svc.maxResults);
    const keyword = input.keyword.toLowerCase().trim();
    const lang = input.language.toLowerCase().trim() || 'en';

    /**
     * GROUP BY collapses two independent to-many joins that otherwise emit one row
     * per (notation × broader-parent) combination for a single concept: EuroVoc
     * carries multiple skos:notation codes per concept and is polyhierarchical
     * (skos:broader binds many parents — "United States" has nine). Left ungrouped,
     * those duplicate rows consume LIMIT/OFFSET slots, so a page of N surfaced far
     * fewer than N distinct concepts and OFFSET skipped mid-concept — the same
     * to-many-join fix eurlex_get_cases / eurlex_search_documents apply via
     * GROUP BY ?celexNumber. ?label is a grouping key, not a SAMPLE: SKOS permits at
     * most one prefLabel per language (verified live — no EuroVoc concept carries two
     * English prefLabels), so grouping by it stays one row per concept AND lets
     * ORDER BY sort the real label string, which Virtuoso does not do for a SAMPLE
     * alias. The unique concept URI breaks the last tie, so OFFSET pages are stable
     * and non-overlapping.
     *
     * The keyword is matched against alternative labels as well as the preferred
     * one. EuroVoc carries its non-preferred terms — the exact phrases people
     * type — on `skos:altLabel`, so a prefLabel-only match dead-ends on concepts
     * that exist ("product liability" is an English altLabel of concept 3635,
     * prefLabel "producer's liability"). A keyword-filtered OPTIONAL binds
     * `?altValue` only when an alternative label matches, and `|| BOUND(?altValue)`
     * admits the concept on that basis. CELLAR asserts the plain SKOS form directly,
     * so no `skosxl:literalForm` join is needed. `?label` is always the prefLabel,
     * never the matched alternative, so a concept reachable by both paths still
     * returns exactly one row.
     *
     * Matches rank in tiers (#113), computed per concept as the best any of its
     * labels reaches: 1 an exact label, 2 a label that starts with the keyword or
     * has a word that does (the keyword follows a space), 3 any other substring.
     * `ORDER BY ?tier ?label ?concept` runs in CELLAR ahead of LIMIT/OFFSET because
     * the page is cut there — re-sorting a returned page could never lift "AI"
     * (concept 3030, 125th alphabetically) onto page 1. The tier is plain string
     * functions over the already-lowercased labels: a per-row REGEX word test made
     * the "ai" query several times slower. Alternative-label terms sit behind
     * `BOUND(?altValue) &&`, so a concept with no matching alternative never
     * evaluates a function over an unbound variable. `?matchedKey` is the matching
     * alternative label behind its own tier digit, and its MIN is the best-tier
     * one, alphabetical among equals; an empty key means none matched.
     */
    const kw = escapeSparqlLiteral(keyword);
    const pref = 'LCASE(STR(?label))';
    const alt = 'LCASE(STR(?altValue))';
    const startsOrWordStarts = (label: string) =>
      `STRSTARTS(${label}, "${kw}") || CONTAINS(${label}, " ${kw}")`;
    const sparql = `
SELECT ?concept ?label
  (MIN(IF(${pref} = "${kw}" || (BOUND(?altValue) && ${alt} = "${kw}"), 1,
       IF(${startsOrWordStarts(pref)} || (BOUND(?altValue) && (${startsOrWordStarts(alt)})), 2, 3))) AS ?tier)
  (SAMPLE(?codeValue) AS ?code)
  (SAMPLE(?broaderLabelValue) AS ?broaderLabel)
  (MIN(IF(BOUND(?altValue),
       CONCAT(IF(${alt} = "${kw}", "1", IF(${startsOrWordStarts(alt)}, "2", "3")), STR(?altValue)),
       "")) AS ?matchedKey) WHERE {
  ?concept a skos:Concept .
  ?concept skos:prefLabel ?label .
  OPTIONAL { ?concept skos:notation ?codeValue . }
  OPTIONAL {
    ?concept skos:broader ?broader .
    ?broader skos:prefLabel ?broaderLabelValue .
    FILTER(LANG(?broaderLabelValue) = "${lang}")
  }
  OPTIONAL {
    ?concept skos:altLabel ?altValue .
    FILTER(LANG(?altValue) = "${lang}")
    FILTER(CONTAINS(${alt}, "${kw}"))
  }
  FILTER(STRSTARTS(STR(?concept), "${EUROVOC_CONCEPT_NAMESPACE}"))
  FILTER(LANG(?label) = "${lang}")
  FILTER(CONTAINS(${pref}, "${kw}") || BOUND(?altValue))
} GROUP BY ?concept ?label ORDER BY ?tier ?label ?concept LIMIT ${pageLimit + 1} OFFSET ${input.offset}`;

    const bindings = await svc.queryWithContinuation(sparql, ctx);
    ctx.log.info('EuroVoc subject browse', {
      keyword,
      language: lang,
      offset: input.offset,
      resultCount: bindings.length,
    });

    /**
     * Zero hits is an answer, not a failure (#112): an empty first page returns the
     * same shape as a page past the end, plus a notice naming the keyword and how to
     * broaden it, and a retry in English only when the search was in another language.
     * A page past the end stays silent — the caller already has rows.
     */
    if (bindings.length === 0 && input.offset === 0) {
      const broaden =
        lang === 'en'
          ? 'Try a broader or simpler term.'
          : 'Try a broader or simpler term, or retry with language "en" for wider coverage.';
      ctx.enrich.notice(
        `No EuroVoc concepts matched "${echoValue(input.keyword)}" in language "${lang}". ${broaden}`,
      );
    }

    const hasMore = bindings.length > pageLimit;
    const concepts = bindings.slice(0, pageLimit).map((b) => {
      const entry: {
        concept_uri: string;
        pref_label: string;
        concept_code?: string;
        broader_label?: string;
        matched_label?: string;
      } = {
        concept_uri: CellarSparqlService.bindingValue(b, 'concept') ?? '',
        pref_label: CellarSparqlService.bindingValue(b, 'label') ?? '',
      };
      const code = CellarSparqlService.bindingValue(b, 'code');
      if (code) entry.concept_code = code;
      const broaderLabel = CellarSparqlService.bindingValue(b, 'broaderLabel');
      if (broaderLabel) entry.broader_label = broaderLabel;
      const matchedKey = CellarSparqlService.bindingValue(b, 'matchedKey');
      if (matchedKey) entry.matched_label = matchedKey.slice(1);
      return entry;
    });

    if (hasMore) {
      ctx.enrich.truncated({
        shown: concepts.length,
        cap: pageLimit,
        guidance: `More concepts match beyond this page; call again with offset=${input.offset + pageLimit}.`,
      });
    }

    return {
      concepts,
      total: concepts.length,
      offset: input.offset,
      has_more: hasMore,
      ...(hasMore ? { next_offset: input.offset + pageLimit } : {}),
    };
  },

  format: (result) => {
    const lines: string[] = [
      `## EuroVoc Concepts (${result.total} found, offset ${result.offset})\n`,
      `**Has more:** ${result.has_more}`,
    ];
    if (result.next_offset !== undefined) lines.push(`**Next offset:** ${result.next_offset}`);
    lines.push('');
    for (const c of result.concepts) {
      lines.push(`### ${c.pref_label}`);
      lines.push(`**URI:** ${c.concept_uri}`);
      if (c.concept_code) lines.push(`**Code:** ${c.concept_code}`);
      if (c.broader_label) lines.push(`**Broader:** ${c.broader_label}`);
      if (c.matched_label) lines.push(`**Matched via:** ${c.matched_label}`);
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
