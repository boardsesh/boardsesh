'use client';

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, useMemo, useDeferredValue } from 'react';
import { useTranslation } from 'react-i18next';
import { track } from '@/app/lib/analytics';
import MuiBadge from '@mui/material/Badge';
import IconButton from '@mui/material/IconButton';
import TextField from '@mui/material/TextField';
import InputAdornment from '@mui/material/InputAdornment';
import SyncOutlined from '@mui/icons-material/SyncOutlined';
import FavoriteBorderOutlined from '@mui/icons-material/FavoriteBorderOutlined';
import Favorite from '@mui/icons-material/Favorite';
import SkipPreviousOutlined from '@mui/icons-material/SkipPreviousOutlined';
import SkipNextOutlined from '@mui/icons-material/SkipNextOutlined';
import MoreHorizOutlined from '@mui/icons-material/MoreHorizOutlined';
import CloseOutlined from '@mui/icons-material/CloseOutlined';
import KeyboardArrowUpOutlined from '@mui/icons-material/KeyboardArrowUpOutlined';
import KeyboardArrowDownOutlined from '@mui/icons-material/KeyboardArrowDownOutlined';
import FormatListBulletedOutlined from '@mui/icons-material/FormatListBulletedOutlined';
import CheckOutlined from '@mui/icons-material/CheckOutlined';
import ChatBubbleOutlineOutlined from '@mui/icons-material/ChatBubbleOutlineOutlined';
import Lightbulb from '@mui/icons-material/Lightbulb';
import LightbulbOutlined from '@mui/icons-material/LightbulbOutlined';
import SwapHorizOutlined from '@mui/icons-material/SwapHorizOutlined';
import { TickIcon, TickButtonWithLabel } from '../logbook/tick-icon';
import { PersonFallingIcon } from '@/app/components/icons/person-falling-icon';
import { usePathname } from 'next/navigation';
import { useQueueActions, useCurrentClimb, useQueueData, useQueueList, useSessionData } from '../graphql-queue';
import { ClimbActions } from '../climb-actions';
import { useDoubleTapFavorite } from '../climb-actions/use-double-tap-favorite';
import HeartAnimationOverlay from '../climb-card/heart-animation-overlay';
import PlaylistSelectionContent from '../climb-actions/playlist-selection-content';
import DrawerClimbHeader from '../climb-card/drawer-climb-header';
import { ShareBoardButton } from '../board-page/share-button';
import { useBoardProvider } from '../board-provider/board-provider-context';
import SwipeBoardCarousel from '../board-renderer/swipe-board-carousel';
import { useWakeLock } from '../board-bluetooth-control/use-wake-lock';
import { themeTokens } from '@/app/theme/theme-config';
import SwipeableDrawer from '../swipeable-drawer/swipeable-drawer';
import AngleSelector from '../board-page/angle-selector';
import ClimbDetailHeader from '@/app/components/climb-detail/climb-detail-header';
import { QuickTickBar, type QuickTickBarHandle } from '../logbook/quick-tick-bar';
import { hasPriorHistoryForClimb } from '@/app/hooks/use-tick-save';
import type { ActiveDrawer } from '../queue-control/queue-control-bar';
import { PLAY_DRAWER_EVENT } from '../queue-control/play-drawer-event';
import {
  TOUR_CLOSE_PLAY_QUEUE_EVENT,
  TOUR_OPEN_PLAY_QUEUE_EVENT,
} from '@/app/components/onboarding/onboarding-tour-events';
import type { BoardDetails, Angle, Climb } from '@/app/lib/types';
import styles from './play-view-drawer.module.css';
import drawerCss from '../swipeable-drawer/swipeable-drawer.module.css';
import { useDrawerDragResize } from '@/app/hooks/use-drawer-drag-resize';
import ClimbDetailShellClient from '@/app/components/climb-detail/climb-detail-shell.client';
import { useBuildClimbDetailSections } from '@/app/components/climb-detail/build-climb-detail-sections';
import { renderBoard } from '@/app/lib/board-render-worker/worker-manager';
import { useNestedDrawerSwipe } from '@/app/lib/hooks/use-nested-drawer-swipe';
import { usePullToClose, findScrollContainer } from '@/app/lib/hooks/pull-to-close';
import { useSnackbar } from '../providers/snackbar-provider';
import { getGradeTintColor } from '@/app/lib/grade-colors';
import { useIsDarkMode } from '@/app/hooks/use-is-dark-mode';
import { getPreference, setPreference } from '@/app/lib/user-preferences-db';
import QueueDrawer from './queue-drawer';
import { useBluetoothContext } from '../board-bluetooth-control/bluetooth-context';

/** Window with optional requestIdleCallback (not available in all browsers). */
type WindowWithIdleCallback = Window & {
  requestIdleCallback?: ((cb: () => void, opts?: { timeout: number }) => number) | undefined;
};

type PlayDrawerContentProps = {
  climb: Climb;
  boardType: string;
  angle: number;
  aboveFold: React.ReactNode;
  sectionsEnabled: boolean;
};

