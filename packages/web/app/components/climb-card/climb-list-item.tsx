'use client';

import React, { useRef, useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import IconButton from '@mui/material/IconButton';
import dynamic from 'next/dynamic';
import MoreHorizOutlined from '@mui/icons-material/MoreHorizOutlined';
import AddOutlined from '@mui/icons-material/AddOutlined';
import CheckOutlined from '@mui/icons-material/CheckOutlined';
import LocalOfferOutlined from '@mui/icons-material/LocalOfferOutlined';
import { track } from '@/app/lib/analytics';
import type { Climb, BoardDetails } from '@/app/lib/types';
import type { AddToQueueSource } from '../queue-control/types';
import ClimbThumbnail from './climb-thumbnail';
import ClimbTitle, { type ClimbTitleProps } from './climb-title';
import DrawerClimbHeader from './drawer-climb-header';
import { AscentStatus } from './ascent-status';
import { ClimbActionsDrawer } from '../climb-actions';
import { useDoubleTapFavorite } from '../climb-actions/use-double-tap-favorite';
import HeartAnimationOverlay from './heart-animation-overlay';
import PlaylistSelectionContent from '../climb-actions/playlist-selection-content';
import { useSwipeActions } from '@/app/hooks/use-swipe-actions';
import { useDoubleTap } from '@/app/lib/hooks/use-double-tap';
import { themeTokens } from '@/app/theme/theme-config';
import { getGradeTintColor } from '@/app/lib/grade-colors';
import { getExcludedClimbActions } from '@/app/lib/climb-action-utils';
import { useIsClimbSelected } from '../board-page/selected-climb-store';
import { InlineListTickBar } from '../logbook/inline-list-tick-bar';
import { useOptionalBoardProvider } from '../board-provider/board-provider-context';
import { useSnackbar } from '../providers/snackbar-provider';
import ascentStyles from './ascent-status.module.css';

const SwipeableDrawer = dynamic(() => import('../swipeable-drawer/swipeable-drawer'), {
  ssr: false,
});
const QueueDrawer = dynamic(() => import('../play-view/queue-drawer'), { ssr: false });

// Keep swipe visuals aligned with gesture max distance
const MAX_GESTURE_SWIPE = 180;
const SHORT_ACTION_WIDTH = 120;
const RIGHT_ACTION_WIDTH = 100;
const RIGHT_OVERRIDE_ACTION_WIDTH = 120;
const LONG_SWIPE_ACTION_WIDTH = MAX_GESTURE_SWIPE;
const SHORT_SWIPE_THRESHOLD = 60;
const TRANSITION_START = 115;
const LONG_SWIPE_THRESHOLD = 150;

// Static style objects (no reactive deps, hoisted out of component to avoid per-render allocation)
const swipeActionLayerBaseStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-start',
  paddingLeft: themeTokens.spacing[4],
  willChange: 'opacity',
};

const rightSwipeActionLayerBaseStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  paddingRight: themeTokens.spacing[4],
  willChange: 'opacity',
};

// Static initial styles for action layers — opacity updated via direct DOM manipulation during swipe
const shortSwipeLayerInitialStyle: React.CSSProperties = {
  ...swipeActionLayerBaseStyle,
  backgroundColor: 'var(--color-primary-fill)',
  opacity: 0,
};

const longSwipeLayerInitialStyle: React.CSSProperties = {
  ...swipeActionLayerBaseStyle,
  backgroundColor: themeTokens.neutral[600],
  opacity: 0,
};

const rightActionLayerDefaultStyle: React.CSSProperties = {
  ...rightSwipeActionLayerBaseStyle,
  backgroundColor: 'var(--color-success)',
  opacity: 0,
  transition: 'opacity 120ms ease-out',
};

const rightActionLayerConfirmedStyle: React.CSSProperties = {
  ...rightSwipeActionLayerBaseStyle,
  backgroundColor: 'var(--color-success)',
  opacity: 0,
  transition: 'opacity 120ms ease-out',
};

