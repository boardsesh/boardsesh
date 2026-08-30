import React, { useCallback, useMemo, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View, StyleSheet, Pressable } from 'react-native';
import Animated, { runOnJS, type SharedValue } from 'react-native-reanimated';
import { Gesture, GestureDetector, type GestureType } from 'react-native-gesture-handler';
import type { BoardName, HoldsFilter } from '@boardsesh/shared-schema';
import { BoardImageNative } from '../BoardImageNative';
import { Text } from '../Text';
import { useZoomPanGesture } from '../play-drawer/use-zoom-pan-gesture';
import { HoldTargetLayer } from '../create-climb/HoldTargetLayer';
import { holdGeometry, buildHoldHitTargets, resolveHoldAtPoint } from '../create-climb/holdLayout';
import { useZoomedHoldTapGesture, PAN_ACTIVATION_OFFSET } from '../create-climb/use-zoomed-hold-tap-gesture';
import { overlays } from '../../theme/tokens';
import type { BoardHoldTarget } from '../../lib/create-board-holds';
import { SearchHoldFilterRings } from './SearchHoldFilterRings';

/** Context handed to an overlay rendered inside the board's zoom transform. */
export type FilterBoardTransformContext = {
  /** The board's pinch gesture, to compose overlay pans Simultaneous with it. */
  pinchGesture: GestureType;
  /** Live zoom scale, so an overlay can convert screen-pixel deltas to board px. */
  scaleSV: SharedValue<number>;
  /**
   * The rest of the live zoom transform. Together with `scaleSV` and the
   * container size these are everything needed to invert the board's transform
   * on the UI thread — what an overlay drawn ABOVE the transform (see
   * `renderAboveBoard`) needs to map a screen point back to board-local px.
   * Produced by `useZoomPanGesture` all along; forwarded here so an overlay
   * doesn't have to re-derive them.
   */
  translateXSV: SharedValue<number>;
  translateYSV: SharedValue<number>;
  containerWidthSV: SharedValue<number>;
  containerHeightSV: SharedValue<number>;
  renderWidth: number;
  renderHeight: number;
};

type InteractiveFilterBoardProps = {
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
  boardWidth: number;
  boardHeight: number;
  holdTargets: BoardHoldTarget[];
  /** Hold-type filter rings, when this board edits hold types. Omit for zone mode. */
  holdsFilter?: HoldsFilter;
  /** The hold the picker is currently editing — drawn with a bright ring. */
  activeHoldId?: number | null;
  /** Tap handler that opens the hold picker. Omit to disable hold taps (zone mode). */
  onHoldTap?: (holdId: number) => void;
  /** Hide visible all-hold tap markers while keeping hold tap targets active. */
  showHoldMarkers?: boolean;
  mirrored?: boolean;
  renderWidth: number;
  renderHeight: number;
  /**
   * Overlay rendered INSIDE the zoom transform (like the hold filter rings) so it
   * tracks the board at any zoom — used by the zone editor for the draggable
   * rectangle. Receives the board pinch + live scale so its pans compose cleanly.
   */
  renderInTransform?: (context: FilterBoardTransformContext) => ReactNode;
  /**
   * Overlay rendered ABOVE the zoom transform (and above the zoomed pan layer),
   * in plain container coordinates — used by the outline editor for the stylus
   * draw surface, which has to see raw screen points and invert the transform
   * itself. Rendered before the reset-zoom button so that button stays tappable.
   */
  renderAboveBoard?: (context: FilterBoardTransformContext) => ReactNode;
};

const TAP_MAX_DURATION_MS = 300;
const TAP_MAX_DISTANCE_PX = 15;
const LONG_PRESS_MIN_DURATION_MS = 400;

/**
 * Full-bleed interactive board for the search hold filter, built on the same
 * no-SVG gesture model as `InteractiveCreateBoard`: the board PNG plus plain RN
 * tap targets and filter rings INSIDE the zoom-transformed view, so taps and
 * rings track holds at any zoom with no manual coordinate math. Pinch is always
 * live; the 1-finger pan only mounts while zoomed.
 *
 * Unlike the create board this lives on a full-screen route (not a bottom
 * sheet), so the pan overlay can stay simpler — there's no parent scroll to
 * yield idle drags to.
 */
