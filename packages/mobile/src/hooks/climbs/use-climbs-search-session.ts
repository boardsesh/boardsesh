import { useTabReselect } from '../../hooks/use-tab-reselect';
import { useLiveClimbFilters, type ClimbFilterSelection } from '../../hooks/use-live-climb-filters';
import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { Keyboard } from 'react-native';
import { useTranslation } from 'react-i18next';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import {
  countActiveFilters,
  normalizeRetiredFilters,
  DEFAULT_CLIMB_FILTER_STATE,
  DEFAULT_CLIMB_BOARD_FILTER_STATE,
  type ClimbBoardFilterState,
} from '@boardsesh/climb-filters';
import { hasActiveFilters, type ClimbFilters } from '../../components/ClimbFilterSheet';
import { buildGradeRailStops } from '../../lib/grade-stops';
import { useClimbSearch } from '../../providers/climb-search-provider';
import { useSetting } from '../../settings';
import { useGrades } from '../../lib/graphql/hooks';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { useLastUsedGrade } from '../../hooks/use-last-used-grade';
import { useAuth } from '../../providers/auth-provider';
import {
  getRecentFilters,
  addRecentFilter,
  clearRecentFilters,
  type RecentFilter,
} from '../../lib/recent-filter-store';
import { boardConfigKey } from '../../lib/last-search-store';
import { getFilterSummary } from '../../lib/filter-summary';
import { filtersForBoard, statusForAuth } from '../../lib/climb-filter-types';
import { track } from '../../lib/analytics';
import type { BoardSearchConfig } from '@boardsesh/climb-filters';
import { usePersistedClimbSearch } from './use-persisted-climb-search';
import { useDebouncedSearchName } from '../use-debounced-search-name';
import { useGradeDisclosure } from '../use-grade-disclosure';

type ClimbFiltersOpenSource = 'tab_reselect' | 'filters_chip' | 'empty_recovery';

