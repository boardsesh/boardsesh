'use client';
import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import MuiButton from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import MuiCard from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import SwipeableDrawer from '../swipeable-drawer/swipeable-drawer';
import SyncOutlined from '@mui/icons-material/SyncOutlined';
import CloudOffOutlined from '@mui/icons-material/CloudOffOutlined';
import DeleteOutlined from '@mui/icons-material/DeleteOutlined';
import OpenInFullOutlined from '@mui/icons-material/OpenInFullOutlined';
import { track } from '@vercel/analytics';
import { useQueueActions, useCurrentClimb, useQueueList, useSessionData } from '../graphql-queue';
import NextClimbButton from './next-climb-button';
import { usePathname, useParams, useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { constructPlayUrlWithSlugs, getContextAwareClimbViewUrl, isNumericId, tryConstructSlugPlayUrl } from '@/app/lib/url-utils';
import { BoardRouteParameters, BoardDetails, Angle, Climb } from '@/app/lib/types';
import PreviousClimbButton from './previous-climb-button';
import QueueList, { QueueListHandle } from './queue-list';
import { useSwipeable } from 'react-swipeable';
import { TickButton } from '../logbook/tick-button';
import { QuickTickBar, type QuickTickBarHandle } from '../logbook/quick-tick-bar';
import ClimbThumbnail from '../climb-card/climb-thumbnail';
import ClimbTitle from '../climb-card/climb-title';
import { themeTokens } from '@/app/theme/theme-config';
import { TOUR_DRAWER_EVENT } from '../onboarding/onboarding-tour';
import { ShareBoardButton } from '../board-page/share-button';
import { useCardSwipeNavigation, EXIT_DURATION, SNAP_BACK_DURATION, ENTER_ANIMATION_DURATION } from '@/app/hooks/use-card-swipe-navigation';
import PlayViewDrawer from '../play-view/play-view-drawer';
import CircularProgress from '@mui/material/CircularProgress';
import CloseOutlined from '@mui/icons-material/CloseOutlined';
import CheckOutlined from '@mui/icons-material/CheckOutlined';
import ChatBubbleOutlineOutlined from '@mui/icons-material/ChatBubbleOutlineOutlined';
import InputAdornment from '@mui/material/InputAdornment';
import { getGradeTintColor } from '@/app/lib/grade-colors';
import { useColorMode } from '@/app/hooks/use-color-mode';
import { ConfirmPopover } from '@/app/components/ui/confirm-popover';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import styles from './queue-control-bar.module.css';

export type ActiveDrawer = 'none' | 'play' | 'queue' | 'tick';

// Re-export the window event so existing imports from this file keep working.
// The actual definition lives in ./play-drawer-event to keep the import graph
// light for callsites that only need the dispatch helper.
export { PLAY_DRAWER_EVENT, dispatchOpenPlayDrawer } from './play-drawer-event';
import { PLAY_DRAWER_EVENT as PLAY_DRAWER_EVENT_INTERNAL } from './play-drawer-event';

const QUEUE_DRAWER_STYLES = { wrapper: { height: '70%' }, body: { padding: 0 } } as const;

export interface QueueControlBarProps {
  boardDetails: BoardDetails;
  angle: Angle;
}

const QueueControlBar: React.FC<QueueControlBarProps> = ({ boardDetails, angle }) => {
  const [activeDrawer, setActiveDrawer] = useState<ActiveDrawer>('none');
  const pathname = usePathname();
  const params = useParams<BoardRouteParameters>();
  const searchParams = useSearchParams();
  const router = useRouter();
  const queueListRef = useRef<QueueListHandle>(null);
  const scrollTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const enterFallbackRef = useRef<NodeJS.Timeout | null>(null);

  // Reset activeDrawer on navigation
  useEffect(() => {
    setActiveDrawer('none');
  }, [pathname]);

  // Cleanup timeouts on unmount
  useEffect(() => {
    return () => {
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
      if (enterFallbackRef.current) {
        clearTimeout(enterFallbackRef.current);
      }
    };
  }, []);

  // Listen for tour events to open/close the queue drawer
  useEffect(() => {
    const handler = (e: Event) => {
      const { open } = (e as CustomEvent<{ open: boolean }>).detail;
      setActiveDrawer(open ? 'queue' : 'none');
    };
    window.addEventListener(TOUR_DRAWER_EVENT, handler);
    return () => window.removeEventListener(TOUR_DRAWER_EVENT, handler);
  }, []);

  // Listen for play drawer open requests from climb list items that live
  // outside this component's React tree (board page, liked list, queue
  // suggestions, queue items). Callers set the active climb before dispatching.
  useEffect(() => {
    const handler = () => setActiveDrawer('play');
    window.addEventListener(PLAY_DRAWER_EVENT_INTERNAL, handler);
    return () => window.removeEventListener(PLAY_DRAWER_EVENT_INTERNAL, handler);
  }, []);

  // Scroll to current climb when drawer finishes opening
  const handleDrawerOpenChange = useCallback((open: boolean) => {
    if (open) {
      scrollTimeoutRef.current = setTimeout(() => {
        queueListRef.current?.scrollToCurrentClimb();
      }, 100);
    }
  }, []);

  const handleCloseDrawer = useCallback(() => setActiveDrawer('none'), []);

  const isViewPage = pathname.includes('/view/');
  const isListPage = pathname.includes('/list');
  const isPlayPage = pathname.includes('/play/');
  const { currentClimb } = useCurrentClimb();
  const { queue } = useQueueList();
  const { viewOnlyMode, connectionState, sessionId, isDisconnected, users } = useSessionData();
  const {
    mirrorClimb,
    setQueue,
    getNextClimbQueueItem,
    getPreviousClimbQueueItem,
    setCurrentClimbQueueItem,
    endSession,
    disconnect,
  } = useQueueActions();
  const handleThumbnailClick = useCallback(() => {
    if (!currentClimb || viewOnlyMode) return;
    const currentQueueItem = queue.find((item) => item.climb.uuid === currentClimb.uuid);
    if (currentQueueItem) {
      setCurrentClimbQueueItem(currentQueueItem);
    }
    setActiveDrawer('play');
  }, [currentClimb, viewOnlyMode, queue, setCurrentClimbQueueItem]);

  const { showMessage } = useSnackbar();
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [dismissedDisconnect, setDismissedDisconnect] = useState(false);

  // Tick-bar comment state lives here so the comment field can render in a
  // separate bar *above* the queue control bar without reflowing the main bar.
  // QuickTickBar reads the value back out via props when saving the tick.
  const [tickComment, setTickComment] = useState('');
  const [tickCommentFocused, setTickCommentFocused] = useState(false);
  const quickTickBarRef = useRef<QuickTickBarHandle>(null);

  // Swipe-to-dismiss state — tracks vertical offset during down-swipe gesture.
  const [tickSwipeOffset, setTickSwipeOffset] = useState(0);

  // Keep the tick row mounted during the close animation so it can collapse.
  const [tickRowVisible, setTickRowVisible] = useState(false);
  const handleTickCommentFocus = useCallback(() => setTickCommentFocused(true), []);
  const handleTickCommentBlur = useCallback(() => setTickCommentFocused(false), []);

  // Reset dismissed state when connection is restored so banner reappears on next disconnect
  useEffect(() => {
    if (!isDisconnected) {
      setDismissedDisconnect(false);
    }
  }, [isDisconnected]);

  const { mode } = useColorMode();
  const isDark = mode === 'dark';

  // Show reconnecting UI only when online but WebSocket is down.
  // When truly offline (browser has no network), show normal controls with an offline indicator instead.
  const isReconnecting = !!sessionId && !isDisconnected && (connectionState === 'reconnecting' || connectionState === 'stale' || connectionState === 'error');

  const nextClimb = useMemo(() => getNextClimbQueueItem(), [getNextClimbQueueItem, queue, currentClimb]);
  const previousClimb = useMemo(() => getPreviousClimbQueueItem(), [getPreviousClimbQueueItem, queue, currentClimb]);
  const shouldNavigate = isViewPage || isPlayPage;

  // Build URL for a climb item (for navigation on view/play pages)
  const buildClimbUrl = useCallback((climb: { uuid: string; name: string }) => {
    let climbUrl: string | null = null;

    if (isPlayPage) {
      if (boardDetails?.layout_name && boardDetails?.size_name && boardDetails?.set_names) {
        climbUrl = constructPlayUrlWithSlugs(
          boardDetails.board_name,
          boardDetails.layout_name,
          boardDetails.size_name,
          boardDetails.size_description,
          boardDetails.set_names,
          angle,
          climb.uuid,
          climb.name,
        );
      } else if (params.board_name) {
        const numericFallback = `/${params.board_name}/${params.layout_id}/${params.size_id}/${params.set_ids}/${params.angle}/play/${climb.uuid}`;
        climbUrl = isNumericId(params.layout_id)
          ? tryConstructSlugPlayUrl(
              params.board_name, Number(params.layout_id), Number(params.size_id),
              decodeURIComponent(params.set_ids).split(',').map(Number),
              angle, climb.uuid, climb.name,
            ) ?? numericFallback
          : numericFallback;
      } else {
        climbUrl = null;
      }
    } else {
      climbUrl = getContextAwareClimbViewUrl(
        pathname,
        boardDetails,
        angle,
        climb.uuid,
        climb.name,
      );
    }

    if (!climbUrl) return null;

    // Preserve search params in play mode
    if (isPlayPage) {
      const queryString = searchParams.toString();
      if (queryString) {
        climbUrl = `${climbUrl}?${queryString}`;
      }
    }
    return climbUrl;
  }, [pathname, boardDetails, angle, params, searchParams, isPlayPage]);

  // Handle swipe navigation
  const handleSwipeNext = useCallback(() => {
    if (!nextClimb || viewOnlyMode) return;

    setCurrentClimbQueueItem(nextClimb);
    track('Queue Navigation', {
      direction: 'next',
      method: 'swipe',
      boardLayout: boardDetails?.layout_name || '',
    });

    if (shouldNavigate) {
      const url = buildClimbUrl(nextClimb.climb);
      if (url) {
        if (isPlayPage) {
          window.history.pushState(null, '', url);
        } else {
          router.push(url);
        }
      }
    }
  }, [nextClimb, viewOnlyMode, setCurrentClimbQueueItem, shouldNavigate, router, buildClimbUrl, boardDetails, isPlayPage]);

  const handleSwipePrevious = useCallback(() => {
    if (!previousClimb || viewOnlyMode) return;

    setCurrentClimbQueueItem(previousClimb);
    track('Queue Navigation', {
      direction: 'previous',
      method: 'swipe',
      boardLayout: boardDetails?.layout_name || '',
    });

    if (shouldNavigate) {
      const url = buildClimbUrl(previousClimb.climb);
      if (url) {
        if (isPlayPage) {
          window.history.pushState(null, '', url);
        } else {
          router.push(url);
        }
      }
    }
  }, [previousClimb, viewOnlyMode, setCurrentClimbQueueItem, shouldNavigate, router, buildClimbUrl, boardDetails, isPlayPage]);

  const tickBarActive = activeDrawer === 'tick';
  const canSwipeNext = !viewOnlyMode && !!nextClimb && !tickBarActive;
  const canSwipePrevious = !viewOnlyMode && !!previousClimb && !tickBarActive;

  // Snapshot the displayed climb when tick mode opens so the queue bar stays
  // frozen on the climb being ticked, even if another user advances the queue.
  const [tickClimb, setTickClimb] = useState<Climb | null>(null);
  useEffect(() => {
    if (tickBarActive && currentClimb && !tickClimb) {
      setTickClimb(currentClimb);
    } else if (!tickBarActive) {
      setTickClimb(null);
    }
  }, [tickBarActive, currentClimb, tickClimb]);

  // The climb shown in the queue bar — frozen during tick mode.
  const displayedClimb = tickBarActive ? (tickClimb ?? currentClimb) : currentClimb;
  const gradeTintColor = useMemo(() => getGradeTintColor(displayedClimb?.difficulty, 'default', isDark), [displayedClimb?.difficulty, isDark]);

  // Reset all tick-bar state on close; keep the row mounted during the 200ms collapse.
  useEffect(() => {
    if (tickBarActive) {
      setTickRowVisible(true);
    } else {
      setTickComment('');
      setTickCommentFocused(false);
      setTickSwipeOffset(0);
      const timer = setTimeout(() => setTickRowVisible(false), 200);
      return () => clearTimeout(timer);
    }
  }, [tickBarActive]);

  const tickSwipeEnabled = tickBarActive && !tickCommentFocused;

  const tickDismissHandlers = useSwipeable({
    onSwiping: (eventData) => {
      if (!tickSwipeEnabled) return;
      const target = eventData.event.target as HTMLElement | null;
      if (target?.closest('[data-scrollable-picker]')) return;
      // Only track downward swipes; ignore horizontal-dominant gestures
      if (Math.abs(eventData.deltaX) > Math.abs(eventData.deltaY)) return;
      if (eventData.deltaY < 0) { setTickSwipeOffset(0); return; }
      setTickSwipeOffset(eventData.deltaY);
    },
    onSwipedDown: (eventData) => {
      if (!tickSwipeEnabled) return;
      const target = eventData.event.target as HTMLElement | null;
      if (target?.closest('[data-scrollable-picker]')) return;
      if (Math.abs(eventData.deltaY) >= 80) {
        // Just close — the CSS grid collapse animation handles the visual exit
        setActiveDrawer('none');
      } else {
        setTickSwipeOffset(0);
      }
    },
    onSwiped: (eventData) => {
      if (!tickSwipeEnabled) return;
      const target = eventData.event.target as HTMLElement | null;
      if (target?.closest('[data-scrollable-picker]')) return;
      if (eventData.dir !== 'Down') setTickSwipeOffset(0);
    },
    trackMouse: false,
    preventScrollOnSwipe: false,
    delta: 10,
  });

  const tickDismissStyle = useMemo<React.CSSProperties | undefined>(() => {
    if (tickSwipeOffset === 0) {
      return { transition: 'grid-template-rows 180ms ease-out, opacity 180ms ease-out' };
    }
    const fraction = Math.max(0, 1 - tickSwipeOffset / 150);
    return { gridTemplateRows: `${fraction}fr`, opacity: fraction, transition: 'none' };
  }, [tickSwipeOffset]);

  const { swipeHandlers, swipeOffset, isAnimating, animationDirection, enterDirection, clearEnterAnimation } = useCardSwipeNavigation({
    onSwipeNext: handleSwipeNext,
    onSwipePrevious: handleSwipePrevious,
    canSwipeNext,
    canSwipePrevious,
    threshold: 80,
    delayNavigation: true,
  });

  const playUrl = useMemo(() => {
    if (!currentClimb) return null;

    const { layout_name, size_name, size_description, set_names, board_name } = boardDetails;

    let baseUrl: string | null;
    if (layout_name && size_name && set_names) {
      baseUrl = constructPlayUrlWithSlugs(
        board_name,
        layout_name,
        size_name,
        size_description,
        set_names,
        angle,
        currentClimb.uuid,
        currentClimb.name,
      );
    } else if (params.board_name) {
      const numericFallback = `/${params.board_name}/${params.layout_id}/${params.size_id}/${params.set_ids}/${params.angle}/play/${currentClimb.uuid}`;
      baseUrl = isNumericId(params.layout_id)
        ? tryConstructSlugPlayUrl(
            params.board_name, Number(params.layout_id), Number(params.size_id),
            decodeURIComponent(params.set_ids).split(',').map(Number),
            angle, currentClimb.uuid, currentClimb.name,
          ) ?? numericFallback
        : numericFallback;
    } else {
      return null;
    }

    const queryString = searchParams.toString();
    if (queryString) {
      return `${baseUrl}?${queryString}`;
    }
    return baseUrl;
  }, [currentClimb, boardDetails, angle, params, searchParams]);

  const handleClearQueue = () => {
    setQueue([]);
    track('Queue Cleared', {
      boardLayout: boardDetails.layout_name || '',
      itemsCleared: queue.length,
    });
  };

  const handleClimbInfoClick = useCallback(() => {
    if (!currentClimb) return;
    setActiveDrawer('play');
    track('Play Drawer Opened', {
      boardLayout: boardDetails.layout_name || '',
      source: 'bar_tap',
    });
  }, [currentClimb, boardDetails.layout_name]);

  // Transition style shared by current and peek text
  const getTextTransitionStyle = () => {
    // After navigation completes, snap instantly (no transition) to avoid
    // the new text sliding in from the old exit position
    if (enterDirection) return 'none';
    if (isAnimating) return `transform ${EXIT_DURATION}ms ease-out`;
    if (swipeOffset === 0) return `transform ${SNAP_BACK_DURATION}ms ease`;
    return 'none';
  };

  // Peek: determine which climb to preview during swipe
  const showPeek = swipeOffset !== 0 || isAnimating;
  const peekIsNext = animationDirection === 'left' || (animationDirection === null && swipeOffset < 0);
  const peekClimbData = peekIsNext ? nextClimb?.climb : previousClimb?.climb;

  // Peek transform: positioned one container-width away, moves with swipeOffset.
  // Clamped so the peek stops at position 0 and never overshoots past it
  // (the exit offset is window.innerWidth which is wider than the clip container).
  const getPeekTransform = () => {
    return peekIsNext
      ? `translateX(max(0px, calc(100% + ${swipeOffset}px)))`
      : `translateX(min(0px, calc(-100% + ${swipeOffset}px)))`;
  };

  const reconnectMessage = connectionState === 'error' ? 'Connection error – retrying…' : 'Reconnecting…';

  const handleLeaveSession = useCallback(() => {
    if (endSession) {
      endSession();
      return;
    }
    if (disconnect) {
      disconnect();
    } else {
      showMessage('Unable to leave session. Please try again.', 'warning');
    }
  }, [endSession, disconnect, showMessage]);

  // Reconnect-only view helpers
  const renderReconnectingRow = () => (
    <div className={styles.reconnectRow}>
      <CircularProgress size={16} thickness={5} />
      <span>{reconnectMessage}</span>
      <MuiButton variant="text" size="small" onClick={() => setShowCancelConfirm(true)}>Cancel</MuiButton>
    </div>
  );

  const renderConfirmRow = () => (
    <div className={styles.reconnectRow}>
      <span className={styles.confirmText}>Cancelling will leave the session. Is that what you want?</span>
      <IconButton aria-label="Leave session" color="error" onClick={() => { handleLeaveSession(); setShowCancelConfirm(false); }}>
        <CloseOutlined />
      </IconButton>
      <IconButton aria-label="Keep reconnecting" onClick={() => setShowCancelConfirm(false)}>
        <CheckOutlined />
      </IconButton>
    </div>
  );

  useEffect(() => {
    if (!isReconnecting) {
      setShowCancelConfirm(false);
    }
  }, [isReconnecting]);

  // Clear enterDirection (for thumbnail crossfade) after it plays
  useEffect(() => {
    if (enterDirection) {
      enterFallbackRef.current = setTimeout(() => {
        clearEnterAnimation();
      }, ENTER_ANIMATION_DURATION);
    }
    return () => {
      if (enterFallbackRef.current) {
        clearTimeout(enterFallbackRef.current);
        enterFallbackRef.current = null;
      }
    };
  }, [enterDirection, clearEnterAnimation]);

  const reconnectView = (
    <MuiCard variant="outlined" className={styles.card} sx={{ border: 'none', backgroundColor: 'transparent' }}>
      <CardContent sx={{ p: 0, '&:last-child': { pb: 0 } }}>
        <div className={styles.swipeWrapper}>
          <div
            className={styles.swipeContainer}
            style={{
              padding: `${themeTokens.spacing[2]}px ${themeTokens.spacing[3]}px`,
              backgroundColor: gradeTintColor ?? (isDark ? 'transparent' : 'var(--semantic-surface)'),
            }}
          >
            <Box sx={{ display: 'flex', flexWrap: 'nowrap', alignItems: 'center' }} className={styles.row}>
              <Box sx={{ flex: 1 }} className={styles.climbInfoCol}>
                <div className={styles.climbInfoInner} style={{ gap: themeTokens.spacing[2] }}>
                  <div className={`${styles.boardPreviewContainer} ${enterDirection ? styles.thumbnailEnter : ''}`}>
                    <ClimbThumbnail
                      boardDetails={boardDetails}
                      currentClimb={displayedClimb}
                      pathname={pathname}
                      onClick={handleThumbnailClick}
                    />
                  </div>

                  {/* Reconnect UI sits where the title normally lives */}
                  <div className={styles.textSwipeClip}>
                    {showCancelConfirm ? renderConfirmRow() : renderReconnectingRow()}
                  </div>
                </div>
              </Box>
            </Box>
          </div>
        </div>
      </CardContent>
    </MuiCard>
  );

  if (isReconnecting) {
    return (
      <div id="onboarding-queue-bar" className={`queue-bar-shadow ${styles.queueBar}`} data-testid="queue-control-bar">
        {reconnectView}
      </div>
    );
  }

  return (
    <div id="onboarding-queue-bar" className={`queue-bar-shadow ${styles.queueBar}`} data-testid="queue-control-bar">
      {/* Offline indicator */}
      {isDisconnected && !dismissedDisconnect && (
        <div
          className={styles.offlineBanner}
          onClick={() => setDismissedDisconnect(true)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDismissedDisconnect(true); } }}
        >
          <CloudOffOutlined sx={{ fontSize: 'body2.fontSize', flexShrink: 0 }} />
          <span className={styles.offlineBannerText}>
            {sessionId
              ? users && users.length > 1
                ? 'Offline. Queued climbs will still sync.'
                : 'Offline. Changes will sync when you reconnect.'
              : 'Offline'}
          </span>
        </div>
      )}
      {/* Main Control Bar */}
      <MuiCard
        variant="outlined"
        className={styles.card}
        sx={{ border: 'none', backgroundColor: 'transparent' }}
      >
        <CardContent sx={{ p: 0, '&:last-child': { pb: 0 } }}>
        {/* Tick-mode controls — expands/collapses via CSS grid transition.
            Swipe-to-dismiss handlers are on the tick row only, not the whole card. */}
        {(tickBarActive || tickRowVisible) && (
          <div
            {...(tickBarActive ? tickDismissHandlers : {})}
            className={`${styles.tickRow} ${tickBarActive ? styles.tickRowExpanded : ''} ${tickSwipeOffset > 0 ? styles.tickRowSwiping : ''}`}
            style={{
              backgroundColor: gradeTintColor ?? (isDark ? 'transparent' : 'var(--semantic-surface)'),
              ...tickDismissStyle,
            }}
          >
            {/* Close button — top-right corner of the tick bar */}
            <div className={styles.tickCloseButton}>
              <IconButton
                onClick={() => setActiveDrawer('none')}
                size="small"
                aria-label="Close tick bar"
                sx={{
                  color: 'text.primary',
                  backgroundColor: 'action.selected',
                  '&:hover': { backgroundColor: 'action.focus' },
                }}
              >
                <CloseOutlined sx={{ fontSize: 16 }} />
              </IconButton>
            </div>
            <div className={styles.tickRowInner}>
              {/* Drag handle */}
              <div className={styles.tickDragHandleRow}>
                <div className={styles.tickDragHandle} aria-hidden="true">
                  <div className={styles.tickDragHandleBar} />
                </div>
              </div>
              {tickBarActive && (
                <QuickTickBar
                  ref={quickTickBarRef}
                  currentClimb={currentClimb}
                  angle={angle}
                  boardDetails={boardDetails}
                  onSave={() => setActiveDrawer('none')}
                  comment={tickComment}
                  commentSlot={
                    <div className={`${styles.tickComment} ${tickCommentFocused ? styles.tickCommentExpanded : ''}`}>
                      <TextField
                        fullWidth
                        size="small"
                        variant="outlined"
                        placeholder="Comment..."
                        multiline
                        minRows={1}
                        maxRows={tickCommentFocused ? 4 : 1}
                        value={tickComment}
                        onChange={(e) => setTickComment(e.target.value)}
                        onFocus={handleTickCommentFocus}
                        onBlur={handleTickCommentBlur}
                        slotProps={{
                          htmlInput: { maxLength: 2000, 'aria-label': 'Tick comment' },
                          input: {
                            startAdornment: (
                              <InputAdornment position="start">
                                <ChatBubbleOutlineOutlined sx={{ fontSize: 16, opacity: 0.5 }} />
                              </InputAdornment>
                            ),
                          },
                        }}
                        sx={{
                          '& .MuiOutlinedInput-root': {
                            borderRadius: '8px',
                            backgroundColor: 'var(--input-bg)',
                            '& .MuiOutlinedInput-notchedOutline': {
                              borderColor: 'var(--neutral-200)',
                            },
                          },
                        }}
                      />
                    </div>
                  }
                />
              )}
            </div>
          </div>
        )}
        {/* Swipe container - captures swipe gestures, does NOT translate */}
        <div className={styles.swipeWrapper}>
          <div
            {...swipeHandlers}
            className={styles.swipeContainer}
            style={{
              padding: `${themeTokens.spacing[2]}px ${themeTokens.spacing[3]}px`,
              backgroundColor: gradeTintColor ?? (isDark ? 'transparent' : 'var(--semantic-surface)'),
            }}
          >
            <Box sx={{ display: 'flex', flexWrap: 'nowrap', justifyContent: 'space-between', alignItems: 'center' }} className={styles.row}>
              {/* Left section: Thumbnail and climb info */}
              <Box sx={{ flex: 1 }} className={styles.climbInfoCol}>
                <div className={styles.climbInfoInner} style={{ gap: themeTokens.spacing[2] }}>
                  {/* Board preview — STATIC, with crossfade on enter */}
                  <div className={`${styles.boardPreviewContainer} ${enterDirection ? styles.thumbnailEnter : ''}`}>
                    <ClimbThumbnail
                      boardDetails={boardDetails}
                      currentClimb={displayedClimb}
                      pathname={pathname}
                      onClick={handleThumbnailClick}
                    />
                  </div>

                  {/* Text swipe clip — overflow hidden to contain sliding text */}
                  <div className={styles.textSwipeClip}>
                    {/* Current climb text — slides with finger */}
                    <div
                      id="onboarding-queue-toggle"
                      onClick={tickBarActive ? undefined : handleClimbInfoClick}
                      className={styles.queueToggle}
                      style={{
                        transform: tickBarActive ? undefined : `translateX(${swipeOffset}px)`,
                        transition: tickBarActive ? undefined : getTextTransitionStyle(),
                        cursor: tickBarActive ? 'default' : undefined,
                      }}
                    >
                      <ClimbTitle
                        climb={displayedClimb}
                        gradePosition="right"
                        showSetterInfo
                      />
                    </div>

                    {/* Peek text — shows next/previous climb sliding in from the edge */}
                    {!tickBarActive && showPeek && peekClimbData && (
                      <div
                        className={`${styles.queueToggle} ${styles.peekText}`}
                        style={{
                          transform: getPeekTransform(),
                          transition: getTextTransitionStyle(),
                        }}
                      >
                        <ClimbTitle
                          climb={peekClimbData}
                          gradePosition="right"
                          showSetterInfo
                        />
                      </div>
                    )}
                  </div>
                </div>
              </Box>

              {/* Button cluster — always visible, lightbulb swaps to X in tick mode */}
              <Box sx={{ flex: 'none', marginLeft: `${themeTokens.spacing[1]}px` }}>
                <Stack direction="row" spacing={0.5}>
                  {/* Mirror button - desktop only */}
                  {boardDetails.supportsMirroring ? (
                    <span className={styles.desktopOnly}>
                      <IconButton
                        id="button-mirror"
                        onClick={() => {
                          mirrorClimb();
                          track('Mirror Climb Toggled', {
                            boardLayout: boardDetails.layout_name || '',
                            mirrored: !displayedClimb?.mirrored,
                          });
                        }}
                        color={displayedClimb?.mirrored ? 'primary' : 'default'}
                        sx={
                          displayedClimb?.mirrored
                            ? { backgroundColor: themeTokens.colors.purple, borderColor: themeTokens.colors.purple, color: 'common.white', '&:hover': { backgroundColor: themeTokens.colors.purple } }
                            : undefined
                        }
                      >
                        <SyncOutlined />
                      </IconButton>
                    </span>
                  ) : null}
                  {/* Play link - desktop only */}
                  {!isPlayPage && playUrl && (
                    <span className={styles.desktopOnly}>
                      <Link
                        href={playUrl}
                        onClick={() => {
                          track('Play Mode Entered', {
                            boardLayout: boardDetails.layout_name || '',
                          });
                        }}
                      >
                        <IconButton aria-label="Enter play mode"><OpenInFullOutlined /></IconButton>
                      </Link>
                    </span>
                  )}
                  {/* Navigation buttons - desktop only */}
                  <span className={styles.navButtons}>
                    <Stack direction="row" spacing={0.5}>
                      <PreviousClimbButton navigate={isViewPage || isPlayPage} boardDetails={boardDetails} />
                      <NextClimbButton navigate={isViewPage || isPlayPage} boardDetails={boardDetails} />
                    </Stack>
                  </span>
                  {/* Party / Cancel button — swaps to X when tick mode is active */}
                  {tickBarActive ? (
                    <IconButton
                      onClick={(e) => quickTickBarRef.current?.saveAttempt(e.currentTarget)}
                      sx={{
                        color: themeTokens.colors.error,
                        opacity: themeTokens.opacity.subtle,
                        '&:hover': { color: themeTokens.colors.error, opacity: 1 },
                      }}
                      aria-label="Log attempt"
                    >
                      <CloseOutlined />
                    </IconButton>
                  ) : (
                    <ShareBoardButton />
                  )}
                  {/* Tick button — activates tick mode, or saves when already active */}
                  <TickButton
                    currentClimb={displayedClimb}
                    angle={angle}
                    boardDetails={boardDetails}
                    onActivateTickBar={() => setActiveDrawer('tick')}
                    onTickSave={() => quickTickBarRef.current?.save()}
                    tickBarActive={tickBarActive}
                  />
                </Stack>
              </Box>
            </Box>
          </div>
        </div>
        </CardContent>
      </MuiCard>

      {/* Drawer for showing the queue */}
      <SwipeableDrawer
        title="Queue"
        placement="bottom"
        open={activeDrawer === 'queue'}
        onClose={handleCloseDrawer}
        onTransitionEnd={handleDrawerOpenChange}
        styles={QUEUE_DRAWER_STYLES}
        extra={
          queue.length > 0 && (
            <ConfirmPopover
              title="Clear queue"
              description="Are you sure you want to clear all items from the queue?"
              onConfirm={handleClearQueue}
              okText="Clear"
              cancelText="Cancel"
            >
              <MuiButton variant="text" startIcon={<DeleteOutlined />} sx={{ color: 'var(--neutral-400)' }}>
                Clear
              </MuiButton>
            </ConfirmPopover>
          )
        }
      >
        <QueueList ref={queueListRef} boardDetails={boardDetails} active={activeDrawer === 'queue'} />
      </SwipeableDrawer>

      <PlayViewDrawer
        activeDrawer={activeDrawer}
        setActiveDrawer={setActiveDrawer}
        boardDetails={boardDetails}
        angle={angle}
      />
    </div>
  );
};

export default React.memo(QueueControlBar);
