// A recap of each workout this phone ran, kept after its session ends (#6903).
// A module singleton read through `useSyncExternalStore`, like `workout-run-store`.
//
// The live run goes when the session ends (`WorkoutRunSessionSync` calls
// `clearWorkoutRunForSession`), before the summary screen mounts. The summary
// still needs it: the server answers nothing for a workout whose owner has no
// synced tick yet, and while ticks wait in the outbox its tallies are short.
// So the record that went (run, tick log, captured climbs) moves here, keyed by
// session id, and the summary and session detail fall back to it.
//
// Persisted under its own key, which no older bundle reads, so it needs none
// of the run slots' rollback rules. Keeps the newest `MAX_ENDED_WORKOUTS`, none
// older than `ENDED_WORKOUT_MAX_AGE_MS`; cleared on sign-out beside the run.

import { useCallback, useSyncExternalStore } from 'react';
import { getPreference, removePreference, setPreference } from './preference-store';
import { parseWorkoutRunRecord, type WorkoutRunRecord } from './workout-run-store';

export const ENDED_WORKOUTS_STORAGE_KEY = 'boardsesh_ended_workouts_v1';
export const MAX_ENDED_WORKOUTS = 10;
export const ENDED_WORKOUT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** The run as it stood when its session ended. */
export type EndedWorkoutRecord = WorkoutRunRecord & {
  /** Epoch ms the session was seen to end on this phone. */
  endedAtMs: number;
};

type StoredEndedWorkouts = { records: unknown[] };

/** Newest first. */
let records: readonly EndedWorkoutRecord[] = [];
let hydration: Promise<void> | null = null;
// Bumped by every clear, so a hydrate that started before one never brings back what it cleared.
let clearGeneration = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function ignoreStorageError(): void {}

function readEndedWorkout(candidate: unknown): EndedWorkoutRecord | null {
  const record = parseWorkoutRunRecord(candidate);
  const endedAtMs = (candidate as { endedAtMs?: unknown } | null)?.endedAtMs;
  if (!record || typeof endedAtMs !== 'number' || !Number.isFinite(endedAtMs)) return null;
  return { ...record, endedAtMs };
}

/** Newest first, one per session, within the count and age caps. */
function prune(candidates: readonly EndedWorkoutRecord[], nowMs: number): EndedWorkoutRecord[] {
  const seen = new Set<string>();
  const kept: EndedWorkoutRecord[] = [];
  for (const record of [...candidates].sort((left, right) => right.endedAtMs - left.endedAtMs)) {
    if (seen.has(record.sessionId) || nowMs - record.endedAtMs > ENDED_WORKOUT_MAX_AGE_MS) continue;
    seen.add(record.sessionId);
    kept.push(record);
    if (kept.length >= MAX_ENDED_WORKOUTS) break;
  }
  return kept;
}

function persist(next: readonly EndedWorkoutRecord[]): void {
  if (next.length === 0) {
    removePreference(ENDED_WORKOUTS_STORAGE_KEY).catch(ignoreStorageError);
    return;
  }
  setPreference<StoredEndedWorkouts>(ENDED_WORKOUTS_STORAGE_KEY, { records: [...next] }).catch(ignoreStorageError);
}

/**
 * Keep `record` as `record.sessionId`'s recap, replacing an older one for the
 * same session. A run with no stages is not a workout and is not kept.
 */
export function rememberEndedWorkout(record: WorkoutRunRecord, nowMs: number): void {
  if (record.run.stages.length === 0) return;
  const ended: EndedWorkoutRecord = { ...record, endedAtMs: nowMs };
  delete (ended as { pendingStart?: true }).pendingStart;
  records = prune([ended, ...records.filter((kept) => kept.sessionId !== record.sessionId)], nowMs);
  emit();
  // Written once the stored recaps are read in, so this write never drops the
  // ones a cold start has not loaded yet.
  const clearGenerationAtWrite = clearGeneration;
  void hydrateEndedWorkouts(nowMs).then(() => {
    if (clearGenerationAtWrite === clearGeneration) persist(records);
  });
}

/** The recap for `sessionId`, or null. */
export function getEndedWorkout(sessionId: string | null | undefined): EndedWorkoutRecord | null {
  if (!sessionId) return null;
  return records.find((record) => record.sessionId === sessionId) ?? null;
}

/**
 * Read the stored recaps once per launch. Recaps remembered before the read
 * lands win over stored copies of the same session.
 */
export function hydrateEndedWorkouts(nowMs: number): Promise<void> {
  hydration ??= (async () => {
    const generationAtRead = clearGeneration;
    let stored: StoredEndedWorkouts | null = null;
    try {
      stored = await getPreference<StoredEndedWorkouts>(ENDED_WORKOUTS_STORAGE_KEY);
    } catch {
      return;
    }
    const storedRecords = Array.isArray(stored?.records) ? stored.records : [];
    const read = storedRecords.map(readEndedWorkout).filter((record): record is EndedWorkoutRecord => record !== null);
    if (read.length === 0) return;
    // A sign-out landed while the read was in flight: what was read is gone.
    if (generationAtRead !== clearGeneration) return;
    const inMemory = new Set(records.map((record) => record.sessionId));
    const next = prune([...records, ...read.filter((record) => !inMemory.has(record.sessionId))], nowMs);
    records = next;
    emit();
  })();
  return hydration;
}

/** Sign-out: forget every recap, in memory and on disk. */
export function clearEndedWorkouts(): Promise<void> {
  clearGeneration += 1;
  records = [];
  emit();
  return removePreference(ENDED_WORKOUTS_STORAGE_KEY);
}

export function subscribeEndedWorkouts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The recap for `sessionId`. Re-renders only when that answer changes. */
export function useEndedWorkout(sessionId: string | null | undefined): EndedWorkoutRecord | null {
  const getSnapshot = useCallback(() => getEndedWorkout(sessionId), [sessionId]);
  return useSyncExternalStore(subscribeEndedWorkouts, getSnapshot, getSnapshot);
}

/** Test-only: back to an empty, unhydrated store. */
export function resetEndedWorkoutStoreForTests(): void {
  records = [];
  hydration = null;
  clearGeneration = 0;
  listeners.clear();
}
