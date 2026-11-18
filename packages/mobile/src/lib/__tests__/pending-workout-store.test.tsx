// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
const storage = vi.hoisted(() => new Map<string, unknown>());
vi.mock('../preference-store', () => ({
  getPreference: async (key: string) => storage.get(key) ?? null,
  setPreference: async (key: string, saved: unknown) => {
    storage.set(key, saved);
  },
  removePreference: async (key: string) => {
    storage.delete(key);
  },
}));
import { invalidateCredentialSnapshots } from '../privacy/privacy-cache';
import {
  activatePartnerWorkout,
  clearActivePartnerWorkout,
  hydratePartnerWorkout,
  rememberPartnerWorkout,
  setPartnerWorkoutOwner,
  getPartnerWorkoutTimer,
  setPartnerWorkoutTimer,
  getPendingWorkout,
  resetPendingWorkoutStore,
  setPendingWorkout,
  useActivePartnerWorkout,
  usePendingWorkout,
  type AppWorkout,
} from '../pending-workout-store';

const workout: AppWorkout = {
  id: 'wk_test',
  clientId: 'app_planner',
  title: 'Free climb',
  sourceAppName: 'Planner',
  status: 'opened',
  notes: null,
  expiresAt: '2026-12-01T00:00:00Z',
  spec: { externalRef: 'free', title: 'Free climb', blocks: [{ type: 'freeClimbing' }] },
};
beforeEach(async () => {
  resetPendingWorkoutStore();
  await clearActivePartnerWorkout();
  setPartnerWorkoutOwner('account_one');
  storage.clear();
});

describe('pending partner workout account boundaries', () => {
  it('keeps the card through session creation and exposes it only in its own session', () => {
    const pending = renderHook(usePendingWorkout);
    const active = renderHook(() => useActivePartnerWorkout('session_one'));
    const other = renderHook(() => useActivePartnerWorkout('session_two'));
    act(() => setPendingWorkout(workout));
    expect(pending.result.current).toEqual(workout);
    act(() => activatePartnerWorkout('session_one', workout));
    expect(pending.result.current).toBeNull();
    expect(active.result.current).toEqual(workout);
    expect(other.result.current).toBeNull();
  });

  it('clears both pending and active private notes before an account switch', () => {
    setPendingWorkout(workout);
    activatePartnerWorkout('session_one', workout);
    setPendingWorkout(workout);
    const active = renderHook(() => useActivePartnerWorkout('session_one'));
    act(invalidateCredentialSnapshots);
    expect(getPendingWorkout()).toBeNull();
    expect(active.result.current).toBeNull();
  });
});

describe('durable partner workout recovery', () => {
  const key = 'boardsesh_active_partner_workout_v1:account_one';
  const started: AppWorkout = { ...workout, status: 'started', sessionId: 'session_one', notes: 'Private coach notes' };

  it('persists only account-scoped ids and the countdown deadline', async () => {
    await rememberPartnerWorkout('session_one', workout.id);
    const timer = { block: 0, endsAt: Date.now() + 60_000 };
    await setPartnerWorkoutTimer('session_one', workout.id, timer);
    expect(storage.get(key)).toEqual({ sessionId: 'session_one', workoutId: workout.id, timer });
    expect(getPartnerWorkoutTimer('session_one', workout.id)).toEqual(timer);
    await clearActivePartnerWorkout('session_one');
    expect(storage.has(key)).toBe(false);
  });

  it('cold-starts from ids and reads authoritative instructions and stages', async () => {
    storage.set(key, { sessionId: 'session_one', workoutId: workout.id });
    const active = renderHook(() => useActivePartnerWorkout('session_one'));
    const fetch = vi.fn(async () => started);
    await act(() => hydratePartnerWorkout('session_one', fetch));
    expect(fetch).toHaveBeenCalledWith(workout.id);
    expect(active.result.current).toEqual(started);
  });

  it('offers Resume if process death occurred before the new session identity landed', async () => {
    storage.set(key, { sessionId: 'session_one', workoutId: workout.id });
    await hydratePartnerWorkout(null, async () => started);
    expect(getPendingWorkout()).toEqual(started);
  });

  it('replaces the early Resume prompt when the persisted session finishes restoring', async () => {
    storage.set(key, { sessionId: 'session_one', workoutId: workout.id });
    await hydratePartnerWorkout(null, async () => started);
    expect(getPendingWorkout()).toEqual(started);
    const active = renderHook(() => useActivePartnerWorkout('session_one'));
    await act(() => hydratePartnerWorkout('session_one', async () => started));
    expect(getPendingWorkout()).toBeNull();
    expect(active.result.current).toEqual(started);
  });

  it.each(['started', 'completed'])(
    'preserves a newer handoff staged before old %s-workout hydration starts',
    async (status) => {
      storage.set(key, { sessionId: 'session_one', workoutId: workout.id });
      const nextWorkout = { ...workout, id: 'wk_new_handoff' };
      setPendingWorkout(nextWorkout);
      await hydratePartnerWorkout('another-session', async () => ({ ...started, status }));
      expect(getPendingWorkout()).toEqual(nextWorkout);
    },
  );

  it('cannot revive a workout when a session ends before cold-start hydration finishes', async () => {
    storage.set(key, { sessionId: 'session_one', workoutId: workout.id });
    let finish!: (result: AppWorkout) => void;
    const fetch = vi.fn(
      () =>
        new Promise<AppWorkout>((resolve) => {
          finish = resolve;
        }),
    );
    const hydration = hydratePartnerWorkout('session_one', fetch);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    await clearActivePartnerWorkout('session_one');
    finish(started);
    await hydration;
    expect(storage.has(key)).toBe(false);
    expect(getPendingWorkout()).toBeNull();
  });

  it('discards a late previous-account read and clears its association at credential change', async () => {
    storage.set(key, { sessionId: 'session_one', workoutId: workout.id });
    let finish!: (result: AppWorkout) => void;
    const fetch = vi.fn(
      () =>
        new Promise<AppWorkout>((resolve) => {
          finish = resolve;
        }),
    );
    const hydration = hydratePartnerWorkout('session_one', fetch);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    invalidateCredentialSnapshots();
    setPartnerWorkoutOwner('account_two');
    finish(started);
    await hydration;
    expect(getPendingWorkout()).toBeNull();
    expect(storage.has(key)).toBe(false);
  });

  it('clears the matching stale Resume prompt when the saved workout has finished', async () => {
    storage.set(key, { sessionId: 'session_one', workoutId: workout.id });
    setPendingWorkout(started);
    await hydratePartnerWorkout(null, async () => ({ ...started, status: 'completed' }));
    expect(getPendingWorkout()).toBeNull();
    expect(storage.has(key)).toBe(false);
  });

  it('retires the persisted association on a definitive completion/revocation', async () => {
    storage.set(key, { sessionId: 'session_one', workoutId: workout.id });
    await hydratePartnerWorkout('session_one', async () => ({ ...started, status: 'revoked' }));
    expect(storage.has(key)).toBe(false);
  });
});
