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
  WORKOUT_RUN_STORAGE_KEY,
  clearWorkoutRun,
  clearWorkoutRunForSession,
  getWorkoutRunForSession,
  getWorkoutRunState,
  hydrateWorkoutRun,
  resetWorkoutRunStoreForTests,
  setWorkoutRun,
  subscribeWorkoutRun,
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

function storedRecord(): unknown {
  const raw = storage.read(WORKOUT_RUN_STORAGE_KEY);
  return raw === null ? null : JSON.parse(raw);
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
