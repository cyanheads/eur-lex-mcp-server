/**
 * @fileoverview Tests for enumInput — the shared case- and separator-tolerant enum
 * input (#143): the variants it maps, the values it leaves for the enum to reject,
 * and the JSON Schema it advertises.
 * @module tests/tools/enum-input.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import { enumInput } from '@/mcp-server/tools/enum-input.js';
import { bestCpuMs, CPU_TIMED_TEST_TIMEOUT_MS } from '../helpers/cpu-time.js';

const MODES = ['metadata_only', 'paged', 'full'] as const;
const modeSchema = () => z.enum(MODES).default('paged').describe('How much of the body to return.');
const mode = enumInput(MODES, modeSchema(), { metadata: 'metadata_only' });

describe('enumInput', () => {
  it.each([
    ['metadata_only', 'metadata_only'],
    ['METADATA_ONLY', 'metadata_only'],
    ['Metadata_Only', 'metadata_only'],
    ['metadata-only', 'metadata_only'],
    ['  metadata-ONLY  ', 'metadata_only'],
    ['metadata', 'metadata_only'],
    [' METADATA ', 'metadata_only'],
    ['PAGED', 'paged'],
    ['Full', 'full'],
  ])('serves %j as %s', (value, member) => {
    expect(mode.parse(value)).toBe(member);
  });

  it('keeps the default when the field is omitted', () => {
    expect(mode.parse(undefined)).toBe('paged');
  });

  it.each([
    ['meta', 'meta'],
    ['none', 'none'],
    ['text', 'text'],
    ['an empty string', ''],
    ['whitespace', '   '],
    ['a number', 7],
    ['metadata only, spaced', 'metadata only'],
  ])('rejects %s with the enum message', (_label, value) => {
    const result = mode.safeParse(value);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(
      'Invalid option: expected one of "metadata_only"|"paged"|"full"',
    );
  });

  it('passes "" through to a union that reads it as unset', () => {
    const court = enumInput(['CJEU', 'GC'], z.union([z.literal(''), z.enum(['CJEU', 'GC'])]));
    expect(court.parse('')).toBe('');
    expect(court.parse('cjeu')).toBe('CJEU');
    expect(court.parse('Gc')).toBe('GC');
    expect(court.safeParse('ECJ').success).toBe(false);
  });

  it('maps each item of a list on its own', () => {
    const types = z.array(enumInput(['cites', 'amended_by'], z.enum(['cites', 'amended_by'])));
    expect(types.parse(['Cites', 'AMENDED-BY'])).toEqual(['cites', 'amended_by']);
    expect(types.safeParse(['Cites', 'quotes']).success).toBe(false);
  });

  it('advertises the wrapped schema byte for byte in input-mode JSON Schema', () => {
    const wrapped = z.toJSONSchema(z.object({ mode }), { io: 'input' });
    const bare = z.toJSONSchema(z.object({ mode: modeSchema() }), { io: 'input' });
    // Serialized, so key order counts: tools/list carries the bare enum's exact bytes.
    expect(JSON.stringify(wrapped)).toBe(JSON.stringify(bare));
    expect(JSON.stringify((wrapped.properties as Record<string, unknown>).mode)).toBe(
      JSON.stringify({
        default: 'paged',
        description: 'How much of the body to return.',
        type: 'string',
        enum: ['metadata_only', 'paged', 'full'],
      }),
    );
  });

  it('carries the description where the definition linter reads it', () => {
    expect(mode.description).toBe('How much of the body to return.');
  });

  it(
    'maps in linear time over a caller-sized value',
    async () => {
      const time = (n: number) => {
        const value = `${' '.repeat(n)}${'-'.repeat(n)}`;
        return bestCpuMs(() => mode.safeParse(value));
      };
      const small = await time(5_000);
      const large = await time(320_000);
      const timings = `${large.toFixed(3)} ms at 320000, ${small.toFixed(3)} ms at 5000`;
      expect(large / Math.max(small, 0.01), timings).toBeLessThan(256);
      expect(large, timings).toBeLessThan(250);
    },
    CPU_TIMED_TEST_TIMEOUT_MS,
  );
});
