import { useSyncExternalStore } from 'react';
import type { CreateWorkout } from '@boardsesh/public-api';
import { subscribeToCredentialChanges } from './privacy/privacy-cache';

export type AppWorkout = {
  id: string;
  clientId: string;
  title: string;
  status: string;
  sourceAppName: string;
  notes: string | null;
  spec: CreateWorkout;
  expiresAt: string;
  sessionId?: string | null;
  sessionPlan?: unknown;
  /** This device explicitly created/prepared the workout; restored links keep running state. */
  pendingNativeStart?: boolean;
};

let pending: AppWorkout | null = null;
let active: { sessionId: string; workout: AppWorkout } | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function setPendingWorkout(workout: AppWorkout): void {
  pending = workout;
  emit();
}
export function clearPendingWorkout(): void {
  pending = null;
  emit();
}
export function getPendingWorkout(): AppWorkout | null {
  return pending;
}
export function activatePartnerWorkout(sessionId: string, workout: AppWorkout): void {
  active = { sessionId, workout };
  pending = null;
  emit();
}
export function usePendingWorkout(): AppWorkout | null {
  return useSyncExternalStore(
    subscribe,
    () => pending,
    () => null,
  );
}
export function useActivePartnerWorkout(sessionId: string | null): AppWorkout | null {
  return useSyncExternalStore(
    subscribe,
    () => (active?.sessionId === sessionId ? active.workout : null),
    () => null,
  );
}
export function resetPendingWorkoutStore(): void {
  pending = null;
  active = null;
  emit();
}
subscribeToCredentialChanges(resetPendingWorkoutStore);
