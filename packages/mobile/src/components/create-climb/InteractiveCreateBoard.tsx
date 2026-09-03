import React, { useMemo, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View, StyleSheet, Pressable, PixelRatio } from 'react-native';
import Animated from 'react-native-reanimated';
import { GestureDetector, GestureHandlerRootView, type GestureType } from 'react-native-gesture-handler';
import type { BoardName, LitUpHoldsMap } from '@boardsesh/shared-schema';
import { BoardImageNative } from '../BoardImageNative';
import { Text } from '../Text';
import { useZoomPanGesture } from '../play-drawer/use-zoom-pan-gesture';
import { overlays } from '../../theme/tokens';
import { EDITING_MAX_VEIL_OPACITY } from '../../lib/board-render-settings';
import type { BoardHoldTarget } from '../../lib/create-board-holds';
import { HoldMarkerLayer } from './HoldMarkerLayer';
import { HoldTargetLayer } from './HoldTargetLayer';
import { PaintedHoldsLayer } from './PaintedHoldsLayer';
import { buildHoldHitTargets } from './holdLayout';
import { useZoomedHoldTapGesture, PAN_ACTIVATION_OFFSET } from './use-zoomed-hold-tap-gesture';

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
};

/**
 * The no-SVG interactive board editor. The board and its painted holds come from
 * the same renderer the play view uses (BoardImageNative, fed the active frame),
 * so a climb looks the same while you build it as it will once it is saved; the
 * veil is capped so the unlit holds you still have to tap stay readable. Tap
 * targets are plain RN Views placed INSIDE the zoom-transformed Animated.View, so
 * RNGH hit-tests them in board-local space and taps land correctly at any zoom
 * level with zero manual coordinate math. PaintedHoldsLayer survives as the
 * fallback for a build with no native renderer, where no overlay ever arrives.
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
}: InteractiveCreateBoardProps) {
  const { t } = useTranslation('common');
  // Shared with the per-hold detectors and the zoomed overlay so they mark
  // themselves simultaneous with the pinch — otherwise two fingers landing on
  // two hold targets each claim a pointer and pinch-to-zoom stalls on Android.
  const pinchRef = useRef<GestureType | undefined>(undefined);
  const {
    pinchGesture,
    zoomPanGesture,
    isZoomed,
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
              filledStyle
              renderWidth={overlayRenderWidth}
              backgroundVariant="full"
              maxVeilOpacity={EDITING_MAX_VEIL_OPACITY}
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
              <View style={StyleSheet.absoluteFill} />
            </GestureDetector>
          ) : null}

          {isZoomed ? (
            <Pressable style={styles.resetButton} onPress={resetZoom} hitSlop={8} accessibilityRole="button">
              <Text variant="footnote" style={styles.resetLabel}>
                {t('board.resetZoom')}
              </Text>
            </Pressable>
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
  resetButton: {
    position: 'absolute',
    top: 12,
    right: 12,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: overlays.scrim,
  },
  resetLabel: {
    color: overlays.onScrim,
  },
});
