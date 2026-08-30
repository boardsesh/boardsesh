import React, { useEffect, useMemo, useRef } from 'react';
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
  /** The board's pinch, composed Simultaneous so 2-finger zoom survives a draw. */
  pinchGesture: GestureType;
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
  pinchGesture,
  onStrokeStart,
  onStrokeEnd,
  onStrokeCancel,
}: DrawStrokeOverlayProps) {
  // Mirrored into a shared value rather than captured: a captured number would
  // have to be a gesture dependency, and rebuilding a live RNGH gesture
  // mid-session has wedged iOS before (see use-zoom-pan-gesture).
  const boardScaleSV = useSharedValue(boardScale);
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
      .maxPointers(1)
      .manualActivation(true)
      .onTouchesDown((event, manager) => {
        'worklet';
        if (event.pointerType === STYLUS_POINTER_TYPE || fingerDrawSV.value) {
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
        if (success) return;
        runOnJS(handleCancel)();
      });

    // Simultaneous with the board's pinch (the ZoneOverlay pattern) so a
    // two-finger zoom still recognises while a finger sits on this overlay.
    return Gesture.Simultaneous(pan, pinchGesture);
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
    pinchGesture,
  ]);

  return (
    <GestureDetector gesture={gesture}>
      <View collapsable={false} style={StyleSheet.absoluteFill} />
    </GestureDetector>
  );
});
