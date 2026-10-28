import type {
  SessionWorkoutPacing,
  SessionWorkoutPlan,
  SessionWorkoutPlanItem,
  SessionWorkoutPlanStage,
  SessionWorkoutTickMapEntry,
} from './types';

/** Caps on one stored workout. A plan or tick map over any of them is rejected, not trimmed. */
export const MAX_SESSION_WORKOUT_STAGES = 30;
export const MAX_SESSION_WORKOUT_ITEMS = 300;
export const MAX_SESSION_WORKOUT_TICK_MAP_ENTRIES = 4000;
export const MAX_SESSION_WORKOUT_STRING_LENGTH = 64;

// Generous bounds that only keep nonsense out of storage; the run's own pickers
// are much narrower.
const MAX_ANGLE = 90;
const MAX_DIFFICULTY_ID = 100;
const MAX_SECONDS = 86_400;
const MAX_REPS_PER_SET = 100;

type Fields = Record<string, unknown>;

const isFields = (candidate: unknown): candidate is Fields =>
  typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);

/** GraphQL hands an omitted optional input field over as null; both mean "absent". */
const isAbsent = (candidate: unknown): candidate is null | undefined => candidate === null || candidate === undefined;

const isShortString = (candidate: unknown): candidate is string =>
  typeof candidate === 'string' && candidate.length > 0 && candidate.length <= MAX_SESSION_WORKOUT_STRING_LENGTH;

/**
 * A stage kind: a camelCase identifier like `fourByFour`, so it is safe to use
 * as a lookup key and an analytics value. Kinds this reader does not know still
 * pass.
 */
const STAGE_KIND_PATTERN = /^[a-zA-Z][a-zA-Z0-9]{0,31}$/;
const isStageKind = (candidate: unknown): candidate is string =>
  typeof candidate === 'string' && STAGE_KIND_PATTERN.test(candidate);

const isWholeNumberIn = (candidate: unknown, min: number, max: number): candidate is number =>
  typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= min && candidate <= max;

// Each optional reader answers INVALID for a present-but-malformed value, so
// the caller can tell "absent" (undefined) from "reject the plan".
const INVALID = Symbol('invalid');
type Read<T> = T | undefined | typeof INVALID;

function readOptionalBoolean(candidate: unknown): Read<boolean> {
  if (isAbsent(candidate)) return undefined;
  return typeof candidate === 'boolean' ? candidate : INVALID;
}

function readOptionalWholeNumber(candidate: unknown, min: number, max: number): Read<number> {
  if (isAbsent(candidate)) return undefined;
  return isWholeNumberIn(candidate, min, max) ? candidate : INVALID;
}

function readOptionalString(candidate: unknown): Read<string> {
  if (isAbsent(candidate)) return undefined;
  return isShortString(candidate) ? candidate : INVALID;
}

function readPacing(candidate: unknown): Read<SessionWorkoutPacing> {
  if (isAbsent(candidate)) return undefined;
  if (!isFields(candidate)) return INVALID;
  const { mode, restSeconds } = candidate;
  if (mode !== 'onTheMinute' && mode !== 'afterTick') return INVALID;
  if (!isWholeNumberIn(restSeconds, 0, MAX_SECONDS)) return INVALID;
  const advanceOn = readOptionalString(candidate.advanceOn);
  const repsPerSet = readOptionalWholeNumber(candidate.repsPerSet, 1, MAX_REPS_PER_SET);
  const restBetweenSetsSeconds = readOptionalWholeNumber(candidate.restBetweenSetsSeconds, 0, MAX_SECONDS);
  if (advanceOn === INVALID || repsPerSet === INVALID || restBetweenSetsSeconds === INVALID) return INVALID;
  // Optional fields are left off rather than set to undefined, so a parsed plan
  // round-trips through JSON unchanged.
  const pacing: SessionWorkoutPacing = { mode, restSeconds };
  if (advanceOn !== undefined) pacing.advanceOn = advanceOn;
  if (repsPerSet !== undefined) pacing.repsPerSet = repsPerSet;
  if (restBetweenSetsSeconds !== undefined) pacing.restBetweenSetsSeconds = restBetweenSetsSeconds;
  return pacing;
}

