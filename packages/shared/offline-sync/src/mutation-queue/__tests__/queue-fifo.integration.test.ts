// FIFO ordering + atomic dead-letter against the REAL pending_mutations DDL (via
// node:sqlite). The sibling queue.test.ts asserts the SQL strings; this file runs
// them through an actual SQLite engine so the ORDER BY and the CASE-in-UPDATE
// behave as claimed on real rows.

import { describe, it, expect, beforeEach } from 'vitest';
import type { OfflineDatabase } from '../../database';

import { enqueue, getOutboxSummary, markDeadLetter, peekPending, recordFailure, type PendingMutation } from '../queue';
import { ensureMutationQueueTable } from '../schema';
import { createTestDatabase, type TestSqliteDb } from '../../testing/sqlite-test-db';

let db: TestSqliteDb;

// Insert a pending mutation with an EXPLICIT created_at so same-second ties are
// deterministic (enqueue() always stamps datetime('now'), which we can't pin).
// id is AUTOINCREMENT, so insertion order fixes the tiebreak.
async function insertPending(database: OfflineDatabase, idempotencyKey: string, createdAt: string): Promise<void> {
  await database.runAsync(
    `INSERT INTO pending_mutations (table_name, operation, payload, idempotency_key, created_at)
     VALUES ('boardsesh_ticks', 'create', '{}', ?, ?)`,
    [idempotencyKey, createdAt],
  );
}

beforeEach(async () => {
  db = createTestDatabase();
  await ensureMutationQueueTable(db);
});

describe('peekPending FIFO ordering', () => {
  it('drains two same-second writes in id (insertion) order', async () => {
    // Identical created_at to the second → the ORDER BY created_at alone is a
    // tie; only the id tiebreak gives a stable, correct (insertion) order.
    const sameSecond = '2024-06-01T12:00:00';
    await insertPending(db, 'first', sameSecond);
    await insertPending(db, 'second', sameSecond);
    await insertPending(db, 'third', sameSecond);

    const pending = await peekPending(db, 10);

    expect(pending.map((mutation) => mutation.idempotency_key)).toEqual(['first', 'second', 'third']);
    // ids are strictly increasing in the same order.
    const ids = pending.map((mutation) => mutation.id);
    expect(ids).toEqual([...ids].sort((left, right) => left - right));
  });

  it('orders by created_at first, then falls back to id within a second', async () => {
    // A later-id row with an EARLIER timestamp must still come first — created_at
    // is the primary sort, id only the tiebreak.
    await insertPending(db, 'newer-second', '2024-06-01T12:00:05');
    await insertPending(db, 'older-first', '2024-06-01T12:00:01');
    // Two in the same (latest) second to exercise the id tiebreak alongside.
    await insertPending(db, 'same-a', '2024-06-01T12:00:09');
    await insertPending(db, 'same-b', '2024-06-01T12:00:09');

    const pending = await peekPending(db, 10);

    expect(pending.map((mutation) => mutation.idempotency_key)).toEqual([
      'older-first',
      'newer-second',
      'same-a',
      'same-b',
    ]);
  });
});

// Issue #4315. Both of these are read by telemetry whose failure mode is
// SILENCE — the outbox gauge swallows its own errors and the suppressed-enqueue
// report only fires on `inserted: false` — so a wrong SQL string or a driver
// that reports `changes` differently would look exactly like "nothing to
// report" forever. The sibling queue.test.ts only proves the code against a
// hand-written double that returns whatever the implementation expects; these
// run the same calls through a real SQLite engine.
describe('enqueue suppression against real SQLite', () => {
  const key = 'add:user_favorites:kilter:climb-1:40';

  it('reports a fresh insert', async () => {
    await expect(enqueue(db, 'user_favorites', 'create', { climbUuid: 'climb-1' }, key)).resolves.toEqual({
      inserted: true,
      revived: false,
      existingStatus: null,
    });
  });

  // The load-bearing one: INSERT OR IGNORE must actually surface changes = 0 on
  // the real driver, or the whole dead-letter-swallow instrument is dead code.
  it('reports the existing row status when the UNIQUE key is already taken', async () => {
    await enqueue(db, 'user_favorites', 'create', {}, key);

    await expect(enqueue(db, 'user_favorites', 'create', {}, key)).resolves.toEqual({
      inserted: false,
      revived: false,
      existingStatus: 'pending',
    });

    const rows = await db.getAllAsync<PendingMutation>('SELECT * FROM pending_mutations');
    expect(rows).toHaveLength(1);
  });

  it('reports dead_letter once the row that owns the key has been given up on', async () => {
    await enqueue(db, 'user_favorites', 'create', {}, key);
    const row = await db.getFirstAsync<{ id: number }>('SELECT id FROM pending_mutations WHERE idempotency_key = ?', [
      key,
    ]);
    await markDeadLetter(db, row!.id, '400 Bad Request');

    await expect(enqueue(db, 'user_favorites', 'create', {}, key)).resolves.toEqual({
      inserted: false,
      revived: false,
      existingStatus: 'dead_letter',
    });
  });
});

