import React, {
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  type MutableRefObject,
  type ReactNode,
  type RefObject,
} from 'react';
import { View, StyleSheet } from 'react-native';
import Animated, { runOnJS, type SharedValue } from 'react-native-reanimated';
import { Gesture, GestureDetector, type GestureType } from 'react-native-gesture-handler';
import type { BoardName, HoldsFilter } from '@boardsesh/shared-schema';
import { BoardImageNative } from '../BoardImageNative';
import { ResetZoomButton } from '../board-controls/ResetZoomButton';
import { useZoomPanGesture } from '../play-drawer/use-zoom-pan-gesture';
import { HoldTargetLayer } from '../create-climb/HoldTargetLayer';
import { holdGeometry, buildHoldHitTargets, resolveHoldAtPoint } from '../create-climb/holdLayout';
import { useZoomedHoldTapGesture, PAN_ACTIVATION_OFFSET } from '../create-climb/use-zoomed-hold-tap-gesture';
import { spacing } from '../../theme/tokens';
import type { BoardHoldTarget } from '../../lib/create-board-holds';
import { SearchHoldFilterRings } from './SearchHoldFilterRings';

/** Context handed to an overlay rendered inside the board's zoom transform. */
export type FilterBoardTransformContext = {
  /**
   * The board's pinch gesture.
   *
   * NOTE for new overlays: do NOT compose this instance into your own
   * `GestureDetector`. RNGH assigns one handler tag per Gesture object and
   * `createGestureHandler` throws "Handler with tag N already exists" the moment
   * a second detector mounts it (RNGestureHandlerModule.kt /
   * RNGestureHandlerManager.mm). Declare the relation instead:
   * `yourGesture.simultaneousWithExternalGesture(pinchRef)`.
   */
  pinchGesture: GestureType;
  /**
   * Ref handle on that same pinch, for
   * `simultaneousWithExternalGesture(pinchRef)` — the safe way to let a
   * two-finger zoom recognise while a finger sits on your overlay. See the
   * warning on `pinchGesture`.
   */
  pinchRef: MutableRefObject<GestureType | undefined>;
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
   * Overlay rendered ABOVE the zoom transform, in plain container coordinates —
   * used by the outline editor for the stylus draw surface, which has to see raw
   * screen points and invert the transform itself.
   *
   * While zoomed it is rendered as a CHILD of the pan overlay's view, not as a
   * sibling above it. That nesting is what makes a gesture the overlay declines
   * (`manager.fail()` on a finger when only a stylus draws) fall through to the
   * board's own pan and hold taps: RNGH offers a touch to the handlers on the
   * touched view and its ANCESTORS, so a sibling that merely sits underneath
   * would never see it and one-finger panning would be dead.
   *
   * At rest there is no pan overlay to nest inside, so it renders as a sibling —
   * and an at-rest tap the overlay declines reaches the ancestor pinch but not
   * the hold-tap layer inside the transform. Callers that need tap-to-select at
   * rest must offer their own affordance (the outline editor's "Pick another
   * hold").
   */
  renderAboveBoard?: (context: FilterBoardTransformContext) => ReactNode;
  /**
   * Imperative handle on the board's zoom, for chrome that lives OUTSIDE this
   * component and still has to drive it — the outline editor's Next/Prev
   * buttons, which sit in its toolbar and have to frame the hold they select.
   *
   * A ref rather than a prop-driven target, because "frame this hold" is an
   * event, not state: re-selecting the hold you are already on should re-frame
   * it, and a declarative prop equal to its previous value would not.
   */
  controlRef?: RefObject<FilterBoardControls | null>;
};

/** What {@link InteractiveFilterBoard} exposes through `controlRef`. */
export type FilterBoardControls = {
  /** Animate to an explicit, already-clamped board transform. */
  zoomTo: (target: { scale: number; translateX: number; translateY: number }) => void;
  /** Animate back to the unzoomed board. */
  resetZoom: () => void;
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
  controlRef,
}: InteractiveFilterBoardProps) {
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
    zoomTo,
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
      pinchRef,
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

  useImperativeHandle(controlRef, () => ({ zoomTo, resetZoom }), [zoomTo, resetZoom]);

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
              <View style={StyleSheet.absoluteFill}>
                {/* renderAboveBoard nests HERE, inside the pan's own view, so
                    this gesture is its ancestor and a declined touch falls
                    through to the pan / zoomed hold taps. See the prop's doc. */}
                {renderAboveBoard ? renderAboveBoard(transformContext) : null}
                {/* Nested for the same reason, and rendered after so it wins its
                    own taps: it sits in the corner the panning thumb rests in,
                    and as a sibling above the overlay it would be a dead zone
                    for panning. */}
                <ResetZoomButton visible onPress={resetZoom} style={styles.resetZoom} />
              </View>
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

          {/* At rest there is no pan overlay to nest inside, so the above-board
              overlay renders as a sibling here. The reset-zoom control is no
              longer one of its neighbours — it moved off the board entirely
              (#5113); the route renders it below the board via `controlRef`. */}
          {!isZoomed && renderAboveBoard ? renderAboveBoard(transformContext) : null}
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
  // Bottom-right, matching every other board. See ResetZoomButton.
  resetZoom: {
    right: spacing[2],
    bottom: spacing[2],
  },
});
