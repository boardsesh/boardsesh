'use client';

import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import IconButton from '@mui/material/IconButton';
import { usePathname } from 'next/navigation';
import dynamic from 'next/dynamic';
import MoreHorizOutlined from '@mui/icons-material/MoreHorizOutlined';
import AddOutlined from '@mui/icons-material/AddOutlined';
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
import { useOptionalQueueContext } from '../graphql-queue';
import { useSwipeActions } from '@/app/hooks/use-swipe-actions';
import { useDoubleTap, DOUBLE_TAP_THRESHOLD } from '@/app/lib/hooks/use-double-tap';
import { themeTokens } from '@/app/theme/theme-config';
import { getGradeTintColor } from '@/app/lib/grade-colors';
import { useIsDarkMode } from '@/app/hooks/use-is-dark-mode';
import { getExcludedClimbActions } from '@/app/lib/climb-action-utils';
import styles from './climb-list-item.module.css';

const SwipeableDrawer = dynamic(() => import('../swipeable-drawer/swipeable-drawer'), { ssr: false });

// Keep swipe visuals aligned with gesture max distance
const MAX_GESTURE_SWIPE = 180;
const SHORT_ACTION_WIDTH = 120;
const LONG_SWIPE_ACTION_WIDTH = MAX_GESTURE_SWIPE;
const SHORT_SWIPE_THRESHOLD = 90;
const TRANSITION_START = 115;
const LONG_SWIPE_THRESHOLD = 150;

// Simple swipe constants for override mode (no long-swipe)
const SIMPLE_MAX_SWIPE = 120;
const SIMPLE_SWIPE_THRESHOLD = 100;

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

const iconStyle: React.CSSProperties = { color: 'white', fontSize: 20 };

const thumbnailStyle: React.CSSProperties = { width: themeTokens.spacing[16], flexShrink: 0 };

const centerStyle: React.CSSProperties = { flex: 1, minWidth: 0 };

const iconButtonStyle: React.CSSProperties = { flexShrink: 0, color: 'var(--neutral-400)' };

const drawerStyles = {
  wrapper: { height: 'auto', width: '100%' },
  body: { padding: `${themeTokens.spacing[2]}px 0` },
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
};