function readItem(candidate: unknown): SessionWorkoutPlanItem | null {
  if (!isFields(candidate)) return null;
  const { queueItemUuid, climbUuid, angle } = candidate;
  if (!isShortString(queueItemUuid) || !isShortString(climbUuid)) return null;
  if (!isWholeNumberIn(angle, -MAX_ANGLE, MAX_ANGLE)) return null;
  const isMirror = readOptionalBoolean(candidate.isMirror);
  if (isMirror === INVALID) return null;
  const item: SessionWorkoutPlanItem = { queueItemUuid, climbUuid, angle };
  if (isMirror !== undefined) item.isMirror = isMirror;
  return item;
}

function readStage(candidate: unknown): SessionWorkoutPlanStage | null {
  if (!isFields(candidate)) return null;
  const { id, kind, items } = candidate;
  if (!isShortString(id) || !isStageKind(kind) || !Array.isArray(items)) return null;
  const coolDown = readOptionalBoolean(candidate.coolDown);
  const targetGrade = readOptionalWholeNumber(candidate.targetGrade, 0, MAX_DIFFICULTY_ID);
  const pacing = readPacing(candidate.pacing);
  if (coolDown === INVALID || targetGrade === INVALID || pacing === INVALID) return null;
  const parsedItems: SessionWorkoutPlanItem[] = [];
  for (const item of items) {
    const parsedItem = readItem(item);
    if (!parsedItem) return null;
    parsedItems.push(parsedItem);
  }
  const stage: SessionWorkoutPlanStage = { id, kind, items: parsedItems };
  if (coolDown !== undefined) stage.coolDown = coolDown;
  if (targetGrade !== undefined) stage.targetGrade = targetGrade;
  if (pacing !== undefined) stage.pacing = pacing;
  return stage;
}

/**
 * Validates a workout plan from a client or from a stored row, and returns a
 * clean copy (unknown keys dropped, null optionals left off). Null when
 * anything is malformed or over a cap, when two stages share an id, or when a
 * queue item appears twice: a tick on it could not say which climb it was.
 *
 * A stage kind is any camelCase identifier up to 32 characters, so a kind
 * added by a newer app passes through to readers that show it as best they can.
 */
export function parseSessionWorkoutPlan(candidate: unknown): SessionWorkoutPlan | null {
  if (!isFields(candidate) || candidate.version !== 1 || !Array.isArray(candidate.stages)) return null;
  if (candidate.stages.length > MAX_SESSION_WORKOUT_STAGES) return null;
  const stages: SessionWorkoutPlanStage[] = [];
  const stageIds = new Set<string>();
  const queueItemUuids = new Set<string>();
  for (const stageCandidate of candidate.stages) {
    const stage = readStage(stageCandidate);
    if (!stage || stageIds.has(stage.id)) return null;
    stageIds.add(stage.id);
    for (const item of stage.items) {
      if (queueItemUuids.has(item.queueItemUuid)) return null;
      queueItemUuids.add(item.queueItemUuid);
    }
    if (queueItemUuids.size > MAX_SESSION_WORKOUT_ITEMS) return null;
    stages.push(stage);
  }
  return { version: 1, stages };
}

/**
 * Validates a tick map. Null when malformed or over the cap. A tick listed
 * twice keeps its first entry.
 */
export function parseSessionWorkoutTickMap(candidate: unknown): SessionWorkoutTickMapEntry[] | null {
  if (!Array.isArray(candidate) || candidate.length > MAX_SESSION_WORKOUT_TICK_MAP_ENTRIES) return null;
  const entries: SessionWorkoutTickMapEntry[] = [];
  const seenTickUuids = new Set<string>();
  for (const entry of candidate) {
    if (!isFields(entry)) return null;
    const { tickUuid, queueItemUuid } = entry;
    if (!isShortString(tickUuid) || !isShortString(queueItemUuid)) return null;
    if (seenTickUuids.has(tickUuid)) continue;
    seenTickUuids.add(tickUuid);
    entries.push({ tickUuid, queueItemUuid });
  }
  return entries;
}
