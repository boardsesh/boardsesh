// `hasPendingTickForClimb` (#5960) against the real pending_mutations DDL, so the
// json_extract and the status / table / operation filters run on actual rows.

import { describe, it, expect, beforeEach } from 'vitest';
import { enqueue, hasPendingTickForClimb, markCompleted, markDeadLetter } from '../queue';
import { ensureMutationQueueTable } from '../schema';
import { createTestDatabase, type TestSqliteDb } from '../../testing/sqlite-test-db';

let db: TestSqliteDb;

const tickInput = (climbUuid: string) => ({ boardType: 'spray', climbUuid, angle: 40, status: 'send' });

async function idOf(key: string): Promise<number> {
  return (await db.getFirstAsync<{ id: number }>('SELECT id FROM pending_mutations WHERE idempotency_key = ?', [key]))!
    .id;
}

beforeEach(async () => {
  db = createTestDatabase();
  await ensureMutationQueueTable(db);
});

describe('hasPendingTickForClimb', () => {
  it('finds a queued send on the climb', async () => {
    await enqueue(db, 'boardsesh_ticks', 'create', tickInput('climb-1'), 'tick-1');
    expect(await hasPendingTickForClimb(db, 'climb-1')).toBe(true);
  });

  it('ignores a send on another climb, and an empty outbox', async () => {
    expect(await hasPendingTickForClimb(db, 'climb-1')).toBe(false);
    await enqueue(db, 'boardsesh_ticks', 'create', tickInput('climb-2'), 'tick-2');
    expect(await hasPendingTickForClimb(db, 'climb-1')).toBe(false);
  });

  it('stops counting a send once it has drained, or died', async () => {
    await enqueue(db, 'boardsesh_ticks', 'create', tickInput('climb-1'), 'tick-1');
    await markCompleted(db, await idOf('tick-1'));
    expect(await hasPendingTickForClimb(db, 'climb-1')).toBe(false);

    await enqueue(db, 'boardsesh_ticks', 'create', tickInput('climb-1'), 'tick-3');
    await markDeadLetter(db, await idOf('tick-3'), 'CLIMB_NOT_FOUND');
    expect(await hasPendingTickForClimb(db, 'climb-1')).toBe(false);
  });

  it('ignores other queued writes that name the climb (a favourite, a tick edit)', async () => {
    await enqueue(db, 'user_favorites', 'create', { climbUuid: 'climb-1' }, 'fav-1');
    await enqueue(db, 'boardsesh_ticks', 'update', { climbUuid: 'climb-1' }, 'edit-1');
    expect(await hasPendingTickForClimb(db, 'climb-1')).toBe(false);
  });
});
