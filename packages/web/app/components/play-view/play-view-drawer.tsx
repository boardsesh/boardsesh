'use client';

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, useMemo, useDeferredValue } from 'react';
import { useTranslation } from 'react-i18next';
import { track } from '@/app/lib/analytics';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import CloseOutlined from '@mui/icons-material/CloseOutlined';
import CheckOutlined from '@mui/icons-material/CheckOutlined';
import { TickBadgeAvatar } from '@/app/components/session/tick-badge-avatar';
import type { ClimbQueueItem } from '../queue-control/types';
import { usePathname } from 'next/navigation';
import { useQueueActions, useCurrentClimb, useQueueList, useSessionData } from '../graphql-queue';
import { ClimbActions } from '../climb-actions';
import { ACTION_SHEET_ACTION_ORDER } from '../climb-actions/types';
import { useDoubleTapFavorite } from '../climb-actions/use-double-tap-favorite';
import HeartAnimationOverlay from '../climb-card/heart-animation-overlay';
import PlaylistSelectionContent from '../climb-actions/playlist-selection-content';
import DrawerClimbHeader from '../climb-card/drawer-climb-header';
import { LightControlDrawer } from '../board-page/light-control-drawer';
import { useBoardProvider } from '../board-provider/board-provider-context';
import SwipeBoardCarousel from '../board-renderer/swipe-board-carousel';
import { PlaybackControls } from '../playback/playback-controls';
import { useWakeLock } from '../board-bluetooth-control/use-wake-lock';
import { useBluetoothContext } from '../board-bluetooth-control/bluetooth-context';
import { isNativeApp } from '@/app/lib/ble/capacitor-utils';
import { useWallConfirmFallback } from './use-wall-confirm-fallback';
import { useDrawerPlayback } from './use-drawer-playback';
import { themeTokens } from '@/app/theme/theme-config';
import SwipeableDrawer from '../swipeable-drawer/swipeable-drawer';
import AngleSelector from '../board-page/angle-selector';
import ClimbDetailHeader from '@/app/components/climb-detail/climb-detail-header';
import type { ActiveDrawer } from '../queue-control/queue-control-bar';
import { PLAY_DRAWER_EVENT } from '../queue-control/play-drawer-event';
import {
  TOUR_CLOSE_PLAY_QUEUE_EVENT,
  TOUR_OPEN_PLAY_QUEUE_EVENT,
} from '@/app/components/onboarding/onboarding-tour-events';
import type { BoardDetails, Angle } from '@/app/lib/types';
import styles from './play-view-drawer.module.css';
import drawerCss from '../swipeable-drawer/swipeable-drawer.module.css';
import { useDrawerDragResize } from '@/app/hooks/use-drawer-drag-resize';
import ClimbDetailShellClient from '@/app/components/climb-detail/climb-detail-shell.client';
import { renderBoard } from '@/app/lib/board-render-worker/worker-manager';
import { useNestedDrawerSwipe } from '@/app/lib/hooks/use-nested-drawer-swipe';
import { usePullToClose, findScrollContainer } from '@/app/lib/hooks/pull-to-close';
import { useSnackbar } from '../providers/snackbar-provider';
import { getPreference, setPreference } from '@/app/lib/user-preferences-db';
import QueueDrawer from './queue-drawer';
import PlayDrawerContent from './play-drawer-content';
import { PlayViewActionBar } from './play-view-action-bar';
import { PlayViewTickBar } from './play-view-tick-bar';
import { MiniSessionBar } from './mini-session-bar';
import { useDrawerUrlSync } from './use-drawer-url-sync';

/** Window with optional requestIdleCallback (not available in all browsers). */
type WindowWithIdleCallback = Window & {
  requestIdleCallback?: ((cb: () => void, opts?: { timeout: number }) => number) | undefined;
};

type PlayViewDrawerProps = {
  activeDrawer: ActiveDrawer;
  setActiveDrawer: (drawer: ActiveDrawer) => void;
  boardDetails: BoardDetails;
  angle: Angle;
  /** Callback to expose the MUI Paper element for external animation (e.g., peek hint). */
  onPaperRef?: (el: HTMLDivElement | null) => void;
  /** Drawer-local "displayed climb" — set by browse callers in a party
   *  session so the drawer can preview a climb without mutating the wall
   *  climb. Null in solo or when the drawer was opened from the bar (then
   *  the drawer displays the wall climb directly). */
  drawerDisplayedItem?: ClimbQueueItem | null;
  setDrawerDisplayedItem?: (item: ClimbQueueItem | null) => void;
  /**
   * When true, the drawer paints in its open state on first mount with no
   * slide-in animation. Used on /view/{uuid} hard-refresh so the drawer is
   * visible immediately on SSR paint. After the first mount this prop is a
   * no-op — subsequent close/open cycles animate normally.
   */
  initialOpenWithoutAnimation?: boolean;
};

