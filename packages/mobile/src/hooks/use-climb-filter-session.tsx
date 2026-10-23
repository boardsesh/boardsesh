// One list's filter session for a screen other than the Climbs tab: the
// selection, the chip row's props, the token row, the grade rail and the
// filter sheet's props, all from one hook. The playlist screen is the first
// consumer (#6651); setter pages follow.
//
// What it owns:
// - The selection, in a reducer (lib/climb-filter-session-reducer.ts). The sort
//   lives apart from the filters, so a list's own sorts never reach `SortOption`.
// - Live sheet edits through useLiveClimbFilters: the query waits out a 250 ms
//   debounce while the sheet is open, and a sheet from an old scope cannot write.
// - The name search, debounced 300 ms like the Climbs search field. Clearing it
//   applies at once.
// - The grade rail's open state, held here and never in the global
//   `gradeRowShown` setting, so opening it in a playlist leaves Climbs alone.
//   A regular-width iPad shows it as a popover on the Grade chip.
//
// Memoisation: every action only dispatches (stable, `[]` deps), and
// `chipRowProps` is one memo over plain values, so a page load, a refetch or a
// header collapse hands `memo(FilterChipRow)` the same object.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import {
  countActiveFilters,
  climbTypePatch,
  flagsToProgress,
  getClimbTypeFilter,
  newSortSeed,
  normalizeRetiredFilters,
  progressToFlags,
  withoutPlaylistActiveBoardOnlyFilters,
  type BoardSearchConfig,
  type ClimbBoardFilterState,
  type GradeAccuracyValue,
  type ProgressFilter,
  type SortOrder,
} from '@boardsesh/climb-filters';
import { GradeRangeRail } from '../components/grade';
import type {
  ClimbFilterSheetBoardFit,
  ClimbFilterSheetPins,
  ClimbFilterSheetProps,
  ClimbFilterSheetSections,
  FilterSortControl,
} from '../components/ClimbFilterSheet';
import type { FilterChipRowProps, FilterChipSortControl } from '../components/search/FilterChipRow.types';
import type { DimensionChip } from '../lib/dimension-chips';
import { statusForAuth, type ClimbFilters } from '../lib/climb-filter-types';
import {
  climbFilterSessionReducer,
  createClimbFilterSessionState,
  type ClimbFilterSessionSelection,
  type SessionSort,
  type SessionSortModel,
} from '../lib/climb-filter-session-reducer';
import { getCollectionFilter, type ClimbTypeFilter, type CollectionFilter } from '../lib/collection-filter';
import { getActiveFilterTokens, type FilterToken } from '../lib/filter-tokens';
import { buildGradeRailStops } from '../lib/grade-stops';
import { chipKindToTokenKeys, type FilterChipKind } from '../lib/pinnable-chips';
import type { PinnedChipsStore } from '../lib/pinned-chips-store';
import { normalizeSearchName } from '../lib/search-name';
import { SPRAY_BOARD_NAME } from '../lib/spray/spray-wall-registry';
import { useGrades } from '../lib/graphql/hooks';
import type { GradeBound } from '../providers/climb-search-provider';
import { useAuth } from '../providers/auth-provider';
import { useDeviceLayout } from './use-device-layout';
import { useGradeFormat } from './use-grade-format';
import { useLastUsedGrade } from './use-last-used-grade';
import { useLiveClimbFilters } from './use-live-climb-filters';

/** Same wait as the Climbs search field before a typed name reaches the query. */
const NAME_DEBOUNCE_MS = 300;
const NO_DIMENSION_CHIPS: DimensionChip[] = [];
const noop = () => {};

