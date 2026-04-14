'use client';
import React, { useEffect, useCallback, useState, useMemo, useRef, useImperativeHandle, forwardRef } from 'react';
import IconButton from '@mui/material/IconButton';
import Box from '@mui/material/Box';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import AppsOutlined from '@mui/icons-material/AppsOutlined';
import FormatListBulletedOutlined from '@mui/icons-material/FormatListBulletedOutlined';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { track } from '@vercel/analytics';
import dynamic from 'next/dynamic';
import { useDrawerDragResize } from '@/app/hooks/use-drawer-drag-resize';
import { useUpdateViewModePreference, type ViewMode } from '@/app/hooks/use-view-mode-preference';
import drawerCss from '../swipeable-drawer/swipeable-drawer.module.css';
import { Climb, BoardDetails } from '@/app/lib/types';
import ErrorBoundary from '../error-boundary';
import { themeTokens } from '@/app/theme/theme-config';
import { classifyClimbListChange } from './climb-list-utils';
import { getExcludedClimbActions } from '@/app/lib/climb-action-utils';
import { SelectionStoreContext, useSelectionStore } from './selected-climb-store';
import { dispatchOpenPlayDrawer } from '../queue-control/play-drawer-event';

const SwipeableDrawer = dynamic(() => import('../swipeable-drawer/swipeable-drawer'), { ssr: false });
const QueueDrawer = dynamic(() => import('../play-view/queue-drawer'), { ssr: false });
const DrawerClimbHeader = dynamic(() => import('../climb-card/drawer-climb-header'), { ssr: false });
const ClimbActions = dynamic(() => import('../climb-actions/climb-actions'), { ssr: false });
const PlaylistSelectionContent = dynamic(() => import('../climb-actions/playlist-selection-content'), { ssr: false });

export type { ViewMode };

// Static drawer style objects (hoisted to avoid per-render allocation)
const sharedDrawerStyles = {
  wrapper: {
    width: '100%',
    touchAction: 'pan-y' as const,
    transition: 'height 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
  },
  body: { padding: `${themeTokens.spacing[2]}px 0` },
  header: { paddingLeft: `${themeTokens.spacing[3]}px`, paddingRight: `${themeTokens.spacing[3]}px` },
} as const;

const sharedPlaylistDrawerStyles = {
  wrapper: { height: 'auto', maxHeight: '70vh', width: '100%' },
  body: { padding: 0 },
  header: { paddingLeft: `${themeTokens.spacing[3]}px`, paddingRight: `${themeTokens.spacing[3]}px` },
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

const SharedDrawers = React.memo(forwardRef<SharedDrawerHandle, SharedDrawersProps>(
  ({ boardDetails, resolveBoardDetails }, ref) => {
    const pathname = usePathname();
    const [activeDrawerClimb, setActiveDrawerClimb] = useState<Climb | null>(null);
    const [drawerMode, setDrawerMode] = useState<'actions' | 'playlist' | null>(null);

    // Queue list drawer state
    const [isQueueListOpen, setIsQueueListOpen] = useState(false);

    useImperativeHandle(ref, () => ({
      openActions: (climb: Climb) => {
        setActiveDrawerClimb(climb);
        setDrawerMode('actions');
      },
      openPlaylistSelector: (climb: Climb) => {
        setActiveDrawerClimb(climb);
        setDrawerMode('playlist');
      },
    }), []);

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
          <QueueDrawer
            open={isQueueListOpen}
            onClose={handleCloseQueueList}
            boardDetails={boardDetails}
          />
        )}
      </>
    );
  },
));
SharedDrawers.displayName = 'SharedDrawers';

/**
 * Props passed to the view-specific content render function.
 * The shell computes these from the raw props and provides them
 * so both list and grid content components share the same logic.
 */
