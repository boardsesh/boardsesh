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
// survive the session ending, changing, or the account signing out (the end
// hands the record to `ended-workout-store` as the summary's recap, #6903).
//
// Never pruned as climbs leave the queue: Undo restores removed climbs under
// their old uuids, and they must come back in their stage. Readers count only
// queued uuids, so the stale ones cost nothing.
//
// The record also keeps a tick log: the ticks logged on this phone on the run's
// climbs, by queue item (#5380, #6231). Ticks carry no queue item on the server,
// so this is the only place a 4x4 set's reps or a limit climb's falls are
// counted.
//
// Schema note. An added OPTIONAL field needs no new key: a stored run without it
// still reads, and a field this bundle cannot read is dropped on its own (see
// `readStage`). A new stage KIND is different. Bundles from before the timed
// kinds pass an unknown kind straight through, and their "Add a block" then
// crashes on it; an OTA rollback lands on the bundle embedded in the binary by
// default, which can be that old. So a run holding any kind outside
// `V1_STAGE_KINDS` is written under `_v2`, which no such bundle reads, and every
// other run stays under `_v1`. One slot holds the run at a time, except after a
// rollback mid-session: see `mergeSlotsForSession`.

import { useCallback, useSyncExternalStore } from 'react';
import {
  CLIMB_BIAS_OPTIONS,
  appendStageToRun,
  isWorkoutStageKind,
  isWorkoutStagePacing,
  type WorkoutRun,
  type WorkoutRunStage,
  type WorkoutStageFilters,
  type WorkoutStageKind,
} from '@boardsesh/playlist-generator';
import { getPreference, removePreference, setPreference } from './preference-store';

/** The slot every bundle since #5379 reads. Holds the runs made only of `V1_STAGE_KINDS`. */
export const WORKOUT_RUN_STORAGE_KEY = 'boardsesh_workout_run_v1';
/** The slot for a run with any newer kind, so a rolled-back bundle never reads it. */
export const WORKOUT_RUN_V2_STORAGE_KEY = 'boardsesh_workout_run_v2';

/**
 * `_v2` then `_v1`. A slot names its session, so the one for the session asked
 * about is the run; when both name it, `_v1`'s stages are merged in after `_v2`'s.
 */
const STORAGE_KEYS_IN_READ_ORDER = [WORKOUT_RUN_V2_STORAGE_KEY, WORKOUT_RUN_STORAGE_KEY] as const;

/** The kinds the `_v1` readers know. Frozen: a new kind goes under `_v2`, never on this list. */
const V1_STAGE_KINDS: ReadonlySet<WorkoutStageKind> = new Set<WorkoutStageKind>([
  'warmUp',
  'volume',
  'pyramid',
  'ladder',
  'gradeFocus',
]);

/** How a tick on a workout climb came out. */
export type WorkoutTickStatus = 'flash' | 'send' | 'attempt';

const WORKOUT_TICK_STATUSES: readonly WorkoutTickStatus[] = ['flash', 'send', 'attempt'];

/** One tick logged on this phone on a climb of the run. */
export type WorkoutTickLogEntry = {
  queueItemUuid: string;
  status: WorkoutTickStatus;
  /** ISO time the tick says it was climbed. */
  climbedAt: string;
  tickUuid?: string;
};

/**
 * The most ticks one record keeps; past it, the oldest go first. The record is
 * rewritten whole on every tick, so this also caps that write (about 100 bytes
 * an entry). A 4x4 is 16 ticks and a long limit session a few dozen.
 */
export const MAX_WORKOUT_TICK_LOG = 2000;

/** The server stores the revision as a Postgres integer. */
export const MAX_WORKOUT_REVISION = 2_147_483_647;

/** 2026-01-01T00:00:00Z: the revision floor counts seconds from here (see `nextWorkoutRunRevision`). */
const REVISION_EPOCH_MS = Date.UTC(2026, 0, 1);

