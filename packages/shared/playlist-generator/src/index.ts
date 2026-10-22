// Pure-TS generator algorithms for climbing workouts. No React, no DOM.
// Web and mobile UIs both consume from here; climb selection (the GraphQL
// fetch that turns slots into actual climbs) stays platform-side.

export * from './types';
export {
  generateVolumePlan,
  generatePyramidPlan,
  generateLadderPlan,
  generateGradeFocusPlan,
  generateWorkoutPlan,
  groupSlotsBySection,
} from './generate';
export type { GroupedSlots } from './generate';
export { summarizePlanFill } from './plan-summary';
export type { PlanFillSummary, PlanSectionCount } from './plan-summary';
export {
  planFromBlocks,
  generateStagedPlan,
  isWarmUpStage,
  buildWorkoutRun,
  appendStageToRun,
  pruneRun,
  locateInRun,
} from './stages';
export type {
  WorkoutBlockSpec,
  WorkoutStageKind,
  WarmUpStageType,
  WarmUpStage,
  StageGeneratorOptions,
  WorkoutMainStage,
  WorkoutStage,
  WorkoutPlan,
  StagedSlot,
  StageIdFactory,
  WorkoutRunStage,
  WorkoutRun,
  WorkoutRunPosition,
} from './stages';
