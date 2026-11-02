// The run record's fields for the server's copy of the workout (#6903): the
// climbs captured when the run is written, and the write revision.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkoutRun } from '@boardsesh/playlist-generator';

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
    read: (key: string) => entries[key] ?? null,
    write: (key: string, value: unknown) => {
      entries[key] = JSON.stringify(value);
    },
  };
});
vi.mock('@react-native-async-storage/async-storage', () => ({ default: storage }));

import {
  MAX_WORKOUT_REVISION,
  WORKOUT_RUN_STORAGE_KEY,
  WORKOUT_RUN_V2_STORAGE_KEY,
  joinRunClimbs,
  revisionAfter,
  addWorkoutRunClimbs,
  clearWorkoutRunForSession,
  forgetWorkoutRunTick,
  getWorkoutRunState,
  hydrateWorkoutRun,
  nextWorkoutRunRevision,
  noteWorkoutRunTick,
  prepareWorkoutRun,
  resetWorkoutRunStoreForTests,
  setWorkoutRun,
  type WorkoutRunRecord,
} from '../workout-run-store';

const run: WorkoutRun = { stages: [{ id: 'main', kind: 'volume', itemUuids: ['m1', 'm2'] }] };
const addedRun: WorkoutRun = {
  stages: [...run.stages, { id: 'more', kind: 'pyramid', itemUuids: ['p1'] }],
};
const climbs = {
  m1: { climbUuid: 'climb-1', angle: 40 },
  m2: { climbUuid: 'climb-2', angle: 40, isMirror: true },
};
const JAN_2_2026_MS = Date.UTC(2026, 0, 2);

async function flushStorageWrites(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  storage.reset();
  resetWorkoutRunStoreForTests();
});

describe('captured climbs', () => {
  it('rides with a prepared run and survives Add a block, merged with the new items', () => {
    prepareWorkoutRun('session-1', run, climbs);
    setWorkoutRun('session-1', addedRun, { p1: { climbUuid: 'climb-3', angle: 40 } });
    expect(getWorkoutRunState()?.climbs).toEqual({ ...climbs, p1: { climbUuid: 'climb-3', angle: 40 } });
  });

  it('is not carried into another session', () => {
    prepareWorkoutRun('session-1', run, climbs);
    setWorkoutRun('session-2', run);
    expect(getWorkoutRunState()?.climbs).toBeUndefined();
  });

  it('survives a tick and a cold start', async () => {
    prepareWorkoutRun('session-1', run, climbs);
    noteWorkoutRunTick('session-1', { queueItemUuid: 'm1', status: 'send', climbedAt: '2026-10-27T10:00:00Z' });
    await flushStorageWrites();
    resetWorkoutRunStoreForTests();
    await hydrateWorkoutRun('session-1');
    expect(getWorkoutRunState()?.climbs).toEqual(climbs);
  });

  it('reads a run stored without them (an older bundle wrote it), and drops a broken entry alone', async () => {
    storage.write(WORKOUT_RUN_STORAGE_KEY, { sessionId: 'session-1', run });
    await hydrateWorkoutRun('session-1');
    expect(getWorkoutRunState()?.run).toEqual(run);
    expect(getWorkoutRunState()?.climbs).toBeUndefined();

    resetWorkoutRunStoreForTests();
    storage.write(WORKOUT_RUN_STORAGE_KEY, {
      sessionId: 'session-1',
      run,
      climbs: { m1: climbs.m1, m2: { climbUuid: 'climb-2' } },
      revision: 'seven',
    });
    await hydrateWorkoutRun('session-1');
    expect(getWorkoutRunState()?.climbs).toEqual({ m1: climbs.m1 });
    expect(getWorkoutRunState()?.revision).toBeUndefined();
  });

  it('fills in only the climbs the record lacks', () => {
    prepareWorkoutRun('session-1', run, { m1: climbs.m1 });
    addWorkoutRunClimbs('session-1', {
      m1: { climbUuid: 'from-the-queue', angle: 25 },
      m2: climbs.m2,
    });
    expect(getWorkoutRunState()?.climbs).toEqual(climbs);
  });
});

