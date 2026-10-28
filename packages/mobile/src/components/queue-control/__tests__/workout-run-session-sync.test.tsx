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

// #6903: the run that goes becomes the summary's recap and sends its last copy.
const sync = vi.hoisted(() => ({
  profileId: 'user-1' as string | null,
  enqueueEndedSessionWorkout: vi.fn(async () => 'queued'),
}));
vi.mock('../../../lib/graphql/hooks', () => ({
  useProfile: () => ({ data: sync.profileId ? { id: sync.profileId } : null }),
}));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('../../../offline/session-workout-outbox', () => ({
  enqueueEndedSessionWorkout: sync.enqueueEndedSessionWorkout,
}));

import {
  getWorkoutRunForSession,
  getWorkoutRunState,
  resetWorkoutRunStoreForTests,
  setWorkoutRun,
} from '../../../lib/workout-run-store';
import { getEndedWorkout, resetEndedWorkoutStoreForTests } from '../../../lib/ended-workout-store';
import { WorkoutRunSessionSync } from '../WorkoutRunSessionSync';

const run: WorkoutRun = {
  stages: [
    { id: 'warm', kind: 'warmUp', itemUuids: ['w1'] },
    { id: 'main', kind: 'volume', itemUuids: ['m1', 'm2'] },
  ],
};

beforeEach(() => {
  resetWorkoutRunStoreForTests();
  resetEndedWorkoutStoreForTests();
  sync.profileId = 'user-1';
  sync.enqueueEndedSessionWorkout.mockClear();
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

  it("keeps the ended run as the account's recap and sends its last copy, however the session ended", () => {
    queueState.sessionId = 'session-1';
    setWorkoutRun('session-1', run);
    const { rerender } = render(<WorkoutRunSessionSync />);

    // No End button: the session ended on another phone, or dropped this climber.
    queueState.sessionId = null;
    rerender(<WorkoutRunSessionSync />);

    expect(getEndedWorkout('session-1')).toMatchObject({ sessionId: 'session-1', run, userId: 'user-1' });
    expect(sync.enqueueEndedSessionWorkout).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sessionId: 'session-1', run }),
      expect.anything(),
    );
  });

  it('sends the last copy when the climber joins another session', () => {
    queueState.sessionId = 'session-1';
    setWorkoutRun('session-1', run);
    const { rerender } = render(<WorkoutRunSessionSync />);

    queueState.sessionId = 'session-2';
    rerender(<WorkoutRunSessionSync />);

    expect(sync.enqueueEndedSessionWorkout).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sessionId: 'session-1' }),
      expect.anything(),
    );
  });
});
