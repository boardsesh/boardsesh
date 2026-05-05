'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import MuiButton from '@mui/material/Button';
import MuiTypography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import MuiTooltip from '@mui/material/Tooltip';
import LayersIcon from '@mui/icons-material/Layers';
import LayersOutlinedIcon from '@mui/icons-material/LayersOutlined';
import { track } from '@vercel/analytics';
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
import ZoomableBoard from '../board-renderer/zoomable-board';
import HoldTypePicker from '../create-climb/hold-type-picker';
import CreateClimbHeatmapOverlay from '../create-climb/create-climb-heatmap-overlay';
import { useSearchHoldPicker } from './use-search-hold-picker';
import SearchHoldFilterOverlay from './search-hold-filter-overlay';
import {
  applyDrag,
  computeHandleRadius,
  gridToSvg,
  svgToGrid,
  type BoardDimensions,
  type DragMode,
} from './climb-zone-math';
import styles from './search-form.module.css';

type ClimbBoardSearchFormProps = {
  boardDetails: BoardDetails;
};

const HANDLE_OPACITY = 0.95;
const RECT_FILL_OPACITY = 0.18;
const RECT_STROKE_OPACITY = 0.9;
// Invisible thicker stroke layered over the visible rect so the user can
// drag the box border on touch devices where a 1-2px visible stroke is
// otherwise impossible to grab.
const GRAB_STROKE_FRACTION = 0.025;

// Angle is part of the URL but not the BoardDetails object, so the heatmap
// query needs to read it from the pathname (the second-to-last segment in
// the routes that mount this component).
const getAngleFromPath = (pathname: string): number => {
  const segments = pathname.split('/');
  const angle = Number(segments[segments.length - 2]);
  return Number.isFinite(angle) ? angle : 40;
};

