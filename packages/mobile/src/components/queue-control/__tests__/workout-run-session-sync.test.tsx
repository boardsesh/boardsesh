// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import type { WorkoutRun } from '@boardsesh/playlist-generator';

const queueState = vi.hoisted(() => ({
  sessionId: null as string | null,
  queue: [] as Array<{ uuid: string }>,
}));
vi.mock('../../../providers/queue-provider', () => ({
  useQueueSessionId: () => ({ sessionId: queueState.sessionId }),
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

import {
  getWorkoutRunForSession,
  getWorkoutRunState,
  resetWorkoutRunStoreForTests,
  setWorkoutRun,
} from '../../../lib/workout-run-store';
import { WorkoutRunSessionSync } from '../WorkoutRunSessionSync';

const run: WorkoutRun = {
  stages: [
    { id: 'warm', kind: 'warmUp', itemUuids: ['w1'] },
    { id: 'main', kind: 'volume', itemUuids: ['m1', 'm2'] },
  ],
};

beforeEach(() => {
  resetWorkoutRunStoreForTests();
  storage.reset();
  queueState.sessionId = null;
  queueState.queue = [];
});

describe('WorkoutRunSessionSync', () => {
  it('restores the stored run when the session comes back after a cold start', async () => {
    setWorkoutRun('session-1', run);
    await act(async () => {
      await Promise.resolve();
    });
    resetWorkoutRunStoreForTests();

    // Cold start: no session yet, which must not clear anything.
    const { rerender } = render(<WorkoutRunSessionSync />);
    queueState.sessionId = 'session-1';
    rerender(<WorkoutRunSessionSync />);

    await waitFor(() => expect(getWorkoutRunForSession('session-1')).toEqual(run));
  });

  it('forgets the run when the session ends', () => {
    queueState.sessionId = 'session-1';
    setWorkoutRun('session-1', run);
    const { rerender } = render(<WorkoutRunSessionSync />);

    queueState.sessionId = null;
    rerender(<WorkoutRunSessionSync />);

    expect(getWorkoutRunState()).toBeNull();
  });

  it('keeps every stage while climbs leave the queue, so Undo brings them back staged', () => {
    queueState.sessionId = 'session-1';
    queueState.queue = [{ uuid: 'w1' }, { uuid: 'm1' }, { uuid: 'm2' }];
    setWorkoutRun('session-1', run);
    const { rerender } = render(<WorkoutRunSessionSync />);

    queueState.queue = [{ uuid: 'm2' }];
    rerender(<WorkoutRunSessionSync />);

    expect(getWorkoutRunForSession('session-1')).toBe(run);
  });
});
