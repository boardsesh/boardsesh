'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import { track } from '@/app/lib/analytics';
import MuiButton from '@mui/material/Button';
import MuiTypography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import MuiTooltip from '@mui/material/Tooltip';
import LayersIcon from '@mui/icons-material/Layers';
import LayersOutlinedIcon from '@mui/icons-material/LayersOutlined';

import type {
  BoardDetails,
  HoldFilterEntry,
  HoldFilterMode,
  HoldFilterType,
  HoldsFilter,
  ZoneBox,
} from '@/app/lib/types';
import { useUISearchParams } from '@/app/components/queue-control/ui-searchparams-provider';
import { themeTokens } from '@/app/theme/theme-config';
import BoardRenderer from '../board-renderer/board-renderer';
import HoldTypePicker from '../create-climb/hold-type-picker';
import CreateClimbHeatmapOverlay from '../create-climb/create-climb-heatmap-overlay';
import {
  applyDrag,
  buildDefaultZone,
  computeHandleRadius,
  gridToSvg,
  isHoldInsideZone,
  svgToGrid,
  type BoardDimensions,
  type DragMode,
} from './climb-zone-math';
import { useSearchHoldPicker } from './use-search-hold-picker';
import SearchHoldFilterOverlay from './search-hold-filter-overlay';
import styles from './search-form.module.css';

type ClimbSearchFormProps = {
  boardDetails: BoardDetails;
};

// Angle is part of the URL but not the BoardDetails object, so the heatmap
// query needs to read it from the pathname (the second-to-last segment in
// the routes that mount this component).
const getAngleFromPath = (pathname: string): number => {
  const segments = pathname.split('/');
  const angle = Number(segments[segments.length - 2]);
  return Number.isFinite(angle) ? angle : 40;
};

const HANDLE_OPACITY = 0.95;
const ZONE_EXCLUSION_OPACITY = 0.42;
const RECT_STROKE_OPACITY = 0.9;

// Stable empty fallback so the ref-syncing effect doesn't re-run every
// render when the URL has no holds filter set.
const EMPTY_HOLDS_FILTER: HoldsFilter = Object.freeze({}) as HoldsFilter;

