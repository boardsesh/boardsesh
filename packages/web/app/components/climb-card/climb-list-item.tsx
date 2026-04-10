'use client';

import React, { useRef, useState, useCallback, useMemo, useEffect } from 'react';
import IconButton from '@mui/material/IconButton';
import dynamic from 'next/dynamic';
import MoreHorizOutlined from '@mui/icons-material/MoreHorizOutlined';
import AddOutlined from '@mui/icons-material/AddOutlined';
import CheckOutlined from '@mui/icons-material/CheckOutlined';
import LocalOfferOutlined from '@mui/icons-material/LocalOfferOutlined';
import { Climb, BoardDetails } from '@/app/lib/types';
import ClimbThumbnail from './climb-thumbnail';
import ClimbTitle, { type ClimbTitleProps } from './climb-title';
import DrawerClimbHeader from './drawer-climb-header';
import { AscentStatus } from './ascent-status';
import { ClimbActions } from '../climb-actions';
import { useDoubleTapFavorite } from '../climb-actions/use-double-tap-favorite';
import HeartAnimationOverlay from './heart-animation-overlay';
import PlaylistSelectionContent from '../climb-actions/playlist-selection-content';
import { useSwipeActions } from '@/app/hooks/use-swipe-actions';
import { useDoubleTap } from '@/app/lib/hooks/use-double-tap';
import { themeTokens } from '@/app/theme/theme-config';
import { getGradeTintColor } from '@/app/lib/grade-colors';
import { getExcludedClimbActions } from '@/app/lib/climb-action-utils';
import { useIsClimbSelected } from '../board-page/selected-climb-store';
import styles from './climb-list-item.module.css';

const SwipeableDrawer = dynamic(() => import('../swipeable-drawer/swipeable-drawer'), { ssr: false });

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
  backgroundColor: themeTokens.colors.primary,
  opacity: 0,
};

const longSwipeLayerInitialStyle: React.CSSProperties = {
  ...swipeActionLayerBaseStyle,
  backgroundColor: themeTokens.neutral[600],
  opacity: 0,
};

const rightActionLayerDefaultStyle: React.CSSProperties = {
  ...rightSwipeActionLayerBaseStyle,
  backgroundColor: themeTokens.colors.primary,
  opacity: 0,
  transition: 'opacity 120ms ease-out',
};

