import React, { useEffect, useImperativeHandle, useMemo, useRef, type ReactNode, type RefObject } from 'react';
import { View, StyleSheet, PixelRatio } from 'react-native';
import Animated from 'react-native-reanimated';
import { GestureDetector, GestureHandlerRootView, type GestureType } from 'react-native-gesture-handler';
import type { BoardName, LitUpHoldsMap } from '@boardsesh/shared-schema';
import { BoardImageNative } from '../BoardImageNative';
import { ResetZoomButton } from '../board-controls/ResetZoomButton';
import { useZoomPanGesture } from '../play-drawer/use-zoom-pan-gesture';
import { spacing } from '../../theme/tokens';
import { EDITING_VEIL_OPACITY } from '../../lib/board-render-settings';
import type { BoardHoldTarget } from '../../lib/create-board-holds';
import { HoldMarkerLayer } from './HoldMarkerLayer';
import { HoldTargetLayer } from './HoldTargetLayer';
import { PaintedHoldsLayer } from './PaintedHoldsLayer';
import { buildHoldHitTargets } from './holdLayout';
import { useZoomedHoldTapGesture, PAN_ACTIVATION_OFFSET } from './use-zoomed-hold-tap-gesture';

/** Imperative handle on the board's zoom, mirroring `FilterBoardControls`. */
export type CreateBoardControls = {
  resetZoom: () => void;
};

type InteractiveCreateBoardProps = {
  /**
   * The active frame as an absolute Aurora frames string. The renderer draws the
   * painted holds from this — the same drawing the play view uses — so it changes
   * on every paint.
   */
  frames: string;
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
  boardWidth: number;
  boardHeight: number;
  holdTargets: BoardHoldTarget[];
  litUpHoldsMap: LitUpHoldsMap;
  onPaint: (holdId: number) => void;
  onLongPressHold: (holdId: number) => void;
  mirrored?: boolean;
  showAllHolds?: boolean;
  /** Exact on-screen board size, computed by the drawer up front so the board
   *  renders immediately (no onLayout round-trip while the sheet animates in). */
  renderWidth: number;
  renderHeight: number;
  /** Optional overlay (e.g. heatmap) drawn between the board photo and the holds. */
  overlay?: ReactNode;
  /** Lets the drawer reset the zoom — both from its own chrome and on frame change. */
  controlRef?: RefObject<CreateBoardControls | null>;
  /** Fires whenever the board is zoomed or mid-pinch. The create drawer's sheet
   *  is an `@expo/ui` native bottom sheet (Jetpack Compose on Android, SwiftUI
   *  on iOS), not an RNGH surface — RNGH's gesture-relation APIs (the pinchRef
   *  simultaneity above) can't reach outside this board's own root, so nothing
   *  here stops the sheet's own drag gesture from grabbing a 2-finger pinch or
   *  a 1-finger pan-while-zoomed. The host uses this to disable that gesture
   *  for the duration (see CreateDrawer's enablePanDownToClose). */
  onInteractionActiveChange?: (active: boolean) => void;
};

/**
 * The no-SVG interactive board editor. The board and its painted holds come from
 * the same renderer the play view uses (BoardImageNative, fed the active frame),
 * so a climb looks the same while you build it as it will once it is saved — it
 * mirrors the climber's own Aura settings exactly (mark style, glow, fill) rather
 * than the small-surface `filledStyle`/thumbnail treatment, with one deliberate
 * exception: the veil is off here — the glow lands on an unwashed wall, so the
 * unlit holds you still have to find and tap stay readable. Tap targets are plain
 * RN Views placed INSIDE the zoom-transformed Animated.View, so RNGH hit-tests
 * them in board-local space and taps land correctly at any zoom level with zero
 * manual coordinate math.
 * PaintedHoldsLayer survives as the fallback for a build with no native renderer,
 * where no overlay ever arrives.
 *
 * Sized by the drawer (renderWidth/renderHeight) so it paints on the first frame.
 * Gesture model mirrors the Play Drawer's board: pinch is always live, but the
 * 1-finger zoom-pan only mounts while zoomed (a conditional overlay) so idle
 * vertical drags fall through to the BottomSheetScrollView and scroll/close the
 * drawer instead of being eaten here.
 *
 * Wrapped in its own GestureHandlerRootView: on Android, CreateDrawer's sheet
 * (`@expo/ui/community/bottom-sheet`) hosts its content inside a Jetpack Compose
 * `ModalBottomSheet` via a native `RNHostView` bridge — a separate surface the
 * app's single root-level GestureHandlerRootView (app/_layout.tsx) doesn't cover.
 * Without a nested root here, every per-hold Gesture.Tap()/LongPress() and the
 * pinch/pan gestures silently never receive touches on Android, so no hold can be
 * painted (#4320). RNGH's own docs call out nesting a root per-Modal for exactly
 * this reason; iOS isn't affected since its modal presentation doesn't split the
 * touch-dispatch tree the same way.
 */
