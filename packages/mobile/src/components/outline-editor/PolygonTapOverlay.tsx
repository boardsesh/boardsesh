import React, { useEffect, useMemo, useRef, type MutableRefObject } from 'react';
import { StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector, PointerType, type GestureType } from 'react-native-gesture-handler';
import { runOnJS, useSharedValue, type DerivedValue, type SharedValue } from 'react-native-reanimated';
import { CORNERS_CLOSE_EXTENT_FRACTION, CORNERS_CLOSE_TARGET_PT } from './spray-hold-tools';
import { isOnPhoto } from './spray-gesture-math';
import {
  pointerWantsLoupe,
  stopLoupe,
  trackLoupe,
  useReleaseLoupeOnUnmount,
  type SprayLoupeFeed,
} from './spray-loupe-feed';

/**
 * How long after a close a corner is ignored. A quick double tap on the first
 * corner would otherwise close the outline and then start a new one on the
 * same spot, leaving a stray corner that blocks Publish.
 */
const AFTER_CLOSE_QUIET_MS = 250;

/** Read into a primitive so the worklet captures a number, not the enum object (as in `DrawStrokeOverlay`). */
const STYLUS_POINTER_TYPE: number = PointerType.STYLUS;

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
  translateXSV: DerivedValue<number>;
  translateYSV: DerivedValue<number>;
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
  /** Most corners a polygon may have; a tap past it fires `onVertexLimit`. */
  maxVertices: number;
  /**
   * Fired after each corner is added — for feedback (a haptic, clearing an
   * error). The count itself is read from `verticesSV`, its one source.
   */
  onVertexAdded: () => void;
  /** Fired when a tap is refused because the outline already has `maxVertices` corners. */
  onVertexLimit: () => void;
  /**
   * Fired when a corner lands on the first corner of a polygon with at least
   * three. Hands back the corners in board px, flat — NOT including the closing
   * touch. `verticesSV` is already empty by then, so a second quick touch cannot
   * close the same outline twice; the handler puts the corners back if it
   * refuses them.
   */
  onClose: (vertices: number[]) => void;
  /** The magnifier over the finger while it slides to a corner. Omitted, there is no loupe. */
  loupe?: SprayLoupeFeed;
  /**
   * OPT-IN, for the spray editor's "Pencil only" mode on iPad. While true, a
   * touch that is not a stylus fails at touch-down, so fingers pan and pinch and
   * only the Pencil places corners. Omitted or false, any one finger places one.
   */
  stylusOnlySV?: SharedValue<boolean>;
};

