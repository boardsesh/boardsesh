'use client';

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, useMemo, useDeferredValue } from 'react';
import MuiBadge from '@mui/material/Badge';
import MuiButton from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import SyncOutlined from '@mui/icons-material/SyncOutlined';
import FavoriteBorderOutlined from '@mui/icons-material/FavoriteBorderOutlined';
import Favorite from '@mui/icons-material/Favorite';
import SkipPreviousOutlined from '@mui/icons-material/SkipPreviousOutlined';
import SkipNextOutlined from '@mui/icons-material/SkipNextOutlined';
import MoreHorizOutlined from '@mui/icons-material/MoreHorizOutlined';
import FormatListBulletedOutlined from '@mui/icons-material/FormatListBulletedOutlined';
import DeleteOutlined from '@mui/icons-material/DeleteOutlined';
import EditOutlined from '@mui/icons-material/EditOutlined';
import CloseOutlined from '@mui/icons-material/CloseOutlined';
import HistoryOutlined from '@mui/icons-material/HistoryOutlined';
import CheckOutlined from '@mui/icons-material/CheckOutlined';
import { usePathname } from 'next/navigation';
import { useQueueActions, useCurrentClimb, useQueueList, useSessionData } from '../graphql-queue';
import { ClimbActions } from '../climb-actions';
import { useDoubleTapFavorite } from '../climb-actions/use-double-tap-favorite';
import HeartAnimationOverlay from '../climb-card/heart-animation-overlay';
import PlaylistSelectionContent from '../climb-actions/playlist-selection-content';
import DrawerClimbHeader from '../climb-card/drawer-climb-header';
import { ShareBoardButton } from '../board-page/share-button';
import { useBoardProvider } from '../board-provider/board-provider-context';
import QueueList, { QueueListHandle } from '../queue-control/queue-list';
import SwipeBoardCarousel from '../board-renderer/swipe-board-carousel';
import { useWakeLock } from '../board-bluetooth-control/use-wake-lock';
import { themeTokens } from '@/app/theme/theme-config';
import SwipeableDrawer from '../swipeable-drawer/swipeable-drawer';
import ClimbDetailHeader from '@/app/components/climb-detail/climb-detail-header';
import { LogAscentDrawer } from '../logbook/log-ascent-drawer';
import type { ActiveDrawer } from '../queue-control/queue-control-bar';
import type { BoardDetails, Angle, Climb } from '@/app/lib/types';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import styles from './play-view-drawer.module.css';
import drawerStyles from '../swipeable-drawer/swipeable-drawer.module.css';
import ClimbDetailShellClient from '@/app/components/climb-detail/climb-detail-shell.client';
import { useBuildClimbDetailSections } from '@/app/components/climb-detail/build-climb-detail-sections';



const QUEUE_DRAWER_STYLES = {
  wrapper: {
    touchAction: 'pan-y' as const,
    transition: 'height 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
  },
  body: { padding: 0, touchAction: 'pan-y' as const },
} as const;

interface PlayDrawerContentProps {
  climb: Climb;
  boardType: string;
  angle: number;
  aboveFold: React.ReactNode;
}

const PlayDrawerContent = React.memo<PlayDrawerContentProps>(({ climb, boardType, angle, aboveFold }) => {
  const sections = useBuildClimbDetailSections({
    climb,
    climbUuid: climb.uuid,
    boardType,
    angle,
    currentClimbDifficulty: climb.difficulty ?? undefined,
    boardName: boardType,
  });

  return <ClimbDetailShellClient mode="play" sections={sections} aboveFold={aboveFold} />;
});
PlayDrawerContent.displayName = 'PlayDrawerContent';

interface PlayViewDrawerProps {
  activeDrawer: ActiveDrawer;
  setActiveDrawer: (drawer: ActiveDrawer) => void;
  boardDetails: BoardDetails;
  angle: Angle;
}


