// The phone's run as the server stores it (#6903): `recordSessionWorkout`'s
// input, built from the run record (stages, captured climbs, tick log). Pure,
// so the write path is tested without a database. docs/workout-stages.md,
// "Workouts on the server".

import type { ClimbQueueItem } from '@boardsesh/queue';
import type { WorkoutRunStage, WorkoutStagePacing } from '@boardsesh/playlist-generator';
import {
  MAX_SESSION_WORKOUT_ITEMS,
  MAX_SESSION_WORKOUT_STAGES,
  MAX_SESSION_WORKOUT_STRING_LENGTH,
  MAX_SESSION_WORKOUT_TICK_MAP_ENTRIES,
  parseSessionWorkoutPlan,
  parseSessionWorkoutTickMap,
  type SessionWorkoutPacing,
  type SessionWorkoutPlan,
  type SessionWorkoutPlanItem,
  type SessionWorkoutPlanStage,
  type SessionWorkoutTickMapEntry,
} from '@boardsesh/workout-summary';
import type { WorkoutRunClimb, WorkoutRunRecord } from './workout-run-store';

/** `RecordSessionWorkoutInput`, field for field. */
export type RecordSessionWorkoutInput = {
  sessionId: string;
  revision: number;
  stages: SessionWorkoutPlanStage[];
  ticks: SessionWorkoutTickMapEntry[];
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether `sessionId` can name a session on the server. `createSession` mints a
 * v4 uuid; stories and fakes use readable ids ("story-summary-workout"), and a
 * daily feed card is "daily:<user>:<day>". Neither must ever reach the outbox.
 */
export function isServerSessionId(sessionId: string | null | undefined): sessionId is string {
  return typeof sessionId === 'string' && UUID_PATTERN.test(sessionId);
}

/** Each queue item's climb, for the run record. */
export function captureWorkoutRunClimbs(items: readonly ClimbQueueItem[]): Record<string, WorkoutRunClimb> {
  const climbs: Record<string, WorkoutRunClimb> = {};
  for (const { uuid, climb } of items) {
    if (!climb?.uuid || typeof climb.angle !== 'number') continue;
    const captured: WorkoutRunClimb = { climbUuid: climb.uuid, angle: climb.angle };
    if (typeof climb.mirrored === 'boolean') captured.isMirror = climb.mirrored;
    if (climb.name) captured.name = climb.name;
    if (climb.difficulty) captured.difficulty = climb.difficulty;
    if (climb.boardType) captured.boardType = climb.boardType;
    climbs[uuid] = captured;
  }
  return climbs;
}

function toPlanPacing(pacing: WorkoutStagePacing | undefined): SessionWorkoutPacing | undefined {
  if (!pacing) return undefined;
  const restSeconds = Math.max(0, Math.round(pacing.restSeconds));
  if (pacing.mode === 'onTheMinute') return { mode: 'onTheMinute', restSeconds };
  const flattened: SessionWorkoutPacing = { mode: 'afterTick', restSeconds, advanceOn: pacing.advanceOn };
  if (pacing.advanceOn === 'set') {
    flattened.repsPerSet = Math.round(pacing.sets.repsPerSet);
    flattened.restBetweenSetsSeconds = Math.max(0, Math.round(pacing.sets.restBetweenSetsSeconds));
  }
  return flattened;
}

const fitsServer = (value: string): boolean => value.length > 0 && value.length <= MAX_SESSION_WORKOUT_STRING_LENGTH;

function toPlanStage(
  stage: WorkoutRunStage,
  climbs: Readonly<Record<string, WorkoutRunClimb>>,
  itemBudget: number,
  claimed: Set<string>,
): SessionWorkoutPlanStage | null {
  if (!fitsServer(stage.id)) return null;
  const items: SessionWorkoutPlanItem[] = [];
  for (const queueItemUuid of stage.itemUuids) {
    if (items.length >= itemBudget) break;
    const climb = climbs[queueItemUuid];
    // A climb never captured (a run an older bundle rewrote, its item gone
    // from the queue) can't be stored: the server needs its climb and angle.
    // An item in two stages goes to the first: the server refuses a plan
    // that names one twice, since a tick on it could not say which it was.
    if (!climb || claimed.has(queueItemUuid) || !fitsServer(queueItemUuid) || !fitsServer(climb.climbUuid)) continue;
    claimed.add(queueItemUuid);
    const item: SessionWorkoutPlanItem = { queueItemUuid, climbUuid: climb.climbUuid, angle: Math.round(climb.angle) };
    if (climb.isMirror !== undefined) item.isMirror = climb.isMirror;
    items.push(item);
  }
  if (items.length === 0) return null;
  const planStage: SessionWorkoutPlanStage = { id: stage.id, kind: stage.kind, items };
  if (stage.coolDown) planStage.coolDown = true;
  if (typeof stage.targetGrade === 'number') planStage.targetGrade = Math.round(stage.targetGrade);
  const pacing = toPlanPacing(stage.pacing);
  if (pacing) planStage.pacing = pacing;
  return planStage;
}

/**
 * The run as a stored plan: stages in run order, each with the items whose
 * climb was captured. Over the server's caps it keeps the first 30 stages and
 * the first 300 items rather than have the whole write refused. Null when
 * nothing is left, or when the server's own parser would refuse it.
 */
export function buildSessionWorkoutPlan(record: Pick<WorkoutRunRecord, 'run' | 'climbs'>): SessionWorkoutPlan | null {
  const climbs = record.climbs ?? {};
  const stages: SessionWorkoutPlanStage[] = [];
  const claimed = new Set<string>();
  const stageIds = new Set<string>();
  let itemCount = 0;
  for (const stage of record.run.stages) {
    if (stages.length >= MAX_SESSION_WORKOUT_STAGES) break;
    if (stageIds.has(stage.id)) continue;
    stageIds.add(stage.id);
    const planStage = toPlanStage(stage, climbs, MAX_SESSION_WORKOUT_ITEMS - itemCount, claimed);
    if (!planStage) continue;
    stages.push(planStage);
    itemCount += planStage.items.length;
  }
  if (stages.length === 0) return null;
  return parseSessionWorkoutPlan({ version: 1, stages });
}

/**
 * Which queue item each tick of the log was logged on: the entries with a tick
 * uuid on an item of the plan, once per tick (the newest entry wins), the
 * newest 4000 when there are more.
 */
export function buildSessionWorkoutTickMap(
  record: Pick<WorkoutRunRecord, 'log'>,
  plan: SessionWorkoutPlan,
): SessionWorkoutTickMapEntry[] {
  const planItems = new Set(plan.stages.flatMap((stage) => stage.items.map((item) => item.queueItemUuid)));
  const byTick = new Map<string, string>();
  for (const entry of record.log ?? []) {
    if (!entry.tickUuid || !planItems.has(entry.queueItemUuid)) continue;
    byTick.delete(entry.tickUuid);
    byTick.set(entry.tickUuid, entry.queueItemUuid);
  }
  const ticks = [...byTick].map(([tickUuid, queueItemUuid]) => ({ tickUuid, queueItemUuid }));
  const kept =
    ticks.length > MAX_SESSION_WORKOUT_TICK_MAP_ENTRIES ? ticks.slice(-MAX_SESSION_WORKOUT_TICK_MAP_ENTRIES) : ticks;
  return parseSessionWorkoutTickMap(kept) ?? [];
}

/** `recordSessionWorkout`'s input for `record` at `revision`, or null when there is no plan to send. */
export function buildRecordSessionWorkoutInput(
  record: WorkoutRunRecord,
  revision: number,
): RecordSessionWorkoutInput | null {
  if (!isServerSessionId(record.sessionId)) return null;
  const plan = buildSessionWorkoutPlan(record);
  if (!plan) return null;
  return {
    sessionId: record.sessionId,
    revision,
    stages: plan.stages,
    ticks: buildSessionWorkoutTickMap(record, plan),
  };
}
