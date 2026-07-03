/**
 * @fileoverview eurlex_comparative_analysis — Comparative EU ↔ US legal analysis prompt.
 * @module mcp-server/prompts/definitions/eurlex-comparative-analysis
 */

import { prompt, z } from '@cyanheads/mcp-ts-core';

/** Identifier for each fixed axis of the analysis framework. */
type AxisKey =
  | 'regulatory_scope'
  | 'core_obligations'
  | 'key_differences'
  | 'enforcement'
  | 'recent_developments'
  | 'practical_implications';

/**
 * The fixed analysis axes, rendered in order. `key_differences` doubles as the
 * swing slot that carries a non-overlapping focus as its own section.
 */
const ANALYSIS_AXES: ReadonlyArray<{ key: AxisKey; title: string; question: string }> = [
  {
    key: 'regulatory_scope',
    title: 'Regulatory scope',
    question: 'What conduct or activity is covered? Who are the regulated entities?',
  },
  {
    key: 'core_obligations',
    title: 'Core obligations',
    question: 'What must regulated parties do or refrain from?',
  },
  {
    key: 'key_differences',
    title: 'Key differences',
    question: 'Where do the EU and US approaches diverge most significantly?',
  },
  {
    key: 'enforcement',
    title: 'Enforcement',
    question: 'Who enforces the rules and what are the penalties?',
  },
  {
    key: 'recent_developments',
    title: 'Recent developments',
    question: 'Recent legislation, court decisions, or regulatory guidance.',
  },
  {
    key: 'practical_implications',
    title: 'Practical implications',
    question: 'For a multinational entity operating in both jurisdictions.',
  },
];

/**
 * Map an optional focus to the fixed axis it overlaps, or null when it raises a
 * genuinely new angle. Overlapping focuses (enforcement, penalties, remedies,
 * recent developments, …) fold into their axis so the framework never renders
 * two near-duplicate sections — one for the focus and one for the axis it
 * restates (issue #37). A focus matching nothing takes the swing slot as its
 * own dedicated section.
 */
function matchFocusToAxis(focus: string): AxisKey | null {
  const f = focus.toLowerCase();
  const rules: ReadonlyArray<readonly [AxisKey, RegExp]> = [
    ['enforcement', /enforce|penalt|sanction|remed|liabilit|prosecut/],
    ['recent_developments', /recent|latest|newest|\bdevelopment/],
    ['key_differences', /difference|diverg|contrast|\bcompar|distinct/],
    ['regulatory_scope', /\bscope|coverage|applicab|regulated entit|who is (?:covered|regulated)/],
    ['core_obligations', /obligation|\bduty|\bduties|requirement|complian/],
    ['practical_implications', /practical|implication|operational/],
  ];
  for (const [key, pattern] of rules) {
    if (pattern.test(f)) return key;
  }
  return null;
}

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
    const domain = args.domain;
    const focus = args.focus?.trim();
    const focusLine = focus ? ` with emphasis on **${focus}**` : '';

    // Route an overlapping focus into its existing axis rather than appending a
    // duplicate section; a non-overlapping focus takes the "Key differences"
    // swing slot as its own dedicated section (issue #37).
    const matchedAxis = focus ? matchFocusToAxis(focus) : null;
    const emphasizedFocus = focus ? focus.charAt(0).toUpperCase() + focus.slice(1) : '';

    const framework = ANALYSIS_AXES.map((axis, i) => {
      const n = i + 1;
      if (focus && matchedAxis === axis.key) {
        // Overlapping focus — this axis carries it, titled by the focus itself.
        return `${n}. **${emphasizedFocus}** — ${axis.question}`;
      }
      if (axis.key === 'key_differences' && focus && !matchedAxis) {
        // Non-overlapping focus — its own dedicated section in the swing slot.
        return `${n}. **${emphasizedFocus}** — Deep dive into this specific aspect.`;
      }
      return `${n}. **${axis.title}** — ${axis.question}`;
    }).join('\n');

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

${framework}

Please cite specific EU acts (with CELEX numbers) and US cases/statutes as you go.`,
        },
      },
    ];
  },
});
