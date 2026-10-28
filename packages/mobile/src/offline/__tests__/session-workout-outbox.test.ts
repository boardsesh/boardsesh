// The workout's trip to the server (#6903): queued through the real outbox
// table at a fresh revision, after the ticks already queued, never for a
// session id the server never minted.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueryClient } from '@tanstack/react-query';
import type { ClimbQueueItem } from '@boardsesh/queue';
import { createTestDatabase, type TestSqliteDb } from '@boardsesh/offline-sync/testing';
import { enqueue, peekPending, runMigrations, stampLocalUserId } from '@boardsesh/offline-sync';

const mocks = vi.hoisted(() => ({
  db: null as object | null,
  drainMutationQueue: vi.fn(() => Promise.resolve()),
  request: vi.fn(async () => ({ recordSessionWorkout: true })),
  reportHandledError: vi.fn(),
  now: Date.UTC(2026, 0, 2),
  account: { status: 'signed-in', userId: 'user-1' } as { status: string; userId?: string },
  accountReadFails: false,
  // Lets a test hold one write's account read open while another goes ahead.
  accountReadGate: [] as Array<PromiseWithResolvers<void>>,
}));
const storage = vi.hoisted(() => {
  let entries: Record<string, string> = {};
  return {
    getItem: vi.fn(async (key: string) => entries[key] ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      entries[key] = value;
    }),
    removeItem: vi.fn(async (key: string) => {
      delete entries[key];
    }),
    reset: () => {
      entries = {};
    },
  };
});
vi.mock('@react-native-async-storage/async-storage', () => ({ default: storage }));
vi.mock('../../db', () => ({ getDatabaseHandle: () => mocks.db }));
vi.mock('../../lib/graphql/client', () => ({ getOfflineSyncHttpClient: () => ({ request: mocks.request }) }));
vi.mock('../../lib/error-reporting', () => ({ reportHandledError: mocks.reportHandledError }));
vi.mock('../../lib/clock', () => ({ nowMs: () => mocks.now }));
vi.mock('../offline-sync-adapter', () => ({
  drainMutationQueue: mocks.drainMutationQueue,
  // The real helper never rejects; a failed read answers null.
  readSignedInUserIdOrNull: async () => {
    await mocks.accountReadGate.shift()?.promise;
    if (mocks.accountReadFails || mocks.account.status !== 'signed-in') return null;
    return mocks.account.userId ?? null;
  },
}));
vi.mock('../outbox-store', () => ({ notifyOutboxChanged: vi.fn() }));
vi.mock('../local-write-telemetry', () => ({ localWriteRetryOptions: () => ({}) }));

import {
  SESSION_WORKOUTS_OUTBOX_TABLE,
  enqueueEndedSessionWorkout,
  enqueueSessionWorkoutWrite,
  sessionWorkoutIdempotencyKey,
} from '../session-workout-outbox';
import {
  clearWorkoutRunForSession,
  getWorkoutRunState,
  noteWorkoutRunTick,
  prepareWorkoutRun,
  resetWorkoutRunStoreForTests,
  setWorkoutRun,
  type WorkoutRunRecord,
} from '../../lib/workout-run-store';

const SESSION_ID = '6f1c2a8e-3b4d-4c5e-9f60-7a8b9c0d1e2f';
const queryClient = { invalidateQueries: vi.fn() } as unknown as QueryClient;
const run = { stages: [{ id: 'main', kind: 'volume' as const, itemUuids: ['q1', 'q2'] }] };
const climbs = { q1: { climbUuid: 'climb-1', angle: 40 }, q2: { climbUuid: 'climb-2', angle: 40 } };

let db: TestSqliteDb;

async function queued(): Promise<Array<{ table: string; key: string; input: Record<string, unknown> }>> {
  return (await peekPending(db, 100)).map((row) => ({
    table: row.table_name,
    key: row.idempotency_key,
    input: JSON.parse(row.payload) as Record<string, unknown>,
  }));
}

