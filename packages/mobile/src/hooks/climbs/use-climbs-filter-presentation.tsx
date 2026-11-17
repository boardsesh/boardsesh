import { useRefocusCount } from '../../hooks/use-refocus-count';
import { useCallback, useMemo, useRef } from 'react';
import { Platform } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { BoardName } from '@boardsesh/shared-schema';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import {
  countActiveFilters,
  flagsToProgress,
  progressToFlags,
  sortKeyPatch,
  climbTypePatch,
  DEFAULT_CLIMB_FILTER_STATE,
  type ProgressFilter,
  type SortOption,
  type GradeAccuracyValue,
} from '@boardsesh/climb-filters';
import { getTallWideScope } from '@boardsesh/board-constants';
import { FilterChipRow } from '../../components/search/FilterChipRow';
import type { DimensionChip } from '../../components/search/FilterChipRow.types';
import { chipKindToTokenKeys } from '../../lib/pinnable-chips';
import { usePinnedChips } from '../../lib/pinned-chips-store';
import { SPRAY_BOARD_NAME } from '../../lib/spray/spray-wall-registry';
import {
  collectionPatch,
  getCollectionFilter,
  getClimbTypeFilter,
  type CollectionFilter,
  type ClimbTypeFilter,
} from '../../lib/collection-filter';
import { FilterTokenRow } from '../../components/search/FilterTokenRow';
import { GradeRangeRail, type GradeRailChange } from '../../components/grade';
import { applyPopularityBucket } from '../../lib/filter-chip-menus';
import { useDimensionLockUpkeep, useDimensionLocks } from '../../lib/dimension-lock-store';
import {
  buildDimensionChip,
  isDimensionChipLocked,
  isDimensionLockEnforced,
  type DimensionLockState,
  type LockedDimensions,
} from '../../lib/dimension-chips';
import { hapticMedium } from '../../lib/haptics';
import { useTheme } from '../../providers/theme-provider';
import { selectByVariant } from '../../theme/variants';
import { type GradeBound } from '../../providers/climb-search-provider';
import { buildClimbFilterSummary } from '../../lib/filter-summary';
import { buildNameFilterToken, getActiveFilterTokens } from '../../lib/filter-tokens';
import { track } from '../../lib/analytics';
import type { BoardSearchConfig } from '@boardsesh/climb-filters';
import type { useClimbsSearchSession } from './use-climbs-search-session';

const SUMMARY_MAX_CHARS = 28;
const DIMENSION_LOCK_SUPPORTED = Platform.OS === 'ios';
/** Presentation reads these controls without depending on query or sheet lifecycle internals. */
type ClimbFilterPresentationInput = Pick<
  ReturnType<typeof useClimbsSearchSession>,
  | 'filters'
  | 'boardFilters'
  | 'name'
  | 'setGrade'
  | 'patchFilters'
  | 'patchBoardFilters'
  | 'isAuthenticated'
  | 'searchReady'
  | 'grades'
  | 'gradeStops'
  | 'formatBoardGradeByDifficultyId'
  | 'lastUsedGrade'
  | 'handleClearName'
  | 'handleOpenFilters'
  | 'recentFilters'
  | 'handleApplyRecentFilter'
  | 'handleClearRecentFilters'
  | 'handleClearNonGradeFilters'
  | 'gradeRowShown'
  | 'gradeUsesPopover'
  | 'gradePopoverOpen'
  | 'handleOpenGrade'
  | 'handleCloseGrade'
>;

