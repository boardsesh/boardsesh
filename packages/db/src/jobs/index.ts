/**
 * Long-running data jobs, runnable from a CLI (`packages/db/scripts/`) or from
 * the background worker's batch families (`packages/backend/src/workers/families/`).
 * Nothing here reads `process.env`, loads dotenv or exits the process.
 */
export * from './types';
export {
  runRefreshRecommendations,
  posthogConfigFromEnvironment,
  POSTHOG_DEFAULT_HOST,
  POSTHOG_DEFAULT_PROJECT_ID,
  type PosthogQueryConfig,
  type RefreshRecommendationsOptions,
  type RefreshRecommendationsResult,
  type SendStatsOutcome,
} from './refresh-recommendations';
export {
  runRefreshHoldFeatures,
  type RefreshHoldFeaturesOptions,
  type RefreshHoldFeaturesParams,
  type RefreshHoldFeaturesResult,
} from './refresh-hold-features';
export {
  runRefreshClimbGrades,
  GradeGatesFailedError,
  type PublishedBoardResult,
  type RefreshClimbGradesOptions,
  type RefreshClimbGradesParams,
  type RefreshClimbGradesResult,
} from './refresh-climb-grades';
export {
  runRefreshClimbNeighbors,
  ClimbNeighborsInterruptedError,
  CLIMB_NEIGHBOR_BOARDS,
  isGapRefillDay,
  orderBoardsByClimbCount,
  type ClimbNeighborRefreshResult,
  type RefreshClimbNeighborsOptions,
  type RefreshClimbNeighborsParams,
  type RefreshClimbNeighborsResult,
} from './refresh-climb-neighbors';