const defaultLeftActionStyle: React.CSSProperties = {
  position: 'absolute',
  left: 0,
  top: 0,
  bottom: 0,
  width: SHORT_ACTION_WIDTH,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-start',
  paddingLeft: themeTokens.spacing[3],
  opacity: 0,
  visibility: 'hidden',
  overflow: 'hidden',
};

const defaultRightActionStyle: React.CSSProperties = {
  position: 'absolute',
  right: 0,
  top: 0,
  bottom: 0,
  width: RIGHT_ACTION_WIDTH,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  paddingRight: themeTokens.spacing[3],
  opacity: 0,
  visibility: 'hidden',
  overflow: 'hidden',
};

const iconStyle: React.CSSProperties = { color: 'white', fontSize: 20 };

const thumbnailStyle: React.CSSProperties = {
  width: themeTokens.spacing[16],
  flexShrink: 0,
  position: 'relative',
};

const centerStyle: React.CSSProperties = { flex: 1, minWidth: 0 };

const iconButtonStyle: React.CSSProperties = { flexShrink: 0, color: 'var(--neutral-400)' };

const playlistDrawerStyles = {
  wrapper: { height: 'auto', maxHeight: '70vh', width: '100%' },
  body: { padding: 0 },
  header: {
    paddingLeft: `${themeTokens.spacing[3]}px`,
    paddingRight: `${themeTokens.spacing[3]}px`,
  },
} as const;

export type SwipeActionOverride = {
  icon: React.ReactNode;
  color: string;
  onAction: () => void;
};

type ClimbListItemProps = {
  climb: Climb;
  /** Board details for thumbnail and actions rendering. Required unless thumbnailSlot + menuSlot are both provided. */
  boardDetails?: BoardDetails;
  /** Current pathname — passed from parent to avoid per-instance usePathname() context lookups. */
  pathname: string;
  /** Whether the app is in dark mode — passed from parent to avoid per-instance context lookups. */
  isDark: boolean;
  /** Override selected state (e.g. in queue drawer). When omitted, subscribes to SelectionStoreContext. */
  selected?: boolean;
  /** When true, the item is visually dimmed (greyed out) but still interactive */
  unsupported?: boolean;
  /** When true, the climb fits only on a bigger board than the user's current session — render dimmed and route clicks to `onNeedsBiggerBoard` instead of selecting. */
  needsBiggerBoard?: boolean;
  /** Fired when the user taps a `needsBiggerBoard` item, so the parent can show a warning. */
  onNeedsBiggerBoard?: () => void;
  /** When true, swipe gestures (favorite/queue) are disabled */
  disableSwipe?: boolean;
  onSelect?: () => void;
  /** Override the right swipe action (revealed on swipe left). Default: add to queue.
   *  Only used by queue items to replace add-to-queue with tick. */
  swipeRightAction?: SwipeActionOverride;
  /** Content rendered between the title and menu button (e.g., avatar) */
  afterTitleSlot?: React.ReactNode;
  /** Override ClimbTitle props. When provided, replaces the defaults entirely. */
  titleProps?: Partial<ClimbTitleProps>;
  /** Override background color of the swipeable content */
  backgroundColor?: string;
  /** Override content opacity (e.g., 0.6 for history items) */
  contentOpacity?: number;
  /** When true, prefer SSR image layers over the canvas renderer for this item. */
  preferImageLayers?: boolean;
  /** Set fetchpriority="high" for LCP-critical images */
  fetchPriority?: 'high' | 'low' | 'auto';
  /** Handler for thumbnail clicks. When set, stops propagation so the row onClick doesn't also fire. */
  onThumbnailClick?: () => void;
  /** When provided, the item delegates opening the actions drawer to the parent instead of rendering its own. */
  onOpenActions?: (climb: Climb) => void;
  /** When provided, the item delegates opening the playlist selector to the parent instead of rendering its own. */
  onOpenPlaylistSelector?: (climb: Climb) => void;
  /** Optional callback to add the climb to the queue (default swipe-left action).
   *  When not provided, swipe-left is a no-op. Pass from a parent that subscribes to QueueContext.
   *  The optional `source` is forwarded for analytics attribution. */
  addToQueue?: (climb: Climb, source?: AddToQueueSource) => void;
  /** Replaces the default ClimbThumbnail + heart overlay + AscentStatus badge with custom content. */
  thumbnailSlot?: React.ReactNode;
  /** Renders below the swipeable row (e.g., inline edit controls). */
  belowContentSlot?: React.ReactNode;
  /** Replaces the default ellipsis menu button and its associated drawers with custom content. */
  menuSlot?: React.ReactNode;
  /** When true, disables the double-tap-to-favorite gesture on the thumbnail. */
  disableFavorite?: boolean;
  /** When true, skips subscribing to the climb selection store. */
  disableSelection?: boolean;
  /** Renders below ClimbTitle inside the center section (e.g., comment + user tick info row). */
  centerBottomSlot?: React.ReactNode;
  /** Override the default content padding (default: `${spacing[2]}px ${spacing[2]}px`). */
  contentPadding?: string;
};

