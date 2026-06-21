'use client';

import React, {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useMemo,
  useDeferredValue,
} from 'react';
import { BoardPresenceCurrentContext } from '@boardsesh/board-presence-react';
import { emitWallConfirm } from '@boardsesh/play-view';
import { useTranslation } from 'react-i18next';
import { track } from '@/app/lib/analytics';
import IconButton from '@mui/material/IconButton';
import CloseOutlined from '@mui/icons-material/CloseOutlined';
import CheckOutlined from '@mui/icons-material/CheckOutlined';
import type { ClimbQueueItem } from '../queue-control/types';
import { usePathname } from 'next/navigation';
import { useQueueActions, useCurrentClimb, useQueueList, useSessionData } from '../graphql-queue';
import { ClimbActions } from '../climb-actions';
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
import { useWallConfirmFallback, WALL_CONFIRM_BACKSTOP_MS } from './use-wall-confirm-fallback';
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
   * Set when the user presses the lightbulb to connect + send the current climb
   * to the board — between the press and the climb converging onto the wall, the
   * lightbulb renders with a soft pulse so the user can see we're waiting.
   * Cleared when the climb confirms (convergent state), is superseded (queue
   * moves on), the session swaps, or the backstop fires.
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
    wallConfirmed,
    lastConnectedBoardSerial,
    participantId,
    users: sessionUsers,
  } = isOpen ? sessionData : deferredSession;
  const { mirrorClimb, getNextClimbQueueItem, getPreviousClimbQueueItem, setCurrentClimbQueueItem } = useQueueActions();
  const {
    isConnected: isBluetoothConnected,
    isBluetoothSupported,
    connect: bluetoothConnect,
    disconnect: bluetoothDisconnect,
    reconnectSerialForCurrentBoard,
  } = useBluetoothContext();

  // Board-presence connection holder — "someone is connected to and writing the
  // wall right now" (seeded for late joiners via fetchConnection). Used only to
  // light the party lightbulb; null when the board is free or unbound.
  const boardPresenceCurrent = useContext(BoardPresenceCurrentContext);

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

  // Card-swipe navigation. Always-live model: every participant (solo or
  // party) navigates the shared queue, and prev/next/swipe broadcasts the new
  // wall climb to everyone.
  //
  // When the user enters via a /view/{uuid} direct hit, the climbs list is
  // empty until React Query resolves — in that window getNextClimbQueueItem
  // returns null and the `!!nextItem` check below naturally disables nav.
  // Once `suggestedClimbs` populate, swipe + prev/next light up against them.
  const navigateFromItem = effectiveItem ?? null;
  const nextItem = getNextClimbQueueItem({ from: navigateFromItem });
  const prevItem = getPreviousClimbQueueItem({ from: navigateFromItem });

  // Always-live broadcast path: clear any lingering drawer-local preview so the
  // drawer's `effectiveItem = drawerDisplayedItem ?? wallClimb` fall-through
  // reads the freshly-broadcast wall climb, then set the new current climb
  // (which broadcasts via the persistent-session subscription in party).
  const advanceTo = useCallback(
    (item: ClimbQueueItem, method: 'swipePlayViewDrawer' | 'playViewDrawer', direction: 'next' | 'previous') => {
      setDrawerDisplayedItem?.(null);
      setCurrentClimbQueueItem(item);
      track('Queue Navigation', { direction, method, mode: 'broadcast' });
      track('Wall Advance', {
        source: method === 'swipePlayViewDrawer' ? 'drawer_swipe' : 'drawer_button',
        direction,
        mode: isPersistentSessionActive ? 'party' : 'solo',
        boardLayout: boardDetails.layout_name ?? '',
      });
    },
    [isPersistentSessionActive, setCurrentClimbQueueItem, setDrawerDisplayedItem, boardDetails.layout_name],
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
      // Don't trample an already-armed coachmark (e.g. one armed on a
      // swipe before the drawer-open effect resolved).
      if (lightbulbCoachmarkKeyRef.current) return;
      lightbulbCoachmarkKeyRef.current = 'swipeHint:lightbulbSeen';
      setShowLightbulbCoachmark(true);
    });
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  // Tracks the one-shot pulse currently armed so `onLightbulbCoachmarkSeen`
  // persists the right IDB key. The "Send to the wall" coachmark fires once on
  // the first drawer open ever.
  const lightbulbCoachmarkKeyRef = useRef<'swipeHint:lightbulbSeen' | null>(null);
  const handleLightbulbCoachmarkSeen = useCallback(() => {
    setShowLightbulbCoachmark(false);
    const key = lightbulbCoachmarkKeyRef.current;
    lightbulbCoachmarkKeyRef.current = null;
    if (key) void setPreference(key, true);
  }, []);

  const navigate = useCallback(
    (direction: 'next' | 'previous', source: 'swipePlayViewDrawer' | 'playViewDrawer') => {
      const getter = direction === 'next' ? getNextClimbQueueItem : getPreviousClimbQueueItem;
      const item = getter({ from: navigateFromItem });
      if (!item || viewOnlyMode) return;
      advanceTo(item, source, direction);
    },
    [getNextClimbQueueItem, getPreviousClimbQueueItem, navigateFromItem, viewOnlyMode, advanceTo],
  );

  const handleSwipeNext = useCallback(() => {
    navigate('next', 'swipePlayViewDrawer');
  }, [navigate]);
  const handleSwipePrevious = useCallback(() => {
    navigate('previous', 'swipePlayViewDrawer');
  }, [navigate]);

  const canSwipeNext = !viewOnlyMode && !!nextItem;
  const canSwipePrevious = !viewOnlyMode && !!prevItem;

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
    navigate('previous', 'playViewDrawer');
  }, [navigate]);
  // Wall-confirm watcher: armed by handleLightbulbClick. The pulse resolves
  // from convergent state — the local wall-confirm bus (fed by the BLE write,
  // the seq'd board-presence `BoardClimbSet`, and `WallConfirmedClimb`) — or
  // clears when the climb is superseded (queue moves on) / the session ends.
  // The timer is only a long backstop for a stuck pulse, not a verdict, so a
  // slow confirm still lands solid-lit instead of being clipped at 2 s.
  //
  // `onConfirmed` / `onTimeout` clear the lightbulb's pending pulse state so
  // the UI reflects the round-trip — pulse while pending, solid lit on confirm.
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

  // Derive the confirm from the convergent wall state: when the board-presence
  // feed *transitions* to show the pending climb on the wall (a fresh seq'd
  // `BoardClimbSet`, which also survives a reconnect catch-up), feed it into the
  // same wall-confirm bus the watcher listens on so it records `Wall Confirmed`
  // with the true, un-clipped latency. The bus coalesces, so this is safe
  // alongside the local BLE write that fires it immediately. Gate on the
  // transition (was-not → now-is), not steady-state equality: a tap while the
  // board already shows the climb is confirmed by the local write, not a fresh
  // round-trip, and would otherwise log a ~0 ms latency that skews the metric.
  const wallCurrentClimbUuid = boardPresenceCurrent?.currentClimb?.climbUuid ?? null;
  const prevWallCurrentClimbUuidRef = useRef<string | null>(null);
  useEffect(() => {
    const prevWallClimbUuid = prevWallCurrentClimbUuidRef.current;
    prevWallCurrentClimbUuidRef.current = wallCurrentClimbUuid;
    if (pendingClimbUuid && wallCurrentClimbUuid === pendingClimbUuid && prevWallClimbUuid !== pendingClimbUuid) {
      emitWallConfirm(pendingClimbUuid);
    }
  }, [wallCurrentClimbUuid, pendingClimbUuid]);

  // Supersede: if the user navigates the queue off the pending climb before it
  // confirms, the pulse was for a climb they've moved on from. Cancel the
  // watcher silently (no confirm, no timeout — it's neither) and clear the
  // pulse, so the longer backstop never leaves a stale pulse on the bulb.
  const committedCurrentClimbUuid = currentClimbQueueItem?.climb.uuid ?? null;
  useEffect(() => {
    if (pendingClimbUuid && committedCurrentClimbUuid && committedCurrentClimbUuid !== pendingClimbUuid) {
      cancelWallConfirmWatcher();
      setPendingClimbUuid(null);
    }
  }, [committedCurrentClimbUuid, pendingClimbUuid, cancelWallConfirmWatcher]);

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
   * Lightbulb press: a plain connect/disconnect toggle (matches mobile).
   * Always-live model — there is no driver role and no "re-send" gesture.
   *
   *  - BLE-connected → disconnect (turn the board off). The drop path releases
   *    the session wall + board-presence holder so every member's lightbulb
   *    clears.
   *  - Not BLE-connected → connect (silent reconnect to the last board on
   *    native shells, otherwise the device picker). The fresh AutoSender pushes
   *    the *committed* current climb on mount; arm the wall-confirm watcher on
   *    that same climb so the bulb pulses until it converges onto the wall.
   */
  const handleLightbulbClick = useCallback(() => {
    const boardLayout = boardDetails.layout_name ?? '';

    if (isBluetoothConnected) {
      // Disconnect. BLE-layer + handleConnectionChange handle analytics and the
      // session/board-presence holder release on the resulting drop.
      bluetoothDisconnect();
      return;
    }

    // Pulse/arm on the *committed* current climb — that's what the AutoSender
    // writes on connect and what board presence will report — not a drawer
    // browse-preview (`currentClimb` can be a previewed climb that never gets
    // sent, which would never confirm and would trip the supersede guard).
    const sendClimbUuid = currentClimbQueueItem?.climb.uuid ?? null;
    track('Wall Control Taken', {
      source: 'lightbulb_drawer',
      mode: isPersistentSessionActive ? 'party' : 'solo',
      boardLayout,
      climbUuid: sendClimbUuid,
    });
    // Silent reconnect to the board we were last on (native shells only — Web
    // Bluetooth ignores a target serial and always shows the chooser). Null
    // when nothing's remembered or the user switched boards, so we open the
    // picker. Don't pass frames: the fresh AutoSender re-pushes the current
    // climb on mount (passing them risks a double-write).
    if (reconnectSerialForCurrentBoard && isNativeApp()) {
      void bluetoothConnect(undefined, undefined, reconnectSerialForCurrentBoard);
    } else {
      void bluetoothConnect();
    }
    // Pulse the bulb until the climb converges onto the wall. We just initiated
    // the connect above, so arm pulse-only: the watcher must NOT fire its own
    // connect fallback on the backstop. Re-connecting later is redundant once the
    // first connect lands, and firing it while the device picker is still open
    // starts a second scan that trips "Already scanning. Stopping now." on iOS.
    // The backstop is connect-included (cold connect + write + ack), not a 2s
    // verdict — the confirm comes from convergent state and supersede clears the
    // pulse early when the user moves on.
    if (sendClimbUuid) {
      setPendingClimbUuid(sendClimbUuid);
      armWallConfirmWatcher({
        climbUuid: sendClimbUuid,
        mode: isPersistentSessionActive ? 'party' : 'solo',
        boardLayout,
        pulseOnly: true,
        timeoutMs: WALL_CONFIRM_BACKSTOP_MS,
      });
    }
  }, [
    currentClimbQueueItem,
    isPersistentSessionActive,
    isBluetoothConnected,
    bluetoothConnect,
    bluetoothDisconnect,
    reconnectSerialForCurrentBoard,
    armWallConfirmWatcher,
    boardDetails.layout_name,
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
          isPersistentSessionActive={isPersistentSessionActive}
          sessionUsers={sessionUsers}
          participantId={participantId}
          currentClimbQueueItem={currentClimbQueueItem}
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
            lightbulbActive={
              isPersistentSessionActive
                ? wallConfirmed || isBluetoothConnected || boardPresenceCurrent?.holder != null
                : isBluetoothConnected
            }
            lightbulbConnected={isBluetoothConnected}
            lightbulbPending={pendingClimbUuid != null}
            lightbulbCoachmark={showLightbulbCoachmark && !pendingClimbUuid}
            lightbulbCoachmarkText={t('playView.actionBar.lightbulb.coachmark')}
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
    wallConfirmed,
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
