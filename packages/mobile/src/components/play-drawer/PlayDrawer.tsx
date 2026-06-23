import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Platform, View, Pressable, StyleSheet, useWindowDimensions } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  BottomSheetModal,
  BottomSheetScrollView,
  type BottomSheetBackdropProps,
  type BottomSheetBackgroundProps,
} from '@gorhom/bottom-sheet';
import { SheetBackdrop } from '../SheetBackdrop';
import type { BoardName, Climb } from '@boardsesh/shared-schema';
import type { ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';
import { randomUUID } from 'expo-crypto';
import { computeNavigationStateWithSuggestions, boardSupportsMirroring } from '@boardsesh/play-view';
import { climbToQueueItem } from '../../lib/climb-to-queue-item';
import type { ActiveSubDrawer } from '@boardsesh/play-view';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { DeferredBoard } from './DeferredBoard';
import { BoardRenderUnavailable } from './BoardRenderUnavailable';
import { PlaybackControls } from './PlaybackControls';
import { useMobilePlayback } from './use-mobile-playback';
import { PlayDrawerHeader } from './PlayDrawerHeader';
import { PlayDrawerPreviewBanner } from './PlayDrawerPreviewBanner';
import { PlayDrawerOnWallBanner } from './PlayDrawerOnWallBanner';
import { PlayDrawerActionBar } from './PlayDrawerActionBar';
import { SwitchBoardOverlay } from './SwitchBoardOverlay';
import { LogAscentSheet } from '../LogAscentSheet';
import { DeferredSections } from './DeferredSections';
import { computeFirstScreenHeight } from './play-drawer-layout';
import { AngleSelectorSheet } from './AngleSelectorSheet';
import { ClimbActionsSheet } from '../ClimbActionsSheet';
import { AddBetaVideoSheet } from '../AddBetaVideoSheet';
import { useBleControlSheet } from '../../providers/ble-control-sheet-provider';
import { GlassSheetBackground } from '../GlassSheetBackground';
import { Icon } from '../Icon';
import { usePlaylistSuggestionSource, useQueue } from '../../providers/queue-provider';
import { useOptionalBluetoothContext } from '../../providers/bluetooth-provider';
import { useAuth } from '../../providers/auth-provider';
import { useToast } from '../../providers/toast-provider';
import { useToggleFavorite, useFavoriteStatus } from '../../lib/graphql/hooks';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { useShareClimb } from '../../hooks/use-share-climb';
import { getBoardRenderData } from '../../lib/board-details';
import { hapticSuccess } from '../../lib/haptics';
import { usePlayDrawerWakeLock } from './use-play-drawer-wake-lock';
import { useDeferredSheetOpen } from './use-deferred-sheet-open';
import { resolveFavoriteRollback } from './favorite-rollback';
import { buildPlayDrawerBoardLayout } from './lightbulb-control';
import { getViewOnlyPreviewNavigationTarget } from './play-drawer-navigation';
import { useLightbulbControl } from '../ble/use-lightbulb-control';
import { track } from '../../lib/analytics';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing, sheetStyles } from '../../theme/tokens';

type BoardConfig = {
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
};

export type PlayDrawerOpenOptions = {
  /**
   * The caller already dispatched `setCurrentClimb` for this climb (the
   * drawer-host queue / suggestion / board-sheet taps and playlist activation
   * do this). The drawer renders from `currentClimbQueueItem` and skips its own
   * commit so the item isn't dispatched twice. No Preview badge — the shown
   * climb IS the active climb.
   */
  committedExternally?: boolean;
  /**
   * View-only preview: show this item in the drawer WITHOUT committing it to the
   * queue. The drawer renders a "Preview" badge + a "Set active" button so the
   * user can promote it. Used by the explicit "Preview" climb action, the
   * deep-link / standalone climb-page route, the workout builder, and the
   * peer-driven wall climb behind the accessory bar. The lightbulb keeps acting
   * on the active climb, not this preview. (The wall climb opts into
   * `previewIsWallClimb` below, which swaps the "Preview / Set active" banner for
   * the read-only "On the wall" status.)
   */
  previewQueueItem?: ClimbQueueItem | null;
  /**
   * The preview is the live wall climb behind the accessory bar — a peer (or
   * another climber on this board) is driving the wall and this climb is lit
   * right now. Renders the read-only "On the wall" status banner instead of
   * "Preview / Set active": it isn't a browse preview to promote, it's already
   * on the wall. Only meaningful alongside `previewQueueItem`.
   */
  previewIsWallClimb?: boolean;
  /**
   * Playlist source that seeds the drawer's next/previous suggestions for a
   * preview open (the suggestion source isn't on the queue yet). Drives
   * swipe-through-playlist in the drawer without re-dispatching.
   */
  playlistSuggestionSource?: PlaylistSuggestionSource | null;
};

