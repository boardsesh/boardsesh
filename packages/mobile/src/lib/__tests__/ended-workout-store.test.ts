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
  ENDED_WORKOUTS_STORAGE_KEY,
  ENDED_WORKOUT_MAX_AGE_MS,
  MAX_ENDED_WORKOUTS,
  clearEndedWorkouts,
  forgetEndedWorkoutTick,
  getEndedWorkout,
  hydrateEndedWorkouts,
  rememberEndedWorkout,
  resetEndedWorkoutStoreForTests,
} from '../ended-workout-store';
import type { WorkoutRunRecord } from '../workout-run-store';

const run: WorkoutRun = { stages: [{ id: 'main', kind: 'fourByFour', itemUuids: ['q1'] }] };
const NOW = Date.UTC(2026, 9, 28, 12);
const DAY_MS = 24 * 60 * 60 * 1000;

const record = (sessionId: string): WorkoutRunRecord => ({
  sessionId,
  run,
  climbs: { q1: { climbUuid: 'climb-1', angle: 40 } },
  log: [{ queueItemUuid: 'q1', status: 'send', climbedAt: '2026-10-28T11:00:00Z', tickUuid: 'tick-1' }],
  revision: 3,
});

async function flushStorageWrites(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  storage.reset();
  resetEndedWorkoutStoreForTests();
});

describe('ended workout recaps', () => {
  it('keeps the run, tick log and captured climbs by session id', () => {
    rememberEndedWorkout({ ...record('session-1'), pendingStart: true }, NOW, 'user-1');
    const recap = getEndedWorkout('session-1');
    expect(recap).toMatchObject({ ...record('session-1'), endedAtMs: NOW, userId: 'user-1' });
    expect(recap?.pendingStart).toBeUndefined();
    expect(getEndedWorkout('session-2')).toBeNull();
  });

  it('skips a run with no stages', () => {
    rememberEndedWorkout({ sessionId: 'session-1', run: { stages: [] } }, NOW, 'user-1');
    expect(getEndedWorkout('session-1')).toBeNull();
  });

  it(`keeps the newest ${MAX_ENDED_WORKOUTS}`, () => {
    for (let index = 0; index <= MAX_ENDED_WORKOUTS; index += 1) {
      rememberEndedWorkout(record(`session-${index}`), NOW + index, 'user-1');
    }
    expect(getEndedWorkout('session-0')).toBeNull();
    expect(getEndedWorkout(`session-${MAX_ENDED_WORKOUTS}`)).not.toBeNull();
  });

  it('drops recaps older than 30 days', async () => {
    storage.write(ENDED_WORKOUTS_STORAGE_KEY, {
      records: [
        { ...record('old'), endedAtMs: NOW - ENDED_WORKOUT_MAX_AGE_MS - DAY_MS },
        { ...record('recent'), endedAtMs: NOW - DAY_MS },
      ],
    });
    await hydrateEndedWorkouts(NOW);
    expect(getEndedWorkout('old')).toBeNull();
    expect(getEndedWorkout('recent')).not.toBeNull();
  });

  it('survives a cold start, and a recap remembered before the read wins', async () => {
    rememberEndedWorkout(record('session-1'), NOW, 'user-1');
    await flushStorageWrites();
    resetEndedWorkoutStoreForTests();

    rememberEndedWorkout({ ...record('session-2'), revision: 9 }, NOW + 1, 'user-1');
    await hydrateEndedWorkouts(NOW + 2);
    expect(getEndedWorkout('session-1')?.revision).toBe(3);
    expect(getEndedWorkout('session-2')?.revision).toBe(9);
  });

  it('skips unreadable stored recaps', async () => {
    storage.write(ENDED_WORKOUTS_STORAGE_KEY, {
      records: [{ sessionId: 'broken' }, { ...record('ok'), endedAtMs: NOW }],
    });
    await hydrateEndedWorkouts(NOW);
    expect(getEndedWorkout('broken')).toBeNull();
    expect(getEndedWorkout('ok')).not.toBeNull();
  });

  it('forgets everything on sign-out, a read in flight included', async () => {
    rememberEndedWorkout(record('session-1'), NOW, 'user-1');
    await flushStorageWrites();
    resetEndedWorkoutStoreForTests();
    const hydrating = hydrateEndedWorkouts(NOW);
    await clearEndedWorkouts();
    await hydrating;
    expect(getEndedWorkout('session-1')).toBeNull();
    expect(storage.read(ENDED_WORKOUTS_STORAGE_KEY)).toBeNull();
  });

  it('keeps the account a recap belongs to across a cold start', async () => {
    rememberEndedWorkout(record('session-1'), NOW, 'user-1');
    rememberEndedWorkout(record('session-2'), NOW + 1, null);
    await flushStorageWrites();
    await flushStorageWrites();
    resetEndedWorkoutStoreForTests();
    await hydrateEndedWorkouts(NOW + 2);
    expect(getEndedWorkout('session-1')?.userId).toBe('user-1');
    expect(getEndedWorkout('session-2')?.userId).toBeNull();
  });

  it('drops a deleted tick from every recap', () => {
    rememberEndedWorkout(record('session-1'), NOW, 'user-1');
    forgetEndedWorkoutTick('tick-1', NOW);
    expect(getEndedWorkout('session-1')?.log).toEqual([]);
  });
});