export function useClimbsSearchSession(boardConfig: BoardSearchConfig | null) {
  const { t } = useTranslation('climbs');
  const { isAuthenticated } = useAuth();
  const { filters, boardFilters, name, setGrade, setName, replaceSearch, patchFilters, patchBoardFilters } =
    useClimbSearch();
  const boardName = boardConfig?.boardName ?? '';
  const boardKey = boardConfig ? boardConfigKey(boardConfig) : null;
  const filterScopeKey = boardKey === null ? null : `${boardKey}|${isAuthenticated}`;
  const filterScopeRef = useRef(filterScopeKey);
  filterScopeRef.current = filterScopeKey;
  const { lastUsedGrade, rememberGrade } = useLastUsedGrade();
  const { data: gradesData } = useGrades(boardName);
  const grades = useMemo(() => gradesData ?? [], [gradesData]);
  const { formatGradeByDifficultyId, gradeFormat } = useGradeFormat();
  const formatBoardGradeByDifficultyId = useCallback(
    (difficultyId: number | null | undefined) => formatGradeByDifficultyId(difficultyId, boardName),
    [formatGradeByDifficultyId, boardName],
  );
  // The grade row's chips. The filter token and the recent pill name a grade by
  // these, the way the chip does (one "V0" for 4a to 4c under V grades), so one
  // pick is never spelled two ways (#5960).
  const gradeStops = useMemo(
    () => buildGradeRailStops(grades, gradeFormat, boardName),
    [grades, gradeFormat, boardName],
  );
  const searchReady = usePersistedClimbSearch({
    boardConfig,
    isAuthenticated,
    filters,
    boardFilters,
    name,
    replaceSearch,
  });
  const searchName = useDebouncedSearchName({ scopeKey: filterScopeKey, name, onCommit: setName });
  const [recentFilters, setRecentFilters] = useState<RecentFilter[]>([]);
  const filtersOpenSourceRef = useRef<ClimbFiltersOpenSource>('filters_chip');
  useEffect(() => {
    let cancelled = false;
    getRecentFilters({ isAuthenticated })
      .then((recent) => {
        if (!cancelled) setRecentFilters(recent);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated]);

  const normalizedFilters = useMemo(
    () => statusForAuth(normalizeRetiredFilters(filters), isAuthenticated),
    [filters, isAuthenticated],
  );
  const filterSelection = useMemo(
    () => ({ filters: normalizedFilters, boardFilters }),
    [normalizedFilters, boardFilters],
  );
  const handleFilterSelectionChange = useCallback(
    (nextFilters: ClimbFilters, nextBoardFilters: ClimbBoardFilterState) => {
      replaceSearch(
        statusForAuth(normalizeRetiredFilters(nextFilters), isAuthenticated),
        searchName.readCommitted(),
        nextBoardFilters,
      );
    },
    [replaceSearch, isAuthenticated, searchName],
  );
  const finishFilterSession = useCallback(
    (finalSelection: ClimbFilterSelection) => {
      const finalScope = filterScopeRef.current;
      const finalName = searchName.flush();
      replaceSearch(finalSelection.filters, finalName, finalSelection.boardFilters);
      track(SHARED_EVENTS.ClimbFiltersClosed, {
        source: filtersOpenSourceRef.current,
        activeFilterCount: countActiveFilters(finalSelection.filters, finalSelection.boardFilters),
        hasName: finalName.length > 0,
      });
      if (hasActiveFilters(finalSelection.filters) || finalName.length > 0) {
        const label = getFilterSummary(finalSelection.filters, finalName, grades, t, gradeStops);
        addRecentFilter(label, finalSelection.filters, finalName)
          .then(() => getRecentFilters({ isAuthenticated }))
          .then((recent) => {
            if (filterScopeRef.current === finalScope) setRecentFilters(recent);
          })
          .catch(() => {});
      }
    },
    [searchName, replaceSearch, grades, t, gradeStops, isAuthenticated],
  );
  const {
    showFilters,
    openFilters,
    hideFilters,
    runWhileOpen,
    closeFilters: handleDismissFilters,
    onSelectionChange: handleLiveFilterSelectionChange,
    querySelection: { filters: queryFilters, boardFilters: queryBoardFilters },
  } = useLiveClimbFilters({
    scopeKey: filterScopeKey,
    selection: filterSelection,
    onSelectionChange: handleFilterSelectionChange,
    onDismiss: finishFilterSession,
  });
  const [gradeRowShown, setGradeRowShown] = useSetting('gradeRowShown');
  const changeGradeRowShown = useCallback(
    (shown: boolean) => {
      setGradeRowShown(shown);
      track(SHARED_EVENTS.GradeRowToggled, { shown });
    },
    [setGradeRowShown],
  );
  const {
    usesPopover: gradeUsesPopover,
    popoverOpen: gradePopoverOpen,
    open: handleOpenGrade,
    close: handleCloseGrade,
    dismissPopover: handleDismissGradePopover,
  } = useGradeDisclosure({
    rowShown: gradeRowShown,
    onRowShownChange: changeGradeRowShown,
    beforeOpenPopover: hideFilters,
  });
  const handleSheetNameChange = useCallback(
    (text: string) => runWhileOpen(() => searchName.schedule(text)),
    [runWhileOpen, searchName],
  );
  const handleClearName = searchName.clear;
  const handleSheetClearName = useCallback(() => runWhileOpen(handleClearName), [runWhileOpen, handleClearName]);
  const readyRef = useRef(searchReady);
  readyRef.current = searchReady;
  const openFiltersFrom = useCallback(
    (source: ClimbFiltersOpenSource) => {
      if (!readyRef.current) return;
      handleDismissGradePopover();
      if (!openFilters()) return;
      filtersOpenSourceRef.current = source;
      track(SHARED_EVENTS.ClimbFiltersOpened, {
        source,
        activeFilterCount: countActiveFilters(normalizedFilters, boardFilters),
        hasName: name.length > 0,
      });
    },
    [handleDismissGradePopover, openFilters, normalizedFilters, boardFilters, name],
  );
  const handleOpenFilters = useCallback(() => openFiltersFrom('filters_chip'), [openFiltersFrom]);
  const handleOpenFiltersFromEmpty = useCallback(() => openFiltersFrom('empty_recovery'), [openFiltersFrom]);
  const handleTabReselect = useCallback(() => openFiltersFrom('tab_reselect'), [openFiltersFrom]);
  useTabReselect(handleTabReselect);
  const handleApplyRecentFilter = useCallback(
    (pillFilters: ClimbFilters, pillSearchText: string) => {
      searchName.replace(pillSearchText);
      replaceSearch(filtersForBoard(statusForAuth(pillFilters, isAuthenticated), boardName), pillSearchText);
      Keyboard.dismiss();
    },
    [searchName, replaceSearch, isAuthenticated, boardName],
  );
  const handleClearRecentFilters = useCallback(() => {
    clearRecentFilters()
      .then(() => setRecentFilters([]))
      .catch(() => {});
  }, []);

  // Material filter-summary chip clears the non-grade refinements (the dedicated
  // grade chip owns the grade), keeping the typed name query. The glass variant
  // has no chrome clear-all — it clears via the filter sheet's Reset.
  const handleClearNonGradeFilters = useCallback(() => {
    replaceSearch(
      {
        ...DEFAULT_CLIMB_FILTER_STATE,
        minGrade: filters.minGrade,
        maxGrade: filters.maxGrade,
      },
      name,
      DEFAULT_CLIMB_BOARD_FILTER_STATE,
    );
  }, [replaceSearch, name, filters.minGrade, filters.maxGrade]);

  // Remember the grade the climber filters by (from any path — the chip rail,
  // the filter sheet's Apply, tokens, recent pills, per-board restore) so the
  // rail can open centred on it later. Skips clears (undefined) so clearing
  // keeps the last real grade in memory rather than forgetting it.
  useEffect(() => {
    const focusGrade = filters.minGrade ?? filters.maxGrade;
    if (focusGrade != null) rememberGrade(focusGrade);
  }, [filters.minGrade, filters.maxGrade, rememberGrade]);
  return {
    filters,
    boardFilters,
    name,
    setGrade,
    patchFilters,
    patchBoardFilters,
    isAuthenticated,
    filterScopeKey,
    searchReady,
    queryFilters,
    queryBoardFilters,
    grades,
    gradeStops,
    gradeFormat,
    formatBoardGradeByDifficultyId,
    lastUsedGrade,
    showFilters,
    handleDismissFilters,
    handleLiveFilterSelectionChange,
    handleSheetNameChange,
    handleClearName,
    handleSheetClearName,
    handleOpenFilters,
    handleOpenFiltersFromEmpty,
    recentFilters,
    handleApplyRecentFilter,
    handleClearRecentFilters,
    handleClearNonGradeFilters,
    gradeRowShown,
    gradeUsesPopover,
    gradePopoverOpen,
    handleOpenGrade,
    handleCloseGrade,
    handleDismissGradePopover,
  };
}
