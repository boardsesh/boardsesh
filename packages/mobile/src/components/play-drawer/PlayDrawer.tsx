import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { View, Pressable, StyleSheet, useWindowDimensions } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  BottomSheetModal,
  BottomSheetBackdrop,
  BottomSheetScrollView,
  type BottomSheetBackdropProps,
  type BottomSheetBackgroundProps,
} from '@gorhom/bottom-sheet';
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
import { PlayDrawerActionBar } from './PlayDrawerActionBar';
import { LogAscentSheet } from '../LogAscentSheet';
import { DeferredSections } from './DeferredSections';
import { computeFirstScreenHeight } from './play-drawer-layout';
import { AngleSelectorSheet } from './AngleSelectorSheet';
import { ClimbActionsSheet } from '../ClimbActionsSheet';
import { BleControlSheet } from '../ble/BleControlSheet';
import { disconnectAllBluetooth } from '../../lib/ble/bluetooth-status-store';
import { GlassSheetBackground } from '../GlassSheetBackground';
import { Icon } from '../Icon';
import { useIsPartyPreviewOnly, usePlaylistSuggestionSource, useQueue } from '../../providers/queue-provider';
import { useOptionalBluetoothContext } from '../../providers/bluetooth-provider';
import { useToast } from '../../providers/toast-provider';
import { useToggleFavorite, useFavoriteStatus } from '../../lib/graphql/hooks';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { useShareClimb } from '../../hooks/use-share-climb';
import { getBoardRenderData } from '../../lib/board-details';
import { hapticSuccess } from '../../lib/haptics';
import { usePlayDrawerWakeLock } from './use-play-drawer-wake-lock';
import { useDeferredSheetOpen } from './use-deferred-sheet-open';
import { resolveFavoriteRollback } from './favorite-rollback';
import {
  buildPlayDrawerBoardLayout,
  derivePlayDrawerLightbulbPressAction,
  derivePlayDrawerLightbulbState,
  derivePlayDrawerPreviousDriver,
  resolvePlayDrawerWallControlQueueItem,
  shouldRestoreFailedTakeControlPreview,
} from './lightbulb-control';
import { usePreviewOnlyExitCleanup } from './use-preview-only-exit-cleanup';
import { useWallConfirmFallback } from './use-wall-confirm-fallback';
import { track } from '../../lib/analytics';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing, sheetStyles } from '../../theme/tokens';

type BoardConfig = {
  boardId?: number;
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
};

