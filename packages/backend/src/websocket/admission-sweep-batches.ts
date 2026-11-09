/**
 * Reads one sweep round may start. Four leaves the rest of the admission read
 * slots for ordinary requests, so a large sweep cannot crowd them out.
 */
export const MAX_SWEEP_BATCHES_PER_ROUND = 4;

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
