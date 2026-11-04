/**
 * @fileoverview Tests for withTimeoutAlternative: a `sparql_timeout` recovery
 * extended, at one step, with a next move only that step's callers can take (#177).
 * @module tests/tools/timeout-alternative.test
 */

import {
  JsonRpcErrorCode,
  McpError,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { withTimeoutAlternative } from '@/mcp-server/tools/timeout-alternative.js';

const CONTRACT_HINT = 'Call again shortly: whether the query finishes turns on CELLAR.';
const ALTERNATIVE = 'Passing celex_number in place of eli_uri skips the ELI lookup.';
const BUDGET_SPENT = 'CELLAR SPARQL queries for this request ran past the time budget they share';

const ctx = createMockContext({
  errors: [
    {
      reason: 'sparql_timeout',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'A query ran out of time, or CELLAR refused it as too costly.',
      recovery: CONTRACT_HINT,
    },
  ],
});

/** The rejection of `pending` run through the helper with `alternative`. */
async function rejectionOf(pending: Promise<unknown>, alternative: string | undefined) {
  return withTimeoutAlternative(ctx, alternative, pending).then(
    () => {
      throw new Error('Expected a rejection');
    },
    (error: unknown) => error,
  );
}

describe('withTimeoutAlternative', () => {
  it.each([
    [
      'a retryable time-budget timeout',
      () =>
        serviceUnavailable(
          BUDGET_SPENT,
          { reason: 'sparql_timeout', retryable: true },
          { cause: new DOMException('signal timed out', 'TimeoutError') },
        ),
      true,
    ],
    [
      'a Virtuoso cost refusal, not retryable',
      () =>
        serviceUnavailable('CELLAR SPARQL query timed out on Virtuoso', {
          reason: 'sparql_timeout',
          retryable: false,
        }),
      false,
    ],
  ])('extends the contract recovery for %s', async (_label, thrown, retryable) => {
    const original = thrown();

    const error = await rejectionOf(Promise.reject(original), ALTERNATIVE);

    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: original.message,
      data: {
        reason: 'sparql_timeout',
        retryable,
        recovery: { hint: `${CONTRACT_HINT} ${ALTERNATIVE}` },
      },
    });
    // The service's own throw stays reachable for the log record's cause chain.
    expect((error as Error).cause).toBe(original);
  });

  it('passes every other failure through as it was thrown', async () => {
    const sparqlError = validationError('CELLAR SPARQL error: Virtuoso 37000 Error SQ156', {
      reason: 'sparql_error',
      retryable: false,
    });
    const outage = serviceUnavailable('CELLAR SPARQL HTTP 502', { status: 502 });
    const cancellation = new DOMException('The operation was aborted.', 'AbortError');

    for (const thrown of [sparqlError, outage, cancellation]) {
      expect(await rejectionOf(Promise.reject(thrown), ALTERNATIVE)).toBe(thrown);
    }
  });

  it('leaves a timeout untouched when the step offers no alternative', async () => {
    const timeout = serviceUnavailable(BUDGET_SPENT, { reason: 'sparql_timeout', retryable: true });

    expect(await rejectionOf(Promise.reject(timeout), undefined)).toBe(timeout);
  });

  it('resolves to what the step resolves to', async () => {
    const rows = [{ celexNumber: { type: 'literal', value: '32016R0679' } }];

    await expect(withTimeoutAlternative(ctx, ALTERNATIVE, Promise.resolve(rows))).resolves.toBe(
      rows,
    );
  });
});