const PlayDrawerContent = React.memo<PlayDrawerContentProps>(
  ({ climb, boardType, angle, aboveFold, sectionsEnabled }) => {
    const sections = useBuildClimbDetailSections({
      climb,
      climbUuid: climb.uuid,
      boardType,
      angle,
      currentClimbDifficulty: climb.difficulty ?? undefined,
      boardName: boardType,
      enabled: sectionsEnabled,
    });

    return <ClimbDetailShellClient mode="play" sections={sections} aboveFold={aboveFold} />;
  },
);
PlayDrawerContent.displayName = 'PlayDrawerContent';

type PlayViewActionBarProps = {
  canSwipePrevious: boolean;
  canSwipeNext: boolean;
  isMirrored: boolean;
  supportsMirroring: boolean;
  isFavorited: boolean;
  remainingQueueCount: number;
  onPrevClick: () => void;
  onNextClick: () => void;
  onMirror: () => void;
  onToggleFavorite: () => void;
  onOpenActions: () => void;
  onOpenQueue: () => void;
  onLightbulb?: () => void;
  onSwitchToEdit?: () => void;
  isActiveClimber?: boolean;
  showLightbulb?: boolean;
  showSwitchToEdit?: boolean;
  angleSelector?: React.ReactNode;
};

export const PlayViewActionBar = React.memo(function PlayViewActionBar({
  canSwipePrevious,
  canSwipeNext,
  isMirrored,
  supportsMirroring,
  isFavorited,
  remainingQueueCount,
  onPrevClick,
  onNextClick,
  onMirror,
  onToggleFavorite,
  onOpenActions,
  onOpenQueue,
  onLightbulb = () => {},
  onSwitchToEdit = () => {},
  isActiveClimber = false,
  showLightbulb = false,
  showSwitchToEdit = false,
  angleSelector,
}: PlayViewActionBarProps) {
  const { t } = useTranslation('session');
  return (
    <div className={styles.actionBar}>
      <IconButton disabled={!canSwipePrevious} onClick={onPrevClick}>
        <SkipPreviousOutlined />
      </IconButton>
      {supportsMirroring && (
        <IconButton
          color={isMirrored ? 'primary' : 'default'}
          onClick={onMirror}
          sx={
            isMirrored
              ? {
                  backgroundColor: themeTokens.colors.purple,
                  borderColor: themeTokens.colors.purple,
                  color: 'common.white',
                  '&:hover': { backgroundColor: themeTokens.colors.purple },
                }
              : undefined
          }
        >
          <SyncOutlined />
        </IconButton>
      )}
      {showLightbulb && (
        <IconButton color={isActiveClimber ? 'primary' : 'default'} onClick={onLightbulb}>
          {isActiveClimber ? <Lightbulb /> : <LightbulbOutlined />}
        </IconButton>
      )}
      {showSwitchToEdit && (
        <IconButton onClick={onSwitchToEdit} aria-label={t('playView.actionBar.switchToMyPickAria')}>
          <SwapHorizOutlined />
        </IconButton>
      )}
      <IconButton onClick={onToggleFavorite}>
        {isFavorited ? <Favorite sx={{ color: themeTokens.colors.error }} /> : <FavoriteBorderOutlined />}
      </IconButton>
      <ShareBoardButton />
      {angleSelector}
      <IconButton onClick={onOpenActions} aria-label={t('playView.actionBar.climbActionsAria')}>
        <MoreHorizOutlined />
      </IconButton>
      <MuiBadge
        badgeContent={remainingQueueCount}
        max={99}
        sx={{
          '& .MuiBadge-badge': {
            backgroundColor: themeTokens.colors.primary,
            color: 'common.white',
          },
        }}
      >
        <IconButton onClick={onOpenQueue} aria-label={t('playView.actionBar.openQueueAria')}>
          <FormatListBulletedOutlined />
        </IconButton>
      </MuiBadge>
      <IconButton disabled={!canSwipeNext} onClick={onNextClick}>
        <SkipNextOutlined />
      </IconButton>
    </div>
  );
});
PlayViewActionBar.displayName = 'PlayViewActionBar';

/**
 * Extracted tick bar component that owns its own `tickComment` state.
 * This prevents comment keystrokes from invalidating the parent `aboveFold` useMemo,
 * which would otherwise re-render the entire board carousel on every keystroke.
 */
type PlayViewTickBarProps = {
  isTickBarActive: boolean;
  currentClimb: Climb;
  angle: Angle;
  boardDetails: BoardDetails;
  onClose: () => void;
  onError: () => void;
};

