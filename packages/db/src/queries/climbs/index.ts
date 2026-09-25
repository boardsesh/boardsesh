export { searchClimbs, MAX_SEARCH_PAGE, clampSearchPage } from './search-climbs';
export { mergeCatalogCharacteristicsSql } from './catalog-characteristics';
export { createClimbFilters, gradeValueSql, hiddenClimbCondition } from './create-climb-filters';
export {
  boardClimbStatsAtSetAngle,
  browsedAngleRestrictionSql,
  effectiveStatsColumn,
  gradeJoinAngleSql,
  resolveBrowsedAngleRestriction,
  resolveCrossAngleStats,
  resolveDetailCrossAngleStats,
  resolvedStatsAngleSql,
  setAngleStatsJoinConditions,
  type StatsColumnKey,
} from './effective-stats';
export { getClimbStars } from './climb-stars';
export { getGradeLabel } from './grade-lookup';
export { populateDenormalizedColumns } from './populate-denormalized-columns';
export { getSetterStats } from './setter-stats';
export { getHoldHeatmapData, normalizeHoldHeatmapRow } from './hold-heatmap';
export type { HoldHeatmapData } from './hold-heatmap';
export { followedAuthorCondition } from './followed-authors';
export type { SetterStat } from './setter-stats';
export type { BoardRouteParams, ClimbSearchParams, ClimbSearchInputLike, ClimbRow, ClimbSearchResult } from './types';
export { mapSearchInputToParams } from './types';

export { applyWoodsRuleUpdates, type WoodsRuleUpdate } from './woods-rule-repair';
export * from './spray-visibility';
export {
  distinctHoldIds,
  parseFramesToHoldEntries,
  storedWoodsSizeId,
  type NormalizedHold,
  type NormalizedHoldRow,
} from './frames-hold-entries';
export {
  CLIMB_NEIGHBOR_K,
  CLIMB_NEIGHBOR_MIN_JACCARD,
  ClimbNeighborIndex,
  getMaterializedSimilarClimbs,
  type ComputedNeighbor,
  type MaterializedSimilarClimb,
  type MaterializedSimilarClimbsArgs,
  type NeighborClimb,
} from './climb-neighbors';
export {
  CLIMB_NEIGHBOR_BOARDS,
  orderBoardsByClimbCount,
  refreshClimbNeighborsForBoard,
  type ClimbNeighborRefreshDb,
  type ClimbNeighborRefreshOptions,
  type ClimbNeighborRefreshResult,
} from './climb-neighbors-refresh';