const PlayViewDrawer: React.FC<PlayViewDrawerProps> = ({
  activeDrawer,
  setActiveDrawer,
  boardDetails,
  angle,
}) => {
  const isOpen = activeDrawer === 'play';
  const [isActionsOpen, setIsActionsOpen] = useState(false);
  const [isQueueOpen, setIsQueueOpen] = useState(false);
  const [isPlaylistSelectorOpen, setIsPlaylistSelectorOpen] = useState(false);
  const [isTickDrawerOpen, setIsTickDrawerOpen] = useState(false);
  const [isEditMode, setIsEditMode] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const queueDrawerHeightRef = useRef('60%');
  const queuePaperRef = useRef<HTMLDivElement>(null);

  const updateQueueDrawerHeight = useCallback((height: string) => {
    queueDrawerHeightRef.current = height;
    if (queuePaperRef.current) {
      queuePaperRef.current.style.height = height;
    }
  }, []);
  const pathname = usePathname();
  const queueListRef = useRef<QueueListHandle>(null);
  const queueScrollRef = useRef<HTMLDivElement>(null);
  const [queueScrollEl, setQueueScrollEl] = useState<HTMLDivElement | null>(null);

  // Get logbook data for tick FAB badge
  const { logbook } = useBoardProvider();

  const queueScrollCallbackRef = useCallback((node: HTMLDivElement | null) => {
    queueScrollRef.current = node;
    setQueueScrollEl(node);
  }, []);

  // Fine-grained context hooks (only re-render when specific data changes)
  const currentClimbData = useCurrentClimb();
  const queueListData = useQueueList();
  const sessionData = useSessionData();

  // When the drawer is closed, defer context updates so they don't block the main
  // thread. React will batch these into low-priority renders that yield to user input.
  const deferredCurrentClimb = useDeferredValue(currentClimbData);
  const deferredQueue = useDeferredValue(queueListData);
  const deferredSession = useDeferredValue(sessionData);

  // Use immediate values when open (responsive), deferred when closed (non-blocking)
  const { currentClimb, currentClimbQueueItem } = isOpen ? currentClimbData : deferredCurrentClimb;
  const { queue } = isOpen ? queueListData : deferredQueue;
  const { viewOnlyMode } = isOpen ? sessionData : deferredSession;
  const {
    mirrorClimb,
    setQueue,
    getNextClimbQueueItem,
    getPreviousClimbQueueItem,
    setCurrentClimbQueueItem,
  } = useQueueActions();

  const {
    handleDoubleTap,
    showHeart,
    dismissHeart,
    isFavorited,
    toggleFavorite,
  } = useDoubleTapFavorite({
    climbUuid: currentClimb?.uuid ?? '',
  });

  const currentQueueIndex = currentClimbQueueItem
    ? queue.findIndex(item => item.uuid === currentClimbQueueItem.uuid)
    : -1;
  const remainingQueueCount = currentQueueIndex >= 0 ? queue.length - currentQueueIndex : queue.length;

  // Wake lock when drawer is open
  useWakeLock(isOpen);

  const handleToggleSelect = useCallback((uuid: string) => {
    setSelectedItems((prev) => {
      const next = new Set(prev);
      if (next.has(uuid)) {
        next.delete(uuid);
      } else {
        next.add(uuid);
      }
      return next;
    });
  }, []);

  const handleBulkRemove = useCallback(() => {
    setQueue(queue.filter((item) => !selectedItems.has(item.uuid)));
    setSelectedItems(new Set());
    setIsEditMode(false);
  }, [queue, selectedItems, setQueue]);

  const handleExitEditMode = useCallback(() => {
    setIsEditMode(false);
    setSelectedItems(new Set());
  }, []);

  // Drag-to-resize handlers for queue drawer header
  const dragStartY = useRef<number>(0);
  const dragStartHeightRef = useRef<string>('60%');
  const isDragGestureRef = useRef(false);

  const handleQueueDragStart = useCallback((e: React.TouchEvent) => {
    dragStartY.current = e.touches[0].clientY;
    dragStartHeightRef.current = queueDrawerHeightRef.current;
    isDragGestureRef.current = false;
  }, []);

  const handleQueueDragMove = useCallback((e: React.TouchEvent) => {
    const delta = Math.abs(e.touches[0].clientY - dragStartY.current);
    if (delta > 10) {
      isDragGestureRef.current = true;
    }
  }, []);

  const handleQueueDragEnd = useCallback((e: React.TouchEvent) => {
    if (!isDragGestureRef.current) return;

    const deltaY = e.changedTouches[0].clientY - dragStartY.current;
    const THRESHOLD = 30;

    if (deltaY < -THRESHOLD) {
      // Dragged up → expand to 100%
      updateQueueDrawerHeight('100%');
    } else if (deltaY > THRESHOLD) {
      if (dragStartHeightRef.current === '100%') {
        // Dragged down from 100% → collapse to 60%
        updateQueueDrawerHeight('60%');
      } else {
        // Dragged down from 60% → close drawer
        setIsQueueOpen(false);
        handleExitEditMode();
        setShowHistory(false);
      }
    }
  }, [handleExitEditMode, updateQueueDrawerHeight]);

  // Reset drawer height when queue drawer closes
  useEffect(() => {
    if (!isQueueOpen) {
      updateQueueDrawerHeight('60%');
    }
  }, [isQueueOpen, updateQueueDrawerHeight]);

  // Hash-based back button support
  useEffect(() => {
    if (!isOpen) return;

    window.history.pushState(null, '', '#playing');

    const handlePopState = () => {
      setActiveDrawer('none');
    };

    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('popstate', handlePopState);
      if (window.location.hash === '#playing') {
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
      }
    };
  }, [isOpen, setActiveDrawer]);

  const handleClose = useCallback(() => {
    if (isActionsOpen || isQueueOpen || isPlaylistSelectorOpen || isTickDrawerOpen) return;
    // Set drawerOpen false directly so React batches it with the parent state
    // update in a single render. This avoids a multi-cycle delay that would
    // leave the Paper sitting at the swipe position after a fling gesture.
    setDrawerOpen(false);
    setActiveDrawer('none');
    if (window.location.hash === '#playing') {
      window.history.back();
    }
  }, [setActiveDrawer, isActionsOpen, isQueueOpen, isPlaylistSelectorOpen, isTickDrawerOpen]);

  // Compute ascent info for tick FAB badge
  const currentAngle = typeof angle === 'string' ? parseInt(angle, 10) : angle;
  const filteredLogbook = useMemo(() => {
    if (!logbook || !currentClimb) return [];
    return logbook.filter(
      (asc) => asc.climb_uuid === currentClimb.uuid && Number(asc.angle) === currentAngle
    );
  }, [logbook, currentClimb, currentAngle]);

  const hasSuccessfulAscent = filteredLogbook.some((asc) => asc.is_ascent);
  const ascentCount = filteredLogbook.length;

  // Card-swipe navigation
  const nextItem = getNextClimbQueueItem();
  const prevItem = getPreviousClimbQueueItem();

  const handleSwipeNext = useCallback(() => {
    const next = getNextClimbQueueItem();
    if (!next || viewOnlyMode) return;
    setCurrentClimbQueueItem(next);
  }, [getNextClimbQueueItem, setCurrentClimbQueueItem, viewOnlyMode]);

  const handleSwipePrevious = useCallback(() => {
    const prev = getPreviousClimbQueueItem();
    if (!prev || viewOnlyMode) return;
    setCurrentClimbQueueItem(prev);
  }, [getPreviousClimbQueueItem, setCurrentClimbQueueItem, viewOnlyMode]);

  const canSwipeNext = !viewOnlyMode && !!nextItem;
  const canSwipePrevious = !viewOnlyMode && !!prevItem;

  const isMirrored = !!currentClimb?.mirrored;

  // Two-phase open: mount content first, then open the drawer on the next
  // animation frame. This ensures the Slide animation runs on an already-
  // rendered Paper instead of competing with heavy content mounting for the
  // main thread.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [showContent, setShowContent] = useState(false);
  const openRafRef = useRef<number>(0);

  // Close path: runs before paint so the Slide exit animation starts immediately
  // (especially important after a fling where the Paper is at a mid-swipe position)
  useLayoutEffect(() => {
    if (!isOpen) {
      cancelAnimationFrame(openRafRef.current);
      setDrawerOpen(false);
    }
  }, [isOpen]);

  // Open path: mount content first, then open drawer after browser has painted
  useEffect(() => {
    if (isOpen) {
      setShowContent(true);
      openRafRef.current = requestAnimationFrame(() => {
        openRafRef.current = requestAnimationFrame(() => {
          setDrawerOpen(true);
        });
      });
    }
    return () => cancelAnimationFrame(openRafRef.current);
  }, [isOpen]);

  const handleTransitionEnd = useCallback((open: boolean) => {
    if (!open) setShowContent(false);
  }, []);

  return (
    <>
    <SwipeableDrawer
      placement="bottom"
      height="100%"
      fullHeight
      open={drawerOpen}
      onClose={handleClose}
      onTransitionEnd={handleTransitionEnd}
      keepMounted
      swipeEnabled={!isActionsOpen && !isQueueOpen && !isPlaylistSelectorOpen}
      showDragHandle={true}
      styles={{
        body: { padding: 0, overflow: 'hidden' },
        wrapper: { height: '100%', backgroundColor: 'var(--semantic-background)' },
      }}
    >
      {showContent ? (<>
      <div className={styles.drawerContent}>
        {currentClimb ? (
          <PlayDrawerContent
            climb={currentClimb}
            boardType={boardDetails.board_name}
            angle={currentAngle}
            aboveFold={
            <>
              {/* Header: Grade | Name | Angle Selector */}
              <div className={styles.headerSection}>
                <ClimbDetailHeader
                  climb={currentClimb}
                  boardDetails={boardDetails}
                  angle={currentAngle}
                  isAngleAdjustable={true}
                />
              </div>

              {/* Board renderer with card-swipe and floating Tick FAB */}
              <div className={styles.boardSectionWrapper}>
                {currentClimb && (
                  <SwipeBoardCarousel
                    boardDetails={boardDetails}
                    currentClimb={currentClimb}
                    nextClimb={nextItem?.climb}
                    previousClimb={prevItem?.climb}
                    onSwipeNext={handleSwipeNext}
                    onSwipePrevious={handleSwipePrevious}
                    canSwipeNext={canSwipeNext}
                    canSwipePrevious={canSwipePrevious}
                    className={styles.boardSection}
                    boardContainerClassName={styles.swipeCardContainer}
                    fillContainer
                    onDoubleTap={handleDoubleTap}
                    showZoomHint
                    isDrawerOpen={isOpen}
                    overlay={<HeartAnimationOverlay visible={showHeart} onAnimationEnd={dismissHeart} />}
                  />
                )}

                {/* Floating Tick FAB - Spotify style */}
                <div className={styles.tickFabContainer}>
                  <button
                    className={`${styles.tickFab} ${hasSuccessfulAscent ? styles.tickFabSuccess : ''}`}
                    onClick={() => setIsTickDrawerOpen(true)}
                    aria-label="Log ascent"
                  >
                    <CheckOutlined className={styles.tickFabIcon} />
                    {ascentCount > 0 && (
                      <span className={styles.tickFabBadge}>{ascentCount}</span>
                    )}
                  </button>
                </div>
              </div>

              <div className={styles.actionBar}>
            <IconButton
              disabled={!canSwipePrevious}
              onClick={() => {
                const prev = getPreviousClimbQueueItem();
                if (prev) setCurrentClimbQueueItem(prev);
              }}
            >
              <SkipPreviousOutlined />
            </IconButton>

            {/* Mirror */}
            {boardDetails.supportsMirroring && (
              <IconButton
                color={isMirrored ? 'primary' : 'default'}
                onClick={() => mirrorClimb()}
                sx={
                  isMirrored
                    ? { backgroundColor: themeTokens.colors.purple, borderColor: themeTokens.colors.purple, color: 'common.white', '&:hover': { backgroundColor: themeTokens.colors.purple } }
                    : undefined
                }
              >
                <SyncOutlined />
              </IconButton>
            )}

            {/* Favorite */}
            <IconButton
              onClick={() => toggleFavorite()}
            >
              {isFavorited ? <Favorite sx={{ color: themeTokens.colors.error }} /> : <FavoriteBorderOutlined />}
            </IconButton>

            {/* Party / LED */}
            <ShareBoardButton />

            {/* More actions */}
            <IconButton
              onClick={() => {
                setIsQueueOpen(false);
                setIsPlaylistSelectorOpen(false);
                setIsActionsOpen(true);
              }}
              aria-label="Climb actions"
            >
              <MoreHorizOutlined />
            </IconButton>

            {/* Queue */}
            <MuiBadge badgeContent={remainingQueueCount} max={99} sx={{ '& .MuiBadge-badge': { backgroundColor: themeTokens.colors.primary, color: 'common.white' } }}>
              <IconButton
                onClick={() => {
                  setIsActionsOpen(false);
                  setIsPlaylistSelectorOpen(false);
                  setIsQueueOpen(true);
                }}
                aria-label="Open queue"
              >
                <FormatListBulletedOutlined />
              </IconButton>
            </MuiBadge>

            <IconButton
              disabled={!canSwipeNext}
              onClick={() => {
                const next = getNextClimbQueueItem();
                if (next) setCurrentClimbQueueItem(next);
              }}
            >
              <SkipNextOutlined />
            </IconButton>
              </div>
            </>
            }
          />
        ) : (
          <ClimbDetailShellClient mode="play" sections={[]} aboveFold={null} />
        )}
      </div>

        {/* Climb actions drawer */}
        {currentClimb && (
          <SwipeableDrawer
            title={<DrawerClimbHeader climb={currentClimb} boardDetails={boardDetails} />}
            placement="bottom"
            open={isActionsOpen}
            onClose={() => setIsActionsOpen(false)}
            disablePortal
            styles={{
              wrapper: { height: 'auto' },
              body: { padding: `${themeTokens.spacing[2]}px 0` },
              header: { paddingLeft: `${themeTokens.spacing[3]}px`, paddingRight: `${themeTokens.spacing[3]}px` },
            }}
          >
            <ClimbActions
              climb={currentClimb}
              boardDetails={boardDetails}
              angle={currentAngle}
              currentPathname={pathname}
              viewMode="list"
              onOpenPlaylistSelector={() => {
                setIsActionsOpen(false);
                setIsPlaylistSelectorOpen(true);
              }}
              onActionComplete={() => setIsActionsOpen(false)}
            />
          </SwipeableDrawer>
        )}

        {/* Playlist selector drawer */}
        {currentClimb && (
          <SwipeableDrawer
            title={<DrawerClimbHeader climb={currentClimb} boardDetails={boardDetails} />}
            placement="bottom"
            open={isPlaylistSelectorOpen}
            onClose={() => setIsPlaylistSelectorOpen(false)}
            disablePortal
            styles={{
              wrapper: { height: 'auto', maxHeight: '70vh' },
              body: { padding: 0 },
              header: { paddingLeft: `${themeTokens.spacing[3]}px`, paddingRight: `${themeTokens.spacing[3]}px` },
            }}
          >
            <PlaylistSelectionContent
              climbUuid={currentClimb.uuid}
              boardDetails={boardDetails}
              angle={currentAngle}
              onDone={() => setIsPlaylistSelectorOpen(false)}
            />
          </SwipeableDrawer>
        )}

        {/* Tick / Log Ascent drawer */}
        {currentClimb && (
          <LogAscentDrawer
            open={isTickDrawerOpen}
            onClose={() => setIsTickDrawerOpen(false)}
            currentClimb={currentClimb}
            boardDetails={boardDetails}
          />
        )}
      </>) : null}

        {/* Queue list drawer */}
        <SwipeableDrawer
          placement="bottom"
          height="60%"
          paperRef={queuePaperRef}
          open={isQueueOpen}
          showCloseButton={false}
          swipeEnabled={false}
          showDragHandle={false}
          disablePortal
          onClose={() => {
            setIsQueueOpen(false);
            handleExitEditMode();
            setShowHistory(false);
          }}
          onTransitionEnd={(open) => {
            if (open) {
              setTimeout(() => {
                queueListRef.current?.scrollToCurrentClimb();
              }, 100);
            }
          }}
          styles={QUEUE_DRAWER_STYLES}
        >
          {/* Custom drag header — resize only on deliberate drag, not scroll */}
          <div
            className={styles.queueDragHeader}
            onTouchStart={handleQueueDragStart}
            onTouchMove={handleQueueDragMove}
            onTouchEnd={handleQueueDragEnd}
          >
            <div className={drawerStyles.dragHandleZoneHorizontal}>
              <div className={drawerStyles.dragHandleBarHorizontal} />
            </div>
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: `${themeTokens.spacing[4]}px ${themeTokens.spacing[6]}px`,
                borderBottom: '1px solid var(--neutral-200)',
              }}
            >
              <Typography variant="h6" component="div" sx={{ fontWeight: themeTokens.typography.fontWeight.semibold, fontSize: themeTokens.typography.fontSize.base }}>
                Queue
              </Typography>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                {queue.length > 0 && !viewOnlyMode && (
                  isEditMode ? (
                    <Stack direction="row" spacing={1}>
                      <MuiButton
                        variant="text"
                        startIcon={<DeleteOutlined />}
                        sx={{ color: 'var(--neutral-400)' }}
                        onClick={() => {
                          setQueue([]);
                          handleExitEditMode();
                        }}
                      >
                        Clear
                      </MuiButton>
                      <IconButton onClick={handleExitEditMode}><CloseOutlined /></IconButton>
                    </Stack>
                  ) : (
                    <Stack direction="row" spacing={1}>
                      <IconButton
                        color={showHistory ? 'default' : 'default'}
                        onClick={() => setShowHistory((prev) => !prev)}
                        sx={showHistory ? { border: '1px solid', borderColor: 'divider' } : undefined}
                      >
                        <HistoryOutlined />
                      </IconButton>
                      <IconButton onClick={() => setIsEditMode(true)}><EditOutlined /></IconButton>
                    </Stack>
                  )
                )}
              </Box>
            </Box>
          </div>
          <div className={styles.queueBodyLayout}>
            <div
              ref={queueScrollCallbackRef}
              className={styles.queueScrollContainer}
              style={{ touchAction: 'pan-y' }}
            >
              <QueueList
                ref={queueListRef}
                boardDetails={boardDetails}
                onClimbNavigate={() => {
                  setIsQueueOpen(false);
                  setActiveDrawer('none');
                }}
                isEditMode={isEditMode}
                showHistory={showHistory}
                selectedItems={selectedItems}
                onToggleSelect={handleToggleSelect}
                scrollContainer={queueScrollEl}
              />
            </div>
            {isEditMode && selectedItems.size > 0 && (
              <div className={styles.bulkRemoveBar}>
                <MuiButton variant="contained" color="error" fullWidth onClick={handleBulkRemove}>
                  Remove {selectedItems.size} {selectedItems.size === 1 ? 'item' : 'items'}
                </MuiButton>
              </div>
            )}
          </div>
        </SwipeableDrawer>
    </SwipeableDrawer>
    </>
  );
};

export default PlayViewDrawer;
