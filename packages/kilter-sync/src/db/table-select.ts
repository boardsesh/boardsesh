import {
  boardClimbs,
  boardClimbStats,
  boardDifficultyGrades,
  boardProductSizes,
  boardLayouts,
  boardUsers,
  boardCircuits,
  boardClimbStatsHistory,
  boardAttempts,
  boardProducts,
  boardSharedSyncs,
  boardUserSyncs,
  boardClimbHolds,
  boardBetaLinks,
  boardWalls,
  boardTags,
} from '@boardsesh/db/schema/boards';

export const UNIFIED_TABLES = {
  climbs: boardClimbs,
  climbStats: boardClimbStats,
  difficultyGrades: boardDifficultyGrades,
  productSizes: boardProductSizes,
  layouts: boardLayouts,
  users: boardUsers,
  circuits: boardCircuits,
  climbStatsHistory: boardClimbStatsHistory,
  attempts: boardAttempts,
  products: boardProducts,
  userSyncs: boardUserSyncs,
  sharedSyncs: boardSharedSyncs,
  climbHolds: boardClimbHolds,
  betaLinks: boardBetaLinks,
  walls: boardWalls,
  tags: boardTags,
} as const;

export type UnifiedTableSet = typeof UNIFIED_TABLES;
