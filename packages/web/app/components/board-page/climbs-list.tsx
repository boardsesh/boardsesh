'use client';
import React, { useEffect, useCallback, useState, useMemo, useRef, useImperativeHandle, forwardRef } from 'react';
import IconButton from '@mui/material/IconButton';
import Box from '@mui/material/Box';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import AppsOutlined from '@mui/icons-material/AppsOutlined';
import FormatListBulletedOutlined from '@mui/icons-material/FormatListBulletedOutlined';
import { usePathname } from 'next/navigation';
import { track } from '@vercel/analytics';
import dynamic from 'next/dynamic';
import { useIsDarkMode } from '@/app/hooks/use-is-dark-mode';
import { useDrawerDragResize } from '@/app/hooks/use-drawer-drag-resize';
import drawerCss from '../swipeable-drawer/swipeable-drawer.module.css';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { Climb, BoardDetails } from '@/app/lib/types';
import ErrorBoundary from '../error-boundary';
import ClimbListItem from '../climb-card/climb-list-item';
import { ClimbCardSkeleton, ClimbListItemSkeleton } from './board-page-skeleton';
import { themeTokens } from '@/app/theme/theme-config';
import { getPreference, setPreference } from '@/app/lib/user-preferences-db';
import { useInfiniteScroll } from '@/app/hooks/use-infinite-scroll';
import { classifyClimbListChange } from './climb-list-utils';
import SwipeHintOrchestrator from './swipe-hint-orchestrator';
import { getExcludedClimbActions } from '@/app/lib/climb-action-utils';
import { SelectionStoreContext, useSelectionStore } from './selected-climb-store';
import { dispatchOpenPlayDrawer } from '../queue-control/play-drawer-event';
import listStyles from './climbs-list.module.css';

const SwipeableDrawer = dynamic(() => import('../swipeable-drawer/swipeable-drawer'), {
  ssr: false,
});
const QueueDrawer = dynamic(() => import('../play-view/queue-drawer'), { ssr: false });
const DrawerClimbHeader = dynamic(() => import('../climb-card/drawer-climb-header'), {
  ssr: false,
});
const ClimbActions = dynamic(() => import('../climb-actions/climb-actions'), { ssr: false });
const PlaylistSelectionContent = dynamic(() => import('../climb-actions/playlist-selection-content'), { ssr: false });
const ClimbCard = dynamic(() => import('../climb-card/climb-card'), { ssr: false });

type ViewMode = 'grid' | 'list';

const VIEW_MODE_PREFERENCE_KEY = 'climbListViewMode';

// Static drawer style objects (hoisted to avoid per-render allocation)
const sharedDrawerStyles = {
  wrapper: {
    width: '100%',
    touchAction: 'pan-y' as const,
    transition: themeTokens.transitions.drawerHeight,
  },
  body: { padding: `${themeTokens.spacing[2]}px 0` },
  header: {
    paddingLeft: `${themeTokens.spacing[3]}px`,
    paddingRight: `${themeTokens.spacing[3]}px`,
  },
} as const;

const sharedPlaylistDrawerStyles = {
  wrapper: { height: 'auto', maxHeight: '70vh', width: '100%' },
  body: { padding: 0 },
  header: {
    paddingLeft: `${themeTokens.spacing[3]}px`,
    paddingRight: `${themeTokens.spacing[3]}px`,
  },
} as const;

// --- Shared drawers extracted into a sibling component ---
// Owns its own state so drawer open/close never re-renders the item list.
export type SharedDrawerHandle = {
  openActions: (climb: Climb) => void;
  openPlaylistSelector: (climb: Climb) => void;
};

type SharedDrawersProps = {
  boardDetails: BoardDetails;
  resolveBoardDetails: (climb: Climb) => BoardDetails;
};