export const PlayViewTickBar = React.memo<PlayViewTickBarProps>(function PlayViewTickBar({
  isTickBarActive,
  currentClimb,
  angle,
  boardDetails,
  onClose,
  onError,
}) {
  const { t } = useTranslation('session');
  const { logbook } = useBoardProvider();
  const [tickComment, setTickComment] = useState('');
  const [commentFocused, setCommentFocused] = useState(false);
  const [isFlash, setIsFlash] = useState(() => !hasPriorHistoryForClimb(currentClimb, logbook));
  const [tickBarExpanded, setTickBarExpanded] = useState(false);
  const quickTickBarRef = useRef<QuickTickBarHandle>(null);
  const isDark = useIsDarkMode();
  // Match queue control bar tint — 'default' variant.
  // In dark mode the tint is semi-transparent, so the backdrop-filter blur
  // fills in behind it. The fallback uses surfaceElevated (#121212) which
  // is visibly distinct from pure black.
  const gradeTintColor = useMemo(
    () => getGradeTintColor(currentClimb.difficulty, 'default', isDark),
    [currentClimb.difficulty, isDark],
  );

  // Restore persisted tick bar expanded state when tick bar opens
  useEffect(() => {
    if (isTickBarActive) {
      void getPreference<boolean>('tickBarExpanded').then((persisted) => {
        if (persisted === true) setTickBarExpanded(true);
      });
    }
  }, [isTickBarActive]);

  // Persist expanded state on user-initiated toggle (not on automatic resets)
  const handleTickBarExpandedChange = useCallback((expanded: boolean) => {
    setTickBarExpanded(expanded);
    void setPreference('tickBarExpanded', expanded);
  }, []);

  const handleCommentFocus = useCallback(() => setCommentFocused(true), []);
  const handleCommentBlur = useCallback(() => setCommentFocused(false), []);

  // Reset comment when the tick bar closes
  const handleClose = useCallback(() => {
    setTickComment('');
    setCommentFocused(false);
    setIsFlash(false);
    setTickBarExpanded(false);
    onClose();
  }, [onClose]);

  // Reset comment and recompute flash state when the climb changes.
  useEffect(() => {
    setTickComment('');
    setCommentFocused(false);
    setIsFlash(!hasPriorHistoryForClimb(currentClimb, logbook));
    setTickBarExpanded(false);
  }, [currentClimb, logbook]);

  return (
    <div className={`${styles.tickBarContainer} ${isTickBarActive ? styles.tickBarContainerActive : ''}`}>
      <div
        className={styles.tickBarInner}
        style={{
          backgroundColor: isDark ? 'var(--semantic-surfaceElevated)' : 'var(--semantic-surface)',
          // Grade tint as a solid overlay via linear-gradient (single-color gradient)
          ...(gradeTintColor ? { backgroundImage: `linear-gradient(${gradeTintColor}, ${gradeTintColor})` } : {}),
        }}
      >
        {isTickBarActive && (
          <>
            {/* Toolbar: expand left, close right — same pattern as queue-control-bar */}
            <div className={styles.tickBarToolbar}>
              <div
                className={styles.tickBarExpandButton}
                onClick={() => handleTickBarExpandedChange(!tickBarExpanded)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') handleTickBarExpandedChange(!tickBarExpanded);
                }}
                aria-label={tickBarExpanded ? t('playView.tickBar.collapseAria') : t('playView.tickBar.expandAria')}
              >
                {tickBarExpanded ? (
                  <KeyboardArrowDownOutlined sx={{ fontSize: 16, opacity: 0.7 }} />
                ) : (
                  <KeyboardArrowUpOutlined sx={{ fontSize: 16, opacity: 0.7 }} />
                )}
                <span className={styles.tickBarExpandLabel}>
                  {tickBarExpanded ? t('queueBar.tickBar.collapse') : t('queueBar.tickBar.expand')}
                </span>
              </div>
              <div className={styles.tickBarCloseButton}>
                <IconButton
                  size="small"
                  onClick={handleClose}
                  aria-label={t('playView.tickBar.closeAria')}
                  sx={{
                    color: 'text.primary',
                    backgroundColor: 'action.selected',
                    '&:hover': { backgroundColor: 'action.focus' },
                    padding: '2px',
                  }}
                >
                  <CloseOutlined sx={{ fontSize: 16 }} />
                </IconButton>
              </div>
            </div>
            <QuickTickBar
              ref={quickTickBarRef}
              currentClimb={currentClimb}
              angle={angle}
              boardDetails={boardDetails}
              onSave={handleClose}
              onError={onError}
              onDraftRestored={(draftComment) => setTickComment(draftComment)}
              onIsFlashChange={setIsFlash}
              comment={tickComment}
              expanded={tickBarExpanded}
              commentSlot={
                <div className={`${styles.tickBarComment} ${commentFocused ? styles.tickBarCommentExpanded : ''}`}>
                  <TextField
                    fullWidth
                    size="small"
                    variant="outlined"
                    placeholder={t('common:comment.shortPlaceholder')}
                    multiline
                    minRows={1}
                    maxRows={commentFocused ? 4 : 1}
                    value={tickComment}
                    onChange={(e) => setTickComment(e.target.value)}
                    onFocus={handleCommentFocus}
                    onBlur={handleCommentBlur}
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
              expandedCommentSlot={
                <TextField
                  fullWidth
                  size="small"
                  variant="outlined"
                  placeholder={t('playView.tickBar.commentPlaceholder')}
                  multiline
                  minRows={2}
                  maxRows={4}
                  value={tickComment}
                  onChange={(e) => setTickComment(e.target.value)}
                  onFocus={handleCommentFocus}
                  onBlur={handleCommentBlur}
                  slotProps={{
                    htmlInput: { maxLength: 2000, 'aria-label': 'Tick comment' },
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
              }
            />
            {/* Action buttons — attempt + tick (order matches queue control bar) */}

            <div className={styles.tickBarButtons}>
              <TickButtonWithLabel label={t('playView.tickBar.attemptLabel')}>
                <IconButton
                  onClick={(e) => quickTickBarRef.current?.saveAttempt(e.currentTarget)}
                  sx={{
                    backgroundColor: themeTokens.colors.errorMuted,
                    color: themeTokens.colors.error,
                    '&:hover': { backgroundColor: themeTokens.colors.errorMutedHover },
                  }}
                  aria-label={t('playView.tickBar.logAttemptAria')}
                >
                  <PersonFallingIcon />
                </IconButton>
              </TickButtonWithLabel>
              <TickButtonWithLabel label={isFlash ? 'flash' : 'tick'}>
                <IconButton
                  id="button-tick"
                  onClick={(e) => quickTickBarRef.current?.save(e.currentTarget)}
                  sx={{
                    backgroundColor: isFlash ? themeTokens.colors.amber : themeTokens.colors.success,
                    color: isFlash ? themeTokens.neutral[900] : 'common.white',
                    transition: 'background-color 150ms ease, color 150ms ease',
                    '&:hover': {
                      backgroundColor: isFlash ? themeTokens.colors.amber : themeTokens.colors.successHover,
                    },
                  }}
                  aria-label={t('playView.tickBar.saveTickAria')}
                >
                  <TickIcon isFlash={!!isFlash} />
                </IconButton>
              </TickButtonWithLabel>
            </div>
          </>
        )}
      </div>
    </div>
  );
});
PlayViewTickBar.displayName = 'PlayViewTickBar';

type PlayViewDrawerProps = {
  activeDrawer: ActiveDrawer;
  setActiveDrawer: (drawer: ActiveDrawer) => void;
  boardDetails: BoardDetails;
  angle: Angle;
};

const PlayViewDrawer: React.FC<PlayViewDrawerProps> = ({ activeDrawer, setActiveDrawer, boardDetails, angle }) => {
  const { t } = useTranslation('session');
  const isOpen = activeDrawer === 'play';
  const [isActionsOpen, setIsActionsOpen] = useState(false);
  const [isQueueOpen, setIsQueueOpen] = useState(false);
  const [queueMounted, setQueueMounted] = useState(false);
  /**
   * True while the nested queue is being opened by the onboarding tour — read
   * at `QueueDrawer` mount time to seed `initialShowHistory`. Kept as a ref
   * rather than state because it only needs to be consumed once per mount and
   * must be synchronously up-to-date with the open handler.
   */
  const queueOpenedByTourRef = useRef(false);
  const [isPlaylistSelectorOpen, setIsPlaylistSelectorOpen] = useState(false);
  const [isTickBarActive, setIsTickBarActive] = useState(false);
  const [isBoardZoomed, setIsBoardZoomed] = useState(false);
  const [mode, setMode] = useState<'spectate' | 'edit'>('edit');

  useEffect(() => {
    const scrollContainer = playPaperRef.current?.querySelector('[data-scroll-container]') as HTMLElement | null;
    if (!scrollContainer) return;
    scrollContainer.style.overflowY = isBoardZoomed ? 'hidden' : '';
  }, [isBoardZoomed, isOpen]);

  const playPaperRef = useRef<HTMLDivElement>(null);

  // Custom swipe-to-close for nested disablePortal drawers (actions + playlist)
  const handleCloseActions = useCallback(() => setIsActionsOpen(false), []);

  // Actions drawer drag-to-resize
  const { paperRef: actionsPaperRef, dragHandlers: actionsDragHandlers } = useDrawerDragResize({
    open: isActionsOpen,
    onClose: handleCloseActions,
  });

  const pathname = usePathname();
  const { showMessage } = useSnackbar();

  const { logbook } = useBoardProvider();

  const currentClimbData = useCurrentClimb();
  const queueData = useQueueData();
  const queueListData = useQueueList();
  const sessionData = useSessionData();

  const deferredCurrentClimb = useDeferredValue(currentClimbData);
  const deferredQueue = useDeferredValue(queueListData);
  const deferredSession = useDeferredValue(sessionData);

  const { currentClimb, currentClimbQueueItem } = isOpen ? currentClimbData : deferredCurrentClimb;
  const { queue } = isOpen ? queueListData : deferredQueue;
  const { viewOnlyMode, clientId } = isOpen ? sessionData : deferredSession;
  const { activeClimberUserId, picks } = queueData;
  const { mirrorClimb, getNextClimbQueueItem, getPreviousClimbQueueItem, setMyPickQueueItem, claimTurn } =
    useQueueActions();
  const bluetooth = useBluetoothContext();

  const myUserId = useMemo(() => {
    return clientId ?? null;
  }, [clientId]);
  const isActiveClimber = !!myUserId && activeClimberUserId === myUserId;
  const myPickItem = myUserId ? picks[myUserId]?.item : null;
  const displayQueueItem = mode === 'edit' ? (myPickItem ?? currentClimbQueueItem) : currentClimbQueueItem;
  const displayClimb = displayQueueItem?.climb ?? currentClimb;

  const { handleDoubleTap, showHeart, dismissHeart, isFavorited, toggleFavorite } = useDoubleTapFavorite({
    climbUuid: displayClimb?.uuid ?? '',
  });

  const currentQueueIndex = displayQueueItem ? queue.findIndex((item) => item.uuid === displayQueueItem.uuid) : -1;
  const remainingQueueCount = currentQueueIndex >= 0 ? queue.length - currentQueueIndex : queue.length;

  useWakeLock(isOpen);

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
    if (isActionsOpen || isQueueOpen || isPlaylistSelectorOpen) return;
    setDrawerOpen(false);
    setActiveDrawer('none');
    if (window.location.hash === '#playing') {
      window.history.back();
    }
  }, [setActiveDrawer, isActionsOpen, isQueueOpen, isPlaylistSelectorOpen]);

  // Compute ascent info for tick FAB badge
  const currentAngle = typeof angle === 'string' ? parseInt(angle, 10) : angle;
  const filteredLogbook = useMemo(() => {
    if (!logbook || !displayClimb) return [];
    return logbook.filter((asc) => asc.climb_uuid === displayClimb.uuid && Number(asc.angle) === currentAngle);
  }, [logbook, displayClimb, currentAngle]);

  const hasSuccessfulAscent = filteredLogbook.some((asc) => asc.is_ascent);
  const ascentCount = filteredLogbook.length;

  // Card-swipe navigation
  const displayQueueIndex = displayQueueItem ? queue.findIndex((item) => item.uuid === displayQueueItem.uuid) : -1;
  const nextItem =
    mode === 'edit' && displayQueueIndex >= 0 ? (queue[displayQueueIndex + 1] ?? null) : getNextClimbQueueItem();
  const prevItem =
    mode === 'edit' && displayQueueIndex > 0 ? (queue[displayQueueIndex - 1] ?? null) : getPreviousClimbQueueItem();

  const handleSwipeNext = useCallback(() => {
    const next = getNextClimbQueueItem();
    if (mode === 'spectate') return;
    const item = mode === 'edit' && displayQueueIndex >= 0 ? queue[displayQueueIndex + 1] : next;
    if (!item || viewOnlyMode) return;
    void setMyPickQueueItem(item);
    track('Queue Navigation', { direction: 'next', method: 'swipePlayViewDrawer' });
  }, [getNextClimbQueueItem, mode, displayQueueIndex, queue, setMyPickQueueItem, viewOnlyMode]);

  const handleSwipePrevious = useCallback(() => {
    const prev = getPreviousClimbQueueItem();
    if (mode === 'spectate') return;
    const item = mode === 'edit' && displayQueueIndex > 0 ? queue[displayQueueIndex - 1] : prev;
    if (!item || viewOnlyMode) return;
    void setMyPickQueueItem(item);
    track('Queue Navigation', { direction: 'previous', method: 'swipePlayViewDrawer' });
  }, [getPreviousClimbQueueItem, mode, displayQueueIndex, queue, setMyPickQueueItem, viewOnlyMode]);

  const canSwipeNext = mode === 'edit' && !viewOnlyMode && !!nextItem;
  const canSwipePrevious = mode === 'edit' && !viewOnlyMode && !!prevItem;

  // Tick FAB → inline tick bar
  const handleTickFabClick = useCallback(() => {
    setIsActionsOpen(false);
    setIsTickBarActive(true);
  }, []);

  const handleTickBarClose = useCallback(() => {
    setIsTickBarActive(false);
  }, []);

  // Reset tick bar when the climb changes so it doesn't stay open for the wrong climb
  useEffect(() => {
    setIsTickBarActive(false);
  }, [displayClimb?.uuid]);

  const handleTickBarError = useCallback(() => {
    showMessage(t('playView.tickError'), 'error');
  }, [showMessage, t]);

  const handlePrevNavClick = useCallback(() => {
    const prev = getPreviousClimbQueueItem();
    const item = mode === 'edit' && displayQueueIndex > 0 ? queue[displayQueueIndex - 1] : prev;
    if (!item || mode === 'spectate') return;
    void setMyPickQueueItem(item);
    track('Queue Navigation', { direction: 'previous', method: 'playViewDrawer' });
  }, [getPreviousClimbQueueItem, mode, displayQueueIndex, queue, setMyPickQueueItem]);
  const handleNextNavClick = useCallback(() => {
    const next = getNextClimbQueueItem();
    const item = mode === 'edit' && displayQueueIndex >= 0 ? queue[displayQueueIndex + 1] : next;
    if (!item || mode === 'spectate') return;
    void setMyPickQueueItem(item);
    track('Queue Navigation', { direction: 'next', method: 'playViewDrawer' });
  }, [getNextClimbQueueItem, mode, displayQueueIndex, queue, setMyPickQueueItem]);
  const handleOpenActionsMenu = useCallback(() => {
    setIsQueueOpen(false);
    setIsPlaylistSelectorOpen(false);
    setIsActionsOpen(true);
  }, []);
  const handleOpenQueueDrawer = useCallback(() => {
    setIsActionsOpen(false);
    setIsPlaylistSelectorOpen(false);
    setQueueMounted(true);
    setIsQueueOpen(true);
  }, []);

  const isMirrored = !!displayClimb?.mirrored;

  const handleLightbulb = useCallback(async () => {
    if (!displayClimb || mode !== 'edit') return;
    if (!myPickItem && displayQueueItem) {
      await setMyPickQueueItem(displayQueueItem);
    }
    if (!bluetooth.isConnected && bluetooth.isBluetoothSupported) {
      const connected = await bluetooth.connect(displayClimb.frames, !!displayClimb.mirrored);
      if (!connected) return;
    }
    await claimTurn();
  }, [bluetooth, claimTurn, displayClimb, displayQueueItem, mode, myPickItem, setMyPickQueueItem]);

  const handleSwitchToEdit = useCallback(() => {
    setMode('edit');
  }, []);

  // Go to queue from actions drawer
  const handleGoToQueueFromActions = useCallback(() => {
    handleCloseActions();
    handleOpenQueueDrawer();
  }, [handleCloseActions, handleOpenQueueDrawer]);

  const handleClosePlaylist = useCallback(() => setIsPlaylistSelectorOpen(false), []);
  const playlistSwipe = useNestedDrawerSwipe(handleClosePlaylist);

  // Queue drawer callbacks
  const handleCloseQueueDrawer = useCallback(() => {
    setIsQueueOpen(false);
  }, []);
  const handleQueueTransitionEnd = useCallback(
    (open: boolean) => {
      if (!open && !isQueueOpen) {
        setQueueMounted(false);
      }
    },
    [isQueueOpen],
  );

  useEffect(() => {
    const handler = () => setIsQueueOpen(false);
    window.addEventListener(PLAY_DRAWER_EVENT, handler);
    return () => window.removeEventListener(PLAY_DRAWER_EVENT, handler);
  }, []);

  // Tour hooks: allow the onboarding tour to open/close the nested queue
  // drawer without the user having to find the button.
  useEffect(() => {
    const openHandler = () => {
      queueOpenedByTourRef.current = true;
      setIsActionsOpen(false);
      setIsPlaylistSelectorOpen(false);
      setQueueMounted(true);
      setIsQueueOpen(true);
    };
    const closeHandler = () => {
      queueOpenedByTourRef.current = false;
      setIsQueueOpen(false);
    };
    window.addEventListener(TOUR_OPEN_PLAY_QUEUE_EVENT, openHandler);
    window.addEventListener(TOUR_CLOSE_PLAY_QUEUE_EVENT, closeHandler);
    return () => {
      window.removeEventListener(TOUR_OPEN_PLAY_QUEUE_EVENT, openHandler);
      window.removeEventListener(TOUR_CLOSE_PLAY_QUEUE_EVENT, closeHandler);
    };
  }, []);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const openRafRef = useRef<number>(0);
  const hasBeenMountedRef = useRef(false);

  const [contentReady, setContentReady] = useState(false);
  useEffect(() => {
    const setReady = () => {
      setContentReady(true);
      hasBeenMountedRef.current = true;
    };
    const w = window as WindowWithIdleCallback;
    if (w.requestIdleCallback) {
      const id = w.requestIdleCallback(setReady, { timeout: 500 });
      return () => window.cancelIdleCallback(id);
    }
    const id = requestAnimationFrame(setReady);
    return () => cancelAnimationFrame(id);
  }, []);

  useLayoutEffect(() => {
    if (!isOpen) {
      cancelAnimationFrame(openRafRef.current);
      setDrawerOpen(false);
      setQueueMounted(false);
      setIsQueueOpen(false);
      setIsActionsOpen(false);
      setIsTickBarActive(false);
    }
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) {
      setMode(isActiveClimber || !activeClimberUserId ? 'edit' : 'spectate');
      if (playPaperRef.current) {
        playPaperRef.current.style.transform = '';
        playPaperRef.current.style.transition = '';
      }
      setContentReady(true);
      if (hasBeenMountedRef.current) {
        setDrawerOpen(true);
      } else {
        hasBeenMountedRef.current = true;
        openRafRef.current = requestAnimationFrame(() => {
          setDrawerOpen(true);
        });
      }
    }
    return () => cancelAnimationFrame(openRafRef.current);
  }, [isOpen, isActiveClimber, activeClimberUserId]);

  const [sectionsEverEnabled, setSectionsEverEnabled] = useState(false);
  const handleTransitionEnd = useCallback((open: boolean) => {
    if (open) setSectionsEverEnabled(true);
  }, []);

  const currentFrames = displayClimb?.frames;
  const currentMirrored = displayClimb?.mirrored;
  useEffect(() => {
    if (displayClimb) {
      renderBoard({
        boardDetails,
        frames: displayClimb.frames,
        mirrored: !!displayClimb.mirrored,
      }).catch((e: unknown) => {
        if (process.env.NODE_ENV === 'development') console.info('Pre-warm render failed:', e);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see comment above
  }, [currentFrames, currentMirrored, boardDetails]);

  const handleBoardPullClose = useCallback(() => {
    setDrawerOpen(false);
    setActiveDrawer('none');
    if (window.location.hash === '#playing') {
      window.history.back();
    }
  }, [setActiveDrawer]);

  const boardPull = usePullToClose({
    paperEl: playPaperRef.current,
    onClose: handleBoardPullClose,
    deadZone: 60,
    closeThreshold: 70,
    trackPullOrigin: true,
    offsetByDeadZone: true,
  });

  const handleBoardTouchStart = useCallback(
    (e: React.TouchEvent) => {
      (e.nativeEvent as unknown as Record<string, unknown>).defaultMuiPrevented = true;

      const scrollContainer = findScrollContainer(e.target as HTMLElement);
      const y = e.touches[0].clientY;
      boardPull.onTouchStart(y, scrollContainer);

      if (scrollContainer && scrollContainer.scrollTop <= 0) {
        boardPull.stateRef.current.pullOriginY = y;
      }
    },
    [boardPull],
  );

  const handleBoardTouchMove = useCallback(
    (e: React.TouchEvent) => {
      boardPull.onTouchMove(e.touches[0].clientY, e.touches.length, isBoardZoomed);
    },
    [boardPull, isBoardZoomed],
  );

  const handleBoardTouchEnd = useCallback(() => {
    boardPull.onTouchEnd();
  }, [boardPull]);

  const aboveFold = useMemo(() => {
    if (!displayClimb) return null;
    return (
      <>
        {/* Header: Grade | Name */}
        <div className={styles.headerSection}>
          <ClimbDetailHeader climb={displayClimb} />
        </div>

        {/* Board renderer with card-swipe and floating Tick FAB */}
        <div className={styles.boardSectionWrapper}>
          {displayClimb && (
            <SwipeBoardCarousel
              boardDetails={boardDetails}
              currentClimb={displayClimb}
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
              onZoomChange={setIsBoardZoomed}
              overlay={<HeartAnimationOverlay visible={showHeart} onAnimationEnd={dismissHeart} />}
            />
          )}

          {/* Floating Tick FAB - hides when tick bar is active */}
          {isOpen && (
            <div className={styles.tickFabContainer}>
              <button
                className={`${styles.tickFab} ${hasSuccessfulAscent ? styles.tickFabSuccess : ''} ${isTickBarActive ? styles.tickFabHiding : ''}`}
                onClick={handleTickFabClick}
                aria-label={t('playView.tickFab.logAscentAria')}
                disabled={isTickBarActive}
              >
                <CheckOutlined className={styles.tickFabIcon} />
                {ascentCount > 0 && <span className={styles.tickFabBadge}>{ascentCount}</span>}
              </button>
            </div>
          )}

          {/* Tick bar backdrop overlay */}
          {isOpen && (
            <div
              className={`${styles.tickBarOverlay} ${isTickBarActive ? styles.tickBarOverlayActive : ''}`}
              onClick={handleTickBarClose}
              aria-hidden="true"
            />
          )}

          {/* Floating tick bar — overlays bottom of board section, no reflow */}
          {isOpen && displayClimb && (
            <PlayViewTickBar
              isTickBarActive={isTickBarActive}
              currentClimb={displayClimb}
              angle={angle}
              boardDetails={boardDetails}
              onClose={handleTickBarClose}
              onError={handleTickBarError}
            />
          )}
        </div>

        {/* Action bar */}
        {isOpen && (
          <PlayViewActionBar
            canSwipePrevious={canSwipePrevious}
            canSwipeNext={canSwipeNext}
            isMirrored={isMirrored}
            supportsMirroring={!!boardDetails.supportsMirroring}
            isFavorited={isFavorited}
            remainingQueueCount={remainingQueueCount}
            onPrevClick={handlePrevNavClick}
            onNextClick={handleNextNavClick}
            onMirror={mirrorClimb}
            onToggleFavorite={toggleFavorite}
            onOpenActions={handleOpenActionsMenu}
            onOpenQueue={handleOpenQueueDrawer}
            onLightbulb={handleLightbulb}
            onSwitchToEdit={handleSwitchToEdit}
            isActiveClimber={isActiveClimber}
            showLightbulb={mode === 'edit'}
            showSwitchToEdit={mode === 'spectate'}
            angleSelector={
              <AngleSelector
                boardName={boardDetails.board_name}
                boardDetails={boardDetails}
                currentAngle={currentAngle}
                currentClimb={displayClimb}
                isAngleAdjustable
              />
            }
          />
        )}
      </>
    );
  }, [
    displayClimb,
    boardDetails,
    currentAngle,
    nextItem,
    prevItem,
    handleSwipeNext,
    handleSwipePrevious,
    canSwipeNext,
    canSwipePrevious,
    handleDoubleTap,
    showHeart,
    dismissHeart,
    isOpen,
    hasSuccessfulAscent,
    ascentCount,
    handleTickFabClick,
    isTickBarActive,
    isMirrored,
    isFavorited,
    remainingQueueCount,
    handlePrevNavClick,
    handleNextNavClick,
    mirrorClimb,
    toggleFavorite,
    handleOpenActionsMenu,
    handleOpenQueueDrawer,
    handleLightbulb,
    handleSwitchToEdit,
    isActiveClimber,
    mode,
    angle,
    handleTickBarClose,
    handleTickBarError,
  ]);

  return (
    <SwipeableDrawer
      placement="bottom"
      height="100%"
      fullHeight
      open={drawerOpen}
      onClose={handleClose}
      onTransitionEnd={handleTransitionEnd}
      keepMounted
      paperRef={playPaperRef}
      swipeEnabled={!isActionsOpen && !isQueueOpen && !isPlaylistSelectorOpen}
      showDragHandle
      styles={{
        body: { padding: 0 },
        wrapper: { height: '100%', backgroundColor: 'var(--semantic-background)' },
      }}
    >
      {contentReady || isOpen ? (
        <>
          <IconButton
            size="small"
            onClick={handleClose}
            aria-label={t('playView.closeAria')}
            sx={{
              position: 'absolute',
              top: 8,
              right: 8,
              zIndex: 2,
              color: 'text.primary',
              backgroundColor: 'action.selected',
              '&:hover': { backgroundColor: 'action.focus' },
            }}
          >
            <CloseOutlined />
          </IconButton>
          <div
            className={styles.drawerContent}
            onTouchStart={handleBoardTouchStart}
            onTouchMove={handleBoardTouchMove}
            onTouchEnd={handleBoardTouchEnd}
          >
            {displayClimb ? (
              <PlayDrawerContent
                climb={displayClimb}
                boardType={boardDetails.board_name}
                angle={currentAngle}
                sectionsEnabled={sectionsEverEnabled && isOpen}
                aboveFold={aboveFold}
              />
            ) : (
              <ClimbDetailShellClient mode="play" sections={[]} aboveFold={null} />
            )}
          </div>

          {/* Climb actions drawer */}
          {isOpen && displayClimb && isActionsOpen && (
            <SwipeableDrawer
              placement="bottom"
              title={
                displayClimb ? (
                  <div data-swipe-blocked="" {...actionsDragHandlers} className={drawerCss.dragHeaderWrapper}>
                    <DrawerClimbHeader climb={displayClimb} boardDetails={boardDetails} />
                  </div>
                ) : undefined
              }
              height="60%"
              paperRef={actionsPaperRef}
              open={isActionsOpen}
              onClose={handleCloseActions}
              swipeEnabled={false}
              disablePortal
              styles={{
                wrapper: {
                  touchAction: 'pan-y' as const,
                  transition: 'height 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                },
                body: { padding: `${themeTokens.spacing[2]}px 0` },
              }}
            >
              <ClimbActions
                climb={displayClimb}
                boardDetails={boardDetails}
                angle={currentAngle}
                currentPathname={pathname}
                viewMode="list"
                onOpenPlaylistSelector={() => {
                  setIsActionsOpen(false);
                  setIsPlaylistSelectorOpen(true);
                }}
                onActionComplete={handleCloseActions}
                onGoToQueue={handleGoToQueueFromActions}
              />
            </SwipeableDrawer>
          )}

          {/* Playlist selector drawer */}
          {isOpen && displayClimb && isPlaylistSelectorOpen && (
            <SwipeableDrawer
              title={<DrawerClimbHeader climb={displayClimb} boardDetails={boardDetails} />}
              placement="bottom"
              open={isPlaylistSelectorOpen}
              onClose={handleClosePlaylist}
              paperRef={playlistSwipe.paperRef}
              swipeEnabled={false}
              disablePortal
              styles={{
                wrapper: { height: 'auto', maxHeight: '70vh' },
                body: { padding: 0 },
                header: {
                  paddingLeft: `${themeTokens.spacing[3]}px`,
                  paddingRight: `${themeTokens.spacing[3]}px`,
                },
              }}
            >
              <PlaylistSelectionContent
                climbUuid={displayClimb.uuid}
                boardDetails={boardDetails}
                angle={currentAngle}
                onDone={handleClosePlaylist}
              />
            </SwipeableDrawer>
          )}
        </>
      ) : null}

      {/* Queue list drawer */}
      {queueMounted && (
        <QueueDrawer
          open={isQueueOpen}
          onClose={handleCloseQueueDrawer}
          onTransitionEnd={handleQueueTransitionEnd}
          boardDetails={boardDetails}
          initialShowHistory={queueOpenedByTourRef.current}
        />
      )}
    </SwipeableDrawer>
  );
};

export default React.memo(PlayViewDrawer);
