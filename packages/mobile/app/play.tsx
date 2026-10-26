import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, StyleSheet, useWindowDimensions } from 'react-native';
import Animated from 'react-native-reanimated';
import { Link, router } from 'expo-router';
import type { BoardName } from '@boardsesh/shared-schema';
import { ScreenBackground } from '../src/components/ScreenBackground';
import { PlayDrawer } from '../src/components/play-drawer';
import { QueueSheet, type QueueSheetHandle } from '../src/components/play-drawer/QueueSheet';
import { DevicePickerSheetHost } from '../src/components/ble/DevicePickerSheetHost';
import { useQueueSheetHandlers } from '../src/components/play-drawer/use-queue-sheet-handlers';
import type { QueueItemRowBoard } from '../src/components/QueueItemRow';
import {
  useDrawerHost,
  usePlayDrawerRoute,
  type BoardConfig,
  type OpenClimbActionsOptions,
} from '../src/providers/drawer-host-provider';
import { useQueueActions, useQueueSessionControls } from '../src/providers/queue-provider';
import { useTheme } from '../src/providers/theme-provider';
import { playDrawerMaterialTint } from '../src/theme/colors';
import { usePlayerDismissAndWait } from '../src/components/create-climb/use-player-dismiss-and-wait';
import { usePlaySwipeDismiss } from '../src/components/play-drawer/use-play-swipe-dismiss';
import type { Climb } from '@boardsesh/shared-schema';
import { dismissManagedSheetAndWait, type DismissAndWaitResult } from '../src/providers/sheet-presentation-provider';
import { holdUntilLaunchReady } from '../src/components/launch-update/hold-until-launch-ready';
import { useReportRoutePlayerBusy } from '../src/components/play-drawer/route-player-handoff';
import { useBlePickerHost } from '../src/providers/ble-picker-host';
import { resolvePlayerArrangement } from '../src/components/play-drawer/play-drawer-layout';
import { PlayerSidePanel, type PlayerSidePanelSegment } from '../src/components/play-drawer/PlayerSidePanel';
import type { PlayerSidePanelClimb } from '../src/components/play-drawer/play-drawer-types';

// The side panel's queue has no sheet to fold away and nothing to wait on.
const keepPanelOpen = () => {};
const panelDismissed = () => dismissManagedSheetAndWait(null);
const openBoardSwitcher = () => router.push('/boards');

/**
 * Full-screen "now playing" player route (`presentation: 'transparentModal'`,
 * registered in app/_layout.tsx). Replaces the old FullWindowOverlay: as a real
 * modal view controller, everything presented from inside its React tree — the
 * sub-drawers, the share sheet, and this route's own QueueSheet — stacks ABOVE
 * it instead of behind it.
 *
 * The first commit mounts the current board and its gestures. PlayCore keeps
 * list walks and below-fold requests behind that first paint; cached artwork
 * never waits for a background-only frame or a second board-layout mount.
 *
 * The host (DrawerHostProvider) owns the open target + board override and exposes
 * them via usePlayDrawerRoute; this route runs the host's close-reset on unmount.
 * It hosts its OWN QueueSheet instance (the host keeps one for the closed-player
 * snackbar path) so the queue stacks over the player — both share queue state via
 * QueueProvider and never present at once.
 */
