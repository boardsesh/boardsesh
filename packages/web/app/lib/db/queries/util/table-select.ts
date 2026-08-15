import {
  // Unified tables
  boardAttempts,
  boardDifficultyGrades,
  boardProducts,
  boardSets,
  boardProductSizes,
  boardLayouts,
  boardHoles,
  boardPlacementRoles,
  boardLeds,
  boardPlacements,
  boardProductSizesLayoutsSets,
  boardClimbs,
  boardClimbStats,
  boardClimbHolds,
  boardClimbStatsHistory,
  boardBetaLinks,
  boardUsers,
  boardCircuits,
  boardCircuitsClimbs,
  boardWalls,
  boardTags,
  boardUserSyncs,
  boardSharedSyncs,
  boardKits,
} from '@/lib/db/schema';
import type { AuroraBoardName } from '@/app/lib/api-wrappers/aurora/types';

// Re-export AuroraBoardName as BoardName for backward compatibility within this module
export type BoardName = AuroraBoardName;

// =============================================================================
// Unified Tables API
// =============================================================================

/**
 * Unified table set - all queries should filter by board_type
 */
export const UNIFIED_TABLES = {
  attempts: boardAttempts,
  difficultyGrades: boardDifficultyGrades,
  products: boardProducts,
  sets: boardSets,
  productSizes: boardProductSizes,
  layouts: boardLayouts,
  holes: boardHoles,
  placementRoles: boardPlacementRoles,
  leds: boardLeds,
  placements: boardPlacements,
  productSizesLayoutsSets: boardProductSizesLayoutsSets,
  climbs: boardClimbs,
  climbStats: boardClimbStats,
  climbHolds: boardClimbHolds,
  climbStatsHistory: boardClimbStatsHistory,
  betaLinks: boardBetaLinks,
  users: boardUsers,
  circuits: boardCircuits,
  circuitsClimbs: boardCircuitsClimbs,
  walls: boardWalls,
  tags: boardTags,
  userSyncs: boardUserSyncs,
  sharedSyncs: boardSharedSyncs,
  kits: boardKits,
} as const;

export type UnifiedTableSet = typeof UNIFIED_TABLES;

/**
 * Get a unified table (all queries should filter by board_type)
 * @param tableName The name of the unified table to retrieve
 * @returns The unified table
 */
export function getUnifiedTable<K extends keyof UnifiedTableSet>(tableName: K): UnifiedTableSet[K] {
  return UNIFIED_TABLES[tableName];
}

// `isValidBoardName` / `isValidUnifiedBoardName` used to live here as a hardcoded
// `||` chain over seven board names. Nothing in the web package imported them (the
// backend has its own copy at `packages/backend/src/db/queries/util/table-select.ts`,
// which is the one every resolver calls), and the chain had already gone stale —
// it never learned about Woods. Deleted rather than re-derived from
// `SUPPORTED_BOARDS`: a board allowlist that nothing consults is a trap, not a guard.

const tableSelectUtils = {
  getUnifiedTable,
  UNIFIED_TABLES,
};

export default tableSelectUtils;
