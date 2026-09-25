import { describe, expect, it } from 'vitest';
import { BULK_VOTE_SUMMARY_CHUNK_SIZE, batchVoteSummaryEntityIds } from '../vote-summary-batching';

function makeEntityIds(count: number, prefix = 'tick'): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}-${String(index).padStart(3, '0')}`);
}

describe('batchVoteSummaryEntityIds', () => {
  it('returns no batches for an empty list, so callers can skip the request', () => {
    expect(batchVoteSummaryEntityIds([])).toEqual([]);
  });

  it('keeps a list at the cap as a single batch', () => {
    const batches = batchVoteSummaryEntityIds(makeEntityIds(BULK_VOTE_SUMMARY_CHUNK_SIZE));

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(BULK_VOTE_SUMMARY_CHUNK_SIZE);
  });

  it('splits a list over the cap so no batch can be rejected by the backend', () => {
    const entityIds = makeEntityIds(235);

    const batches = batchVoteSummaryEntityIds(entityIds);

    expect(batches.map((batch) => batch.length)).toEqual([100, 100, 35]);
    for (const batch of batches) {
      expect(batch.length).toBeLessThanOrEqual(BULK_VOTE_SUMMARY_CHUNK_SIZE);
    }
    expect(batches.flat()).toEqual(entityIds);
  });

  it('drops duplicates in first-seen order before batching', () => {
    const batches = batchVoteSummaryEntityIds(['tick-b', 'tick-a', 'tick-b', 'tick-c', 'tick-a']);

    expect(batches).toEqual([['tick-b', 'tick-a', 'tick-c']]);
  });

  it('counts an entity once against the cap even when the caller repeats it', () => {
    const duplicatedIds = makeEntityIds(100).flatMap((entityId) => [entityId, entityId]);

    expect(batchVoteSummaryEntityIds(duplicatedIds)).toHaveLength(1);
  });
});