export type PlayDrawerHandle = {
  open: (climb: Climb, options?: PlayDrawerOpenOptions) => void;
  close: () => void;
};

type PlayDrawerProps = {
  boardConfig: BoardConfig;
  onAngleChange?: (angle: number) => void;
  /** When false, the board's angle is fixed — the angle pill is hidden. */
  isAngleAdjustable?: boolean;
  /** Open the queue list sheet (provided by DrawerHostProvider; passed as a prop
   *  rather than read via useDrawerHost to avoid a host↔PlayDrawer require cycle). */
  onOpenQueue: () => void;
  /** When true, the displayed climb belongs to a board other than the user's
   *  active board — render the switch-board overlay over the controls. */
  boardMismatch?: boolean;
  /** Human-readable name of the climb's board, shown in the overlay message. */
  mismatchBoardLabel?: string;
  /** Switch to the climb's board (one-tap if owned, else the board picker). */
  onSwitchBoard?: () => void;
  /** Opens the climb reaction menu (DrawerHostProvider's openClimbActions, passed as a
   *  prop to avoid a host↔PlayDrawer require cycle). On iOS the ellipsis uses this
   *  instead of the in-drawer bottom sheet. */
  onOpenClimbActions?: (climb: Climb) => void;
};

// Full-screen now-playing takeover: a single 100% snap, no peek detent. The
// mini-player (PersistentQueueBar) is the collapsed state, like Spotify.
const SNAP_POINTS = ['100%'];
// Fallback used for the first-screen reserve before the Beta Videos header has
// been measured, so the board fits without a visible jump on first open.
const DEFAULT_BETA_HEADER_HEIGHT = 52;
// No gorhom handle — at topInset 0 it would sit under the notch. A grabber is
// rendered inside the content instead; swipe-to-close still works via
// enablePanDownToClose + enableContentPanningGesture.
const renderNoHandle = () => null;