const ClimbListItem: React.FC<ClimbListItemProps> = React.memo(
  ({
    climb,
    boardDetails,
    pathname,
    isDark,
    selected: selectedOverride,
    unsupported,
    needsBiggerBoard,
    onNeedsBiggerBoard,
    disableSwipe,
    onSelect,
    swipeRightAction,
    afterTitleSlot,
    titleProps,
    backgroundColor,
    contentOpacity,
    preferImageLayers,
    fetchPriority,
    onThumbnailClick,
    onOpenActions,
    onOpenPlaylistSelector,
    addToQueue,
    thumbnailSlot,
    belowContentSlot,
    menuSlot,
    disableFavorite,
    disableSelection,
    centerBottomSlot,
    contentPadding,
  }) => {
    const { t } = useTranslation('climbs');
    // Subscribe to selection store — only re-renders when THIS item's selected state changes.
    // When `selectedOverride` or `disableSelection` is provided, ignore the store value.
    const storeSelected = useIsClimbSelected(climb.uuid);
    const selected = selectedOverride ?? (disableSelection ? false : storeSelected);
    // Check if we're inside a BoardProvider — needed for inline tick bar
    const boardProvider = useOptionalBoardProvider();
    // When parent provides both drawer callbacks or a custom menuSlot, skip local drawers entirely.
    const hasParentDrawers = Boolean(menuSlot || (onOpenActions && onOpenPlaylistSelector));
    const [isActionsOpen, setIsActionsOpen] = useState(false);
    const [isPlaylistSelectorOpen, setIsPlaylistSelectorOpen] = useState(false);
    const [isInlineTickOpen, setIsInlineTickOpen] = useState(false);
    const { showMessage } = useSnackbar();
    // Refs for inner action layer elements — updated via direct DOM manipulation during swipe
    const shortSwipeLayerRef = useRef<HTMLDivElement>(null);
    const longSwipeLayerRef = useRef<HTMLDivElement>(null);
    const rightActionLayerRef = useRef<HTMLDivElement>(null);
    const leftActionContainerRef = useRef<HTMLDivElement>(null);
    // Store addToQueue in a ref so the memoized handler always reads the latest
    // value without requiring addToQueue in the memo comparator.
    const addToQueueRef = useRef(addToQueue);
    addToQueueRef.current = addToQueue;
    const { handleDoubleTap, showHeart, dismissHeart, isFavorited } = useDoubleTapFavorite({
      climbUuid: climb.uuid,
    });
    const { ref: doubleTapRef, onDoubleClick: handleDoubleTapClick } = useDoubleTap(handleDoubleTap);
    // Store onThumbnailClick in a ref so the memoized handler always reads the latest
    // value without requiring onThumbnailClick in the memo comparator.
    const onThumbnailClickRef = useRef(onThumbnailClick);
    onThumbnailClickRef.current = onThumbnailClick;

    // Per-direction override flag
    const hasRightOverride = Boolean(swipeRightAction);

    // Default swipe handlers
    // Swipe left (right action): add to queue
    const handleDefaultSwipeLeft = useCallback(() => {
      addToQueueRef.current?.(climb, 'search');
      track('Add to Queue', { source: 'swipe' });
    }, [climb]);

    // Swipe right short (left action): open playlist selector
    const handleDefaultSwipeRight = useCallback(() => {
      if (onOpenPlaylistSelector) {
        onOpenPlaylistSelector(climb);
      } else {
        setIsActionsOpen(false);
        setIsPlaylistSelectorOpen(true);
      }
    }, [onOpenPlaylistSelector, climb]);

    // Swipe right long (left action): open actions menu
    const handleDefaultSwipeRightLong = useCallback(() => {
      if (onOpenActions) {
        onOpenActions(climb);
      } else {
        setIsPlaylistSelectorOpen(false);
        setIsActionsOpen(true);
      }
    }, [onOpenActions, climb]);

    // Override handler for right swipe action (e.g., tick in queue)
    const handleOverrideSwipeLeft = useCallback(() => {
      swipeRightAction?.onAction();
    }, [swipeRightAction]);

    const resolvedSwipeLeft = hasRightOverride ? handleOverrideSwipeLeft : handleDefaultSwipeLeft;
    const rightActionRevealWidth = hasRightOverride ? RIGHT_OVERRIDE_ACTION_WIDTH : RIGHT_ACTION_WIDTH;

    // Direct DOM manipulation for swipe layer opacities — zero React re-renders during gesture
    const handleSwipeOffset = useCallback((offset: number) => {
      const rightOffset = offset > 0 ? offset : 0;
      const leftOffset = offset < 0 ? -offset : 0;

      // Right swipe: short (playlist) → long (actions) transition
      const rightBaseOpacity = Math.min(1, rightOffset / SHORT_SWIPE_THRESHOLD);
      const transitionRange = LONG_SWIPE_THRESHOLD - TRANSITION_START;
      const blend =
        transitionRange > 0 ? Math.max(0, Math.min(1, (rightOffset - TRANSITION_START) / transitionRange)) : 1;

      if (shortSwipeLayerRef.current) {
        shortSwipeLayerRef.current.style.opacity = String(rightBaseOpacity * (1 - blend));
      }
      if (longSwipeLayerRef.current) {
        longSwipeLayerRef.current.style.opacity = String(rightBaseOpacity * blend);
      }
      if (leftActionContainerRef.current) {
        leftActionContainerRef.current.style.width = `${SHORT_ACTION_WIDTH + (LONG_SWIPE_ACTION_WIDTH - SHORT_ACTION_WIDTH) * blend}px`;
      }

      // Left swipe: queue/tick action opacity
      if (rightActionLayerRef.current) {
        rightActionLayerRef.current.style.opacity = String(Math.min(1, leftOffset / SHORT_SWIPE_THRESHOLD));
      }
    }, []);

    const { swipeHandlers, swipeLeftConfirmed, contentRef, leftActionRef, rightActionRef } = useSwipeActions({
      onSwipeLeft: resolvedSwipeLeft,
      onSwipeRight: handleDefaultSwipeRight,
      onSwipeRightLong: handleDefaultSwipeRightLong,
      onSwipeOffsetChange: handleSwipeOffset,
      swipeThreshold: SHORT_SWIPE_THRESHOLD,
      longSwipeRightThreshold: LONG_SWIPE_THRESHOLD,
      maxSwipe: MAX_GESTURE_SWIPE,
      maxSwipeLeft: rightActionRevealWidth,
      disabled: disableSwipe,
      confirmationPeekOffset: rightActionRevealWidth,
    });

    // Combined ref callback for left action container — avoids inline function recreation
    const leftActionCombinedRef = useCallback(
      (node: HTMLDivElement | null) => {
        leftActionRef(node);
        leftActionContainerRef.current = node;
      },
      [leftActionRef],
    );

    // Combined ref callback for swipeable content div
    const contentCombinedRef = useCallback(
      (node: HTMLDivElement | null) => {
        if (!disableSwipe) {
          swipeHandlers.ref(node);
          contentRef(node);
        }
      },
      [disableSwipe, swipeHandlers, contentRef],
    );

    // Stable refs so the memoized handlers below stay stable across renders
    // even when the bigger-board callback identity changes.
    const onNeedsBiggerBoardRef = useRef(onNeedsBiggerBoard);
    onNeedsBiggerBoardRef.current = onNeedsBiggerBoard;
    const needsBiggerBoardRef = useRef(needsBiggerBoard);
    needsBiggerBoardRef.current = needsBiggerBoard;
    const onSelectRef = useRef(onSelect);
    onSelectRef.current = onSelect;

    // Thumbnail click handler — uses ref to avoid stale closure.
    // Always attached (not conditional) because onThumbnailClick is excluded from
    // the memo comparator; a render-time conditional would go stale.
    const handleThumbnailClick = useCallback((e: React.MouseEvent) => {
      if (needsBiggerBoardRef.current) {
        e.stopPropagation();
        onNeedsBiggerBoardRef.current?.();
        return;
      }
      if (!onThumbnailClickRef.current) return;
      e.stopPropagation();
      onThumbnailClickRef.current();
    }, []);

    // Row click — same interception for the bigger-board case.
    const handleRowClick = useCallback(() => {
      if (needsBiggerBoardRef.current) {
        onNeedsBiggerBoardRef.current?.();
        return;
      }
      onSelectRef.current?.();
    }, []);

    // Drawer state callbacks — extracted from inline to avoid per-render allocation
    const handleCloseActions = useCallback(() => setIsActionsOpen(false), []);
    const handleOpenPlaylistFromActions = useCallback(() => {
      setIsActionsOpen(false);
      setIsPlaylistSelectorOpen(true);
    }, []);
    const handleClosePlaylist = useCallback(() => setIsPlaylistSelectorOpen(false), []);

    // Inline tick bar callbacks
    const handleOpenInlineTickBar = useCallback(() => {
      setIsActionsOpen(false);
      setIsInlineTickOpen(true);
    }, []);

    const handleCloseTickBar = useCallback(() => {
      setIsInlineTickOpen(false);
    }, []);

    const handleTickError = useCallback(() => {
      showMessage(t('card.list.tickError'), 'error');
    }, [showMessage, t]);

    // --- Queue drawer state ---
    const [isQueueListOpen, setIsQueueListOpen] = useState(false);

    const handleGoToQueue = useCallback(() => {
      handleCloseActions();
      setIsQueueListOpen(true);
    }, [handleCloseActions]);

    const handleCloseQueueList = useCallback(() => {
      setIsQueueListOpen(false);
    }, []);

    // Menu button click handler — extracted from inline to avoid per-render allocation
    const handleMenuClick = useCallback(
      (e: React.MouseEvent) => {
        e.stopPropagation();
        if (onOpenActions) {
          onOpenActions(climb);
        } else {
          setIsPlaylistSelectorOpen(false);
          setIsActionsOpen(true);
        }
      },
      [onOpenActions, climb],
    );

    const excludeActions = useMemo(
      () => (boardDetails ? getExcludedClimbActions(boardDetails.board_name, 'list') : []),
      [boardDetails],
    );

    // Memoize style objects to prevent recreation on every render
    const containerStyle = useMemo(
      () => ({
        position: 'relative' as const,
        overflow: 'hidden' as const,
        ...(unsupported || needsBiggerBoard ? { opacity: 0.5, filter: 'grayscale(80%)' } : {}),
      }),
      [unsupported, needsBiggerBoard],
    );

    const rightOverrideActionStyle = useMemo(
      () => ({
        position: 'absolute' as const,
        right: 0,
        top: 0,
        bottom: 0,
        width: rightActionRevealWidth,
        backgroundColor: swipeRightAction?.color ?? 'var(--color-error)',
        display: 'flex' as const,
        alignItems: 'center' as const,
        justifyContent: 'flex-end' as const,
        paddingRight: themeTokens.spacing[4],
        opacity: 0,
        visibility: 'hidden' as const,
      }),
      [rightActionRevealWidth, swipeRightAction?.color],
    );

    const resolvedBg =
      backgroundColor ??
      (selected ? (getGradeTintColor(climb.difficulty, 'light', isDark) ?? 'var(--semantic-selected)') : 'transparent');

    const swipeableContentStyle = useMemo(
      () => ({
        display: 'flex' as const,
        alignItems: 'center' as const,
        padding: contentPadding ?? `${themeTokens.spacing[2]}px ${themeTokens.spacing[2]}px`,
        gap: themeTokens.spacing[3],
        backgroundColor: resolvedBg,
        borderBottom: '1px solid var(--border-subtle)',
        cursor: 'pointer' as const,
        userSelect: 'none' as const,
        opacity: contentOpacity ?? 1,
      }),
      [resolvedBg, contentOpacity, contentPadding],
    );

    // Default ClimbTitle props when no override is provided
    const resolvedTitleProps = useMemo<Partial<ClimbTitleProps>>(
      () =>
        titleProps ?? {
          gradePosition: 'right',
          showSetterInfo: true,
          titleFontSize: themeTokens.typography.fontSize.xl,
          favorited: isFavorited,
          isNoMatch: !!climb.is_no_match,
        },
      [titleProps, isFavorited, climb.is_no_match],
    );

    // Memoize right action layer styles to avoid inline object creation per render
    const rightActionDefaultLayerStyle = useMemo(
      () => (swipeLeftConfirmed ? { ...rightActionLayerDefaultStyle, opacity: 0 } : rightActionLayerDefaultStyle),
      [swipeLeftConfirmed],
    );

    const rightActionConfirmedLayerStyle = useMemo(
      () => ({ ...rightActionLayerConfirmedStyle, opacity: swipeLeftConfirmed ? 1 : 0 }),
      [swipeLeftConfirmed],
    );

    return (
      <>
        <div style={containerStyle}>
          {!disableSwipe && (
            <>
              {/* Left action (revealed on swipe right) */}
              <div ref={leftActionCombinedRef} style={defaultLeftActionStyle}>
                <div ref={shortSwipeLayerRef} style={shortSwipeLayerInitialStyle}>
                  <LocalOfferOutlined style={iconStyle} />
                </div>
                <div ref={longSwipeLayerRef} style={longSwipeLayerInitialStyle}>
                  <MoreHorizOutlined style={iconStyle} />
                </div>
              </div>

              {/* Right action (revealed on swipe left) */}
              {hasRightOverride ? (
                <div ref={rightActionRef} style={rightOverrideActionStyle} data-swipe-right-action="">
                  {swipeRightAction?.icon ?? null}
                </div>
              ) : (
                <div ref={rightActionRef} style={defaultRightActionStyle} data-swipe-right-action="">
                  {/* Default layer (Add icon) — opacity driven by swipe gesture via ref */}
                  <div ref={rightActionLayerRef} style={rightActionDefaultLayerStyle}>
                    <AddOutlined style={iconStyle} />
                  </div>
                  {/* Confirmed layer (Check icon) — crossfades in via CSS transition */}
                  <div style={rightActionConfirmedLayerStyle}>
                    <CheckOutlined style={iconStyle} />
                  </div>
                </div>
              )}
            </>
          )}

          {/* Content (swipeable when swipe is enabled) */}
          <div
            {...(disableSwipe ? {} : swipeHandlers)}
            ref={contentCombinedRef}
            onClick={handleRowClick}
            style={swipeableContentStyle}
            data-swipe-content=""
          >
            {/* Thumbnail with ascent status badge */}
            {thumbnailSlot ? (
              <div style={thumbnailStyle} data-testid="climb-thumbnail" onClick={handleThumbnailClick}>
                {thumbnailSlot}
              </div>
            ) : (
              <div
                ref={disableFavorite ? undefined : doubleTapRef}
                style={thumbnailStyle}
                data-testid="climb-thumbnail"
                onClick={handleThumbnailClick}
                onDoubleClick={disableFavorite ? undefined : handleDoubleTapClick}
              >
                {boardDetails && (
                  <ClimbThumbnail
                    boardDetails={boardDetails}
                    currentClimb={climb}
                    pathname={pathname}
                    preferImageLayers={preferImageLayers}
                    fetchPriority={fetchPriority}
                  />
                )}
                {!disableFavorite && (
                  <HeartAnimationOverlay visible={showHeart} onAnimationEnd={dismissHeart} size={32} />
                )}
                <AscentStatus
                  climbUuid={climb.uuid}
                  angle={climb.angle}
                  fontSize={12}
                  className={ascentStyles.badge}
                  mirroredClassName={ascentStyles.badgeMirrored}
                />
              </div>
            )}

            {/* Center: Name, stars, setter, colorized grade */}
            <div style={centerStyle}>
              <ClimbTitle climb={climb} {...resolvedTitleProps} isActive={selected} />
              {centerBottomSlot}
            </div>

            {/* After-title slot (e.g., avatar) */}
            {afterTitleSlot}

            {/* Menu button — custom slot or default ellipsis */}
            {menuSlot ?? (
              <IconButton
                size="small"
                aria-label={t('card.list.moreActions')}
                onClick={handleMenuClick}
                style={iconButtonStyle}
                disableRipple
              >
                <MoreHorizOutlined />
              </IconButton>
            )}
          </div>
        </div>

        {/* Below-content slot (e.g., inline edit controls) */}
        {belowContentSlot}

        {/* Default actions drawers - only rendered when no parent drawer callbacks and boardDetails is available */}
        {!hasParentDrawers && boardDetails && (
          <>
            <ClimbActionsDrawer
              open={isActionsOpen}
              onClose={handleCloseActions}
              climb={climb}
              boardDetails={boardDetails}
              angle={climb.angle}
              exclude={excludeActions}
              onOpenPlaylistSelector={handleOpenPlaylistFromActions}
              onTickAction={boardProvider?.isAuthenticated ? handleOpenInlineTickBar : undefined}
              onGoToQueue={handleGoToQueue}
            />

            <SwipeableDrawer
              title={<DrawerClimbHeader climb={climb} boardDetails={boardDetails} />}
              placement="bottom"
              open={isPlaylistSelectorOpen}
              onClose={handleClosePlaylist}
              styles={playlistDrawerStyles}
            >
              <PlaylistSelectionContent
                climbUuid={climb.uuid}
                boardDetails={boardDetails}
                angle={climb.angle}
                onDone={handleClosePlaylist}
              />
            </SwipeableDrawer>

            {isQueueListOpen && (
              <QueueDrawer open={isQueueListOpen} onClose={handleCloseQueueList} boardDetails={boardDetails} />
            )}
          </>
        )}

        {/* Inline tick bar — only mounted when open and inside a BoardProvider */}
        {isInlineTickOpen && boardProvider && boardDetails && (
          <InlineListTickBar
            climb={climb}
            angle={climb.angle}
            boardDetails={boardDetails}
            onClose={handleCloseTickBar}
            onError={handleTickError}
          />
        )}
      </>
    );
  },
  (prev, next) => {
    return (
      prev.climb.uuid === next.climb.uuid &&
      prev.climb.frames === next.climb.frames &&
      prev.climb.name === next.climb.name &&
      prev.climb.mirrored === next.climb.mirrored &&
      prev.pathname === next.pathname &&
      prev.isDark === next.isDark &&
      prev.selected === next.selected &&
      prev.unsupported === next.unsupported &&
      prev.needsBiggerBoard === next.needsBiggerBoard &&
      prev.disableSwipe === next.disableSwipe &&
      prev.boardDetails === next.boardDetails &&
      prev.swipeRightAction === next.swipeRightAction &&
      prev.afterTitleSlot === next.afterTitleSlot &&
      prev.titleProps === next.titleProps &&
      prev.backgroundColor === next.backgroundColor &&
      prev.contentOpacity === next.contentOpacity &&
      prev.preferImageLayers === next.preferImageLayers &&
      prev.onOpenActions === next.onOpenActions &&
      prev.onOpenPlaylistSelector === next.onOpenPlaylistSelector &&
      prev.thumbnailSlot === next.thumbnailSlot &&
      prev.belowContentSlot === next.belowContentSlot &&
      prev.menuSlot === next.menuSlot &&
      prev.disableFavorite === next.disableFavorite &&
      prev.disableSelection === next.disableSelection &&
      prev.centerBottomSlot === next.centerBottomSlot &&
      prev.contentPadding === next.contentPadding
    );
  },
);

ClimbListItem.displayName = 'ClimbListItem';

export default ClimbListItem;
