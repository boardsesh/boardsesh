// Builds the removable active-filter tokens shown beneath the climbs search
// field. Each token carries a display label and a `clear` that resets just that
// one filter back to its default. Labels reuse the same builders as the filter
// summary string (filter-labels.ts) so a filter is never worded two ways.
//
// The climb-name search is its own token (`buildNameFilterToken`): no list has a
// search field, the name is typed in the Filters sheet, so the token is where the
// list shows it and clears it. `getActiveFilterTokens` leaves it out so each
// caller puts it first.
//
// Mobile-only for now: web has no removable-token row and its filter state is a
// different (URL-param) shape. If web grows one, promote the {key,label,clear}
// mapping into @boardsesh/climb-filters, parameterized over the state shape.

import type { TFunction } from 'i18next';
import type { Grade } from '@boardsesh/shared-schema';
import {
  getGradeName,
  applyStatusChange,
  countFilteredHolds,
  flagsToProgress,
  progressToFlags,
  getClimbTypeFilter,
  isClimbTypeFilterActive,
  DEFAULT_CLIMB_FILTER_STATE,
  type ClimbFilterState,
  type ClimbBoardFilterState,
} from '@boardsesh/climb-filters';
import { buildFilterLabels, buildSortLabel, formatSettersLabel } from './filter-labels';
import { gradeBoundLabels, type NamedGradeStop } from './grade-stops';
import type { GradeBound } from '../providers/climb-search-provider';

export type FilterToken = {
  /** Stable identity for the React key and tests. */
  key: string;
  label: string;
  /** Reset this single filter to its default. */
  clear: () => void;
};

type GetActiveFilterTokensArgs = {
  filters: ClimbFilterState;
  boardFilters: ClimbBoardFilterState;
  grades: Grade[] | undefined;
  t: TFunction<'climbs'>;
  /** Formats a difficulty id in the user's chosen single scale (V or font),
   *  matching how the list rows render grades — keeps the chip from showing the
   *  dual "7a+/V7" string. Falls back to the dual name when it returns null. */
  formatGradeByDifficultyId: (difficultyId: number | null | undefined) => string | null;
  /** The range rail's stops (`buildGradeRailStops`), so the token names a pick
   *  exactly as the chip the climber made it from does (#5960): a grouped stop
   *  reads as the stop ("V0" for 4a to 4c), and a bound that covers only part of
   *  one names its grade precisely ("V0 / 4A"). See `gradeBoundLabels`. */
  gradeStops?: readonly NamedGradeStop[];
  patchFilters: (patch: Partial<ClimbFilterState>) => void;
  patchBoardFilters: (patch: Partial<ClimbBoardFilterState>) => void;
  setGrade: (grade: GradeBound) => void;
  /**
   * The list's own starting state, which decides when the sort and the climb
   * type count as set and what their tokens clear back to. The Climbs list's
   * unless given; a playlist starts with both climb types on, so without this a
   * fresh playlist would show a "Boulders & routes" token.
   */
  defaults?: ClimbFilterState;
};

/** The climb-name search as a token, or null with no name. Leads the token row. */
export function buildNameFilterToken(name: string, t: TFunction<'climbs'>, clear: () => void): FilterToken | null {
  const trimmedName = name.trim();
  if (trimmedName.length === 0) return null;
  return { key: 'name', label: t('mobile.filter.nameToken', { name: trimmedName }), clear };
}

/**
 * One token per active filter, in the same field order as the summary string.
 * Grade is a single token for the whole bound; the name query is excluded (see
 * `buildNameFilterToken`).
 */
