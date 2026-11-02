// From the server's `SessionWorkout`, or the phone's own run, to the view the
// session screens draw (#6903). Pure, so the mapping and the choice of which
// workout to show are tested without React.
//
// Which workout a screen shows:
// - The summary is the viewer's own recap, so only the viewer's workout.
// - Session detail shows the viewer's own workout when they ran one, else the
//   session owner's (a crew climbs the owner's queue, so theirs is the
//   session's workout), else the first one the server lists.
// Either way the viewer's own workout comes from this phone while the phone
// still has writes for the session in the outbox (the server copy is short of
// them), or when the server has none yet (it answers nothing for an owner with
// no synced tick).

import {
  deriveWorkoutStages,
  type DerivedWorkoutStage,
  type SessionWorkoutTick,
  type SessionWorkoutTickMapEntry,
} from '@boardsesh/workout-summary';
import type {
  SessionWorkoutClimbResult,
  SessionWorkoutHeadlineResult,
  SessionWorkoutResult,
  SessionWorkoutStageResult,
} from '@boardsesh/graphql/operations/session-workouts';
import { getDifficultyIdForGradeName, getGradeLabel } from '../../../lib/grade-label';
import { buildSessionWorkoutPlan, buildSessionWorkoutTickMap } from '../../../lib/session-workout-plan';
import type { WorkoutRunRecord } from '../../../lib/workout-run-store';
import type {
  SessionWorkoutView,
  WorkoutClimbView,
  WorkoutHeadlineView,
  WorkoutRepOutcome,
  WorkoutStageView,
} from './types';

/** `useGradeFormat().formatGrade`: a stored grade label in the viewer's grade system. */
export type FormatGradeLabel = (label: string | null | undefined, boardType?: string | null) => string | null;

const REP_OUTCOME: Record<SessionWorkoutClimbResult['reps'][number], WorkoutRepOutcome> = {
  FLASH: 'flash',
  SEND: 'send',
  ATTEMPT: 'attempt',
};

function displayGrade(
  label: string | null | undefined,
  boardType: string | null | undefined,
  format: FormatGradeLabel,
) {
  if (!label) return null;
  return format(label, boardType) ?? label;
}

function serverClimbView(climb: SessionWorkoutClimbResult, format: FormatGradeLabel): WorkoutClimbView {
  const view: WorkoutClimbView = {
    queueItemUuid: climb.queueItemUuid,
    climbUuid: climb.climbUuid,
    angle: climb.angle,
    reps: climb.reps.map((rep) => REP_OUTCOME[rep]),
    skipped: climb.skipped,
    name: climb.name,
    grade: displayGrade(climb.grade, climb.boardType, format),
    difficulty: getDifficultyIdForGradeName(climb.grade),
    boardType: climb.boardType,
    layoutId: climb.layoutId,
    frames: climb.frames,
    renderBoard: climb.renderBoard,
  };
  if (typeof climb.isMirror === 'boolean') view.isMirror = climb.isMirror;
  if (climb.tickUuids) view.tickUuids = climb.tickUuids;
  return view;
}

function serverStageView(stage: SessionWorkoutStageResult, format: FormatGradeLabel): WorkoutStageView {
  const boardType = stage.climbs.find((climb) => climb.boardType)?.boardType ?? null;
  return {
    id: stage.id,
    kind: stage.kind,
    isCoolDown: stage.isCoolDown,
    targetGrade: displayGrade(stage.targetGrade, boardType, format),
    repsPerSet: stage.repsPerSet,
    sets: stage.sets,
    intervalSeconds: stage.intervalSeconds,
    restSeconds: stage.restSeconds,
    climbs: stage.climbs.map((climb) => serverClimbView(climb, format)),
    tally: stage.tally,
  };
}

/** The server's workout as the screens draw it: outcomes lowercased, grades in the viewer's system. */
export function serverWorkoutView(workout: SessionWorkoutResult, format: FormatGradeLabel): SessionWorkoutView {
  const view: SessionWorkoutView = {
    userId: workout.userId,
    stages: workout.stages.map((stage) => serverStageView(stage, format)),
    offPlan: workout.offPlan,
  };
  if (workout.offPlanTickUuids) view.offPlanTickUuids = workout.offPlanTickUuids;
  return view;
}

/**
 * The phone's own run, tallied from its tick log with the same derivation the
 * server runs (`deriveWorkoutStages`), and drawn from the climbs captured when
 * the run was written. Null when no stage has a captured climb.
 *
 * The log holds only ticks on the run's climbs, so nothing reads as off plan.
 * An entry without a tick uuid (a save whose answer never came back) still
 * counts: it is placed on its queue item under a stand-in uuid.
 */