const ClimbListItem: React.FC<ClimbListItemProps> = React.memo(
  ({
    climb,
    boardDetails,
    selected,
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
  }) => {
    const pathname = usePathname();
    const isDark = useIsDarkMode();
    // When parent provides both drawer callbacks, skip local drawers entirely.
    // Both must be present to ensure the parent handles all drawer interactions.
    const hasParentDrawers = Boolean(onOpenActions && onOpenPlaylistSelector);
    const [isActionsOpen, setIsActionsOpen] = useState(false);
    const [isPlaylistSelectorOpen, setIsPlaylistSelectorOpen] = useState(false);
    // Single signed offset: positive = right swipe, negative = left swipe
    const [swipeOffset, setSwipeOffset] = useState(0);
    const queueContext = useOptionalQueueContext();
    const addToQueue = queueContext?.addToQueue;
    const {
      handleDoubleTap,
      showHeart,
      dismissHeart,
      isFavorited,
    } = useDoubleTapFavorite({ climbUuid: climb.uuid });
    const { ref: doubleTapRef, onDoubleClick: handleDoubleTapClick } = useDoubleTap(handleDoubleTap);
    const clickTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      addToQueue?.(climb);
    }, [climb, addToQueue]);

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

    // Use simple thresholds when right action is overridden (no long-swipe needed for left action)
    const useSimpleSwipe = hasRightOverride;

    const { swipeHandlers, isSwipeComplete, contentRef, leftActionRef, rightActionRef } = useSwipeActions({
      onSwipeLeft: resolvedSwipeLeft,
      onSwipeRight: handleDefaultSwipeRight,
      onSwipeRightLong: useSimpleSwipe ? undefined : handleDefaultSwipeRightLong,
      onSwipeOffsetChange: useSimpleSwipe ? undefined : setSwipeOffset,
      swipeThreshold: useSimpleSwipe ? SIMPLE_SWIPE_THRESHOLD : SHORT_SWIPE_THRESHOLD,
      longSwipeRightThreshold: useSimpleSwipe ? undefined : LONG_SWIPE_THRESHOLD,
      maxSwipe: useSimpleSwipe ? SIMPLE_MAX_SWIPE : MAX_GESTURE_SWIPE,
      maxSwipeLeft: useSimpleSwipe ? undefined : SHORT_ACTION_WIDTH,
      disabled: disableSwipe,
    });

    const excludeActions = getExcludedClimbActions(boardDetails.board_name, 'list');

    // Memoize style objects to prevent recreation on every render
    const containerStyle = useMemo(
      () => ({
        position: 'relative' as const,
        overflow: 'hidden' as const,
        ...(unsupported ? { opacity: 0.5, filter: 'grayscale(80%)' } : {}),
      }),
      [unsupported],
    );

    // Derive directional offsets from the single signed value
    const rightSwipeOffset = swipeOffset > 0 ? swipeOffset : 0;
    const leftSwipeOffset = swipeOffset < 0 ? -swipeOffset : 0;

    const rightSwipeBaseOpacity = useMemo(
      () => Math.min(1, rightSwipeOffset / SHORT_SWIPE_THRESHOLD),
      [rightSwipeOffset],
    );

    const longSwipeBlend = useMemo(() => {
      const transitionRange = LONG_SWIPE_THRESHOLD - TRANSITION_START;
      if (transitionRange <= 0) return 1;
      return Math.max(0, Math.min(1, (rightSwipeOffset - TRANSITION_START) / transitionRange));
    }, [rightSwipeOffset]);

    const shortSwipeLayerOpacity = useMemo(
      () => rightSwipeBaseOpacity * (1 - longSwipeBlend),
      [rightSwipeBaseOpacity, longSwipeBlend],
    );

    const longSwipeLayerOpacity = useMemo(
      () => rightSwipeBaseOpacity * longSwipeBlend,
      [rightSwipeBaseOpacity, longSwipeBlend],
    );

    // Left-swipe opacity (for right action panel — queue only, no long swipe)
    const leftSwipeOpacity = useMemo(() => Math.min(1, leftSwipeOffset / SHORT_SWIPE_THRESHOLD), [leftSwipeOffset]);

    const defaultLeftActionStyle = useMemo(
      () => ({
        position: 'absolute' as const,
        left: 0,
        top: 0,
        bottom: 0,
        width: SHORT_ACTION_WIDTH + (LONG_SWIPE_ACTION_WIDTH - SHORT_ACTION_WIDTH) * longSwipeBlend,
        display: 'flex' as const,
        alignItems: 'center' as const,
        justifyContent: 'flex-start' as const,
        paddingLeft: themeTokens.spacing[3],
        opacity: 0,
        visibility: 'hidden' as const,
        overflow: 'hidden' as const,
      }),
      [longSwipeBlend],
    );

    const shortSwipeLayerStyle = useMemo(
      () => ({
        ...swipeActionLayerBaseStyle,
        backgroundColor: themeTokens.colors.primary,
        opacity: shortSwipeLayerOpacity,
      }),
      [shortSwipeLayerOpacity],
    );

    const longSwipeLayerStyle = useMemo(
      () => ({
        ...swipeActionLayerBaseStyle,
        backgroundColor: themeTokens.neutral[600],
        opacity: longSwipeLayerOpacity,
      }),
      [longSwipeLayerOpacity],
    );

    const defaultRightActionStyle = useMemo(
      () => ({
        position: 'absolute' as const,
        right: 0,
        top: 0,
        bottom: 0,
        width: SHORT_ACTION_WIDTH,
        display: 'flex' as const,
        alignItems: 'center' as const,
        justifyContent: 'flex-end' as const,
        paddingRight: themeTokens.spacing[3],
        opacity: 0,
        visibility: 'hidden' as const,
        overflow: 'hidden' as const,
      }),
      [],
    );

    const rightActionLayerStyle = useMemo(
      () => ({
        ...rightSwipeActionLayerBaseStyle,
        backgroundColor: themeTokens.colors.primary,
        opacity: leftSwipeOpacity,
      }),
      [leftSwipeOpacity],
    );

    const simpleRightActionStyle = useMemo(
      () => ({
        position: 'absolute' as const,
        right: 0,
        top: 0,
        bottom: 0,
        width: SIMPLE_MAX_SWIPE,
        backgroundColor: swipeRightAction?.color ?? themeTokens.colors.error,
        display: 'flex' as const,
        alignItems: 'center' as const,
        justifyContent: 'flex-end' as const,
        paddingRight: themeTokens.spacing[4],
        opacity: 0,
        visibility: 'hidden' as const,
      }),
      [swipeRightAction?.color],
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
        opacity: isSwipeComplete ? 0 : (contentOpacity ?? 1),
      }),
      [resolvedBg, isSwipeComplete, contentOpacity],
    );

    // Default ClimbTitle props when no override is provided
    const resolvedTitleProps: Partial<ClimbTitleProps> = titleProps ?? {
      gradePosition: 'right',
      showSetterInfo: true,
      titleFontSize: themeTokens.typography.fontSize.xl,
      rightAddon: <AscentStatus climbUuid={climb.uuid} fontSize={20} />,
      favorited: isFavorited,
    };

    return (
      <>
        <div style={containerStyle}>
          {!disableSwipe && (
            <>
              {/* Left action (revealed on swipe right) */}
              <div ref={leftActionRef} style={defaultLeftActionStyle}>
                <div style={shortSwipeLayerStyle}>
                  <LocalOfferOutlined style={iconStyle} />
                </div>
                {!useSimpleSwipe && (
                  <div style={longSwipeLayerStyle}>
                    <MoreHorizOutlined style={iconStyle} />
                  </div>
                )}
              </div>

              {/* Right action (revealed on swipe left) */}
              {hasRightOverride ? (
                <div ref={rightActionRef} style={simpleRightActionStyle}>
                  {swipeRightAction?.icon ?? null}
                </div>
              ) : (
                <div ref={rightActionRef} style={defaultRightActionStyle}>
                  <div style={rightActionLayerStyle}>
                    <AddOutlined style={iconStyle} />
                  </div>
                </div>
              )}
            </>
          )}

          {/* Content (swipeable when swipe is enabled) */}
          <div
            {...(disableSwipe ? {} : swipeHandlers)}
            ref={(node: HTMLDivElement | null) => {
              if (!disableSwipe) {
                swipeHandlers.ref(node);
                contentRef(node);
              }
            }}
            onClick={onSelect}
            style={swipeableContentStyle}
          >
            {/* Thumbnail */}
            <div
              ref={doubleTapRef}
              style={{ ...thumbnailStyle, position: 'relative' }}
              onClick={
                onThumbnailClick
                  ? (e) => {
                      e.stopPropagation();
                      if (clickTimeoutRef.current) clearTimeout(clickTimeoutRef.current);
                      clickTimeoutRef.current = setTimeout(() => {
                        clickTimeoutRef.current = null;
                        onThumbnailClick();
                      }, DOUBLE_TAP_THRESHOLD);
                    }
                  : undefined
              }
              onDoubleClick={() => {
                if (clickTimeoutRef.current) {
                  clearTimeout(clickTimeoutRef.current);
                  clickTimeoutRef.current = null;
                }
                handleDoubleTapClick();
              }}
            >
              <ClimbThumbnail
                boardDetails={boardDetails}
                currentClimb={climb}
                enableNavigation={!disableThumbnailNavigation}
                preferImageLayers={preferImageLayers}
                onNavigate={onNavigate}
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
              onClick={(e) => {
                e.stopPropagation();
                if (onOpenActions) {
                  onOpenActions(climb);
                } else {
                  setIsPlaylistSelectorOpen(false);
                  setIsActionsOpen(true);
                }
              }}
              style={iconButtonStyle}
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
              onClose={() => setIsActionsOpen(false)}
              styles={drawerStyles}
            >
              <ClimbActions
                climb={climb}
                boardDetails={boardDetails}
                angle={climb.angle}
                currentPathname={pathname}
                viewMode="list"
                exclude={excludeActions}
                onOpenPlaylistSelector={() => {
                  setIsActionsOpen(false);
                  setIsPlaylistSelectorOpen(true);
                }}
                onActionComplete={() => setIsActionsOpen(false)}
              />
            </SwipeableDrawer>

            <SwipeableDrawer
              title={<DrawerClimbHeader climb={climb} boardDetails={boardDetails} />}
              placement="bottom"
              open={isPlaylistSelectorOpen}
              onClose={() => setIsPlaylistSelectorOpen(false)}
              styles={{
                wrapper: { height: 'auto', maxHeight: '70vh', width: '100%' },
                body: { padding: 0 },
                header: { paddingLeft: `${themeTokens.spacing[3]}px`, paddingRight: `${themeTokens.spacing[3]}px` },
              }}
            >
              <PlaylistSelectionContent
                climbUuid={climb.uuid}
                boardDetails={boardDetails}
                angle={climb.angle}
                onDone={() => setIsPlaylistSelectorOpen(false)}
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
      prev.onThumbnailClick === next.onThumbnailClick &&
      prev.onOpenActions === next.onOpenActions &&
      prev.onOpenPlaylistSelector === next.onOpenPlaylistSelector &&
      prev.onNavigate === next.onNavigate
    );
  },
);

ClimbListItem.displayName = 'ClimbListItem';

export default ClimbListItem;
