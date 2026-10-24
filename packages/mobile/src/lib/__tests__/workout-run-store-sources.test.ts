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
  };
});
vi.mock('@react-native-async-storage/async-storage', () => ({ default: storage }));

import {
  WORKOUT_RUN_STORAGE_KEY,
  getWorkoutRunForSession,
  hydrateWorkoutRun,
  resetWorkoutRunStoreForTests,
  setWorkoutRun,
} from '../workout-run-store';

const plainFilters = {
  climbBias: 'unfamiliar',
  minAscents: 5,
  minRating: 2,
  onlyTallClimbs: false,
  onlyWideClimbs: false,
} as const;

async function flushStorageWrites(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  resetWorkoutRunStoreForTests();
  storage.reset();
});

describe('workout-run-store: blocks drawn from sent and liked climbs', () => {
  it('keeps a Sent and a Liked block through a relaunch, in the v1 slot', async () => {
    const run: WorkoutRun = {
      stages: [
        { id: 'warm', kind: 'warmUp', itemUuids: ['w1'], filters: { ...plainFilters, climbBias: 'sent' } },
        {
          id: 'main',
          kind: 'gradeFocus',
          itemUuids: ['g1'],
          targetGrade: 18,
          filters: { ...plainFilters, climbBias: 'liked', skipSent: true },
        },
      ],
    };
    setWorkoutRun('session-1', run);
    await flushStorageWrites();
    resetWorkoutRunStoreForTests();

    await hydrateWorkoutRun('session-1');

    expect(getWorkoutRunForSession('session-1')).toEqual(run);
    // A new climb bias is a new value, not a new stage kind: the run stays where every bundle reads it.
    expect(await storage.getItem(WORKOUT_RUN_STORAGE_KEY)).not.toBeNull();
  });

  it('drops only the filters of a stage whose bias this bundle does not know, and keeps the run', async () => {
    await storage.setItem(
      WORKOUT_RUN_STORAGE_KEY,
      JSON.stringify({
        sessionId: 'session-1',
        run: {
          stages: [
            { id: 'main', kind: 'volume', itemUuids: ['v1'], filters: { ...plainFilters, climbBias: 'playlist' } },
            { id: 'next', kind: 'ladder', itemUuids: ['l1'], filters: { ...plainFilters, climbBias: 'liked' } },
          ],
        },
      }),
    );

    await hydrateWorkoutRun('session-1');

    expect(getWorkoutRunForSession('session-1')).toEqual({
      stages: [
        { id: 'main', kind: 'volume', itemUuids: ['v1'] },
        { id: 'next', kind: 'ladder', itemUuids: ['l1'], filters: { ...plainFilters, climbBias: 'liked' } },
      ],
    });
  });
});