export type PlayDrawerOpenOptions = {
  /**
   * When `true` (default), the opened climb is dispatched through
   * `setCurrentClimb`, which both makes it the active climb and appends
   * it to the queue. Pass `false` when the drawer is being opened for a
   * climb that's already current (e.g. from the persistent queue bar),
   * to avoid duplicating that climb at the end of the queue — the queue
   * item wrapper carries a fresh uuid, so the reducer's idempotency
   * guards key off uuid and don't catch the duplicate.
   */
  setAsCurrent?: boolean;
  /**
   * Local-only playlist source for party non-driver previews. It drives drawer
   * next/previous suggestions without mutating the shared queue until the
   * lightbulb promotes the preview to wall control.
   */
  previewPlaylistSuggestionSource?: PlaylistSuggestionSource | null;
  /** Queue item to display locally without making it current. Used by
   * preview-only queue-sheet opens so navigation has the right queue anchor. */
  previewQueueItem?: ClimbQueueItem | null;
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
  { boardConfig, onAngleChange, isAngleAdjustable = true, onOpenQueue },
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
  const [isMirrored, setIsMirrored] = useState(false);
  // Local optimistic override for the heart. `null` means "no local change —
  // show the server's favorite status". A tap sets it optimistically, the
  // mutation's returned `favorited` confirms it, and a failure rolls it back.
  // Cleared on every climb change so the next climb shows its real status.
  const [favoriteOverride, setFavoriteOverride] = useState<boolean | null>(null);
  const [isTickBarActive, setIsTickBarActive] = useState(false);
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  const [activeSubDrawer, setActiveSubDrawer] = useState<ActiveSubDrawer>('none');
  const [bleControlOpen, setBleControlOpen] = useState(false);
  const [pendingClimbUuid, setPendingClimbUuid] = useState<string | null>(null);
  const [belowFoldContentRequested, setBelowFoldContentRequested] = useState(false);
  const wallControlPressOperationRef = useRef(0);
  const resetZoomRef = useRef<(() => void) | null>(null);

  // Beta Videos section-header height feeds the first-screen reserve so the
  // header teases at the bottom of the full-screen view (the cue that there's
  // more to scroll). Measured because it varies with locale / font scaling.
  const [betaHeaderHeight, setBetaHeaderHeight] = useState(0);
  const handleBetaHeaderLayout = useCallback((measured: number) => {
    setBetaHeaderHeight((prev) => (Math.abs(prev - measured) > 2 ? Math.round(measured) : prev));
  }, []);

  const {
    state,
    setCurrentClimb,
    nextClimb,
    previousClimb,
    sessionId,
    addToQueue,
    takeControl,
    releaseControl,
    driverParticipantId,
    participantId,
    lastConnectedBoardSerial,
  } = useQueue();
  const playlistSuggestionSource = usePlaylistSuggestionSource();
  const bluetooth = useOptionalBluetoothContext();
  const { mutate: toggleFavoriteMutate } = useToggleFavorite();
  const { formatGrade } = useGradeFormat();

  const { boardName, layoutId, sizeId, setIds, angle } = boardConfig;
  const bluetoothConnected = bluetooth?.isConnected ?? false;
  const bluetoothLoading = bluetooth?.loading ?? false;
  const bluetoothArmUndoWallChangeToast = bluetooth?.armUndoWallChangeToast;
  const bluetoothReassertWall = bluetooth?.reassertWall;
  const bluetoothClearBoard = bluetooth?.clearBoard;
  // Single source for "is a board's BLE available at all" so the lightbulb's
  // accessibility label and its press action stay in lockstep — both read this
  // instead of one checking `bluetooth` and the other `bluetooth !== null`.
  const hasBluetooth = bluetooth !== null;

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
  const displayedClimbUuidRef = useRef<string | null>(null);
  displayedClimbUuidRef.current = displayedClimb?.uuid ?? null;

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
  const lightbulbState = useMemo(
    () =>
      derivePlayDrawerLightbulbState({
        sessionId,
        driverParticipantId,
        participantId,
        isBluetoothConnected: bluetoothConnected,
        isBluetoothLoading: bluetoothLoading,
        pendingClimbUuid,
      }),
    [sessionId, driverParticipantId, participantId, bluetoothConnected, bluetoothLoading, pendingClimbUuid],
  );
  // Queue-mutation gating comes from the provider's roster-aware selector (a
  // solo occupant keeps full control); lightbulbState stays driver-based for
  // the wall-control press semantics only.
  const isPartyPreviewOnly = useIsPartyPreviewOnly();
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

  // When this client stops being preview-only (took control, or the session
  // ended), drop the drawer-local preview state: commits now go through the
  // provider, and a lingering drawerPreviewSuggestionSource would keep shadowing
  // the provider's source for displayed peeks while nextClimb() commits against
  // the provider source. Transition-gated (true→false only) so entering preview
  // mode or mounting never clears a fresh preview. Safe for the lightbulb flow:
  // handleLightbulb reads drawerPreviewSuggestionSource synchronously at press
  // time and hands it to takeControl before the driver flip lands here.
  usePreviewOnlyExitCleanup(isPartyPreviewOnly, () => {
    setDrawerPreviewItem(null);
    setDrawerPreviewSuggestionSource(null);
  });

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

  const bluetoothConnect = useCallback(
    (frames?: string, mirrored?: boolean, targetSerial?: string) =>
      bluetooth?.connect(frames, mirrored, targetSerial) ?? Promise.resolve(false),
    [bluetooth],
  );

  const handleWallConfirmed = useCallback((info: { climbUuid: string }) => {
    setPendingClimbUuid((currentClimbUuid) => (currentClimbUuid === info.climbUuid ? null : currentClimbUuid));
  }, []);
  const handleWallConfirmTimeout = useCallback((info: { climbUuid: string }) => {
    setPendingClimbUuid((currentClimbUuid) => (currentClimbUuid === info.climbUuid ? null : currentClimbUuid));
  }, []);
  const { armWatcher: armWallConfirmWatcher, cancelWatcher: cancelWallConfirmWatcher } = useWallConfirmFallback(
    {
      sessionId,
      isBluetoothConnected: bluetoothConnected,
      isBluetoothSupported: bluetooth !== null,
      lastConnectedBoardSerial,
      isPersistentSessionActive: lightbulbState.isPersistentSessionActive,
      bluetoothConnect,
    },
    { onConfirmed: handleWallConfirmed, onTimeout: handleWallConfirmTimeout },
  );

  const cancelPendingWallControlAttempt = useCallback(() => {
    wallControlPressOperationRef.current += 1;
    cancelWallConfirmWatcher();
    setPendingClimbUuid(null);
  }, [cancelWallConfirmWatcher]);

  const pendingSessionIdRef = useRef(sessionId);
  useEffect(() => {
    const didSessionChange = pendingSessionIdRef.current !== sessionId;
    pendingSessionIdRef.current = sessionId;
    if (pendingClimbUuid !== null && (!lightbulbState.isPersistentSessionActive || didSessionChange)) {
      cancelPendingWallControlAttempt();
    }
  }, [cancelPendingWallControlAttempt, lightbulbState.isPersistentSessionActive, pendingClimbUuid, sessionId]);

  const openDrawer = useCallback(
    (selectedClimb: Climb, options?: PlayDrawerOpenOptions) => {
      cancelPendingWallControlAttempt();
      const previewPlaylistSuggestionSource = options?.previewPlaylistSuggestionSource ?? null;
      const shouldShowCurrentQueueItem =
        options?.setAsCurrent === false &&
        options.previewQueueItem == null &&
        previewPlaylistSuggestionSource === null &&
        state.currentClimbQueueItem?.climb.uuid === selectedClimb.uuid;
      const selectedItem = shouldShowCurrentQueueItem
        ? null
        : (options?.previewQueueItem ??
          climbToQueueItem(selectedClimb, { suggested: previewPlaylistSuggestionSource !== null }));
      setDrawerPreviewSuggestionSource(previewPlaylistSuggestionSource);
      setDrawerPreviewItem(selectedItem);
      setIsMirrored(false);
      // Drop any stale optimistic heart so the opened climb shows its real
      // (server) favorite status rather than a leftover from the last climb.
      setFavoriteOverride(null);
      setIsTickBarActive(false);
      setIsSheetOpen(true);
      setActiveSubDrawer('none');
      if (selectedItem && (options?.setAsCurrent ?? true) && !isPartyPreviewOnly) {
        // Fresh activation from the list/search clears any playlist suggestion
        // source (web passes the same null option on every non-playlist set).
        setCurrentClimb(selectedItem, { playlistSuggestionSource: null });
      }
      sheetRef.current?.present();
    },
    [cancelPendingWallControlAttempt, state.currentClimbQueueItem, isPartyPreviewOnly, setCurrentClimb],
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
    cancelPendingWallControlAttempt();
    setDrawerPreviewItem(null);
    setDrawerPreviewSuggestionSource(null);
    setIsMirrored(false);
    setIsTickBarActive(false);
    setIsSheetOpen(false);
    setActiveSubDrawer('none');
    // Replay an open() that arrived while this dismissal was animating — the
    // modal is now fully dismissed, so the re-present is clean.
    flushOnDismiss();
  }, [cancelPendingWallControlAttempt, flushOnDismiss]);

  const handlePrev = useCallback(() => {
    cancelPendingWallControlAttempt();
    if (isPartyPreviewOnly) {
      if (navigationState.prevItem) {
        setDrawerPreviewItem(navigationState.prevItem);
      }
    } else {
      setDrawerPreviewItem(null);
      previousClimb();
    }
    setIsMirrored(false);
    // The favorite override is cleared by the climb-change effect.
  }, [cancelPendingWallControlAttempt, isPartyPreviewOnly, navigationState.prevItem, previousClimb]);

  const handleNext = useCallback(() => {
    cancelPendingWallControlAttempt();
    if (isPartyPreviewOnly) {
      if (navigationState.nextItem) {
        setDrawerPreviewItem(navigationState.nextItem);
      }
    } else {
      setDrawerPreviewItem(null);
      nextClimb();
    }
    setIsMirrored(false);
    // The favorite override is cleared by the climb-change effect.
  }, [cancelPendingWallControlAttempt, isPartyPreviewOnly, navigationState.nextItem, nextClimb]);

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

  const handleLightbulb = useCallback(() => {
    const pressAction = derivePlayDrawerLightbulbPressAction({
      hasBluetooth,
      hasDisplayedClimb: displayedClimb !== null,
      isPersistentSessionActive: lightbulbState.isPersistentSessionActive,
      isDriver: lightbulbState.isDriver,
      isBluetoothConnected: bluetoothConnected,
    });
    if (pressAction === 'noop') return;

    const previousDriver = derivePlayDrawerPreviousDriver({ driverParticipantId, participantId });

    if (pressAction === 'release_party') {
      wallControlPressOperationRef.current += 1;
      cancelWallConfirmWatcher();
      setPendingClimbUuid(null);
      void releaseControl()
        .then(() => {
          track('Wall Control Released', {
            reason: 'manual',
            mode: 'party',
            boardLayout,
          });
        })
        .catch((error: unknown) => {
          console.error('[playDrawer] failed to release wall control:', error);
        });
      return;
    }

    if (pressAction === 'reconnect_ble') {
      if (!bluetooth) return;
      // Ignore taps while a connect is already in flight, matching the climbs-list
      // lightbulb (use-lightbulb-toggle.ts). The connect() in-flight ref also guards,
      // but bailing here avoids a misleading haptic and a dead tap.
      if (bluetoothLoading) return;
      // Party driver whose BLE link was stolen — reconnect to the remembered board
      // without releasing wall control, so it relights in one tap. No control
      // changes hands here, and connect() already emits BluetoothConnectionSuccess,
      // so we don't fire 'Wall Control Taken' (which would inflate party-take counts).
      bluetooth.armUndoWallChangeToast();
      void bluetooth.connect(undefined, undefined, bluetooth.reconnectSerialForCurrentBoard ?? undefined);
      return;
    }

    if (pressAction === 'connect_solo') {
      if (!bluetooth) return;
      track('Wall Control Taken', {
        source: 'lightbulb_drawer',
        previousDriver,
        mode: 'solo',
        boardLayout,
        climbUuid: displayedClimb?.uuid ?? null,
      });
      const reconnectSerialForBoard = bluetooth.reconnectSerialForCurrentBoard;
      bluetooth.armUndoWallChangeToast();
      if (reconnectSerialForBoard) {
        void bluetooth.connect(undefined, undefined, reconnectSerialForBoard);
      } else {
        void bluetooth.connect();
      }
      return;
    }

    if (!displayedClimb) return;

    if (pressAction === 'reassert_solo') {
      if (!bluetooth) return;
      // Already connected — re-light the current climb. Re-tapping the lightbulb
      // re-pushes the wall (and trips disconnect detection if the link is dead).
      bluetooth.armUndoWallChangeToast();
      bluetooth.reassertWall();
      setDrawerPreviewItem(null);
      track('Wall Control Taken', {
        source: 'lightbulb_drawer',
        previousDriver,
        mode: 'solo',
        boardLayout,
        climbUuid: displayedClimb.uuid,
      });
      return;
    }

    const queueItem = resolvePlayDrawerWallControlQueueItem({
      displayedQueueItem,
      displayedClimb,
      createQueueItem: (queueItemClimb, options) =>
        climbToQueueItem(queueItemClimb as unknown as Parameters<typeof climbToQueueItem>[0], options),
    });
    const operationId = wallControlPressOperationRef.current + 1;
    wallControlPressOperationRef.current = operationId;
    setDrawerPreviewItem(null);
    setPendingClimbUuid(displayedClimb.uuid);
    bluetooth?.armUndoWallChangeToast();
    const takeControlOptions = drawerPreviewSuggestionSource
      ? { playlistSuggestionSource: drawerPreviewSuggestionSource }
      : undefined;
    void takeControl(queueItem, takeControlOptions)
      .then(() => {
        track('Wall Control Taken', {
          source: 'lightbulb_drawer',
          previousDriver,
          mode: 'party',
          boardLayout,
          climbUuid: displayedClimb.uuid,
        });
      })
      .catch((error: unknown) => {
        const shouldHandleFailure = wallControlPressOperationRef.current === operationId;
        if (!shouldHandleFailure) return;
        console.error('[playDrawer] failed to take wall control:', error);
        cancelWallConfirmWatcher();
        setPendingClimbUuid((currentClimbUuid) => (currentClimbUuid === displayedClimb.uuid ? null : currentClimbUuid));
        if (
          shouldRestoreFailedTakeControlPreview({
            failedOperationId: operationId,
            latestOperationId: wallControlPressOperationRef.current,
            failedClimbUuid: displayedClimb.uuid,
            displayedClimbUuid: displayedClimbUuidRef.current,
          })
        ) {
          setDrawerPreviewItem((currentItem) => currentItem ?? queueItem);
          // The optimistic driver flip cleared the drawer-local suggestion
          // source (preview-only → driver transition effect above); the
          // rollback restores preview-only, so restore the at-press source
          // alongside the preview item to keep playlist peeks working.
          if (drawerPreviewSuggestionSource) {
            setDrawerPreviewSuggestionSource((currentSource) => currentSource ?? drawerPreviewSuggestionSource);
          }
        }
      });
    armWallConfirmWatcher({
      climbUuid: displayedClimb.uuid,
      mode: 'party',
      boardLayout,
    });
  }, [
    bluetooth,
    hasBluetooth,
    bluetoothLoading,
    driverParticipantId,
    participantId,
    lightbulbState.isPersistentSessionActive,
    lightbulbState.isDriver,
    cancelWallConfirmWatcher,
    releaseControl,
    boardLayout,
    bluetoothConnected,
    displayedClimb,
    displayedQueueItem,
    takeControl,
    drawerPreviewSuggestionSource,
    armWallConfirmWatcher,
  ]);

  const handleLightbulbLongPress = useCallback(() => {
    if (!bluetooth?.isConnected) return;
    // Reveal the BLE controls (Re-light / Disconnect) rather than disconnecting
    // blind — keeps the destructive action behind a labelled menu.
    setBleControlOpen(true);
  }, [bluetooth]);

  const handleBleReassert = useCallback(() => {
    bluetoothArmUndoWallChangeToast?.();
    bluetoothReassertWall?.();
  }, [bluetoothArmUndoWallChangeToast, bluetoothReassertWall]);

  const handleBleClearLights = useCallback(() => {
    void bluetoothClearBoard?.();
  }, [bluetoothClearBoard]);

  const handleBleControlClose = useCallback(() => {
    setBleControlOpen(false);
  }, []);

  // Close the BLE controls sheet if the link drops while it's open — otherwise
  // it lingers showing Re-light / Disconnect actions that no-op on a dead link.
  useEffect(() => {
    if (!bluetoothConnected) setBleControlOpen(false);
  }, [bluetoothConnected]);

  const handleOpenActions = useCallback(() => {
    setActiveSubDrawer('actions');
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
      cancelPendingWallControlAttempt();
      const queueItem = climbToQueueItem(similarClimb);
      setDrawerPreviewItem(queueItem);
      setDrawerPreviewSuggestionSource(null);
      setIsMirrored(false);
      // The favorite override is cleared by the climb-change effect.
      setIsTickBarActive(false);
      if (isPartyPreviewOnly) return;
      addToQueue(queueItem);
      setCurrentClimb(queueItem, { playlistSuggestionSource: null });
    },
    [addToQueue, cancelPendingWallControlAttempt, isPartyPreviewOnly, setCurrentClimb],
  );

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.5} />
    ),
    [],
  );

  // Glass background with squared-off top corners so the sheet reads as a
  // full-screen takeover, not a rounded panel.
  const renderBackground = useCallback(
    (props: BottomSheetBackgroundProps) => <GlassSheetBackground {...props} flatTop />,
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
  const lightbulbAccessibilityLabel = useMemo(() => {
    if (!lightbulbState.isPersistentSessionActive) return undefined;
    if (lightbulbState.isDriver) {
      // Still the driver but the board link dropped — the tap reconnects, not
      // releases, so the label must match (see derivePlayDrawerLightbulbPressAction,
      // which keys the reconnect action off this same hasBluetooth condition).
      if (hasBluetooth && !bluetoothConnected) return t('playView.actionBar.lightbulb.reconnect');
      if (!displayedClimb) return t('playView.actionBar.lightbulb.driving');
      return t('playView.actionBar.lightbulb.drivingNamed', { name: displayedClimb.name });
    }
    if (!displayedClimb) return t('playView.actionBar.lightbulb.take');
    return t('playView.actionBar.lightbulb.takeNamed', { name: displayedClimb.name });
  }, [
    displayedClimb,
    lightbulbState.isDriver,
    lightbulbState.isPersistentSessionActive,
    hasBluetooth,
    bluetoothConnected,
    t,
  ]);

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
                />

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
                  lightbulbActive={lightbulbState.lightbulbActive}
                  lightbulbPending={lightbulbState.lightbulbPending}
                  lightbulbAccessibilityLabel={lightbulbAccessibilityLabel}
                  lightbulbLongPressEnabled={bluetoothConnected}
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
              />
            </>
          )}
        </BottomSheetScrollView>
      </BottomSheetModal>

      {/* Sub-drawer: Climb actions. Always mounted and toggled via `visible`
          (it presents as a BottomSheetModal with stackBehavior=push, the only
          way to render above the play drawer's own modal — same as the angle
          selector and tick sheet). A conditionally-mounted modal here would drop
          its present() over the already-open play drawer and never appear. */}
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
        onClose={handleCloseSubDrawer}
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
          boardId={boardConfig.boardId}
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

      {/* BLE controls revealed by long-pressing the lightbulb. */}
      {bluetooth && (
        <BleControlSheet
          visible={bleControlOpen}
          onReassert={handleBleReassert}
          onClearLights={handleBleClearLights}
          supportsClearLights={boardName !== 'moonboard'}
          onDisconnect={disconnectAllBluetooth}
          onClose={handleBleControlClose}
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
});
