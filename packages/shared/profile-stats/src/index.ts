// @boardsesh/profile-stats — renderer-agnostic climbing-stats aggregation for
// the web "You" page and the mobile profile screen. Pure TS: no React, no
// theme, no DOM. Chart output is keyed (gradeKey / layoutKey / flash|redpoint)
// with display labels but no colors; each platform resolves colors itself.

export * from './types';
export {
  filterLogbookByTimeframe,
  buildAggregatedStackedBars,
  buildWeeklyBars,
  buildFlashRedpointBars,
  buildAggregatedFlashRedpointBars,
  buildVPointsTimeline,
  buildStatisticsSummary,
  buildActivityHeatmap,
} from './chart-builders';
export { difficultyMapping, getDifficultyMapping, sortGrades } from './grade-mapping';
export {
  BOARD_TYPES,
  LAYOUT_ORDER,
  getLayoutKey,
  getLayoutDisplayName,
  parseLayoutKey,
  sortLayoutKeys,
} from './layouts';
export { parseTickTime, tickTimeMs, formatTickRelativeTime, formatTickAbsoluteTime } from './format-tick-time';
export { deriveProfileViewModel, type DeriveProfileViewModelInput, type ProfileViewModel } from './derive-view-model';
