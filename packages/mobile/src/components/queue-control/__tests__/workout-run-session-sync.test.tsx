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

// #6903: the run that goes becomes the summary's recap and sends its last copy,
// for the account the stored token names.
const sync = vi.hoisted(() => ({
  account: { status: 'signed-in', userId: 'user-1' } as { status: string; userId?: string },
  accountReads: 0,
  accountReadFails: false,
  generation: 1,
  enqueueEndedSessionWorkout: vi.fn(async () => 'queued'),
}));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('../../../offline/session-workout-outbox', () => ({
  enqueueEndedSessionWorkout: sync.enqueueEndedSessionWorkout,
}));
vi.mock('../../../offline/offline-sync-adapter', () => ({
  readSignedInAccount: async () => {
    sync.accountReads += 1;
    if (sync.accountReadFails) throw new Error('SecureStore unavailable');
    return sync.account;
  },
}));
vi.mock('../../../lib/auth-store', () => ({
  captureAuthCredentialGeneration: () => sync.generation,
  isAuthCredentialGenerationCurrent: (generation: number) => generation === sync.generation,
  subscribeAuthCredentialGenerationChanges: () => () => undefined,
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
  sync.account = { status: 'signed-in', userId: 'user-1' };
  sync.accountReads = 0;
  sync.accountReadFails = false;
  sync.generation = 1;
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

  it("keeps the ended run as the account's recap and sends its last copy, however the session ended", async () => {
    queueState.sessionId = 'session-1';
    setWorkoutRun('session-1', run);
    const { rerender } = render(<WorkoutRunSessionSync />);
    // The account was read ahead, so the recap is there at once.
    await waitFor(() => expect(sync.accountReads).toBe(1));
    await act(async () => {
      await Promise.resolve();
    });

    // No End button: the session ended on another phone, or dropped this climber.
    queueState.sessionId = null;
    rerender(<WorkoutRunSessionSync />);

    expect(getEndedWorkout('session-1')).toMatchObject({ sessionId: 'session-1', run, userId: 'user-1' });
    expect(sync.enqueueEndedSessionWorkout).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sessionId: 'session-1', run }),
      expect.objectContaining({ ownerUserId: 'user-1' }),
    );
  });

  it('stamps the recap from the token on a cold start that finds the session over', async () => {
    const realAccount = sync.account;
    sync.account = { status: 'unsettled' };
    queueState.sessionId = 'session-1';
    setWorkoutRun('session-1', run);
    const { rerender } = render(<WorkoutRunSessionSync />);
    // The read ahead found no settled account yet.
    await waitFor(() => expect(sync.accountReads).toBe(1));
    sync.account = realAccount;

    queueState.sessionId = null;
    rerender(<WorkoutRunSessionSync />);

    await waitFor(() => expect(getEndedWorkout('session-1')?.userId).toBe('user-1'));
    expect(sync.enqueueEndedSessionWorkout).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1' }),
      expect.objectContaining({ ownerUserId: 'user-1' }),
    );
  });

  it('keeps the recap unowned when the token cannot be read, ahead or at the end', async () => {
    sync.accountReadFails = true;
    queueState.sessionId = 'session-1';
    setWorkoutRun('session-1', run);
    const { rerender } = render(<WorkoutRunSessionSync />);
    await waitFor(() => expect(sync.accountReads).toBe(1));

    queueState.sessionId = null;
    rerender(<WorkoutRunSessionSync />);

    await waitFor(() => expect(getEndedWorkout('session-1')).toMatchObject({ sessionId: 'session-1', userId: null }));
    expect(sync.enqueueEndedSessionWorkout).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1' }),
      expect.objectContaining({ ownerUserId: null }),
    );
  });

  it('keeps nothing when the account changed between the end and the token read', async () => {
    sync.account = { status: 'unsettled' };
    queueState.sessionId = 'session-1';
    setWorkoutRun('session-1', run);
    const { rerender } = render(<WorkoutRunSessionSync />);
    await waitFor(() => expect(sync.accountReads).toBe(1));

    queueState.sessionId = null;
    rerender(<WorkoutRunSessionSync />);
    // Signed out and back in as someone else before the read came back.
    sync.generation = 2;
    sync.account = { status: 'signed-in', userId: 'user-2' };
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getEndedWorkout('session-1')).toBeNull();
    expect(sync.enqueueEndedSessionWorkout).not.toHaveBeenCalled();
  });

  it('sends the last copy when the climber joins another session', async () => {
    queueState.sessionId = 'session-1';
    setWorkoutRun('session-1', run);
    const { rerender } = render(<WorkoutRunSessionSync />);

    queueState.sessionId = 'session-2';
    rerender(<WorkoutRunSessionSync />);

    await waitFor(() =>
      expect(sync.enqueueEndedSessionWorkout).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ sessionId: 'session-1' }),
        expect.anything(),
      ),
    );
  });
});
