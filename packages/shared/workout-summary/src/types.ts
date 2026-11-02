// The workout a climber followed in a session, as the server stores it
// (`session_workouts`, #6903), and what its blocks came to. Pure TS and
// JSON-serialisable: the backend validates and derives with it, and mobile runs
// the same derivation on its local run and tick log while the write is pending.
// See docs/workout-stages.md, "Workouts on the server".

/** How one logged rep or climb ended. The same three statuses a tick has. */
export type SessionWorkoutRepOutcome = 'flash' | 'send' | 'attempt';

/**
 * A timed stage's pacing, flattened from the run's `WorkoutStagePacing`: a
 * 4x4's `sets.repsPerSet` and `sets.restBetweenSetsSeconds` sit beside the rest.
 * `advanceOn` is a string so a newer value survives an older server.
 */
export type SessionWorkoutPacing = {
  mode: 'onTheMinute' | 'afterTick';
  restSeconds: number;
  advanceOn?: string;
  repsPerSet?: number;
  restBetweenSetsSeconds?: number;
};

/** One queued climb of a stage. The climb fields are captured when the run is written. */
export type SessionWorkoutPlanItem = {
  queueItemUuid: string;
  climbUuid: string;
  angle: number;
  isMirror?: boolean;
};

export type SessionWorkoutPlanStage = {
  /** The run stage's id (a uuid). */
  id: string;
  /** A `WorkoutStageKind`, stored as a string so a kind newer than the reader survives. */
  kind: string;
  coolDown?: boolean;
  /** Difficulty id, as `WorkoutRunStage.targetGrade`. */
  targetGrade?: number;
  pacing?: SessionWorkoutPacing;
  items: SessionWorkoutPlanItem[];
};

export type SessionWorkoutPlan = {
  version: 1;
  stages: SessionWorkoutPlanStage[];
};

/** Which queue item a tick was logged on, from the run's tick log. */
export type SessionWorkoutTickMapEntry = { tickUuid: string; queueItemUuid: string };

/** One of the workout owner's ticks in the session. */
export type SessionWorkoutTick = {
  uuid: string;
  climbUuid: string;
  angle: number;
  isMirror?: boolean | null;
  status: SessionWorkoutRepOutcome;
  /** ISO string or Date; orders the reps. */
  climbedAt: string | Date;
};

export type DerivedWorkoutClimb = {
  queueItemUuid: string;
  climbUuid: string;
  angle: number;
  isMirror?: boolean;
  /** One entry per tick matched to this climb, in tick order. */
  reps: SessionWorkoutRepOutcome[];
  /** The matched ticks' uuids, in the same order as `reps`. */
  tickUuids: string[];
  /** True when the owner logged no tick on it. */
  skipped: boolean;
};

/** Every count is in ticks, the unit the session totals use. */
export type DerivedWorkoutTally = {
  /** Flash and send ticks. */
  sent: number;
  /** Attempt ticks. */
  attempts: number;
  /** Climbs with no tick. */
  skipped: number;
  /** Climbs in the stage. */
  climbs: number;
};

export type DerivedWorkoutStage = {
  id: string;
  kind: string;
  isCoolDown: boolean;
  targetGrade?: number;
  /** A 4x4: reps per climb. */
  repsPerSet?: number;
  /** A 4x4: one set per climb. */
  sets?: number;
  /** On the minute: the interval. */
  intervalSeconds?: number;
  /** An `afterTick` stage: the rest after each tick (a 4x4: between reps). */
  restSeconds?: number;
  climbs: DerivedWorkoutClimb[];
  tally: DerivedWorkoutTally;
};

export type DerivedWorkout = {
  stages: DerivedWorkoutStage[];
  /** Owner ticks in the session that match no climb of the plan. */
  offPlan: number;
  /** Their uuids, so a reader can leave out the ones a viewer may not see. */
  offPlanTickUuids: string[];
};

export type WorkoutHeadline = {
  /** The first main stage's kind; absent for a plan with no stages. */
  mainKind?: string;
  mainTargetGrade?: number;
  /** The second main stage's kind, for "A + B". */
  secondMainKind?: string;
  /** Every stage, warm-ups and cool-downs included. */
  blockCount: number;
  /** Main stages after the first, for "A + N more". */
  extraMainBlocks: number;
};
