// Which workout stage each queued climb belongs to (#5379), for the session it
// was generated for. A module singleton read through `useSyncExternalStore`,
// the same shape as `rest-timer-store`.
//
// The stage stays on this phone, keyed by queue-item uuid: the queue items, the
// GraphQL schema and the wire mappers carry no stage. So a crew member's phone
// has no run, and that is fine: the readout is for the climber who built the
// workout.
//
// Persisted in ONE slot keyed by session id (like `session-comment-draft-store`):
// a read for a different session misses, and writing a run for a new session
// replaces the old one. It survives a cold start mid-workout; it does not
// survive the session ending, changing, or the account signing out.
//
// Never pruned as climbs leave the queue: Undo restores removed climbs under
// their old uuids, and they must come back in their stage. Readers count only
// queued uuids, so the stale ones cost nothing.
//
// Schema note: bump the key suffix if `WorkoutRun`'s shape changes, so a stale
// value is ignored rather than misread. An added OPTIONAL field (a stage's
// `targetGrade` or `filters`) needs no bump: a stored run without it still
// reads correctly.

import { useCallback, useSyncExternalStore } from 'react';
import {
  CLIMB_BIAS_OPTIONS,
  type WorkoutRun,
  type WorkoutRunStage,
  type WorkoutStageFilters,
} from '@boardsesh/playlist-generator';
import { getPreference, removePreference, setPreference } from './preference-store';

export const WORKOUT_RUN_STORAGE_KEY = 'boardsesh_workout_run_v1';

export type WorkoutRunRecord = { sessionId: string; run: WorkoutRun };

let state: WorkoutRunRecord | null = null;
// Bumped by every write, so a hydrate that started before a set or clear never
// lands on top of it.
let writeGeneration = 0;
const listeners = new Set<() => void>();

function setState(next: WorkoutRunRecord | null): void {
  writeGeneration += 1;
  if (next === state) return;
  state = next;
  for (const listener of listeners) listener();
}

// Best-effort: losing the stored copy only costs the readout after a relaunch.
function ignoreStorageError(): void {}

function persist(record: WorkoutRunRecord | null): void {
  const write = record ? setPreference<WorkoutRunRecord>(WORKOUT_RUN_STORAGE_KEY, record) : clearStoredWorkoutRun();
  write.catch(ignoreStorageError);
}

function clearStoredWorkoutRun(): Promise<void> {
  return removePreference(WORKOUT_RUN_STORAGE_KEY);
}

function isStageFilters(candidate: unknown): candidate is WorkoutStageFilters {
  if (typeof candidate !== 'object' || candidate === null) return false;
  const filters = candidate as Partial<Record<keyof WorkoutStageFilters, unknown>>;
  return (
    CLIMB_BIAS_OPTIONS.some((climbBias) => climbBias === filters.climbBias) &&
    typeof filters.minAscents === 'number' &&
    typeof filters.minRating === 'number' &&
    typeof filters.onlyTallClimbs === 'boolean' &&
    typeof filters.onlyWideClimbs === 'boolean'
  );
}

/**
 * One stored stage, or null when a field the readout needs is wrong. Unreadable
 * `filters` are dropped rather than failing the stage: losing them only costs a
 * mid-session block its starting filters, while dropping the run would let the
 * next "Add a block" overwrite the stages queued at Start.
 */
function readStage(candidate: unknown): WorkoutRunStage | null {
  if (typeof candidate !== 'object' || candidate === null) return null;
  const stage = candidate as Partial<Record<keyof WorkoutRunStage, unknown>>;
  if (
    typeof stage.id !== 'string' ||
    typeof stage.kind !== 'string' ||
    !Array.isArray(stage.itemUuids) ||
    !stage.itemUuids.every((uuid) => typeof uuid === 'string') ||
    // Optional and newer than the key: an older run without it still loads.
    (stage.targetGrade !== undefined && typeof stage.targetGrade !== 'number')
  ) {
    return null;
  }
  const { filters, ...rest } = candidate as WorkoutRunStage;
  return filters === undefined || isStageFilters(filters) ? (candidate as WorkoutRunStage) : rest;
}

/** The stored record, or null when it is not one. Only a stage's bad `filters` are repaired. */
function readWorkoutRunRecord(candidate: unknown): WorkoutRunRecord | null {
  if (typeof candidate !== 'object' || candidate === null) return null;
  const record = candidate as Partial<WorkoutRunRecord>;
  if (typeof record.sessionId !== 'string' || typeof record.run !== 'object' || record.run === null) return null;
  if (!Array.isArray(record.run.stages)) return null;
  const stages: WorkoutRunStage[] = [];
  for (const storedStage of record.run.stages) {
    const stage = readStage(storedStage);
    if (!stage) return null;
    stages.push(stage);
  }
  return { sessionId: record.sessionId, run: { stages } };
}

export function subscribeWorkoutRun(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getWorkoutRunState(): WorkoutRunRecord | null {
  return state;
}

/** The run for `sessionId`, or null when the store holds none or another session's. */
export function getWorkoutRunForSession(sessionId: string | null): WorkoutRun | null {
  return sessionId !== null && state?.sessionId === sessionId ? state.run : null;
}

/** Remember a session's run, replacing whatever was stored. An empty run clears. */
export function setWorkoutRun(sessionId: string, run: WorkoutRun): void {
  const next = run.stages.length > 0 ? { sessionId, run } : null;
  setState(next);
  persist(next);
}

/**
 * Load the stored run for `sessionId` after a cold start. No-op when the store
 * already holds that session's run, and a stored run for another session
 * misses. A read that fails leaves the store as it is.
 */
export async function hydrateWorkoutRun(sessionId: string): Promise<void> {
  if (state?.sessionId === sessionId) return;
  const generationAtRead = writeGeneration;
  let stored: unknown;
  try {
    stored = await getPreference<unknown>(WORKOUT_RUN_STORAGE_KEY);
  } catch {
    return;
  }
  if (generationAtRead !== writeGeneration) return;
  const record = readWorkoutRunRecord(stored);
  if (!record || record.sessionId !== sessionId) return;
  setState(record);
}

/** Forget the run, in memory and on disk. */
export function clearWorkoutRun(): Promise<void> {
  setState(null);
  return clearStoredWorkoutRun();
}

/**
 * `sessionId` ended or was left: forget its run. Always bumps the write
 * generation, so a hydrate for that session still in flight never lands after
 * it ended, and removes the stored slot when it names that session (the
 * restored session may have ended before its run was ever read into memory).
 */
export async function clearWorkoutRunForSession(sessionId: string): Promise<void> {
  if (state?.sessionId === sessionId) {
    setState(null);
  } else {
    writeGeneration += 1;
  }
  const generationAtRead = writeGeneration;
  try {
    const stored = await getPreference<unknown>(WORKOUT_RUN_STORAGE_KEY);
    // A run written while this read was in flight is newer and stays.
    if (generationAtRead !== writeGeneration) return;
    if (readWorkoutRunRecord(stored)?.sessionId === sessionId) await clearStoredWorkoutRun();
  } catch {
    ignoreStorageError();
  }
}

/** The run for `sessionId`. Re-renders only when that answer changes. */
export function useWorkoutRun(sessionId: string | null): WorkoutRun | null {
  const getSnapshot = useCallback(() => getWorkoutRunForSession(sessionId), [sessionId]);
  return useSyncExternalStore(subscribeWorkoutRun, getSnapshot, getSnapshot);
}

/** Test-only: drop every listener and return to the empty state. */
export function resetWorkoutRunStoreForTests(): void {
  state = null;
  writeGeneration = 0;
  listeners.clear();
}