describe('mirror and deleted ticks', () => {
  it('takes the mirror a queue item has now, and nothing else about a climb it already holds', () => {
    prepareWorkoutRun('session-1', run, climbs);
    addWorkoutRunClimbs('session-1', {
      m1: { climbUuid: 'climb-1', angle: 40, isMirror: true },
      m2: { climbUuid: 'climb-2', angle: 40, isMirror: true },
    });
    expect(getWorkoutRunState()?.climbs).toEqual({
      m1: { climbUuid: 'climb-1', angle: 40, isMirror: true },
      m2: { climbUuid: 'climb-2', angle: 40, isMirror: true },
    });
  });

  it('drops a deleted tick from the log', () => {
    prepareWorkoutRun('session-1', run, climbs);
    noteWorkoutRunTick('session-1', {
      queueItemUuid: 'm1',
      status: 'send',
      climbedAt: '2026-10-27T10:00:00Z',
      tickUuid: 't1',
    });
    noteWorkoutRunTick('session-1', {
      queueItemUuid: 'm2',
      status: 'send',
      climbedAt: '2026-10-27T10:01:00Z',
      tickUuid: 't2',
    });
    forgetWorkoutRunTick('t1');
    expect(getWorkoutRunState()?.log?.map((entry) => entry.tickUuid)).toEqual(['t2']);
  });
});

describe('nextWorkoutRunRevision', () => {
  it('climbs on every write and is stored with the run', async () => {
    prepareWorkoutRun('session-1', run, climbs);
    const first = nextWorkoutRunRevision('session-1', JAN_2_2026_MS);
    const second = nextWorkoutRunRevision('session-1', JAN_2_2026_MS);
    expect(first).toBe(86_400);
    expect(second).toBe(86_401);
    await flushStorageWrites();
    const stored = JSON.parse(storage.read(WORKOUT_RUN_STORAGE_KEY) ?? 'null') as WorkoutRunRecord;
    expect(stored.revision).toBe(86_401);
  });

  it('keeps climbing after a rollback dropped the stored revision', () => {
    prepareWorkoutRun('session-1', run, climbs);
    const beforeRollback = nextWorkoutRunRevision('session-1', JAN_2_2026_MS) ?? 0;
    // An older bundle rewrote the run without the field.
    setWorkoutRun('session-2', run);
    setWorkoutRun('session-1', run);
    expect(getWorkoutRunState()?.revision).toBeUndefined();
    const afterRollForward = nextWorkoutRunRevision('session-1', JAN_2_2026_MS + 60_000) ?? 0;
    expect(afterRollForward).toBeGreaterThan(beforeRollback);
  });

  it('stays inside a Postgres integer', () => {
    prepareWorkoutRun('session-1', run, climbs);
    expect(nextWorkoutRunRevision('session-1', Date.UTC(2200, 0, 1))).toBe(MAX_WORKOUT_REVISION);
    expect(Number.isInteger(MAX_WORKOUT_REVISION)).toBe(true);
  });

  it('answers null for another session or none', () => {
    expect(nextWorkoutRunRevision('session-1', JAN_2_2026_MS)).toBeNull();
    prepareWorkoutRun('session-1', run, climbs);
    expect(nextWorkoutRunRevision('session-2', JAN_2_2026_MS)).toBeNull();
  });
});

