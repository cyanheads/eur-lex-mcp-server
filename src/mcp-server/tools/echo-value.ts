/**
 * @fileoverview Bounds a caller-supplied value quoted back in a notice or error
 * message, so an oversized input cannot inflate the response that echoes it.
 * @module mcp-server/tools/echo-value
 */

/** Longest echo kept whole: every CELEX and CELLAR work URI fits, and a title phrase stays readable. */
const MAX_ECHO_LENGTH = 100;

/** `value` unchanged up to {@link MAX_ECHO_LENGTH} characters, else its first 100 plus an ellipsis. */
export function echoValue(value: string): string {
  return value.length > MAX_ECHO_LENGTH ? `${value.slice(0, MAX_ECHO_LENGTH)}…` : value;
}
