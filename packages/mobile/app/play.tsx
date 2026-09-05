import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import type { BoardName } from '@boardsesh/shared-schema';
import { GlassSurface } from '../src/components/GlassSurface';
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
import type { Climb } from '@boardsesh/shared-schema';
import { dismissManagedSheetAndWait, type DismissAndWaitResult } from '../src/providers/sheet-presentation-provider';

/**
 * Full-screen "now playing" player route (`presentation: 'fullScreenModal'`,
 * registered in app/_layout.tsx). Replaces the old FullWindowOverlay: as a real
 * modal view controller, everything presented from inside its React tree — the
 * sub-drawers, the share sheet, and this route's own QueueSheet — stacks ABOVE
 * it instead of behind it.
 *
 * Open latency: the native modal present can't start until React commits this
 * route's first frame. PlayDrawer's mount is heavy (board geometry + a stack of
 * hooks), and the old overlay hid that by running its slide on the UI thread
 * (reanimated) while content filled in. To restore the instant-start feel, the
 * first frame paints ONLY the full-screen GlassSurface (cheap), so the present
 * begins immediately; PlayDrawer + the QueueSheet mount one frame later and fill
 * in mid-slide (the present runs natively, off the JS thread). A deterministic
 * rAF gate (not InteractionManager, which waits out the whole present and is
 * disabled in screenshot mode) keeps this screenshot-safe.
 *
 * The host (DrawerHostProvider) owns the open target + board override and exposes
 * them via usePlayDrawerRoute; this route runs the host's close-reset on unmount.
 * It hosts its OWN QueueSheet instance (the host keeps one for the closed-player
 * snackbar path) so the queue stacks over the player — both share queue state via
 * QueueProvider and never present at once.
 */
export default function PlayScreen() {
  const {
    activeBoardConfig,
    isAngleAdjustable,
    boardMismatch,
    mismatchBoardLabel,
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

  const queueSheetRef = useRef<QueueSheetHandle>(null);
  const presentQueue = useCallback(() => queueSheetRef.current?.present(), []);
  const requestCloseQueue = useCallback(() => queueSheetRef.current?.dismiss(), []);
  const dismissQueueAndWait = useCallback((): Promise<DismissAndWaitResult> => {
    return dismissManagedSheetAndWait(queueSheetRef.current);
  }, []);
  const dismissPlayerAndWait = usePlayerDismissAndWait();
  // Any actions menu opened from this route receives the route-owned transition
  // waiter. That includes the root FullWindowOverlay and the route's QueueSheet;
  // neither can safely discover the native-stack navigation object itself.
  const openPlayerClimbActions = useCallback(
    (climb: Climb, boardConfigOverride?: BoardConfig, options?: OpenClimbActionsOptions) => {
      openClimbActions(climb, boardConfigOverride, { ...options, dismissPlayerAndWait });
    },
    [openClimbActions, dismissPlayerAndWait],
  );

  // Paint the glass first, mount the heavy player content one frame later so the
  // native present starts immediately (see the file comment). rAF fires before
  // the next paint, so PlayDrawer renders into the slide that's already running.
  const [contentMounted, setContentMounted] = useState(false);
  useEffect(() => {
    const handle = requestAnimationFrame(() => setContentMounted(true));
    return () => cancelAnimationFrame(handle);
  }, []);

  // Drop the board override + open target when the route unmounts (any dismiss:
  // chevron, swipe, back, or programmatic). A ref calls the latest callback
  // without re-running the unmount effect.
  const onClosedRef = useRef(onPlayDrawerClosed);
  onClosedRef.current = onPlayDrawerClosed;
  useEffect(() => () => onClosedRef.current(), []);

  // Tell the host which target this route has actually applied. The close above
  // is only allowed to clear that one — a target written by a tap that landed
  // during the dismiss window never reaches this effect (the route is already
  // unmounting), so it survives and the next mount serves the tap instead of
  // swallowing it. Runs in the same commit as PlayDrawer's own apply effect.
  const onTargetConsumedRef = useRef(onPlayDrawerTargetConsumed);
  onTargetConsumedRef.current = onPlayDrawerTargetConsumed;
  const playTargetNonce = playTarget?.nonce;
  useEffect(() => {
    if (playTargetNonce == null) return;
    onTargetConsumedRef.current(playTargetNonce);
  }, [playTargetNonce]);

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

  return (
    <View style={styles.root}>
      {/* Opaque backstop. The player is a transparentModal, so the live tabs
          screen sits behind it — paint a solid background under the glass so the
          Climbs list doesn't show through the translucent GlassSurface. */}
      <View style={[StyleSheet.absoluteFill, { backgroundColor: systemColors.secondaryBackground }]} />
      {/* Edge-to-edge glass/material background with NO radius — full-screen, not
          a card. Rendered on the first frame so the present animates over it.
          GlassSurface resolves Liquid Glass / blur / Material / Reduce-
          Transparency-solid per device.

          `level0` and `pointerEvents="none"` are load-bearing, not cosmetic. This
          surface is a BACKGROUND with the player stacked on top as a sibling, and
          Android orders siblings by Z: GlassSurface's Material branch otherwise
          defaults to `shadows.sm` (elevation 2), which lifts the full-screen fill
          above the elevation-0 PlayDrawer and paints over the whole player — the
          drawer opened showing nothing but its own tint (#4209). A background also
          has no business taking touches. */}
      <GlassSurface
        style={StyleSheet.absoluteFill}
        glassEffectStyle="regular"
        role="low"
        level="level0"
        pointerEvents="none"
        fallbackColor={systemColors.secondaryBackground}
        tintColor={playDrawerMaterialTint[colorScheme]}
      />
      {contentMounted && activeBoardConfig ? (
        <>
          <PlayDrawer
            boardConfig={activeBoardConfig}
            onAngleChange={onAngleChange}
            isAngleAdjustable={isAngleAdjustable}
            onOpenQueue={presentQueue}
            boardMismatch={boardMismatch}
            mismatchBoardLabel={mismatchBoardLabel}
            onSwitchBoard={onSwitchBoard}
            onOpenClimbActions={openPlayerClimbActions}
            dismissPlayerAndWait={dismissPlayerAndWait}
            openTarget={playTarget}
          />
          {queueBoard ? (
            <QueueSheet
              ref={queueSheetRef}
              board={queueBoard}
              onClose={requestCloseQueue}
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
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
});