describe('clearWorkoutRunForSession', () => {
  it('hands the record that went to the caller, at once, for the summary recap', async () => {
    prepareWorkoutRun('session-1', run, climbs);
    const onCleared = vi.fn();
    const clearing = clearWorkoutRunForSession('session-1', onCleared);
    expect(onCleared).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sessionId: 'session-1', climbs }));
    await clearing;
    expect(onCleared).toHaveBeenCalledTimes(1);
    expect(getWorkoutRunState()).toBeNull();
  });

  it('hands over a run only the disk held', async () => {
    storage.write(WORKOUT_RUN_STORAGE_KEY, { sessionId: 'session-1', run, climbs });
    const onCleared = vi.fn();
    await clearWorkoutRunForSession('session-1', onCleared);
    expect(onCleared).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sessionId: 'session-1', climbs }));
    expect(storage.read(WORKOUT_RUN_STORAGE_KEY)).toBeNull();
  });

  it('hands over nothing when no run named the session', async () => {
    prepareWorkoutRun('session-2', run, climbs);
    const onCleared = vi.fn();
    await clearWorkoutRunForSession('session-1', onCleared);
    expect(onCleared).not.toHaveBeenCalled();
  });
});

describe('revisionAfter', () => {
  it('counts up from the last revision, floored at the seconds since 2026', () => {
    expect(revisionAfter(undefined, JAN_2_2026_MS)).toBe(86_400);
    expect(revisionAfter(86_400, JAN_2_2026_MS)).toBe(86_401);
    // A rollback dropped the field: the floor still beats what the server holds.
    expect(revisionAfter(3, JAN_2_2026_MS)).toBe(86_400);
    // A clock set back: the counter still climbs.
    expect(revisionAfter(90_000, JAN_2_2026_MS)).toBe(90_001);
  });

  it('never passes a Postgres integer', () => {
    expect(revisionAfter(MAX_WORKOUT_REVISION, JAN_2_2026_MS)).toBe(MAX_WORKOUT_REVISION);
    expect(revisionAfter(undefined, Date.UTC(2200, 0, 1))).toBe(MAX_WORKOUT_REVISION);
  });
});

describe('joinRunClimbs', () => {
  it("keeps the earlier map's climb for an item both name, and every other item", () => {
    expect(joinRunClimbs({ a: climbs.m1 }, { a: climbs.m2, b: climbs.m2 })).toEqual({ a: climbs.m1, b: climbs.m2 });
    expect(joinRunClimbs(undefined, { b: climbs.m2 })).toEqual({ b: climbs.m2 });
    expect(joinRunClimbs({ a: climbs.m1 }, undefined)).toEqual({ a: climbs.m1 });
    expect(joinRunClimbs(undefined, undefined)).toBeUndefined();
  });
});

describe('both slots naming one session (a rollback mid-session)', () => {
  it("joins the climbs (the v2 slot's copy wins on a shared item) and keeps the higher revision", async () => {
    storage.write(WORKOUT_RUN_V2_STORAGE_KEY, {
      sessionId: 'session-1',
      run: { stages: [{ id: 'four', kind: 'fourByFour', itemUuids: ['f1'] }] },
      climbs: { f1: { climbUuid: 'climb-f1', angle: 40 }, shared: { climbUuid: 'from-v2', angle: 40 } },
      revision: 50,
      sentDigest: 'v2-copy',
    });
    storage.write(WORKOUT_RUN_STORAGE_KEY, {
      sessionId: 'session-1',
      run: { stages: [{ id: 'vol', kind: 'volume', itemUuids: ['v1'] }] },
      climbs: { v1: { climbUuid: 'climb-v1', angle: 40 }, shared: { climbUuid: 'from-v1', angle: 40 } },
      revision: 70,
    });

    await hydrateWorkoutRun('session-1');

    const merged = getWorkoutRunState();
    expect(merged?.run.stages.map((stage) => stage.id)).toEqual(['four', 'vol']);
    expect(merged?.climbs).toEqual({
      f1: { climbUuid: 'climb-f1', angle: 40 },
      v1: { climbUuid: 'climb-v1', angle: 40 },
      shared: { climbUuid: 'from-v2', angle: 40 },
    });
    expect(merged?.revision).toBe(70);
    // Neither slot's copy holds the merged run: the next write must go out.
    expect(merged?.sentDigest).toBeUndefined();
  });
});