export type ViewContentRenderProps = {
  visibleClimbs: Climb[];
  boardDetails: BoardDetails;
  resolveBoardDetails: (climb: Climb) => BoardDetails;
  initialImageCount: number;
  unsupportedClimbs?: Set<string>;
  upsizedClimbs?: Set<string>;
  isFetching: boolean;
  hasMore: boolean;
  climbs: Climb[];
  handleClimbClickByIndex: (index: number) => void;
  handleClimbThumbnailClickByIndex: (index: number) => void;
  handleNeedsBiggerBoard: () => void;
  handleOpenActions: (climb: Climb) => void;
  handleOpenPlaylistSelector: (climb: Climb) => void;
  addToQueue?: (climb: Climb) => void;
  handleLoadMore: () => void;
  renderItemExtra?: (climb: Climb) => React.ReactNode;
};

export type ClimbsListShellProps = {
  viewMode: ViewMode;
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
  children: (props: ViewContentRenderProps) => React.ReactNode;
};

const ClimbsListShell = ({
  viewMode,
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
  children,
}: ClimbsListShellProps) => {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const updateViewMode = useUpdateViewModePreference();

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

  const onClimbSelectRef = useRef(onClimbSelect);
  onClimbSelectRef.current = onClimbSelect;

  const handleLoadMore = useCallback(() => {
    track('Infinite Scroll Load More', {
      currentCount: climbs.length,
      hasMore,
    });
    onLoadMore();
  }, [climbs.length, hasMore, onLoadMore]);

  // Row click: activates the climb but does NOT open the play drawer.
  const handleClimbClickByIndex = useCallback((index: number) => {
    const climb = climbs[index];
    if (climb) {
      onClimbSelectRef.current?.(climb);
      track('Climb List Row Clicked', { climbUuid: climb.uuid });
    }
  }, [climbs]);

  // Thumbnail / card-cover click: activates the climb and opens the play drawer.
  const handleClimbThumbnailClickByIndex = useCallback((index: number) => {
    const climb = climbs[index];
    if (climb) {
      onClimbSelectRef.current?.(climb);
      dispatchOpenPlayDrawer();
      track('Climb List Cover Clicked', { climbUuid: climb.uuid });
    }
  }, [climbs]);

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

  // --- Shared drawers via imperative handle ---
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

  // --- View mode toggle URLs ---
  const search = searchParams.toString();
  const listUrl = useMemo(() => {
    const base = pathname.replace(/\/(list|grid)$/, '/list');
    return search ? `${base}?${search}` : base;
  }, [pathname, search]);
  const gridUrl = useMemo(() => {
    const base = pathname.replace(/\/(list|grid)$/, '/grid');
    return search ? `${base}?${search}` : base;
  }, [pathname, search]);

  const handleListClick = useCallback(() => updateViewMode('list'), [updateViewMode]);
  const handleGridClick = useCallback(() => updateViewMode('grid'), [updateViewMode]);

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

  const selectionStore = useSelectionStore(selectedClimbUuid ?? null);

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
            <Link href={listUrl} prefetch onClick={handleListClick}>
              <IconButton
                aria-label="List view"
                size="small"
                sx={listButtonSx}
                component="span"
              >
                <FormatListBulletedOutlined fontSize="small" />
              </IconButton>
            </Link>
            <Link href={gridUrl} prefetch onClick={handleGridClick}>
              <IconButton
                aria-label="Grid view"
                size="small"
                sx={gridButtonSx}
                component="span"
              >
                <AppsOutlined fontSize="small" />
              </IconButton>
            </Link>
          </Box>
          {angleSelector}
        </Box>
      </Box>

      <ErrorBoundary recoverable>
        {children({
          visibleClimbs,
          boardDetails,
          resolveBoardDetails,
          initialImageCount,
          unsupportedClimbs,
          upsizedClimbs,
          isFetching,
          hasMore,
          climbs,
          handleClimbClickByIndex,
          handleClimbThumbnailClickByIndex,
          handleNeedsBiggerBoard,
          handleOpenActions,
          handleOpenPlaylistSelector,
          addToQueue,
          handleLoadMore,
          renderItemExtra,
        })}
      </ErrorBoundary>

      {/* End message */}
      <Box sx={sentinelBoxSx}>
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

export default ClimbsListShell;
