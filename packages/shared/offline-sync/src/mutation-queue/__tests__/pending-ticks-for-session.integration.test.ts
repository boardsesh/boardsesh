// `hasPendingTicksForSession` (#6903) against the real pending_mutations DDL, so
// the json_extract on the tick payload's sessionId and the status / table /
// operation filters run on actual rows.

import { describe, it, expect, beforeEach } from 'vitest';
import { enqueue, hasPendingTicksForSession, markCompleted, markDeadLetter } from '../queue';
import { ensureMutationQueueTable } from '../schema';
import { createTestDatabase, type TestSqliteDb } from '../../testing/sqlite-test-db';

let db: TestSqliteDb;

const tickInput = (sessionId: string | null) => ({
  boardType: 'kilter',
  climbUuid: 'climb-1',
  angle: 40,
  status: 'send',
  ...(sessionId ? { sessionId } : {}),
});

async function idOf(key: string): Promise<number> {
  return (await db.getFirstAsync<{ id: number }>('SELECT id FROM pending_mutations WHERE idempotency_key = ?', [key]))!
    .id;
}

beforeEach(async () => {
  db = createTestDatabase();
  await ensureMutationQueueTable(db);
});

describe('hasPendingTicksForSession', () => {
  it('finds a queued send logged in the session', async () => {
    await enqueue(db, 'boardsesh_ticks', 'create', tickInput('session-1'), 'tick-1');
    expect(await hasPendingTicksForSession(db, 'session-1')).toBe(true);
  });

  it('ignores an empty outbox, another session, and a tick with no session', async () => {
    expect(await hasPendingTicksForSession(db, 'session-1')).toBe(false);
    await enqueue(db, 'boardsesh_ticks', 'create', tickInput('session-2'), 'tick-2');
    await enqueue(db, 'boardsesh_ticks', 'create', tickInput(null), 'tick-3');
    expect(await hasPendingTicksForSession(db, 'session-1')).toBe(false);
  });

  it('stops counting a send once it has drained, or died', async () => {
    await enqueue(db, 'boardsesh_ticks', 'create', tickInput('session-1'), 'tick-1');
    await markCompleted(db, await idOf('tick-1'));
    expect(await hasPendingTicksForSession(db, 'session-1')).toBe(false);

    await enqueue(db, 'boardsesh_ticks', 'create', tickInput('session-1'), 'tick-4');
    await markDeadLetter(db, await idOf('tick-4'), 'CLIMB_NOT_FOUND');
    expect(await hasPendingTicksForSession(db, 'session-1')).toBe(false);
  });

  it('ignores other queued writes that name the session (a tick edit)', async () => {
    await enqueue(db, 'boardsesh_ticks', 'update', { sessionId: 'session-1' }, 'edit-1');
    expect(await hasPendingTicksForSession(db, 'session-1')).toBe(false);
  });
});