export const PlayDrawer = forwardRef<PlayDrawerHandle, PlayDrawerProps>(function PlayDrawer(
  {
    boardConfig,
    onAngleChange,
    isAngleAdjustable = true,
    onOpenQueue,
    boardMismatch = false,
    mismatchBoardLabel,
    onSwitchBoard,
    onOpenClimbActions,
  },
  ref,
) {
  const { t } = useTranslation('session');
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const sheetRef = useRef<BottomSheetModal>(null);
  const [drawerPreviewItem, setDrawerPreviewItem] = useState<ClimbQueueItem | null>(null);
  const [drawerPreviewSuggestionSource, setDrawerPreviewSuggestionSource] = useState<PlaylistSuggestionSource | null>(
    null,
  );
  // True when the preview is the live wall climb (accessory bar). Swaps the
  // "Preview / Set active" banner for the read-only "On the wall" status.
  const [drawerPreviewIsWallClimb, setDrawerPreviewIsWallClimb] = useState(false);
  const [isMirrored, setIsMirrored] = useState(false);
  // Local optimistic override for the heart. `null` means "no local change —
  // show the server's favorite status". A tap sets it optimistically, the
  // mutation's returned `favorited` confirms it, and a failure rolls it back.
  // Cleared on every climb change so the next climb shows its real status.
  const [favoriteOverride, setFavoriteOverride] = useState<boolean | null>(null);
  const [isTickBarActive, setIsTickBarActive] = useState(false);
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  const [activeSubDrawer, setActiveSubDrawer] = useState<ActiveSubDrawer>('none');
  const [addBetaVideoOpen, setAddBetaVideoOpen] = useState(false);
  const [belowFoldContentRequested, setBelowFoldContentRequested] = useState(false);
  const resetZoomRef = useRef<(() => void) | null>(null);

  // Beta Videos section-header height feeds the first-screen reserve so the
  // header teases at the bottom of the full-screen view (the cue that there's
  // more to scroll). Measured because it varies with locale / font scaling.
  const [betaHeaderHeight, setBetaHeaderHeight] = useState(0);
  const handleBetaHeaderLayout = useCallback((measured: number) => {
    setBetaHeaderHeight((prev) => (Math.abs(prev - measured) > 2 ? Math.round(measured) : prev));
  }, []);

  const { state, setCurrentClimb, nextClimb, previousClimb, sessionId, addToQueue } = useQueue();
  const playlistSuggestionSource = usePlaylistSuggestionSource();
  const bluetooth = useOptionalBluetoothContext();
  const { mutate: toggleFavoriteMutate } = useToggleFavorite();
  const { formatGrade } = useGradeFormat();
  const { isAuthenticated } = useAuth();

  const { boardName, layoutId, sizeId, setIds, angle } = boardConfig;
  // Opens the shared, app-root BLE controls sheet (same instance the persistent
  // bar's board control uses), so there's one Re-light / Disconnect menu.
  const { open: openBleControlSheet } = useBleControlSheet();

  usePlayDrawerWakeLock(isSheetOpen);

  const boardLayout = useMemo(
    () => buildPlayDrawerBoardLayout({ boardName, layoutId, sizeId }),
    [boardName, layoutId, sizeId],
  );

  const boardRenderData = useMemo(() => {
    const parsedSetIds = setIds.split(',').map(Number);
    return getBoardRenderData({
      boardName: boardName as BoardName,
      layoutId,
      sizeId,
      setIds: parsedSetIds,
    });
  }, [boardName, layoutId, sizeId, setIds]);

  const displayedQueueItem = drawerPreviewItem ?? state.currentClimbQueueItem;
  const displayedClimb = displayedQueueItem?.climb;
  // A view-only preview is showing (not the active/wall climb). Commit paths
  // never set `drawerPreviewItem`, so this is true only for genuine previews
  // (workout builder, logbook/cross-board, the peer-driven accessory wall climb).
  const isPreview = drawerPreviewItem != null;

  // Real favorite status for the heart, keyed on (boardName, climbUuid, angle).
  // Gated on the sheet being open so it doesn't fetch while the drawer is closed.
  // The displayed state is the local optimistic override when set, otherwise the
  // server's truth — so the heart reflects whether the climb is already a favorite
  // on open, and a single tap can't invert reality (the previous always-false
  // local state silently un-favorited already-favorited climbs).
  const { data: serverFavorited } = useFavoriteStatus(boardName, displayedClimb?.uuid ?? null, angle, {
    enabled: isSheetOpen,
  });
  const isFavorited = favoriteOverride ?? serverFavorited ?? false;
  // Lit visual, pending pulse, and the connect/disconnect tap — shared with the
  // toolbar bulb via `useLightbulbControl`, so both light identically (this
  // device, or a session peer driving the wall) and run one connect path. The
  // press action keys on THIS device's BLE; `lightbulbConnected` (below) carries
  // that to the action bar for the accessibility label.
  const {
    lit: lightbulbActive,
    localConnected: bluetoothConnected,
    pending: lightbulbPending,
    onPress: handleLightbulb,
  } = useLightbulbControl({
    source: 'lightbulb_drawer',
    boardLayout,
    climbUuid: displayedClimb?.uuid ?? null,
  });
  const navigationSuggestionSource = drawerPreviewSuggestionSource ?? playlistSuggestionSource;
  const navigationState = useMemo(
    () => computeNavigationStateWithSuggestions(state.queue, displayedQueueItem, navigationSuggestionSource),
    [state.queue, displayedQueueItem, navigationSuggestionSource],
  );

  // Multi-frame route playback (animation + BLE + party-sync). Boulders
  // short-circuit inside the hook (isAnimatable === false), so nothing renders
  // and the drawer behaves exactly as before for single-frame climbs.
  const playback = useMobilePlayback({
    climb: displayedClimb ?? null,
    boardName: boardName as BoardName,
    mirrored: isMirrored,
    isOpen: isSheetOpen,
  });

  // Auto-close tick bar and drop the favorite override when climb changes, so the
  // new climb's heart shows its real (server) status rather than the previous
  // climb's optimistic value.
  const displayedClimbUuid = displayedClimb?.uuid;
  useEffect(() => {
    setIsTickBarActive(false);
    setFavoriteOverride(null);
  }, [displayedClimbUuid]);

  // Once the user has requested below-fold content in an open sheet, keep it
  // mounted across climb changes because the scroll view stays below the fold.
  // Reset only after close so the next fresh open starts cheap again.
  useEffect(() => {
    if (!isSheetOpen) setBelowFoldContentRequested(false);
  }, [isSheetOpen]);

  // When the board angle changes, drop the locally-pinned climb so the drawer
  // re-derives the displayed climb from currentClimbQueueItem — which the queue
  // re-grade effect patches with the new angle's grade. Without this, the header
  // would keep showing the stale grade baked into the locally-held climb. The
  // preview suggestion source anchors peeks on that pinned climb, so it must
  // drop with it — kept alone it would aim next-peeks at the wrong climb.
  useEffect(() => {
    setDrawerPreviewItem(null);
    setDrawerPreviewSuggestionSource(null);
  }, [angle]);

  const { showToast } = useToast();

  const shareClimb = useShareClimb({
    climb: displayedClimb ?? null,
    boardName,
    layoutId,
    sizeId,
    setIds,
    angle,
  });

  // Android can throw on share cancellation; surface anything we didn't expect
  // rather than silently swallowing the rejection.
  const handleShare = useCallback(() => {
    shareClimb().catch((error) => {
      console.warn('[playDrawer] share failed:', error);
      showToast(t('playView.shareError'), 'error');
    });
  }, [shareClimb, showToast, t]);

  const openDrawer = useCallback(
    (selectedClimb: Climb, options?: PlayDrawerOpenOptions) => {
      const previewItem = options?.previewQueueItem ?? null;
      const playlistSuggestionSource = options?.playlistSuggestionSource ?? null;
      // A view-only preview is shown without committing; the badge keys off this.
      // Commit paths (committedExternally) and fresh active opens leave it null so
      // the drawer renders the real currentClimbQueueItem.
      setDrawerPreviewItem(previewItem);
      setDrawerPreviewSuggestionSource(previewItem ? playlistSuggestionSource : null);
      setDrawerPreviewIsWallClimb(previewItem ? (options?.previewIsWallClimb ?? false) : false);
      setIsMirrored(false);
      // Drop any stale optimistic heart so the opened climb shows its real
      // (server) favorite status rather than a leftover from the last climb.
      setFavoriteOverride(null);
      setIsTickBarActive(false);
      setIsSheetOpen(true);
      setActiveSubDrawer('none');
      if (!previewItem && !options?.committedExternally) {
        // Fresh active open (search / list / LogbookTab / accessory-of-current):
        // make it current unless it already is, so re-opening the current climb
        // doesn't re-append it. A fresh-uuid item on a genuinely new selection is
        // intentional (re-tapping starts a fresh pass — see queue setCurrentClimb).
        const isAlreadyCurrent = state.currentClimbQueueItem?.climb.uuid === selectedClimb.uuid;
        if (!isAlreadyCurrent) {
          setCurrentClimb(climbToQueueItem(selectedClimb), { playlistSuggestionSource: null });
        }
      }
      sheetRef.current?.present();
    },
    [state.currentClimbQueueItem, setCurrentClimb],
  );

  // Serialize open() against the sheet's dismiss animation: presenting
  // mid-dismiss races gorhom's onDismiss, which then fires AFTER the re-present
  // and wipes isSheetOpen — leaving the sheet visibly open with the board gated
  // off forever (the intermittent blank-board-on-reopen bug). The hook stashes
  // an open requested mid-dismiss and replays it once the dismissal settles.
  const openDrawerFromArgs = useCallback(
    (args: { climb: Climb; options?: PlayDrawerOpenOptions }) => openDrawer(args.climb, args.options),
    [openDrawer],
  );
  const { requestOpen, onAnimate: handleSheetAnimateIndex, flushOnDismiss } = useDeferredSheetOpen(openDrawerFromArgs);

  useImperativeHandle(
    ref,
    () => ({
      open: (selectedClimb: Climb, options?: PlayDrawerOpenOptions) => {
        requestOpen({ climb: selectedClimb, options });
      },
      close: () => {
        sheetRef.current?.dismiss();
      },
    }),
    [requestOpen],
  );

  const handleSheetAnimate = useCallback(
    (_fromIndex: number, toIndex: number) => {
      handleSheetAnimateIndex(toIndex);
    },
    [handleSheetAnimateIndex],
  );

  const handleClose = useCallback(() => {
    setDrawerPreviewItem(null);
    setDrawerPreviewSuggestionSource(null);
    setDrawerPreviewIsWallClimb(false);
    setIsMirrored(false);
    setIsTickBarActive(false);
    setIsSheetOpen(false);
    setActiveSubDrawer('none');
    // Replay an open() that arrived while this dismissal was animating — the
    // modal is now fully dismissed, so the re-present is clean.
    flushOnDismiss();
  }, [flushOnDismiss]);

  const handlePrev = useCallback(() => {
    const previewTarget = getViewOnlyPreviewNavigationTarget({
      previewItem: drawerPreviewItem,
      previewSuggestionSource: drawerPreviewSuggestionSource,
      targetItem: navigationState.prevItem,
    });
    if (previewTarget.viewOnly) {
      if (!previewTarget.targetItem) return;
      setDrawerPreviewItem(previewTarget.targetItem);
      setIsMirrored(false);
      // The favorite override is cleared by the climb-change effect.
      return;
    }
    // Always-live: navigation commits the shared current climb for everyone.
    setDrawerPreviewItem(null);
    setDrawerPreviewIsWallClimb(false);
    previousClimb();
    setIsMirrored(false);
    // The favorite override is cleared by the climb-change effect.
  }, [drawerPreviewSuggestionSource, drawerPreviewItem, navigationState.prevItem, previousClimb]);

  const handleNext = useCallback(() => {
    const previewTarget = getViewOnlyPreviewNavigationTarget({
      previewItem: drawerPreviewItem,
      previewSuggestionSource: drawerPreviewSuggestionSource,
      targetItem: navigationState.nextItem,
    });
    if (previewTarget.viewOnly) {
      if (!previewTarget.targetItem) return;
      setDrawerPreviewItem(previewTarget.targetItem);
      setIsMirrored(false);
      // The favorite override is cleared by the climb-change effect.
      return;
    }
    // Always-live: navigation commits the shared current climb for everyone.
    setDrawerPreviewItem(null);
    setDrawerPreviewIsWallClimb(false);
    nextClimb();
    setIsMirrored(false);
    // The favorite override is cleared by the climb-change effect.
  }, [drawerPreviewSuggestionSource, drawerPreviewItem, navigationState.nextItem, nextClimb]);

  // Promote the previewed climb to the active/current queue item. The Preview
  // badge clears and the lightbulb (which acts on the current climb) now drives
  // this climb.
  const handleSetActive = useCallback(() => {
    if (!drawerPreviewItem) return;
    setCurrentClimb(drawerPreviewItem, { playlistSuggestionSource: drawerPreviewSuggestionSource });
    setDrawerPreviewItem(null);
    setDrawerPreviewSuggestionSource(null);
    setDrawerPreviewIsWallClimb(false);
  }, [drawerPreviewItem, drawerPreviewSuggestionSource, setCurrentClimb]);

  const handleMirror = useCallback(() => {
    const nextMirrored = !isMirrored;
    setIsMirrored(nextMirrored);
    // The wall doesn't follow the toggle by itself: the AutoSender keys off
    // the queue item's own `climb.mirrored`, not this drawer-local state, so
    // without an explicit re-push the LEDs would keep showing the previous
    // orientation. isConnected means this device holds the BLE link (and
    // therefore drives the wall).
    if (bluetooth?.isConnected && displayedClimb?.frames) {
      void bluetooth.sendFramesToBoard(displayedClimb.frames, nextMirrored);
    }
  }, [isMirrored, bluetooth, displayedClimb]);

  const handleToggleFavorite = useCallback(() => {
    if (!displayedClimb) return;
    hapticSuccess();
    const nextIsFavorited = !isFavorited;
    const previousOverride = favoriteOverride;
    setFavoriteOverride(nextIsFavorited);
    track(SHARED_EVENTS.FavoriteToggle, {
      action: nextIsFavorited ? 'added' : 'removed',
      climbUuid: displayedClimb.uuid,
      boardName,
      layoutId,
      source: 'mobile_play_drawer',
    });
    toggleFavoriteMutate(
      {
        input: {
          boardName,
          climbUuid: displayedClimb.uuid,
          angle,
        },
      },
      {
        // Reconcile to the server's authoritative result — the backend toggles
        // off the real DB state, so this is the truth even if our optimistic
        // guess was wrong.
        onSuccess: (response) => {
          setFavoriteOverride(response.toggleFavorite.favorited);
        },
        // Roll back the optimistic flip and tell the user it didn't stick, rather
        // than leaving the heart diverged from the server. Only undo OUR flip,
        // though: if a newer tap (or a climb change, which resets the override to
        // null) has since moved the heart, this late error must not clobber the
        // current state with this tap's stale previous value.
        onError: () => {
          setFavoriteOverride((current) => resolveFavoriteRollback(current, nextIsFavorited, previousOverride));
          showToast(t('playView.favoriteError'), 'error');
        },
      },
    );
  }, [displayedClimb, isFavorited, favoriteOverride, boardName, layoutId, angle, toggleFavoriteMutate, showToast, t]);

  const handleLightbulbLongPress = useCallback(() => {
    if (!bluetooth?.isConnected) return;
    // Reveal the shared BLE controls (Re-light / Disconnect) rather than
    // disconnecting blind — keeps the destructive action behind a labelled menu.
    openBleControlSheet();
  }, [bluetooth, openBleControlSheet]);

  const handleOpenActions = useCallback(() => {
    // iOS: open the floating reaction menu (over the drawer) instead of the in-drawer
    // bottom sheet. Android keeps the bottom sheet.
    if (Platform.OS === 'ios' && onOpenClimbActions && displayedClimb) {
      onOpenClimbActions(displayedClimb);
      return;
    }
    setActiveSubDrawer('actions');
  }, [onOpenClimbActions, displayedClimb]);

  const handleOpenAddBetaVideo = useCallback(() => {
    setAddBetaVideoOpen(true);
  }, []);

  const handleCloseAddBetaVideo = useCallback(() => {
    setAddBetaVideoOpen(false);
  }, []);

  const handleScrollTowardBelowFold = useCallback(() => {
    setBelowFoldContentRequested(true);
  }, []);

  const handleOpenAngleSelector = useCallback(() => {
    setActiveSubDrawer('angleSelector');
  }, []);

  const handleCloseSubDrawer = useCallback(() => {
    setActiveSubDrawer('none');
  }, []);

  const handleTickFabPress = useCallback(() => {
    resetZoomRef.current?.();
    setIsTickBarActive(true);
  }, []);

  // Long-press now opens the same QuickTickBar as a short press; LogAscentSheet
  // has been retired in favour of a single ticking surface (see PR #2366).
  const handleTickFabLongPress = useCallback(() => {
    resetZoomRef.current?.();
    setIsTickBarActive(true);
  }, []);

  const handleTickBarDismiss = useCallback(() => {
    setIsTickBarActive(false);
  }, []);

  const handleResetZoomReady = useCallback((resetFn: () => void) => {
    resetZoomRef.current = resetFn;
  }, []);

  const handleSimilarClimbPress = useCallback(
    (similarClimb: Climb) => {
      const queueItem = climbToQueueItem(similarClimb);
      // Tapping a similar climb activates it (commit), so it's never a preview —
      // clear any preview that was showing.
      setDrawerPreviewItem(null);
      setDrawerPreviewSuggestionSource(null);
      setIsMirrored(false);
      // The favorite override is cleared by the climb-change effect.
      setIsTickBarActive(false);
      addToQueue(queueItem);
      setCurrentClimb(queueItem, { playlistSuggestionSource: null });
    },
    [addToQueue, setCurrentClimb],
  );

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <SheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.5} />
    ),
    [],
  );

  // Glass background with squared-off top corners so the sheet reads as a
  // full-screen takeover, not a rounded panel. `opaqueMaterial` makes the
  // takeover a denser, more opaque surface than the lighter glass on the other
  // sheets, while staying light in light mode.
  const renderBackground = useCallback(
    (props: BottomSheetBackgroundProps) => <GlassSheetBackground {...props} flatTop opaqueMaterial />,
    [],
  );

  // The first screen is sized so the action bar stays visible and the Beta
  // Videos header teases at the bottom across board sizes — the carousel fits
  // the leftover space (SwipeBoardCarousel contains the board). Reserve the
  // DeferredSections top padding, the beta header, and a small margin so that
  // header peeks just above the fold. The home-indicator inset belongs to the
  // scroll view's paddingBottom only — counting it here too would shrink the
  // board by that inset twice.
  const firstScreenReserve =
    spacing[3] + (betaHeaderHeight > 0 ? betaHeaderHeight : DEFAULT_BETA_HEADER_HEIGHT) + spacing[2];
  const firstScreenHeight = computeFirstScreenHeight(windowHeight, firstScreenReserve);

  const ascentCount = displayedClimb?.userAscents ?? 0;
  const supportsMirroring = boardSupportsMirroring(boardName, layoutId);
  const subDrawerOpen = activeSubDrawer !== 'none';

  return (
    <>
      <BottomSheetModal
        ref={sheetRef}
        snapPoints={SNAP_POINTS}
        index={0}
        topInset={0}
        enablePanDownToClose
        enableContentPanningGesture={!subDrawerOpen}
        enableHandlePanningGesture={!subDrawerOpen}
        backdropComponent={renderBackdrop}
        backgroundComponent={renderBackground}
        handleComponent={renderNoHandle}
        onAnimate={handleSheetAnimate}
        onDismiss={handleClose}
      >
        <BottomSheetScrollView
          style={styles.content}
          contentContainerStyle={{ paddingBottom: insets.bottom }}
          onScrollBeginDrag={handleScrollTowardBelowFold}
        >
          {displayedClimb && (
            <>
              <View style={[styles.firstScreen, { height: firstScreenHeight, paddingTop: insets.top }]}>
                <View style={styles.topRow}>
                  <View style={sheetStyles.indicator} />
                  <Pressable
                    onPress={() => sheetRef.current?.dismiss()}
                    accessibilityRole="button"
                    accessibilityLabel={t('playView.closeAria')}
                    style={styles.closeButton}
                    hitSlop={8}
                  >
                    <Icon name="chevron.down" size={20} color={iosSystemColors.systemGray} />
                  </Pressable>
                </View>

                <PlayDrawerHeader
                  name={displayedClimb.name}
                  difficulty={formatGrade(displayedClimb.difficulty) ?? displayedClimb.difficulty}
                  rawDifficulty={displayedClimb.difficulty}
                  qualityAverage={displayedClimb.quality_average}
                  ascensionistCount={displayedClimb.ascensionist_count}
                  setterUsername={displayedClimb.setter_username}
                  isNoMatch={displayedClimb.is_no_match}
                  benchmarkDifficulty={displayedClimb.benchmark_difficulty}
                  // The accessory-bar wall climb is physically lit right now, so its
                  // read-only "on the wall" status rides in the header's leading slot
                  // (left of the name, opposite the grade) rather than as a banner.
                  leading={isPreview && drawerPreviewIsWallClimb ? <PlayDrawerOnWallBanner /> : undefined}
                />

                {isPreview && !drawerPreviewIsWallClimb ? (
                  // Cross-board previews use the switch-board overlay instead, so
                  // hide "Set active" there — promoting a foreign-board climb would
                  // only spill it into the queue.
                  <PlayDrawerPreviewBanner showSetActive={!boardMismatch} onSetActive={handleSetActive} />
                ) : null}

                <View style={styles.boardSection}>
                  {boardRenderData ? (
                    <DeferredBoard
                      open={isSheetOpen}
                      boardName={boardName as BoardName}
                      boardRenderData={boardRenderData}
                      layoutId={layoutId}
                      sizeId={sizeId}
                      setIds={setIds}
                      currentFrames={displayedClimb.frames}
                      currentFrameOverride={playback.isAnimatable ? playback.currentFrameString : null}
                      nextFrames={navigationState.nextItem?.climb.frames ?? null}
                      prevFrames={navigationState.prevItem?.climb.frames ?? null}
                      mirrored={isMirrored}
                      canSwipeNext={navigationState.canNext}
                      canSwipePrevious={navigationState.canPrevious}
                      onSwipeNext={handleNext}
                      onSwipePrevious={handlePrev}
                      onResetZoomReady={handleResetZoomReady}
                      enabled={!isTickBarActive}
                    />
                  ) : (
                    <BoardRenderUnavailable
                      boardName={boardName}
                      layoutId={layoutId}
                      sizeId={sizeId}
                      setIds={setIds}
                      climbUuid={displayedClimb.uuid}
                      climbName={displayedClimb.name}
                    />
                  )}
                </View>

                {/* Controls region — gated by the switch-board overlay when the
                    displayed climb is on a board the user isn't currently on.
                    Board art + swipe above stay interactive for viewing. The
                    controls are wrapped so assistive tech can't reach them while
                    gated (on BOTH platforms — the scrim's accessibilityViewIsModal
                    is iOS-only); the overlay itself stays a sibling so its
                    "Switch board" action remains focusable. */}
                <View style={styles.controlsRegion}>
                  <View
                    accessibilityElementsHidden={boardMismatch}
                    importantForAccessibility={boardMismatch ? 'no-hide-descendants' : 'auto'}
                  >
                    {playback.isAnimatable && (
                      <PlaybackControls
                        frameIndex={playback.frameIndex}
                        frameCount={playback.frameCount}
                        isPlaying={playback.isPlaying}
                        speed={playback.speed}
                        paceMs={playback.paceMs}
                        onPlay={playback.play}
                        onPause={playback.pause}
                        onSeek={playback.seek}
                        onSpeedChange={playback.setSpeed}
                      />
                    )}

                    <PlayDrawerActionBar
                      canSwipePrevious={navigationState.canPrevious}
                      canSwipeNext={navigationState.canNext}
                      isMirrored={isMirrored}
                      supportsMirroring={supportsMirroring}
                      isFavorited={isFavorited}
                      remainingQueueCount={navigationState.remainingCount}
                      lightbulbActive={lightbulbActive}
                      lightbulbConnected={bluetoothConnected}
                      lightbulbPending={lightbulbPending}
                      lightbulbLongPressEnabled={bluetoothConnected}
                      // The on-wall banner owns the driver's face in the header
                      // when it's up; suppress the lightbulb pip so the same
                      // avatar never shows twice in the drawer.
                      showHolderBadge={!(isPreview && drawerPreviewIsWallClimb)}
                      ascentCount={ascentCount}
                      onPrevClick={handlePrev}
                      onNextClick={handleNext}
                      onMirror={handleMirror}
                      onToggleFavorite={handleToggleFavorite}
                      onLightbulb={handleLightbulb}
                      onLightbulbLongPress={handleLightbulbLongPress}
                      onOpenActions={handleOpenActions}
                      onOpenQueue={onOpenQueue}
                      onShare={handleShare}
                      onTickPress={handleTickFabPress}
                      onTickLongPress={handleTickFabLongPress}
                      currentAngle={angle}
                      onOpenAngleSelector={isAngleAdjustable ? handleOpenAngleSelector : undefined}
                    />
                  </View>

                  {boardMismatch && onSwitchBoard ? (
                    <SwitchBoardOverlay boardLabel={mismatchBoardLabel ?? ''} onSwitchBoard={onSwitchBoard} />
                  ) : null}
                </View>
              </View>

              {/* Below-fold deferred sections */}
              <DeferredSections
                climb={displayedClimb}
                boardName={boardName}
                layoutId={layoutId}
                sizeId={sizeId}
                setIds={setIds}
                angle={angle}
                enabled={isSheetOpen}
                contentEnabled={belowFoldContentRequested}
                onSimilarClimbPress={handleSimilarClimbPress}
                onBetaHeaderLayout={handleBetaHeaderLayout}
                onAddBetaVideo={isAuthenticated ? handleOpenAddBetaVideo : undefined}
              />
            </>
          )}
        </BottomSheetScrollView>
      </BottomSheetModal>

      {/* Sub-drawer: Climb actions — the Android / fallback path. On iOS the ellipsis
          routes to ClimbReactionMenu via onOpenClimbActions (see handleOpenActions), so
          activeSubDrawer never becomes 'actions' there and this sheet stays idle.
          Always mounted and toggled via `visible` (it presents as a BottomSheetModal
          with stackBehavior=push, the only way to render above the play drawer's own
          modal — same as the angle selector and tick sheet). A conditionally-mounted
          modal here would drop its present() over the already-open play drawer. */}
      <ClimbActionsSheet
        visible={activeSubDrawer === 'actions'}
        climb={displayedClimb ?? null}
        boardName={boardName as BoardName}
        layoutId={layoutId}
        sizeId={sizeId}
        setIds={setIds}
        angle={angle}
        onAddToQueue={() => {
          if (displayedClimb) {
            addToQueue({
              uuid: randomUUID(),
              climb: displayedClimb,
            });
          }
        }}
        onToggleFavorite={handleToggleFavorite}
        onAddBetaVideo={isAuthenticated ? handleOpenAddBetaVideo : undefined}
        onClose={handleCloseSubDrawer}
      />

      {/* Sub-drawer: Share your beta. Sibling modal (stackBehavior=push) so it
          stacks above the play drawer, opened from the action sheet's "Add beta
          video" row or the Beta Videos section "+" button. */}
      <AddBetaVideoSheet
        visible={addBetaVideoOpen}
        climb={displayedClimb ?? null}
        boardName={boardName as BoardName}
        layoutId={layoutId}
        angle={angle}
        onClose={handleCloseAddBetaVideo}
      />

      {/* Sub-drawer: Angle selector. Always mounted and toggled via `visible`
          (it presents as a BottomSheetModal with stackBehavior=push, the only
          way to render above the play drawer's own modal — same as the tick
          sheet below). A plain BottomSheet here would open behind this modal. */}
      <AngleSelectorSheet
        visible={activeSubDrawer === 'angleSelector'}
        onClose={handleCloseSubDrawer}
        boardName={boardName}
        layoutId={layoutId}
        climbUuid={displayedClimb?.uuid}
        currentAngle={angle}
        onAngleChange={(newAngle) => {
          onAngleChange?.(newAngle);
          handleCloseSubDrawer();
        }}
      />

      {/* Tick sheet — sibling of the PlayDrawer modal so it renders above
          (gorhom `BottomSheetModal` with stackBehavior=push). Snap-point is
          60% so the climb image above stays visible while logging. */}
      {displayedClimb && (
        <LogAscentSheet
          visible={isTickBarActive}
          onDismiss={handleTickBarDismiss}
          climbUuid={displayedClimb.uuid}
          boardName={boardName}
          angle={angle}
          isMirror={isMirrored}
          isBenchmark={displayedClimb.benchmark_difficulty != null}
          layoutId={layoutId}
          sizeId={sizeId}
          setIds={setIds}
          sessionId={sessionId}
          consensusGradeName={displayedClimb.difficulty}
        />
      )}
    </>
  );
});

const styles = StyleSheet.create({
  content: {
    flex: 1,
  },
  firstScreen: {
    width: '100%',
  },
  // Centers the grabber; the close button overlays the left edge.
  topRow: {
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeButton: {
    position: 'absolute',
    top: 0,
    left: spacing[2],
    zIndex: 2,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(120, 120, 128, 0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  boardSection: {
    flex: 1,
    position: 'relative',
    marginHorizontal: spacing[4],
  },
  // Anchors the switch-board overlay so its scrim covers exactly the playback +
  // action controls, leaving the board art and header above it interactive.
  controlsRegion: {
    position: 'relative',
  },
});
