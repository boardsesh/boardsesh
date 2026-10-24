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

// A 4x4 behind a warm-up, as Start would store it: two climbs, two rounds.
const timedRun: WorkoutRun = {
  stages: [
    { id: 'warm', kind: 'warmUp', itemUuids: ['w1'] },
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

  it('hydrates a timed run with its pacing and rounds', async () => {
    setWorkoutRun('session-1', timedRun);
    await flushStorageWrites();
    resetWorkoutRunStoreForTests();

    await hydrateWorkoutRun('session-1');

    expect(getWorkoutRunForSession('session-1')).toEqual(timedRun);
  });

  it('reads _v2 first and falls back to _v1 when _v2 is another session’s', async () => {
    await storage.setItem(WORKOUT_RUN_V2_STORAGE_KEY, JSON.stringify({ sessionId: 'session-1', run: timedRun }));
    await storage.setItem(WORKOUT_RUN_STORAGE_KEY, JSON.stringify({ sessionId: 'session-2', run }));

    await hydrateWorkoutRun('session-2');
    expect(getWorkoutRunForSession('session-2')).toEqual(run);

    resetWorkoutRunStoreForTests();
    await hydrateWorkoutRun('session-1');
    expect(getWorkoutRunForSession('session-1')).toEqual(timedRun);
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

  it('drops an unreadable pacing, rounds or round map on its own and keeps the stage', async () => {
    const fourByFour = timedRun.stages[1];
    await storage.setItem(
      WORKOUT_RUN_V2_STORAGE_KEY,
      JSON.stringify({
        sessionId: 'session-1',
        run: {
          stages: [
            { ...fourByFour, id: 'bad-pacing', pacing: { mode: 'afterTick', restSeconds: 30, advanceOn: 'beat' } },
            { ...fourByFour, id: 'bad-rounds', itemUuids: ['r1'], rounds: 0 },
            { ...fourByFour, id: 'bad-map', itemUuids: ['m1'], roundByUuid: { m1: 'two' } },
            { ...fourByFour, id: 'list-map', itemUuids: ['m2'], roundByUuid: [1, 2] },
          ],
        },
      }),
    );

    await hydrateWorkoutRun('session-1');

    const stages = getWorkoutRunForSession('session-1')?.stages ?? [];
    expect(stages.map((stage) => stage.id)).toEqual(['bad-pacing', 'bad-rounds', 'bad-map', 'list-map']);
    expect('pacing' in stages[0]).toBe(false);
    expect(stages[0]).toMatchObject({ rounds: 2, roundByUuid: fourByFour.roundByUuid });
    expect('rounds' in stages[1]).toBe(false);
    expect(stages[1].pacing).toEqual(fourByFour.pacing);
    expect('roundByUuid' in stages[2]).toBe(false);
    expect('roundByUuid' in stages[3]).toBe(false);
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
