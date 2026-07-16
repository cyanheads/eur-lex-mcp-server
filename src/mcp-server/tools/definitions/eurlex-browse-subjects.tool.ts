/**
 * @fileoverview eurlex_browse_subjects — Search the EuroVoc multilingual thesaurus.
 * @module mcp-server/tools/definitions/eurlex-browse-subjects
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
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
    'Search the EuroVoc thesaurus, resolving a keyword into concept URIs usable in the eurovoc_concept subject filter of eurlex_search_documents. Returns each concept URI, its preferred label in the requested language, code, and broader (parent) label, ordered alphabetically by label.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  input: z.object({
    keyword: z
      .string()
      .min(1)
      .describe(
        'Search term to match against EuroVoc concept labels (e.g. "privacy", "agriculture", "trade").',
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
          })
          .describe('A single EuroVoc concept with its URI, label, code, and hierarchy context.'),
      )
      .describe('Matching EuroVoc concepts ordered alphabetically by label.'),
    total: z.number().describe('Number of concepts returned in this response.'),
    offset: z.number().describe('Pagination offset used for this response.'),
  }),

  enrichment: {
    truncated: z
      .boolean()
      .optional()
      .describe('True when the returned list was capped at the limit and more concepts may exist.'),
    shown: z.number().optional().describe('Number of concepts returned in this response.'),
    cap: z.number().optional().describe('The limit that was applied to this response.'),
  },

  errors: [
    {
      reason: 'no_concepts',
      code: JsonRpcErrorCode.NotFound,
      when: 'No EuroVoc concepts matched the keyword in the requested language.',
      recovery: 'Try a broader or simpler term, or retry with language "en" for wider coverage.',
    },
  ],

  async handler(input, ctx) {
    const svc = getCellarSparqlService();
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
     * alias. ORDER BY ?label ?concept is a deterministic alphabetical order (the
     * unique concept URI breaks ties) so OFFSET pages are stable and non-overlapping;
     * no relevance signal is computed.
     */
    const sparql = `
SELECT ?concept ?label
  (SAMPLE(?codeValue) AS ?code)
  (SAMPLE(?broaderLabelValue) AS ?broaderLabel) WHERE {
  ?concept a skos:Concept .
  ?concept skos:prefLabel ?label .
  OPTIONAL { ?concept skos:notation ?codeValue . }
  OPTIONAL {
    ?concept skos:broader ?broader .
    ?broader skos:prefLabel ?broaderLabelValue .
    FILTER(LANG(?broaderLabelValue) = "${lang}")
  }
  FILTER(STRSTARTS(STR(?concept), "${EUROVOC_CONCEPT_NAMESPACE}"))
  FILTER(LANG(?label) = "${lang}")
  FILTER(CONTAINS(LCASE(STR(?label)), "${escapeSparqlLiteral(keyword)}"))
} GROUP BY ?concept ?label ORDER BY ?label ?concept LIMIT ${input.limit} OFFSET ${input.offset}`;

    const bindings = await svc.query(sparql, ctx);
    ctx.log.info('EuroVoc subject browse', {
      keyword,
      language: lang,
      offset: input.offset,
      resultCount: bindings.length,
    });

    if (bindings.length === 0) {
      throw ctx.fail(
        'no_concepts',
        `No EuroVoc concepts found for "${input.keyword}" in language "${lang}"`,
        {
          ...ctx.recoveryFor('no_concepts'),
        },
      );
    }

    const concepts = bindings.map((b) => {
      const entry: {
        concept_uri: string;
        pref_label: string;
        concept_code?: string;
        broader_label?: string;
      } = {
        concept_uri: CellarSparqlService.bindingValue(b, 'concept') ?? '',
        pref_label: CellarSparqlService.bindingValue(b, 'label') ?? '',
      };
      const code = CellarSparqlService.bindingValue(b, 'code');
      if (code) entry.concept_code = code;
      const broaderLabel = CellarSparqlService.bindingValue(b, 'broaderLabel');
      if (broaderLabel) entry.broader_label = broaderLabel;
      return entry;
    });

    // A full page means the limit capped the list — page forward with offset for more.
    if (concepts.length >= input.limit) {
      ctx.enrich.truncated({ shown: concepts.length, cap: input.limit });
    }

    return { concepts, total: concepts.length, offset: input.offset };
  },

  format: (result) => {
    const lines: string[] = [
      `## EuroVoc Concepts (${result.total} found, offset ${result.offset})\n`,
    ];
    for (const c of result.concepts) {
      lines.push(`### ${c.pref_label}`);
      lines.push(`**URI:** ${c.concept_uri}`);
      if (c.concept_code) lines.push(`**Code:** ${c.concept_code}`);
      if (c.broader_label) lines.push(`**Broader:** ${c.broader_label}`);
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