export const InteractiveCreateBoard = React.memo(function InteractiveCreateBoard({
  frames,
  boardName,
  layoutId,
  sizeId,
  setIds,
  boardWidth,
  boardHeight,
  holdTargets,
  litUpHoldsMap,
  onPaint,
  onLongPressHold,
  mirrored = false,
  showAllHolds = false,
  renderWidth,
  renderHeight,
  overlay,
  controlRef,
  onInteractionActiveChange,
}: InteractiveCreateBoardProps) {
  // Shared with the per-hold detectors and the zoomed overlay so they mark
  // themselves simultaneous with the pinch — otherwise two fingers landing on
  // two hold targets each claim a pointer and pinch-to-zoom stalls on Android.
  const pinchRef = useRef<GestureType | undefined>(undefined);
  const {
    pinchGesture,
    zoomPanGesture,
    isZoomed,
    isPinching,
    isPinchingSV,
    scaleSV,
    translateXSV,
    translateYSV,
    containerWidthSV,
    containerHeightSV,
    resetZoom,
    animatedZoomStyle,
  } = useZoomPanGesture({
    enabled: true,
    containerWidth: renderWidth,
    containerHeight: renderHeight,
    panActivationOffset: PAN_ACTIVATION_OFFSET,
    pinchRef,
  });

  // Rasterize the holds overlay at the size it is actually displayed, not the
  // board's native ~1080px. Clamped to board width inside useNativeClimbRender
  // (never upscales), so on a 3x phone this is a no-op and on 2x devices it is a
  // real saving — which matters here, where every paint tap mints a new PNG.
  const overlayRenderWidth = useMemo(() => Math.round(renderWidth * PixelRatio.get()), [renderWidth]);

  useImperativeHandle(controlRef, () => ({ resetZoom }), [resetZoom]);

  // Tell the host (CreateDrawer) to disable its native sheet's own pan while
  // the board is zoomed or mid-pinch — see onInteractionActiveChange above.
  useEffect(() => {
    onInteractionActiveChange?.(isZoomed || isPinching);
  }, [isZoomed, isPinching, onInteractionActiveChange]);

  const holdById = useMemo(() => {
    const map = new Map<number, BoardHoldTarget>();
    for (const hold of holdTargets) map.set(hold.id, hold);
    return map;
  }, [holdTargets]);

  // Hit circles for resolving a tap to a hold while zoomed (the pan overlay sits
  // above the per-hold detectors, so it resolves taps itself — see #2687).
  const hitTargets = useMemo(
    () => buildHoldHitTargets(holdTargets, boardWidth, boardHeight, renderWidth, renderHeight, mirrored),
    [holdTargets, boardWidth, boardHeight, renderWidth, renderHeight, mirrored],
  );

  const overlayGesture = useZoomedHoldTapGesture({
    zoomPanGesture,
    scaleSV,
    translateXSV,
    translateYSV,
    containerWidthSV,
    containerHeightSV,
    hitTargets,
    onTap: onPaint,
    onLongPress: onLongPressHold,
    pinchRef,
    isPinchingSV,
  });

  // Only ever mounted on a build with no native renderer, but memoized anyway:
  // a fresh element every render would defeat BoardImageNative's React.memo and
  // re-render the board on every zoom tick.
  const paintedHoldsFallback = useMemo(
    () => (
      <PaintedHoldsLayer
        litUpHoldsMap={litUpHoldsMap}
        holdById={holdById}
        boardWidth={boardWidth}
        boardHeight={boardHeight}
        measuredWidth={renderWidth}
        mirrored={mirrored}
      />
    ),
    [litUpHoldsMap, holdById, boardWidth, boardHeight, renderWidth, mirrored],
  );

  // The wall's own marks — the discoverability dots, and whatever the caller
  // draws on the board — go UNDER the rendered holds. Above them, a dot lands in
  // the middle of a lit hold's fill and its role glyph. Memoized for the same
  // reason as the fallback: a fresh element per render would defeat
  // BoardImageNative's React.memo on every zoom tick.
  const underOverlay = useMemo(
    () => (
      <>
        <HoldMarkerLayer
          holdTargets={holdTargets}
          boardWidth={boardWidth}
          boardHeight={boardHeight}
          measuredWidth={renderWidth}
          mirrored={mirrored}
          showAllHolds={showAllHolds}
        />
        {overlay ? (
          <View pointerEvents="none" style={StyleSheet.absoluteFill}>
            {overlay}
          </View>
        ) : null}
      </>
    ),
    [holdTargets, boardWidth, boardHeight, renderWidth, mirrored, showAllHolds, overlay],
  );

  return (
    <GestureHandlerRootView style={styles.root}>
      <GestureDetector gesture={pinchGesture}>
        <View style={[styles.clip, { width: renderWidth, height: renderHeight }]}>
          <Animated.View style={[styles.board, animatedZoomStyle]}>
            <BoardImageNative
              frames={frames}
              boardName={boardName}
              layoutId={layoutId}
              sizeId={sizeId}
              setIds={setIds}
              boardWidth={boardWidth}
              boardHeight={boardHeight}
              mirrored={mirrored}
              renderWidth={overlayRenderWidth}
              backgroundVariant="full"
              maxVeilOpacity={EDITING_VEIL_OPACITY}
              retainPreviousOverlay
              underOverlay={underOverlay}
              emptyOverlayFallback={paintedHoldsFallback}
            />
            <HoldTargetLayer
              holdTargets={holdTargets}
              boardWidth={boardWidth}
              boardHeight={boardHeight}
              measuredWidth={renderWidth}
              mirrored={mirrored}
              showAllHolds={showAllHolds}
              // The dots are drawn by HoldMarkerLayer, under the holds overlay.
              // These targets stay transparent and on top, where the touches are.
              showHoldMarkers={false}
              onPaint={onPaint}
              onLongPress={onLongPressHold}
              pinchRef={pinchRef}
              isPinchingSV={isPinchingSV}
            />
          </Animated.View>

          {/* Pan-while-zoomed overlay: only mounted when zoomed so it doesn't
              claim 1-finger touches at rest (which would block the drawer's
              scroll/close). 2-finger pinches fall through via maxPointers(1).
              The overlay sits above the per-hold detectors, so its gesture also
              resolves taps/long-presses to holds (Race with the pan) — without
              that, painting and the role sheet are dead while zoomed (#2687). */}
          {isZoomed ? (
            <GestureDetector gesture={overlayGesture}>
              <View style={StyleSheet.absoluteFill}>
                {/* A CHILD of the pan overlay, not a sibling above it. RNGH
                    offers a touch to the handlers on the touched view and its
                    ANCESTORS, so nesting is what keeps a drag that starts on the
                    button panning the board — and this button sits in the corner
                    the panning thumb rests in. As a sibling it would be a 32dp
                    dead zone for panning. Mounting with the overlay also means
                    it re-introduces itself on every zoom, which is the point of
                    the 3s label. */}
                <ResetZoomButton visible onPress={resetZoom} style={styles.resetZoom} />
              </View>
            </GestureDetector>
          ) : null}
        </View>
      </GestureDetector>
    </GestureHandlerRootView>
  );
});

const styles = StyleSheet.create({
  root: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  clip: {
    overflow: 'hidden',
  },
  board: {
    width: '100%',
    height: '100%',
  },
  // Bottom-right: nearest the thumb on a sheet, and the corner it already
  // covers while panning. See ResetZoomButton for why it is on the board.
  resetZoom: {
    right: spacing[2],
    bottom: spacing[2],
  },
});