/**
 * The climb behind one queue item of the run, captured when the run is written
 * (#6903): by the time the session ends the queue is gone, and the server's
 * copy of the workout needs each item's climb, angle and mirror. `name`,
 * `difficulty` (the climb's grade label, "6a/V3") and `boardType` stay on the
 * phone; they draw the summary while its write is still in the outbox.
 */
export type WorkoutRunClimb = {
  climbUuid: string;
  angle: number;
  isMirror?: boolean;
  name?: string;
  difficulty?: string;
  boardType?: string;
};

export type WorkoutRunRecord = {
  sessionId: string;
  run: WorkoutRun;
  log?: WorkoutTickLogEntry[];
  /** Prepared on Workout; only an explicit Start workout begins its pacing. */
  pendingStart?: true;
  /** By queue-item uuid. Newer than the key, so optional: an older run reads without it. */
  climbs?: Record<string, WorkoutRunClimb>;
  /**
   * The revision of the last copy of this run queued for the server
   * (`recordSessionWorkout`), so each write outranks the one before. Optional
   * for the same reason as `climbs`.
   */
  revision?: number;
  /**
   * A digest of what that copy held (`sessionWorkoutDigest`), so a write with
   * nothing new (the session-end write after the End button's) is skipped.
   */
  sentDigest?: string;
};

const EMPTY_LOG: readonly WorkoutTickLogEntry[] = Object.freeze([]);

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

/** The slot a run is written to: `_v2` as soon as it holds a kind the `_v1` readers do not know. */
export function workoutRunStorageKey(run: WorkoutRun): string {
  return run.stages.every((stage) => V1_STAGE_KINDS.has(stage.kind))
    ? WORKOUT_RUN_STORAGE_KEY
    : WORKOUT_RUN_V2_STORAGE_KEY;
}

// Writing one slot removes the other, so a run never sits in both.
function persist(record: WorkoutRunRecord | null): void {
  if (!record) {
    clearStoredWorkoutRun().catch(ignoreStorageError);
    return;
  }
  const key = workoutRunStorageKey(record.run);
  const otherKey = key === WORKOUT_RUN_STORAGE_KEY ? WORKOUT_RUN_V2_STORAGE_KEY : WORKOUT_RUN_STORAGE_KEY;
  setPreference<WorkoutRunRecord>(key, record).catch(ignoreStorageError);
  removePreference(otherKey).catch(ignoreStorageError);
}

async function clearStoredWorkoutRun(): Promise<void> {
  await Promise.all(STORAGE_KEYS_IN_READ_ORDER.map((key) => removePreference(key)));
}

function isStageFilters(candidate: unknown): candidate is WorkoutStageFilters {
  if (typeof candidate !== 'object' || candidate === null) return false;
  const filters = candidate as Partial<Record<keyof WorkoutStageFilters, unknown>>;
  return (
    CLIMB_BIAS_OPTIONS.some((climbBias) => climbBias === filters.climbBias) &&
    typeof filters.minAscents === 'number' &&
    typeof filters.minRating === 'number' &&
    typeof filters.onlyTallClimbs === 'boolean' &&
    typeof filters.onlyWideClimbs === 'boolean' &&
    // Newer than the key: filters stored without them still read.
    (filters.skipSent === undefined || typeof filters.skipSent === 'boolean') &&
    (filters.skipTried === undefined || typeof filters.skipTried === 'boolean') &&
    (filters.onlyBenchmarks === undefined || typeof filters.onlyBenchmarks === 'boolean')
  );
}

/** A stored stage whose kind this bundle does not know, most likely written by a newer bundle. */
function hasUnknownKind(candidate: unknown): boolean {
  if (typeof candidate !== 'object' || candidate === null) return false;
  return !isWorkoutStageKind((candidate as { kind?: unknown }).kind);
}

/**
 * The two fields a 4x4 stage stored before sets (Marco, 2026-10-25) carried:
 * its rounds, and each queue item's round. Nothing reads them any more, so they
 * are dropped on read and never written back.
 */
