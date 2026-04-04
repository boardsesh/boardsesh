'use client';
import React, { useEffect, useCallback, useState, useMemo, useRef } from 'react';
import IconButton from '@mui/material/IconButton';
import Box from '@mui/material/Box';
import AppsOutlined from '@mui/icons-material/AppsOutlined';
import FormatListBulletedOutlined from '@mui/icons-material/FormatListBulletedOutlined';
import { usePathname } from 'next/navigation';
import { track } from '@vercel/analytics';
import dynamic from 'next/dynamic';
import { Climb, BoardDetails } from '@/app/lib/types';
import ClimbCard from '../climb-card/climb-card';
import ClimbListItem from '../climb-card/climb-list-item';
import DrawerClimbHeader from '../climb-card/drawer-climb-header';
import { ClimbActions } from '../climb-actions';
import PlaylistSelectionContent from '../climb-actions/playlist-selection-content';
import { ClimbCardSkeleton, ClimbListItemSkeleton } from './board-page-skeleton';
import { themeTokens } from '@/app/theme/theme-config';
import { getPreference, setPreference } from '@/app/lib/user-preferences-db';
import { useInfiniteScroll } from '@/app/hooks/use-infinite-scroll';
import { trackListBatchRender } from '@/app/lib/rendering-metrics';
import { classifyClimbListChange } from './climb-list-utils';
import { getExcludedClimbActions } from '@/app/lib/climb-action-utils';

const SwipeableDrawer = dynamic(() => import('../swipeable-drawer/swipeable-drawer'), { ssr: false });

type ViewMode = 'grid' | 'list';

const VIEW_MODE_PREFERENCE_KEY = 'climbListViewMode';

// Static drawer style objects (hoisted to avoid per-render allocation)
const sharedDrawerStyles = {
  wrapper: { height: 'auto', width: '100%' },
  body: { padding: `${themeTokens.spacing[2]}px 0` },
  header: { paddingLeft: `${themeTokens.spacing[3]}px`, paddingRight: `${themeTokens.spacing[3]}px` },
} as const;

const sharedPlaylistDrawerStyles = {
  wrapper: { height: 'auto', maxHeight: '70vh', width: '100%' },
  body: { padding: 0 },
  header: { paddingLeft: `${themeTokens.spacing[3]}px`, paddingRight: `${themeTokens.spacing[3]}px` },
} as const;

export type ClimbsListProps = {
  boardDetails: BoardDetails;
  boardDetailsMap?: Record<string, BoardDetails>;
  unsupportedClimbs?: Set<string>;
  initialImageCount?: number;
  climbs: Climb[];
  selectedClimbUuid?: string | null;
  isFetching: boolean;
  hasMore: boolean;
  onClimbSelect?: (climb: Climb) => void;
  onLoadMore: () => void;
  header?: React.ReactNode;
  headerInline?: React.ReactNode;
  /** Angle selector to render on the right side of the first header row */
  angleSelector?: React.ReactNode;
  hideEndMessage?: boolean;
  renderItemExtra?: (climb: Climb) => React.ReactNode;
  showBottomSpacer?: boolean;
};

const ClimbsListSkeleton = ({ aspectRatio, viewMode }: { aspectRatio: number; viewMode: ViewMode }) => {
  if (viewMode === 'list') {
    return Array.from({ length: 10 }, (_, i) => <ClimbListItemSkeleton key={i} />);
  }
  return Array.from({ length: 10 }, (_, i) => (
    <Box key={i} sx={{ width: { xs: '100%', lg: '50%' } }}>
      <ClimbCardSkeleton aspectRatio={aspectRatio} />
    </Box>
  ));
};

