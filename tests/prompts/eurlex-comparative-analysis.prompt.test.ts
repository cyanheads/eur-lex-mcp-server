/**
 * @fileoverview Tests for eurlex_comparative_analysis prompt.
 * @module tests/prompts/eurlex-comparative-analysis.prompt.test
 */

import { describe, expect, it } from 'vitest';
import { eurlex_comparative_analysis } from '@/mcp-server/prompts/definitions/eurlex-comparative-analysis.prompt.js';

describe('eurlex_comparative_analysis', () => {
  type GenArgs = Parameters<typeof eurlex_comparative_analysis.generate>[0];
  const renderText = (args: GenArgs) => {
    const messages = eurlex_comparative_analysis.generate(args);
    return (messages[0]!.content as { type: string; text: string }).text;
  };
  // Numbered analysis-framework headers whose bold title mentions enforcement.
  const enforcementSections = (text: string) =>
    text.match(/^\d+\.\s+\*\*[^*]*[Ee]nforcement[^*]*\*\*/gm) ?? [];

  // --- Happy path: required args only ---

  it('generates a valid user message for a domain with no focus', () => {
    const args = eurlex_comparative_analysis.args!.parse({ domain: 'data privacy' });
    const messages = eurlex_comparative_analysis.generate(args);

    expect(messages).toBeInstanceOf(Array);
    expect(messages.length).toBeGreaterThan(0);

    const msg = messages[0]!;
    expect(msg.role).toBe('user');
    expect(msg.content.type).toBe('text');

    const text = (msg.content as { type: string; text: string }).text;
    expect(text).toContain('data privacy');
    // Tool references for EU side
    expect(text).toContain('eurlex_browse_subjects');
    expect(text).toContain('eurlex_search_documents');
    expect(text).toContain('eurlex_get_document');
    expect(text).toContain('eurlex_get_relations');
    // US side
    expect(text).toContain('courtlistener_search_opinions');
  });

  it('incorporates focus into the generated prompt when provided', () => {
    const args = eurlex_comparative_analysis.args!.parse({
      domain: 'antitrust',
      focus: 'enforcement mechanisms',
    });
    const messages = eurlex_comparative_analysis.generate(args);
    const text = (messages[0]!.content as { type: string; text: string }).text;

    expect(text).toContain('antitrust');
    expect(text).toContain('enforcement mechanisms');
  });

  // --- #37: focus normalization — an overlapping focus never spawns a second section ---

  it('merges an overlapping focus into its axis without a duplicate section', () => {
    const text = renderText(
      eurlex_comparative_analysis.args!.parse({
        domain: 'data privacy',
        focus: 'enforcement mechanisms',
      }),
    );

    // The Enforcement axis now carries the focus in its title...
    expect(text).toContain('**Enforcement mechanisms** — Who enforces the rules');
    // ...the swing slot reverts to the generic differences section...
    expect(text).toContain('**Key differences**');
    // ...and no separate "deep dive" focus section is appended.
    expect(text).not.toContain('Deep dive into this specific aspect');
    // Exactly one numbered section is enforcement-flavored (the merged axis).
    expect(enforcementSections(text)).toHaveLength(1);
  });

  it('adds a dedicated section for a focus that overlaps no axis', () => {
    const text = renderText(
      eurlex_comparative_analysis.args!.parse({
        domain: 'data privacy',
        focus: 'cross-border data transfers',
      }),
    );

    // The focus takes the swing slot as its own dedicated section...
    expect(text).toContain(
      '**Cross-border data transfers** — Deep dive into this specific aspect.',
    );
    // ...and the fixed axes stay generic (no focus bleed into Enforcement).
    expect(text).toContain('**Enforcement** — Who enforces the rules');
    expect(enforcementSections(text)).toHaveLength(1);
  });

  it.each([
    'enforcement',
    'penalties',
    'remedies',
    'recent developments',
  ])('folds overlapping focus "%s" into an existing axis rather than duplicating', (focus) => {
    const text = renderText(
      eurlex_comparative_analysis.args!.parse({ domain: 'data privacy', focus }),
    );
    // Overlapping focus keeps the generic swing-slot section and adds no deep dive.
    expect(text).toContain('**Key differences**');
    expect(text).not.toContain('Deep dive into this specific aspect');
  });

  it('uses generic "Key differences" section when focus is omitted', () => {
    const args = eurlex_comparative_analysis.args!.parse({ domain: 'AI regulation' });
    const messages = eurlex_comparative_analysis.generate(args);
    const text = (messages[0]!.content as { type: string; text: string }).text;

    expect(text).toContain('Key differences');
    // Focus placeholder should NOT appear
    expect(text).not.toContain('undefined');
  });

  it('message structure conforms to MCP message shape', () => {
    const args = eurlex_comparative_analysis.args!.parse({ domain: 'food safety' });
    const messages = eurlex_comparative_analysis.generate(args);

    for (const msg of messages) {
      expect(msg).toHaveProperty('role');
      expect(msg).toHaveProperty('content');
      expect(['user', 'assistant']).toContain(msg.role);
      expect(msg.content).toHaveProperty('type');
    }
  });
});
