import React, { useEffect, useMemo, useRef, type MutableRefObject } from 'react';
import { StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector, PointerType, type GestureType } from 'react-native-gesture-handler';
import { runOnJS, useSharedValue, type SharedValue } from 'react-native-reanimated';
import { STROKE_MIN_SAMPLE_BOARD_PX } from './stroke';
import { stopLoupe, trackLoupe, type SprayLoupeFeed } from './spray-loupe-feed';

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
  /** Add mode accepts stationary taps; Trace keeps its existing pan recognizer. */
  acceptStationaryTaps?: boolean;
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
  /**
   * Opt-in magnifier over the finger, fed for the length of a FINGER stroke
   * (a stylus tip hides nothing). Omitted — the catalogue editor — nothing is
   * fed and the overlay behaves exactly as before.
   */
  loupe?: SprayLoupeFeed;
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
 * A second touch means different things depending on what started the stroke.
 *
 *  - STYLUS: ignored outright. A palm resting on the glass is normal Apple
 *    Pencil posture, so there is deliberately no `maxPointers(1)` — capping the
 *    pointer count would cancel the stroke the moment the palm landed. The cost
 *    is that Pan reports the CENTROID of all active pointers, so a palm iPadOS
 *    fails to reject can drag the sampled point — a real-device QA item, not
 *    something a simulator can show.
 *  - FINGER (finger-draw on): the stroke is abandoned. A second finger is a
 *    pinch far more often than a palm, and because this pan activates on
 *    touch-down, the first finger has already started a stroke by the time the
 *    second lands. So the live points are cleared, the pan fails (onStrokeCancel,
 *    never onStrokeEnd), and the board's pinch — already a simultaneous relation
 *    — zooms. Two fingers landing together never start a stroke at all.
 *
 * Samples are converted to board px on the UI thread — the worklet twin of
 * `screenToBoardPoint` in `stroke.ts`, inlined because reanimated can't reliably
 * call a cross-module worklet (same split as `use-zoomed-hold-tap-gesture`).
 * Absolute event coordinates, never `translationX/Y`: a delta would accumulate
 * the zoom scale twice.
 *
 * Add opts into a Manual recognizer that samples the owned raw pointer,
 * avoiding Pan centroid movement and committing stationary matching UP events.
 * Trace retains the Pan behavior above.
 *
 * `runOnJS` fires at most twice per stroke (start, then end or cancel) — never
 * per frame.
 */
