import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { BoardName } from '@boardsesh/shared-schema';
import { HeatmapOverlay, useHeatLayer } from '../../board/HeatmapOverlay';
import type { HeatLegend, HeatmapMode } from '../../board/heatmap-buckets';
import { getCreateBoardHolds, parseSetIdsParam } from '../../../lib/create-board-holds';
import { getLastSearch } from '../../../lib/last-search-store';
import { useHoldHeatmap } from '../../../lib/graphql/hooks/use-hold-heatmap';
import { useCatalogQuerySourceState, type CatalogQuerySource } from '../../../lib/offline/use-catalog-query-source';
import { useAuth } from '../../../providers/auth-provider';
import {
  heatmapSearchInput,
  isHeatmapSearchFiltered,
  localHeatmapInput,
  type HeatmapSearch,
} from './heatmap-search-input';

export type PlayDrawerHeatmapBoard = {
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
};

export type PlayDrawerHeatmap = {
  enabled: boolean;
  toggle: () => void;
  mode: HeatmapMode;
  setMode: (mode: HeatmapMode) => void;
  /** The saved list search the heatmap is following, or null for the whole board. */
  search: HeatmapSearch | null;
  /** A filtered search exists and the climber switched it off. */
  wholeBoard: boolean;
  toggleWholeBoard: () => void;
  source: CatalogQuerySource;
  /** The source could still move off `download`; hold the offer back. */
  isResolving: boolean;
  /** The saved search needs a filter this phone cannot run even without its hold picks. */
  filterUnsupported: boolean;
  /** The phone dropped the search's hold-state picks and drew the rest. */
  holdPicksSkipped: boolean;
  isBusy: boolean;
  isError: boolean;
  /** The query answered with no holds at all. */
  isEmpty: boolean;
  /** The phone could not answer (the local-only fallback), which is not "no climbs". */
  isUnavailable: boolean;
  /** How many climbs the colours count, or null when the answer has no count (admin network). */
  climbCount: number | null;
  /** What the legend says about the colours on screen. */
  legend: HeatLegend;
  /** For the current board's `underOverlay` slot; null while there is nothing to draw. */
  overlay: ReactNode;
};

/**
 * Everything the play drawer's hold heatmap needs, in one place so the drawer
 * only wires it: the toggle and colour mode, the climb list's saved search for
 * this board config (the drawer has no search provider of its own), where the
 * answer comes from (`useCatalogQuerySource`), the ranked heat layer, and the
 * memoised overlay.
 *
 * The saved search is re-read each time the heatmap is switched on or the
 * board changes, so a filter set in the list since the last look is picked up.
 */
export function usePlayDrawerHeatmap(board: PlayDrawerHeatmapBoard): PlayDrawerHeatmap {
  const { boardName, layoutId, sizeId, setIds, angle } = board;
  const { isAuthenticated } = useAuth();
  const [enabled, setEnabled] = useState(false);
  const [mode, setMode] = useState<HeatmapMode>('climbs');
  const [wholeBoard, setWholeBoard] = useState(false);
  // undefined while the read is in flight, so the query waits for the filters
  // rather than running once unfiltered and again filtered.
  const [savedSearch, setSavedSearch] = useState<HeatmapSearch | null | undefined>(undefined);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setSavedSearch(undefined);
    getLastSearch({ boardName, layoutId, sizeId, setIds, angle }, { isAuthenticated })
      .then((entry) => {
        if (!cancelled) setSavedSearch(entry);
      })
      .catch(() => {
        if (!cancelled) setSavedSearch(null);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, boardName, layoutId, sizeId, setIds, angle, isAuthenticated]);

  const search = isHeatmapSearchFiltered(savedSearch) ? savedSearch : null;
  const listInput = useMemo(
    () => heatmapSearchInput({ boardName, layoutId, sizeId, setIds, angle }, search && !wholeBoard ? search : null),
    [boardName, layoutId, sizeId, setIds, angle, search, wholeBoard],
  );

  const scope = useMemo(() => ({ boardName, layoutId, sizeId }), [boardName, layoutId, sizeId]);
  const { source, isResolving } = useCatalogQuerySourceState(scope);
  // Only the phone is limited; the admin resolver runs every filter.
  const local = useMemo(
    () =>
      source === 'local'
        ? localHeatmapInput(listInput)
        : { input: listInput, holdPicksSkipped: false, unsupported: false },
    [source, listInput],
  );
  const filterUnsupported = local.unsupported;

  const heatmap = useHoldHeatmap(
    local.input,
    source,
    enabled && savedSearch !== undefined && !isResolving && !filterUnsupported,
    { withStats: mode === 'grade' },
  );

  const holds = useMemo(
    () => getCreateBoardHolds({ boardName, layoutId, sizeId, setIds: parseSetIdsParam(setIds) }),
    [boardName, layoutId, sizeId, setIds],
  );
  const layer = useHeatLayer({ statsByHoldId: heatmap.statsByHoldId, holdTargets: holds?.holdTargets, metric: mode });

  const showOverlay = enabled && source !== 'download' && !filterUnsupported && holds !== null;
  const overlay = useMemo(
    () =>
      showOverlay && holds ? (
        <HeatmapOverlay
          layer={layer}
          boardName={boardName}
          layoutId={layoutId}
          sizeId={sizeId}
          setIds={setIds}
          holdTargets={holds.holdTargets}
          boardWidth={holds.boardWidth}
          boardHeight={holds.boardHeight}
        />
      ) : null,
    [showOverlay, holds, layer, boardName, layoutId, sizeId, setIds],
  );

  const toggle = useCallback(() => setEnabled((previous) => !previous), []);
  const toggleWholeBoard = useCallback(() => setWholeBoard((previous) => !previous), []);

  const isBusy = enabled && (savedSearch === undefined || isResolving || heatmap.isFetching);
  const isUnavailable = enabled && heatmap.isUnavailable;
  const isEmpty = enabled && heatmap.isSuccess && !heatmap.isUnavailable && heatmap.holdStats.length === 0;
  // One object per real change, so the memoised panel and action bar skip the
  // drawer's unrelated re-renders.
  return useMemo(
    () => ({
      enabled,
      toggle,
      mode,
      setMode,
      search,
      wholeBoard,
      toggleWholeBoard,
      source,
      isResolving,
      filterUnsupported,
      holdPicksSkipped: local.holdPicksSkipped,
      isBusy,
      isError: heatmap.isError,
      isEmpty,
      isUnavailable,
      climbCount: heatmap.climbCount,
      legend: layer.legend,
      overlay,
    }),
    [
      enabled,
      toggle,
      mode,
      search,
      wholeBoard,
      toggleWholeBoard,
      source,
      isResolving,
      filterUnsupported,
      local.holdPicksSkipped,
      isBusy,
      heatmap.isError,
      isEmpty,
      isUnavailable,
      heatmap.climbCount,
      layer.legend,
      overlay,
    ],
  );
}