export function useClimbsFilterPresentation(
  session: ClimbFilterPresentationInput,
  boardConfig: BoardSearchConfig | null,
) {
  const {
    filters,
    boardFilters,
    name,
    setGrade,
    patchFilters,
    patchBoardFilters,
    isAuthenticated,
    searchReady,
    grades,
    gradeStops,
    formatBoardGradeByDifficultyId,
    lastUsedGrade,
    handleClearName,
    handleOpenFilters,
    recentFilters,
    handleApplyRecentFilter,
    handleClearRecentFilters,
    handleClearNonGradeFilters,
    gradeRowShown,
    gradeUsesPopover,
    gradePopoverOpen,
    handleOpenGrade,
    handleCloseGrade,
  } = session;
  const { t } = useTranslation('climbs');
  const { variant, features } = useTheme();
  const filterInTopChrome = features.filtersInTopChrome;
  const boardName = boardConfig?.boardName ?? '';
  const layoutId = boardConfig?.layoutId ?? 0;
  const sizeId = boardConfig?.sizeId ?? 0;
  const { pinned: pinnedChips, loaded: pinnedChipsLoaded } = usePinnedChips();
  const gradeRowVisible = gradeRowShown && !gradeUsesPopover && pinnedChips.includes('grade');
  const gradeBound = useMemo<GradeBound>(
    () => ({ minGradeId: filters.minGrade, maxGradeId: filters.maxGrade }),
    [filters.minGrade, filters.maxGrade],
  );
  const activeFilterCount = useMemo(() => countActiveFilters(filters, boardFilters), [filters, boardFilters]);
  // The Filters badge also counts a name search, which lives in the sheet like any
  // other filter (the Logbook pattern). Analytics and the empty states keep
  // `activeFilterCount`, which leaves the name out.
  const filtersBadgeCount = activeFilterCount + (name.trim().length > 0 ? 1 : 0);
  // The name search as the first token: the list shows it, and clears it, here.
  const nameToken = useMemo(() => buildNameFilterToken(name, t, handleClearName), [name, t, handleClearName]);
  // `Grade Filter Changed`: each change the climber makes on the grade row or
  // its iPad popover, with how they made it. The filter sheet's rail edits a
  // draft and is not reported here.
  const lastGradeChangeAtRef = useRef<number | null>(null);
  const handleGradeRailChange = useCallback(
    (next: GradeBound, change: GradeRailChange) => {
      const changedAt = Date.now();
      const previousChangeAt = lastGradeChangeAtRef.current;
      lastGradeChangeAtRef.current = changedAt;
      track(SHARED_EVENTS.GradeFilterChanged, {
        // 0 = unset, the sentinel Climb Search Performed uses.
        fromMin: gradeBound.minGradeId ?? 0,
        fromMax: gradeBound.maxGradeId ?? 0,
        toMin: next.minGradeId ?? 0,
        toMax: next.maxGradeId ?? 0,
        gesture: change.gesture,
        // Only on a tap with one other grade selected: did it land inside the
        // range window (a range) or after it (a switch)?
        ...(change.withinRangeWindow !== undefined && { withinRangeWindow: change.withinRangeWindow }),
        // Left out on the first change of the session.
        ...(previousChangeAt !== null && { msSincePrevious: changedAt - previousChangeAt }),
      });
      setGrade(next);
    },
    [gradeBound, setGrade],
  );
  // Once open, the grade row stays on screen, so it outlives a visit to a climb.
  // On the way back it centres on the current selection again, wherever the
  // climber left it scrolled.
  const gradeRecenterKey = useRefocusCount();
  // Removable active-filter tokens for the scope row beneath the search field.
  // Each token's `clear` patches just its field back to the default.
  const filterTokens = useMemo(
    () =>
      getActiveFilterTokens({
        filters,
        boardFilters,
        boardName,
        grades,
        t,
        formatGradeByDifficultyId: formatBoardGradeByDifficultyId,
        gradeStops,
        patchFilters,
        patchBoardFilters,
        setGrade,
      }),
    [
      filters,
      boardFilters,
      boardName,
      grades,
      t,
      formatBoardGradeByDifficultyId,
      gradeStops,
      patchFilters,
      patchBoardFilters,
      setGrade,
    ],
  );
  const nonGradeFilterTokens = useMemo(
    () => filterTokens.filter((filterToken) => filterToken.key !== 'grade'),
    [filterTokens],
  );
  const summaryFilterTokens = features.summaryExcludesGradeFilter ? nonGradeFilterTokens : filterTokens;
  // Condensed summary of the active filters (variant-aware: Material chip vs glass
  // title). See buildClimbFilterSummary.
  const filterSummary = useMemo(
    () =>
      buildClimbFilterSummary({
        labels: summaryFilterTokens.map((token) => token.label),
        isMaterial: selectByVariant(variant, { material: true, liquidGlass: false }),
        maxChars: SUMMARY_MAX_CHARS,
        more: (count) => t('mobile.search.more', { count }),
      }),
    [summaryFilterTokens, variant, t],
  );
  // Stable object for the memoized ClimbTopChrome's filterSummary prop — inline
  // it would allocate every render and defeat the memo.
  const filterSummaryProp = useMemo(
    () =>
      filterInTopChrome && filterSummary ? { text: filterSummary, onClear: handleClearNonGradeFilters } : undefined,
    [filterInTopChrome, filterSummary, handleClearNonGradeFilters],
  );
  const gradeFilterToken = useMemo(
    () => filterTokens.find((filterToken) => filterToken.key === 'grade'),
    [filterTokens],
  );
  const gradeChip = useMemo(() => {
    if (gradeFilterToken) {
      return { label: gradeFilterToken.label, active: true, onClear: gradeFilterToken.clear };
    }
    return { label: t('mobile.filter.grade'), active: false };
  }, [gradeFilterToken, t]);

  // --- Persistent filter chips (Liquid Glass) ---
  // Each facet chip commits live through the search-provider patch actions. The
  // Popularity chip routes through applyPopularityBucket so it clears a
  // conflicting projects/drafts status, exactly like the filter sheet.
  // Bare patch, mirroring the sheet's StarRating (which also doesn't conflict-clear
  // status for minRating); keeps the chip, token, and sheet divergence-free.
  const handleChangeRating = useCallback(
    (value: number | undefined) => patchFilters({ minRating: value }),
    [patchFilters],
  );
  const handleChangePopularity = useCallback(
    (bucket: number | undefined) => patchFilters(applyPopularityBucket(filters, bucket)),
    [patchFilters, filters],
  );
  // "Your progress" writes a full four-flag patch (progressToFlags clears stale
  // flags), so switching between values never leaves a contradictory flag behind.
  const handleChangeProgress = useCallback(
    (value: ProgressFilter) => patchFilters(progressToFlags(value)),
    [patchFilters],
  );
  // Collection — Benchmarks (board filter), My drafts (status) and Liked
  // (onlyFavorited), mutually exclusive: picking one clears the other two.
  const handleChangeCollection = useCallback(
    (value: CollectionFilter) => {
      patchFilters(collectionPatch(value, filters).filters);
    },
    [patchFilters, filters],
  );
  // --- Tier-2 (opt-in) chip handlers — mirror the filter sheet's own controls so
  // a chip and the sheet never diverge. ---
  // Sort: picking Random reseeds a fresh shuffle (matches the sheet); every other
  // key clears the seed. Direction (asc/desc) stays a sheet-only refinement.
  const handleChangeSort = useCallback((value: SortOption) => patchFilters(sortKeyPatch(value)), [patchFilters]);
  const handleChangeAccuracy = useCallback(
    (value: GradeAccuracyValue | 'off') => patchFilters({ gradeAccuracy: value === 'off' ? undefined : value }),
    [patchFilters],
  );
  // Climb type — the same shared mapping as the sheet's handleClimbTypeChange.
  const handleChangeClimbType = useCallback(
    (value: ClimbTypeFilter) => patchFilters(climbTypePatch(value)),
    [patchFilters],
  );
  const handleToggleBeta = useCallback(
    () => patchFilters({ onlyWithBetaVideos: filters.onlyWithBetaVideos ? undefined : true }),
    [patchFilters, filters.onlyWithBetaVideos],
  );
  const handleToggleBenchmarks = useCallback(
    () => patchBoardFilters({ onlyBenchmarks: boardFilters.onlyBenchmarks ? undefined : true }),
    [patchBoardFilters, boardFilters.onlyBenchmarks],
  );
  // Climb-type single-select derived from the boulders/routes flags — one shared
  // helper with the sheet, so the chip and sheet never show a different pick.
  const climbType = getClimbTypeFilter(filters);
  // Sort is "active" whenever the key OR direction differs from the default — the
  // same condition the sort token uses, so the chip lights up in lockstep with it.
  const sortActive =
    filters.sortBy !== DEFAULT_CLIMB_FILTER_STATE.sortBy || filters.sortOrder !== DEFAULT_CLIMB_FILTER_STATE.sortOrder;
  // Tall/Wide chips appear on any board whose active size has a shorter/narrower
  // size in its product family — Kilter Homewall & Original, Tension Board 2,
  // Decoy, Grasshopper (getTallWideScope is the shared source of truth, matching
  // the server filter). Tap toggles the filter. On iOS a long-press locks it
  // (persisted) so it survives clears; the upkeep hooks below re-apply a locked
  // filter whenever it's cleared. Every rule lives in lib/dimension-chips.ts.
  const { locks: dimensionLocks, setLock: setDimensionLock } = useDimensionLocks();
  const { hasShorter: showTallChip, hasNarrower: showWideChip } = getTallWideScope(
    boardName as BoardName,
    layoutId,
    sizeId,
  );
  const tallLockState = useMemo<DimensionLockState>(
    () => ({
      lockSupported: DIMENSION_LOCK_SUPPORTED,
      locked: dimensionLocks.tall,
      inScope: showTallChip,
      pinned: pinnedChips.includes('tall'),
      pinsLoaded: pinnedChipsLoaded,
    }),
    [dimensionLocks.tall, showTallChip, pinnedChips, pinnedChipsLoaded],
  );
  const wideLockState = useMemo<DimensionLockState>(
    () => ({
      lockSupported: DIMENSION_LOCK_SUPPORTED,
      locked: dimensionLocks.wide,
      inScope: showWideChip,
      pinned: pinnedChips.includes('wide'),
      pinsLoaded: pinnedChipsLoaded,
    }),
    [dimensionLocks.wide, showWideChip, pinnedChips, pinnedChipsLoaded],
  );
  const dimensionChips = useMemo<DimensionChip[]>(() => {
    const chips: DimensionChip[] = [];
    if (showTallChip) {
      chips.push(
        buildDimensionChip({
          key: 'tall',
          locked: isDimensionChipLocked(tallLockState),
          filterActive: !!filters.onlyTallClimbs,
          setFilter: (on) => patchFilters({ onlyTallClimbs: on || undefined }),
          setLock: (locked) => {
            hapticMedium();
            setDimensionLock('tall', locked);
          },
        }),
      );
    }
    if (showWideChip) {
      chips.push(
        buildDimensionChip({
          key: 'wide',
          locked: isDimensionChipLocked(wideLockState),
          filterActive: !!filters.onlyWideClimbs,
          setFilter: (on) => patchFilters({ onlyWideClimbs: on || undefined }),
          setLock: (locked) => {
            hapticMedium();
            setDimensionLock('wide', locked);
          },
        }),
      );
    }
    return chips;
  }, [
    showTallChip,
    showWideChip,
    tallLockState,
    wideLockState,
    filters.onlyTallClimbs,
    filters.onlyWideClimbs,
    patchFilters,
    setDimensionLock,
  ]);
  // An enforced lock (iOS, in scope, pinned, pins loaded) puts its filter back
  // after any clear (sheet Reset, FAB clear, recent re-apply), but only once this
  // board's saved search has been restored (`searchReady`), since the restore
  // replaces the whole search. Unpinning a chip drops its lock.
  const pinTall = useCallback(() => patchFilters({ onlyTallClimbs: true }), [patchFilters]);
  const pinWide = useCallback(() => patchFilters({ onlyWideClimbs: true }), [patchFilters]);
  useDimensionLockUpkeep({
    key: 'tall',
    state: tallLockState,
    filterActive: !!filters.onlyTallClimbs,
    searchReady,
    pin: pinTall,
  });
  useDimensionLockUpkeep({
    key: 'wide',
    state: wideLockState,
    filterActive: !!filters.onlyWideClimbs,
    searchReady,
    pin: pinWide,
  });
  // The filter sheet holds an enforced lock's switch on (disabled) and keeps it
  // set through its Reset, so its "Show N" count matches what Apply will list.
  // Built from the two flags, so its identity only changes when a lock does (a
  // pin toggle rebuilds the lock states but rarely changes either flag).
  const tallLockEnforced = isDimensionLockEnforced(tallLockState);
  const wideLockEnforced = isDimensionLockEnforced(wideLockState);
  const lockedDimensions = useMemo<LockedDimensions>(
    () => ({ tall: tallLockEnforced, wide: wideLockEnforced }),
    [tallLockEnforced, wideLockEnforced],
  );
  // The normal status token also resets popularity. Empty-search recovery must
  // remove exactly the chosen restriction, keeping every other pick intact.
  const recoveryFilterTokens = useMemo(() => {
    const restrictionTokens = filterTokens.map((token) =>
      token.key === 'status' ? { ...token, clear: () => patchFilters({ status: 'any' }) } : token,
    );
    return nameToken ? [nameToken, ...restrictionTokens] : restrictionTokens;
  }, [filterTokens, patchFilters, nameToken]);
  // Token row = the receipt for the long tail only; a filter backed by a *pinned*
  // chip shows and clears itself there, so it's excluded to avoid wording it
  // twice. Derived from the user's pinned set so unpinning a chip re-surfaces its
  // filter as a removable token (and re-pinning removes the token). Tall/Wide are
  // chip-backed only when their own chip is pinned AND the board size shows it.
  const chipBackedTokenKeys = useMemo(
    () => new Set<string>(pinnedChips.flatMap((kind) => chipKindToTokenKeys(kind))),
    [pinnedChips],
  );
  const sheetOnlyFilterTokens = useMemo(() => {
    const longTailTokens = filterTokens.filter((token) => {
      if (token.key === 'tall') return !(chipBackedTokenKeys.has('tall') && showTallChip);
      if (token.key === 'wide') return !(chipBackedTokenKeys.has('wide') && showWideChip);
      // The Sort chip only switches the sort KEY, never the direction. So keep the
      // sort token (its clear() resets both) whenever the direction is non-default —
      // else an ascending sort set in the sheet would be unclearable from the row.
      if (token.key === 'sort') {
        return !(chipBackedTokenKeys.has('sort') && filters.sortOrder === DEFAULT_CLIMB_FILTER_STATE.sortOrder);
      }
      return !chipBackedTokenKeys.has(token.key);
    });
    return nameToken ? [nameToken, ...longTailTokens] : longTailTokens;
  }, [filterTokens, chipBackedTokenKeys, showTallChip, showWideChip, filters.sortOrder, nameToken]);
  const denseChipRow = selectByVariant(variant, { material: true, liquidGlass: false });
  const filterChrome = useMemo(() => {
    return (
      <>
        <FilterChipRow
          pinnedChips={pinnedChips}
          activeFilterCount={filtersBadgeCount}
          onOpenFilters={handleOpenFilters}
          recentFilters={recentFilters}
          currentFilters={filters}
          currentSearchText={name}
          onApplyRecent={handleApplyRecentFilter}
          onClearRecent={handleClearRecentFilters}
          gradeLabel={gradeChip.label}
          gradeActive={gradeChip.active}
          onOpenGrade={handleOpenGrade}
          gradeRailOpen={gradeUsesPopover ? gradePopoverOpen : gradeRowShown}
          onCloseGrade={handleCloseGrade}
          gradePopoverContent={
            gradeUsesPopover ? (
              <GradeRangeRail
                grades={grades}
                bound={gradeBound}
                lastUsedGradeId={lastUsedGrade}
                boardName={boardName}
                onChange={handleGradeRailChange}
              />
            ) : undefined
          }
          dimensionChips={dimensionChips}
          minAscents={filters.minAscents}
          onChangePopularity={handleChangePopularity}
          minRating={filters.minRating}
          onChangeRating={handleChangeRating}
          progress={flagsToProgress(filters)}
          onChangeProgress={handleChangeProgress}
          canFilterProgress={isAuthenticated}
          collection={getCollectionFilter(filters)}
          onChangeCollection={handleChangeCollection}
          canFilterPersonalCollections={isAuthenticated}
          isSprayWall={boardName === SPRAY_BOARD_NAME}
          boardName={boardName}
          sortBy={filters.sortBy}
          sortActive={sortActive}
          onChangeSort={handleChangeSort}
          accuracyValue={filters.gradeAccuracy ?? 'off'}
          onChangeAccuracy={handleChangeAccuracy}
          climbType={climbType}
          onChangeClimbType={handleChangeClimbType}
          betaActive={!!filters.onlyWithBetaVideos}
          onToggleBeta={handleToggleBeta}
          benchmarksActive={!!boardFilters.onlyBenchmarks}
          onToggleBenchmarks={handleToggleBenchmarks}
          // The Material Climbs bar's 48dp chip row (ClimbTopChrome).
          dense={denseChipRow}
        />
        {/* Under the dense Material chip row nothing else pads the pills off the list. */}
        <FilterTokenRow tokens={sheetOnlyFilterTokens} bottomInset={denseChipRow} />
      </>
    );
  }, [
    denseChipRow,
    gradeUsesPopover,
    grades,
    gradeBound,
    lastUsedGrade,
    boardName,
    handleGradeRailChange,
    gradePopoverOpen,
    gradeRowShown,
    pinnedChips,
    filtersBadgeCount,
    handleOpenFilters,
    recentFilters,
    filters,
    name,
    handleApplyRecentFilter,
    handleClearRecentFilters,
    gradeChip,
    handleOpenGrade,
    handleCloseGrade,
    dimensionChips,
    handleChangePopularity,
    handleChangeRating,
    handleChangeProgress,
    handleChangeCollection,
    boardFilters.onlyBenchmarks,
    isAuthenticated,
    sortActive,
    handleChangeSort,
    handleChangeAccuracy,
    climbType,
    handleChangeClimbType,
    handleToggleBeta,
    handleToggleBenchmarks,
    sheetOnlyFilterTokens,
  ]);
  return {
    gradeBound,
    activeFilterCount,
    filtersBadgeCount,
    recoveryFilterTokens,
    lockedDimensions,
    filterSummaryProp,
    gradeChip,
    gradeRowVisible,
    gradeRecenterKey,
    handleGradeRailChange,
    filterChrome,
  };
}