type LegacyRoundFields = { rounds?: unknown; roundByUuid?: unknown };

/**
 * One stored stage, or null when a field the readout needs is wrong. Each
 * unreadable optional field (`filters`, `pacing`) is dropped on its own rather
 * than failing the stage: losing one costs a mid-session block its starting
 * filters, or a timed stage its own pacing, while dropping the run would let
 * the next "Add a block" overwrite the stages queued at Start. A tester's 4x4
 * from before sets loses its pacing that way (`isWorkoutStagePacing`), and its
 * round fields with it, so its climbs read as an ordinary block.
 */
function readStage(candidate: unknown): WorkoutRunStage | null {
  if (typeof candidate !== 'object' || candidate === null) return null;
  const stage = candidate as Partial<Record<keyof WorkoutRunStage, unknown>>;
  if (
    typeof stage.id !== 'string' ||
    !isWorkoutStageKind(stage.kind) ||
    !Array.isArray(stage.itemUuids) ||
    !stage.itemUuids.every((uuid) => typeof uuid === 'string') ||
    // Optional and newer than the key: an older run without it still loads.
    (stage.targetGrade !== undefined && typeof stage.targetGrade !== 'number')
  ) {
    return null;
  }
  const readable: WorkoutRunStage & LegacyRoundFields = { ...(candidate as WorkoutRunStage) };
  delete readable.rounds;
  delete readable.roundByUuid;
  if (stage.filters !== undefined && !isStageFilters(stage.filters)) delete readable.filters;
  if (stage.pacing !== undefined && !isWorkoutStagePacing(stage.pacing)) delete readable.pacing;
  return readable;
}

function readTickLogEntry(candidate: unknown): WorkoutTickLogEntry | null {
  if (typeof candidate !== 'object' || candidate === null) return null;
  const entry = candidate as Partial<Record<keyof WorkoutTickLogEntry, unknown>>;
  const status = WORKOUT_TICK_STATUSES.find((knownStatus) => knownStatus === entry.status);
  if (typeof entry.queueItemUuid !== 'string' || !status || typeof entry.climbedAt !== 'string') return null;
  const readable: WorkoutTickLogEntry = { queueItemUuid: entry.queueItemUuid, status, climbedAt: entry.climbedAt };
  if (typeof entry.tickUuid === 'string') readable.tickUuid = entry.tickUuid;
  return readable;
}

function readRunClimb(candidate: unknown): WorkoutRunClimb | null {
  if (typeof candidate !== 'object' || candidate === null) return null;
  const climb = candidate as Partial<Record<keyof WorkoutRunClimb, unknown>>;
  if (typeof climb.climbUuid !== 'string' || typeof climb.angle !== 'number' || !Number.isFinite(climb.angle)) {
    return null;
  }
  const readable: WorkoutRunClimb = { climbUuid: climb.climbUuid, angle: climb.angle };
  if (typeof climb.isMirror === 'boolean') readable.isMirror = climb.isMirror;
  if (typeof climb.name === 'string') readable.name = climb.name;
  if (typeof climb.difficulty === 'string') readable.difficulty = climb.difficulty;
  if (typeof climb.boardType === 'string') readable.boardType = climb.boardType;
  return readable;
}

/** The captured climbs, one by one: an unreadable entry costs only that item its server copy. */
function readRunClimbs(candidate: unknown): Record<string, WorkoutRunClimb> | undefined {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return undefined;
  const climbs: Record<string, WorkoutRunClimb> = {};
  let count = 0;
  for (const [queueItemUuid, entry] of Object.entries(candidate)) {
    const climb = readRunClimb(entry);
    if (!climb) continue;
    climbs[queueItemUuid] = climb;
    count += 1;
  }
  return count > 0 ? climbs : undefined;
}

const isRevision = (candidate: unknown): candidate is number =>
  typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 0 && candidate <= MAX_WORKOUT_REVISION;

