// Builds the removable active-filter tokens shown beneath the climbs search
// field. Each token carries a display label and a `clear` that resets just that
// one filter back to its default. Labels reuse the same builders as the filter
// summary string (filter-labels.ts) so a filter is never worded two ways.
//
// The typed name query is deliberately NOT a token — it lives in the search
// field itself, where the field's own clear/cancel handles it.
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
  DEFAULT_CLIMB_FILTER_STATE,
  type ClimbFilterState,
  type ClimbBoardFilterState,
} from '@boardsesh/climb-filters';
import { buildFilterLabels, buildSortLabel, formatSettersLabel } from './filter-labels';
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
  patchFilters: (patch: Partial<ClimbFilterState>) => void;
  patchBoardFilters: (patch: Partial<ClimbBoardFilterState>) => void;
  setGrade: (grade: GradeBound) => void;
};

/**
 * One token per active filter, in the same field order as the summary string.
 * Grade is a single token for the whole bound; the name query is excluded.
 */
export function getActiveFilterTokens({
  filters,
  boardFilters,
  grades,
  t,
  formatGradeByDifficultyId,
  patchFilters,
  patchBoardFilters,
  setGrade,
}: GetActiveFilterTokensArgs): FilterToken[] {
  const labels = buildFilterLabels(t);
  const sortLabel = buildSortLabel(t);
  const tokens: FilterToken[] = [];

  // Grade — only when grades data has loaded, so the label is a real grade name
  // rather than the "#42" id fallback.
  if (grades != null && (filters.minGrade != null || filters.maxGrade != null)) {
    // Prefer the user's single-scale grade name; fall back to the dual name.
    const gradeName = (difficultyId: number) =>
      formatGradeByDifficultyId(difficultyId) ?? getGradeName(difficultyId, grades);
    let label: string;
    if (filters.minGrade != null && filters.maxGrade != null) {
      // A single selected grade (min == max) reads as the bare grade name, not a range.
      label =
        filters.minGrade === filters.maxGrade
          ? gradeName(filters.minGrade)
          : labels.gradeRange(gradeName(filters.minGrade), gradeName(filters.maxGrade));
    } else if (filters.minGrade != null) {
      label = labels.gradeMin(gradeName(filters.minGrade));
    } else {
      label = labels.gradeMax(gradeName(filters.maxGrade as number));
    }
    tokens.push({ key: 'grade', label, clear: () => setGrade({ minGradeId: undefined, maxGradeId: undefined }) });
  }

  // Sort — when either the field or direction differs from the default.
  if (
    filters.sortBy !== DEFAULT_CLIMB_FILTER_STATE.sortBy ||
    filters.sortOrder !== DEFAULT_CLIMB_FILTER_STATE.sortOrder
  ) {
    const label = sortLabel(filters.sortBy);
    if (label) {
      tokens.push({
        key: 'sort',
        label,
        clear: () =>
          patchFilters({
            sortBy: DEFAULT_CLIMB_FILTER_STATE.sortBy,
            sortOrder: DEFAULT_CLIMB_FILTER_STATE.sortOrder,
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

  // Only drafts/projects produce a token — 'any' is the default and 'established'
  // is the retired duplicate of the popularity lever (matches the summary).
  if (filters.status === 'drafts' || filters.status === 'projects') {
    tokens.push({
      key: 'status',
      label: labels.status(filters.status),
      clear: () => patchFilters(applyStatusChange(filters, 'any')),
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

  // Climb type — default is boulders-only; a token appears when routes are on or
  // boulders are off. Clearing returns to the boulders-only default.
  const bouldersOn = filters.boulders ?? true;
  const routesOn = filters.routes ?? false;
  if (bouldersOn !== true || routesOn !== false) {
    const label = routesOn && !bouldersOn ? t('search.summary.routesOnly') : t('search.summary.bouldersAndRoutes');
    tokens.push({ key: 'climbType', label, clear: () => patchFilters({ boulders: true, routes: false }) });
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

  if (boardFilters.quantumOverlap != null && boardFilters.quantumOverlap !== 'off') {
    tokens.push({
      key: 'quantumOverlap',
      label:
        boardFilters.quantumOverlap === 'none'
          ? t('mobile.filter.quantumOverlap.noneToken')
          : t('mobile.filter.quantumOverlap.atMostOneToken'),
      clear: () => patchBoardFilters({ quantumOverlap: undefined }),
    });
  }

  return tokens;
}
