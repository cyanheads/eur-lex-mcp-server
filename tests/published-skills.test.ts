/**
 * @fileoverview The published root `skills/` tree, which `createApp({ skills: 'skills' })`
 * serves over MCP and the plugin, npm, MCPB, and Docker channels ship: it passes the
 * MCP SDK's strict skill loader, so every skill in it is served.
 * @module tests/published-skills
 */

import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { validateSkillTree } from '@cyanheads/mcp-ts-core/linter';
import { describe, expect, it } from 'vitest';

const skillsRoot = fileURLToPath(new URL('../skills/', import.meta.url));

/** Entries of a folder, sorted, without dotfiles such as a Finder `.DS_Store`. */
async function entries(path: string): Promise<string[]> {
  return (await readdir(path)).filter((name) => !name.startsWith('.')).sort();
}

describe('published skills', () => {
  it('holds the eur-lex-guide skill and its SPARQL reference', async () => {
    expect(await entries(skillsRoot)).toEqual(['eur-lex-guide']);
    expect(await entries(`${skillsRoot}eur-lex-guide`)).toEqual(['SKILL.md', 'references']);
    expect(await entries(`${skillsRoot}eur-lex-guide/references`)).toEqual(['sparql-cdm.md']);
  });

  it('passes the strict loader the server serves it with', async () => {
    expect(await validateSkillTree(skillsRoot)).toEqual([]);
  });
});