const ClimbSearchForm: React.FC<ClimbSearchFormProps> = ({ boardDetails }) => {
  const { t } = useTranslation('climbs');
  const { uiSearchParams, updateFilters } = useUISearchParams();
  const [showHeatmap, setShowHeatmap] = useState(false);
  const pathname = usePathname();
  const angle = useMemo(() => getAngleFromPath(pathname), [pathname]);

  // Shrink the click radii on the BoardRenderer so a tap lands on the visible
  // hold image rather than the generous setter-mode click circle. Same
  // rationale as the previous standalone hold form.
  const tightenedBoardDetails = useMemo(
    () => ({
      ...boardDetails,
      holdsData: boardDetails.holdsData.map((hold) => ({ ...hold, r: hold.r * 0.5 })),
    }),
    [boardDetails],
  );

  // holdsById is built from the original (non-tightened) holdsData because
  // we only need cx/cy here — the tightening shrinks `r`, not the position.
  // If we ever start adjusting cx/cy in tightenedBoardDetails, this lookup
  // must move to that array so the prune calculation stays in sync with
  // where the user actually tapped.
  const holdsById = useMemo(() => {
    const map = new Map<number, { cx: number; cy: number }>();
    for (const hold of boardDetails.holdsData) {
      map.set(hold.id, { cx: hold.cx, cy: hold.cy });
    }
    return map;
  }, [boardDetails.holdsData]);

  const { boardWidth, boardHeight, edge_left, edge_right, edge_bottom, edge_top } = boardDetails;
  const dims = useMemo<BoardDimensions>(
    () => ({
      boardWidth,
      boardHeight,
      edgeLeft: edge_left,
      edgeRight: edge_right,
      edgeBottom: edge_bottom,
      edgeTop: edge_top,
    }),
    [boardWidth, boardHeight, edge_left, edge_right, edge_bottom, edge_top],
  );

  const defaultZone = useMemo(() => buildDefaultZone(dims), [dims]);
  const handleRadius = useMemo(() => computeHandleRadius(dims), [dims]);
  const handleHitRadius = handleRadius * 2.25;

  // Local zone mirrors the URL param so dragging stays smooth without
  // hammering the search debounce on every pointermove.
  const [localZone, setLocalZone] = useState<ZoneBox | null>(uiSearchParams.zoneBox);
  useEffect(() => {
    setLocalZone(uiSearchParams.zoneBox);
  }, [uiSearchParams.zoneBox]);

  const zoneEnabled = localZone !== null;

  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragStateRef = useRef<{
    mode: DragMode;
    pointerId: number;
    startGridX: number;
    startGridY: number;
    startBox: ZoneBox;
    latestBox: ZoneBox;
  } | null>(null);

  const svgPointToGrid = useCallback(
    (clientX: number, clientY: number) => {
      const svg = svgRef.current;
      if (!svg) return null;
      const point = svg.createSVGPoint();
      point.x = clientX;
      point.y = clientY;
      const screenCtm = svg.getScreenCTM();
      if (!screenCtm) return null;
      const local = point.matrixTransform(screenCtm.inverse());
      return svgToGrid(local.x, local.y, dims);
    },
    [dims],
  );

  const holdsFilter: HoldsFilter = uiSearchParams.holdsFilter ?? EMPTY_HOLDS_FILTER;

  // Latest-known holdsFilter snapshot for prune calculations during a drag.
  // The tap-a-hold path calls `updateFilters({ holdsFilter })` which is
  // debounced 500 ms before reaching the URL — but `setUISearchParams`
  // updates the context synchronously, so reading the ref from `endDrag`
  // sees a hold added immediately before the user grabbed a corner. The
  // ref is also written synchronously inside `setHoldFilter`/`clearHold`
  // so a within-render update doesn't have to wait for React's commit.
  const holdsFilterRef = useRef<HoldsFilter>(holdsFilter);
  useEffect(() => {
    holdsFilterRef.current = holdsFilter;
  }, [holdsFilter]);

  const setHoldFilter = useCallback(
    (holdId: number, type: HoldFilterType, nextMode: HoldFilterMode | undefined) => {
      const nextHoldsFilter: HoldsFilter = { ...holdsFilterRef.current };
      let holdEntry: HoldFilterEntry = { ...nextHoldsFilter[holdId] };
      if (nextMode === undefined) {
        delete holdEntry[type];
      } else {
        // Don't allow mixing include and exclude on the same hold — switching
        // modes wipes any previously-set entries in the other mode so the
        // hold ends up consistently include-only or exclude-only.
        const otherMode: HoldFilterMode = nextMode === 'include' ? 'exclude' : 'include';
        const conflicts = Object.entries(holdEntry).some(([, mode]) => mode === otherMode);
        if (conflicts) {
          holdEntry = Object.fromEntries(Object.entries(holdEntry).filter(([, mode]) => mode !== otherMode));
        }
        holdEntry[type] = nextMode;
      }
      if (Object.keys(holdEntry).length === 0) {
        delete nextHoldsFilter[holdId];
      } else {
        nextHoldsFilter[holdId] = holdEntry;
      }
      holdsFilterRef.current = nextHoldsFilter;
      updateFilters({ holdsFilter: nextHoldsFilter });
      track('Search Hold Filter Changed', {
        type,
        mode: nextMode ?? 'unset',
        boardLayout: boardDetails.layout_name || '',
      });
    },
    [boardDetails.layout_name, updateFilters],
  );

  const clearHold = useCallback(
    (holdId: number) => {
      if (!(holdId in holdsFilterRef.current)) return;
      const nextHoldsFilter: HoldsFilter = { ...holdsFilterRef.current };
      delete nextHoldsFilter[holdId];
      holdsFilterRef.current = nextHoldsFilter;
      updateFilters({ holdsFilter: nextHoldsFilter });
      track('Search Hold Filter Cleared', { boardLayout: boardDetails.layout_name || '' });
    },
    [boardDetails.layout_name, updateFilters],
  );

  const picker = useSearchHoldPicker({
    holdsFilter,
    setHoldFilter,
    clearHold,
    // Don't auto-assign on first tap — the click-target circles around each
    // hold extend slightly beyond the visible hold image, so accidental taps
    // on apparent empty space would otherwise commit unintended filters.
    autoAssignOnFirstTap: false,
  });

  // The backend zone filter requires every hold of a climb to fit inside
  // the box. So a filter-hold sitting outside the zone guarantees zero
  // matches — drop it instead of leaving the user staring at empty results.
  const pruneHoldsToZone = useCallback(
    (zone: ZoneBox): HoldsFilter => {
      const prunedHoldsFilter: HoldsFilter = {};
      for (const [holdIdRaw, entry] of Object.entries(holdsFilterRef.current)) {
        const hold = holdsById.get(Number(holdIdRaw));
        if (hold && entry && isHoldInsideZone(hold, zone, dims)) {
          prunedHoldsFilter[Number(holdIdRaw)] = entry;
        }
      }
      return prunedHoldsFilter;
    },
    [dims, holdsById],
  );

  const handleEnable = useCallback(() => {
    setLocalZone(defaultZone);
    updateFilters({ zoneBox: defaultZone, holdsFilter: pruneHoldsToZone(defaultZone) });
    track('Search Zone Enabled', { boardLayout: boardDetails.layout_name || '' });
  }, [boardDetails.layout_name, defaultZone, pruneHoldsToZone, updateFilters]);

  const handleClear = useCallback(() => {
    setLocalZone(null);
    // No zone constraint = no need to touch holdsFilter; existing filter
    // holds keep working with their hold-only semantics.
    updateFilters({ zoneBox: null });
    track('Search Zone Cleared', { boardLayout: boardDetails.layout_name || '' });
  }, [boardDetails.layout_name, updateFilters]);

  const beginDrag = useCallback(
    (mode: DragMode) => (event: React.PointerEvent<SVGElement>) => {
      if (!localZone) return;
      const grid = svgPointToGrid(event.clientX, event.clientY);
      if (!grid) return;
      event.preventDefault();
      event.stopPropagation();
      (event.target as Element).setPointerCapture?.(event.pointerId);
      dragStateRef.current = {
        mode,
        pointerId: event.pointerId,
        startGridX: grid.x,
        startGridY: grid.y,
        startBox: localZone,
        latestBox: localZone,
      };
    },
    [localZone, svgPointToGrid],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<SVGElement>) => {
      const drag = dragStateRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      const grid = svgPointToGrid(event.clientX, event.clientY);
      if (!grid) return;
      const nextZone = applyDrag(
        drag.startBox,
        drag.mode,
        grid.x - drag.startGridX,
        grid.y - drag.startGridY,
        dims,
      );
      drag.latestBox = nextZone;
      setLocalZone(nextZone);
    },
    [dims, svgPointToGrid],
  );

  const persistDraggedZone = useCallback(
    (finalZone: ZoneBox) => {
      setLocalZone(finalZone);
      updateFilters({ zoneBox: finalZone, holdsFilter: pruneHoldsToZone(finalZone) });
      track('Search Zone Updated', {
        boardLayout: boardDetails.layout_name || '',
        width: finalZone.edgeRight - finalZone.edgeLeft,
        height: finalZone.edgeTop - finalZone.edgeBottom,
      });
    },
    [boardDetails.layout_name, pruneHoldsToZone, updateFilters],
  );

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<SVGElement>) => {
      const drag = dragStateRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      dragStateRef.current = null;
      (event.target as Element).releasePointerCapture?.(event.pointerId);
      // Compute the final zone directly from the drag start state plus the
      // pointerup event coords, instead of reading `localZone`. If the
      // browser fires `pointerup` in the same task as the final
      // `pointermove`, React hasn't committed the move's `setLocalZone`
      // yet — closing over `localZone` would persist the second-to-last
      // box. Reading from the ref + event keeps the persisted box in lock
      // step with the user's actual final pointer position.
      const grid = svgPointToGrid(event.clientX, event.clientY);
      const finalZone = grid
        ? applyDrag(drag.startBox, drag.mode, grid.x - drag.startGridX, grid.y - drag.startGridY, dims)
        : drag.latestBox;
      persistDraggedZone(finalZone);
    },
    [dims, persistDraggedZone, svgPointToGrid],
  );

  const handlePointerCancel = useCallback(
    (event: React.PointerEvent<SVGElement>) => {
      const drag = dragStateRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      dragStateRef.current = null;
      (event.target as Element).releasePointerCapture?.(event.pointerId);
      // iOS can cancel pointer streams with coordinates unrelated to the
      // user's last finger position. Persist the last valid move instead of
      // recalculating from the cancel event.
      persistDraggedZone(drag.latestBox);
    },
    [persistDraggedZone],
  );

  // Drag pointer handlers attach to each interactive handle directly
  // rather than to the parent SVG. The parent's `pointer-events: none` is
  // what lets taps on holds inside the zone reach BoardRenderer underneath
  // — and on Safari/iOS, listeners on a `pointer-events: none` element are
  // unreliable once `setPointerCapture` re-routes the move/up events to
  // the captured handle. Binding the handlers to each handle makes the
  // capture self-contained.
  const dragHandlers = {
    onPointerMove: handlePointerMove,
    onPointerUp: handlePointerUp,
    onPointerCancel: handlePointerCancel,
  };

  const rectSvg = useMemo(() => {
    if (!localZone) return null;
    const topLeft = gridToSvg(localZone.edgeLeft, localZone.edgeTop, dims);
    const bottomRight = gridToSvg(localZone.edgeRight, localZone.edgeBottom, dims);
    return {
      x: topLeft.x,
      y: topLeft.y,
      width: bottomRight.x - topLeft.x,
      height: bottomRight.y - topLeft.y,
      centerX: (topLeft.x + bottomRight.x) / 2,
      centerY: (topLeft.y + bottomRight.y) / 2,
    };
  }, [dims, localZone]);

  const { includeCount, excludeCount } = useMemo(() => {
    let included = 0;
    let excluded = 0;
    for (const entry of Object.values(holdsFilter)) {
      if (!entry) continue;
      for (const mode of Object.values(entry)) {
        if (mode === 'include') included++;
        else if (mode === 'exclude') excluded++;
      }
    }
    return { includeCount: included, excludeCount: excluded };
  }, [holdsFilter]);

  return (
    <div className={styles.holdSearchForm}>
      <div className={styles.holdSearchHeaderCompact}>
        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <MuiTypography variant="body2" component="span" color="text.secondary">
            {t('search.holdsAndZone.description')}
          </MuiTypography>
          {includeCount > 0 && (
            <Chip
              label={t('search.holds.included', { count: includeCount })}
              size="small"
              sx={{ bgcolor: themeTokens.colors.success, color: 'common.white' }}
            />
          )}
          {excludeCount > 0 && (
            <Chip
              label={t('search.holds.excluded', { count: excludeCount })}
              size="small"
              sx={{ bgcolor: themeTokens.colors.error, color: 'common.white' }}
            />
          )}
          {zoneEnabled ? (
            <MuiButton size="small" variant="outlined" onClick={handleClear}>
              {t('search.zone.clear')}
            </MuiButton>
          ) : (
            <MuiButton size="small" variant="contained" onClick={handleEnable}>
              {t('search.zone.draw')}
            </MuiButton>
          )}
          <MuiTooltip title={showHeatmap ? t('search.holds.hideHeatmap') : t('search.holds.showHeatmap')}>
            <IconButton
              size="small"
              onClick={() => {
                const nextShowHeatmap = !showHeatmap;
                setShowHeatmap(nextShowHeatmap);
                track(`Heatmap ${nextShowHeatmap ? 'Shown' : 'Hidden'}`, {
                  boardLayout: boardDetails.layout_name || '',
                });
              }}
              aria-label={showHeatmap ? t('search.holds.hideHeatmap') : t('search.holds.showHeatmap')}
            >
              {showHeatmap ? <LayersIcon fontSize="small" /> : <LayersOutlinedIcon fontSize="small" />}
            </IconButton>
          </MuiTooltip>
        </Stack>
      </div>

      <div className={styles.boardContainer} data-testid="zone-board-container" data-swipe-blocked="">
        <BoardRenderer
          boardDetails={tightenedBoardDetails}
          litUpHoldsMap={{}}
          mirrored={false}
          onHoldClick={picker.handleHoldClick}
        />
        {/* Heatmap below the filter rings so the wash colours sit behind the
            user's selections instead of dimming them. */}
        <CreateClimbHeatmapOverlay
          boardDetails={tightenedBoardDetails}
          angle={angle}
          litUpHoldsMap={{}}
          opacity={0.7}
          enabled={showHeatmap}
          filtersOverride={uiSearchParams}
        />
        <SearchHoldFilterOverlay
          boardDetails={boardDetails}
          holdsFilter={holdsFilter}
          activeHoldId={picker.activeHoldId}
        />
        {rectSvg && localZone && (
          <svg
            ref={svgRef}
            viewBox={`0 0 ${boardWidth} ${boardHeight}`}
            preserveAspectRatio="xMidYMid meet"
            className={styles.zoneOverlaySvg}
          >
            <rect
              data-testid="zone-hit-move-border"
              x={rectSvg.x}
              y={rectSvg.y}
              width={rectSvg.width}
              height={rectSvg.height}
              fill="none"
              stroke="transparent"
              strokeWidth={handleHitRadius}
              onPointerDown={beginDrag('move')}
              className={styles.zoneDragTarget}
              data-swipe-blocked=""
              cursor="move"
              pointerEvents="stroke"
              {...dragHandlers}
            />
            <rect
              data-testid="zone-exclusion-top"
              x={0}
              y={0}
              width={boardWidth}
              height={rectSvg.y}
              fill={themeTokens.neutral[900]}
              fillOpacity={ZONE_EXCLUSION_OPACITY}
              pointerEvents="none"
            />
            <rect
              data-testid="zone-exclusion-bottom"
              x={0}
              y={rectSvg.y + rectSvg.height}
              width={boardWidth}
              height={Math.max(0, boardHeight - (rectSvg.y + rectSvg.height))}
              fill={themeTokens.neutral[900]}
              fillOpacity={ZONE_EXCLUSION_OPACITY}
              pointerEvents="none"
            />
            <rect
              data-testid="zone-exclusion-left"
              x={0}
              y={rectSvg.y}
              width={rectSvg.x}
              height={rectSvg.height}
              fill={themeTokens.neutral[900]}
              fillOpacity={ZONE_EXCLUSION_OPACITY}
              pointerEvents="none"
            />
            <rect
              data-testid="zone-exclusion-right"
              x={rectSvg.x + rectSvg.width}
              y={rectSvg.y}
              width={Math.max(0, boardWidth - (rectSvg.x + rectSvg.width))}
              height={rectSvg.height}
              fill={themeTokens.neutral[900]}
              fillOpacity={ZONE_EXCLUSION_OPACITY}
              pointerEvents="none"
            />
            <rect
              data-testid="zone-selection-outline"
              x={rectSvg.x}
              y={rectSvg.y}
              width={rectSvg.width}
              height={rectSvg.height}
              fill="none"
              stroke={themeTokens.colors.primary}
              strokeOpacity={RECT_STROKE_OPACITY}
              strokeWidth={Math.max(boardWidth, boardHeight) * 0.005}
              pointerEvents="none"
            />
            {/* Centre move handle replaces dragging the rect body so holds
                under the zone fill stay tappable. Sized to match the corner
                handles so it's a proper touch target on mobile. */}
            <circle
              data-testid="zone-hit-move"
              cx={rectSvg.centerX}
              cy={rectSvg.centerY}
              r={handleHitRadius}
              fill="transparent"
              onPointerDown={beginDrag('move')}
              className={styles.zoneDragTarget}
              data-swipe-blocked=""
              cursor="move"
              pointerEvents="all"
              {...dragHandlers}
            />
            <circle
              data-testid="zone-handle-move"
              cx={rectSvg.centerX}
              cy={rectSvg.centerY}
              r={handleRadius}
              fill={themeTokens.colors.primary}
              fillOpacity={HANDLE_OPACITY}
              stroke={themeTokens.neutral[50]}
              strokeWidth={handleRadius * 0.25}
              onPointerDown={beginDrag('move')}
              className={styles.zoneDragHandle}
              data-swipe-blocked=""
              cursor="move"
              pointerEvents="auto"
              {...dragHandlers}
            />
            {(['nw', 'ne', 'sw', 'se'] as const).map((corner) => {
              const handleX = corner === 'nw' || corner === 'sw' ? localZone.edgeLeft : localZone.edgeRight;
              const handleY = corner === 'nw' || corner === 'ne' ? localZone.edgeTop : localZone.edgeBottom;
              const handlePos = gridToSvg(handleX, handleY, dims);
              const cursor = corner === 'nw' || corner === 'se' ? 'nwse-resize' : 'nesw-resize';
              return (
                <React.Fragment key={corner}>
                  <circle
                    data-testid={`zone-hit-${corner}`}
                    cx={handlePos.x}
                    cy={handlePos.y}
                    r={handleHitRadius}
                    fill="transparent"
                    onPointerDown={beginDrag(corner)}
                    className={styles.zoneDragTarget}
                    data-swipe-blocked=""
                    cursor={cursor}
                    pointerEvents="all"
                    {...dragHandlers}
                  />
                  <circle
                    data-testid={`zone-handle-${corner}`}
                    cx={handlePos.x}
                    cy={handlePos.y}
                    r={handleRadius}
                    fill={themeTokens.colors.primary}
                    fillOpacity={HANDLE_OPACITY}
                    stroke={themeTokens.neutral[50]}
                    strokeWidth={handleRadius * 0.25}
                    onPointerDown={beginDrag(corner)}
                    className={styles.zoneDragHandle}
                    data-swipe-blocked=""
                    cursor={cursor}
                    pointerEvents="auto"
                    {...dragHandlers}
                  />
                </React.Fragment>
              );
            })}
          </svg>
        )}
      </div>

      <HoldTypePicker
        mode="search"
        boardName={boardDetails.board_name}
        anchorEl={picker.anchorEl}
        currentEntry={picker.currentEntry}
        onFilterChange={picker.handleFilterChange}
        onClearAll={picker.handleClearAll}
        onClose={picker.handleClose}
      />
    </div>
  );
};

export default ClimbSearchForm;
