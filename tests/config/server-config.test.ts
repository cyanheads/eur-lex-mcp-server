/**
 * @fileoverview Startup validation of the server's environment config: a value
 * the timeout consumer cannot honor stops startup instead of failing every call.
 * @module tests/config/server-config
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

/** A fresh module instance, so the lazily cached config is parsed again. */
async function loadConfig() {
  vi.resetModules();
  const { getServerConfig } = await import('@/config/server-config.js');
  return getServerConfig();
}

describe('server config', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ['unset, as the 55000 default', '', 55_000],
    ['2147483647, the largest timer value', '2147483647', 2_147_483_647],
  ])('reads SPARQL_QUERY_TIMEOUT_MS %s', async (_label, value, expected) => {
    vi.stubEnv('SPARQL_QUERY_TIMEOUT_MS', value);
    expect((await loadConfig()).sparqlQueryTimeoutMs).toBe(expected);
  });

  it.each([
    ['zero', '0'],
    ['a negative', '-5'],
    ['a fraction', '25.5'],
    ['one past the timer range', '2147483648'],
  ])(
    'rejects %s SPARQL_QUERY_TIMEOUT_MS at startup, naming the variable',
    async (_label, value) => {
      vi.stubEnv('SPARQL_QUERY_TIMEOUT_MS', value);
      await expect(loadConfig()).rejects.toThrow(/SPARQL_QUERY_TIMEOUT_MS/);
    },
  );
});
