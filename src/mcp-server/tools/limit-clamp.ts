/**
 * @fileoverview The `limit_clamp` enrichment (#151): a `limit` above a tool's
 * per-call maximum is served at that maximum rather than rejected, and the response
 * says so on both surfaces under its own key, apart from the one `notice`.
 * @module mcp-server/tools/limit-clamp
 */

import { z } from '@cyanheads/mcp-ts-core';

/** Hard ceiling on a row `limit`: rejects absurd input; anything up to it is served at the tool's maximum. */
export const ROW_LIMIT_CEILING = 10_000;

/** A clamped `limit`: what the call asked for and what it was served at. */
export interface LimitClamp {
  applied: number;
  requested: number;
}

/** The `limit_clamp` enrichment field, declared by every tool whose `limit` clamps. */
export const limitClampEnrichment = z
  .object({
    requested: z.number().int().describe('The limit the call asked for.'),
    applied: z.number().int().describe('The limit served: the per-call maximum.'),
  })
  .optional()
  .describe(
    'Present only when limit exceeded the per-call maximum: the value asked for and the value served. The response follows the applied value.',
  );

/** The `content[]` trailer line for `limit_clamp`. */
export const limitClampTrailer = {
  render: (clamp: LimitClamp | undefined) =>
    clamp ? `**Limit clamped:** ${clamp.requested} → ${clamp.applied} (per-call maximum)` : '',
};

/**
 * The `limit` a call is served at: `requested` cut to `maximum`, with `limit_clamp`
 * enriched onto the response when it cut.
 */
export function clampLimit(
  ctx: { enrich: (fields: { limit_clamp: LimitClamp }) => unknown },
  requested: number,
  maximum: number,
): number {
  if (requested <= maximum) return requested;
  ctx.enrich({ limit_clamp: { requested, applied: maximum } });
  return maximum;
}
