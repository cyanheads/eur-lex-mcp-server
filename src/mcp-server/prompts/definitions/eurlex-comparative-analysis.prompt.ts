/**
 * @fileoverview eurlex_comparative_analysis — Comparative EU ↔ US legal analysis prompt.
 * @module mcp-server/prompts/definitions/eurlex-comparative-analysis
 */

import { prompt, z } from '@cyanheads/mcp-ts-core';

export const eurlex_comparative_analysis = prompt('eurlex_comparative_analysis', {
  description:
    'Frames a comparative legal analysis across EU and US law for a given policy domain. ' +
    'Structures the inquiry to use eurlex_search_documents and eurlex_get_document for the EU side, ' +
    'and courtlistener_search_opinions for the US counterpart. ' +
    'Useful for policy analysts, legal researchers, and practitioners needing a cross-jurisdictional overview.',
  args: z.object({
    domain: z
      .string()
      .min(1)
      .describe(
        'Policy domain for the comparison (e.g. "data privacy", "antitrust", "AI regulation", "food safety").',
      ),
    focus: z
      .string()
      .optional()
      .describe(
        'Optional sub-topic or specific aspect to focus on (e.g. "enforcement mechanisms", "data subject rights", "remedies").',
      ),
  }),

  generate: (args) => {
    const focusLine = args.focus ? ` with emphasis on **${args.focus}**` : '';
    const domain = args.domain;

    return [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `Please provide a comparative legal analysis of **${domain}**${focusLine} across EU and US jurisdictions.

## Research Plan

### EU Side
1. Call **eurlex_browse_subjects** with keyword "${domain}" to identify relevant EuroVoc concept URIs.
2. Call **eurlex_search_documents** filtered by the EuroVoc concept(s) found, document_type REG or DIR, to find key legislative acts.
3. Call **eurlex_get_document** on the most significant act(s) to retrieve full text and metadata.
4. Call **eurlex_get_relations** on key acts to understand the legislative history and amendments.

### US Side
5. Call **courtlistener_search_opinions** with query "${domain}" to find significant US court decisions.
6. Supplement with relevant federal statutes or regulations where applicable.

## Analysis Framework

After gathering sources, structure your analysis around:

1. **Regulatory scope** — What conduct or activity is covered? Who are the regulated entities?
2. **Core obligations** — What must regulated parties do or refrain from?
3. ${args.focus ? `**${args.focus}** — Deep dive into this specific aspect` : '**Key differences** — Where do the EU and US approaches diverge most significantly?'}
4. **Enforcement** — Who enforces the rules and what are the penalties?
5. **Recent developments** — Recent legislation, court decisions, or regulatory guidance.
6. **Practical implications** — For a multinational entity operating in both jurisdictions.

Please cite specific EU acts (with CELEX numbers) and US cases/statutes as you go.`,
        },
      },
    ];
  },
});
