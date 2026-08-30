import React, { useEffect, useMemo, useRef, type MutableRefObject } from 'react';
import { StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector, PointerType, type GestureType } from 'react-native-gesture-handler';
import { runOnJS, useSharedValue, type SharedValue } from 'react-native-reanimated';
import { STROKE_MIN_SAMPLE_BOARD_PX } from './stroke';

/**
 * Pointer types that draw. Read into a module-level number so the activation
 * worklet captures a primitive rather than the whole `PointerType` enum object.
 */
const STYLUS_POINTER_TYPE: number = PointerType.STYLUS;

/** Squared form of the sampling gate, so the worklet needs no `Math.hypot`. */
const MIN_SAMPLE_DISTANCE_SQUARED = STROKE_MIN_SAMPLE_BOARD_PX * STROKE_MIN_SAMPLE_BOARD_PX;

/**
 * Hard cap on one stroke's sample count (in numbers, so half this many points).
 * A stroke is decimated to at most 150 points on commit anyway; the cap only
 * stops a stylus left resting under a slow drift from growing the shared value
 * without bound.
 */
const MAX_STROKE_NUMBERS = 4000;

type DrawStrokeOverlayProps = {
  /**
   * The live stroke, in BOARD px, flat `[x0, y0, x1, y1, ...]`. Owned by the
   * screen because the preview is drawn by the SVG layer INSIDE the zoom
   * transform (so it tracks the board for free) while this overlay sits above
   * it. Replaced wholesale on each kept sample — reanimated only reacts to a new
   * value, not an in-place push.
   */
  pointsSV: SharedValue<number[]>;
  /**
   * True when the finger-draw toggle is on. Off (the default) only an Apple
   * Pencil / stylus draws, and every finger touch falls through to the board's
   * own pan and pinch.
   */
  fingerDrawSV: SharedValue<boolean>;
  /** The board's live zoom transform, from `FilterBoardTransformContext`. */
  scaleSV: SharedValue<number>;
  translateXSV: SharedValue<number>;
  translateYSV: SharedValue<number>;
  containerWidthSV: SharedValue<number>;
  containerHeightSV: SharedValue<number>;
  /** Board px per render px (`boardWidth / renderWidth`). */
  boardScale: number;
  /**
   * Ref handle on the board's pinch. Declared as a RELATION
   * (`simultaneousWithExternalGesture`), never composed into this detector: a
   * Gesture instance carries one RNGH handler tag, and mounting the board's
   * pinch in a second `GestureDetector` throws "Handler with tag N already
   * exists" and drops the handler the board still owns when this unmounts.
   */
  pinchRef: MutableRefObject<GestureType | undefined>;
  /** Fired once when a stroke actually starts — the screen uses it to stop hold taps. */
  onStrokeStart: () => void;
  /** Fired once at stroke end with the whole stroke in board px. */
  onStrokeEnd: (boardPoints: number[]) => void;
  /** Fired once when a stroke is cancelled without committing. */
  onStrokeCancel: () => void;
};

/**
 * The Apple-Pencil draw surface: a full-bleed pan that only claims the touch
 * when the pointer is a stylus (or the finger-draw toggle is on), and otherwise
 * fails so the touch reaches the board underneath.
 *
 * That split is the whole point of `manualActivation(true)`. Without it the pan
 * would swallow every drag and the zoomed board could no longer be repositioned
 * mid-edit; with it, a finger drag on an iPad still pans the zoomed board and a
 * two-finger pinch still zooms, while the pencil draws.
 *
 * The fall-through only works because this overlay is mounted INSIDE the pan
 * overlay's view (see `renderAboveBoard` in InteractiveFilterBoard): RNGH offers
 * a declined touch to ancestors, never to siblings drawn underneath.
 *
 * There is deliberately no `maxPointers(1)`. A palm resting on the glass is
 * normal Apple Pencil posture, and capping the pointer count would cancel the
 * stroke the moment it landed. Once a stroke is live, later touches are ignored
 * outright rather than allowed to start or fail one. The cost is that Pan
 * reports the CENTROID of all active pointers, so a palm iPadOS fails to reject
 * can drag the sampled point — a real-device QA item, not something a simulator
 * can show.
 *
 * Samples are converted to board px on the UI thread — the worklet twin of
 * `screenToBoardPoint` in `stroke.ts`, inlined because reanimated can't reliably
 * call a cross-module worklet (same split as `use-zoomed-hold-tap-gesture`).
 * Absolute event coordinates, never `translationX/Y`: a delta would accumulate
 * the zoom scale twice.
 *
 * `runOnJS` fires at most three times per stroke (start, end, cancel) — never
 * per frame.
 */
