import {
  MAX_SYNCED_QUEUE_ITEMS,
  normaliseHistoryCount,
  normaliseOrphanCurrent,
  type ClimbQueueItem,
} from '@boardsesh/queue';
import { isWorkoutStageKind, type WorkoutRun, type WorkoutRunStage } from '@boardsesh/playlist-generator';
import {
  MAX_SESSION_WORKOUT_ITEMS,
  parseSessionWorkoutPlan,
  type SessionWorkoutPlanStage,
} from '@boardsesh/workout-summary';
import type { AppWorkoutInitialSeed } from '../providers/queue/queue-contexts';
import { appendBlockToRun } from '../components/session-screen/in-session/add-workout-block';
import { buildSessionWorkoutPlan, captureWorkoutRunClimbs } from './session-workout-plan';
import type { WorkoutRunClimb } from './workout-run-store';

/** Build the complete first write before creating a session; existing solo content is preserved. */
export function buildPartnerWorkoutInitialSeed({
  workoutId,
  blockCount,
  items,
  run,
  queue,
  currentClimbQueueItem,
  historyCount,
}: {
  workoutId: string;
  blockCount: number;
  items: ClimbQueueItem[];
  run: WorkoutRun;
  queue: ClimbQueueItem[];
  currentClimbQueueItem: ClimbQueueItem | null;
  historyCount?: number | null;
}): { seed: AppWorkoutInitialSeed; landedItems: ClimbQueueItem[] } {
  const savedLine = normaliseHistoryCount(historyCount, queue, currentClimbQueueItem);
  const normalized = normaliseOrphanCurrent({ queue, currentClimbQueueItem, historyCount: savedLine ?? 0 });
  const available = MAX_SYNCED_QUEUE_ITEMS - normalized.queue.length;
  if (available < 0) throw new Error('The existing solo queue exceeds the initial session budget');
  if (items.length > Math.min(available, MAX_SESSION_WORKOUT_ITEMS))
    throw new Error('Partner workout exceeds available queue capacity');
  const landedItems = items;
  const partnerRun = appendBlockToRun(
    null,
    run,
    landedItems.map((item) => item.uuid),
  );
  const capturedClimbs = captureWorkoutRunClimbs(landedItems);
  const sessionPlan = buildSessionWorkoutPlan({ run: partnerRun, climbs: capturedClimbs }) ?? {
    version: 1 as const,
    stages: [],
  };
  const climbByItem = new Map(landedItems.map((item) => [item.uuid, item.climb.uuid]));
  return {
    seed: {
      queue: [...normalized.queue, ...landedItems],
      currentClimbQueueItem,
      ...(savedLine == null ? {} : { historyCount: normalized.historyCount }),
      sessionPlan,
      plan: Array.from({ length: blockCount }, (_, index) => ({
        index,
        climbUuids:
          partnerRun.stages
            .find((stage) => stage.id === `${workoutId}:${index}`)
            ?.itemUuids.flatMap((uuid) => climbByItem.get(uuid) ?? []) ?? [],
      })),
    },
    landedItems,
  };
}

function savedPacing(stage: SessionWorkoutPlanStage): WorkoutRunStage['pacing'] {
  const pacing = stage.pacing;
  if (!pacing) return undefined;
  if (pacing.mode === 'onTheMinute') return { mode: 'onTheMinute', restSeconds: pacing.restSeconds };
  if (pacing.advanceOn === 'tick' || pacing.advanceOn === 'send')
    return { mode: 'afterTick', restSeconds: pacing.restSeconds, advanceOn: pacing.advanceOn };
  if (
    pacing.advanceOn === 'round' &&
    pacing.roundCount &&
    pacing.climbsPerRound &&
    pacing.restBetweenRoundsSeconds !== undefined
  ) {
    return {
      mode: 'afterTick',
      restSeconds: pacing.restSeconds,
      advanceOn: 'round',
      rounds: {
        climbCount: pacing.climbsPerRound,
        roundCount: pacing.roundCount,
        restBetweenRoundsSeconds: pacing.restBetweenRoundsSeconds,
        positionByItemUuid: Object.fromEntries(
          stage.items.flatMap((item) => (item.position === undefined ? [] : [[item.queueItemUuid, item.position]])),
        ),
      },
    };
  }
  if (pacing.advanceOn === 'set' && pacing.repsPerSet && pacing.restBetweenSetsSeconds !== undefined) {
    return {
      mode: 'afterTick',
      restSeconds: pacing.restSeconds,
      advanceOn: 'set',
      sets: { repsPerSet: pacing.repsPerSet, restBetweenSetsSeconds: pacing.restBetweenSetsSeconds },
    };
  }
  return undefined;
}

/** Restore only the winning persisted plan, never the preview regenerated after a lost reply. */
export function restorePartnerWorkoutRun(
  candidate: unknown,
): { run: WorkoutRun; climbs: Record<string, WorkoutRunClimb> } | null {
  const plan = parseSessionWorkoutPlan(candidate);
  if (!plan) return null;
  const stages: WorkoutRunStage[] = [];
  const climbs: Record<string, WorkoutRunClimb> = {};
  for (const stage of plan.stages) {
    if (!isWorkoutStageKind(stage.kind)) continue;
    stages.push({
      id: stage.id,
      kind: stage.kind,
      itemUuids: stage.items.map((item) => item.queueItemUuid),
      ...(stage.targetGrade === undefined ? {} : { targetGrade: stage.targetGrade }),
      ...(stage.coolDown ? { coolDown: true as const } : {}),
      pacing: savedPacing(stage),
    });
    for (const item of stage.items)
      climbs[item.queueItemUuid] = {
        climbUuid: item.climbUuid,
        angle: item.angle,
        ...(item.isMirror === undefined ? {} : { isMirror: item.isMirror }),
      };
  }
  return { run: { stages }, climbs };
}
