/**
 * Batching rules for `bulkVoteSummaries`, shared by the backend validator and
 * every client that builds a vote-summary request.
 */

/**
 * Hard cap on how many entity IDs a single `bulkVoteSummaries` request may
 * carry. The backend rejects an over-cap request outright (see
 * `BulkVoteSummaryInputSchema`), so a caller with an unbounded list — a
 * paginating feed, a long logbook — has to split it with
 * {@link batchVoteSummaryEntityIds} instead of handing the whole list over.
 */
export const BULK_VOTE_SUMMARY_CHUNK_SIZE = 100;

/**
 * Splits entity IDs into batches the backend will accept, dropping duplicates
 * (in first-seen order) so a feed that shows the same entity twice doesn't
 * spend cap headroom on it. Empty input yields no batches at all, which lets
 * callers skip the request entirely.
 */
export function batchVoteSummaryEntityIds(entityIds: readonly string[]): string[][] {
  const uniqueIds = Array.from(new Set(entityIds));
  const batches: string[][] = [];
  for (let startIndex = 0; startIndex < uniqueIds.length; startIndex += BULK_VOTE_SUMMARY_CHUNK_SIZE) {
    batches.push(uniqueIds.slice(startIndex, startIndex + BULK_VOTE_SUMMARY_CHUNK_SIZE));
  }
  return batches;
}