export const InteractiveFilterBoard = React.memo(function InteractiveFilterBoard({
  boardName,
  layoutId,
  sizeId,
  setIds,
  boardWidth,
  boardHeight,
  holdTargets,
  holdsFilter,
  activeHoldId = null,
  onHoldTap,
  showHoldMarkers = true,
  mirrored = false,
  renderWidth,
  renderHeight,
  renderInTransform,
  renderAboveBoard,
}: InteractiveFilterBoardProps) {
  const { t } = useTranslation('common');
  // Shared with the per-hold detectors and the rest/zoom tap overlays so they
  // mark themselves simultaneous with the pinch — same Android pinch-stall fix
  // as the create board (two fingers on two hold targets must not block pinch).
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

  // The picker uses a long-press-style commit, but holds here only need a single
  // tap to open the picker, so we route both tap and "long press" to the same
  // handler (HoldTargetLayer requires both).

  const transformContext = useMemo<FilterBoardTransformContext>(
    () => ({
      pinchGesture,
      scaleSV,
      translateXSV,
      translateYSV,
      containerWidthSV,
      containerHeightSV,
      renderWidth,
      renderHeight,
    }),
    [pinchGesture, scaleSV, translateXSV, translateYSV, containerWidthSV, containerHeightSV, renderWidth, renderHeight],
  );

  // Hit circles so the zoomed pan overlay can resolve a tap to a hold itself
  // (it sits above the per-hold detectors — see #2687). Zone mode passes no
  // onHoldTap, so the hook returns the bare pan and this is unused.
  const hitTargets = useMemo(
    () => buildHoldHitTargets(holdTargets, boardWidth, boardHeight, renderWidth, renderHeight, mirrored),
    [holdTargets, boardWidth, boardHeight, renderWidth, renderHeight, mirrored],
  );
  const hasHoldTap = onHoldTap != null;
  const holdTapResolutionRef = useRef({ hitTargets, onHoldTap });
  holdTapResolutionRef.current = { hitTargets, onHoldTap };
  const handleRestHoldTap = useCallback((boardX: number, boardY: number) => {
    const current = holdTapResolutionRef.current;
    if (!current.onHoldTap) return;
    const holdId = resolveHoldAtPoint(boardX, boardY, current.hitTargets);
    if (holdId != null) current.onHoldTap(holdId);
  }, []);
  const restHoldTapGesture = useMemo(() => {
    if (!hasHoldTap) return null;

    const tap = Gesture.Tap()
      .maxDuration(TAP_MAX_DURATION_MS)
      .maxDistance(TAP_MAX_DISTANCE_PX)
      .onStart((event) => {
        'worklet';
        // Bail if a pinch is active (see isPinchingSV) so a small pinch over the
        // board doesn't also open the hold picker on release.
        if (isPinchingSV?.value) return;
        runOnJS(handleRestHoldTap)(event.x, event.y);
      });
    const longPress = Gesture.LongPress()
      .minDuration(LONG_PRESS_MIN_DURATION_MS)
      .onStart((event) => {
        'worklet';
        if (isPinchingSV?.value) return;
        runOnJS(handleRestHoldTap)(event.x, event.y);
      });
    // Let the ancestor pinch recognize even while a finger sits on this overlay
    // — applied per-leg (the relation method is on the individual gestures).
    tap.simultaneousWithExternalGesture(pinchRef);
    longPress.simultaneousWithExternalGesture(pinchRef);
    return Gesture.Exclusive(longPress, tap);
  }, [hasHoldTap, handleRestHoldTap, isPinchingSV]);

  const overlayGesture = useZoomedHoldTapGesture({
    zoomPanGesture,
    scaleSV,
    translateXSV,
    translateYSV,
    containerWidthSV,
    containerHeightSV,
    hitTargets,
    // Long-press falls back to onTap in the hook, so a held hold opens the
    // picker too — same as HoldTargetLayer wiring both to onHoldTap at rest.
    onTap: onHoldTap,
    pinchRef,
    isPinchingSV,
  });

  const holdById = useMemo(() => {
    const map = new Map<number, BoardHoldTarget>();
    for (const hold of holdTargets) map.set(hold.id, hold);
    return map;
  }, [holdTargets]);

  const activeHighlight = useMemo(() => {
    if (activeHoldId == null || renderWidth <= 0) return null;
    const hold = holdById.get(activeHoldId);
    if (!hold) return null;
    const geometry = holdGeometry(hold, boardWidth, boardHeight, renderWidth, mirrored);
    const diameter = geometry.ringDiameter * 1.5;
    const radius = diameter / 2;
    return (
      <View
        pointerEvents="none"
        style={[
          styles.activeRing,
          {
            left: `${geometry.leftPct}%`,
            top: `${geometry.topPct}%`,
            width: diameter,
            height: diameter,
            marginLeft: -radius,
            marginTop: -radius,
            borderRadius: radius,
            borderWidth: Math.max(2.5, geometry.ringDiameter * 0.18),
          },
        ]}
      />
    );
  }, [activeHoldId, holdById, boardWidth, boardHeight, renderWidth, mirrored]);

  return (
    <View style={styles.root}>
      <GestureDetector gesture={pinchGesture}>
        <View style={[styles.clip, { width: renderWidth, height: renderHeight }]}>
          <Animated.View style={[styles.board, animatedZoomStyle]}>
            <BoardImageNative
              frames=""
              boardName={boardName}
              layoutId={layoutId}
              sizeId={sizeId}
              setIds={setIds}
              boardWidth={boardWidth}
              boardHeight={boardHeight}
              mirrored={mirrored}
            />
            {holdsFilter ? (
              <SearchHoldFilterRings
                boardName={boardName}
                holdsFilter={holdsFilter}
                holdTargets={holdTargets}
                boardWidth={boardWidth}
                boardHeight={boardHeight}
                measuredWidth={renderWidth}
                mirrored={mirrored}
              />
            ) : null}
            {activeHighlight}
            {onHoldTap ? (
              <HoldTargetLayer
                holdTargets={holdTargets}
                boardWidth={boardWidth}
                boardHeight={boardHeight}
                measuredWidth={renderWidth}
                mirrored={mirrored}
                showAllHolds
                showHoldMarkers={showHoldMarkers}
                onPaint={onHoldTap}
                onLongPress={onHoldTap}
                pinchRef={pinchRef}
                isPinchingSV={isPinchingSV}
              />
            ) : null}
            {!isZoomed && restHoldTapGesture ? (
              <GestureDetector gesture={restHoldTapGesture}>
                <View collapsable={false} style={StyleSheet.absoluteFill} />
              </GestureDetector>
            ) : null}
          </Animated.View>

          {/* 1-finger pan-to-reposition the zoomed board. Sits ABOVE the board
              layer (so a drag over the bare board pans it) but BELOW the
              `renderInTransform` overlay layer (so the zone rectangle + corner
              handles still win their touches while zoomed). In hold mode the
              gesture also resolves taps/long-presses to holds (Race with the
              pan) so the picker opens while zoomed (#2687); in zone mode
              `overlayGesture` is the bare pan (no onHoldTap). */}
          {isZoomed ? (
            <GestureDetector gesture={overlayGesture}>
              <View style={StyleSheet.absoluteFill} />
            </GestureDetector>
          ) : null}

          {/* Overlay rendered INSIDE the same zoom transform but ABOVE the
              pan-reset layer, so its gestures (e.g. the zone rectangle) receive
              touches even when zoomed. Its root is `pointerEvents="box-none"`,
              so taps on empty space fall through to the pan-reset layer below. */}
          {renderInTransform ? (
            <Animated.View pointerEvents="box-none" style={[StyleSheet.absoluteFill, animatedZoomStyle]}>
              {renderInTransform(transformContext)}
            </Animated.View>
          ) : null}

          {/* Overlay ABOVE the transform, in container coordinates. Sits over
              the zoomed pan layer so it gets first refusal on a touch, and
              before the reset-zoom button so that button still wins its own. */}
          {renderAboveBoard ? renderAboveBoard(transformContext) : null}

          {isZoomed ? (
            <Pressable style={styles.resetButton} onPress={resetZoom} hitSlop={8} accessibilityRole="button">
              <Text variant="footnote" style={styles.resetLabel}>
                {t('board.resetZoom')}
              </Text>
            </Pressable>
          ) : null}
        </View>
      </GestureDetector>
    </View>
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
  activeRing: {
    position: 'absolute',
    borderColor: '#FFFFFF',
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
