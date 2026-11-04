/**
 * @fileoverview A `sparql_timeout` recovery extended, at the step it fits, with a
 * next move that depends on the input the call was sent (#177).
 * @module mcp-server/tools/timeout-alternative
 */

import { McpError } from '@cyanheads/mcp-ts-core/errors';

/** A handler context whose definition declares `sparql_timeout`. */
interface TimeoutContract {
  recoveryFor(reason: 'sparql_timeout'): { recovery: { hint: string } };
}

/**
 * `pending`, with `alternative` added after the definition's `sparql_timeout`
 * recovery when `pending` rejects with one. A contract recovery reaches every
 * caller of a tool, so it cannot name an input only some of them can switch to;
 * wrapping only the step that input skips offers it to exactly the callers who
 * reached that step. The rethrown error keeps the original's code, message, and
 * data, and carries it as its cause. Every other failure, and every failure when
 * `alternative` is undefined, passes through as thrown.
 */
export async function withTimeoutAlternative<T>(
  ctx: TimeoutContract,
  alternative: string | undefined,
  pending: Promise<T>,
): Promise<T> {
  if (alternative === undefined) return pending;
  try {
    return await pending;
  } catch (error) {
    if (!(error instanceof McpError) || error.data?.reason !== 'sparql_timeout') throw error;
    const { hint } = ctx.recoveryFor('sparql_timeout').recovery;
    throw new McpError(
      error.code,
      error.message,
      { ...error.data, recovery: { hint: `${hint} ${alternative}` } },
      { cause: error },
    );
  }
}
