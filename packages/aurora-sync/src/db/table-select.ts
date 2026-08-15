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
  boardSets,
  boardHoles,
  boardPlacementRoles,
  boardLeds,
  boardPlacements,
  boardProductSizesLayoutsSets,
  boardKits,
} from '@boardsesh/db/schema/boards';
import { SUPPORTED_BOARDS } from '@boardsesh/shared-schema';
import { type AuroraBoardName, AURORA_BOARDS } from '../api/types';

// Re-export AuroraBoardName as BoardName for backward compatibility within this module
export type BoardName = AuroraBoardName;

const VALID_AURORA_BOARD_NAMES = new Set<string>(AURORA_BOARDS);

// Unified tables - all queries should filter by board_type
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
  sets: boardSets,
  holes: boardHoles,
  placementRoles: boardPlacementRoles,
  leds: boardLeds,
  placements: boardPlacements,
  productSizesLayoutsSets: boardProductSizesLayoutsSets,
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

/**
 * Helper function to check if a board name is valid
 * @param boardName The name to check
 * @returns True if the board name is valid
 */
export function isValidBoardName(boardName: string): boardName is BoardName {
  return VALID_AURORA_BOARD_NAMES.has(boardName);
}

/**
 * Extended board name type for the unified tables: every supported board, not
 * just the Aurora ones. Derived from `SUPPORTED_BOARDS` rather than listing the
 * non-Aurora boards by hand — a code-driven board (MoonBoard, Woods) writes to
 * the same `board_*` tables, and one missing from a hand-kept copy reads as an
 * unknown board rather than as a table it has rows in.
 */
export type UnifiedBoardName = (typeof SUPPORTED_BOARDS)[number];

const VALID_UNIFIED_BOARD_NAMES = new Set<string>(SUPPORTED_BOARDS);

/**
 * Check if a board name is valid for unified tables (every supported board)
 * @param boardName The name to check
 * @returns True if the board name is valid for unified tables
 */
export function isValidUnifiedBoardName(boardName: string): boardName is UnifiedBoardName {
  return VALID_UNIFIED_BOARD_NAMES.has(boardName);
}

export default {
  getUnifiedTable,
  isValidBoardName,
  isValidUnifiedBoardName,
  UNIFIED_TABLES,
};