export type UseClimbFilterSessionOptions<K extends string, P extends FilterChipKind> = {
  /**
   * The list, board and login this session belongs to, or null while there is
   * nothing to filter. A sheet opened under one scope closes when it changes.
   */
  scopeKey: string | null;
  /** The active board: Tall / Wide and the sheet's board rows read it. Null without one. */
  boardConfig: BoardSearchConfig | null;
  /** The board whose grades the rail and the tokens use. */
  gradeBoardName: string;
  /** The list's starting filters (sort fields inert). */
  defaultFilters: ClimbFilters;
  /** The list's sorts. Keep it a module constant: its `useLabels` runs as a hook. */
  sortModel: SessionSortModel<K>;
  /** The sort to open on (a remembered one). Read once. */
  initialSort: SessionSort<K>;
  /** Called after the climber settles on a new sort (not while the view is paused). */
  onSortCommit?: (sort: SessionSort<K>) => void;
  /** The list's pin store. Keep it a module constant: its `usePinnedChips` runs as a hook. */
  pinStore: PinnedChipsStore<P>;
  /** Every kind the list can pin, for the sheet's pin toggles. */
  pinnable: readonly P[];
  /** The sheet rows the list hides. */
  sections: ClimbFilterSheetSections;
  /**
   * An active board is picked. Without one, "Fits my board" and every filter
   * that passes only active-board climbs (`PLAYLIST_ACTIVE_BOARD_ONLY_FILTERS`)
   * would match nothing: they are dropped from the selection, and the chips in
   * `activeBoardOnlyChips` from the row.
   */
  activeBoardAvailable: boolean;
  /** The chips whose control needs an active board, left off the row without one. */
  activeBoardOnlyChips: readonly FilterChipKind[];
  /** The list's live match count for the sheet's subtitle; null while unknown. */
  liveCount: number | null;
  /** True while the list cannot be filtered (playlist edit mode): Filters stays shut. */
  disabled: boolean;
  /** The sheet's name-field placeholder. */
  namePlaceholder?: string;
};

export type ClimbFilterSessionView<K extends string> = {
  /**
   * What the query should ask for: the selection (signed-out and boardless
   * filters already dropped), with sheet edits debounced.
   */
  querySelection: ClimbFilterSessionSelection<K>;
  /** Filters in force, the name and "Fits my board" included, the sort not. */
  activeFilterCount: number;
  chipRowProps: FilterChipRowProps;
  /** The removable tokens for the filters no pinned chip shows. */
  tokens: FilterToken[];
  /** The inline grade rail, or null while it is closed (or a popover). */
  gradeRail: ReactElement | null;
  /** The filter sheet's props while it is open, null while it is shut. */
  sheetProps: ClimbFilterSheetProps | null;
};

export type ClimbFilterSessionActions = {
  openFilters: () => void;
  /** Filters, board filters, name and "Fits my board" back to the start. Keeps the sort. */
  clearFilters: () => void;
  /** Everything back to the start, the sort included (and forgotten). */
  resetToDefault: () => void;
  /** Shows the default view (owner edit mode). The sort is kept aside, not forgotten. */
  pauseView: () => void;
  /** Puts the kept-aside sort back. */
  resumeView: () => void;
};

