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
  MAX_STAGE_REST_SECONDS,
  MAX_STAGE_ROUNDS,
  MIN_STAGE_INTERVAL_SECONDS,
  STAGE_CHANGEOVER_SECONDS,
  isWorkoutStagePacing,
  pacingForOptions,
  roundsForOptions,
  stageRestSeconds,
} from './pacing';
export type { StageAdvanceOn, StagePacingMode, WorkoutStagePacing } from './pacing';
export { expandRounds, isRoundNumber, locateRound } from './rounds';
export type { WorkoutRunRoundPosition } from './rounds';
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