const ClimbsList = ({
  boardDetails,
  boardDetailsMap,
  unsupportedClimbs,
  initialImageCount = 0,
  climbs,
  selectedClimbUuid,
  isFetching,
  hasMore,
  onClimbSelect,
  onLoadMore,
  header,
  headerInline,
  angleSelector,
  hideEndMessage,
  renderItemExtra,
  showBottomSpacer,
}: ClimbsListProps) => {
  // Show the first batch immediately, then reveal the rest on the next frame.
  // Only batch when the list is replaced (new search), not when items are appended (infinite scroll)
  // — otherwise the height shrinks and the page jumps.
  const INITIAL_BATCH = 6;
  const [visibleCount, setVisibleCount] = useState(climbs.length);
  const prevClimbsRef = useRef(climbs);

  // --- Batch render timing ---
  // Records when a new batch of climbs arrives (data change) so we can measure
  // render duration in useEffect (fires after DOM commit).
  const batchStartRef = useRef<{ time: number; prevLength: number; isInitial: boolean } | null>(
    climbs.length > 0 ? { time: performance.now(), prevLength: 0, isInitial: true } : null,
  );

  if (climbs !== prevClimbsRef.current) {
    const prevClimbs = prevClimbsRef.current;
    prevClimbsRef.current = climbs;

    const changeType = classifyClimbListChange(climbs, prevClimbs);

    // Record batch start for any data change that adds items
    if (climbs.length > prevClimbs.length) {
      batchStartRef.current = {
        time: performance.now(),
        prevLength: prevClimbs.length,
        isInitial: prevClimbs.length === 0,
      };
    }

    if (changeType === 'append' || changeType === 'same') {
      // Show all items immediately — no batching for appended pages or unchanged data
      setVisibleCount(climbs.length);
    } else if (climbs.length > INITIAL_BATCH) {
      setVisibleCount(INITIAL_BATCH);
    }
  }

  useEffect(() => {
    if (visibleCount < climbs.length) {
      const id = requestAnimationFrame(() => setVisibleCount(climbs.length));
      return () => cancelAnimationFrame(id);
    }
  }, [visibleCount, climbs.length]);

  const visibleClimbs = useMemo(() => climbs.slice(0, visibleCount), [climbs, visibleCount]);

  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  // Track batch render timing after DOM commit
  useEffect(() => {
    const batch = batchStartRef.current;
    if (!batch || climbs.length === 0) return;
    // Only fire once per batch (when all items are visible)
    if (visibleCount < climbs.length) return;
    batchStartRef.current = null;
    trackListBatchRender(performance.now() - batch.time, {
      viewMode,
      renderer: 'wasm',
      batchSize: climbs.length - batch.prevLength,
      totalItems: climbs.length,
      isInitial: batch.isInitial,
    });
  }, [climbs.length, visibleCount, viewMode]);

  const onClimbSelectRef = useRef(onClimbSelect);
  onClimbSelectRef.current = onClimbSelect;

  useEffect(() => {
    getPreference<ViewMode>(VIEW_MODE_PREFERENCE_KEY).then((stored) => {
      if (stored === 'grid' || stored === 'list') {
        setViewMode(stored);
      }
    });
  }, []);

  const handleViewModeChange = useCallback((mode: ViewMode) => {
    setViewMode(mode);
    setPreference(VIEW_MODE_PREFERENCE_KEY, mode).catch(() => {});
    track('View Mode Changed', { mode });
  }, []);

  const handleLoadMore = useCallback(() => {
    track('Infinite Scroll Load More', {
      currentCount: climbs.length,
      hasMore,
    });
    onLoadMore();
  }, [climbs.length, hasMore, onLoadMore]);

  const { sentinelRef } = useInfiniteScroll({
    onLoadMore: handleLoadMore,
    hasMore,
    isFetching,
  });

  const handleClimbClick = useCallback((climb: Climb) => {
    onClimbSelectRef.current?.(climb);
    track('Climb List Item Clicked', { climbUuid: climb.uuid });
  }, []);

  const climbHandlersMap = useMemo(() => {
    const map = new Map<string, () => void>();
    climbs.forEach((climb) => {
      map.set(climb.uuid, () => handleClimbClick(climb));
    });
    return map;
  }, [climbs, handleClimbClick]);

  const resolveBoardDetails = useCallback(
    (climb: Climb): BoardDetails => {
      if (boardDetailsMap && climb.boardType && climb.layoutId != null) {
        const key = `${climb.boardType}:${climb.layoutId}`;
        return boardDetailsMap[key] || boardDetails;
      }
      return boardDetails;
    },
    [boardDetails, boardDetailsMap],
  );

  // --- Shared drawer state (one pair of drawers for all list items) ---
  const pathname = usePathname();
  const [activeDrawerClimb, setActiveDrawerClimb] = useState<Climb | null>(null);
  const [drawerMode, setDrawerMode] = useState<'actions' | 'playlist' | null>(null);

  const handleOpenActions = useCallback((climb: Climb) => {
    setActiveDrawerClimb(climb);
    setDrawerMode('actions');
  }, []);

  const handleOpenPlaylistSelector = useCallback((climb: Climb) => {
    setActiveDrawerClimb(climb);
    setDrawerMode('playlist');
  }, []);

  const handleCloseDrawer = useCallback(() => {
    setDrawerMode(null);
  }, []);

  const handleSwitchToPlaylist = useCallback(() => {
    setDrawerMode('playlist');
  }, []);

  const handleDrawerTransitionEnd = useCallback((open: boolean) => {
    if (!open) setActiveDrawerClimb(null);
  }, []);

  const excludeActions = useMemo(
    () => getExcludedClimbActions(boardDetails.board_name, 'list'),
    [boardDetails.board_name],
  );

  const activeDrawerBoardDetails = useMemo(
    () => (activeDrawerClimb ? resolveBoardDetails(activeDrawerClimb) : boardDetails),
    [activeDrawerClimb, resolveBoardDetails, boardDetails],
  );

  // Memoize sx prop objects to prevent recreation on every render
  const headerContainerSx = useMemo(
    () => ({
      display: 'flex',
      alignItems: 'center',
      gap: `${themeTokens.spacing[2]}px`,
      padding: `${themeTokens.spacing[2]}px ${themeTokens.spacing[3]}px`,
      minHeight: 40,
    }),
    [],
  );

  const searchPillsContainerSx = useMemo(
    () => ({
      flex: 1,
      minWidth: 0,
      overflow: 'hidden',
    }),
    [],
  );

  const rightControlsSx = useMemo(
    () => ({
      display: 'flex',
      alignItems: 'center',
      gap: `${themeTokens.spacing[2]}px`,
      flexShrink: 0,
    }),
    [],
  );

  const viewModeToggleBoxSx = useMemo(
    () => ({
      display: 'flex',
      gap: '2px',
      flexShrink: 0,
    }),
    [],
  );

  const iconButtonSx = useMemo(() => ({ padding: '4px' }), []);

  const viewModeButtonSx = useCallback(
    (isActive: boolean) => ({
      padding: '4px',
      opacity: isActive ? 1 : 0.4,
    }),
    [],
  );

  const gridContainerSx = useMemo(
    () => ({
      display: 'flex',
      flexWrap: 'wrap' as const,
      gap: `${themeTokens.spacing[4]}px`,
    }),
    [],
  );

  const cardBoxSx = useMemo(
    () => ({
      width: { xs: '100%', lg: `calc(50% - ${themeTokens.spacing[4] / 2}px)` },
    }),
    [],
  );

  const sentinelBoxSx = useMemo(
    () => ({
      minHeight: `${themeTokens.spacing[5]}px`,
      mt: viewMode === 'grid' ? `${themeTokens.spacing[4]}px` : 0,
    }),
    [viewMode],
  );

  const noMoreClimbsBoxSx = useMemo(
    () => ({
      textAlign: 'center' as const,
      padding: `${themeTokens.spacing[5]}px`,
      color: 'var(--neutral-400)',
    }),
    [],
  );

  return (
    <Box>
      {header}
      {/* Header: Search pills (left, scrollable) | View toggle + Angle selector (right) */}
      <Box sx={headerContainerSx}>
        {/* Left: Search pills (scrollable) */}
        <Box sx={searchPillsContainerSx}>{headerInline}</Box>
        {/* Right: View toggle + Angle selector */}
        <Box sx={rightControlsSx}>
          <Box sx={viewModeToggleBoxSx}>
            <IconButton
              onClick={() => handleViewModeChange('list')}
              aria-label="List view"
              size="small"
              sx={viewModeButtonSx(viewMode === 'list')}
            >
              <FormatListBulletedOutlined fontSize="small" />
            </IconButton>
            <IconButton
              onClick={() => handleViewModeChange('grid')}
              aria-label="Grid view"
              size="small"
              sx={viewModeButtonSx(viewMode === 'grid')}
            >
              <AppsOutlined fontSize="small" />
            </IconButton>
          </Box>
          {angleSelector}
        </Box>
      </Box>

      {viewMode === 'grid' ? (
        /* Grid (card) mode — not virtualized */
        <Box sx={gridContainerSx}>
          {visibleClimbs.map((climb, index) => (
            <Box key={climb.uuid} sx={cardBoxSx}>
              <div {...(index === 0 ? { id: 'onboarding-climb-card' } : {})}>
                <ClimbCard
                  climb={climb}
                  boardDetails={resolveBoardDetails(climb)}
                  preferImageLayers={index < initialImageCount}
                  selected={selectedClimbUuid === climb.uuid}
                  onCoverClick={climbHandlersMap.get(climb.uuid)}
                  unsupported={unsupportedClimbs?.has(climb.uuid)}
                />
              </div>
              {renderItemExtra?.(climb)}
            </Box>
          ))}
          {isFetching && (!climbs || climbs.length === 0) ? (
            <ClimbsListSkeleton aspectRatio={boardDetails.boardWidth / boardDetails.boardHeight} viewMode="grid" />
          ) : null}
        </Box>
      ) : (
        /* List mode — non-virtualized */
        <div>
          {isFetching && climbs.length === 0 ? (
            <ClimbsListSkeleton aspectRatio={boardDetails.boardWidth / boardDetails.boardHeight} viewMode="list" />
          ) : (
            visibleClimbs.map((climb, index) => (
              <div key={climb.uuid}>
                <div {...(index === 0 ? { id: 'onboarding-climb-card' } : {})}>
                  <ClimbListItem
                    climb={climb}
                    boardDetails={resolveBoardDetails(climb)}
                    preferImageLayers={index < initialImageCount}
                    selected={selectedClimbUuid === climb.uuid}
                    onSelect={climbHandlersMap.get(climb.uuid)}
                    onThumbnailClick={climbHandlersMap.get(climb.uuid)}
                    disableThumbnailNavigation
                    disableSwipe={!hydrated}
                    unsupported={unsupportedClimbs?.has(climb.uuid)}
                    onOpenActions={handleOpenActions}
                    onOpenPlaylistSelector={handleOpenPlaylistSelector}
                  />
                </div>
                {renderItemExtra?.(climb)}
              </div>
            ))
          )}
        </div>
      )}

      {/* Sentinel for infinite scroll (grid mode fallback) */}
      <Box ref={sentinelRef} sx={sentinelBoxSx}>
        {isFetching &&
          climbs.length > 0 &&
          (viewMode === 'grid' ? (
            <Box sx={gridContainerSx}>
              <ClimbsListSkeleton aspectRatio={boardDetails.boardWidth / boardDetails.boardHeight} viewMode="grid" />
            </Box>
          ) : (
            <ClimbsListSkeleton aspectRatio={boardDetails.boardWidth / boardDetails.boardHeight} viewMode="list" />
          ))}
        {!hasMore && climbs.length > 0 && !hideEndMessage && <Box sx={noMoreClimbsBoxSx}>No more climbs</Box>}
      </Box>

      {showBottomSpacer && <Box sx={{ height: themeTokens.layout.bottomNavSpacer }} aria-hidden />}

      {/* Shared drawers for all list items (actions + playlist selector) */}
      <SwipeableDrawer
        title={
          activeDrawerClimb ? (
            <DrawerClimbHeader climb={activeDrawerClimb} boardDetails={activeDrawerBoardDetails} />
          ) : undefined
        }
        placement="bottom"
        open={drawerMode === 'actions'}
        onClose={handleCloseDrawer}
        onTransitionEnd={handleDrawerTransitionEnd}
        styles={sharedDrawerStyles}
      >
        {activeDrawerClimb && (
          <ClimbActions
            climb={activeDrawerClimb}
            boardDetails={activeDrawerBoardDetails}
            angle={activeDrawerClimb.angle}
            currentPathname={pathname}
            viewMode="list"
            exclude={excludeActions}
            onOpenPlaylistSelector={handleSwitchToPlaylist}
            onActionComplete={handleCloseDrawer}
          />
        )}
      </SwipeableDrawer>

      <SwipeableDrawer
        title={
          activeDrawerClimb ? (
            <DrawerClimbHeader climb={activeDrawerClimb} boardDetails={activeDrawerBoardDetails} />
          ) : undefined
        }
        placement="bottom"
        open={drawerMode === 'playlist'}
        onClose={handleCloseDrawer}
        onTransitionEnd={handleDrawerTransitionEnd}
        styles={sharedPlaylistDrawerStyles}
      >
        {activeDrawerClimb && (
          <PlaylistSelectionContent
            climbUuid={activeDrawerClimb.uuid}
            boardDetails={activeDrawerBoardDetails}
            angle={activeDrawerClimb.angle}
            onDone={handleCloseDrawer}
          />
        )}
      </SwipeableDrawer>
    </Box>
  );
};

export default ClimbsList;