function PlayScreen() {
  const {
    activeBoardConfig,
    isAngleAdjustable,
    boardMismatch,
    mismatchBoardLabel,
    reachableBoardKeys,
    onAngleChange,
    onSwitchBoard,
    onPlayDrawerClosed,
    onPlayDrawerTargetConsumed,
    playTarget,
  } = usePlayDrawerRoute();
  const { boardConfig: storedBoardConfig, openPlayDrawer, openClimbActions, openLogAscent } = useDrawerHost();
  const { setCurrentClimb } = useQueueActions();
  const { sessionId } = useQueueSessionControls();
  const { systemColors, colorScheme } = useTheme();
  const { swipeDismiss, animatedStyle, onLayout, close, canConsumeTarget, dismissAndWait } = usePlaySwipeDismiss(
    playTarget?.nonce,
  );

  // Landscape iPad: the board on the left, Up next / Logbook / Beta on the right.
  // The native iPad's only (the Music layout); Android tablets and the browser
  // build keep the stacked player.
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const isNativeIpad = Platform.OS === 'ios' && Platform.isPad;
  const sideBySide =
    resolvePlayerArrangement({ width: windowWidth, height: windowHeight, isTablet: isNativeIpad }) === 'sideBySide';
  // Every open starts on Up next, like Music's queue beside the artwork.
  const [panelSegment, setPanelSegment] = useState<PlayerSidePanelSegment>('upNext');

  const queueSheetRef = useRef<QueueSheetHandle>(null);
  const [mountQueue, setMountQueue] = useState(false);
  const pendingQueuePresentation = useRef(false);
  // Up from present until the dismiss settles. With the Bluetooth picker this
  // route hosts, it tells the phone split (iPhone Duo opened into landscape) to
  // wait before closing this route for its pane (route-player-handoff).
  const [queueSheetUp, setQueueSheetUp] = useState(false);
  const handleQueueDismissed = useCallback(() => setQueueSheetUp(false), []);
  const presentQueue = useCallback(() => {
    setQueueSheetUp(true);
    if (queueSheetRef.current) queueSheetRef.current.present();
    else {
      pendingQueuePresentation.current = true;
      setMountQueue(true);
    }
  }, []);
  useEffect(() => {
    if (!mountQueue || !queueSheetRef.current || !pendingQueuePresentation.current) return;
    pendingQueuePresentation.current = false;
    queueSheetRef.current.present();
  }, [mountQueue]);
  // With Up next already beside the board, the queue button picks that segment
  // instead of stacking a second copy of the queue over the player.
  const openQueue = useCallback(() => {
    if (sideBySide) setPanelSegment('upNext');
    else presentQueue();
  }, [sideBySide, presentQueue]);
  const requestCloseQueue = useCallback(() => queueSheetRef.current?.dismiss(), []);
  const dismissQueueAndWait = useCallback((): Promise<DismissAndWaitResult> => {
    return dismissManagedSheetAndWait(queueSheetRef.current);
  }, []);
  const waitForPlayerDismiss = usePlayerDismissAndWait();
  const dismissPlayerAndWait = useCallback(
    () => dismissAndWait(waitForPlayerDismiss),
    [dismissAndWait, waitForPlayerDismiss],
  );
  // A reaction menu opened from this route's QueueSheet (a row long-press)
  // receives the route-owned transition waiter: the root FullWindowOverlay can't
  // safely discover the native-stack navigation object itself. The player's own
  // ⋯ is a native menu inside PlayDrawer and needs none of this.
  const openPlayerClimbActions = useCallback(
    (climb: Climb, boardConfigOverride?: BoardConfig, options?: OpenClimbActionsOptions) => {
      openClimbActions(climb, boardConfigOverride, { ...options, dismissPlayerAndWait });
    },
    [openClimbActions, dismissPlayerAndWait],
  );

  // Drop the board override + open target when the route unmounts (any dismiss:
  // chevron, swipe, back, or programmatic). A ref calls the latest callback
  // without re-running the unmount effect.
  const onClosedRef = useRef(onPlayDrawerClosed);
  onClosedRef.current = onPlayDrawerClosed;
  const consumedTargetNonceRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      const consumedNonce = consumedTargetNonceRef.current;
      onClosedRef.current(consumedNonce);
    },
    [],
  );

  // Tell the host which target this route has actually applied. The close above
  // is only allowed to clear that one — a target written by a tap that landed
  // during the dismiss window never reaches this effect (the route is already
  // unmounting), so it survives and the next mount serves the tap instead of
  // swallowing it. Runs in the same commit as PlayDrawer's own apply effect.
  const onTargetConsumedRef = useRef(onPlayDrawerTargetConsumed);
  onTargetConsumedRef.current = onPlayDrawerTargetConsumed;
  const playTargetNonce = playTarget?.nonce;
  useEffect(() => {
    if (
      playTargetNonce == null ||
      playTargetNonce === consumedTargetNonceRef.current ||
      !canConsumeTarget(playTargetNonce)
    )
      return;
    consumedTargetNonceRef.current = playTargetNonce;
    onTargetConsumedRef.current(playTargetNonce);
  }, [playTargetNonce, canConsumeTarget]);

  // The queue renders climbs against the stored active board (thumbnails + tick),
  // same as the host's instance.
  const queueBoard = useMemo<QueueItemRowBoard | null>(() => {
    if (!storedBoardConfig) return null;
    return {
      boardName: storedBoardConfig.boardName as BoardName,
      layoutId: storedBoardConfig.layoutId,
      sizeId: storedBoardConfig.sizeId,
      setIds: storedBoardConfig.setIds,
      angle: storedBoardConfig.angle,
    };
  }, [storedBoardConfig]);

  const { handleClimbPress, handleOpenActions, handleSuggestionPress, handleTickHistory } = useQueueSheetHandlers({
    setCurrentClimb,
    openPlayDrawer,
    openClimbActions: openPlayerClimbActions,
    openLogAscent,
    storedBoardConfig,
    sessionId,
    requestCloseQueueSheet: requestCloseQueue,
    dismissQueueSheetAndWait: dismissQueueAndWait,
  });
  const {
    handleClimbPress: handlePanelClimbPress,
    handleOpenActions: handlePanelOpenActions,
    handleSuggestionPress: handlePanelSuggestionPress,
    handleTickHistory: handlePanelTickHistory,
  } = useQueueSheetHandlers({
    setCurrentClimb,
    openPlayDrawer,
    openClimbActions: openPlayerClimbActions,
    openLogAscent,
    storedBoardConfig,
    sessionId,
    requestCloseQueueSheet: keepPanelOpen,
    dismissQueueSheetAndWait: panelDismissed,
  });
  const renderSidePanel = useCallback(
    (displayed: PlayerSidePanelClimb | null) => (
      <PlayerSidePanel
        displayed={displayed}
        segment={panelSegment}
        onSegmentChange={setPanelSegment}
        queueBoard={queueBoard}
        onSwitchBoard={openBoardSwitcher}
        onClimbPress={handlePanelClimbPress}
        onOpenActions={handlePanelOpenActions}
        onSuggestionPress={handlePanelSuggestionPress}
        onTickHistory={handlePanelTickHistory}
      />
    ),
    [
      panelSegment,
      queueBoard,
      handlePanelClimbPress,
      handlePanelOpenActions,
      handlePanelSuggestionPress,
      handlePanelTickHistory,
    ],
  );

  return (
    <Link.AppleZoomTarget>
      <Animated.View style={[styles.root, animatedStyle]} onLayout={onLayout}>
        {/* Opaque background. The player is a transparentModal, so the live tabs
          screen sits behind it and must not show through. On Liquid Glass it is
          plain secondarySystemBackground: HIG Materials keeps glass on the
          controls layer, not under the player's content. Material and Reduce
          Transparency keep their opaque tonal surface — see ScreenBackground,
          which also owns why that fill stays `level0` and untouchable (#4209).
          Rendered on the first frame so the present animates over it. */}
        <ScreenBackground
          color={systemColors.secondaryBackground}
          role="low"
          fallbackColor={systemColors.secondaryBackground}
          tintColor={playDrawerMaterialTint[colorScheme]}
        />
        {activeBoardConfig ? (
          <>
            <PlayDrawer
              swipeDismiss={swipeDismiss}
              onClose={close}
              boardConfig={activeBoardConfig}
              onAngleChange={onAngleChange}
              isAngleAdjustable={isAngleAdjustable}
              onOpenQueue={openQueue}
              boardMismatch={boardMismatch}
              reachableBoardKeys={reachableBoardKeys}
              mismatchBoardLabel={mismatchBoardLabel}
              onSwitchBoard={onSwitchBoard}
              dismissPlayerAndWait={dismissPlayerAndWait}
              openTarget={playTarget}
              fitBoardToHeight={sideBySide}
              renderSidePanel={sideBySide ? renderSidePanel : undefined}
            />
            {mountQueue && queueBoard ? (
              <QueueSheet
                ref={queueSheetRef}
                board={queueBoard}
                onClose={requestCloseQueue}
                onDismissed={handleQueueDismissed}
                onClimbPress={handleClimbPress}
                onOpenActions={handleOpenActions}
                onSuggestionPress={handleSuggestionPress}
                onTickHistory={handleTickHistory}
              />
            ) : null}
          </>
        ) : null}
        {/* Host the BLE device picker from inside this route so a connect from the
          player's lightbulb (when disconnected) presents OVER the player. Claims
          the picker, suppressing the app-root instance while mounted. */}
        <DevicePickerSheetHost registerExternal />
        <RouteSheetsBusyReporter queueSheetUp={queueSheetUp} />
      </Animated.View>
    </Link.AppleZoomTarget>
  );
}

/**
 * Reports this route busy while its queue sheet or its Bluetooth device picker
 * is up. A component of its own so the picker's updates while it scans re-render
 * only this, never the player.
 */
function RouteSheetsBusyReporter({ queueSheetUp }: { queueSheetUp: boolean }) {
  const { pickerState } = useBlePickerHost();
  useReportRoutePlayerBusy('route', queueSheetUp || pickerState != null);
  return null;
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
});

// iOS presents this route as a native modal, above the launch update
// placeholder, and a URL can open it on a cold start. Held until launch is
// ready so a gate reload cannot land mid-tap (#6006).
export default holdUntilLaunchReady(PlayScreen);
