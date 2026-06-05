/**
 * @fileoverview Tests for eurlex_comparative_analysis prompt.
 * @module tests/prompts/eurlex-comparative-analysis.prompt.test
 */

import { describe, expect, it } from 'vitest';
import { eurlex_comparative_analysis } from '@/mcp-server/prompts/definitions/eurlex-comparative-analysis.prompt.js';

describe('eurlex_comparative_analysis', () => {
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
