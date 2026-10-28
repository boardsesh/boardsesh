// `countPendingSessionWrites` and `supersedePendingSessionWorkouts` (#6903)
// against the real pending_mutations DDL.

import { describe, it, expect, beforeEach } from 'vitest';
import { countPendingSessionWrites, enqueue, markDeadLetter, supersedePendingSessionWorkouts } from '../queue';
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

describe('supersedePendingSessionWorkouts', () => {
  async function keys(): Promise<string[]> {
    const rows = await db.getAllAsync<{ idempotency_key: string }>(
      'SELECT idempotency_key FROM pending_mutations ORDER BY id',
    );
    return rows.map((row) => row.idempotency_key);
  }

  it("drops only that session's waiting lower revisions, never a tick or a dead letter", async () => {
    await enqueue(db, 'boardsesh_ticks', 'create', tick('session-1'), 'tick-1');
    await enqueue(db, 'session_workouts', 'create', workout('session-1', 1), 'workout-1');
    await enqueue(db, 'session_workouts', 'create', workout('session-1', 2), 'workout-2');
    await markDeadLetter(db, await idOf('workout-2'), 'FORBIDDEN');
    await enqueue(db, 'session_workouts', 'create', workout('session-2', 1), 'workout-3');

    expect(await supersedePendingSessionWorkouts(db, 'session-1', 3)).toEqual({ newerPending: false });

    expect(await keys()).toEqual(['tick-1', 'workout-2', 'workout-3']);
  });

  it('keeps a newer waiting write and says so, when an older one comes in after it', async () => {
    await enqueue(db, 'session_workouts', 'create', workout('session-1', 12), 'workout-12');

    expect(await supersedePendingSessionWorkouts(db, 'session-1', 11)).toEqual({ newerPending: true });
    expect(await keys()).toEqual(['workout-12']);
  });
});

describe('enqueue maxRetries', () => {
  it('stores the retry budget given, and the table default otherwise', async () => {
    await enqueue(db, 'session_workouts', 'create', workout('session-1', 1), 'workout-1', { maxRetries: 3 });
    await enqueue(db, 'boardsesh_ticks', 'create', tick('session-1'), 'tick-1');
    const rows = await db.getAllAsync<{ idempotency_key: string; max_retries: number }>(
      'SELECT idempotency_key, max_retries FROM pending_mutations ORDER BY id',
    );
    expect(rows).toEqual([
      { idempotency_key: 'workout-1', max_retries: 3 },
      { idempotency_key: 'tick-1', max_retries: 10 },
    ]);
  });
});
