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
};

async function flushStorageWrites(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function storeStages(stages: unknown[]): Promise<void> {
  await storage.setItem(WORKOUT_RUN_STORAGE_KEY, JSON.stringify({ sessionId: 'session-1', run: { stages } }));
}

beforeEach(() => {
  resetWorkoutRunStoreForTests();
  storage.reset();
});

describe('workout-run-store: the skip switches and Benchmarks only', () => {
  it('keeps every switch through a relaunch', async () => {
    const run: WorkoutRun = {
      stages: [
        {
          id: 'main',
          kind: 'gradeFocus',
          itemUuids: ['g1'],
          targetGrade: 18,
          filters: { ...plainFilters, climbBias: 'any', skipSent: true, skipTried: true, onlyBenchmarks: true },
        },
      ],
    };
    setWorkoutRun('session-1', run);
    await flushStorageWrites();
    resetWorkoutRunStoreForTests();

    await hydrateWorkoutRun('session-1');

    expect(getWorkoutRunForSession('session-1')).toEqual(run);
  });

  it('still reads filters stored before the switches existed', async () => {
    await storeStages([{ id: 'main', kind: 'volume', itemUuids: ['v1'], targetGrade: 18, filters: plainFilters }]);

    await hydrateWorkoutRun('session-1');

    expect(getWorkoutRunForSession('session-1')?.stages[0].filters).toEqual(plainFilters);
  });

  it('drops filters whose switch is not a boolean, and keeps the stage', async () => {
    await storeStages([
      { id: 'main', kind: 'volume', itemUuids: ['v1'], targetGrade: 18, filters: { ...plainFilters, skipSent: 'yes' } },
      { id: 'next', kind: 'ladder', itemUuids: ['l1'], filters: { ...plainFilters, onlyBenchmarks: 1 } },
      { id: 'last', kind: 'pyramid', itemUuids: ['p1'], filters: { ...plainFilters, skipTried: 'on' } },
    ]);

    await hydrateWorkoutRun('session-1');

    expect(getWorkoutRunForSession('session-1')).toEqual({
      stages: [
        { id: 'main', kind: 'volume', itemUuids: ['v1'], targetGrade: 18 },
        { id: 'next', kind: 'ladder', itemUuids: ['l1'] },
        { id: 'last', kind: 'pyramid', itemUuids: ['p1'] },
      ],
    });
  });
});
