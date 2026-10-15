/**
 * @fileoverview Enum inputs that accept the case and separator variants of their
 * members (#143): `PAGED`, `Metadata_Only`, and `metadata-only` each name exactly
 * one member, so they are served as it rather than rejected.
 * @module mcp-server/tools/enum-input
 */

import { z } from '@cyanheads/mcp-ts-core';

/** The comparison key of an enum value: trimmed, lowercased, `-` read as `_`. */
function enumKey(value: string): string {
  return value.trim().toLowerCase().replaceAll('-', '_');
}

/**
 * `schema`, accepting a string that names exactly one of `members` — in any letter
 * case, with surrounding whitespace, with `-` for `_`, or as one of `aliases` — as
 * that canonical member. Any other value reaches `schema` unchanged and gets its
 * own rejection; `""` included, so a field that reads `""` as unset still does.
 *
 * Built on `z.preprocess` so `tools/list` advertises `schema` byte for byte — its
 * enum, default, and description, in its key order. Keep the default inside
 * `schema`: placed outside the preprocess, input-mode JSON Schema drops it. An
 * `.overwrite()` chain would advertise a bare string and lose the enum.
 *
 * The definition linter reads a field's description from the wrapper, so the
 * wrapper reports `schema`'s as its own property. `.describe()` would register it
 * as metadata instead, which JSON Schema emits ahead of `default`.
 */
export function enumInput<const T extends readonly string[], S extends z.ZodType>(
  members: T,
  schema: S,
  aliases: Readonly<Record<string, T[number]>> = {},
) {
  const canonical = new Map<string, string>([
    ...members.map((member) => [enumKey(member), member] as const),
    ...Object.entries(aliases).map(([alias, member]) => [enumKey(alias), member] as const),
  ]);
  const input = z.preprocess(
    (value) => (typeof value === 'string' ? (canonical.get(enumKey(value)) ?? value) : value),
    schema,
  );
  return Object.defineProperty(input, 'description', { value: schema.description });
}
