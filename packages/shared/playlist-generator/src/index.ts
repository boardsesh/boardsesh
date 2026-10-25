// Pure-TS generator algorithms for climbing workouts. No React, no DOM.
// Web and mobile UIs both consume from here; climb selection (the GraphQL
// fetch that turns slots into actual climbs) stays platform-side.

export * from './types';
export {
  generateVolumePlan,
  generatePyramidPlan,
  generateLadderPlan,
  generateGradeFocusPlan,
  generateOnTheMinutePlan,
  generateFourByFourPlan,
  generateLimitBoulderingPlan,
  generateWorkoutPlan,
  groupSlotsBySection,
} from './generate';
export type { GroupedSlots } from './generate';
export {
  ESTIMATE_SECONDS_PER_TRY,
  ESTIMATE_TRIES_UNTIL_SEND,
  ESTIMATE_UNPACED_REST_SECONDS,
  estimateWorkoutMinutes,
  summarizePlanFill,
} from './plan-summary';
export type { PlanFillSummary, PlanSectionCount } from './plan-summary';
export {
  MAX_STAGE_REPS_PER_SET,
  MAX_STAGE_REST_SECONDS,
  MAX_STAGE_SETS,
  MIN_STAGE_INTERVAL_SECONDS,
  MIN_STAGE_REPS_PER_SET,
  STAGE_CHANGEOVER_SECONDS,
  isWorkoutStagePacing,
  pacingForOptions,
  stageRestSeconds,
} from './pacing';
export type { StageAdvanceOn, StagePacingMode, StageSetPacing, WorkoutStagePacing } from './pacing';
export {
  WORKOUT_STAGE_KINDS,
  isWorkoutStageKind,
  planFromBlocks,
  generateStagedPlan,
  isWarmUpStage,
  buildWorkoutRun,
  appendStageToRun,
  pruneRun,
  locateInRun,
  workoutRunHasPacing,
} from './stages';
export type {
  WorkoutBlockSpec,
  WorkoutStageKind,
  WarmUpStageType,
  WorkoutStageFilters,
  WarmUpStage,
  StageGeneratorOptions,
  WorkoutMainStage,
  WorkoutStage,
  WorkoutPlan,
  StagedSlot,
  StageIdFactory,
  WorkoutRunStage,
  WorkoutRunStageIdentity,
  WorkoutRun,
  WorkoutRunEntry,
  WorkoutRunPosition,
} from './stages';