export function useClimbFilterSession<K extends string, P extends FilterChipKind>(
  options: UseClimbFilterSessionOptions<K, P>,
): { state: ClimbFilterSessionView<K>; actions: ClimbFilterSessionActions } {
  const {
    scopeKey,
    boardConfig,
    gradeBoardName,
    defaultFilters,
    sortModel,
    initialSort,
    pinStore,
    pinnable,
    sections,
    activeBoardAvailable,
    activeBoardOnlyChips,
    liveCount,
    disabled,
    namePlaceholder,
  } = options;
  const { t } = useTranslation('climbs');
  const { isAuthenticated } = useAuth();
  const [session, dispatch] = useReducer(
    climbFilterSessionReducer<K>,
    { defaultFilters, defaultSort: sortModel.defaultSort, initialSort },
    createClimbFilterSessionState<K>,
  );
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  // --- Selection ------------------------------------------------------------
  // Signed out, the auth-only filters (progress, ratings, Liked, Following) are
  // dropped, as on the Climbs list. With no active board the active-board-only
  // filters, "Fits my board" among them, are dropped too: they would match
  // nothing, and their controls are hidden, so they must not filter unseen.
  // On a spray wall every climb is a boulder: the climb type rests on the list's
  // default, so no climb-type filter is sent and its control and chip go.
  const isSprayWall = boardConfig?.boardName === SPRAY_BOARD_NAME;
  const { filters, boardFilters } = useMemo(() => {
    const signedInFilters = statusForAuth(normalizeRetiredFilters(session.filters), isAuthenticated);
    const climbTypeFilters =
      isSprayWall &&
      (signedInFilters.boulders !== defaultFilters.boulders || signedInFilters.routes !== defaultFilters.routes)
        ? { ...signedInFilters, boulders: defaultFilters.boulders, routes: defaultFilters.routes }
        : signedInFilters;
    return activeBoardAvailable
      ? { filters: climbTypeFilters, boardFilters: session.boardFilters }
      : withoutPlaylistActiveBoardOnlyFilters(climbTypeFilters, session.boardFilters);
  }, [session.filters, session.boardFilters, isAuthenticated, isSprayWall, defaultFilters, activeBoardAvailable]);
  const boardFit = session.boardFit && activeBoardAvailable;

  // --- Actions (each only dispatches) ----------------------------------------
  const patchFilters = useCallback((patch: Partial<ClimbFilters>) => dispatch({ type: 'patchFilters', patch }), []);
  const patchBoardFilters = useCallback(
    (patch: Partial<ClimbBoardFilterState>) => dispatch({ type: 'patchBoardFilters', patch }),
    [],
  );
  const setGrade = useCallback(
    (grade: GradeBound) =>
      dispatch({ type: 'patchFilters', patch: { minGrade: grade.minGradeId, maxGrade: grade.maxGradeId } }),
    [],
  );
  const handleGradeChange = useCallback((next: GradeBound) => setGrade(next), [setGrade]);
  const handleChangePopularity = useCallback(
    (bucket: number | undefined) => dispatch({ type: 'popularity', bucket }),
    [],
  );
  const handleChangeRating = useCallback(
    (minRating: number | undefined) => dispatch({ type: 'patchFilters', patch: { minRating } }),
    [],
  );
  const handleChangeProgress = useCallback(
    (value: ProgressFilter) => dispatch({ type: 'patchFilters', patch: progressToFlags(value) }),
    [],
  );
  const handleChangeCollection = useCallback((value: CollectionFilter) => dispatch({ type: 'collection', value }), []);
  const handleChangeAccuracy = useCallback(
    (value: GradeAccuracyValue | 'off') =>
      dispatch({ type: 'patchFilters', patch: { gradeAccuracy: value === 'off' ? undefined : value } }),
    [],
  );
  const handleChangeClimbType = useCallback(
    (value: ClimbTypeFilter) => dispatch({ type: 'patchFilters', patch: climbTypePatch(value) }),
    [],
  );
  const handleToggleBeta = useCallback(() => dispatch({ type: 'toggleBeta' }), []);
  const handleToggleBoardFit = useCallback(() => dispatch({ type: 'toggleBoardFit' }), []);
  const handleChipSortSelect = useCallback((value: string) => {
    const model = optionsRef.current.sortModel;
    if (model.isOption(value)) dispatch({ type: 'selectSortKey', sort: model.patchFor(value) });
  }, []);
  const resetSort = useCallback(
    () => dispatch({ type: 'setSort', sort: optionsRef.current.sortModel.defaultSort }),
    [],
  );

  // The name: a typed term waits out the debounce; clearing it does not.
  const nameTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelPendingName = useCallback(() => {
    if (nameTimerRef.current) clearTimeout(nameTimerRef.current);
    nameTimerRef.current = null;
  }, []);
  useEffect(() => cancelPendingName, [cancelPendingName]);
  const handleNameChange = useCallback(
    (text: string) => {
      cancelPendingName();
      const nextName = normalizeSearchName(text);
      if (nextName === '') {
        dispatch({ type: 'setName', name: '' });
        return;
      }
      nameTimerRef.current = setTimeout(() => {
        nameTimerRef.current = null;
        dispatch({ type: 'setName', name: nextName });
      }, NAME_DEBOUNCE_MS);
    },
    [cancelPendingName],
  );
  const handleClearName = useCallback(() => {
    cancelPendingName();
    dispatch({ type: 'setName', name: '' });
  }, [cancelPendingName]);

  const clearFilters = useCallback(() => {
    cancelPendingName();
    dispatch({ type: 'clearFilters' });
  }, [cancelPendingName]);
  const resetToDefault = useCallback(() => {
    cancelPendingName();
    dispatch({ type: 'resetToDefault' });
  }, [cancelPendingName]);
  const pauseView = useCallback(() => {
    cancelPendingName();
    dispatch({ type: 'pauseView' });
  }, [cancelPendingName]);
  const resumeView = useCallback(() => dispatch({ type: 'resumeView' }), []);

  // --- Remembered sort -------------------------------------------------------
  // After the climber settles on a sort (a chip, the sheet, a token, Reset). A
  // paused view is not a choice, and resuming puts back the sort already stored.
  const committedSortKeyRef = useRef(`${initialSort.sortBy}|${initialSort.sortOrder}`);
  useEffect(() => {
    if (session.pausedSort) return;
    const sortKey = `${session.sort.sortBy}|${session.sort.sortOrder}`;
    if (sortKey === committedSortKeyRef.current) return;
    committedSortKeyRef.current = sortKey;
    optionsRef.current.onSortCommit?.(session.sort);
  }, [session.sort, session.pausedSort]);

  // --- Sheet session ---------------------------------------------------------
  // The sort and "Fits my board" ride in the live selection, so with the sheet
  // open they wait out the same debounce as the filters: a filter tap then a
  // sort tap (or Reset, which changes both) is one request, not two.
  const liveSelection = useMemo(
    () => ({ filters, boardFilters, sort: session.sort, boardFit }),
    [filters, boardFilters, session.sort, boardFit],
  );
  const replaceSelection = useCallback(
    (nextFilters: ClimbFilters, nextBoardFilters: ClimbBoardFilterState) =>
      dispatch({ type: 'replaceSelection', filters: nextFilters, boardFilters: nextBoardFilters }),
    [],
  );
  const {
    showFilters,
    openFilters: openLiveFilters,
    hideFilters,
    closeFilters,
    onSelectionChange: handleSheetSelectionChange,
    runWhileOpen,
    querySelection: debouncedSelection,
  } = useLiveClimbFilters({ scopeKey, selection: liveSelection, onSelectionChange: replaceSelection, onDismiss: noop });

  // Grade rail: a row under the chips, or a popover on a regular-width iPad. An
  // open popover stays one until dismissed, even if the window narrows.
  const { isPad, widthClass } = useDeviceLayout();
  const isRegularWidthPad = isPad && widthClass === 'regular';
  const isRegularWidthPadRef = useRef(isRegularWidthPad);
  isRegularWidthPadRef.current = isRegularWidthPad;
  const [gradeRowShown, setGradeRowShown] = useState(false);
  const [gradePopoverOpen, setGradePopoverOpen] = useState(false);
  const gradeUsesPopover = gradePopoverOpen || isRegularWidthPad;
  const gradeUsesPopoverRef = useRef(gradeUsesPopover);
  gradeUsesPopoverRef.current = gradeUsesPopover;

  const openFilters = useCallback(() => {
    if (disabledRef.current) return;
    setGradePopoverOpen(false);
    openLiveFilters();
  }, [openLiveFilters]);
  const handleOpenGrade = useCallback(() => {
    if (isRegularWidthPadRef.current) {
      hideFilters();
      setGradePopoverOpen(true);
      return;
    }
    setGradeRowShown(true);
  }, [hideFilters]);
  const handleCloseGrade = useCallback(() => {
    if (gradeUsesPopoverRef.current) {
      setGradePopoverOpen(false);
      return;
    }
    setGradeRowShown(false);
  }, []);

  // Edit mode (or anything else that disables the list) shuts the sheet and the popover.
  useEffect(() => {
    if (!disabled) return;
    hideFilters();
    setGradePopoverOpen(false);
  }, [disabled, hideFilters]);

  const querySelection = useMemo<ClimbFilterSessionSelection<K>>(
    () => ({ ...debouncedSelection, name: session.name }),
    [debouncedSelection, session.name],
  );

  // --- Counts ----------------------------------------------------------------
  const hasName = session.name.trim().length > 0;
  const activeFilterCount =
    countActiveFilters(filters, boardFilters, defaultFilters) + (boardFit ? 1 : 0) + (hasName ? 1 : 0);
  const { defaultSort } = sortModel;
  const sortActive = session.sort.sortBy !== defaultSort.sortBy || session.sort.sortOrder !== defaultSort.sortOrder;

  // --- Grades ----------------------------------------------------------------
  const { data: gradesData } = useGrades(gradeBoardName);
  const grades = useMemo(() => gradesData ?? [], [gradesData]);
  const { formatGradeByDifficultyId, gradeFormat } = useGradeFormat();
  const formatBoardGradeByDifficultyId = useCallback(
    (difficultyId: number | null | undefined) => formatGradeByDifficultyId(difficultyId, gradeBoardName),
    [formatGradeByDifficultyId, gradeBoardName],
  );
  const gradeStops = useMemo(
    () => buildGradeRailStops(grades, gradeFormat, gradeBoardName),
    [grades, gradeFormat, gradeBoardName],
  );
  const { lastUsedGrade } = useLastUsedGrade();
  const gradeBound = useMemo<GradeBound>(
    () => ({ minGradeId: filters.minGrade, maxGradeId: filters.maxGrade }),
    [filters.minGrade, filters.maxGrade],
  );
  const gradeRail = useMemo(
    () =>
      gradeRowShown && !gradeUsesPopover ? (
        <GradeRangeRail
          grades={grades}
          bound={gradeBound}
          lastUsedGradeId={lastUsedGrade}
          boardName={gradeBoardName}
          onChange={handleGradeChange}
        />
      ) : null,
    [gradeRowShown, gradeUsesPopover, grades, gradeBound, lastUsedGrade, gradeBoardName, handleGradeChange],
  );
  const gradePopoverContent = useMemo(
    () =>
      gradeUsesPopover ? (
        <GradeRangeRail
          grades={grades}
          bound={gradeBound}
          lastUsedGradeId={lastUsedGrade}
          boardName={gradeBoardName}
          onChange={handleGradeChange}
        />
      ) : undefined,
    [gradeUsesPopover, grades, gradeBound, lastUsedGrade, gradeBoardName, handleGradeChange],
  );

  // --- Sort labels and controls ----------------------------------------------
  const sortLabels = sortModel.useLabels();
  const sortLabel = sortActive
    ? sortModel.hasDirection(session.sort.sortBy)
      ? sortLabels.directionLabel(session.sort.sortBy, session.sort.sortOrder)
      : sortLabels.keyLabel(session.sort.sortBy)
    : sortLabels.resting;
  const chipSortOptions = useMemo(
    () => sortModel.options.map((sortBy) => ({ value: sortBy, label: sortLabels.keyLabel(sortBy) })),
    [sortModel, sortLabels],
  );
  const chipSortControl = useMemo<FilterChipSortControl>(
    () => ({
      label: sortLabel,
      active: sortActive,
      options: chipSortOptions,
      selected: session.sort.sortBy,
      onSelect: handleChipSortSelect,
    }),
    [sortLabel, sortActive, chipSortOptions, session.sort.sortBy, handleChipSortSelect],
  );

  // --- Tokens ----------------------------------------------------------------
  const { pinned: storedPins, isPinned, togglePin } = pinStore.usePinnedChips();
  // A chip whose control needs an active board stays pinned, but leaves the row
  // while there is none (its filter is dropped above).
  // The climb-type chip leaves a spray wall's row too: it has nothing to offer.
  const pinned = useMemo(() => {
    const hiddenKinds = new Set<FilterChipKind>(activeBoardAvailable ? [] : activeBoardOnlyChips);
    if (isSprayWall) hiddenKinds.add('climbType');
    return hiddenKinds.size === 0 ? storedPins : storedPins.filter((kind) => !hiddenKinds.has(kind));
  }, [activeBoardAvailable, storedPins, activeBoardOnlyChips, isSprayWall]);
  const filterTokens = useMemo(
    () =>
      getActiveFilterTokens({
        filters,
        boardFilters,
        grades: gradesData,
        t,
        formatGradeByDifficultyId: formatBoardGradeByDifficultyId,
        gradeStops,
        patchFilters,
        patchBoardFilters,
        setGrade,
        defaults: defaultFilters,
      }),
    [
      filters,
      boardFilters,
      gradesData,
      t,
      formatBoardGradeByDifficultyId,
      gradeStops,
      patchFilters,
      patchBoardFilters,
      setGrade,
      defaultFilters,
    ],
  );
  const gradeToken = filterTokens.find((filterToken) => filterToken.key === 'grade');
  const gradeLabel = gradeToken?.label ?? t('mobile.filter.grade');
  const gradeActive = gradeToken != null;
  // The receipt row: a filter a pinned chip shows is left out, so nothing is
  // worded twice. The name has no chip, so it always gets a token here (there is
  // no search field on these screens to show it); "Fits my board" and the sort
  // get one while their chips are unpinned.
  const tokens = useMemo(() => {
    const chipBackedTokenKeys = new Set<string>(pinned.flatMap((kind) => chipKindToTokenKeys(kind)));
    const receipt: FilterToken[] = [];
    if (hasName) {
      receipt.push({
        key: 'name',
        label: t('mobile.filter.nameToken', { name: session.name }),
        clear: handleClearName,
      });
    }
    for (const filterToken of filterTokens) {
      if (!chipBackedTokenKeys.has(filterToken.key)) receipt.push(filterToken);
    }
    if (boardFit && !chipBackedTokenKeys.has('boardFit')) {
      receipt.push({ key: 'boardFit', label: t('mobile.filter.boardFit.label'), clear: handleToggleBoardFit });
    }
    if (sortActive && !chipBackedTokenKeys.has('sort')) {
      receipt.push({ key: 'sort', label: sortLabel, clear: resetSort });
    }
    return receipt;
  }, [
    pinned,
    hasName,
    t,
    session.name,
    handleClearName,
    filterTokens,
    boardFit,
    handleToggleBoardFit,
    sortActive,
    sortLabel,
    resetSort,
  ]);

  // --- Chip row --------------------------------------------------------------
  const chipBoardFit = useMemo(
    () => (activeBoardAvailable ? { active: boardFit, onToggle: handleToggleBoardFit } : undefined),
    [activeBoardAvailable, boardFit, handleToggleBoardFit],
  );
  const gradeRailOpen = gradeUsesPopover ? gradePopoverOpen : gradeRowShown;
  const progress = flagsToProgress(filters);
  const collection = getCollectionFilter(filters, boardFilters);
  const climbType = getClimbTypeFilter(filters, defaultFilters);
  const defaultClimbType = getClimbTypeFilter(defaultFilters, defaultFilters);
  const accuracyValue = filters.gradeAccuracy ?? 'off';
  const betaActive = !!filters.onlyWithBetaVideos;
  const chipRowProps = useMemo<FilterChipRowProps>(
    () => ({
      pinnedChips: pinned,
      activeFilterCount,
      onOpenFilters: openFilters,
      gradeLabel,
      gradeActive,
      onOpenGrade: handleOpenGrade,
      gradeRailOpen,
      onCloseGrade: handleCloseGrade,
      gradePopoverContent,
      dimensionChips: NO_DIMENSION_CHIPS,
      minAscents: filters.minAscents,
      onChangePopularity: handleChangePopularity,
      minRating: filters.minRating,
      onChangeRating: handleChangeRating,
      progress,
      onChangeProgress: handleChangeProgress,
      canFilterProgress: isAuthenticated,
      collection,
      onChangeCollection: handleChangeCollection,
      canFilterPersonalCollections: isAuthenticated,
      isSprayWall,
      sortControl: chipSortControl,
      accuracyValue,
      onChangeAccuracy: handleChangeAccuracy,
      climbType,
      onChangeClimbType: handleChangeClimbType,
      defaultClimbType,
      betaActive,
      onToggleBeta: handleToggleBeta,
      boardFit: chipBoardFit,
      showAngle: false,
    }),
    [
      pinned,
      activeFilterCount,
      openFilters,
      gradeLabel,
      gradeActive,
      handleOpenGrade,
      gradeRailOpen,
      handleCloseGrade,
      gradePopoverContent,
      filters.minAscents,
      handleChangePopularity,
      filters.minRating,
      handleChangeRating,
      progress,
      handleChangeProgress,
      isAuthenticated,
      collection,
      handleChangeCollection,
      isSprayWall,
      chipSortControl,
      accuracyValue,
      handleChangeAccuracy,
      climbType,
      handleChangeClimbType,
      defaultClimbType,
      betaActive,
      handleToggleBeta,
      chipBoardFit,
    ],
  );

  // --- Sheet props -----------------------------------------------------------
  const sheetPins = useMemo<ClimbFilterSheetPins>(() => {
    const isListKind = (kind: FilterChipKind): kind is P => (pinnable as readonly FilterChipKind[]).includes(kind);
    return {
      isPinned: (kind: FilterChipKind) => isListKind(kind) && isPinned(kind),
      togglePin: (kind: FilterChipKind) => {
        if (isListKind(kind)) togglePin(kind);
      },
      pinnable,
    };
  }, [pinnable, isPinned, togglePin]);
  const sheetSortControl = useMemo<FilterSortControl>(() => {
    const { sortBy, sortOrder } = session.sort;
    const openingOrder = sortModel.defaultOrder(sortBy);
    const otherOrder: SortOrder = openingOrder === 'asc' ? 'desc' : 'asc';
    return {
      options: sortModel.options.map((option) => ({ key: option, label: sortLabels.keyLabel(option) })),
      selected: sortBy,
      active: sortActive,
      orderOptions: sortModel.hasDirection(sortBy)
        ? [
            { key: openingOrder, label: sortLabels.directionLabel(sortBy, openingOrder) },
            { key: otherOrder, label: sortLabels.directionLabel(sortBy, otherOrder) },
          ]
        : null,
      order: sortOrder,
      showReshuffle: sortModel.isShuffle(sortBy),
      onSelect: (key: string) =>
        runWhileOpen(() => {
          if (sortModel.isOption(key)) dispatch({ type: 'selectSortKey', sort: sortModel.patchFor(key) });
        }),
      onOrderChange: (order: SortOrder) => runWhileOpen(() => dispatch({ type: 'setSortOrder', sortOrder: order })),
      onReshuffle: () => runWhileOpen(() => dispatch({ type: 'reshuffle', sortSeed: newSortSeed() })),
    };
  }, [session.sort, sortModel, sortLabels, sortActive, runWhileOpen]);
  const sheetBoardFit = useMemo<ClimbFilterSheetBoardFit | undefined>(
    () =>
      activeBoardAvailable
        ? {
            value: boardFit,
            onChange: (value: boolean) => runWhileOpen(() => dispatch({ type: 'setBoardFit', boardFit: value })),
          }
        : undefined,
    [activeBoardAvailable, boardFit, runWhileOpen],
  );
  const sheetLiveCount = useMemo(() => ({ count: liveCount }), [liveCount]);
  const sheetProps = useMemo<ClimbFilterSheetProps | null>(
    () =>
      showFilters
        ? {
            onDismiss: closeFilters,
            boardConfig,
            currentFilters: filters,
            currentBoardFilters: boardFilters,
            searchName: session.name,
            lastUsedGradeId: lastUsedGrade,
            onSelectionChange: handleSheetSelectionChange,
            onNameChange: handleNameChange,
            onClearName: handleClearName,
            pins: sheetPins,
            sections,
            liveCount: sheetLiveCount,
            defaultFilters,
            onReset: resetToDefault,
            sortControl: sheetSortControl,
            boardFit: sheetBoardFit,
            gradeBoardName,
            namePlaceholder,
          }
        : null,
    [
      showFilters,
      closeFilters,
      boardConfig,
      filters,
      boardFilters,
      session.name,
      lastUsedGrade,
      handleSheetSelectionChange,
      handleNameChange,
      handleClearName,
      sheetPins,
      sections,
      sheetLiveCount,
      defaultFilters,
      resetToDefault,
      sheetSortControl,
      sheetBoardFit,
      gradeBoardName,
      namePlaceholder,
    ],
  );

  const state = useMemo<ClimbFilterSessionView<K>>(
    () => ({
      querySelection,
      activeFilterCount,
      chipRowProps,
      tokens,
      gradeRail,
      sheetProps,
    }),
    [querySelection, activeFilterCount, chipRowProps, tokens, gradeRail, sheetProps],
  );
  const actions = useMemo<ClimbFilterSessionActions>(
    () => ({ openFilters, clearFilters, resetToDefault, pauseView, resumeView }),
    [openFilters, clearFilters, resetToDefault, pauseView, resumeView],
  );
  return { state, actions };
}