const SharedDrawers = React.memo(
  forwardRef<SharedDrawerHandle, SharedDrawersProps>(({ boardDetails, resolveBoardDetails }, ref) => {
    const pathname = usePathname();
    const [activeDrawerClimb, setActiveDrawerClimb] = useState<Climb | null>(null);
    const [drawerMode, setDrawerMode] = useState<'actions' | 'playlist' | null>(null);

    // Queue list drawer state
    const [isQueueListOpen, setIsQueueListOpen] = useState(false);

    useImperativeHandle(
      ref,
      () => ({
        openActions: (climb: Climb) => {
          setActiveDrawerClimb(climb);
          setDrawerMode('actions');
        },
        openPlaylistSelector: (climb: Climb) => {
          setActiveDrawerClimb(climb);
          setDrawerMode('playlist');
        },
      }),
      [],
    );

    const handleCloseDrawer = useCallback(() => setDrawerMode(null), []);

    const { paperRef: actionsPaperRef, dragHandlers: actionsDragHandlers } = useDrawerDragResize({
      open: drawerMode === 'actions',
      onClose: handleCloseDrawer,
    });
    const handleSwitchToPlaylist = useCallback(() => setDrawerMode('playlist'), []);
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

    // --- Queue list drawer handlers ---
    const handleGoToQueue = useCallback(() => {
      handleCloseDrawer();
      setIsQueueListOpen(true);
    }, [handleCloseDrawer]);

    const handleCloseQueueList = useCallback(() => {
      setIsQueueListOpen(false);
    }, []);

    return (
      <>
        <SwipeableDrawer
          placement="bottom"
          title={
            activeDrawerClimb ? (
              <div data-swipe-blocked="" {...actionsDragHandlers} className={drawerCss.dragHeaderWrapper}>
                <DrawerClimbHeader climb={activeDrawerClimb} boardDetails={activeDrawerBoardDetails} />
              </div>
            ) : undefined
          }
          height="60%"
          paperRef={actionsPaperRef}
          open={drawerMode === 'actions'}
          onClose={handleCloseDrawer}
          onTransitionEnd={handleDrawerTransitionEnd}
          swipeEnabled={false}
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
              onGoToQueue={handleGoToQueue}
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

        {isQueueListOpen && (
          <QueueDrawer open={isQueueListOpen} onClose={handleCloseQueueList} boardDetails={boardDetails} />
        )}
      </>
    );
  }),
);
SharedDrawers.displayName = 'SharedDrawers';

