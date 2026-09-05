// Issue #4331. `enqueue` is INSERT OR IGNORE against a UNIQUE idempotency key,
// so a dead-lettered row used to own a deterministic key (a favorite, a follow)
// forever: every later write for that target was dropped at INSERT time, and
// nothing was left to drain. `reviveDeadLetter` is the escape hatch — the row
// goes back to pending carrying the CURRENT intent.
//
// Run against the REAL pending_mutations DDL through node:sqlite, because the
// whole behaviour is in what the UPDATE does to a row the engine will later read
// back.

import { describe, it, expect, beforeEach } from 'vitest';

import { enqueue, peekPending, getDeadLetterCount, markDeadLetter } from '../queue';
import { ensureMutationQueueTable } from '../schema';
import { createTestDatabase, type TestSqliteDb } from '../../testing/sqlite-test-db';

const FAVORITE_KEY = 'add:user_favorites:kilter:c1:40';

type QueueRow = {
  id: number;
  table_name: string;
  operation: string;
  payload: string;
  status: string;
  retry_count: number;
  last_error: string | null;
  created_at: string;
};

let db: TestSqliteDb;

async function readRow(idempotencyKey: string): Promise<QueueRow | null> {
  return db.getFirstAsync<QueueRow>('SELECT * FROM pending_mutations WHERE idempotency_key = ?', [idempotencyKey]);
}

beforeEach(async () => {
  db = createTestDatabase();
  await ensureMutationQueueTable(db);
});

describe('enqueue against a dead-lettered key', () => {
  beforeEach(async () => {
    await enqueue(db, 'user_favorites', 'create', { climbUuid: 'c1', angle: 40 }, FAVORITE_KEY);
    const queued = await readRow(FAVORITE_KEY);
    await markDeadLetter(db, queued!.id, 'Error code 5: database is locked');
    // Burn a retry too, so the reset is visible rather than a coincidence.
    await db.runAsync('UPDATE pending_mutations SET retry_count = 3 WHERE idempotency_key = ?', [FAVORITE_KEY]);
  });

  it('revives the row with the payload of the NEW write when the caller opts in', async () => {
    const result = await enqueue(
      db,
      'user_favorites',
      'create',
      { climbUuid: 'c1', angle: 40, source: 'retap' },
      FAVORITE_KEY,
      { reviveDeadLetter: true },
    );

    expect(result).toEqual({ inserted: false, revived: true, existingStatus: 'dead_letter' });

    const row = await readRow(FAVORITE_KEY);
    expect(row).toMatchObject({
      status: 'pending',
      retry_count: 0,
      last_error: null,
      table_name: 'user_favorites',
      operation: 'create',
    });
    // The revived row replays what the user just did, not what died.
    expect(JSON.parse(row!.payload)).toEqual({ climbUuid: 'c1', angle: 40, source: 'retap' });
    expect(await getDeadLetterCount(db)).toBe(0);
  });

  it('makes the revived row drainable again — the whole point', async () => {
    expect(await peekPending(db, 10)).toHaveLength(0);

    await enqueue(db, 'user_favorites', 'create', { climbUuid: 'c1', angle: 40 }, FAVORITE_KEY, {
      reviveDeadLetter: true,
    });

    const pending = await peekPending(db, 10);
    expect(pending).toHaveLength(1);
    expect(pending[0].idempotency_key).toBe(FAVORITE_KEY);
  });

  it('re-stamps created_at so FIFO order and queue-age telemetry stop reporting the weeks it spent dead', async () => {
    await db.runAsync("UPDATE pending_mutations SET created_at = '2026-07-01 00:00:00' WHERE idempotency_key = ?", [
      FAVORITE_KEY,
    ]);

    await enqueue(db, 'user_favorites', 'create', { climbUuid: 'c1', angle: 40 }, FAVORITE_KEY, {
      reviveDeadLetter: true,
    });

    const row = await readRow(FAVORITE_KEY);
    expect(row!.created_at).not.toBe('2026-07-01 00:00:00');
  });

  it('leaves the dead letter exactly as it was without the opt-in (the tick path contract)', async () => {
    const before = await readRow(FAVORITE_KEY);

    const result = await enqueue(db, 'user_favorites', 'create', { climbUuid: 'c1', angle: 99 }, FAVORITE_KEY);

    expect(result).toEqual({ inserted: false, revived: false, existingStatus: 'dead_letter' });
    expect(await readRow(FAVORITE_KEY)).toEqual(before);
    expect(await getDeadLetterCount(db)).toBe(1);
  });
});

describe('enqueue against a live pending row', () => {
  it('is still plain dedup, opt-in or not — a double tap must not reset anything', async () => {
    await enqueue(db, 'user_favorites', 'create', { climbUuid: 'c1', angle: 40 }, FAVORITE_KEY);
    const before = await readRow(FAVORITE_KEY);

    const result = await enqueue(db, 'user_favorites', 'create', { climbUuid: 'c1', angle: 99 }, FAVORITE_KEY, {
      reviveDeadLetter: true,
    });

    expect(result).toEqual({ inserted: false, revived: false, existingStatus: 'pending' });
    expect(await readRow(FAVORITE_KEY)).toEqual(before);
  });

  it('reports a fresh insert on a key nothing owns', async () => {
    await expect(
      enqueue(db, 'user_follows', 'create', { followingId: 'u-1' }, 'add:user_follows:u-1', {
        reviveDeadLetter: true,
      }),
    ).resolves.toEqual({ inserted: true, revived: false, existingStatus: null });
  });
});