export const DrawStrokeOverlay = React.memo(function DrawStrokeOverlay({
  pointsSV,
  acceptStationaryTaps = false,
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
  loupe,
}: DrawStrokeOverlayProps) {
  // Mirrored into a shared value rather than captured: a captured number would
  // have to be a gesture dependency, and rebuilding a live RNGH gesture
  // mid-session has wedged iOS before (see use-zoom-pan-gesture).
  const boardScaleSV = useSharedValue(boardScale);
  // True between activation and finalize. Lives on the UI thread because the
  // activation worklet has to read it on the very next touch-down.
  const isDrawingSV = useSharedValue(false);
  // Whether the live stroke was started by a stylus — the answer to what a
  // second touch means (see the component doc).
  const strokeIsStylusSV = useSharedValue(false);
  // Set when a finger stroke is dropped for a pinch, so a pan that RNGH still
  // reports as a success cannot commit the cleared stroke.
  const abandonedSV = useSharedValue(false);
  const ownerPointerIdSV = useSharedValue(-1);
  /** When the live stroke's first pointer landed, for the loupe's delay. */
  const strokeDownAtSV = useSharedValue(0);
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
    /** Points the loupe at a finger stroke's pointer. Never for a stylus. */
    const followWithLoupe = (screenX: number, screenY: number) => {
      'worklet';
      if (strokeIsStylusSV.value) return;
      trackLoupe(
        loupe,
        strokeDownAtSV.value,
        screenX,
        screenY,
        scaleSV.value,
        translateXSV.value,
        translateYSV.value,
        containerWidthSV.value,
        containerHeightSV.value,
      );
    };
    if (acceptStationaryTaps) {
      // A manually activated UIPan recognizer need not deliver onStart/onEnd
      // for a stationary touch. Add owns raw pointer events instead: DOWN seeds
      // a stroke and its matching UP commits it, including a zero-length tap.
      const appendSample = (screenX: number, screenY: number) => {
        'worklet';
        const centreX = containerWidthSV.value / 2;
        const centreY = containerHeightSV.value / 2;
        const boardX = ((screenX - translateXSV.value - centreX) / scaleSV.value + centreX) * boardScaleSV.value;
        const boardY = ((screenY - translateYSV.value - centreY) / scaleSV.value + centreY) * boardScaleSV.value;
        const current = pointsSV.value;
        const count = current.length;
        if (count >= MAX_STROKE_NUMBERS) return;
        if (count > 0) {
          const deltaX = boardX - current[count - 2];
          const deltaY = boardY - current[count - 1];
          if (deltaX * deltaX + deltaY * deltaY < MIN_SAMPLE_DISTANCE_SQUARED) return;
        }
        pointsSV.value = [...current, boardX, boardY];
      };
      const cancelStroke = () => {
        'worklet';
        if (!isDrawingSV.value) return;
        // Clear ownership before fail/end: either can synchronously finalize.
        isDrawingSV.value = false;
        ownerPointerIdSV.value = -1;
        pointsSV.value = [];
        stopLoupe(loupe);
        runOnJS(handleCancel)();
      };
      const manual = Gesture.Manual()
        .onTouchesDown((event, manager) => {
          'worklet';
          if (isDrawingSV.value) {
            // Ignore palm touches before considering a second finger pinch.
            if (strokeIsStylusSV.value) return;
            cancelStroke();
            manager.fail();
            return;
          }
          const isStylus = event.pointerType === STYLUS_POINTER_TYPE;
          const pointer = event.changedTouches[0];
          if (!pointer || (!isStylus && (!fingerDrawSV.value || event.numberOfTouches > 1))) {
            manager.fail();
            return;
          }
          ownerPointerIdSV.value = pointer.id;
          strokeIsStylusSV.value = isStylus;
          strokeDownAtSV.value = Date.now();
          isDrawingSV.value = true;
          pointsSV.value = [];
          appendSample(pointer.x, pointer.y);
          followWithLoupe(pointer.x, pointer.y);
          runOnJS(handleStart)();
          manager.begin();
          manager.activate();
        })
        .onTouchesMove((event, manager) => {
          'worklet';
          if (!isDrawingSV.value) return;
          if (!strokeIsStylusSV.value && event.numberOfTouches > 1) {
            cancelStroke();
            manager.fail();
            return;
          }
          const pointer = event.changedTouches.find((touch) => touch.id === ownerPointerIdSV.value);
          if (!pointer) return;
          appendSample(pointer.x, pointer.y);
          followWithLoupe(pointer.x, pointer.y);
        })
        .onTouchesUp((event, manager) => {
          'worklet';
          if (!isDrawingSV.value) return;
          // changedTouches identifies the released pointer even when iOS
          // allTouches still includes it in the pre-unregister snapshot.
          const pointer = event.changedTouches.find((touch) => touch.id === ownerPointerIdSV.value);
          if (!pointer) return;
          appendSample(pointer.x, pointer.y);
          isDrawingSV.value = false;
          ownerPointerIdSV.value = -1;
          stopLoupe(loupe);
          runOnJS(handleEnd)(pointsSV.value);
          manager.end();
        })
        .onTouchesCancelled((event, manager) => {
          'worklet';
          if (!isDrawingSV.value) return;
          if (
            event.changedTouches.length > 0 &&
            !event.changedTouches.some((touch) => touch.id === ownerPointerIdSV.value)
          )
            return;
          cancelStroke();
          manager.fail();
        })
        .onFinalize(() => {
          'worklet';
          // Unexpected native interruption cancels once; an UP/fail has already
          // released ownership and cannot be committed again by late callbacks.
          cancelStroke();
          stopLoupe(loupe);
        });
      manual.simultaneousWithExternalGesture(pinchRef);
      return manual;
    }
    const pan = Gesture.Pan()
      .minPointers(1)
      .manualActivation(true)
      .onTouchesDown((event, manager) => {
        'worklet';
        if (isDrawingSV.value) {
          // A stylus stroke is live: a second touch (typically the palm) must
          // neither restart nor fail it.
          if (strokeIsStylusSV.value) return;
          // A finger stroke is live and another finger landed: that's a pinch.
          // Drop the stroke and step aside for the board's zoom.
          abandonedSV.value = true;
          pointsSV.value = [];
          stopLoupe(loupe);
          manager.fail();
          return;
        }
        const isStylus = event.pointerType === STYLUS_POINTER_TYPE;
        // Two fingers at once are a pinch from the start, not a stroke.
        if (isStylus || (fingerDrawSV.value && event.numberOfTouches < 2)) {
          isDrawingSV.value = true;
          strokeIsStylusSV.value = isStylus;
          strokeDownAtSV.value = Date.now();
          abandonedSV.value = false;
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
        followWithLoupe(event.x, event.y);
        runOnJS(handleStart)();
      })
      .onUpdate((event) => {
        'worklet';
        followWithLoupe(event.x, event.y);
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
        if (!success || abandonedSV.value) return;
        runOnJS(handleEnd)(pointsSV.value);
      })
      .onFinalize((_event, success) => {
        'worklet';
        isDrawingSV.value = false;
        stopLoupe(loupe);
        const abandoned = abandonedSV.value;
        abandonedSV.value = false;
        if (success && !abandoned) return;
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
    acceptStationaryTaps,
    loupe,
    strokeDownAtSV,
    ownerPointerIdSV,
    pointsSV,
    fingerDrawSV,
    scaleSV,
    translateXSV,
    translateYSV,
    containerWidthSV,
    containerHeightSV,
    boardScaleSV,
    isDrawingSV,
    strokeIsStylusSV,
    abandonedSV,
    pinchRef,
  ]);

  return (
    <GestureDetector gesture={gesture}>
      <View collapsable={false} style={StyleSheet.absoluteFill} />
    </GestureDetector>
  );
});