beforeEach(async () => {
  storage.reset();
  resetWorkoutRunStoreForTests();
  db = createTestDatabase();
  await runMigrations(db);
  await stampLocalUserId(db, 'user-1');
  mocks.db = db;
  mocks.account = { status: 'signed-in', userId: 'user-1' };
  mocks.accountReadFails = false;
  mocks.accountReadGate = [];
  mocks.now = Date.UTC(2026, 0, 2);
  mocks.drainMutationQueue.mockClear();
  mocks.request.mockClear();
  mocks.reportHandledError.mockClear();
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('enqueueSessionWorkoutWrite', () => {
  it('queues the whole workout at a new revision and starts a drain (Start)', async () => {
    prepareWorkoutRun(SESSION_ID, run, climbs);

    expect(await enqueueSessionWorkoutWrite(SESSION_ID, { queryClient })).toBe('queued');

    const rows = await queued();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.table).toBe(SESSION_WORKOUTS_OUTBOX_TABLE);
    expect(rows[0]?.key).toBe(sessionWorkoutIdempotencyKey(SESSION_ID, 86_400));
    expect(rows[0]?.input).toEqual({
      sessionId: SESSION_ID,
      revision: 86_400,
      stages: [
        {
          id: 'main',
          kind: 'volume',
          items: [
            { queueItemUuid: 'q1', climbUuid: 'climb-1', angle: 40 },
            { queueItemUuid: 'q2', climbUuid: 'climb-2', angle: 40 },
          ],
        },
      ],
      ticks: [],
    });
    expect(mocks.drainMutationQueue).toHaveBeenCalledTimes(1);
  });

  it('replaces the waiting copy with a higher revision on Add a block, and keeps it behind the ticks', async () => {
    prepareWorkoutRun(SESSION_ID, run, climbs);
    await enqueueSessionWorkoutWrite(SESSION_ID, { queryClient });
    await enqueue(db, 'boardsesh_ticks', 'create', { sessionId: SESSION_ID, climbUuid: 'climb-1' }, 'tick-1');
    noteWorkoutRunTick(SESSION_ID, {
      queueItemUuid: 'q1',
      status: 'send',
      climbedAt: '2026-10-28T10:00:00Z',
      tickUuid: 'tick-1',
    });
    setWorkoutRun(
      SESSION_ID,
      { stages: [...run.stages, { id: 'more', kind: 'pyramid', itemUuids: ['q3'] }] },
      { q3: { climbUuid: 'climb-3', angle: 40 } },
    );

    await enqueueSessionWorkoutWrite(SESSION_ID, { queryClient });

    const rows = await queued();
    // FIFO: the tick first, then the one workout copy left.
    expect(rows.map((row) => row.table)).toEqual(['boardsesh_ticks', SESSION_WORKOUTS_OUTBOX_TABLE]);
    const workout = rows[1]?.input;
    expect(workout?.revision).toBe(86_401);
    expect(workout?.stages).toHaveLength(2);
    expect(workout?.ticks).toEqual([{ tickUuid: 'tick-1', queueItemUuid: 'q1' }]);
  });

  it('fills a climb the run never captured from the live queue before the last write', async () => {
    prepareWorkoutRun(SESSION_ID, run, { q1: climbs.q1 });
    const queueItems = [
      { uuid: 'q2', climb: { uuid: 'climb-2', angle: 40 } },
      { uuid: 'hand-queued', climb: { uuid: 'climb-9', angle: 40 } },
    ] as unknown as ClimbQueueItem[];

    await enqueueSessionWorkoutWrite(SESSION_ID, { queryClient, queueItems });

    const [row] = await queued();
    expect(row?.input.stages).toEqual([
      expect.objectContaining({
        items: [expect.objectContaining({ queueItemUuid: 'q1' }), expect.objectContaining({ queueItemUuid: 'q2' })],
      }),
    ]);
  });

  it('never sends for a story or fake session, nor in a screenshot capture', async () => {
    prepareWorkoutRun('story-summary-workout', run, climbs);
    expect(await enqueueSessionWorkoutWrite('story-summary-workout', { queryClient })).toBe('skipped');

    prepareWorkoutRun(SESSION_ID, run, climbs);
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
    expect(await enqueueSessionWorkoutWrite(SESSION_ID, { queryClient })).toBe('skipped');

    expect(await queued()).toEqual([]);
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('sends nothing when the store holds no run for the session', async () => {
    prepareWorkoutRun('0e1c2a8e-3b4d-4c5e-9f60-7a8b9c0d1e2f', run, climbs);
    expect(await enqueueSessionWorkoutWrite(SESSION_ID, { queryClient })).toBe('skipped');
    expect(await queued()).toEqual([]);
  });

  it('sends straight to the server when there is no offline database', async () => {
    mocks.db = null;
    prepareWorkoutRun(SESSION_ID, run, climbs);

    expect(await enqueueSessionWorkoutWrite(SESSION_ID, { queryClient })).toBe('sent');

    expect(mocks.request).toHaveBeenCalledWith(
      expect.stringContaining('recordSessionWorkout(input: $input)'),
      expect.objectContaining({ input: expect.objectContaining({ sessionId: SESSION_ID, revision: 86_400 }) }),
    );
  });

  it('reports a direct send that failed, without throwing', async () => {
    mocks.db = null;
    mocks.request.mockRejectedValueOnce(new Error('offline'));
    prepareWorkoutRun(SESSION_ID, run, climbs);

    expect(await enqueueSessionWorkoutWrite(SESSION_ID, { queryClient })).toBe('failed');
    expect(mocks.reportHandledError).toHaveBeenCalledTimes(1);
  });

  it('queues nothing into an outbox stamped for another account, or for none', async () => {
    prepareWorkoutRun(SESSION_ID, run, climbs);
    await stampLocalUserId(db, 'user-2');
    expect(await enqueueSessionWorkoutWrite(SESSION_ID, { queryClient })).toBe('skipped');

    mocks.account = { status: 'unsettled' };
    await stampLocalUserId(db, 'user-1');
    expect(await enqueueSessionWorkoutWrite(SESSION_ID, { queryClient })).toBe('skipped');

    expect(await queued()).toEqual([]);
  });

  it('gives the higher revision to the newer run when two writes overlap', async () => {
    prepareWorkoutRun(SESSION_ID, run, climbs);
    // The Add a block write starts, and its account read is slow...
    const slowRead = Promise.withResolvers<void>();
    mocks.accountReadGate.push(slowRead, Promise.withResolvers<void>());
    mocks.accountReadGate[1]?.resolve();
    const addBlock = enqueueSessionWorkoutWrite(SESSION_ID, { queryClient });
    // ...the run grows meanwhile, and the End write goes ahead of it.
    setWorkoutRun(
      SESSION_ID,
      { stages: [...run.stages, { id: 'more', kind: 'pyramid', itemUuids: ['q3'] }] },
      { q3: { climbUuid: 'climb-3', angle: 40 } },
    );
    const end = enqueueSessionWorkoutWrite(SESSION_ID, { queryClient });
    await end;
    slowRead.resolve();
    await addBlock;

    const rows = await queued();
    // Whatever was queued last holds the grown run at the highest revision.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.input.stages).toHaveLength(2);
  });

  it('queues nothing, and never throws, when the token cannot be read', async () => {
    prepareWorkoutRun(SESSION_ID, run, climbs);
    mocks.accountReadFails = true;
    await expect(enqueueSessionWorkoutWrite(SESSION_ID, { queryClient })).resolves.toBe('skipped');
    expect(await queued()).toEqual([]);
  });

  it('skips a write with nothing new since the last copy', async () => {
    prepareWorkoutRun(SESSION_ID, run, climbs);
    expect(await enqueueSessionWorkoutWrite(SESSION_ID, { queryClient })).toBe('queued');
    expect(await enqueueSessionWorkoutWrite(SESSION_ID, { queryClient })).toBe('skipped');
    expect(await queued()).toHaveLength(1);
    expect(getWorkoutRunState()?.revision).toBe(86_400);
  });

  it('never leaves an older copy last when a newer one got into the outbox first', async () => {
    prepareWorkoutRun(SESSION_ID, run, climbs);
    // A newer write whose transaction ran first.
    const newer = { sessionId: SESSION_ID, revision: 99_999_999, stages: [], ticks: [] };
    await enqueue(
      db,
      SESSION_WORKOUTS_OUTBOX_TABLE,
      'create',
      newer,
      sessionWorkoutIdempotencyKey(SESSION_ID, 99_999_999),
    );

    expect(await enqueueSessionWorkoutWrite(SESSION_ID, { queryClient })).toBe('skipped');

    expect((await queued()).map((row) => row.input.revision)).toEqual([99_999_999]);
  });

  it('takes a climb mirrored since Start from the live queue at the last write', async () => {
    prepareWorkoutRun(SESSION_ID, run, climbs);
    await enqueueSessionWorkoutWrite(SESSION_ID, { queryClient });
    const queueItems = [
      { uuid: 'q2', climb: { uuid: 'climb-2', angle: 40, mirrored: true } },
    ] as unknown as ClimbQueueItem[];

    expect(await enqueueSessionWorkoutWrite(SESSION_ID, { queryClient, queueItems })).toBe('queued');

    const [row] = await queued();
    expect(row?.input.stages).toEqual([
      expect.objectContaining({
        items: [
          { queueItemUuid: 'q1', climbUuid: 'climb-1', angle: 40 },
          { queueItemUuid: 'q2', climbUuid: 'climb-2', angle: 40, isMirror: true },
        ],
      }),
    ]);
  });
});

describe('enqueueEndedSessionWorkout (the session ended some other way)', () => {
  async function clearedRecord(sessionId = SESSION_ID): Promise<WorkoutRunRecord> {
    const cleared: WorkoutRunRecord[] = [];
    await clearWorkoutRunForSession(sessionId, (record) => cleared.push(record));
    const [record] = cleared;
    if (!record) throw new Error('nothing was cleared');
    return record;
  }

  it('sends the tick map when the session ended on another phone after the last copy', async () => {
    prepareWorkoutRun(SESSION_ID, run, climbs);
    await enqueueSessionWorkoutWrite(SESSION_ID, { queryClient });
    noteWorkoutRunTick(SESSION_ID, {
      queueItemUuid: 'q2',
      status: 'attempt',
      climbedAt: '2026-10-28T10:00:00Z',
      tickUuid: 'tick-9',
    });
    // A remote SessionEnded: no beforeEnd, the run is just cleared.
    const record = await clearedRecord();
    mocks.now += 1000;

    expect(await enqueueEndedSessionWorkout(record, { queryClient, ownerUserId: 'user-1' })).toBe('queued');

    const rows = await queued();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.input.revision).toBe(86_401);
    expect(rows[0]?.input.ticks).toEqual([{ tickUuid: 'tick-9', queueItemUuid: 'q2' }]);
  });

  it('sends nothing more after a local End already sent the same copy', async () => {
    prepareWorkoutRun(SESSION_ID, run, climbs);
    // The End button's write from beforeEnd.
    await enqueueSessionWorkoutWrite(SESSION_ID, { queryClient });
    const record = await clearedRecord();

    expect(await enqueueEndedSessionWorkout(record, { queryClient, ownerUserId: 'user-1' })).toBe('skipped');
    expect(await queued()).toHaveLength(1);
  });

  it('never sends for a story session', async () => {
    prepareWorkoutRun('story-summary-workout', run, climbs);
    const record = await clearedRecord('story-summary-workout');
    expect(await enqueueEndedSessionWorkout(record, { queryClient, ownerUserId: 'user-1' })).toBe('skipped');
  });

  it('sends again when the End copy dead-lettered, so the server never stays on an older copy', async () => {
    prepareWorkoutRun(SESSION_ID, run, climbs);
    noteWorkoutRunTick(SESSION_ID, {
      queueItemUuid: 'q1',
      status: 'send',
      climbedAt: '2026-10-28T10:00:00Z',
      tickUuid: 'tick-1',
    });
    // The End button's copy, then a minute of resolver errors kills it.
    await enqueueSessionWorkoutWrite(SESSION_ID, { queryClient });
    const [endCopy] = await peekPending(db, 1);
    if (!endCopy) throw new Error('the End copy was not queued');
    await db.runAsync("UPDATE pending_mutations SET status = 'dead_letter', last_error = ? WHERE id = ?", [
      'INTERNAL_SERVER_ERROR',
      endCopy.id,
    ]);
    const record = await clearedRecord();

    expect(await enqueueEndedSessionWorkout(record, { queryClient, ownerUserId: 'user-1' })).toBe('queued');

    const rows = await queued();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.input.revision).toBe(86_401);
    expect(rows[0]?.input.ticks).toEqual([{ tickUuid: 'tick-1', queueItemUuid: 'q1' }]);
    // The dead copy it replaces is gone from Sync issues.
    const dead = await db.getAllAsync<{ id: number }>("SELECT id FROM pending_mutations WHERE status = 'dead_letter'");
    expect(dead).toEqual([]);
  });

  it('keeps the cleared copy out of an outbox that now belongs to someone else', async () => {
    prepareWorkoutRun(SESSION_ID, run, climbs);
    const record = await clearedRecord();
    // Sign-out wiped the outbox and the next account stamped it.
    await stampLocalUserId(db, 'user-2');

    expect(await enqueueEndedSessionWorkout(record, { queryClient, ownerUserId: 'user-1' })).toBe('skipped');
    expect(await enqueueEndedSessionWorkout(record, { queryClient, ownerUserId: null })).toBe('skipped');
    expect(await queued()).toEqual([]);
  });
});
