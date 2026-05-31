import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SQLiteDatabase } from 'expo-sqlite';

function createMockDb() {
  return {
    runAsync: vi.fn().mockResolvedValue(undefined),
    getAllAsync: vi.fn().mockResolvedValue([]),
    getFirstAsync: vi.fn().mockResolvedValue(null),
  } as unknown as SQLiteDatabase;
}

import {
  enqueue,
  peekPending,
  markCompleted,
  recordFailure,
  markDeadLetter,
  getPendingCount,
  getDeadLetterCount,
  retryDeadLetter,
  discardDeadLetter,
  clearAll,
} from '../queue';

describe('mutation queue', () => {
  let db: SQLiteDatabase;

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

  it('recordFailure bumps retry_count, stores the error, and conditionally dead-letters in one UPDATE', async () => {
    await recordFailure(db, 7, 'Connection timeout');

    const [sql, params] = (db.runAsync as ReturnType<typeof vi.fn>).mock.calls[0];
    // Single atomic statement: the retry bump and the dead-letter transition
    // are in the same UPDATE (CASE on retry_count + 1 >= max_retries).
    expect(sql).toMatch(/retry_count = retry_count \+ 1/);
    expect(sql).toMatch(/last_error = \?/);
    expect(sql).toMatch(/status = CASE WHEN retry_count \+ 1 >= max_retries THEN 'dead_letter' ELSE status END/);
    expect(params).toEqual(['Connection timeout', 7]);
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