export function getActiveFilterTokens({
  filters,
  boardFilters,
  grades,
  t,
  formatGradeByDifficultyId,
  gradeStops,
  patchFilters,
  patchBoardFilters,
  setGrade,
  defaults = DEFAULT_CLIMB_FILTER_STATE,
}: GetActiveFilterTokensArgs): FilterToken[] {
  const labels = buildFilterLabels(t);
  const sortLabel = buildSortLabel(t);
  const tokens: FilterToken[] = [];
  if (filters.onlyFollowedAuthors)
    tokens.push({
      key: 'onlyFollowedAuthors',
      label: t('authors.followingClimbs'),
      clear: () => patchFilters({ onlyFollowedAuthors: undefined }),
    });

  // Grade — only when grades data has loaded, so the label is a real grade name
  // rather than the "#42" id fallback.
  if (grades != null && (filters.minGrade != null || filters.maxGrade != null)) {
    // Prefer the rail's own name for each end, then the user's single-scale
    // grade name; fall back to the dual name.
    const railLabels = gradeStops
      ? gradeBoundLabels(gradeStops, { minGradeId: filters.minGrade, maxGradeId: filters.maxGrade })
      : undefined;
    const gradeName = (difficultyId: number, railLabel: string | undefined) =>
      railLabel ?? formatGradeByDifficultyId(difficultyId) ?? getGradeName(difficultyId, grades);
    let label: string;
    if (filters.minGrade != null && filters.maxGrade != null) {
      // `gradeRange` reads two ends with one label as the bare grade name, which
      // covers a single grade and a grouped stop whose ids differ.
      label = labels.gradeRange(
        gradeName(filters.minGrade, railLabels?.min),
        gradeName(filters.maxGrade, railLabels?.max),
      );
    } else if (filters.minGrade != null) {
      label = labels.gradeMin(gradeName(filters.minGrade, railLabels?.min));
    } else {
      label = labels.gradeMax(gradeName(filters.maxGrade as number, railLabels?.max));
    }
    tokens.push({ key: 'grade', label, clear: () => setGrade({ minGradeId: undefined, maxGradeId: undefined }) });
  }

  // Sort — when either the field or direction differs from the default.
  if (filters.sortBy !== defaults.sortBy || filters.sortOrder !== defaults.sortOrder) {
    const label = sortLabel(filters.sortBy);
    if (label) {
      tokens.push({
        key: 'sort',
        label,
        clear: () =>
          patchFilters({
            sortBy: defaults.sortBy,
            sortOrder: defaults.sortOrder,
            sortSeed: undefined,
          }),
      });
    }
  }

  if (filters.minAscents != null) {
    tokens.push({
      key: 'minAscents',
      label: labels.ascents(filters.minAscents),
      clear: () => patchFilters({ minAscents: undefined }),
    });
  }

  if (filters.minRating != null) {
    tokens.push({
      key: 'minRating',
      label: labels.rating(filters.minRating),
      clear: () => patchFilters({ minRating: undefined }),
    });
  }

  // Personal rating (auth-gated). Both levers get their own token so either can
  // be cleared without losing the other.
  if (filters.minUserRating != null) {
    tokens.push({
      key: 'minUserRating',
      label: labels.myRating(filters.minUserRating),
      clear: () => patchFilters({ minUserRating: undefined }),
    });
  }

  if (filters.onlyRatedByMe) {
    tokens.push({
      key: 'onlyRatedByMe',
      label: labels.onlyRatedByMe(),
      clear: () => patchFilters({ onlyRatedByMe: undefined }),
    });
  }

  if (filters.setter != null && filters.setter.length > 0) {
    tokens.push({
      key: 'setter',
      label: formatSettersLabel(filters.setter, labels, t),
      clear: () => patchFilters({ setter: undefined }),
    });
  }

  if (filters.gradeAccuracy != null) {
    tokens.push({
      key: 'gradeAccuracy',
      label: labels.gradeAccuracy(filters.gradeAccuracy),
      clear: () => patchFilters({ gradeAccuracy: undefined }),
    });
  }

  if (filters.onlyTallClimbs) {
    tokens.push({ key: 'tall', label: labels.tallOnly(), clear: () => patchFilters({ onlyTallClimbs: undefined }) });
  }

  if (filters.onlyWideClimbs) {
    tokens.push({ key: 'wide', label: labels.wideOnly(), clear: () => patchFilters({ onlyWideClimbs: undefined }) });
  }

  if (filters.onlyWithBetaVideos) {
    tokens.push({
      key: 'beta',
      label: labels.betaOnly(),
      clear: () => patchFilters({ onlyWithBetaVideos: undefined }),
    });
  }

  if (filters.includeOtherAngles) {
    tokens.push({
      key: 'otherAngles',
      label: labels.otherAngles(),
      clear: () => patchFilters({ includeOtherAngles: undefined }),
    });
  }

  // Only drafts/projects produce a token — 'any' is the default and 'established'
  // is the retired duplicate of the popularity lever (matches the summary).
  if (filters.status === 'drafts' || filters.status === 'projects') {
    tokens.push({
      key: 'status',
      label: labels.status(filters.status),
      clear: () => patchFilters(applyStatusChange(filters, 'any')),
    });
  }

  // The Liked collection (#6002). Its own token, since it is not a status.
  if (filters.onlyFavorited) {
    tokens.push({
      key: 'liked',
      label: labels.liked(),
      clear: () => patchFilters({ onlyFavorited: undefined }),
    });
  }

  // The four per-user tick flags collapse into one "Your progress" token, so a
  // single Projects selection (showOnlyAttempted + hideCompleted) never reads as
  // two tokens. Clearing resets every progress flag to its default.
  const progress = flagsToProgress(filters);
  if (progress !== 'all') {
    tokens.push({
      key: 'progress',
      label: labels.progress(progress),
      clear: () => patchFilters(progressToFlags('all')),
    });
  }

  // Climb type — a token appears when the pick differs from the list's default
  // (boulders only on the Climbs list, both on a playlist). Clearing returns to
  // that default.
  if (isClimbTypeFilterActive(filters, defaults)) {
    const climbType = getClimbTypeFilter(filters, defaults);
    const label =
      climbType === 'routes'
        ? t('search.summary.routesOnly')
        : climbType === 'boulders'
          ? t('search.summary.bouldersOnly')
          : t('search.summary.bouldersAndRoutes');
    tokens.push({
      key: 'climbType',
      label,
      clear: () => patchFilters({ boulders: defaults.boulders ?? true, routes: defaults.routes ?? false }),
    });
  }

  // Board-renderer filters: benchmark, hold types, and board region are all
  // user-settable from the filter sheet, so each gets a removable token. Their
  // labels reuse the same keys the sheet's refine summary uses.
  if (boardFilters.onlyBenchmarks) {
    tokens.push({
      key: 'benchmark',
      label: t('mobile.filter.benchmark'),
      clear: () => patchBoardFilters({ onlyBenchmarks: false }),
    });
  }

  const holdCount = countFilteredHolds(boardFilters.holdsFilter);
  if (holdCount > 0) {
    tokens.push({
      key: 'holds',
      label: t('mobile.holdFilter.summaryCount', { count: holdCount }),
      clear: () => patchBoardFilters({ holdsFilter: undefined }),
    });
  }

  if (boardFilters.zoneBox != null) {
    tokens.push({
      key: 'zone',
      label: t('mobile.zoneFilter.title'),
      clear: () => patchBoardFilters({ zoneBox: null, zoneMode: undefined }),
    });
  }

  return tokens;
}
