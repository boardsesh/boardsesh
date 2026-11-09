/**
 * Reads one sweep round may start. One, because the round shares two admission
 * connections with ordinary requests: at a slow statement a larger round queues
 * those requests past their deadline (docs/db-connectivity.md). A round is one
 * second, so a full pass takes one second per 128 connected users.
 */
export const MAX_SWEEP_BATCHES_PER_ROUND = 1;

/**
 * Picks this round's batches, resuming where the last round stopped. With more
 * connected users than one round covers, a full pass takes several rounds, and
 * every account is still checked instead of the later batches being starved.
 */
export function selectSweepBatches<Batch>(
  batches: readonly Batch[],
  previousOffset: number,
): { roundBatches: Batch[]; nextOffset: number } {
  if (batches.length === 0) return { roundBatches: [], nextOffset: 0 };
  const startIndex = previousOffset % batches.length;
  const roundBatches = Array.from(
    { length: Math.min(MAX_SWEEP_BATCHES_PER_ROUND, batches.length) },
    (_unused, index) => batches[(startIndex + index) % batches.length],
  );
  return { roundBatches, nextOffset: (startIndex + roundBatches.length) % batches.length };
}