/**
 * The stored record, or null when it is not one. A stage of a kind this bundle
 * does not know is left out and the rest of the run kept, so its climbs read as
 * hand-queued; only a stage this bundle should read but cannot fails the whole
 * record. Unreadable log entries are left out one by one.
 */
export function readWorkoutRunRecord(candidate: unknown): WorkoutRunRecord | null {
  if (typeof candidate !== 'object' || candidate === null) return null;
  const record = candidate as Partial<Record<keyof WorkoutRunRecord, unknown>>;
  if (typeof record.sessionId !== 'string' || typeof record.run !== 'object' || record.run === null) return null;
  const storedStages = (record.run as { stages?: unknown }).stages;
  if (!Array.isArray(storedStages)) return null;
  const stages: WorkoutRunStage[] = [];
  for (const storedStage of storedStages) {
    if (hasUnknownKind(storedStage)) continue;
    const stage = readStage(storedStage);
    if (!stage) return null;
    stages.push(stage);
  }
  const readable: WorkoutRunRecord = { sessionId: record.sessionId, run: { stages } };
  if (record.pendingStart === true) readable.pendingStart = true;
  if (Array.isArray(record.log)) {
    const log = record.log.map(readTickLogEntry).filter((entry): entry is WorkoutTickLogEntry => entry !== null);
    if (log.length > 0) readable.log = log;
  }
  const climbs = readRunClimbs(record.climbs);
  if (climbs) readable.climbs = climbs;
  if (isRevision(record.revision)) readable.revision = record.revision;
  if (typeof record.sentDigest === 'string') readable.sentDigest = record.sentDigest;
  return readable;
}

async function readStoredRecord(key: string): Promise<WorkoutRunRecord | null> {
  return readWorkoutRunRecord(await getPreference<unknown>(key));
}

/**
 * One tick's identity, as a string, so the same tick in two logs is kept once.
 * A tick with a uuid is that uuid alone: its copies in the two slots can differ
 * in `climbedAt` or `status` and are still one tick. Without a uuid, the queue
 * item, status and time are all there is, so two attempts on one climb at
 * different times stay two.
 */
function tickLogEntryKey({ queueItemUuid, status, climbedAt, tickUuid }: WorkoutTickLogEntry): string {
  return tickUuid ? JSON.stringify(['tick', tickUuid]) : JSON.stringify(['entry', queueItemUuid, status, climbedAt]);
}

/** `earlier` then the entries of `later` it lacks, capped like any log. A tick in both keeps `earlier`'s copy. */
function joinTickLogs(
  earlier: WorkoutTickLogEntry[] | undefined,
  later: WorkoutTickLogEntry[] | undefined,
): WorkoutTickLogEntry[] | undefined {
  if (!later || later.length === 0) return earlier;
  if (!earlier || earlier.length === 0) return later;
  const earlierKeys = new Set(earlier.map(tickLogEntryKey));
  const joined = [...earlier, ...later.filter((entry) => !earlierKeys.has(tickLogEntryKey(entry)))];
  return joined.length > MAX_WORKOUT_TICK_LOG ? joined.slice(joined.length - MAX_WORKOUT_TICK_LOG) : joined;
}

/** Both maps' captured climbs; an item in both keeps `earlier`'s. */
export function joinRunClimbs(
  earlier: Record<string, WorkoutRunClimb> | undefined,
  later: Record<string, WorkoutRunClimb> | undefined,
): Record<string, WorkoutRunClimb> | undefined {
  if (!later) return earlier;
  if (!earlier) return later;
  return { ...later, ...earlier };
}

