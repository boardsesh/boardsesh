// The session page's Climbs list grouped by workout block (#6903): one group per
// block, then "Off plan" for the workout owner's ticks that match no block, then
// the crew's ticks. A 4x4 lists one row per set (climb) with its reps; a
// planned climb with no visible tick still gets a row, dimmed, saying it was
// skipped. Pure, so the grouping is tested without rendering.

import type { SessionDetailTick } from '@boardsesh/shared-schema';
import type { SessionWorkoutResult, SessionWorkoutStageResult } from '@boardsesh/graphql/operations/session-workouts';
import { assignWorkoutTicks, isFourByFourStage, type SessionWorkoutRepOutcome } from '@boardsesh/workout-summary';
import type { Climb } from '@/app/lib/types';

/** A workout climb as the page draws it: reps lowercased, grade in the viewer's format. */
export type WorkoutClimbView = Omit<SessionWorkoutStageResult['climbs'][number], 'reps'> & {
  reps: SessionWorkoutRepOutcome[];
  /** The server's grade label ("6b/V4"), which the climb rows format themselves. */
  rawGrade: string | null;
};

export type WorkoutStageView = Omit<SessionWorkoutStageResult, 'climbs'> & { climbs: WorkoutClimbView[] };

export type SessionWorkoutView = Omit<SessionWorkoutResult, 'stages'> & { stages: WorkoutStageView[] };

const REP: Record<string, SessionWorkoutRepOutcome> = { FLASH: 'flash', SEND: 'send', ATTEMPT: 'attempt' };

/**
 * The server's answer as the page draws it. `formatGrade` turns the server's
 * grade labels ("6b/V4") into the viewer's format.
 */
export function toWorkoutView(
  workout: SessionWorkoutResult,
  formatGrade: (grade: string) => string | null,
): SessionWorkoutView {
  const format = (grade: string | null) => (grade ? (formatGrade(grade) ?? grade) : null);
  return {
    ...workout,
    stages: workout.stages.map((stage) => ({
      ...stage,
      targetGrade: format(stage.targetGrade),
      climbs: stage.climbs.map((climb) => ({
        ...climb,
        grade: format(climb.grade),
        rawGrade: climb.grade,
        reps: climb.reps.flatMap((rep) => (REP[rep] ? [REP[rep]] : [])),
      })),
    })),
  };
}

/**
 * Which workout the page shows when several climbers followed one: the
 * viewer's own, else the first one stored.
 */
export function pickWorkout<Workout extends { userId: string }>(
  workouts: readonly Workout[],
  viewerUserId: string | null | undefined,
): Workout | null {
  return workouts.find((workout) => workout.userId === viewerUserId) ?? workouts[0] ?? null;
}

/** A tick's climb, as the climb list rows draw it. */
export function tickToClimb(tick: SessionDetailTick, unknownClimbLabel: string): Climb {
  return {
    uuid: tick.climbUuid,
    name: tick.climbName || unknownClimbLabel,
    frames: tick.frames || '',
    angle: tick.angle,
    difficulty: tick.difficultyName || '',
    quality_average: tick.quality != null ? String(tick.quality) : '0',
    setter_username: tick.setterUsername || '',
    description: '',
    ascensionist_count: 0,
    stars: 0,
    difficulty_error: '0',
    benchmark_difficulty: tick.isBenchmark ? tick.difficultyName || null : null,
    mirrored: tick.isMirror,
    is_no_match: tick.isNoMatch,
    boardType: tick.boardType,
    layoutId: tick.layoutId ?? null,
  };
}

/** A planned climb with no tick to draw it from. */
function workoutClimbToClimb(climb: WorkoutClimbView, unknownClimbLabel: string): Climb {
  return {
    uuid: climb.climbUuid,
    name: climb.name || unknownClimbLabel,
    frames: climb.frames || '',
    angle: climb.angle,
    difficulty: climb.rawGrade || '',
    quality_average: '0',
    setter_username: '',
    description: '',
    ascensionist_count: 0,
    stars: 0,
    difficulty_error: '0',
    benchmark_difficulty: null,
    mirrored: climb.isMirror,
    boardType: climb.boardType ?? undefined,
    layoutId: climb.layoutId ?? null,
  };
}

export type WorkoutClimbEntry = {
  /** The row's key: the queue item for a planned climb, the climb uuid otherwise. */
  key: string;
  climb: Climb;
  ticks: SessionDetailTick[];
  /** The block's climb this row is, absent for off-plan and crew rows. */
  workoutClimb?: WorkoutClimbView;
  /** A 4x4 row's set number, from 1. */
  setNumber?: number;
};

export type WorkoutClimbGroup =
  | { type: 'block'; key: string; stage: WorkoutStageView; entries: WorkoutClimbEntry[] }
  | { type: 'offPlan'; key: string; tickCount: number; entries: WorkoutClimbEntry[] }
  | { type: 'crew'; key: string; tickCount: number; entries: WorkoutClimbEntry[] };

/** One row per climb, first-tick order, ticks kept with their climb. */
function entriesFromTicks(ticks: readonly SessionDetailTick[], unknownClimbLabel: string): WorkoutClimbEntry[] {
  const byClimb = new Map<string, WorkoutClimbEntry>();
  for (const tick of ticks) {
    const existing = byClimb.get(tick.climbUuid);
    if (existing) existing.ticks.push(tick);
    else {
      byClimb.set(tick.climbUuid, {
        key: tick.climbUuid,
        climb: tickToClimb(tick, unknownClimbLabel),
        ticks: [tick],
      });
    }
  }
  return [...byClimb.values()];
}

/**
 * Groups the session's ticks under the workout's blocks, one row per planned
 * slot (keyed by its queue item), so a climb planned twice shows twice: a 4x4
 * that repeats a climb numbers every set and keeps each set's reps.
 */
export function buildWorkoutClimbGroups(
  ticks: readonly SessionDetailTick[],
  workout: SessionWorkoutView,
  unknownClimbLabel: string,
): WorkoutClimbGroup[] {
  const { byClimb, offPlan, crew } = assignWorkoutTicks(ticks, workout);
  const groups: WorkoutClimbGroup[] = workout.stages.map((stage, stageIndex) => {
    const entries = stage.climbs.map((workoutClimb, climbIndex): WorkoutClimbEntry => {
      const climbTicks = byClimb[stageIndex][climbIndex];
      return {
        key: workoutClimb.queueItemUuid,
        climb: climbTicks[0]
          ? tickToClimb(climbTicks[0], unknownClimbLabel)
          : workoutClimbToClimb(workoutClimb, unknownClimbLabel),
        ticks: climbTicks,
        workoutClimb,
        setNumber: isFourByFourStage(stage) ? climbIndex + 1 : undefined,
      };
    });
    return { type: 'block', key: `block-${stage.id}`, stage, entries };
  });
  if (offPlan.length > 0) {
    groups.push({
      type: 'offPlan',
      key: 'off-plan',
      tickCount: offPlan.length,
      entries: entriesFromTicks(offPlan, unknownClimbLabel),
    });
  }
  if (crew.length > 0) {
    groups.push({
      type: 'crew',
      key: 'crew',
      tickCount: crew.length,
      entries: entriesFromTicks(crew, unknownClimbLabel),
    });
  }
  return groups;
}