const PlayViewDrawer: React.FC<PlayViewDrawerProps> = ({
  activeDrawer,
  setActiveDrawer,
  boardDetails,
  angle,
  onPaperRef,
  drawerDisplayedItem = null,
  setDrawerDisplayedItem,
  initialOpenWithoutAnimation = false,
}) => {
  const { t } = useTranslation('session');
  const isOpen = activeDrawer === 'play';
  const [isActionsOpen, setIsActionsOpen] = useState(false);
  const [isQueueOpen, setIsQueueOpen] = useState(false);
  const [queueMounted, setQueueMounted] = useState(false);
  const [isPlaylistSelectorOpen, setIsPlaylistSelectorOpen] = useState(false);
  const [isTickBarActive, setIsTickBarActive] = useState(false);
  const [isBoardZoomed, setIsBoardZoomed] = useState(false);
  /**
   * Lightbulb pending state (queue-control-bar pivot, Phase 3).
   *
   * Set when the user presses the lightbulb to take control (party non-driver
   * branch) — between the press and the matching `WallConfirmedClimb`, the
   * lightbulb renders with a soft pulse so the user can see we're waiting.
   * Cleared either way when `useWallConfirmFallback` resolves (confirm,
   * timeout, or session-swap cancellation).
   */
  const [pendingClimbUuid, setPendingClimbUuid] = useState<string | null>(null);
  /**
   * First-run coachmark pulse (queue-control-bar pivot, Phase 3). Reads
   * `swipeHint:lightbulbSeen` from IndexedDB once on first drawer open, fires
   * a single-iteration pulse on the lightbulb with the "Send to the wall"
   * tooltip, then writes the seen flag so subsequent opens are silent.
   */
  const [showLightbulbCoachmark, setShowLightbulbCoachmark] = useState(false);
  // Light-control drawer (disco / glyphs / palette / manual BLE disconnect).
  // Opened by long-pressing the action bar's lightbulb — the ShareBoardButton
  // that used to host the long-press is gone (pivot simplification: one
  // lightbulb in the drawer). Mount lazily — keeps the disco/glyph effects
  // out of the initial render path for users who never use them.
  const [lightDrawerOpen, setLightDrawerOpen] = useState(false);
  const [hasOpenedLightDrawer, setHasOpenedLightDrawer] = useState(false);
  const handleOpenLightDrawer = useCallback(() => {
    setHasOpenedLightDrawer(true);
    setLightDrawerOpen(true);
  }, []);
  const handleCloseLightDrawer = useCallback(() => setLightDrawerOpen(false), []);

  useEffect(() => {
    const scrollContainer = playPaperRef.current?.querySelector('[data-scroll-container]') as HTMLElement | null;
    if (!scrollContainer) return;
    scrollContainer.style.overflowY = isBoardZoomed ? 'hidden' : '';
  }, [isBoardZoomed, isOpen]);

  const playPaperRef = useRef<HTMLDivElement | null>(null);
  const combinedPaperRef = useCallback(
    (el: HTMLDivElement | null) => {
      playPaperRef.current = el;
      onPaperRef?.(el);
    },
    [onPaperRef],
  );

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
  const queueListData = useQueueList();
  const sessionData = useSessionData();

  const deferredCurrentClimb = useDeferredValue(currentClimbData);
  const deferredQueue = useDeferredValue(queueListData);
  const deferredSession = useDeferredValue(sessionData);

  const { currentClimbQueueItem } = isOpen ? currentClimbData : deferredCurrentClimb;
  const { queue } = isOpen ? queueListData : deferredQueue;
  const {
    viewOnlyMode,
    isPersistentSessionActive,
    isDriver,
    lastConnectedBoardSerial,
    connectionState,
    participantId,
    users: sessionUsers,
    driverParticipantId,
  } = isOpen ? sessionData : deferredSession;
  const {
    mirrorClimb,
    getNextClimbQueueItem,
    getPreviousClimbQueueItem,
    setCurrentClimbQueueItem,
    takeControl,
    releaseControl,
  } = useQueueActions();
  const {
    isConnected: isBluetoothConnected,
    isBluetoothSupported,
    connect: bluetoothConnect,
    reassertWall,
    reconnectSerialForCurrentBoard,
  } = useBluetoothContext();

  // In a party session, the drawer-local `drawerDisplayedItem` (set by browse
  // callers via the open-drawer event payload) takes precedence over the wall
  // climb, so browsing previews without yanking the wall. In solo (or when
  // opened from the bar with no payload), drawerDisplayedItem is null and the
  // drawer displays the wall climb directly — matching today's behavior.
  const effectiveItem = drawerDisplayedItem ?? currentClimbQueueItem;
  const currentClimb = effectiveItem?.climb ?? null;

  const { handleDoubleTap, showHeart, dismissHeart, isFavorited, toggleFavorite } = useDoubleTapFavorite({
    climbUuid: currentClimb?.uuid ?? '',
  });

  // Multi-frame ("route") playback. Single-frame climbs short-circuit: the
  // engine reports `isAnimatable: false`, the BLE loop never fires, and we
  // skip rendering `<PlaybackControls />` below.
  const isMirrored = !!currentClimb?.mirrored;
  const playback = useDrawerPlayback({ currentClimb, boardDetails, isOpen });

  // Multi-frame climbs render the engine's current snapshot so the on-screen
  // board tracks playback; static climbs pass through. Memoised so the
  // carousel's `currentClimb` prop stays referentially stable between ticks
  // that don't actually change the displayed frame.
  const carouselCurrentClimb = useMemo(
    () =>
      currentClimb
        ? {
            frames: playback.isAnimatable ? playback.currentFrameString : currentClimb.frames,
            mirrored: currentClimb.mirrored,
          }
        : null,
    [currentClimb, playback.isAnimatable, playback.currentFrameString],
  );

  // currentQueueIndex / remainingQueueCount stay anchored on the wall climb
  // (currentClimbQueueItem). The drawer-local preview doesn't represent
  // progress through the shared queue — the wall climb does.
  const currentQueueIndex = currentClimbQueueItem
    ? queue.findIndex((item) => item.uuid === currentClimbQueueItem.uuid)
    : -1;
  const remainingQueueCount = currentQueueIndex >= 0 ? queue.length - currentQueueIndex : queue.length;

  useWakeLock(isOpen);

  const handleClose = useCallback(() => {
    if (isActionsOpen || isQueueOpen || isPlaylistSelectorOpen) return;
    setDrawerOpen(false);
    setActiveDrawer('none');
  }, [setActiveDrawer, isActionsOpen, isQueueOpen, isPlaylistSelectorOpen]);

  // Compute ascent info for tick FAB badge
  const currentAngle = typeof angle === 'string' ? parseInt(angle, 10) : angle;

  // Sync the browser URL with the drawer's open state so the address bar
  // reflects /view/{climb_uuid} while open, replaceState tracks the displayed
  // climb on prev/next/swipe, and browser back closes the drawer.
  // Browser back must close unconditionally (don't gate on nested drawers like
  // handleClose does — back is a hardware affordance that shouldn't be
  // swallowed silently). The hook also runs in viewOnlyMode — URL sync is a
  // presentational concern, and read-only spectators should still be able to
  // copy a shareable link from their address bar.
  const handleUrlSyncClose = useCallback(() => {
    setDrawerOpen(false);
    setActiveDrawer('none');
  }, [setActiveDrawer]);
  useDrawerUrlSync({
    isOpen,
    displayedClimb: currentClimb,
    boardDetails,
    angle: currentAngle,
    onClose: handleUrlSyncClose,
  });
  const filteredLogbook = useMemo(() => {
    if (!logbook || !currentClimb) return [];
    return logbook.filter((asc) => asc.climb_uuid === currentClimb.uuid && Number(asc.angle) === currentAngle);
  }, [logbook, currentClimb, currentAngle]);

  const hasSuccessfulAscent = filteredLogbook.some((asc) => asc.is_ascent);
  const ascentCount = filteredLogbook.length;

  // Card-swipe navigation. In an active party session, prev/next walks the
  // drawer-local preview state without broadcasting (browse-doesn't-yank). In
  // solo, it mutates the wall climb like today so BLE keeps sending.
  //
  // Non-driver swipe (party + isDriver===false): walks the suggested-climbs
  // feed only — skip the shared queue, which is "the climbs the driver
  // committed to" and not a non-driver's preview surface (pivot rule 5).
  // Drivers (and solo, where isDriver is always true) get the existing
  // queue → suggestions fall-through.
  //
  // When the user enters via a /view/{uuid} direct hit, the climbs list is
  // empty until React Query resolves — in that window getNextClimbQueueItem
  // returns null and the `!!nextItem` check below naturally disables nav.
  // Once `suggestedClimbs` populate, swipe + prev/next light up against them.
  const navigateFromItem = effectiveItem ?? null;
  const swipeSuggestionsOnly = isPersistentSessionActive && !isDriver;
  const nextItem = getNextClimbQueueItem({ from: navigateFromItem, suggestionsOnly: swipeSuggestionsOnly });
  const prevItem = getPreviousClimbQueueItem({ from: navigateFromItem, suggestionsOnly: swipeSuggestionsOnly });

  // The pivot's preview-vs-broadcast fork: in party, non-drivers preview
  // (drawer-local state, no wall change); drivers broadcast (wall climb +
  // BLE send). Solo always broadcasts. Phase 1 routed every party tap to
  // preview; PR3 narrows that to "party AND not driving" so driver
  // gestures inside the drawer (swipe, prev/next) walk the queue/
  // suggestions and update the wall as the spec requires.
  const advanceTo = useCallback(
    (item: ClimbQueueItem, method: 'swipePlayViewDrawer' | 'playViewDrawer', direction: 'next' | 'previous') => {
      if (isPersistentSessionActive && !isDriver) {
        setDrawerDisplayedItem?.(item);
        track('Queue Navigation', { direction, method, mode: 'preview' });
        // Pivot Phase 5: non-driver preview swipe is intentionally NOT a
        // Wall Advance — nothing reaches the wall, so the success-metric
        // pipeline shouldn't count it as a broadcast advance.
      } else {
        // Broadcast path: clear any lingering drawer-local preview so the
        // drawer's `effectiveItem = drawerDisplayedItem ?? wallClimb`
        // fall-through reads the freshly-broadcast wall climb instead of a
        // stale preview from before the user became driver.
        setDrawerDisplayedItem?.(null);
        setCurrentClimbQueueItem(item);
        track('Queue Navigation', { direction, method, mode: 'broadcast' });
        // Pivot Phase 5: drawer broadcast paths are by definition driver
        // (or solo, which we treat as driver). The method discriminates
        // swipe vs button.
        track('Wall Advance', {
          source: method === 'swipePlayViewDrawer' ? 'drawer_swipe' : 'drawer_button',
          pressedByRole: 'driver',
          direction,
          mode: isPersistentSessionActive ? 'party' : 'solo',
          boardLayout: boardDetails.layout_name ?? '',
        });
      }
    },
    [isPersistentSessionActive, isDriver, setCurrentClimbQueueItem, setDrawerDisplayedItem, boardDetails.layout_name],
  );

  // First-run coachmark — pulses the lightbulb once with the "Send to the
  // wall" tooltip the first time the drawer opens. Reads
  // `swipeHint:lightbulbSeen` from IndexedDB; if unset, schedules the pulse
  // and writes the flag. Single-fire per user via the IDB key.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    void getPreference<boolean>('swipeHint:lightbulbSeen').then((seen) => {
      if (cancelled) return;
      if (seen) return;
      // Don't trample an already-armed coachmark (e.g. previewCoachmark
      // armed on a swipe before the drawer-open effect resolved).
      if (lightbulbCoachmarkKeyRef.current) return;
      lightbulbCoachmarkKeyRef.current = 'swipeHint:lightbulbSeen';
      setShowLightbulbCoachmark(true);
    });
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  // Tracks which one-shot pulse is currently armed so the shared
  // `onLightbulbCoachmarkSeen` handler persists the right IDB key. Two
  // distinct one-shots ride on the same lightbulb-pulse animation: the
  // original "Send to the wall" coachmark (first drawer open ever) and
  // the new partyPreview coachmark (first non-driver swipe in a party
  // session) speced by the queue-control-bar pivot doc + flagged in the
  // group-session feedback review.
  const lightbulbCoachmarkKeyRef = useRef<'swipeHint:lightbulbSeen' | 'swipeHint:partyPreviewSeen' | null>(null);
  const [lightbulbCoachmarkText, setLightbulbCoachmarkText] = useState<string | null>(null);
  const handleLightbulbCoachmarkSeen = useCallback(() => {
    setShowLightbulbCoachmark(false);
    const key = lightbulbCoachmarkKeyRef.current;
    lightbulbCoachmarkKeyRef.current = null;
    setLightbulbCoachmarkText(null);
    if (key) void setPreference(key, true);
  }, []);

  // Non-driver swipe coachmark (queue-control-bar pivot, rule 5 + group-
  // session feedback fix). On the first swipe a non-driver in a party
  // session takes inside the drawer, pulse the lightbulb once with a
  // tooltip explaining that swipe is preview-only and the lightbulb is
  // the path to send. Tracked in a ref so a re-render between the swipe
  // and the read doesn't double-fire.
  const previewCoachmarkArmedRef = useRef(false);
  const maybeArmPreviewCoachmark = useCallback(() => {
    if (previewCoachmarkArmedRef.current) return;
    if (!swipeSuggestionsOnly) return;
    previewCoachmarkArmedRef.current = true;
    void getPreference<boolean>('swipeHint:partyPreviewSeen').then((seen) => {
      if (seen) return;
      // Don't trample an already-armed lightbulb coachmark — the first-open
      // one wins (it's already been visible for at least a beat).
      if (lightbulbCoachmarkKeyRef.current) return;
      lightbulbCoachmarkKeyRef.current = 'swipeHint:partyPreviewSeen';
      setLightbulbCoachmarkText(t('playView.previewCoachmark'));
      setShowLightbulbCoachmark(true);
    });
  }, [swipeSuggestionsOnly, t]);

  // Resolve the driver's user record for the grabber-row peripheral cue.
  // The mini session bar resolves its own copy from the same fields.
  const driverUser = useMemo(() => {
    if (!driverParticipantId) return null;
    return sessionUsers.find((u) => u.id === driverParticipantId) ?? null;
  }, [driverParticipantId, sessionUsers]);

  const handleReturnToWallClimb = useCallback(() => {
    setDrawerDisplayedItem?.(null);
  }, [setDrawerDisplayedItem]);

  const navigate = useCallback(
    (direction: 'next' | 'previous', source: 'swipePlayViewDrawer' | 'playViewDrawer') => {
      const getter = direction === 'next' ? getNextClimbQueueItem : getPreviousClimbQueueItem;
      const item = getter({ from: navigateFromItem, suggestionsOnly: swipeSuggestionsOnly });
      if (!item || viewOnlyMode) return;
      advanceTo(item, source, direction);
    },
    [getNextClimbQueueItem, getPreviousClimbQueueItem, navigateFromItem, swipeSuggestionsOnly, viewOnlyMode, advanceTo],
  );

  // When a non-driver has swiped off the wall climb in browse mode, the
  // most-recent "previous" climb in their mental model is the wall climb
  // itself (where they just came from). Snap-back via swipe-left mirrors
  // the mini session bar's "return to wall climb" button so both gestures
  // resolve drift the same way.
  const isDriftedFromWall =
    !isDriver &&
    isPersistentSessionActive &&
    drawerDisplayedItem != null &&
    currentClimbQueueItem != null &&
    drawerDisplayedItem.climb.uuid !== currentClimbQueueItem.climb.uuid;

  const handleSwipeNext = useCallback(() => {
    maybeArmPreviewCoachmark();
    navigate('next', 'swipePlayViewDrawer');
  }, [navigate, maybeArmPreviewCoachmark]);
  const handleSwipePrevious = useCallback(() => {
    if (isDriftedFromWall) {
      setDrawerDisplayedItem?.(null);
      return;
    }
    maybeArmPreviewCoachmark();
    navigate('previous', 'swipePlayViewDrawer');
  }, [navigate, maybeArmPreviewCoachmark, isDriftedFromWall, setDrawerDisplayedItem]);

  const canSwipeNext = !viewOnlyMode && !!nextItem;
  // While drifted from the wall, "previous" always resolves to the wall climb
  // (handleSwipePrevious snap-back path), so swipe-back is always enabled even
  // if the suggestions feed has no further previous item.
  const canSwipePrevious = !viewOnlyMode && (isDriftedFromWall || !!prevItem);

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
  }, [currentClimb?.uuid]);

  const handleTickBarError = useCallback(() => {
    showMessage(t('playView.tickError'), 'error');
  }, [showMessage, t]);

  const handlePrevNavClick = useCallback(() => {
    if (isDriftedFromWall) {
      setDrawerDisplayedItem?.(null);
      return;
    }
    navigate('previous', 'playViewDrawer');
  }, [navigate, isDriftedFromWall, setDrawerDisplayedItem]);
  // Wall-confirm watcher: armed by handleLightbulbClick, dismissed by the
  // local wall-confirm bus or fires a connect fallback after 2 s. Owns its
  // own unmount cleanup so the drawer doesn't need to thread that wiring.
  //
  // `onConfirmed` / `onTimeout` clear the lightbulb's pending pulse state so
  // the UI accurately reflects the round-trip — pulse during the window,
  // solid lit on confirm, picker (or no-op) on timeout.
  const handleWallConfirmed = useCallback((info: { climbUuid: string }) => {
    setPendingClimbUuid((current) => (current === info.climbUuid ? null : current));
  }, []);
  const handleWallConfirmTimeout = useCallback((info: { climbUuid: string }) => {
    setPendingClimbUuid((current) => (current === info.climbUuid ? null : current));
  }, []);
  const { armWatcher: armWallConfirmWatcher, cancelWatcher: cancelWallConfirmWatcher } = useWallConfirmFallback(
    {
      isBluetoothConnected,
      isBluetoothSupported,
      lastConnectedBoardSerial,
      isPersistentSessionActive,
      bluetoothConnect,
    },
    { onConfirmed: handleWallConfirmed, onTimeout: handleWallConfirmTimeout },
  );

  // Session-swap during pending: if the watcher hook cancels because the
  // session ended mid-window, also clear the local pending UI state. The
  // hook handles the watcher teardown; this just keeps the pulse from
  // sticking on the bulb.
  useEffect(() => {
    if (!isPersistentSessionActive && pendingClimbUuid) {
      setPendingClimbUuid(null);
    }
  }, [isPersistentSessionActive, pendingClimbUuid]);

  /**
   * Wall Control Released — yanked + disconnect variants (Phase 5 analytics).
   *
   *  - 'yanked': a server-driven `DriverChanged` arrives naming someone else
   *    while we were the previous driver. Detect by tracking the previously-
   *    observed isDriver state with a ref and firing when it transitions
   *    from true → false in an active party session. This catches both the
   *    "someone else took it" yank and the explicit-release path (the
   *    release-from-self also flips isDriver to false). We disambiguate by
   *    consulting `pendingReleaseReasonRef` — if a manual release just fired,
   *    suppress the yanked event for the same transition.
   *  - 'disconnect': we're the driver and the WS connection drops. Detect
   *    by watching `connectionState` while `isDriver` is true.
   */
  const wasDriverRef = useRef(isDriver);
  const wasConnectedRef = useRef(connectionState === 'connected');
  // Set to 'manual' by handleLightbulbClick right before it calls
  // releaseControl(); the isDriver flip that follows is then attributed to
  // the manual release rather than counted as a yank.
  const pendingReleaseReasonRef = useRef<'manual' | null>(null);

  useEffect(() => {
    const boardLayout = boardDetails.layout_name ?? '';
    const wasDriver = wasDriverRef.current;
    wasDriverRef.current = isDriver;

    // Driver flipped from true → false while still in a party session →
    // yanked OR manual. Manual flips set the suppression ref; everything
    // else is a yank.
    if (wasDriver && !isDriver && isPersistentSessionActive) {
      const pending = pendingReleaseReasonRef.current;
      pendingReleaseReasonRef.current = null;
      if (pending !== 'manual') {
        track('Wall Control Released', {
          reason: 'yanked',
          mode: 'party',
          boardLayout,
        });
      }
    }
  }, [isDriver, isPersistentSessionActive, boardDetails.layout_name]);

  useEffect(() => {
    const boardLayout = boardDetails.layout_name ?? '';
    const wasConnected = wasConnectedRef.current;
    const isNowConnected = connectionState === 'connected';
    wasConnectedRef.current = isNowConnected;

    if (
      wasConnected &&
      !isNowConnected &&
      // Use the latest known driver flag — fire only when we were driving
      // at the moment the disconnect happened.
      wasDriverRef.current &&
      isPersistentSessionActive
    ) {
      track('Wall Control Released', {
        reason: 'disconnect',
        mode: 'party',
        boardLayout,
      });
    }
  }, [connectionState, isPersistentSessionActive, boardDetails.layout_name]);

  /**
   * Lightbulb press: toggle the driver role.
   *
   * - When the local user is NOT driving, press takes control via
   *   `takeControl(currentClimb)` and arms the 2-second wall-confirm
   *   watcher. While driving, every subsequent prev/next/swipe broadcasts
   *   (per the advanceTo driver fork) and the AutoSender forwards each
   *   climb change to the wall — so the lit lightbulb means "I'm driving;
   *   the wall follows what I do."
   *
   * - When the local user IS already driving, press releases via
   *   `releaseControl()`. The lightbulb darkens; subsequent prev/next/
   *   swipe go back to preview-only.
   *
   * Watcher fallbacks (only on the take-control branch):
   *  - Already BLE-connected → trust the AutoSender's in-flight write.
   *  - Stored session board serial + native shell → auto-connect.
   *  - Otherwise → connect() which opens the device picker dialog.
   */
  const handleLightbulbClick = useCallback(() => {
    const boardLayout = boardDetails.layout_name ?? '';
    // `previousDriver` analytic property: who held the wall before the
    // local user pressed? Use the live `driverParticipantId` from session
    // data — null means "none", local participantId means "self" (a no-op
    // re-take), otherwise some other party member held it.
    const previousDriver: 'none' | 'self' | 'other' =
      sessionData.driverParticipantId == null
        ? 'none'
        : sessionData.driverParticipantId === participantId
          ? 'self'
          : 'other';

    // Party + driver: release control (give the wall away). Cancel any
    // in-flight watcher so the fallback doesn't fire after the role is
    // already released.
    if (isPersistentSessionActive && isDriver) {
      cancelWallConfirmWatcher();
      setPendingClimbUuid(null);
      // Suppress the upcoming isDriver true→false flip from being counted
      // as a yank by the analytics watcher below.
      pendingReleaseReasonRef.current = 'manual';
      void releaseControl();
      track('Wall Control Released', {
        reason: 'manual',
        mode: 'party',
        boardLayout,
      });
      return;
    }
    // Solo: BLE-centric — the lightbulb's filled state means "a board is
    // paired." Tap when not paired opens the picker directly (no 2s watcher
    // needed; there's no other device that might emit a wall-confirm).
    // Tap when paired sends the displayed climb to the wall — `takeControl`
    // short-circuits to `setCurrentClimb` in solo, which the BLE AutoSender
    // picks up. Re-pressing the exact same frames is deduped at the BLE layer
    // by the send-payload signature; the deeper "actually disconnect BLE" path
    // stays on the long-press into the light-control drawer.
    if (!isPersistentSessionActive) {
      if (!isBluetoothConnected) {
        track('Wall Control Taken', {
          source: 'lightbulb_drawer',
          previousDriver,
          mode: 'solo',
          boardLayout,
          climbUuid: currentClimb?.uuid ?? null,
        });
        // Silent reconnect to the board we were last on (native shells only —
        // Web Bluetooth ignores a target serial and always shows the chooser).
        // Null when nothing's remembered or the user switched boards, so we
        // open the picker. Don't pass frames: the fresh AutoSender re-pushes
        // the current climb on mount (passing them risks a double-write).
        if (reconnectSerialForCurrentBoard && isNativeApp()) {
          void bluetoothConnect(undefined, undefined, reconnectSerialForCurrentBoard);
        } else {
          void bluetoothConnect();
        }
        return;
      }
      if (!currentClimb) return;
      void takeControl(currentClimb);
      // Force a re-push even when the climb is unchanged — re-tapping the
      // lightbulb should re-light the wall. If the link is secretly dead (the
      // board was grabbed but no disconnect event fired), the failing write
      // trips disconnect detection and darkens the bulb so the next tap
      // reconnects.
      reassertWall();
      setDrawerDisplayedItem?.(null);
      track('Wall Control Taken', {
        source: 'lightbulb_drawer',
        previousDriver,
        mode: 'solo',
        boardLayout,
        climbUuid: currentClimb.uuid,
      });
      return;
    }
    // Party + non-driver: take + arm the 2s wall-confirm watcher. The
    // watcher fires the picker fallback if no BLE-paired peer emits a
    // confirmation in time — exactly what the pivot's lightbulb is for.
    if (!currentClimb) return;
    void takeControl(currentClimb);
    setDrawerDisplayedItem?.(null);
    setPendingClimbUuid(currentClimb.uuid);
    track('Wall Control Taken', {
      source: 'lightbulb_drawer',
      previousDriver,
      mode: 'party',
      boardLayout,
      climbUuid: currentClimb.uuid,
    });
    armWallConfirmWatcher({
      climbUuid: currentClimb.uuid,
      mode: 'party',
      boardLayout,
    });
  }, [
    currentClimb,
    takeControl,
    releaseControl,
    setDrawerDisplayedItem,
    isDriver,
    isPersistentSessionActive,
    isBluetoothConnected,
    bluetoothConnect,
    reassertWall,
    reconnectSerialForCurrentBoard,
    armWallConfirmWatcher,
    cancelWallConfirmWatcher,
    boardDetails.layout_name,
    participantId,
    sessionData.driverParticipantId,
  ]);
  const handleNextNavClick = useCallback(() => navigate('next', 'playViewDrawer'), [navigate]);
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
      setIsActionsOpen(false);
      setIsPlaylistSelectorOpen(false);
      setQueueMounted(true);
      setIsQueueOpen(true);
    };
    const closeHandler = () => {
      setIsQueueOpen(false);
    };
    window.addEventListener(TOUR_OPEN_PLAY_QUEUE_EVENT, openHandler);
    window.addEventListener(TOUR_CLOSE_PLAY_QUEUE_EVENT, closeHandler);
    return () => {
      window.removeEventListener(TOUR_OPEN_PLAY_QUEUE_EVENT, openHandler);
      window.removeEventListener(TOUR_CLOSE_PLAY_QUEUE_EVENT, closeHandler);
    };
  }, []);

  // When opened from a /view/ direct hit (initialOpenWithoutAnimation), seed
  // drawerOpen synchronously so the SSR-rendered DOM already has the drawer
  // visible. Otherwise start closed and let the open-effect below drive the
  // animation as usual.
  const [drawerOpen, setDrawerOpen] = useState(() => initialOpenWithoutAnimation && isOpen);
  const openRafRef = useRef<number>(0);
  // Seed `hasBeenMounted` to true when we open synchronously so the open
  // effect below doesn't try to RAF the transition on the same render.
  const hasBeenMountedRef = useRef(initialOpenWithoutAnimation && isOpen);

  const [contentReady, setContentReady] = useState(() => initialOpenWithoutAnimation && isOpen);
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
  }, [isOpen]);

  const [sectionsEverEnabled, setSectionsEverEnabled] = useState(false);
  const handleTransitionEnd = useCallback((open: boolean) => {
    if (open) setSectionsEverEnabled(true);
  }, []);

  const currentFrames = currentClimb?.frames;
  const currentMirrored = currentClimb?.mirrored;
  useEffect(() => {
    if (currentClimb) {
      renderBoard({
        boardDetails,
        frames: currentClimb.frames,
        mirrored: !!currentClimb.mirrored,
      }).catch((e: unknown) => {
        if (process.env.NODE_ENV === 'development') console.info('Pre-warm render failed:', e);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see comment above
  }, [currentFrames, currentMirrored, boardDetails]);

  const handleBoardPullClose = useCallback(() => {
    setDrawerOpen(false);
    setActiveDrawer('none');
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
    if (!currentClimb) return null;
    return (
      <>
        {/* Header: Grade | Name */}
        <div className={styles.headerSection}>
          <ClimbDetailHeader climb={currentClimb} />
        </div>

        {/* Board renderer with card-swipe and floating Tick FAB */}
        <div className={styles.boardSectionWrapper}>
          {currentClimb && carouselCurrentClimb && (
            <SwipeBoardCarousel
              boardDetails={boardDetails}
              currentClimb={carouselCurrentClimb}
              // Bind zoom to the climb UUID, not the frames string — without
              // this, every animation tick changes `frames` and ZoomableBoard
              // resets the pinch zoom.
              zoomResetKey={currentClimb.uuid}
              nextClimb={nextItem?.climb}
              previousClimb={isDriftedFromWall ? (currentClimbQueueItem?.climb ?? prevItem?.climb) : prevItem?.climb}
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
          {isOpen && currentClimb && (
            <PlayViewTickBar
              isTickBarActive={isTickBarActive}
              currentClimb={currentClimb}
              angle={angle}
              boardDetails={boardDetails}
              onClose={handleTickBarClose}
              onError={handleTickBarError}
            />
          )}
        </div>

        <MiniSessionBar
          isDriver={isDriver}
          isPersistentSessionActive={isPersistentSessionActive}
          sessionUsers={sessionUsers}
          participantId={participantId}
          driverParticipantId={driverParticipantId}
          currentClimbQueueItem={currentClimbQueueItem}
          drawerDisplayedItem={drawerDisplayedItem}
          onReturnToWallClimb={handleReturnToWallClimb}
        />

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
            lightbulbActive={isPersistentSessionActive ? isDriver : isBluetoothConnected}
            lightbulbPending={pendingClimbUuid != null}
            lightbulbCoachmark={showLightbulbCoachmark && !pendingClimbUuid}
            lightbulbCoachmarkText={lightbulbCoachmarkText ?? t('playView.actionBar.lightbulb.coachmark')}
            onLightbulbCoachmarkSeen={handleLightbulbCoachmarkSeen}
            displayedClimbName={currentClimb?.name ?? null}
            onLightbulb={handleLightbulbClick}
            onLightbulbLongPress={handleOpenLightDrawer}
            angleSelector={
              <AngleSelector
                boardName={boardDetails.board_name}
                boardDetails={boardDetails}
                currentAngle={currentAngle}
                currentClimb={currentClimb}
                isAngleAdjustable
              />
            }
          />
        )}

        {/* Playback strip — only renders for multi-frame climbs ("routes"). */}
        {isOpen && playback.isAnimatable && (
          <PlaybackControls
            frameIndex={playback.frameIndex}
            frameCount={playback.frameCount}
            isPlaying={playback.isPlaying}
            speed={playback.speed}
            onPlay={playback.play}
            onPause={playback.pause}
            onSeek={playback.seek}
            onSpeedChange={playback.setSpeed}
          />
        )}
      </>
    );
  }, [
    currentClimb,
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
    isDriver,
    handleLightbulbClick,
    handleOpenLightDrawer,
    angle,
    handleTickBarClose,
    handleTickBarError,
    pendingClimbUuid,
    showLightbulbCoachmark,
    handleLightbulbCoachmarkSeen,
    t,
    isPersistentSessionActive,
    isBluetoothConnected,
    currentClimbQueueItem,
    sessionUsers,
    participantId,
    driverParticipantId,
    drawerDisplayedItem,
    handleReturnToWallClimb,
    lightbulbCoachmarkText,
    playback,
    carouselCurrentClimb,
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
      paperRef={combinedPaperRef}
      swipeEnabled={!isActionsOpen && !isQueueOpen && !isPlaylistSelectorOpen}
      showDragHandle
      disableEnterAnimation={initialOpenWithoutAnimation}
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
          {/* Grabber-row driver dot: a small driver avatar pinned to the
              top-left, beside the drawer's grabber. Gives a peripheral
              "who's driving" cue even when the user's eye is on the climb
              header or board renderer (the mini session bar lives near the
              bottom of the drawer). Renders only in a party session with a
              driver present; the local user being the driver hides it
              (they don't need to be told they're driving). */}
          {isPersistentSessionActive && driverUser && !isDriver && (
            <Box
              sx={{
                position: 'absolute',
                top: 10,
                left: 12,
                zIndex: 2,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 0.5,
                pointerEvents: 'none',
              }}
            >
              <TickBadgeAvatar user={driverUser} hasTicked={false} isDriver size={18} />
            </Box>
          )}
          <div
            className={styles.drawerContent}
            onTouchStart={handleBoardTouchStart}
            onTouchMove={handleBoardTouchMove}
            onTouchEnd={handleBoardTouchEnd}
          >
            {currentClimb ? (
              <PlayDrawerContent
                climb={currentClimb}
                boardType={boardDetails.board_name}
                angle={currentAngle}
                layoutId={boardDetails.layout_id}
                viewerBoardDetails={boardDetails}
                sectionsEnabled={sectionsEverEnabled && isOpen}
                aboveFold={aboveFold}
                paperRef={playPaperRef}
              />
            ) : (
              <ClimbDetailShellClient mode="play" sections={[]} aboveFold={null} />
            )}
          </div>

          {/* Climb actions drawer */}
          {isOpen && currentClimb && isActionsOpen && (
            <SwipeableDrawer
              placement="bottom"
              title={
                currentClimb ? (
                  <div data-swipe-blocked="" {...actionsDragHandlers} className={drawerCss.dragHeaderWrapper}>
                    <DrawerClimbHeader climb={currentClimb} boardDetails={boardDetails} />
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
                climb={currentClimb}
                boardDetails={boardDetails}
                angle={currentAngle}
                currentPathname={pathname}
                viewMode="list"
                include={ACTION_SHEET_ACTION_ORDER}
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
          {isOpen && currentClimb && isPlaylistSelectorOpen && (
            <SwipeableDrawer
              title={<DrawerClimbHeader climb={currentClimb} boardDetails={boardDetails} />}
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
                climbUuid={currentClimb.uuid}
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
        />
      )}
      {/* Light-control drawer — opened by long-pressing the action bar's
          lightbulb. Hosts disco/glyph light shows, palette customisation,
          and the manual BLE disconnect that the old ShareBoardButton
          used to own. Mounted lazily on first open. */}
      {hasOpenedLightDrawer && (
        <LightControlDrawer open={lightDrawerOpen} onClose={handleCloseLightDrawer} boardDetails={boardDetails} />
      )}
    </SwipeableDrawer>
  );
};

export default React.memo(PlayViewDrawer);