/**
 * The run when both slots name the same session. That only happens after an
 * OTA rollback mid-session: a bundle that knows the timed kinds wrote `_v2` and
 * removed `_v1`, then a bundle from before them, which never reads, writes or
 * clears `_v2`, saw no run and wrote its "Add a block" to `_v1`. Each copy then
 * holds part of the run and `_v1`'s part is the newer one, so taking either
 * alone would read the other's climbs as hand-queued, and the next write, which
 * removes the other slot, would lose them for good. So `_v1`'s stages go after
 * `_v2`'s. Every block mints fresh stage ids and queue-item uuids, and a uuid
 * already in `_v2` (a copy left by a remove that failed) is skipped; a `_v1`
 * stage whose id names a `_v2` stage of another kind is left out. The logs are
 * joined the same way. Nothing is written back: the next write stores the whole
 * run, and until then a second rollback still finds its `_v1`.
 */
function mergeSlotsForSession(newerKinds: WorkoutRunRecord, originalKinds: WorkoutRunRecord): WorkoutRunRecord {
  let run = newerKinds.run;
  for (const stage of originalKinds.run.stages) {
    const stageWithSameId = run.stages.find((runStage) => runStage.id === stage.id);
    if (stageWithSameId && stageWithSameId.kind !== stage.kind) continue;
    run = appendStageToRun(run, stage, stage.itemUuids);
  }
  const merged: WorkoutRunRecord = { sessionId: newerKinds.sessionId, run };
  if (newerKinds.pendingStart || originalKinds.pendingStart) merged.pendingStart = true;
  const log = joinTickLogs(newerKinds.log, originalKinds.log);
  if (log) merged.log = log;
  const climbs = joinRunClimbs(newerKinds.climbs, originalKinds.climbs);
  if (climbs) merged.climbs = climbs;
  const revision = Math.max(newerKinds.revision ?? -1, originalKinds.revision ?? -1);
  if (revision >= 0) merged.revision = revision;
  // No `sentDigest`: neither slot's copy holds the merged run, so the next
  // write has to go out.
  return merged;
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

/** An older record without the optional marker is an already-started workout. */
export function isWorkoutRunPendingStart(sessionId: string | null): boolean {
  return sessionId !== null && state?.sessionId === sessionId && state.pendingStart === true;
}

/**
 * Prepare a new workout without starting its first climb or its clock.
 * `climbs` is each queued item's climb (`captureWorkoutRunClimbs`).
 */
export function prepareWorkoutRun(sessionId: string, run: WorkoutRun, climbs?: Record<string, WorkoutRunClimb>): void {
  let next: WorkoutRunRecord | null = null;
  if (run.stages.length > 0) {
    next = { sessionId, run, pendingStart: true };
    if (climbs && Object.keys(climbs).length > 0) next.climbs = { ...climbs };
  }
  setState(next);
  persist(next);
}

/** Consume the launch once, even when multiple pill/card callbacks still hold the old render. */
export function markWorkoutRunStarted(sessionId: string): boolean {
  if (!isWorkoutRunPendingStart(sessionId) || state === null) return false;
  const next = { ...state };
  delete next.pendingStart;
  setState(next);
  persist(next);
  return true;
}

/**
 * Remember a session's run, replacing whatever was stored. An empty run clears.
 * The tick log, the captured climbs and the revision stay when the session is
 * the same: "Add a block" rewrites the run mid-workout, and the ticks already
 * logged must survive it. `climbs` adds the new items' climbs.
 */
export function setWorkoutRun(sessionId: string, run: WorkoutRun, climbs?: Record<string, WorkoutRunClimb>): void {
  let next: WorkoutRunRecord | null = null;
  if (run.stages.length > 0) {
    next = { sessionId, run };
    const kept = state?.sessionId === sessionId ? state : null;
    if (kept?.log) next.log = kept.log;
    const mergedClimbs = { ...kept?.climbs, ...climbs };
    if (Object.keys(mergedClimbs).length > 0) next.climbs = mergedClimbs;
    if (kept?.revision !== undefined) next.revision = kept.revision;
    if (kept?.sentDigest !== undefined) next.sentDigest = kept.sentDigest;
    if (isWorkoutRunPendingStart(sessionId)) next.pendingStart = true;
  }
  setState(next);
  persist(next);
}

/**
 * Bring the captured climbs up to date from queue items still in the queue: an
 * item the record has no climb for is filled in (a run written by an older
 * bundle, which drops `climbs`, gets them back this way), and an item mirrored
 * since it was captured takes its new mirror. The climb and angle a queue item
 * names never change, so nothing else is touched.
 */
export function addWorkoutRunClimbs(sessionId: string, climbs: Record<string, WorkoutRunClimb>): void {
  if (state?.sessionId !== sessionId) return;
  const current = state.climbs ?? {};
  const updates: Array<[string, WorkoutRunClimb]> = [];
  for (const [queueItemUuid, climb] of Object.entries(climbs)) {
    const kept = current[queueItemUuid];
    if (!kept) {
      updates.push([queueItemUuid, climb]);
    } else if (climb.isMirror !== undefined && kept.isMirror !== climb.isMirror) {
      updates.push([queueItemUuid, { ...kept, isMirror: climb.isMirror }]);
    }
  }
  if (updates.length === 0) return;
  const next: WorkoutRunRecord = { ...state, climbs: { ...current, ...Object.fromEntries(updates) } };
  setState(next);
  persist(next);
}

/**
 * The revision after `revision`: a counter, floored at the seconds since 2026
 * began. An OTA rollback to a bundle that predates the field rewrites the
 * record without it, and after the roll forward a counter restarting at 1 would
 * sit below the revision the server already holds, so every later write would
 * be a no-op. The floor keeps it climbing (and inside a Postgres integer until
 * 2094); the counter keeps two writes in one second apart.
 */
export function revisionAfter(revision: number | undefined, nowMs: number): number {
  const floor = Math.max(0, Math.floor((nowMs - REVISION_EPOCH_MS) / 1000));
  return Math.min(MAX_WORKOUT_REVISION, Math.max((revision ?? 0) + 1, floor));
}

/**
 * The next revision for `sessionId`'s server copy, stored with the run so the
 * one after it is higher still. Null when the store holds another session's
 * run or none.
 */
export function nextWorkoutRunRevision(sessionId: string, nowMs: number): number | null {
  if (state?.sessionId !== sessionId) return null;
  const revision = revisionAfter(state.revision, nowMs);
  const next: WorkoutRunRecord = { ...state, revision };
  setState(next);
  persist(next);
  return revision;
}

/**
 * The copy at `revision` is queued (or sent): remember what it held, so a
 * later write with nothing new is skipped. Ignored when a newer revision was
 * taken meanwhile.
 */
export function noteWorkoutRunSent(sessionId: string, revision: number, sentDigest: string): void {
  if (state?.sessionId !== sessionId || state.revision !== revision || state.sentDigest === sentDigest) return;
  const next: WorkoutRunRecord = { ...state, sentDigest };
  setState(next);
  persist(next);
}

/**
 * A tick deleted from the logbook (#6903): out of the run's tick log, so the
 * phone's own tallies and its "still saving" count stop counting it.
 */
export function forgetWorkoutRunTick(tickUuid: string): void {
  if (!state?.log?.some((entry) => entry.tickUuid === tickUuid)) return;
  const next: WorkoutRunRecord = { ...state, log: state.log.filter((entry) => entry.tickUuid !== tickUuid) };
  setState(next);
  persist(next);
}

/**
 * Log a tick on a climb of `sessionId`'s run. Does nothing when the store holds
 * another session's run or none, or when the climb is in no stage of it, so a
 * hand-queued climb's tick never reaches the log. Keeps the newest
 * `MAX_WORKOUT_TICK_LOG` entries.
 *
 * `climb` is the climb the tick was logged on, which is the queue item's climb
 * at its angle (`attributeTickToQueueItem`). It fills in an item the record has
 * no climb for, and never replaces one it has. Without it the server copy and
 * the recap leave the item out, and a run whose climbs were all lost (written
 * by a bundle that predates `climbs`, or rewritten by one after an OTA
 * rollback) is never sent at all unless the climber ends the session on this
 * phone: Leave, an End on another phone and a relaunch onto an ended session
 * have no queue to fill it from (#6903).
 */
export function noteWorkoutRunTick(sessionId: string, entry: WorkoutTickLogEntry, climb?: WorkoutRunClimb): void {
  if (state?.sessionId !== sessionId) return;
  const inRun = state.run.stages.some((stage) => stage.itemUuids.includes(entry.queueItemUuid));
  if (!inRun) return;
  const log = [...(state.log ?? EMPTY_LOG), { ...entry }];
  const next: WorkoutRunRecord = {
    ...state,
    log: log.length > MAX_WORKOUT_TICK_LOG ? log.slice(log.length - MAX_WORKOUT_TICK_LOG) : log,
  };
  if (climb && !state.climbs?.[entry.queueItemUuid]) {
    next.climbs = { ...state.climbs, [entry.queueItemUuid]: { ...climb } };
  }
  setState(next);
  persist(next);
}

/** The ticks logged on `sessionId`'s run, oldest first. The same array until a tick is added. */
export function getWorkoutRunLog(sessionId: string | null): readonly WorkoutTickLogEntry[] {
  if (sessionId === null || state?.sessionId !== sessionId) return EMPTY_LOG;
  return state.log ?? EMPTY_LOG;
}

/** The ticks a log holds for one queue item, falls and sends alike: a 4x4 set's reps so far. */
export function countWorkoutRunTicks(log: readonly WorkoutTickLogEntry[], queueItemUuid: string | null): number {
  if (queueItemUuid === null) return 0;
  let count = 0;
  for (const entry of log) if (entry.queueItemUuid === queueItemUuid) count += 1;
  return count;
}

/**
 * How a hydrate ended. `'clean'`: the store holds `sessionId`'s run, or both
 * slots were read and gave none to load. `'failed'`: neither, so a stored run
 * for the session may be missing from the store, and a write made from it now
 * ("Add a block") would remove the slot it did not read.
 */
export type WorkoutRunHydrateResult = 'clean' | 'failed';

/** After a hydrate stopped early: clean only if the store holds the session's run anyway. */
function hydrateResultForHeldRun(sessionId: string): WorkoutRunHydrateResult {
  return state?.sessionId === sessionId ? 'clean' : 'failed';
}

/**
 * Load the stored run for `sessionId` after a cold start. No-op when the store
 * already holds that session's run, and a stored run for another session
 * misses. Both slots are read, `_v2` first; the one naming this session is the
 * run, and when both name it they are merged (`mergeSlotsForSession`). A read
 * that fails, of either slot, leaves the store as it is (see the catch) and
 * reports `'failed'`, unless the store holds the session's run anyway.
 */
export async function hydrateWorkoutRun(sessionId: string): Promise<WorkoutRunHydrateResult> {
  if (state?.sessionId === sessionId) return 'clean';
  const generationAtRead = writeGeneration;
  let hydrated: WorkoutRunRecord | null = null;
  for (const key of STORAGE_KEYS_IN_READ_ORDER) {
    let record: WorkoutRunRecord | null;
    try {
      record = await readStoredRecord(key);
    } catch {
      // Fail closed: do not hydrate from the other slot alone. The slot that
      // failed may name this session too (after a rollback both can, see
      // `mergeSlotsForSession`), and a run read without its part is not just a
      // short readout: the next write of it ("Add a block" or a tick) goes
      // through `persist`, which writes one slot and removes the other. A run
      // read from `_v1` alone holds only original kinds, so that write lands in
      // `_v1` and removes `_v2`, and the stages queued at Start are gone for
      // good (read from `_v2` alone, it removes the block `_v1` holds). With
      // the store left empty a tick is not logged and nothing is written, and
      // the next hydrate (Add a block runs one first) reads both slots again.
      return hydrateResultForHeldRun(sessionId);
    }
    // A write landed mid-read. It is newer, so this read stops; whatever slot it
    // did not reach yet is unread.
    if (generationAtRead !== writeGeneration) return hydrateResultForHeldRun(sessionId);
    if (record?.sessionId !== sessionId) continue;
    hydrated = hydrated ? mergeSlotsForSession(hydrated, record) : record;
  }
  // Nothing to show: no slot named this session, or the slot that did held only
  // stages of a kind this bundle does not know. A _v1 slot naming the same session
  // is merged in above, before this check, so the second case reaches here only
  // when there is no _v1 fallback.
  if (!hydrated || hydrated.run.stages.length === 0) return 'clean';
  setState(hydrated);
  return 'clean';
}

/** Forget the run, in memory and on disk. */
export function clearWorkoutRun(): Promise<void> {
  setState(null);
  return clearStoredWorkoutRun();
}

/**
 * `sessionId` ended or was left: forget its run. Always bumps the write
 * generation, so a hydrate for that session still in flight never lands after
 * it ended, and removes each stored slot that names that session (the restored
 * session may have ended before its run was ever read into memory).
 *
 * `onCleared` gets the record that went (#6903), so the session summary can
 * keep a recap of it: called at once with the run in memory, or once the first
 * stored slot naming the session is read when only the disk held it. Called at
 * most once, and not at all when nothing named the session.
 */
export async function clearWorkoutRunForSession(
  sessionId: string,
  onCleared?: (record: WorkoutRunRecord) => void,
): Promise<void> {
  let reported = false;
  if (state?.sessionId === sessionId) {
    const cleared = state;
    setState(null);
    reported = true;
    onCleared?.(cleared);
  } else {
    writeGeneration += 1;
  }
  const generationAtRead = writeGeneration;
  for (const key of STORAGE_KEYS_IN_READ_ORDER) {
    try {
      const stored = await readStoredRecord(key);
      // A run written while this read was in flight is newer and stays.
      if (generationAtRead !== writeGeneration) return;
      if (stored?.sessionId === sessionId) {
        if (!reported) {
          reported = true;
          onCleared?.(stored);
        }
        await removePreference(key);
      }
    } catch {
      ignoreStorageError();
    }
  }
}

/** The run for `sessionId`. Re-renders only when that answer changes. */
export function useWorkoutRun(sessionId: string | null): WorkoutRun | null {
  const getSnapshot = useCallback(() => getWorkoutRunForSession(sessionId), [sessionId]);
  return useSyncExternalStore(subscribeWorkoutRun, getSnapshot, getSnapshot);
}

/**
 * The whole record for `sessionId` (run, tick log, captured climbs), or null.
 * Re-renders on every write to it, a tick included: for the session screens'
 * workout (#6903), never for a list row.
 */
export function useWorkoutRunRecord(sessionId: string | null): WorkoutRunRecord | null {
  const getSnapshot = useCallback(
    () => (sessionId !== null && state?.sessionId === sessionId ? state : null),
    [sessionId],
  );
  return useSyncExternalStore(subscribeWorkoutRun, getSnapshot, getSnapshot);
}

/** Separate from the run identity, which stays the same when Start is consumed. */
export function useWorkoutRunPendingStart(sessionId: string | null): boolean {
  const getSnapshot = useCallback(() => isWorkoutRunPendingStart(sessionId), [sessionId]);
  return useSyncExternalStore(subscribeWorkoutRun, getSnapshot, getSnapshot);
}

/** The ticks logged on `sessionId`'s run. Re-renders only when a tick is added or the run goes. */
export function useWorkoutRunLog(sessionId: string | null): readonly WorkoutTickLogEntry[] {
  const getSnapshot = useCallback(() => getWorkoutRunLog(sessionId), [sessionId]);
  return useSyncExternalStore(subscribeWorkoutRun, getSnapshot, getSnapshot);
}

/** Test-only: drop every listener and return to the empty state. */
export function resetWorkoutRunStoreForTests(): void {
  state = null;
  writeGeneration = 0;
  listeners.clear();
}
