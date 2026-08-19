import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OfflineDatabase } from '../../database';

function createMockDb() {
  return {
    runAsync: vi.fn().mockResolvedValue(undefined),
    getAllAsync: vi.fn().mockResolvedValue([]),
    getFirstAsync: vi.fn().mockResolvedValue(null),
  } as unknown as OfflineDatabase;
}

import {
  enqueue,
  peekPending,
  markCompleted,
  recordFailure,
  markDeadLetter,
  getPendingCount,
  getDeadLetterCount,
  getOutboxSummary,
  getDeadLetters,
  retryDeadLetter,
  discardDeadLetter,
  clearAll,
} from '../queue';

describe('mutation queue', () => {
  let db: OfflineDatabase;

  beforeEach(() => {
    db = createMockDb();
  });

  it('enqueue inserts with correct parameters', async () => {
    const payload = { climbUuid: 'abc-123', grade: 5 };

    await enqueue(db, 'boardsesh_ticks', 'create', payload, 'idem-key-1');

    expect(db.runAsync).toHaveBeenCalledWith(expect.stringContaining('INSERT OR IGNORE INTO pending_mutations'), [
      'boardsesh_ticks',
      'create',
      JSON.stringify(payload),
      'idem-key-1',
    ]);
  });

  it('peekPending selects pending mutations ordered by created_at then id (FIFO)', async () => {
    await peekPending(db, 5);

    expect(db.getAllAsync).toHaveBeenCalledWith(
      expect.stringMatching(
        /SELECT \* FROM pending_mutations WHERE status = 'pending' ORDER BY created_at ASC, id ASC LIMIT \?/,
      ),
      [5],
    );
  });

  it('peekPending defaults to limit 10', async () => {
    await peekPending(db);

    expect(db.getAllAsync).toHaveBeenCalledWith(expect.any(String), [10]);
  });

  it('markCompleted deletes by id', async () => {
    await markCompleted(db, 42);

    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM pending_mutations WHERE id = ?', [42]);
  });

  it.each(['pending', 'dead_letter'] as const)(
    'recordFailure returns %s and the bumped retry count from one UPDATE RETURNING statement',
    async (status) => {
      (db.getFirstAsync as ReturnType<typeof vi.fn>).mockResolvedValue({ status, retry_count: 3 });

      await expect(recordFailure(db, 7, 'Connection timeout')).resolves.toEqual({ status, retryCount: 3 });

      expect(db.getFirstAsync).toHaveBeenCalledTimes(1);
      const [sql, params] = (db.getFirstAsync as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toMatch(/^UPDATE pending_mutations/);
      expect(sql).toMatch(/retry_count = retry_count \+ 1/);
      expect(sql).toMatch(/last_error = \?/);
      expect(sql).toMatch(/status = CASE WHEN retry_count \+ 1 >= max_retries THEN 'dead_letter' ELSE status END/);
      expect(sql).toMatch(/RETURNING status, retry_count$/);
      expect(sql).not.toMatch(/\bSELECT\b/);
      expect(params).toEqual(['Connection timeout', 7]);
      expect(db.runAsync).not.toHaveBeenCalled();
    },
  );

  it('recordFailure treats an already-missing row as pending without a second query', async () => {
    (db.getFirstAsync as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await expect(recordFailure(db, 404, 'Already removed')).resolves.toEqual({ status: 'pending', retryCount: 0 });

    expect(db.getFirstAsync).toHaveBeenCalledTimes(1);
    expect(db.runAsync).not.toHaveBeenCalled();
  });

  describe('enqueue result (issue #4315)', () => {
    it('reports a fresh insert without spending a lookup', async () => {
      (db.runAsync as ReturnType<typeof vi.fn>).mockResolvedValue({ changes: 1, lastInsertRowId: 9 });

      await expect(enqueue(db, 'user_favorites', 'create', {}, 'add:user_favorites:kilter:abc:40')).resolves.toEqual({
        inserted: true,
        revived: false,
        existingStatus: null,
      });

      expect(db.getFirstAsync).not.toHaveBeenCalled();
    });

    it('reports a suppression against a live pending row (legitimate dedup)', async () => {
      (db.runAsync as ReturnType<typeof vi.fn>).mockResolvedValue({ changes: 0, lastInsertRowId: 0 });
      (db.getFirstAsync as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'pending' });

      await expect(
        enqueue(db, 'user_favorites', 'create', {}, 'add:user_favorites:kilter:abc:40', { reviveDeadLetter: true }),
      ).resolves.toEqual({
        inserted: false,
        revived: false,
        existingStatus: 'pending',
      });
    });

    it('reports a suppression against a dead-lettered row when the caller does not opt into reviving', async () => {
      (db.runAsync as ReturnType<typeof vi.fn>).mockResolvedValue({ changes: 0, lastInsertRowId: 0 });
      (db.getFirstAsync as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'dead_letter' });

      await expect(enqueue(db, 'user_favorites', 'create', {}, 'add:user_favorites:kilter:abc:40')).resolves.toEqual({
        inserted: false,
        revived: false,
        existingStatus: 'dead_letter',
      });

      expect(db.getFirstAsync).toHaveBeenCalledWith('SELECT status FROM pending_mutations WHERE idempotency_key = ?', [
        'add:user_favorites:kilter:abc:40',
      ]);
      // Exactly one write: the INSERT. No revive UPDATE was attempted.
      expect(db.runAsync).toHaveBeenCalledTimes(1);
    });

    // The SELECT says dead_letter, the UPDATE matches nothing — the row's status
    // moved in between (a concurrent drain retry, a cancel DELETE). Reporting a
    // suppression is the right alarm: nothing was queued for this write.
    it('reports a suppression when the revive UPDATE matches no row', async () => {
      (db.runAsync as ReturnType<typeof vi.fn>).mockResolvedValue({ changes: 0, lastInsertRowId: 0 });
      (db.getFirstAsync as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'dead_letter' });

      await expect(
        enqueue(db, 'user_favorites', 'create', {}, 'add:user_favorites:kilter:abc:40', { reviveDeadLetter: true }),
      ).resolves.toEqual({
        inserted: false,
        revived: false,
        existingStatus: 'dead_letter',
      });
    });

    it('degrades to "inserted" when the driver reports no changes count', async () => {
      (db.runAsync as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      await expect(enqueue(db, 'boardsesh_ticks', 'create', {}, 'uuid-1')).resolves.toEqual({
        inserted: true,
        revived: false,
        existingStatus: null,
      });
    });
  });

  describe('getOutboxSummary', () => {
    it('splits counts and oldest timestamps per status', async () => {
      (db.getAllAsync as ReturnType<typeof vi.fn>).mockResolvedValue([
        { status: 'pending', count: 3, oldest_created_at: '2026-08-01 10:00:00' },
        { status: 'dead_letter', count: 2, oldest_created_at: '2026-07-20 08:30:00' },
      ]);

      await expect(getOutboxSummary(db)).resolves.toEqual({
        pendingCount: 3,
        deadLetterCount: 2,
        oldestPendingAt: '2026-08-01 10:00:00',
        oldestDeadLetterAt: '2026-07-20 08:30:00',
      });
    });

    it('returns zeros and nulls on an empty outbox', async () => {
      (db.getAllAsync as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await expect(getOutboxSummary(db)).resolves.toEqual({
        pendingCount: 0,
        deadLetterCount: 0,
        oldestPendingAt: null,
        oldestDeadLetterAt: null,
      });
    });
  });

  it('getDeadLetters is unbounded by default and takes a LIMIT for callers that act on the rows', async () => {
    await getDeadLetters(db);
    expect(db.getAllAsync).toHaveBeenLastCalledWith(expect.not.stringContaining('LIMIT'));

    await getDeadLetters(db, 50);
    expect(db.getAllAsync).toHaveBeenLastCalledWith(expect.stringContaining('LIMIT ?'), [50]);
  });

  it('markDeadLetter sets status to dead_letter with error', async () => {
    await markDeadLetter(db, 15, 'Bad request');

    expect(db.runAsync).toHaveBeenCalledWith(expect.stringContaining("status = 'dead_letter'"), ['Bad request', 15]);
  });

  it('getPendingCount queries count of pending mutations', async () => {
    (db.getFirstAsync as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 3 });

    const count = await getPendingCount(db);

    expect(count).toBe(3);
    expect(db.getFirstAsync).toHaveBeenCalledWith(expect.stringMatching(/COUNT\(\*\).*status = 'pending'/));
  });

  it('getPendingCount returns 0 when no row', async () => {
    (db.getFirstAsync as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const count = await getPendingCount(db);

    expect(count).toBe(0);
  });

  it('getDeadLetterCount queries count of dead_letter mutations', async () => {
    (db.getFirstAsync as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 2 });

    const count = await getDeadLetterCount(db);

    expect(count).toBe(2);
    expect(db.getFirstAsync).toHaveBeenCalledWith(expect.stringMatching(/COUNT\(\*\).*status = 'dead_letter'/));
  });

  it('retryDeadLetter resets status to pending and clears retry_count', async () => {
    await retryDeadLetter(db, 9);

    expect(db.runAsync).toHaveBeenCalledWith(
      expect.stringMatching(/status = 'pending'.*retry_count = 0.*last_error = NULL/),
      [9],
    );
  });

  it('discardDeadLetter deletes only dead_letter entries', async () => {
    await discardDeadLetter(db, 11);

    expect(db.runAsync).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM pending_mutations WHERE id = ? AND status = ?'),
      [11, 'dead_letter'],
    );
  });

  it('clearAll deletes all pending_mutations', async () => {
    await clearAll(db);

    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM pending_mutations');
  });
});