describe('getOutboxSummary against real SQLite', () => {
  it('splits counts and oldest created_at per status', async () => {
    await insertPending(db, 'pending-newer', '2026-08-02T10:00:00');
    await insertPending(db, 'pending-older', '2026-08-01T10:00:00');
    await insertPending(db, 'dead-older', '2026-07-20T08:30:00');
    await insertPending(db, 'dead-newer', '2026-07-25T08:30:00');
    for (const deadKey of ['dead-older', 'dead-newer']) {
      const row = await db.getFirstAsync<{ id: number }>('SELECT id FROM pending_mutations WHERE idempotency_key = ?', [
        deadKey,
      ]);
      await markDeadLetter(db, row!.id, 'gone');
    }

    await expect(getOutboxSummary(db)).resolves.toEqual({
      pendingCount: 2,
      deadLetterCount: 2,
      oldestPendingAt: '2026-08-01T10:00:00',
      oldestDeadLetterAt: '2026-07-20T08:30:00',
    });
  });

  it('reads an empty outbox as zeros and nulls, not as an error', async () => {
    await expect(getOutboxSummary(db)).resolves.toEqual({
      pendingCount: 0,
      deadLetterCount: 0,
      oldestPendingAt: null,
      oldestDeadLetterAt: null,
    });
  });
});

describe('recordFailure atomic dead-letter', () => {
  async function getRow(id: number): Promise<PendingMutation | null> {
    return db.getFirstAsync<PendingMutation>('SELECT * FROM pending_mutations WHERE id = ?', [id]);
  }

  it('bumps retry_count below the threshold without changing status', async () => {
    await db.runAsync(
      `INSERT INTO pending_mutations (table_name, operation, payload, idempotency_key, retry_count, max_retries)
       VALUES ('boardsesh_ticks', 'create', '{}', 'k', 0, 3)`,
    );
    const before = await db.getFirstAsync<{ id: number }>(
      "SELECT id FROM pending_mutations WHERE idempotency_key = 'k'",
    );

    await expect(recordFailure(db, before!.id, 'transient 503')).resolves.toEqual({
      status: 'pending',
      retryCount: 1,
    });

    const row = await getRow(before!.id);
    expect(row?.retry_count).toBe(1);
    expect(row?.status).toBe('pending'); // still retryable
    expect(row?.last_error).toBe('transient 503');
  });

  it('flips to dead_letter in the SAME update once the bumped count reaches max_retries', async () => {
    // retry_count one below max: this failure is the one that exhausts it, so the
    // single UPDATE must both bump to max AND set status = dead_letter — never an
    // intermediate "retry_count = max but status = pending" state.
    await db.runAsync(
      `INSERT INTO pending_mutations (table_name, operation, payload, idempotency_key, retry_count, max_retries)
       VALUES ('boardsesh_ticks', 'create', '{}', 'k', 2, 3)`,
    );
    const before = await db.getFirstAsync<{ id: number }>(
      "SELECT id FROM pending_mutations WHERE idempotency_key = 'k'",
    );

    await expect(recordFailure(db, before!.id, 'still down')).resolves.toEqual({
      status: 'dead_letter',
      retryCount: 3,
    });

    const row = await getRow(before!.id);
    expect(row?.retry_count).toBe(3);
    expect(row?.status).toBe('dead_letter');
    expect(row?.last_error).toBe('still down');
  });

  it('only one row reaches dead_letter at max_retries; siblings below threshold stay pending', async () => {
    await db.runAsync(
      `INSERT INTO pending_mutations (table_name, operation, payload, idempotency_key, retry_count, max_retries)
       VALUES ('boardsesh_ticks', 'create', '{}', 'exhausted', 4, 5)`,
    );
    await db.runAsync(
      `INSERT INTO pending_mutations (table_name, operation, payload, idempotency_key, retry_count, max_retries)
       VALUES ('boardsesh_ticks', 'create', '{}', 'healthy', 0, 5)`,
    );
    const exhausted = await db.getFirstAsync<{ id: number }>(
      "SELECT id FROM pending_mutations WHERE idempotency_key = 'exhausted'",
    );
    const healthy = await db.getFirstAsync<{ id: number }>(
      "SELECT id FROM pending_mutations WHERE idempotency_key = 'healthy'",
    );

    await expect(recordFailure(db, exhausted!.id, 'gone')).resolves.toEqual({
      status: 'dead_letter',
      retryCount: 5,
    });
    await expect(recordFailure(db, healthy!.id, 'blip')).resolves.toEqual({ status: 'pending', retryCount: 1 });

    const deadLettered = await db.getAllAsync<PendingMutation>(
      "SELECT * FROM pending_mutations WHERE status = 'dead_letter'",
    );
    expect(deadLettered).toHaveLength(1);
    expect(deadLettered[0].idempotency_key).toBe('exhausted');

    const healthyRow = await getRow(healthy!.id);
    expect(healthyRow?.status).toBe('pending');
    expect(healthyRow?.retry_count).toBe(1);
  });
});
