import React, { useEffect, useMemo, useRef, type MutableRefObject } from 'react';
import { StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector, type GestureType } from 'react-native-gesture-handler';
import { runOnJS, useSharedValue, type SharedValue } from 'react-native-reanimated';
import { HIT_FALLBACK_SCREEN_PT } from './spray-hold-tools';

/**
 * How close to the first corner, in SCREEN points, a tap has to land to close
 * the polygon. Half a fingertip, like the hold tools' own grab radius, and
 * converted to board px at the live zoom so it stays a fingertip wide however
 * far in the climber has zoomed.
 */
const CLOSE_TARGET_SCREEN_PT = HIT_FALLBACK_SCREEN_PT;

/** Longest a press can last and still read as a tap, in ms. Past it, the board's pan owns the touch. */
const TAP_MAX_DURATION_MS = 300;

/** Furthest a finger can travel and still read as a tap, in screen points. */
const TAP_MAX_DISTANCE_PT = 15;

type PolygonTapOverlayProps = {
  /**
   * The corners placed so far, in BOARD px, flat `[x0, y0, x1, y1, ...]`. Owned
   * by the screen because the preview is drawn by the SVG layer INSIDE the zoom
   * transform while this overlay sits above it, and because Undo and Finish
   * live in the screen's chrome. Replaced wholesale on each tap — reanimated
   * only reacts to a new value, not an in-place push.
   */
  verticesSV: SharedValue<number[]>;
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
   * (`simultaneousWithExternalGesture`), never composed into this detector —
   * see `DrawStrokeOverlay` for why a second detector must not claim it.
   */
  pinchRef: MutableRefObject<GestureType | undefined>;
  /** Most corners a polygon may have; a tap past it is ignored. */
  maxVertices: number;
  /** Fired after each corner is added, with the new corner count. */
  onVertexCountChange: (count: number) => void;
  /**
   * Fired when a tap lands on the first corner of a polygon with at least three.
   * Hands back the corners in board px, flat — NOT including the closing tap.
   */
  onClose: (vertices: number[]) => void;
};

/**
 * The Corners draw surface: each tap on the photo drops one corner of a hold's
 * outline, and a tap back on the first corner closes it.
 *
 * One `Gesture.Tap`, bounded on duration and travel, so a drag or a slow press
 * fails it and falls through to the board's own zoomed pan, and a second finger
 * fails it outright so a pinch zooms instead of dropping a corner. The pinch is
 * a simultaneous RELATION, as in `DrawStrokeOverlay`, never composed in.
 *
 * The fall-through only works because this overlay is mounted INSIDE the pan
 * overlay's view (see `renderAboveBoard` in InteractiveFilterBoard): RNGH offers
 * a declined touch to ancestors, never to siblings drawn underneath.
 *
 * The tap is converted to board px on the UI thread with the same inlined
 * inverse transform `DrawStrokeOverlay` uses (the worklet twin of
 * `screenToBoardPoint` in `stroke.ts`). Absolute event coordinates, never a
 * translation delta.
 *
 * `runOnJS` fires once per accepted tap — never per frame.
 */
export const PolygonTapOverlay = React.memo(function PolygonTapOverlay({
  verticesSV,
  scaleSV,
  translateXSV,
  translateYSV,
  containerWidthSV,
  containerHeightSV,
  boardScale,
  pinchRef,
  maxVertices,
  onVertexCountChange,
  onClose,
}: PolygonTapOverlayProps) {
  // Mirrored into shared values rather than captured: a captured number would
  // have to be a gesture dependency, and rebuilding a live RNGH gesture
  // mid-session has wedged iOS before (see use-zoom-pan-gesture).
  const boardScaleSV = useSharedValue(boardScale);
  const maxVerticesSV = useSharedValue(maxVertices);
  useEffect(() => {
    boardScaleSV.value = boardScale;
  }, [boardScale, boardScaleSV]);
  useEffect(() => {
    maxVerticesSV.value = maxVertices;
  }, [maxVertices, maxVerticesSV]);

  const callbacksRef = useRef({ onVertexCountChange, onClose });
  callbacksRef.current = { onVertexCountChange, onClose };
  // Captured once by the gesture memo — only closes over the stable ref.
  const handleVertexCountChange = (count: number) => callbacksRef.current.onVertexCountChange(count);
  const handleClose = (vertices: number[]) => callbacksRef.current.onClose(vertices);

  const gesture = useMemo(() => {
    const tap = Gesture.Tap()
      .maxDuration(TAP_MAX_DURATION_MS)
      .maxDistance(TAP_MAX_DISTANCE_PT)
      .onTouchesDown((event, manager) => {
        'worklet';
        // A second finger means a pinch, not a corner.
        if (event.numberOfTouches > 1) manager.fail();
      })
      .onEnd((event, success) => {
        'worklet';
        if (!success) return;
        const scale = scaleSV.value;
        const centreX = containerWidthSV.value / 2;
        const centreY = containerHeightSV.value / 2;
        const renderX = (event.x - translateXSV.value - centreX) / scale + centreX;
        const renderY = (event.y - translateYSV.value - centreY) / scale + centreY;
        const boardX = renderX * boardScaleSV.value;
        const boardY = renderY * boardScaleSV.value;

        const current = verticesSV.value;
        const count = current.length / 2;
        if (count >= 3) {
          // Screen points → board px at the live zoom.
          const closeRadius = (CLOSE_TARGET_SCREEN_PT * boardScaleSV.value) / scale;
          const deltaX = boardX - current[0];
          const deltaY = boardY - current[1];
          if (deltaX * deltaX + deltaY * deltaY <= closeRadius * closeRadius) {
            runOnJS(handleClose)(current);
            return;
          }
        }
        if (count >= maxVerticesSV.value) return;
        verticesSV.value = [...current, boardX, boardY];
        runOnJS(handleVertexCountChange)(count + 1);
      });

    // A RELATION on the board's pinch, not a composition of it.
    tap.simultaneousWithExternalGesture(pinchRef);
    return tap;
    // handleVertexCountChange/handleClose are intentionally not deps — they're
    // captured once and read render-scoped values through callbacksRef.
  }, [
    verticesSV,
    scaleSV,
    translateXSV,
    translateYSV,
    containerWidthSV,
    containerHeightSV,
    boardScaleSV,
    maxVerticesSV,
    pinchRef,
  ]);

  return (
    <GestureDetector gesture={gesture}>
      <View collapsable={false} style={StyleSheet.absoluteFill} />
    </GestureDetector>
  );
});
