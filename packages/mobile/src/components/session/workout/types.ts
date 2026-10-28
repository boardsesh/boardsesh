// The workout a session was climbed to, as the session screens draw it (#6903).
//
// Mirrors `DerivedWorkoutStage` from `@boardsesh/workout-summary` (the pure
// derivation the server and the phone both run over a stored plan and the
// owner's ticks) plus what a row needs to draw a climb: its name, grade label
// and thumbnail inputs. The GraphQL `SessionWorkout` maps into this one-to-one
// (a later PR); the phone's own run maps into it too while its ticks are still
// saving. Keep the two in step: a field added to the derivation lands here.

import type { RenderBoardConfig } from '@boardsesh/shared-schema';

/** One go on a climb, in tick order. A go that didn't top out is an attempt. */
export type WorkoutRepOutcome = 'flash' | 'send' | 'attempt';

/** Every tally counts ticks, the unit the session totals use. */
export type WorkoutStageTally = {
  /** Flash and send ticks. */
  sent: number;
  /** Attempt ticks. */
  attempts: number;
  /** Climbs of the block with no tick from the workout's owner. */
  skipped: number;
  /** Climbs in the block. */
  climbs: number;
};

export type WorkoutClimbView = {
  queueItemUuid: string;
  climbUuid: string;
  angle: number;
  isMirror?: boolean;
  /** The owner's ticks on this climb within the block, in tick order. */
  reps: WorkoutRepOutcome[];
  /** No tick from the owner on this climb. */
  skipped: boolean;
  // Display fields, resolved the way `hardestClimb` is in the session summary.
  name: string | null;
  /** Display grade label ("V4", "6c+"), already in the viewer's grade system. */
  grade: string | null;
  /**
   * The grade's difficulty id, for ordering a block's grade span. Null when
   * unknown: the span then reads first climb to last.
   */
  difficulty?: number | null;
  boardType?: string | null;
  layoutId?: number | null;
  frames?: string | null;
  renderBoard?: RenderBoardConfig | null;
  /**
   * The owner's tick uuids on this climb, from the derivation's tick map. The
   * session detail groups ticks by them; an older payload without them falls
   * back to matching the owner's ticks by climb and angle.
   */
  tickUuids?: string[];
};

export type WorkoutStageView = {
  id: string;
  /** A `WorkoutStageKind`, kept as a string so a newer kind still draws (as "Block"). */
  kind: string;
  /** A warm-up after the last main block, stepping back down. */
  isCoolDown: boolean;
  /** Display grade label of the block's target grade, when it has one. */
  targetGrade?: string | null;
  /** 4x4: reps per climb. */
  repsPerSet?: number | null;
  /** 4x4: one set per climb. */
  sets?: number | null;
  /** On the Minute: seconds from one climb to the next. */
  intervalSeconds?: number | null;
  restSeconds?: number | null;
  climbs: WorkoutClimbView[];
  tally: WorkoutStageTally;
};

export type SessionWorkoutView = {
  /** The workout's owner: only their ticks count toward it. */
  userId: string;
  stages: WorkoutStageView[];
  /** The owner's ticks in the session that matched no block. */
  offPlan: number;
  /** Those ticks' uuids, from the derivation. */
  offPlanTickUuids?: string[];
};

/**
 * One line for a feed card, from `workoutHeadline` in `@boardsesh/workout-summary`.
 * Main blocks are the non-warm-up ones (a warm-up counts only when it is all
 * there is).
 */
export type WorkoutHeadlineView = {
  mainKind: string | null;
  mainTargetGrade?: string | null;
  /** The second main block's kind, for "4x4 at V4 + Pyramid". Left out, two main blocks read "A + 1 more". */
  secondMainKind?: string | null;
  /** Every block, warm-up and cool-down included. */
  blockCount: number;
  /** Main blocks after the first. */
  extraMainBlocks: number;
};