export const DrawStrokeOverlay = React.memo(function DrawStrokeOverlay({
  pointsSV,
  fingerDrawSV,
  scaleSV,
  translateXSV,
  translateYSV,
  containerWidthSV,
  containerHeightSV,
  boardScale,
  pinchRef,
  onStrokeStart,
  onStrokeEnd,
  onStrokeCancel,
}: DrawStrokeOverlayProps) {
  // Mirrored into a shared value rather than captured: a captured number would
  // have to be a gesture dependency, and rebuilding a live RNGH gesture
  // mid-session has wedged iOS before (see use-zoom-pan-gesture).
  const boardScaleSV = useSharedValue(boardScale);
  // True between activation and finalize. Lives on the UI thread because the
  // activation worklet has to read it on the very next touch-down.
  const isDrawingSV = useSharedValue(false);
  useEffect(() => {
    boardScaleSV.value = boardScale;
  }, [boardScale, boardScaleSV]);

  const callbacksRef = useRef({ onStrokeStart, onStrokeEnd, onStrokeCancel });
  callbacksRef.current = { onStrokeStart, onStrokeEnd, onStrokeCancel };
  // Captured once by the gesture memo — only closes over the stable ref.
  const handleStart = () => callbacksRef.current.onStrokeStart();
  const handleEnd = (boardPoints: number[]) => callbacksRef.current.onStrokeEnd(boardPoints);
  const handleCancel = () => callbacksRef.current.onStrokeCancel();

  const gesture = useMemo(() => {
    const pan = Gesture.Pan()
      .minPointers(1)
      .manualActivation(true)
      .onTouchesDown((event, manager) => {
        'worklet';
        // A stroke is already live: a second touch (typically the palm) must
        // neither restart nor fail it.
        if (isDrawingSV.value) return;
        if (event.pointerType === STYLUS_POINTER_TYPE || fingerDrawSV.value) {
          isDrawingSV.value = true;
          manager.activate();
          return;
        }
        // Not a drawing pointer: hand the touch back so the board's own
        // zoomed-pan / pinch / hold-tap gestures can have it.
        manager.fail();
      })
      .onStart((event) => {
        'worklet';
        const centreX = containerWidthSV.value / 2;
        const centreY = containerHeightSV.value / 2;
        const renderX = (event.x - translateXSV.value - centreX) / scaleSV.value + centreX;
        const renderY = (event.y - translateYSV.value - centreY) / scaleSV.value + centreY;
        pointsSV.value = [renderX * boardScaleSV.value, renderY * boardScaleSV.value];
        runOnJS(handleStart)();
      })
      .onUpdate((event) => {
        'worklet';
        const current = pointsSV.value;
        const count = current.length;
        if (count === 0 || count >= MAX_STROKE_NUMBERS) return;
        const centreX = containerWidthSV.value / 2;
        const centreY = containerHeightSV.value / 2;
        const renderX = (event.x - translateXSV.value - centreX) / scaleSV.value + centreX;
        const renderY = (event.y - translateYSV.value - centreY) / scaleSV.value + centreY;
        const boardX = renderX * boardScaleSV.value;
        const boardY = renderY * boardScaleSV.value;
        const deltaX = boardX - current[count - 2];
        const deltaY = boardY - current[count - 1];
        // Gate the append on real movement so a resting stylus doesn't push a
        // point (and reallocate the shared value) every frame.
        if (deltaX * deltaX + deltaY * deltaY < MIN_SAMPLE_DISTANCE_SQUARED) return;
        pointsSV.value = [...current, boardX, boardY];
      })
      .onEnd((_event, success) => {
        'worklet';
        if (!success) return;
        runOnJS(handleEnd)(pointsSV.value);
      })
      .onFinalize((_event, success) => {
        'worklet';
        isDrawingSV.value = false;
        if (success) return;
        runOnJS(handleCancel)();
      });

    // A RELATION on the board's pinch, not a composition of it — so a two-finger
    // zoom still recognises while a finger or pencil sits on this overlay,
    // without this detector claiming the pinch's handler tag.
    pan.simultaneousWithExternalGesture(pinchRef);
    return pan;
    // handleStart/handleEnd/handleCancel are intentionally not deps — they're
    // captured once and read render-scoped values through callbacksRef.
  }, [
    pointsSV,
    fingerDrawSV,
    scaleSV,
    translateXSV,
    translateYSV,
    containerWidthSV,
    containerHeightSV,
    boardScaleSV,
    isDrawingSV,
    pinchRef,
  ]);

  return (
    <GestureDetector gesture={gesture}>
      <View collapsable={false} style={StyleSheet.absoluteFill} />
    </GestureDetector>
  );
});
