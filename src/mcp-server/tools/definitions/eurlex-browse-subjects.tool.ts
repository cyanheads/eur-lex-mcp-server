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

export const eurlex_browse_subjects = tool('eurlex_browse_subjects', {
  title: 'Browse EuroVoc Subjects',
  description:
    'Search the EuroVoc multilingual thesaurus to resolve a human-readable term or keyword into EuroVoc concept IDs. ' +
    'This tool is required before using the eurovoc_concept filter in eurlex_search_documents — ' +
    'agents cannot guess numeric EuroVoc concept IDs. ' +
    'Returns concept URI, preferred label in the requested language, concept code, and broader/narrower hierarchy hints. ' +
    'EuroVoc covers all EU policy domains: agriculture, environment, finance, health, trade, transport, and more. ' +
    'If no results are found in a non-English language, retry with language "en" and a broader English term.',
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
      .default('en')
      .describe('Language code for concept labels (e.g. "en", "fr", "de"). Defaults to English.'),
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
      .describe('Matching EuroVoc concepts ordered by relevance of the label match.'),
    total: z.number().describe('Number of concepts returned in this response.'),
  }),

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
    const limit = input.limit;

    const sparql = `
SELECT ?concept ?label ?code ?broaderLabel WHERE {
  ?concept a skos:Concept .
  ?concept skos:prefLabel ?label .
  OPTIONAL { ?concept skos:notation ?code . }
  OPTIONAL {
    ?concept skos:broader ?broader .
    ?broader skos:prefLabel ?broaderLabel .
    FILTER(LANG(?broaderLabel) = "${lang}")
  }
  FILTER(LANG(?label) = "${lang}")
  FILTER(CONTAINS(LCASE(STR(?label)), "${keyword.replace(/"/g, '\\"')}"))
} LIMIT ${limit}`;

    const bindings = await svc.query(sparql, ctx);
    ctx.log.info('EuroVoc subject browse', {
      keyword,
      language: lang,
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

    return { concepts, total: concepts.length };
  },

  format: (result) => {
    const lines: string[] = [`## EuroVoc Concepts (${result.total} found)\n`];
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
