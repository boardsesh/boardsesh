import { useSyncExternalStore } from 'react';
import type { CreateWorkout } from '@boardsesh/public-api';
import { getCredentialGeneration, subscribeToCredentialChanges } from './privacy/privacy-cache';
import { getPreference, removePreference, setPreference } from './preference-store';

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

export type PartnerWorkoutTimer = { block: number; endsAt: number };
type ActiveWorkoutAssociation = { sessionId: string; workoutId: string; timer?: PartnerWorkoutTimer | null };
const STORAGE_KEY = 'boardsesh_active_partner_workout_v1';
let ownerId: string | null = null;
let association: ActiveWorkoutAssociation | null = null;
let revision = 0;
let writeQueue: Promise<void> = Promise.resolve();
const storageKey = (userId: string) => `${STORAGE_KEY}:${encodeURIComponent(userId)}`;
function enqueueWrite(write: () => Promise<void>): Promise<void> {
  const operation = writeQueue.then(write, write);
  writeQueue = operation.catch(() => undefined);
  return operation;
}

/** Auth injects identity; queue modules never import the native credential store. */
export function setPartnerWorkoutOwner(userId: string | null): void {
  if (ownerId === userId) return;
  resetPendingWorkoutStore();
  ownerId = userId;
}

/** Save before awaiting session identity/plan reads, including a committed Start whose UI moved. */
export async function rememberPartnerWorkout(sessionId: string, workoutId: string): Promise<void> {
  const userId = ownerId;
  const saved =
    association?.sessionId === sessionId && association.workoutId === workoutId
      ? association
      : { sessionId, workoutId };
  association = saved;
  revision += 1;
  if (userId) await enqueueWrite(() => setPreference(storageKey(userId), saved));
}

export function getPartnerWorkoutTimer(sessionId: string, workoutId: string): PartnerWorkoutTimer | null {
  return association?.sessionId === sessionId && association.workoutId === workoutId
    ? (association.timer ?? null)
    : null;
}

export async function setPartnerWorkoutTimer(
  sessionId: string,
  workoutId: string,
  timer: PartnerWorkoutTimer | null,
): Promise<void> {
  if (association?.sessionId !== sessionId || association.workoutId !== workoutId) return;
  association = { ...association, timer };
  const saved = association;
  const userId = ownerId;
  revision += 1;
  if (userId) await enqueueWrite(() => setPreference(storageKey(userId), saved));
}

export async function clearActivePartnerWorkout(sessionId?: string): Promise<void> {
  if (sessionId && association?.sessionId !== sessionId && active?.sessionId !== sessionId) {
    // Teardown may beat cold-start hydration. Retire its fetch and conditionally
    // remove only that room's persisted record, before a newer Start writes.
    if (association || active) return;
    revision += 1;
    const userId = ownerId;
    if (userId)
      await enqueueWrite(async () => {
        const saved = await getPreference<ActiveWorkoutAssociation>(storageKey(userId));
        if (saved?.sessionId === sessionId) await removePreference(storageKey(userId));
      });
    return;
  }
  if (pending?.sessionId === sessionId || !sessionId) pending = null;
  association = null;
  active = null;
  revision += 1;
  const userId = ownerId;
  emit();
  if (userId) await enqueueWrite(() => removePreference(storageKey(userId)));
}

/** Only ids/deadlines live on disk; private instructions and stages come from the server. */
export async function hydratePartnerWorkout(
  sessionId: string | null,
  fetchWorkout: (id: string) => Promise<AppWorkout>,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const userId = ownerId;
  if (!userId) return;
  const generation = getCredentialGeneration();
  const expectedRevision = revision;
  const current = () =>
    ownerId === userId && generation === getCredentialGeneration() && revision === expectedRevision && isCurrent();
  await writeQueue;
  const saved = await getPreference<ActiveWorkoutAssociation>(storageKey(userId));
  if (!current() || !saved || typeof saved.sessionId !== 'string' || typeof saved.workoutId !== 'string') return;
  const workout = await fetchWorkout(saved.workoutId);
  if (!current()) return;
  if (workout.status !== 'started' || workout.sessionId !== saved.sessionId) {
    if (pending?.id === saved.workoutId) {
      pending = null;
      emit();
    }
    await clearActivePartnerWorkout(saved.sessionId);
    return;
  }
  association = saved;
  if (workout.sessionId === sessionId) {
    active = { sessionId, workout };
    if (pending?.id === workout.id) pending = null;
  } else if (!pending || pending.id === workout.id) pending = workout; // A committed Start won another room: confirmation lives behind Resume.
  emit();
}

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
  revision += 1;
  pending = workout;
  emit();
}
export function clearPendingWorkout(): void {
  revision += 1;
  pending = null;
  emit();
}
export function getPendingWorkout(): AppWorkout | null {
  return pending;
}
export function activatePartnerWorkout(sessionId: string, workout: AppWorkout): void {
  active = { sessionId, workout };
  void rememberPartnerWorkout(sessionId, workout.id).catch(() => undefined);
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
  void clearActivePartnerWorkout().catch(() => undefined);
  emit();
}
subscribeToCredentialChanges(() => {
  resetPendingWorkoutStore();
  ownerId = null;
});
