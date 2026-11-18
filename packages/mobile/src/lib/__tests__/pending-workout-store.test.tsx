// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { invalidateCredentialSnapshots } from '../privacy/privacy-cache';
import {
  activatePartnerWorkout,
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
beforeEach(resetPendingWorkoutStore);

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
