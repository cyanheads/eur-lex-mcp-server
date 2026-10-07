/**
 * @fileoverview CPU-time measurement for the suite's linear-time regression tests.
 * Wall-clock time also counts every moment the test's thread waits for a core, so
 * on a loaded machine it measures the scheduler as much as the code: a parse that
 * runs in 2 ms reads as 30 ms when other processes hold the cores. These helpers
 * read the main thread's own CPU time (`process.threadCpuUsage`, in Node ≥23.9 and
 * Bun), which stops while the thread is descheduled and leaves out other threads,
 * so it tracks the work the code under test does, whatever else the machine runs.
 * @module tests/helpers/cpu-time
 */

import { expect } from 'vitest';

/**
 * Wall-clock timeout for a test these helpers time. Its assertions are on CPU time,
 * and on a loaded machine a test doing 200 ms of work can take past Vitest's 5 s
 * default to finish, so the wall clock gets room enough never to decide the result.
 */
export const CPU_TIMED_TEST_TIMEOUT_MS = 30_000;

/** Main-thread CPU time one call of `run` takes, in milliseconds. */
async function cpuMs(run: () => unknown): Promise<number> {
  const start = process.threadCpuUsage();
  await run();
  const { user, system } = process.threadCpuUsage(start);
  return (user + system) / 1000;
}

/**
 * Main-thread CPU time of the fastest of `rounds` calls of `run`, in milliseconds.
 * The fastest round leaves out a garbage collection or a cold cache that landed on
 * one call.
 */
export async function bestCpuMs(run: () => unknown, rounds = 5): Promise<number> {
  let best = Number.POSITIVE_INFINITY;
  for (let round = 0; round < rounds; round++) best = Math.min(best, await cpuMs(run));
  return best;
}

const SMALL = 5_000;
const LARGE = 80_000;

/**
 * Asserts that the work `setup(n)` returns grows linearly with `n`. `setup` builds
 * the input for an `n`-character case outside the measurement and returns the call
 * to time; each size is timed by its best of five rounds of CPU time.
 *
 * The 80k time over the 5k time is about 16 for a linear pass and 256 for a
 * quadratic one, so it must stay under 64, their geometric midpoint. The rounds
 * alternate between the two sizes, so a stretch on a slower core or a contended
 * cache slows both alike instead of skewing the ratio. The 80k call must also stay
 * under `maxLargeMs`: a quadratic term still small next to a heavy linear one can
 * hold the ratio under 64 while multiplying the time.
 */
export async function expectLinearScaling(
  setup: (n: number) => () => unknown,
  maxLargeMs: number,
): Promise<void> {
  const small = setup(SMALL);
  const large = setup(LARGE);
  let tSmall = Number.POSITIVE_INFINITY;
  let tLarge = Number.POSITIVE_INFINITY;
  for (let round = 0; round < 5; round++) {
    tSmall = Math.min(tSmall, await cpuMs(small));
    tLarge = Math.min(tLarge, await cpuMs(large));
  }
  const timings = `${tLarge.toFixed(3)} ms at ${LARGE} characters, ${tSmall.toFixed(3)} ms at ${SMALL}`;
  expect(tLarge / tSmall, timings).toBeLessThan(64);
  expect(tLarge, timings).toBeLessThan(maxLargeMs);
}
