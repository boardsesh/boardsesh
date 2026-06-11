// FIFO ordering + atomic dead-letter against the REAL pending_mutations DDL (via
// node:sqlite). The sibling queue.test.ts asserts the SQL strings; this file runs
// them through an actual SQLite engine so the ORDER BY and the CASE-in-UPDATE
// behave as claimed on real rows.

import { describe, it, expect, beforeEach } from 'vitest';
import type { SQLiteDatabase } from 'expo-sqlite';

import { peekPending, recordFailure, type PendingMutation } from '../queue';
import { ensureMutationQueueTable } from '../schema';
import { createTestDatabase, type TestSqliteDb } from '../../db/__tests__/sqlite-test-db';

let db: TestSqliteDb;

// Insert a pending mutation with an EXPLICIT created_at so same-second ties are
// deterministic (enqueue() always stamps datetime('now'), which we can't pin).
// id is AUTOINCREMENT, so insertion order fixes the tiebreak.
async function insertPending(database: SQLiteDatabase, idempotencyKey: string, createdAt: string): Promise<void> {
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

    await recordFailure(db, before!.id, 'transient 503');

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

    await recordFailure(db, before!.id, 'still down');

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

    await recordFailure(db, exhausted!.id, 'gone');
    await recordFailure(db, healthy!.id, 'blip');

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