const rightActionLayerConfirmedStyle: React.CSSProperties = {
  ...rightSwipeActionLayerBaseStyle,
  backgroundColor: themeTokens.colors.success,
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

const thumbnailStyle: React.CSSProperties = { width: themeTokens.spacing[16], flexShrink: 0, position: 'relative' };

const centerStyle: React.CSSProperties = { flex: 1, minWidth: 0 };

const iconButtonStyle: React.CSSProperties = { flexShrink: 0, color: 'var(--neutral-400)' };

const drawerStyles = {
  wrapper: { height: 'auto', width: '100%' },
  body: { padding: `${themeTokens.spacing[2]}px 0` },
  header: { paddingLeft: `${themeTokens.spacing[3]}px`, paddingRight: `${themeTokens.spacing[3]}px` },
} as const;

const playlistDrawerStyles = {
  wrapper: { height: 'auto', maxHeight: '70vh', width: '100%' },
  body: { padding: 0 },
  header: { paddingLeft: `${themeTokens.spacing[3]}px`, paddingRight: `${themeTokens.spacing[3]}px` },
} as const;

export type SwipeActionOverride = {
  icon: React.ReactNode;
  color: string;
  onAction: () => void;
};

type ClimbListItemProps = {
  climb: Climb;
  boardDetails: BoardDetails;
  /** Current pathname — passed from parent to avoid per-instance usePathname() context lookups. */
  pathname: string;
  /** Whether the app is in dark mode — passed from parent to avoid per-instance context lookups. */
  isDark: boolean;
  /** Override selected state (e.g. in queue drawer). When omitted, subscribes to SelectionStoreContext. */
  selected?: boolean;
  /** When true, the item is visually dimmed (greyed out) but still interactive */
  unsupported?: boolean;
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
  /** When true, disables thumbnail click-to-navigate (e.g., in edit mode) */
  disableThumbnailNavigation?: boolean;
  /** When true, prefer SSR image layers over the canvas renderer for this item. */
  preferImageLayers?: boolean;
  /** Handler for thumbnail clicks. When set, stops propagation so the row onClick doesn't also fire. */
  onThumbnailClick?: () => void;
  /** When provided, the item delegates opening the actions drawer to the parent instead of rendering its own. */
  onOpenActions?: (climb: Climb) => void;
  /** When provided, the item delegates opening the playlist selector to the parent instead of rendering its own. */
  onOpenPlaylistSelector?: (climb: Climb) => void;
  /** Callback invoked when the user navigates via the thumbnail link (e.g., to close a drawer). Forwarded to ClimbThumbnail. */
  onNavigate?: () => void;
  /** Optional callback to add the climb to the queue (default swipe-left action).
   *  When not provided, swipe-left is a no-op. Pass from a parent that subscribes to QueueContext. */
  addToQueue?: (climb: Climb) => void;
};

const ClimbListItem: React.FC<ClimbListItemProps> = React.memo(
  ({
    climb,
    boardDetails,
    pathname,
    isDark,
    selected: selectedOverride,
    unsupported,
    disableSwipe,
    onSelect,
    swipeRightAction,
    afterTitleSlot,
    titleProps,
    backgroundColor,
    contentOpacity,
    disableThumbnailNavigation,
    preferImageLayers,
    onThumbnailClick,
    onOpenActions,
    onOpenPlaylistSelector,
    onNavigate,
    addToQueue,
  }) => {
    // Subscribe to selection store — only re-renders when THIS item's selected state changes.
    // When `selectedOverride` is provided (e.g. queue drawer), use that instead.
    const storeSelected = useIsClimbSelected(climb.uuid);
    const selected = selectedOverride ?? storeSelected;
    // When parent provides both drawer callbacks, skip local drawers entirely.
    // Both must be present to ensure the parent handles all drawer interactions.
    const hasParentDrawers = Boolean(onOpenActions && onOpenPlaylistSelector);
    const [isActionsOpen, setIsActionsOpen] = useState(false);
    const [isPlaylistSelectorOpen, setIsPlaylistSelectorOpen] = useState(false);
    // Refs for inner action layer elements — updated via direct DOM manipulation during swipe
    const shortSwipeLayerRef = useRef<HTMLDivElement>(null);
    const longSwipeLayerRef = useRef<HTMLDivElement>(null);
    const rightActionLayerRef = useRef<HTMLDivElement>(null);
    const leftActionContainerRef = useRef<HTMLDivElement>(null);
    // Store addToQueue in a ref so the memoized handler always reads the latest
    // value without requiring addToQueue in the memo comparator.
    const addToQueueRef = useRef(addToQueue);
    addToQueueRef.current = addToQueue;
    const {
      handleDoubleTap,
      showHeart,
      dismissHeart,
      isFavorited,
    } = useDoubleTapFavorite({ climbUuid: climb.uuid });
    const { ref: doubleTapRef, onDoubleClick: handleDoubleTapClick } = useDoubleTap(handleDoubleTap);
    const clickTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Store onThumbnailClick in a ref so the memoized handler always reads the latest
    // value without requiring onThumbnailClick in the memo comparator.
    const onThumbnailClickRef = useRef(onThumbnailClick);
    onThumbnailClickRef.current = onThumbnailClick;
    const onNavigateRef = useRef(onNavigate);
    onNavigateRef.current = onNavigate;

    // Clear pending click timeout on unmount to prevent stale callbacks
    useEffect(() => {
      return () => {
        if (clickTimeoutRef.current) clearTimeout(clickTimeoutRef.current);
      };
    }, []);

    // Per-direction override flag
    const hasRightOverride = Boolean(swipeRightAction);

    // Default swipe handlers
    // Swipe left (right action): add to queue
    const handleDefaultSwipeLeft = useCallback(() => {
      addToQueueRef.current?.(climb);
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
        transitionRange > 0
          ? Math.max(0, Math.min(1, (rightOffset - TRANSITION_START) / transitionRange))
          : 1;

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
    const leftActionCombinedRef = useCallback((node: HTMLDivElement | null) => {
      leftActionRef(node);
      leftActionContainerRef.current = node;
    }, [leftActionRef]);

    // Combined ref callback for swipeable content div
    const contentCombinedRef = useCallback((node: HTMLDivElement | null) => {
      if (!disableSwipe) {
        swipeHandlers.ref(node);
        contentRef(node);
      }
    }, [disableSwipe, swipeHandlers, contentRef]);

    // Thumbnail click handler — uses ref to avoid stale closure.
    // Always attached (not conditional) because onThumbnailClick is excluded from
    // the memo comparator; a render-time conditional would go stale.
    const handleThumbnailClick = useCallback((e: React.MouseEvent) => {
      if (!onThumbnailClickRef.current) {
        if (onNavigateRef.current) {
          e.stopPropagation();
          onNavigateRef.current();
        }
        return;
      }
      e.stopPropagation();
      if (disableThumbnailNavigation) {
        onThumbnailClickRef.current();
        return;
      }
      if (clickTimeoutRef.current) clearTimeout(clickTimeoutRef.current);
      clickTimeoutRef.current = setTimeout(() => {
        clickTimeoutRef.current = null;
        onThumbnailClickRef.current?.();
      }, 300);
    }, [disableThumbnailNavigation]);

    // Thumbnail double-click handler
    const handleThumbnailDoubleClick = useCallback(() => {
      if (clickTimeoutRef.current) {
        clearTimeout(clickTimeoutRef.current);
        clickTimeoutRef.current = null;
      }
      handleDoubleTapClick();
    }, [handleDoubleTapClick]);

    // Drawer state callbacks — extracted from inline to avoid per-render allocation
    const handleCloseActions = useCallback(() => setIsActionsOpen(false), []);
    const handleOpenPlaylistFromActions = useCallback(() => {
      setIsActionsOpen(false);
      setIsPlaylistSelectorOpen(true);
    }, []);
    const handleClosePlaylist = useCallback(() => setIsPlaylistSelectorOpen(false), []);

    // Menu button click handler — extracted from inline to avoid per-render allocation
    const handleMenuClick = useCallback((e: React.MouseEvent) => {
      e.stopPropagation();
      if (onOpenActions) {
        onOpenActions(climb);
      } else {
        setIsPlaylistSelectorOpen(false);
        setIsActionsOpen(true);
      }
    }, [onOpenActions, climb]);

    const excludeActions = useMemo(
      () => getExcludedClimbActions(boardDetails.board_name, 'list'),
      [boardDetails.board_name],
    );

    // Memoize style objects to prevent recreation on every render
    const containerStyle = useMemo(
      () => ({
        position: 'relative' as const,
        overflow: 'hidden' as const,
        ...(unsupported ? { opacity: 0.5, filter: 'grayscale(80%)' } : {}),
      }),
      [unsupported],
    );


    const rightOverrideActionStyle = useMemo(
      () => ({
        position: 'absolute' as const,
        right: 0,
        top: 0,
        bottom: 0,
        width: rightActionRevealWidth,
        backgroundColor: swipeRightAction?.color ?? themeTokens.colors.error,
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
      (selected
        ? (getGradeTintColor(climb.difficulty, 'light', isDark) ?? 'var(--semantic-selected)')
        : 'var(--semantic-surface)');

    const swipeableContentStyle = useMemo(
      () => ({
        display: 'flex' as const,
        alignItems: 'center' as const,
        padding: `${themeTokens.spacing[2]}px ${themeTokens.spacing[2]}px`,
        gap: themeTokens.spacing[3],
        backgroundColor: resolvedBg,
        borderBottom: `1px solid var(--neutral-200)`,
        cursor: 'pointer' as const,
        userSelect: 'none' as const,
        opacity: contentOpacity ?? 1,
      }),
      [resolvedBg, contentOpacity],
    );

    // Default ClimbTitle props when no override is provided
    const resolvedTitleProps = useMemo<Partial<ClimbTitleProps>>(
      () =>
        titleProps ?? {
          gradePosition: 'right',
          showSetterInfo: true,
          titleFontSize: themeTokens.typography.fontSize.xl,
          rightAddon: <AscentStatus climbUuid={climb.uuid} fontSize={20} />,
          favorited: isFavorited,
          isNoMatch: !!climb.is_no_match,
        },
      [titleProps, climb.uuid, isFavorited, climb.is_no_match],
    );

    // Memoize right action layer styles to avoid inline object creation per render
    const rightActionDefaultLayerStyle = useMemo(
      () => swipeLeftConfirmed
        ? { ...rightActionLayerDefaultStyle, opacity: 0 }
        : rightActionLayerDefaultStyle,
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
                <div ref={rightActionRef} style={rightOverrideActionStyle}>
                  {swipeRightAction?.icon ?? null}
                </div>
              ) : (
                <div ref={rightActionRef} style={defaultRightActionStyle}>
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
            onClick={onSelect}
            style={swipeableContentStyle}
          >
            {/* Thumbnail */}
            <div
              ref={doubleTapRef}
              style={thumbnailStyle}
              onClick={handleThumbnailClick}
              onDoubleClick={handleThumbnailDoubleClick}
            >
              <ClimbThumbnail
                boardDetails={boardDetails}
                currentClimb={climb}
                pathname={pathname}
                preferImageLayers={preferImageLayers}
              />
              <HeartAnimationOverlay visible={showHeart} onAnimationEnd={dismissHeart} size={32} />
            </div>

            {/* Center + Right: Name, stars, setter, colorized grade */}
            <div style={centerStyle}>
              <ClimbTitle climb={climb} {...resolvedTitleProps} />
            </div>

            {/* After-title slot (e.g., avatar) */}
            {afterTitleSlot}

            {/* Menu: ellipsis button (hidden on mobile — replaced by far left swipe) */}
            <IconButton
              className={styles.menuButton}
              size="small"
              aria-label="More actions"
              onClick={handleMenuClick}
              style={iconButtonStyle}
              disableRipple
            >
              <MoreHorizOutlined />
            </IconButton>
          </div>
        </div>

        {/* Default actions drawers - only rendered when no parent drawer callbacks */}
        {!hasParentDrawers && (
          <>
            <SwipeableDrawer
              title={<DrawerClimbHeader climb={climb} boardDetails={boardDetails} />}
              placement="bottom"
              open={isActionsOpen}
              onClose={handleCloseActions}
              styles={drawerStyles}
            >
              <ClimbActions
                climb={climb}
                boardDetails={boardDetails}
                angle={climb.angle}
                currentPathname={pathname}
                viewMode="list"
                exclude={excludeActions}
                onOpenPlaylistSelector={handleOpenPlaylistFromActions}
                onActionComplete={handleCloseActions}
              />
            </SwipeableDrawer>

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
          </>
        )}
      </>
    );
  },
  (prev, next) => {
    return (
      prev.climb.uuid === next.climb.uuid &&
      prev.pathname === next.pathname &&
      prev.isDark === next.isDark &&
      prev.selected === next.selected &&
      prev.unsupported === next.unsupported &&
      prev.disableSwipe === next.disableSwipe &&
      prev.boardDetails === next.boardDetails &&
      prev.swipeRightAction === next.swipeRightAction &&
      prev.afterTitleSlot === next.afterTitleSlot &&
      prev.titleProps === next.titleProps &&
      prev.backgroundColor === next.backgroundColor &&
      prev.contentOpacity === next.contentOpacity &&
      prev.disableThumbnailNavigation === next.disableThumbnailNavigation &&
      prev.preferImageLayers === next.preferImageLayers &&
      prev.onOpenActions === next.onOpenActions &&
      prev.onOpenPlaylistSelector === next.onOpenPlaylistSelector &&
      prev.onNavigate === next.onNavigate
    );
  },
);

ClimbListItem.displayName = 'ClimbListItem';

export default ClimbListItem;
