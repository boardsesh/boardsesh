/**
 * @boardsesh/leaderboard — pure, renderer-agnostic leaderboard logic.
 *
 * No React, no platform I/O. Shared by the mobile Standings surface, the
 * backend resolver's scope handling, and the web kiosk rail.
 */
export {
  GLOBAL_SCOPE,
  RANKED_BOARD_TYPES,
  SCOPE_KINDS,
  fallbackKinds,
  isRankedBoardType,
  isValidScope,
  layoutScopeKey,
  parseLayoutScopeKey,
  scopeDefinition,
  scopeToId,
  type RankedBoardType,
  type Scope,
  type ScopeKind,
  type ScopeKindDefinition,
} from './scope';

export {
  MIN_COHORT_FOR_PERCENTILE,
  MIN_TIE_FOR_SUPPRESSING_PERCENTILE,
  isTied,
  nextRankGap,
  shouldShowPercentile,
  tiedWithCount,
  type RankGap,
  type ViewerStanding,
} from './ranking';