/**
 * The Corners draw surface: touch the photo, slide to the exact spot, lift, and
 * a corner of the hold's outline lands where the finger lifted. A corner
 * landing back on the first corner closes the outline.
 *
 * A Manual recognizer that owns one pointer from touch-down to lift, as Add's
 * Draw does in `DrawStrokeOverlay`: it activates at touch-down, so a finger
 * that slides positions the corner rather than panning the board, and the
 * loupe (`loupe`) shows the spot under the finger once the touch has lasted
 * 120 ms or moved 4 pt. A quick tap still drops a corner where it landed. Like
 * Draw, a zoomed board pans with two fingers here (`pinchPans`). A second
 * finger cancels the corner and fails the recognizer, so the pinch — a
 * simultaneous RELATION, never composed in — zooms instead.
 *
 * The lift is converted to board px on the UI thread with the same inlined
 * inverse transform `DrawStrokeOverlay` uses (the worklet twin of
 * `screenToBoardPoint` in `stroke.ts`). Absolute event coordinates, never a
 * translation delta. The close test and the corner cap run there too, so the
 * corners never round-trip through React per touch.
 *
 * A lift past the photo's edge (the dark band round a zoomed wall) places no
 * corner: the outline can only be built on the photo. It can still close the
 * outline when it lands on the first corner.
 *
 * `runOnJS` fires once per lifted finger — never per frame.
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
  onVertexAdded,
  onVertexLimit,
  onClose,
  loupe,
  stylusOnlySV,
}: PolygonTapOverlayProps) {
  // Mirrored into shared values rather than captured: a captured number would
  // have to be a gesture dependency, and rebuilding a live RNGH gesture
  // mid-session has wedged iOS before (see use-zoom-pan-gesture).
  const boardScaleSV = useSharedValue(boardScale);
  const maxVerticesSV = useSharedValue(maxVertices);
  const lastCloseAtSV = useSharedValue(0);
  /** The one pointer placing a corner, or -1 when none is. */
  const ownerPointerIdSV = useSharedValue(-1);
  /** When that pointer landed, for the loupe's delay. */
  const touchDownAtSV = useSharedValue(0);
  /** That pointer is a finger, so it gets the loupe. */
  const loupeFingerSV = useSharedValue(false);
  useReleaseLoupeOnUnmount(loupe, touchDownAtSV);
  useEffect(() => {
    boardScaleSV.value = boardScale;
  }, [boardScale, boardScaleSV]);
  useEffect(() => {
    maxVerticesSV.value = maxVertices;
  }, [maxVertices, maxVerticesSV]);

  const callbacksRef = useRef({ onVertexAdded, onVertexLimit, onClose });
  callbacksRef.current = { onVertexAdded, onVertexLimit, onClose };
  // Captured once by the gesture memo — only closes over the stable ref.
  const handleVertexAdded = () => callbacksRef.current.onVertexAdded();
  const handleVertexLimit = () => callbacksRef.current.onVertexLimit();
  const handleClose = (vertices: number[]) => callbacksRef.current.onClose(vertices);

  const gesture = useMemo(() => {
    /** Points the loupe at the placing finger. Never for a stylus. */
    const followWithLoupe = (screenX: number, screenY: number) => {
      'worklet';
      if (!loupeFingerSV.value) return;
      trackLoupe(
        loupe,
        touchDownAtSV.value,
        screenX,
        screenY,
        scaleSV.value,
        translateXSV.value,
        translateYSV.value,
        containerWidthSV.value,
        containerHeightSV.value,
      );
    };
    /** Lets go of the pointer without a corner. Cleared before fail/end: either can finalize synchronously. */
    const release = () => {
      'worklet';
      ownerPointerIdSV.value = -1;
      stopLoupe(loupe);
    };
    /** The finger lifted at this screen point: a corner, a close, or a refusal at the cap. */
    const placeCorner = (screenX: number, screenY: number) => {
      'worklet';
      const scale = scaleSV.value;
      const centreX = containerWidthSV.value / 2;
      const centreY = containerHeightSV.value / 2;
      const renderX = (screenX - translateXSV.value - centreX) / scale + centreX;
      const renderY = (screenY - translateYSV.value - centreY) / scale + centreY;
      const boardX = renderX * boardScaleSV.value;
      const boardY = renderY * boardScaleSV.value;

      const current = verticesSV.value;
      const count = current.length / 2;
      if (count === 0 && Date.now() - lastCloseAtSV.value < AFTER_CLOSE_QUIET_MS) return;
      if (count >= 3) {
        // Screen points → board px at the live zoom, capped by the outline's
        // own size so a small hold's next corner is not read as closing it.
        // Inlined twin of the preview's target in SprayHoldSvgLayer.
        let farthestSquared = 0;
        for (let index = 2; index < current.length; index += 2) {
          const spanX = current[index] - current[0];
          const spanY = current[index + 1] - current[1];
          farthestSquared = Math.max(farthestSquared, spanX * spanX + spanY * spanY);
        }
        const closeRadius = Math.min(
          (CORNERS_CLOSE_TARGET_PT * boardScaleSV.value) / scale,
          CORNERS_CLOSE_EXTENT_FRACTION * Math.sqrt(farthestSquared),
        );
        const deltaX = boardX - current[0];
        const deltaY = boardY - current[1];
        if (deltaX * deltaX + deltaY * deltaY <= closeRadius * closeRadius) {
          // Emptied here, on the UI thread, before JS hears of it.
          verticesSV.value = [];
          lastCloseAtSV.value = Date.now();
          runOnJS(handleClose)(current);
          return;
        }
      }
      // Off the photo: nothing to outline there.
      if (
        !isOnPhoto(
          boardX,
          boardY,
          containerWidthSV.value * boardScaleSV.value,
          containerHeightSV.value * boardScaleSV.value,
        )
      ) {
        return;
      }
      if (count >= maxVerticesSV.value) {
        runOnJS(handleVertexLimit)();
        return;
      }
      verticesSV.value = [...current, boardX, boardY];
      runOnJS(handleVertexAdded)();
    };

    const place = Gesture.Manual()
      .onTouchesDown((event, manager) => {
        'worklet';
        if (ownerPointerIdSV.value !== -1) {
          // A second finger while one is placing is a pinch starting: no corner.
          release();
          manager.fail();
          return;
        }
        const pointer = event.changedTouches[0];
        // Two fingers landing together are a pinch from the start.
        if (!pointer || event.numberOfTouches > 1) {
          manager.fail();
          return;
        }
        // Pencil only: a finger is moving round the wall, not placing a corner.
        if (stylusOnlySV !== undefined && stylusOnlySV.value && event.pointerType !== STYLUS_POINTER_TYPE) {
          manager.fail();
          return;
        }
        ownerPointerIdSV.value = pointer.id;
        touchDownAtSV.value = Date.now();
        loupeFingerSV.value = pointerWantsLoupe(event.pointerType);
        followWithLoupe(pointer.x, pointer.y);
        manager.begin();
        manager.activate();
      })
      .onTouchesMove((event) => {
        'worklet';
        if (ownerPointerIdSV.value === -1) return;
        const pointer = event.changedTouches.find((touch) => touch.id === ownerPointerIdSV.value);
        if (pointer) followWithLoupe(pointer.x, pointer.y);
      })
      .onTouchesUp((event, manager) => {
        'worklet';
        if (ownerPointerIdSV.value === -1) return;
        // changedTouches names the lifted pointer even when iOS's allTouches
        // snapshot still holds it.
        const pointer = event.changedTouches.find((touch) => touch.id === ownerPointerIdSV.value);
        if (!pointer) return;
        release();
        placeCorner(pointer.x, pointer.y);
        manager.end();
      })
      .onTouchesCancelled((event, manager) => {
        'worklet';
        if (ownerPointerIdSV.value === -1) return;
        if (
          event.changedTouches.length > 0 &&
          !event.changedTouches.some((touch) => touch.id === ownerPointerIdSV.value)
        )
          return;
        release();
        manager.fail();
      })
      .onFinalize(() => {
        'worklet';
        // Taken from outside (the system, a pinch that won): no corner.
        release();
      });

    // A RELATION on the board's pinch, not a composition of it.
    place.simultaneousWithExternalGesture(pinchRef);
    return place;
    // handleVertexAdded/handleVertexLimit/handleClose are intentionally not deps — they're
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
    lastCloseAtSV,
    ownerPointerIdSV,
    touchDownAtSV,
    loupeFingerSV,
    loupe,
    stylusOnlySV,
    pinchRef,
  ]);

  return (
    <GestureDetector gesture={gesture}>
      <View collapsable={false} style={StyleSheet.absoluteFill} />
    </GestureDetector>
  );
});
