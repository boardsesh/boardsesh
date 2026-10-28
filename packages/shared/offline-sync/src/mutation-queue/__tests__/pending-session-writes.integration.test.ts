// `countPendingSessionWrites` and `removePendingSessionWorkouts` (#6903)
// against the real pending_mutations DDL.

import { describe, it, expect, beforeEach } from 'vitest';
import { countPendingSessionWrites, enqueue, markDeadLetter, removePendingSessionWorkouts } from '../queue';
import { ensureMutationQueueTable } from '../schema';
import { createTestDatabase, type TestSqliteDb } from '../../testing/sqlite-test-db';

let db: TestSqliteDb;

const tick = (sessionId: string) => ({
  boardType: 'kilter',
  climbUuid: 'climb-1',
  angle: 40,
  status: 'send',
  sessionId,
});
const workout = (sessionId: string, revision: number) => ({ sessionId, revision, stages: [], ticks: [] });

async function idOf(key: string): Promise<number> {
  return (await db.getFirstAsync<{ id: number }>('SELECT id FROM pending_mutations WHERE idempotency_key = ?', [key]))!
    .id;
}

beforeEach(async () => {
  db = createTestDatabase();
  await ensureMutationQueueTable(db);
});

describe('countPendingSessionWrites', () => {
  it('counts the session’s queued ticks and workout writes apart', async () => {
    expect(await countPendingSessionWrites(db, 'session-1')).toEqual({ ticks: 0, workouts: 0 });
    await enqueue(db, 'boardsesh_ticks', 'create', tick('session-1'), 'tick-1');
    await enqueue(db, 'boardsesh_ticks', 'create', tick('session-1'), 'tick-2');
    await enqueue(db, 'boardsesh_ticks', 'update', { sessionId: 'session-1' }, 'edit-1');
    await enqueue(db, 'boardsesh_ticks', 'create', tick('session-2'), 'tick-3');
    await enqueue(db, 'session_workouts', 'create', workout('session-1', 1), 'workout-1');
    expect(await countPendingSessionWrites(db, 'session-1')).toEqual({ ticks: 2, workouts: 1 });
  });

  it('leaves dead letters out', async () => {
    await enqueue(db, 'boardsesh_ticks', 'create', tick('session-1'), 'tick-1');
    await markDeadLetter(db, await idOf('tick-1'), 'CLIMB_NOT_FOUND');
    expect(await countPendingSessionWrites(db, 'session-1')).toEqual({ ticks: 0, workouts: 0 });
  });
});

describe('removePendingSessionWorkouts', () => {
  it("drops only that session's waiting workout writes, never a tick or a dead letter", async () => {
    await enqueue(db, 'boardsesh_ticks', 'create', tick('session-1'), 'tick-1');
    await enqueue(db, 'session_workouts', 'create', workout('session-1', 1), 'workout-1');
    await enqueue(db, 'session_workouts', 'create', workout('session-1', 2), 'workout-2');
    await markDeadLetter(db, await idOf('workout-2'), 'FORBIDDEN');
    await enqueue(db, 'session_workouts', 'create', workout('session-2', 1), 'workout-3');

    await removePendingSessionWorkouts(db, 'session-1');

    const keys = await db.getAllAsync<{ idempotency_key: string }>(
      'SELECT idempotency_key FROM pending_mutations ORDER BY id',
    );
    expect(keys.map((row) => row.idempotency_key)).toEqual(['tick-1', 'workout-2', 'workout-3']);
  });
});
