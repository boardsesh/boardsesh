import { useCallback, useMemo, useState, type ReactNode } from 'react';
import type { BoardName } from '@boardsesh/shared-schema';
import { HeatmapOverlay, useHeatLayer } from '../../board/HeatmapOverlay';
import type { HeatLegend, HeatmapMode } from '../../board/heatmap-buckets';
import type { CreateBoardHolds } from '../../../lib/create-board-holds';
import { useHoldHeatmap } from '../../../lib/graphql/hooks/use-hold-heatmap';
import { useCatalogQuerySourceState, type CatalogQuerySource } from '../../../lib/offline/use-catalog-query-source';
import { isOfflineSearchSupported } from '../../../db/queries/search-climbs-local';
import {
  heatmapSearchInput,
  isHeatmapSearchFiltered,
  withoutHoldPicks,
  type HeatmapSearch,
} from './heatmap-search-input';

export type HoldFilterHeatmapBoard = {
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
  /** The screen's own hold geometry, so a spray wall that arrives late is picked up once. */
  holds: CreateBoardHolds | null;
};

export type HoldFilterHeatmap = {
  enabled: boolean;
  toggle: () => void;
  mode: HeatmapMode;
  setMode: (mode: HeatmapMode) => void;
  /** The filter sheet's draft (minus its hold picks) the heatmap follows, or null for the whole board. */
  search: HeatmapSearch | null;
  /** A filtered search exists and the climber switched it off. */
  wholeBoard: boolean;
  toggleWholeBoard: () => void;
  source: CatalogQuerySource;
  /** The source could still move off `download`; hold the offer back. */
  isResolving: boolean;
  /** The search needs a filter this phone cannot run. */
  filterUnsupported: boolean;
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
 * Everything the hold filter screen's heatmap needs, in one place so the screen
 * only wires it: the toggle and colour mode, which climbs to count, where the
 * answer comes from (`useCatalogQuerySource`), the ranked heat layer, and the
 * memoised overlay.
 *
 * `draft` is the filter sheet's search as it stood when the screen opened. Its
 * hold picks are dropped: they are what this screen edits, so the heat shows
 * where the climbs matching everything else go.
 */
export function useHoldFilterHeatmap(board: HoldFilterHeatmapBoard, draft: HeatmapSearch | null): HoldFilterHeatmap {
  const { boardName, layoutId, sizeId, setIds, angle, holds } = board;
  const [enabled, setEnabled] = useState(false);
  const [mode, setMode] = useState<HeatmapMode>('climbs');
  const [wholeBoard, setWholeBoard] = useState(false);

  const search = useMemo(() => {
    const withoutPicks = draft ? withoutHoldPicks(draft) : null;
    return isHeatmapSearchFiltered(withoutPicks) ? withoutPicks : null;
  }, [draft]);
  const listInput = useMemo(
    () => heatmapSearchInput({ boardName, layoutId, sizeId, setIds, angle }, search && !wholeBoard ? search : null),
    [boardName, layoutId, sizeId, setIds, angle, search, wholeBoard],
  );

  const scope = useMemo(() => ({ boardName, layoutId, sizeId }), [boardName, layoutId, sizeId]);
  const { source, isResolving } = useCatalogQuerySourceState(scope);
  // Only the phone is limited; the admin resolver runs every filter.
  const filterUnsupported = useMemo(
    () => source === 'local' && !isOfflineSearchSupported(listInput),
    [source, listInput],
  );

  const heatmap = useHoldHeatmap(listInput, source, enabled && !isResolving && !filterUnsupported, {
    withStats: mode === 'grade',
  });

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

  const isBusy = enabled && (isResolving || heatmap.isFetching);
  const isUnavailable = enabled && heatmap.isUnavailable;
  const isEmpty = enabled && heatmap.isSuccess && !heatmap.isUnavailable && heatmap.holdStats.length === 0;
  // One object per real change, so the memoised panel skips the screen's
  // unrelated re-renders (every hold tap).
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
