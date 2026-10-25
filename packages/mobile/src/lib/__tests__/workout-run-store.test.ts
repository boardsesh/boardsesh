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
  };
});
vi.mock('@react-native-async-storage/async-storage', () => ({ default: storage }));

import {
  MAX_WORKOUT_TICK_LOG,
  WORKOUT_RUN_STORAGE_KEY,
  WORKOUT_RUN_V2_STORAGE_KEY,
  clearWorkoutRun,
  clearWorkoutRunForSession,
  countWorkoutRunTicks,
  getWorkoutRunForSession,
  getWorkoutRunLog,
  getWorkoutRunState,
  hydrateWorkoutRun,
  noteWorkoutRunTick,
  resetWorkoutRunStoreForTests,
  setWorkoutRun,
  subscribeWorkoutRun,
  workoutRunStorageKey,
  type WorkoutTickLogEntry,
} from '../workout-run-store';

const run: WorkoutRun = {
  stages: [
    { id: 'warm', kind: 'warmUp', itemUuids: ['w1', 'w2'] },
    { id: 'main', kind: 'volume', itemUuids: ['m1', 'm2', 'm3'] },
  ],
};

async function flushStorageWrites(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function storedRecord(key: string = WORKOUT_RUN_STORAGE_KEY): unknown {
  const raw = storage.read(key);
  return raw === null ? null : JSON.parse(raw);
}

// A 4x4 behind a warm-up, as Start would store it: four sets, one climb each.
const timedRun: WorkoutRun = {
  stages: [
    { id: 'warm', kind: 'warmUp', itemUuids: ['w1'] },
    {
      id: 'four',
      kind: 'fourByFour',
      itemUuids: ['a', 'b', 'c', 'd'],
      targetGrade: 18,
      pacing: {
        mode: 'afterTick',
        restSeconds: 0,
        advanceOn: 'set',
        sets: { repsPerSet: 4, restBetweenSetsSeconds: 180 },
      },
    },
  ],
};

function tick(queueItemUuid: string, status: WorkoutTickLogEntry['status'] = 'attempt'): WorkoutTickLogEntry {
  return { queueItemUuid, status, climbedAt: '2026-10-24T12:00:00.000Z' };
}

beforeEach(() => {
  resetWorkoutRunStoreForTests();
  storage.reset();
  storage.getItem.mockClear();
});

describe('workout-run-store', () => {
  it('holds and persists the run for its session', async () => {
    const listener = vi.fn();
    subscribeWorkoutRun(listener);

    setWorkoutRun('session-1', run);
    await flushStorageWrites();

    expect(getWorkoutRunForSession('session-1')).toBe(run);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(storedRecord()).toEqual({ sessionId: 'session-1', run });
  });

  it('answers null for another session', () => {
    setWorkoutRun('session-1', run);
    expect(getWorkoutRunForSession('session-2')).toBeNull();
    expect(getWorkoutRunForSession(null)).toBeNull();
  });

  it('hydrates the stored run after a cold start', async () => {
    setWorkoutRun('session-1', run);
    await flushStorageWrites();
    resetWorkoutRunStoreForTests();

    await hydrateWorkoutRun('session-1');

    expect(getWorkoutRunForSession('session-1')).toEqual(run);
  });

  it('misses a stored run that belongs to a different session', async () => {
    setWorkoutRun('session-1', run);
    await flushStorageWrites();
    resetWorkoutRunStoreForTests();

    await hydrateWorkoutRun('session-2');

    expect(getWorkoutRunState()).toBeNull();
  });

  it('ignores a stored value with the wrong shape', async () => {
    await storage.setItem(WORKOUT_RUN_STORAGE_KEY, JSON.stringify({ sessionId: 'session-1', run: { stages: 'no' } }));

    await hydrateWorkoutRun('session-1');

    expect(getWorkoutRunState()).toBeNull();
  });

  it('ignores a stored run whose climb ids are not strings', async () => {
    await storage.setItem(
      WORKOUT_RUN_STORAGE_KEY,
      JSON.stringify({ sessionId: 'session-1', run: { stages: [{ id: 's', kind: 'volume', itemUuids: [7] }] } }),
    );

    await hydrateWorkoutRun('session-1');

    expect(getWorkoutRunState()).toBeNull();
  });

  it('hydrates a stage target grade, and ignores one that is not a number', async () => {
    const graded: WorkoutRun = { stages: [{ id: 'main', kind: 'ladder', itemUuids: ['l1'], targetGrade: 20 }] };
    setWorkoutRun('session-1', graded);
    await flushStorageWrites();
    resetWorkoutRunStoreForTests();
    await hydrateWorkoutRun('session-1');
    expect(getWorkoutRunForSession('session-1')).toEqual(graded);

    resetWorkoutRunStoreForTests();
    await storage.setItem(
      WORKOUT_RUN_STORAGE_KEY,
      JSON.stringify({
        sessionId: 'session-1',
        run: { stages: [{ id: 's', kind: 'volume', itemUuids: ['v1'], targetGrade: 'V5' }] },
      }),
    );
    await hydrateWorkoutRun('session-1');
    expect(getWorkoutRunState()).toBeNull();
  });

  it("hydrates each stage's filters, warm-ups included", async () => {
    const filtered: WorkoutRun = {
      stages: [
        {
          id: 'warm',
          kind: 'warmUp',
          itemUuids: ['w1'],
          filters: { climbBias: 'any', minAscents: 0, minRating: 0, onlyTallClimbs: false, onlyWideClimbs: false },
        },
        {
          id: 'main',
          kind: 'volume',
          itemUuids: ['v1'],
          targetGrade: 18,
          filters: {
            climbBias: 'attempted',
            minAscents: 50,
            minRating: 3,
            onlyTallClimbs: true,
            onlyWideClimbs: false,
          },
        },
      ],
    };
    setWorkoutRun('session-1', filtered);
    await flushStorageWrites();
    resetWorkoutRunStoreForTests();

    await hydrateWorkoutRun('session-1');

    expect(getWorkoutRunForSession('session-1')).toEqual(filtered);
  });

  it('still loads a run stored before stages kept their filters, under the same key', async () => {
    // Written by the previous bundle: no `filters` on any stage.
    await storage.setItem(
      WORKOUT_RUN_STORAGE_KEY,
      JSON.stringify({
        sessionId: 'session-1',
        run: {
          stages: [
            { id: 'warm', kind: 'warmUp', itemUuids: ['w1'] },
            { id: 'main', kind: 'pyramid', itemUuids: ['p1'], targetGrade: 18 },
          ],
        },
      }),
    );

    await hydrateWorkoutRun('session-1');

    expect(getWorkoutRunForSession('session-1')?.stages.map((stage) => stage.filters)).toEqual([undefined, undefined]);
  });

  it('keeps a stage whose stored filters are unreadable, without them', async () => {
    const goodFilters = { climbBias: 'any', minAscents: 0, minRating: 0, onlyTallClimbs: false, onlyWideClimbs: false };
    await storage.setItem(
      WORKOUT_RUN_STORAGE_KEY,
      JSON.stringify({
        sessionId: 'session-1',
        run: {
          stages: [
            { id: 'warm', kind: 'warmUp', itemUuids: ['w1'], filters: { minAscents: '5' } },
            // A climb bias this bundle does not know, as a newer bundle might write.
            {
              id: 'main',
              kind: 'volume',
              itemUuids: ['v1'],
              targetGrade: 18,
              filters: { ...goodFilters, climbBias: 'fresh' },
            },
            { id: 'last', kind: 'ladder', itemUuids: ['l1'], filters: goodFilters },
          ],
        },
      }),
    );

    await hydrateWorkoutRun('session-1');

    expect(getWorkoutRunForSession('session-1')).toEqual({
      stages: [
        { id: 'warm', kind: 'warmUp', itemUuids: ['w1'] },
        { id: 'main', kind: 'volume', itemUuids: ['v1'], targetGrade: 18 },
        { id: 'last', kind: 'ladder', itemUuids: ['l1'], filters: goodFilters },
      ],
    });
  });

  it('does not let a slow hydrate overwrite a run written meanwhile', async () => {
    setWorkoutRun('session-1', { stages: [{ id: 'old', kind: 'volume', itemUuids: ['x'] }] });
    await flushStorageWrites();
    resetWorkoutRunStoreForTests();

    const hydrate = hydrateWorkoutRun('session-1');
    setWorkoutRun('session-1', run);
    await hydrate;

    expect(getWorkoutRunForSession('session-1')).toBe(run);
  });

  it('skips the storage read when the session is already in memory', async () => {
    setWorkoutRun('session-1', run);
    await hydrateWorkoutRun('session-1');
    expect(storage.getItem).not.toHaveBeenCalled();
  });

  it('clears only the session that ended', async () => {
    setWorkoutRun('session-1', run);

    await clearWorkoutRunForSession('session-2');
    expect(getWorkoutRunForSession('session-1')).toBe(run);

    await clearWorkoutRunForSession('session-1');
    expect(getWorkoutRunState()).toBeNull();
    expect(storedRecord()).toBeNull();
  });

  it('does not let a hydrate land after its session ended', async () => {
    setWorkoutRun('session-1', run);
    await flushStorageWrites();
    resetWorkoutRunStoreForTests();

    // Restore starts reading the slot, then the session ends before it lands.
    const hydrate = hydrateWorkoutRun('session-1');
    const clear = clearWorkoutRunForSession('session-1');
    await hydrate;
    await clear;

    expect(getWorkoutRunState()).toBeNull();
    expect(storedRecord()).toBeNull();
  });

  it('removes the stored slot for an ended session that was never read into memory', async () => {
    setWorkoutRun('session-1', run);
    await flushStorageWrites();
    resetWorkoutRunStoreForTests();

    await clearWorkoutRunForSession('session-1');

    expect(storedRecord()).toBeNull();
  });

  it('keeps the stored slot when another session ended', async () => {
    setWorkoutRun('session-1', run);
    await flushStorageWrites();
    resetWorkoutRunStoreForTests();

    await clearWorkoutRunForSession('session-2');

    expect(storedRecord()).toEqual({ sessionId: 'session-1', run });
  });

  it('forgets the run in memory and on disk at sign-out', async () => {
    setWorkoutRun('session-1', run);
    await flushStorageWrites();

    await clearWorkoutRun();

    expect(getWorkoutRunState()).toBeNull();
    expect(storedRecord()).toBeNull();
    await hydrateWorkoutRun('session-1');
    expect(getWorkoutRunState()).toBeNull();
  });
});

describe('workout-run-store: timed stages and the storage slot', () => {
  it('keeps a run of the original kinds under _v1, where every older bundle reads it', async () => {
    setWorkoutRun('session-1', run);
    await flushStorageWrites();

    expect(workoutRunStorageKey(run)).toBe(WORKOUT_RUN_STORAGE_KEY);
    expect(storedRecord(WORKOUT_RUN_STORAGE_KEY)).toEqual({ sessionId: 'session-1', run });
    expect(storedRecord(WORKOUT_RUN_V2_STORAGE_KEY)).toBeNull();
  });

  it('writes a run with a timed stage under _v2 only, so a rolled-back bundle never reads it', async () => {
    setWorkoutRun('session-1', run);
    await flushStorageWrites();
    setWorkoutRun('session-1', timedRun);
    await flushStorageWrites();

    expect(workoutRunStorageKey(timedRun)).toBe(WORKOUT_RUN_V2_STORAGE_KEY);
    expect(storedRecord(WORKOUT_RUN_V2_STORAGE_KEY)).toEqual({ sessionId: 'session-1', run: timedRun });
    // What a bundle from before the timed kinds reads: nothing, so its "Add a block" cannot trip on them.
    expect(storedRecord(WORKOUT_RUN_STORAGE_KEY)).toBeNull();
  });

  it('moves back to _v1 when the next run has only the original kinds', async () => {
    setWorkoutRun('session-1', timedRun);
    await flushStorageWrites();
    setWorkoutRun('session-2', run);
    await flushStorageWrites();

    expect(storedRecord(WORKOUT_RUN_STORAGE_KEY)).toEqual({ sessionId: 'session-2', run });
    expect(storedRecord(WORKOUT_RUN_V2_STORAGE_KEY)).toBeNull();
  });

  it('hydrates a timed run with its pacing, a 4x4’s sets included', async () => {
    setWorkoutRun('session-1', timedRun);
    await flushStorageWrites();
    resetWorkoutRunStoreForTests();

    await hydrateWorkoutRun('session-1');

    expect(getWorkoutRunForSession('session-1')).toEqual(timedRun);
  });

  it('hydrates whichever slot names the session when the slots hold different sessions', async () => {
    await storage.setItem(WORKOUT_RUN_V2_STORAGE_KEY, JSON.stringify({ sessionId: 'session-1', run: timedRun }));
    await storage.setItem(WORKOUT_RUN_STORAGE_KEY, JSON.stringify({ sessionId: 'session-2', run }));

    await hydrateWorkoutRun('session-2');
    expect(getWorkoutRunForSession('session-2')).toEqual(run);

    resetWorkoutRunStoreForTests();
    await hydrateWorkoutRun('session-1');
    expect(getWorkoutRunForSession('session-1')).toEqual(timedRun);
  });

  it('keeps both parts of a run split across the slots by a rollback mid-session', async () => {
    // This bundle starts a 4x4 and logs a tick on it: the run sits in _v2 only.
    setWorkoutRun('session-1', timedRun);
    noteWorkoutRunTick('session-1', tick('a', 'send'));
    await flushStorageWrites();
    // Rolled back to a bundle from before the timed kinds. It reads only _v1, finds
    // nothing, and its "Add a block" stores the block alone there, with no log.
    const blockAddedAfterRollback = { id: 'later', kind: 'volume', itemUuids: ['v1', 'v2'], targetGrade: 16 } as const;
    await storage.setItem(
      WORKOUT_RUN_STORAGE_KEY,
      JSON.stringify({ sessionId: 'session-1', run: { stages: [blockAddedAfterRollback] } }),
    );
    resetWorkoutRunStoreForTests();

    // Rolled forward: neither copy alone is the run.
    await hydrateWorkoutRun('session-1');

    expect(getWorkoutRunForSession('session-1')).toEqual({ stages: [...timedRun.stages, blockAddedAfterRollback] });
    expect(getWorkoutRunLog('session-1')).toEqual([tick('a', 'send')]);
    // Nothing is written back, so a second rollback still finds its block.
    expect(storedRecord(WORKOUT_RUN_STORAGE_KEY)).toEqual({
      sessionId: 'session-1',
      run: { stages: [blockAddedAfterRollback] },
    });

    // The next write stores the whole run under _v2 and empties _v1.
    noteWorkoutRunTick('session-1', tick('v1'));
    await flushStorageWrites();
    expect(storedRecord(WORKOUT_RUN_V2_STORAGE_KEY)).toEqual({
      sessionId: 'session-1',
      run: { stages: [...timedRun.stages, blockAddedAfterRollback] },
      log: [tick('a', 'send'), tick('v1')],
    });
    expect(storedRecord(WORKOUT_RUN_STORAGE_KEY)).toBeNull();
  });

  it('reads a leftover copy of the same run in both slots once', async () => {
    // A write to _v2 whose remove of _v1 failed: _v1 still holds the run as it was
    // before the 4x4 was added.
    const withFourByFour: WorkoutRun = { stages: [...run.stages, timedRun.stages[1]] };
    await storage.setItem(
      WORKOUT_RUN_V2_STORAGE_KEY,
      JSON.stringify({ sessionId: 'session-1', run: withFourByFour, log: [tick('m1'), tick('a')] }),
    );
    await storage.setItem(WORKOUT_RUN_STORAGE_KEY, JSON.stringify({ sessionId: 'session-1', run, log: [tick('m1')] }));

    await hydrateWorkoutRun('session-1');

    expect(getWorkoutRunState()).toEqual({
      sessionId: 'session-1',
      run: withFourByFour,
      log: [tick('m1'), tick('a')],
    });
  });

  it('keeps a tick in both slots once by its uuid, even when its times differ', async () => {
    const inV2 = { ...tick('a', 'send'), tickUuid: 'tick-1' };
    const inV1 = { ...inV2, climbedAt: '2026-10-24T12:05:00.000Z' };
    await storage.setItem(
      WORKOUT_RUN_V2_STORAGE_KEY,
      JSON.stringify({ sessionId: 'session-1', run: timedRun, log: [inV2] }),
    );
    await storage.setItem(WORKOUT_RUN_STORAGE_KEY, JSON.stringify({ sessionId: 'session-1', run, log: [inV1] }));

    await hydrateWorkoutRun('session-1');

    expect(getWorkoutRunLog('session-1')).toEqual([inV2]);
  });

  it('keeps two attempts on one climb with no tick uuid when their times differ', async () => {
    const first = tick('a', 'attempt');
    const second = { ...first, climbedAt: '2026-10-24T12:05:00.000Z' };
    await storage.setItem(
      WORKOUT_RUN_V2_STORAGE_KEY,
      JSON.stringify({ sessionId: 'session-1', run: timedRun, log: [first] }),
    );
    await storage.setItem(WORKOUT_RUN_STORAGE_KEY, JSON.stringify({ sessionId: 'session-1', run, log: [second] }));

    await hydrateWorkoutRun('session-1');

    expect(getWorkoutRunLog('session-1')).toEqual([first, second]);
  });

  it('hydrates nothing when the _v2 read fails, so no later write can remove it', async () => {
    // The rollback case: both slots name the session and neither alone is the run.
    const blockAddedAfterRollback = { id: 'later', kind: 'volume', itemUuids: ['v1', 'v2'], targetGrade: 16 } as const;
    const v2Record = { sessionId: 'session-1', run: timedRun };
    const v1Record = { sessionId: 'session-1', run: { stages: [blockAddedAfterRollback] } };
    await storage.setItem(WORKOUT_RUN_V2_STORAGE_KEY, JSON.stringify(v2Record));
    await storage.setItem(WORKOUT_RUN_STORAGE_KEY, JSON.stringify(v1Record));
    storage.setItem.mockClear();
    storage.removeItem.mockClear();
    storage.getItem.mockImplementationOnce(async (key: string) => {
      throw new Error(`could not read ${key}`);
    });

    await hydrateWorkoutRun('session-1');

    expect(storage.getItem.mock.calls).toEqual([[WORKOUT_RUN_V2_STORAGE_KEY]]);
    expect(getWorkoutRunState()).toBeNull();
    // A tick on a climb of either part finds no run, so nothing is written or removed.
    noteWorkoutRunTick('session-1', tick('v1'));
    noteWorkoutRunTick('session-1', tick('a'));
    await flushStorageWrites();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
    expect(storedRecord(WORKOUT_RUN_V2_STORAGE_KEY)).toEqual(v2Record);
    expect(storedRecord(WORKOUT_RUN_STORAGE_KEY)).toEqual(v1Record);

    // The next clean read gets both parts back.
    await hydrateWorkoutRun('session-1');
    expect(getWorkoutRunForSession('session-1')).toEqual({ stages: [...timedRun.stages, blockAddedAfterRollback] });
  });

  it("reports 'failed' when a slot read fails and 'clean' when both read", async () => {
    await storage.setItem(WORKOUT_RUN_V2_STORAGE_KEY, JSON.stringify({ sessionId: 'session-1', run: timedRun }));
    storage.getItem.mockImplementationOnce(async (key: string) => {
      throw new Error(`could not read ${key}`);
    });

    await expect(hydrateWorkoutRun('session-1')).resolves.toBe('failed');
    expect(getWorkoutRunState()).toBeNull();

    await expect(hydrateWorkoutRun('session-1')).resolves.toBe('clean');
    expect(getWorkoutRunForSession('session-1')).toEqual(timedRun);
    // Already in memory, and a clean read that finds no run, are clean too.
    await expect(hydrateWorkoutRun('session-1')).resolves.toBe('clean');
    resetWorkoutRunStoreForTests();
    await expect(hydrateWorkoutRun('session-2')).resolves.toBe('clean');
  });

  it("reports 'failed' when a write for another session stops the read before both slots", async () => {
    await storage.setItem(WORKOUT_RUN_STORAGE_KEY, JSON.stringify({ sessionId: 'session-1', run }));

    const hydrate = hydrateWorkoutRun('session-1');
    // Another session ends before the read reaches `_v1`.
    const clear = clearWorkoutRunForSession('session-2');

    await expect(hydrate).resolves.toBe('failed');
    await clear;
    expect(getWorkoutRunState()).toBeNull();
  });

  it('leaves out a _v1 stage whose id names a _v2 stage of another kind', async () => {
    await storage.setItem(WORKOUT_RUN_V2_STORAGE_KEY, JSON.stringify({ sessionId: 'session-1', run: timedRun }));
    await storage.setItem(
      WORKOUT_RUN_STORAGE_KEY,
      JSON.stringify({
        sessionId: 'session-1',
        run: {
          stages: [
            { id: 'four', kind: 'ladder', itemUuids: ['l1'] },
            { id: 'later', kind: 'pyramid', itemUuids: ['p1'] },
          ],
        },
      }),
    );

    await hydrateWorkoutRun('session-1');

    expect(getWorkoutRunForSession('session-1')).toEqual({
      stages: [...timedRun.stages, { id: 'later', kind: 'pyramid', itemUuids: ['p1'] }],
    });
  });

  it('hydrates the _v1 copy when the _v2 copy of the same session shows nothing', async () => {
    await storage.setItem(
      WORKOUT_RUN_V2_STORAGE_KEY,
      JSON.stringify({
        sessionId: 'session-1',
        run: { stages: [{ id: 'x', kind: 'campusLadder', itemUuids: ['c1'] }] },
      }),
    );
    await storage.setItem(WORKOUT_RUN_STORAGE_KEY, JSON.stringify({ sessionId: 'session-1', run }));

    await hydrateWorkoutRun('session-1');

    expect(getWorkoutRunForSession('session-1')).toEqual(run);
  });

  it('drops a stage of a kind this bundle does not know and keeps the rest of the run', async () => {
    await storage.setItem(
      WORKOUT_RUN_V2_STORAGE_KEY,
      JSON.stringify({
        sessionId: 'session-1',
        run: {
          stages: [
            { id: 'warm', kind: 'warmUp', itemUuids: ['w1'] },
            { id: 'future', kind: 'campusLadder', itemUuids: ['c1'], pacing: { mode: 'campus' } },
            { id: 'main', kind: 'limitBouldering', itemUuids: ['l1'], targetGrade: 22 },
          ],
        },
      }),
    );

    await hydrateWorkoutRun('session-1');

    expect(getWorkoutRunForSession('session-1')).toEqual({
      stages: [
        { id: 'warm', kind: 'warmUp', itemUuids: ['w1'] },
        { id: 'main', kind: 'limitBouldering', itemUuids: ['l1'], targetGrade: 22 },
      ],
    });
  });

  it('shows nothing for a run whose every stage is of an unknown kind, and still clears its slot', async () => {
    await storage.setItem(
      WORKOUT_RUN_V2_STORAGE_KEY,
      JSON.stringify({
        sessionId: 'session-1',
        run: { stages: [{ id: 'x', kind: 'campusLadder', itemUuids: ['c1'] }] },
      }),
    );

    await hydrateWorkoutRun('session-1');
    expect(getWorkoutRunState()).toBeNull();

    await clearWorkoutRunForSession('session-1');
    expect(storedRecord(WORKOUT_RUN_V2_STORAGE_KEY)).toBeNull();
  });

  it('drops a stage with no readable kind the same way', async () => {
    await storage.setItem(
      WORKOUT_RUN_V2_STORAGE_KEY,
      JSON.stringify({
        sessionId: 'session-1',
        run: {
          stages: [
            { id: 'odd', kind: 7, itemUuids: ['x'] },
            { id: 'main', kind: 'onTheMinute', itemUuids: ['m1'] },
          ],
        },
      }),
    );

    await hydrateWorkoutRun('session-1');

    expect(getWorkoutRunForSession('session-1')).toEqual({
      stages: [{ id: 'main', kind: 'onTheMinute', itemUuids: ['m1'] }],
    });
  });

  it('still fails the record for a stage of a known kind it cannot read', async () => {
    await storage.setItem(
      WORKOUT_RUN_V2_STORAGE_KEY,
      JSON.stringify({ sessionId: 'session-1', run: { stages: [{ id: 4, kind: 'fourByFour', itemUuids: ['x'] }] } }),
    );

    await hydrateWorkoutRun('session-1');

    expect(getWorkoutRunState()).toBeNull();
  });

  it('drops an unreadable pacing on its own and keeps the stage', async () => {
    const fourByFour = timedRun.stages[1];
    await storage.setItem(
      WORKOUT_RUN_V2_STORAGE_KEY,
      JSON.stringify({
        sessionId: 'session-1',
        run: {
          stages: [
            { ...fourByFour, id: 'bad-pacing', pacing: { mode: 'afterTick', restSeconds: 30, advanceOn: 'beat' } },
            {
              ...fourByFour,
              id: 'bad-sets',
              itemUuids: ['s1'],
              pacing: { mode: 'afterTick', restSeconds: 0, advanceOn: 'set', sets: { repsPerSet: 'four' } },
            },
          ],
        },
      }),
    );

    await hydrateWorkoutRun('session-1');

    const stages = getWorkoutRunForSession('session-1')?.stages ?? [];
    expect(stages.map((stage) => stage.id)).toEqual(['bad-pacing', 'bad-sets']);
    expect(stages.map((stage) => 'pacing' in stage)).toEqual([false, false]);
    expect(stages[1]).toMatchObject({ kind: 'fourByFour', itemUuids: ['s1'], targetGrade: 18 });
  });

  it('reads a tester’s 4x4 from before sets as an unpaced block, and drops its rounds', async () => {
    // Stored by the round model: every climb queued once per round, the round
    // rest in the pacing and each copy's round beside it.
    await storage.setItem(
      WORKOUT_RUN_V2_STORAGE_KEY,
      JSON.stringify({
        sessionId: 'session-1',
        run: {
          stages: [
            {
              id: 'four',
              kind: 'fourByFour',
              itemUuids: ['a', 'b', 'a2', 'b2'],
              targetGrade: 18,
              pacing: { mode: 'afterTick', restSeconds: 0, restBetweenRoundsSeconds: 180, advanceOn: 'tick' },
              rounds: 2,
              roundByUuid: { a: 1, b: 1, a2: 2, b2: 2 },
            },
          ],
        },
        log: [tick('a')],
      }),
    );

    await hydrateWorkoutRun('session-1');

    expect(getWorkoutRunForSession('session-1')).toEqual({
      stages: [{ id: 'four', kind: 'fourByFour', itemUuids: ['a', 'b', 'a2', 'b2'], targetGrade: 18 }],
    });
    expect(getWorkoutRunLog('session-1')).toEqual([tick('a')]);
  });

  it('forgets both slots at sign-out', async () => {
    setWorkoutRun('session-1', timedRun);
    await flushStorageWrites();
    // Left by a rolled-back bundle, which only knows _v1.
    await storage.setItem(WORKOUT_RUN_STORAGE_KEY, JSON.stringify({ sessionId: 'session-2', run }));

    await clearWorkoutRun();

    expect(storedRecord(WORKOUT_RUN_STORAGE_KEY)).toBeNull();
    expect(storedRecord(WORKOUT_RUN_V2_STORAGE_KEY)).toBeNull();
  });

  it('clears both slots when each holds the ended session, so a later hydrate finds nothing', async () => {
    // The rollback case in docs/workout-stages.md: a rolled-back bundle wrote _v1
    // for a session whose timed run is still in _v2.
    await storage.setItem(WORKOUT_RUN_V2_STORAGE_KEY, JSON.stringify({ sessionId: 'session-1', run: timedRun }));
    await storage.setItem(WORKOUT_RUN_STORAGE_KEY, JSON.stringify({ sessionId: 'session-1', run }));

    await clearWorkoutRunForSession('session-1');

    expect(storedRecord(WORKOUT_RUN_STORAGE_KEY)).toBeNull();
    expect(storedRecord(WORKOUT_RUN_V2_STORAGE_KEY)).toBeNull();
    await hydrateWorkoutRun('session-1');
    expect(getWorkoutRunState()).toBeNull();
  });

  it('clears only the slot that names the ended session', async () => {
    await storage.setItem(WORKOUT_RUN_V2_STORAGE_KEY, JSON.stringify({ sessionId: 'session-1', run: timedRun }));
    await storage.setItem(WORKOUT_RUN_STORAGE_KEY, JSON.stringify({ sessionId: 'session-2', run }));

    await clearWorkoutRunForSession('session-1');

    expect(storedRecord(WORKOUT_RUN_V2_STORAGE_KEY)).toBeNull();
    expect(storedRecord(WORKOUT_RUN_STORAGE_KEY)).toEqual({ sessionId: 'session-2', run });
  });
});

describe('workout-run-store: tick log', () => {
  it('logs ticks on the run’s climbs, oldest first, and persists them', async () => {
    setWorkoutRun('session-1', timedRun);
    noteWorkoutRunTick('session-1', tick('a', 'attempt'));
    noteWorkoutRunTick('session-1', { ...tick('a', 'send'), tickUuid: 'tick-2' });
    await flushStorageWrites();

    const log = [tick('a', 'attempt'), { ...tick('a', 'send'), tickUuid: 'tick-2' }];
    expect(getWorkoutRunLog('session-1')).toEqual(log);
    expect(storedRecord(WORKOUT_RUN_V2_STORAGE_KEY)).toEqual({ sessionId: 'session-1', run: timedRun, log });
  });

  it('ignores a tick on a hand-queued climb, for another session, or with no run', () => {
    noteWorkoutRunTick('session-1', tick('a'));
    expect(getWorkoutRunState()).toBeNull();

    setWorkoutRun('session-1', timedRun);
    const listener = vi.fn();
    subscribeWorkoutRun(listener);
    noteWorkoutRunTick('session-1', tick('hand-queued'));
    noteWorkoutRunTick('session-2', tick('a'));

    expect(getWorkoutRunLog('session-1')).toEqual([]);
    expect(getWorkoutRunLog('session-2')).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
  });

  it('keeps the same log array until a tick is added', () => {
    setWorkoutRun('session-1', timedRun);
    const empty = getWorkoutRunLog('session-1');
    expect(getWorkoutRunLog('session-1')).toBe(empty);
    expect(getWorkoutRunLog(null)).toBe(empty);

    noteWorkoutRunTick('session-1', tick('a'));
    const first = getWorkoutRunLog('session-1');
    expect(first).not.toBe(empty);
    expect(getWorkoutRunLog('session-1')).toBe(first);
  });

  it('keeps the log when the same session’s run is rewritten, and drops it for a new session', () => {
    setWorkoutRun('session-1', timedRun);
    noteWorkoutRunTick('session-1', tick('a'));
    const log = getWorkoutRunLog('session-1');

    // "Add a block" rewrites the run with one more stage.
    setWorkoutRun('session-1', {
      stages: [...timedRun.stages, { id: 'more', kind: 'volume', itemUuids: ['v1'] }],
    });
    expect(getWorkoutRunLog('session-1')).toBe(log);

    setWorkoutRun('session-2', run);
    expect(getWorkoutRunLog('session-2')).toEqual([]);
    expect(getWorkoutRunState()).toEqual({ sessionId: 'session-2', run });
  });

  it('keeps only the newest entries past the cap', () => {
    setWorkoutRun('session-1', timedRun);
    for (let count = 0; count < MAX_WORKOUT_TICK_LOG + 2; count++) {
      noteWorkoutRunTick('session-1', { ...tick('a'), tickUuid: `tick-${count}` });
    }

    const log = getWorkoutRunLog('session-1');
    expect(log).toHaveLength(MAX_WORKOUT_TICK_LOG);
    expect(log[0].tickUuid).toBe('tick-2');
    expect(log[log.length - 1].tickUuid).toBe(`tick-${MAX_WORKOUT_TICK_LOG + 1}`);
  });

  it('hydrates the log with the run and leaves out unreadable entries', async () => {
    await storage.setItem(
      WORKOUT_RUN_STORAGE_KEY,
      JSON.stringify({
        sessionId: 'session-1',
        run,
        log: [
          tick('m1', 'flash'),
          { ...tick('m2', 'send'), tickUuid: 'tick-1' },
          { queueItemUuid: 'm3', status: 'repeat', climbedAt: '2026-10-24T12:00:00.000Z' },
          { queueItemUuid: 'm3', status: 'attempt' },
          'garbage',
          { ...tick('m3', 'attempt'), tickUuid: 9 },
        ],
      }),
    );

    await hydrateWorkoutRun('session-1');

    expect(getWorkoutRunLog('session-1')).toEqual([
      tick('m1', 'flash'),
      { ...tick('m2', 'send'), tickUuid: 'tick-1' },
      tick('m3', 'attempt'),
    ]);
  });

  it('loads a run whose log is not a list, without the log', async () => {
    await storage.setItem(WORKOUT_RUN_STORAGE_KEY, JSON.stringify({ sessionId: 'session-1', run, log: 'nope' }));

    await hydrateWorkoutRun('session-1');

    expect(getWorkoutRunState()).toEqual({ sessionId: 'session-1', run });
  });
});

describe('countWorkoutRunTicks', () => {
  it('counts every tick on one queue item, falls and sends alike: a 4x4 set’s reps so far', () => {
    const log = [tick('a'), tick('b', 'send'), tick('a', 'send'), tick('a', 'flash')];

    expect(countWorkoutRunTicks(log, 'a')).toBe(3);
    expect(countWorkoutRunTicks(log, 'b')).toBe(1);
    expect(countWorkoutRunTicks(log, 'c')).toBe(0);
    expect(countWorkoutRunTicks(log, null)).toBe(0);
    expect(countWorkoutRunTicks([], 'a')).toBe(0);
  });
});
