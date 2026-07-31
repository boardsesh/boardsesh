import { describe, it, expect, vi } from 'vitest';
import { syncDeletions } from '@boardsesh/db/schema';
import { SYNC_DELETIONS_RETENTION_DAYS as SHARED_RETENTION_DAYS } from '@boardsesh/offline-sync';
import { pruneSyncDeletions, SYNC_DELETIONS_RETENTION_DAYS } from '../sync-deletions-prune';
import type { Database } from '../../db/client';

function makeDatabaseMock(count: number | undefined) {
  const where = vi.fn().mockResolvedValue({ count });
  const deleteFn = vi.fn(() => ({ where }));
  return { database: { delete: deleteFn } as unknown as Database, deleteFn, where };
}

describe('pruneSyncDeletions', () => {
  it('deletes from sync_deletions with a cutoff at the retention boundary and returns the pruned count', async () => {
    const { database, deleteFn, where } = makeDatabaseMock(7);

    const beforeMs = Date.now() - SYNC_DELETIONS_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const prunedCount = await pruneSyncDeletions(database);
    const afterMs = Date.now() - SYNC_DELETIONS_RETENTION_DAYS * 24 * 60 * 60 * 1000;

    expect(prunedCount).toBe(7);
    expect(deleteFn).toHaveBeenCalledWith(syncDeletions);
    expect(where).toHaveBeenCalledTimes(1);
    // The where clause is drizzle's lt(deletedAt, cutoff); pull the bound Date
    // back out of the SQL param list to pin the retention arithmetic.
    const whereCondition = where.mock.calls[0][0] as { queryChunks?: unknown[] };
    const boundDates = (whereCondition.queryChunks ?? []).flatMap((chunk) => {
      const param = chunk as { value?: unknown };
      return param && param.value instanceof Date ? [param.value as Date] : [];
    });
    expect(boundDates).toHaveLength(1);
    expect(boundDates[0].getTime()).toBeGreaterThanOrEqual(beforeMs);
    expect(boundDates[0].getTime()).toBeLessThanOrEqual(afterMs);
  });

  it('prunes on the SAME window the client staleness guard compares against', async () => {
    // The client forces a from-scratch user-data resync once its deletions
    // coverage marker is older than this value minus a margin (issue #3474). If
    // the two ever forked — a local `= 90` re-introduced here and then edited —
    // the server would prune tombstones inside a window the client still
    // believes it is covered for, silently reopening the gap on device.
    expect(SYNC_DELETIONS_RETENTION_DAYS).toBe(SHARED_RETENTION_DAYS);
    expect(SYNC_DELETIONS_RETENTION_DAYS).toBe(90);
  });

  it('returns 0 when the driver reports no count', async () => {
    const { database } = makeDatabaseMock(undefined);
    expect(await pruneSyncDeletions(database)).toBe(0);
  });
});