const ClimbBoardSearchForm: React.FC<ClimbBoardSearchFormProps> = ({ boardDetails }) => {
  const { t } = useTranslation('climbs');
  const { uiSearchParams, updateFilters } = useUISearchParams();
  const [showHeatmap, setShowHeatmap] = useState(false);
  const pathname = usePathname();
  const angle = useMemo(() => getAngleFromPath(pathname), [pathname]);

  const { boardWidth, boardHeight, edge_left, edge_right, edge_bottom, edge_top, holdsData } = boardDetails;

  // BoardLitupHolds renders a transparent click circle at each hold's
  // (cx, cy, r). The radius `r` comes from board-constants.ts as
  // `xSpacing * 4`, which is generous on purpose so the visible stroke
  // stands out for setters — but for search mode that means taps several
  // SVG units away from the visible hold image still land on its hidden
  // click target, so the user sees a filter circle "in empty space".
  // Shrink each hold's click radius for search mode so the tap target sits
  // closer to the visible hold image. Setter mode is unaffected.
  const tightenedBoardDetails = useMemo(
    () => ({
      ...boardDetails,
      holdsData: holdsData.map((h) => ({ ...h, r: h.r * 0.5 })),
    }),
    [boardDetails, holdsData],
  );

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

  // Default to the full board on enable so we don't surprise-clear holds the
  // user already selected — they constrain by dragging handles inward.
  const fullBoardZone = useMemo<ZoneBox>(
    () => ({
      edgeLeft: edge_left,
      edgeRight: edge_right,
      edgeBottom: edge_bottom,
      edgeTop: edge_top,
    }),
    [edge_left, edge_right, edge_bottom, edge_top],
  );

  const holdsFilter: HoldsFilter = uiSearchParams.holdsFilter || {};
  const zoneBoxParam: ZoneBox | null = uiSearchParams.zoneBox;

  // Local zone for smooth dragging without flooding the search debounce.
  // Synced from the URL param so external clears propagate in.
  const [localZone, setLocalZone] = useState<ZoneBox | null>(zoneBoxParam);
  useEffect(() => {
    setLocalZone(zoneBoxParam);
  }, [zoneBoxParam]);

  const setHoldFilter = useCallback(
    (holdId: number, type: HoldFilterType, nextMode: HoldFilterMode | undefined) => {
      const next: HoldsFilter = { ...holdsFilter };
      let existing: HoldFilterEntry = { ...next[holdId] };
      if (nextMode === undefined) {
        delete existing[type];
      } else {
        // Don't allow mixing include and exclude on the same hold — switching
        // modes wipes any previously-set entries in the other mode so the
        // hold ends up consistently include-only or exclude-only.
        const otherMode: HoldFilterMode = nextMode === 'include' ? 'exclude' : 'include';
        const conflicts = Object.entries(existing).some(([, m]) => m === otherMode);
        if (conflicts) {
          existing = Object.fromEntries(Object.entries(existing).filter(([, m]) => m !== otherMode));
        }
        existing[type] = nextMode;
      }
      if (Object.keys(existing).length === 0) {
        delete next[holdId];
      } else {
        next[holdId] = existing;
      }
      updateFilters({ holdsFilter: next });
      track('Search Hold Filter Changed', {
        type,
        mode: nextMode ?? 'unset',
        boardLayout: boardDetails.layout_name || '',
      });
    },
    [boardDetails.layout_name, holdsFilter, updateFilters],
  );

  const clearHold = useCallback(
    (holdId: number) => {
      if (!(holdId in holdsFilter)) return;
      const next: HoldsFilter = { ...holdsFilter };
      delete next[holdId];
      updateFilters({ holdsFilter: next });
      track('Search Hold Filter Cleared', { boardLayout: boardDetails.layout_name || '' });
    },
    [boardDetails.layout_name, holdsFilter, updateFilters],
  );

  const picker = useSearchHoldPicker({
    holdsFilter,
    setHoldFilter,
    clearHold,
    autoAssignOnFirstTap: false,
  });

  // Strip any selected hold whose centre lies outside the given zone. Used
  // when the zone is committed (drag end) so user expectation stays simple:
  // shrinking the zone drops holds that are no longer covered.
  const filterHoldsToZone = useCallback(
    (zone: ZoneBox, current: HoldsFilter): HoldsFilter => {
      const tl = gridToSvg(zone.edgeLeft, zone.edgeTop, dims);
      const br = gridToSvg(zone.edgeRight, zone.edgeBottom, dims);
      const next: HoldsFilter = {};
      for (const [holdIdRaw, entry] of Object.entries(current)) {
        const holdId = Number(holdIdRaw);
        const hold = holdsData.find((h) => h.id === holdId);
        if (!hold || !entry) continue;
        if (hold.cx >= tl.x && hold.cx <= br.x && hold.cy >= tl.y && hold.cy <= br.y) {
          next[holdId] = entry;
        }
      }
      return next;
    },
    [dims, holdsData],
  );

  // Zone-drag plumbing
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragStateRef = useRef<{
    mode: DragMode;
    pointerId: number;
    startGridX: number;
    startGridY: number;
    startBox: ZoneBox;
  } | null>(null);

  const svgPointToGrid = useCallback(
    (clientX: number, clientY: number) => {
      const svg = svgRef.current;
      if (!svg) return null;
      const point = svg.createSVGPoint();
      point.x = clientX;
      point.y = clientY;
      const ctm = svg.getScreenCTM();
      if (!ctm) return null;
      const local = point.matrixTransform(ctm.inverse());
      return svgToGrid(local.x, local.y, dims);
    },
    [dims],
  );

  const beginDrag = useCallback(
    (mode: DragMode) => (event: React.PointerEvent<SVGElement>) => {
      if (!localZone) return;
      const grid = svgPointToGrid(event.clientX, event.clientY);
      if (!grid) return;
      // Stop the event from bubbling up to ZoomableBoard so the gesture lib
      // doesn't grab this pointer for a pan drag.
      event.preventDefault();
      event.stopPropagation();
      (event.target as Element).setPointerCapture?.(event.pointerId);
      dragStateRef.current = {
        mode,
        pointerId: event.pointerId,
        startGridX: grid.x,
        startGridY: grid.y,
        startBox: localZone,
      };
    },
    [localZone, svgPointToGrid],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<SVGElement>) => {
      const drag = dragStateRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      const grid = svgPointToGrid(event.clientX, event.clientY);
      if (!grid) return;
      setLocalZone(applyDrag(drag.startBox, drag.mode, grid.x - drag.startGridX, grid.y - drag.startGridY, dims));
    },
    [dims, svgPointToGrid],
  );

  const endDrag = useCallback(
    (event: React.PointerEvent<SVGElement>) => {
      const drag = dragStateRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      dragStateRef.current = null;
      (event.target as Element).releasePointerCapture?.(event.pointerId);
      if (!localZone) return;
      const trimmedHolds = filterHoldsToZone(localZone, holdsFilter);
      const droppedCount = Object.keys(holdsFilter).length - Object.keys(trimmedHolds).length;
      const update: { zoneBox: ZoneBox; holdsFilter?: HoldsFilter } = { zoneBox: localZone };
      if (droppedCount > 0) update.holdsFilter = trimmedHolds;
      updateFilters(update);
      track('Search Zone Updated', {
        boardLayout: boardDetails.layout_name || '',
        width: localZone.edgeRight - localZone.edgeLeft,
        height: localZone.edgeTop - localZone.edgeBottom,
        droppedHolds: droppedCount,
      });
    },
    [boardDetails.layout_name, filterHoldsToZone, holdsFilter, localZone, updateFilters],
  );

  const handleEnableZone = () => {
    setLocalZone(fullBoardZone);
    updateFilters({ zoneBox: fullBoardZone });
    track('Search Zone Enabled', { boardLayout: boardDetails.layout_name || '' });
  };

  const handleClearZone = () => {
    setLocalZone(null);
    updateFilters({ zoneBox: null });
    track('Search Zone Cleared', { boardLayout: boardDetails.layout_name || '' });
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
    };
  }, [dims, localZone]);

  const handleRadius = computeHandleRadius(dims);
  const grabStrokeWidth = Math.max(boardWidth, boardHeight) * GRAB_STROKE_FRACTION;
  const visibleStrokeWidth = Math.max(boardWidth, boardHeight) * 0.005;

  // Tally include / exclude across all (hold, type) pairs so the chip count
  // reflects total filters, not just hold count.
  let includeCount = 0;
  let excludeCount = 0;
  for (const entry of Object.values(holdsFilter)) {
    if (!entry) continue;
    for (const mode of Object.values(entry)) {
      if (mode === 'include') includeCount++;
      else if (mode === 'exclude') excludeCount++;
    }
  }

  const zoneEnabled = localZone !== null;

  return (
    <div className={styles.holdSearchForm}>
      <div className={styles.holdSearchHeaderCompact}>
        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <MuiTypography variant="body2" component="span" color="text.secondary">
            {t('search.holds.tapToToggle')}
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
          <MuiTooltip title={showHeatmap ? t('search.holds.hideHeatmap') : t('search.holds.showHeatmap')}>
            <IconButton
              size="small"
              onClick={() => {
                const next = !showHeatmap;
                setShowHeatmap(next);
                track(`Heatmap ${next ? 'Shown' : 'Hidden'}`, { boardLayout: boardDetails.layout_name || '' });
              }}
              aria-label={showHeatmap ? t('search.holds.hideHeatmap') : t('search.holds.showHeatmap')}
            >
              {showHeatmap ? <LayersIcon fontSize="small" /> : <LayersOutlinedIcon fontSize="small" />}
            </IconButton>
          </MuiTooltip>
          {zoneEnabled ? (
            <MuiButton size="small" variant="outlined" onClick={handleClearZone}>
              {t('search.zone.clear')}
            </MuiButton>
          ) : (
            <MuiButton size="small" variant="contained" onClick={handleEnableZone}>
              {t('search.zone.draw')}
            </MuiButton>
          )}
        </Stack>
      </div>

      <div className={styles.boardContainer} style={{ aspectRatio: `${boardWidth} / ${boardHeight}` }}>
        <ZoomableBoard resetKey="search-board">
          <div className={styles.zoomFill}>
            <BoardRenderer
              boardDetails={tightenedBoardDetails}
              litUpHoldsMap={{}}
              mirrored={false}
              onHoldClick={picker.handleHoldClick}
              fillHeight
            />
            <SearchHoldFilterOverlay
              boardDetails={boardDetails}
              holdsFilter={holdsFilter}
              activeHoldId={picker.activeHoldId}
            />
            <CreateClimbHeatmapOverlay
              boardDetails={tightenedBoardDetails}
              angle={angle}
              litUpHoldsMap={{}}
              opacity={0.7}
              enabled={showHeatmap}
              filtersOverride={uiSearchParams}
            />
            {/* Zone overlay sits on top of the heatmap/filter overlays. The svg
                itself ignores pointer events so taps on the board pass through
                to BoardRenderer's hold click targets; only the rect-grab
                stroke and corner handles are interactive. */}
            <svg
              ref={svgRef}
              viewBox={`0 0 ${boardWidth} ${boardHeight}`}
              preserveAspectRatio="xMidYMid meet"
              onPointerMove={handlePointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              className={styles.zoneOverlaySvg}
            >
              {rectSvg && localZone && (
                <g>
                  {/* Visible rect — purely decorative, click-through. */}
                  <rect
                    x={rectSvg.x}
                    y={rectSvg.y}
                    width={rectSvg.width}
                    height={rectSvg.height}
                    fill={themeTokens.colors.primary}
                    fillOpacity={RECT_FILL_OPACITY}
                    stroke={themeTokens.colors.primary}
                    strokeOpacity={RECT_STROKE_OPACITY}
                    strokeWidth={visibleStrokeWidth}
                    pointerEvents="none"
                  />
                  {/* Invisible thicker stroke for grabbing the border to move. */}
                  <rect
                    x={rectSvg.x}
                    y={rectSvg.y}
                    width={rectSvg.width}
                    height={rectSvg.height}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={grabStrokeWidth}
                    onPointerDown={beginDrag('move')}
                    cursor="move"
                    style={{ pointerEvents: 'stroke', touchAction: 'none' }}
                  />
                  {(['nw', 'ne', 'sw', 'se'] as const).map((corner) => {
                    const handleX = corner === 'nw' || corner === 'sw' ? localZone.edgeLeft : localZone.edgeRight;
                    const handleY = corner === 'nw' || corner === 'ne' ? localZone.edgeTop : localZone.edgeBottom;
                    const handlePos = gridToSvg(handleX, handleY, dims);
                    const cursor = corner === 'nw' || corner === 'se' ? 'nwse-resize' : 'nesw-resize';
                    return (
                      <circle
                        key={corner}
                        cx={handlePos.x}
                        cy={handlePos.y}
                        r={handleRadius}
                        fill={themeTokens.colors.primary}
                        fillOpacity={HANDLE_OPACITY}
                        stroke={themeTokens.neutral[50]}
                        strokeWidth={handleRadius * 0.25}
                        onPointerDown={beginDrag(corner)}
                        cursor={cursor}
                        style={{ touchAction: 'none' }}
                      />
                    );
                  })}
                </g>
              )}
            </svg>
          </div>
        </ZoomableBoard>
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

export default ClimbBoardSearchForm;