export type ClimbsListProps = {
  boardDetails: BoardDetails;
  boardDetailsByClimb?: Record<string, BoardDetails>;
  unsupportedClimbs?: Set<string>;
  upsizedClimbs?: Set<string>;
  initialImageCount?: number;
  climbs: Climb[];
  selectedClimbUuid?: string | null;
  isFetching: boolean;
  hasMore: boolean;
  onClimbSelect?: (climb: Climb) => void;
  addToQueue?: (climb: Climb) => void;
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

type GridClimbItemProps = {
  climb: Climb;
  index: number;
  boardDetails: BoardDetails;
  preferImageLayers: boolean;
  unsupported?: boolean;
  needsBiggerBoard?: boolean;
  onClimbClickByIndex: (index: number) => void;
  onNeedsBiggerBoard?: () => void;
  renderItemExtra?: (climb: Climb) => React.ReactNode;
};

const GridClimbItem = React.memo(function GridClimbItem({
  climb,
  index,
  boardDetails,
  preferImageLayers,
  unsupported,
  needsBiggerBoard,
  onClimbClickByIndex,
  onNeedsBiggerBoard,
  renderItemExtra,
}: GridClimbItemProps) {
  const handleCoverClick = useCallback(() => {
    if (needsBiggerBoard) {
      onNeedsBiggerBoard?.();
      return;
    }
    onClimbClickByIndex(index);
  }, [onClimbClickByIndex, index, needsBiggerBoard, onNeedsBiggerBoard]);
  return (
    <>
      <div {...(index === 0 ? { id: 'onboarding-climb-card' } : {})}>
        <ClimbCard
          climb={climb}
          boardDetails={boardDetails}
          preferImageLayers={preferImageLayers}
          onCoverClick={handleCoverClick}
          unsupported={unsupported || needsBiggerBoard}
        />
      </div>
      {renderItemExtra?.(climb)}
    </>
  );
});

const ClimbsList = ({
  boardDetails,
  boardDetailsByClimb,
  unsupportedClimbs,
  upsizedClimbs,
  initialImageCount = 0,
  climbs,
  selectedClimbUuid,
  isFetching,
  hasMore,
  onClimbSelect,
  addToQueue,
  onLoadMore,
  header,
  headerInline,
  angleSelector,
  hideEndMessage,
  renderItemExtra,
  showBottomSpacer,
}: ClimbsListProps) => {
  // Hoisted once so every ClimbListItem receives the value as a prop
  // instead of each one doing its own context lookup.
  const pathname = usePathname();
  const isDark = useIsDarkMode();
  // Show the first batch immediately, then reveal the rest on the next frame.
  // Only batch when the list is replaced (new search), not when items are appended (infinite scroll)
  // — otherwise the height shrinks and the page jumps.
  const INITIAL_BATCH = 6;
  const [visibleCount, setVisibleCount] = useState(climbs.length);
  const prevClimbsRef = useRef(climbs);

  if (climbs !== prevClimbsRef.current) {
    const prevClimbs = prevClimbsRef.current;
    prevClimbsRef.current = climbs;

    const changeType = classifyClimbListChange(climbs, prevClimbs);

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

  const handleListView = useCallback(() => handleViewModeChange('list'), [handleViewModeChange]);
  const handleGridView = useCallback(() => handleViewModeChange('grid'), [handleViewModeChange]);

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

  // Row click: activates the climb but does NOT open the play drawer.
  // Only the thumbnail (list mode) or card cover (grid mode) opens the drawer.
  const handleClimbClickByIndex = useCallback(
    (index: number) => {
      const climb = climbs[index];
      if (climb) {
        onClimbSelectRef.current?.(climb);
        track('Climb List Row Clicked', { climbUuid: climb.uuid });
      }
    },
    [climbs],
  );

  // Thumbnail / card-cover click: activates the climb and opens the play drawer.
  const handleClimbThumbnailClickByIndex = useCallback(
    (index: number) => {
      const climb = climbs[index];
      if (climb) {
        onClimbSelectRef.current?.(climb);
        dispatchOpenPlayDrawer();
        track('Climb List Cover Clicked', { climbUuid: climb.uuid });
      }
    },
    [climbs],
  );

  const resolveBoardDetails = useCallback(
    (climb: Climb): BoardDetails => {
      if (boardDetailsByClimb) {
        const resolved = boardDetailsByClimb[climb.uuid];
        if (resolved) return resolved;
      }
      return boardDetails;
    },
    [boardDetails, boardDetailsByClimb],
  );

  // --- Shared drawers via imperative handle (state lives in SharedDrawers, not here) ---
  const drawerRef = useRef<SharedDrawerHandle>(null);

  const [biggerBoardOpen, setBiggerBoardOpen] = useState(false);
  const handleNeedsBiggerBoard = useCallback(() => setBiggerBoardOpen(true), []);
  const handleCloseBiggerBoard = useCallback(() => setBiggerBoardOpen(false), []);

  const handleOpenActions = useCallback((climb: Climb) => {
    if (process.env.NODE_ENV !== 'production' && !drawerRef.current) {
      console.warn('SharedDrawers ref not attached — openActions is a no-op');
    }
    drawerRef.current?.openActions(climb);
  }, []);

  const handleOpenPlaylistSelector = useCallback((climb: Climb) => {
    if (process.env.NODE_ENV !== 'production' && !drawerRef.current) {
      console.warn('SharedDrawers ref not attached — openPlaylistSelector is a no-op');
    }
    drawerRef.current?.openPlaylistSelector(climb);
  }, []);

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

  const listButtonSx = useMemo(() => ({ padding: '4px', opacity: viewMode === 'list' ? 1 : 0.4 }), [viewMode]);
  const gridButtonSx = useMemo(() => ({ padding: '4px', opacity: viewMode === 'grid' ? 1 : 0.4 }), [viewMode]);

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

  // External store for selected climb UUID — items subscribe individually via
  // useSyncExternalStore so only 2 items re-render on selection change (old + new),
  // without the parent list needing to iterate all items.
  const selectionStore = useSelectionStore(selectedClimbUuid ?? null);

  // --- List virtualization ---
  // Only ~40-50 items are mounted at a time instead of 600+.
  // Overscan of 25 items (1800px) provides enough headroom so that fast scrolling
  // never outpaces the render cycle and causes a blank screen.
  const virtualizer = useWindowVirtualizer({
    count: visibleClimbs.length,
    estimateSize: () => 107,
    overscan: 25,
    getItemKey: (index) => visibleClimbs[index]?.uuid ?? index,
    // Provide a fake viewport so the virtualizer renders items during SSR.
    // Without this, getVirtualItems() returns [] on the server and the
    // climb list is entirely client-rendered (hurts LCP).
    initialRect: { width: 375, height: 812 },
  });

  const virtualItems = virtualizer.getVirtualItems();

  // Virtualizer-based infinite scroll for list mode
  const lastVirtualItem = virtualItems[virtualItems.length - 1];
  useEffect(() => {
    if (viewMode !== 'list' || !lastVirtualItem) return;
    if (lastVirtualItem.index >= visibleClimbs.length - 5 && hasMore && !isFetching) {
      handleLoadMore();
    }
  }, [viewMode, lastVirtualItem?.index, visibleClimbs.length, hasMore, isFetching, handleLoadMore]);

  return (
    <SelectionStoreContext.Provider value={selectionStore}>
      <Box>
        {header}
        {/* Header: Search pills (left, scrollable) | View toggle + Angle selector (right) */}
        <Box sx={headerContainerSx}>
          {/* Left: Search pills (scrollable) */}
          <Box sx={searchPillsContainerSx}>{headerInline}</Box>
          {/* Right: View toggle + Angle selector */}
          <Box sx={rightControlsSx}>
            <Box sx={viewModeToggleBoxSx}>
              <IconButton onClick={handleListView} aria-label="List view" size="small" sx={listButtonSx}>
                <FormatListBulletedOutlined fontSize="small" />
              </IconButton>
              <IconButton onClick={handleGridView} aria-label="Grid view" size="small" sx={gridButtonSx}>
                <AppsOutlined fontSize="small" />
              </IconButton>
            </Box>
            {angleSelector}
          </Box>
        </Box>

        <ErrorBoundary recoverable>
          {viewMode === 'grid' ? (
            /* Grid (card) mode — not virtualized */
            <Box sx={gridContainerSx} translate="no">
              {visibleClimbs.map((climb, index) => (
                <Box key={climb.uuid} sx={cardBoxSx} className={listStyles.gridItem}>
                  <GridClimbItem
                    climb={climb}
                    index={index}
                    boardDetails={resolveBoardDetails(climb)}
                    preferImageLayers={index < initialImageCount}
                    unsupported={unsupportedClimbs?.has(climb.uuid)}
                    needsBiggerBoard={upsizedClimbs?.has(climb.uuid)}
                    onClimbClickByIndex={handleClimbThumbnailClickByIndex}
                    onNeedsBiggerBoard={handleNeedsBiggerBoard}
                    renderItemExtra={renderItemExtra}
                  />
                </Box>
              ))}
              {isFetching && (!climbs || climbs.length === 0) ? (
                <ClimbsListSkeleton aspectRatio={boardDetails.boardWidth / boardDetails.boardHeight} viewMode="grid" />
              ) : null}
            </Box>
          ) : (
            /* List mode — virtualized via @tanstack/react-virtual */
            <div translate="no">
              {isFetching && climbs.length === 0 ? (
                <ClimbsListSkeleton aspectRatio={boardDetails.boardWidth / boardDetails.boardHeight} viewMode="list" />
              ) : (
                <div
                  style={{
                    height: virtualizer.getTotalSize(),
                    width: '100%',
                    position: 'relative',
                    backgroundColor: 'inherit',
                  }}
                >
                  {virtualItems.map((virtualItem) => {
                    const climb = visibleClimbs[virtualItem.index];
                    const index = virtualItem.index;
                    if (!climb) return null;
                    return (
                      <div
                        key={virtualItem.key}
                        ref={virtualizer.measureElement}
                        data-index={virtualItem.index}
                        {...(index === 0 ? { id: 'onboarding-climb-card' } : {})}
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: '100%',
                          transform: `translateY(${virtualItem.start}px)`,
                          contain: 'layout style paint',
                        }}
                      >
                        <ClimbListItem
                          climb={climb}
                          boardDetails={resolveBoardDetails(climb)}
                          pathname={pathname}
                          isDark={isDark}
                          preferImageLayers={index < initialImageCount}
                          fetchPriority={index === 0 ? 'high' : undefined}
                          onSelect={() => handleClimbClickByIndex(index)}
                          onThumbnailClick={() => handleClimbThumbnailClickByIndex(index)}
                          disableSwipe={!hydrated}
                          unsupported={unsupportedClimbs?.has(climb.uuid)}
                          needsBiggerBoard={upsizedClimbs?.has(climb.uuid)}
                          onNeedsBiggerBoard={handleNeedsBiggerBoard}
                          onOpenActions={handleOpenActions}
                          onOpenPlaylistSelector={handleOpenPlaylistSelector}
                          addToQueue={addToQueue}
                        />
                        {renderItemExtra?.(climb)}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </ErrorBoundary>

        {viewMode === 'list' && climbs.length > 0 && <SwipeHintOrchestrator />}

        {/* Sentinel for infinite scroll — only needed for grid mode (list mode uses virtualizer) */}
        <Box ref={viewMode === 'grid' ? sentinelRef : undefined} sx={sentinelBoxSx}>
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

        {/* Shared drawers — owns its own state so open/close doesn't re-render the list */}
        <SharedDrawers ref={drawerRef} boardDetails={boardDetails} resolveBoardDetails={resolveBoardDetails} />

        <Snackbar
          open={biggerBoardOpen}
          autoHideDuration={4000}
          onClose={handleCloseBiggerBoard}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        >
          <Alert severity="warning" onClose={handleCloseBiggerBoard} variant="filled">
            <AlertTitle>Won&apos;t fit your board</AlertTitle>
            This one runs off the edge of your wall. You&apos;ll need a bigger size to send it.
          </Alert>
        </Snackbar>
      </Box>
    </SelectionStoreContext.Provider>
  );
};

export default ClimbsList;