export function localWorkoutView(
  record: Pick<WorkoutRunRecord, 'run' | 'climbs' | 'log'>,
  ownerUserId: string,
  format: FormatGradeLabel,
): SessionWorkoutView | null {
  const plan = buildSessionWorkoutPlan(record);
  if (!plan) return null;
  const climbs = record.climbs ?? {};
  const tickMap: SessionWorkoutTickMapEntry[] = buildSessionWorkoutTickMap(record, plan);
  const mappedTicks = new Set(tickMap.map((entry) => entry.tickUuid));
  const ticks: SessionWorkoutTick[] = [];
  const placed = new Set<string>();
  (record.log ?? []).forEach((entry, index) => {
    const climb = climbs[entry.queueItemUuid];
    if (!climb) return;
    const uuid = entry.tickUuid ?? `local-tick:${index}`;
    if (!entry.tickUuid) tickMap.push({ tickUuid: uuid, queueItemUuid: entry.queueItemUuid });
    // Off the plan (its item was left out over a cap), or a second copy of one tick.
    else if (!mappedTicks.has(uuid) || placed.has(uuid)) return;
    placed.add(uuid);
    ticks.push({
      uuid,
      climbUuid: climb.climbUuid,
      angle: climb.angle,
      isMirror: climb.isMirror ?? null,
      status: entry.status,
      climbedAt: entry.climbedAt,
    });
  });
  const derived = deriveWorkoutStages(plan, tickMap, ticks);
  const runStages = new Map(record.run.stages.map((stage) => [stage.id, stage]));

  const stageView = (stage: DerivedWorkoutStage): WorkoutStageView => {
    const boardType = stage.climbs.map((climb) => climbs[climb.queueItemUuid]?.boardType).find(Boolean) ?? null;
    const targetGrade = runStages.get(stage.id)?.targetGrade;
    return {
      id: stage.id,
      kind: stage.kind,
      isCoolDown: stage.isCoolDown,
      targetGrade: displayGrade(getGradeLabel(targetGrade, boardType), boardType, format),
      repsPerSet: stage.repsPerSet ?? null,
      sets: stage.sets ?? null,
      intervalSeconds: stage.intervalSeconds ?? null,
      restSeconds: stage.restSeconds ?? null,
      tally: stage.tally,
      climbs: stage.climbs.map((climb) => {
        const captured = climbs[climb.queueItemUuid];
        const view: WorkoutClimbView = {
          queueItemUuid: climb.queueItemUuid,
          climbUuid: climb.climbUuid,
          angle: climb.angle,
          reps: climb.reps,
          skipped: climb.skipped,
          // The stand-in uuids name no tick a list could hold.
          tickUuids: climb.tickUuids.filter((uuid) => !uuid.startsWith('local-tick:')),
          name: captured?.name ?? null,
          grade: displayGrade(captured?.difficulty, captured?.boardType, format),
          difficulty: getDifficultyIdForGradeName(captured?.difficulty),
          boardType: captured?.boardType ?? null,
        };
        if (climb.isMirror !== undefined) view.isMirror = climb.isMirror;
        return view;
      }),
    };
  };

  return { userId: ownerUserId, stages: derived.stages.map(stageView), offPlan: 0, offPlanTickUuids: [] };
}

/** Which surface asks: the summary shows only the viewer's own workout. */
export type SessionWorkoutScope = 'viewer' | 'session';

export type SessionWorkoutChoice = { source: 'server'; workout: SessionWorkoutResult } | { source: 'local' } | null;

/**
 * Which workout to draw. `localAvailable` says this phone holds the viewer's
 * own run (live, or its ended recap); `phoneAhead` that the phone still has
 * ticks or a workout write for the session in the outbox. See the module
 * comment for the order.
 */
export function chooseSessionWorkout({
  workouts,
  viewerUserId,
  sessionOwnerUserId,
  localAvailable,
  phoneAhead,
  scope,
}: {
  workouts: readonly SessionWorkoutResult[];
  viewerUserId: string | null;
  sessionOwnerUserId: string | null;
  localAvailable: boolean;
  phoneAhead: boolean;
  scope: SessionWorkoutScope;
}): SessionWorkoutChoice {
  const own = viewerUserId ? workouts.find((workout) => workout.userId === viewerUserId) : undefined;
  if (localAvailable && (phoneAhead || !own)) return { source: 'local' };
  if (own) return { source: 'server', workout: own };
  if (scope === 'viewer') return null;
  const owners = sessionOwnerUserId ? workouts.find((workout) => workout.userId === sessionOwnerUserId) : undefined;
  const shown = owners ?? workouts.at(0);
  return shown ? { source: 'server', workout: shown } : null;
}

/** A feed card's line from the server's headline, grades in the viewer's system. */
export function headlineView(headline: SessionWorkoutHeadlineResult, format: FormatGradeLabel): WorkoutHeadlineView {
  return {
    mainKind: headline.mainKind,
    mainTargetGrade: displayGrade(headline.mainTargetGrade, null, format),
    secondMainKind: headline.secondMainKind,
    blockCount: headline.blockCount,
    extraMainBlocks: headline.extraMainBlocks,
  };
}

/**
 * The ids each headline request asks for: one request per feed page, a page
 * over the server's cap split, daily cards (never a workout) and ids an earlier
 * page already asked for left out, empty requests dropped. Keeping a page's
 * request to that page's ids means loading the next page never refetches the
 * pages already on screen.
 */
export function headlineRequests(pages: readonly (readonly string[])[], maxIds: number): string[][] {
  const asked = new Set<string>();
  const requests: string[][] = [];
  for (const page of pages) {
    const ids = page.filter((sessionId) => !sessionId.startsWith('daily:') && !asked.has(sessionId));
    for (const sessionId of ids) asked.add(sessionId);
    for (let start = 0; start < ids.length; start += maxIds) requests.push(ids.slice(start, start + maxIds));
  }
  return requests;
}
