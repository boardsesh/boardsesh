import React, { useEffect, useMemo, useRef, type MutableRefObject } from 'react';
import { StyleSheet, View } from 'react-native';
import {
  Gesture,
  GestureDetector,
  PointerType,
  type GestureStateManager,
  type GestureType,
} from 'react-native-gesture-handler';
import { runOnJS, useSharedValue, type SharedValue } from 'react-native-reanimated';
import { fallbackRadiusAt, selectedDragIdAt, strokeReturnsToHead } from './spray-gesture-math';
import { CORNERS_CLOSE_TARGET_PT } from './spray-hold-tools';
import { STROKE_MIN_SAMPLE_BOARD_PX } from './stroke';
import { stopLoupe, trackLoupe, useReleaseLoupeOnUnmount, type SprayLoupeFeed } from './spray-loupe-feed';

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
   * End the stroke the moment it comes back round to where it started
   * (`strokeReturnsToHead`), instead of on lift. On by default: every stroke
   * here is an outline, and movement after closing the loop only drags a tail
   * past the start. Off for a tool that paints rather than outlines (spray
   * Refine), whose strokes cross themselves on purpose.
   */
  closeOnReturn?: boolean;
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
  /**
   * OPT-IN, for the spray editor's resting Pencil surface. The selected hold as
   * `[id, cx, cy, r]` in board px, or empty for none. A drawing touch that lands
   * inside that hold's grab radius (`r`, or a fingertip at the current zoom when
   * that is bigger) fails at touch-down instead of drawing, so an
   * ANCESTOR gesture can claim it — the spray editor's move, which is how a
   * Pencil stroke that starts on the selected ring carries the ring rather than
   * drawing a new one. Omitted, every drawing touch draws (the catalogue editor
   * and the spray Trace / Add tools).
   */
  declineOnSelectionSV?: SharedValue<number[]>;
  /**
   * The wall's flat hit list (`[id, cx, cy, r, ...]`), read with
   * `declineOnSelectionSV`. A touch inside the selection's grab radius that the
   * full hit test gives to a smaller or nearer neighbour is NOT the move's
   * (`selectedDragIdAt`), so it draws rather than being declined into nothing.
   * Omitted, the grab radius alone decides.
   */
  declineHitHoldsSV?: SharedValue<number[]>;
  /**
   * OPT-IN. Fired once per mount, at the first stylus touch-down (drawing or
   * declined), so a screen can notice an Apple Pencil exists. Whether it is
   * listened for is fixed at mount.
   */
  onStylusSeen?: () => void;
  /**
   * OPT-IN. Written with the board's zoom on the UI thread when a stroke
   * starts, before its first sample, for a tool whose brush is sized in screen
   * points at that zoom (spray Refine): its preview and its commit then read
   * the same zoom, even if a pinch moves the board mid-stroke.
   */
  strokeZoomSV?: SharedValue<number>;
};

/** No hit list: the selection's grab radius alone decides a decline. */
const NO_HIT_HOLDS: number[] = [];

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
 * A stroke that comes back round to its first sample ends right there, as if
 * the pointer had lifted (`closeOnReturn`, on unless a caller paints rather
 * than outlines). Add commits from its MOVE; Trace's pan can't end itself from
 * onUpdate, so it flags the return and the next touch move ends the pan.
 *
 * Three opt-in props exist for the spray editor's iPad Pencil surface and
 * change nothing when omitted: `declineOnSelectionSV` (with
 * `declineHitHoldsSV`) steps aside at touch-down for a touch the edit
 * overlay's move claims, and `onStylusSeen` reports the first stylus. The
 * decline calls the move's own `selectedDragIdAt` from `spray-gesture-math`,
 * whose functions carry the `'worklet'` directive, so the two rules cannot drift.
 *
 * `runOnJS` fires at most twice per stroke (start, then end or cancel) — never
 * per frame — plus once per mount for `onStylusSeen`.
 */
export const DrawStrokeOverlay = React.memo(function DrawStrokeOverlay({
  pointsSV,
  acceptStationaryTaps = false,
  closeOnReturn = true,
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
  declineOnSelectionSV,
  declineHitHoldsSV,
  onStylusSeen,
  strokeZoomSV,
}: DrawStrokeOverlayProps) {
  // Mirrored into a shared value rather than captured: a captured number would
  // have to be a gesture dependency, and rebuilding a live RNGH gesture
  // mid-session has wedged iOS before (see use-zoom-pan-gesture).
  const boardScaleSV = useSharedValue(boardScale);
  // Mirrored for the same reason as boardScale.
  const closeOnReturnSV = useSharedValue(closeOnReturn);
  // How far the live stroke has reached from its first sample, in board px —
  // kept as it grows so the close test never rescans the stroke per frame.
  const farthestSV = useSharedValue(0);
  // Trace only: the stroke came back to its start in onUpdate, which can't end
  // a gesture; the next touch move ends it (see the pan below).
  const returnedSV = useSharedValue(false);
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
  useReleaseLoupeOnUnmount(loupe, strokeDownAtSV);
  // Starts "already reported" when nobody listens, so the catalogue editor
  // never makes the hop to JS at all.
  const stylusReportedSV = useSharedValue(onStylusSeen == null);
  useEffect(() => {
    boardScaleSV.value = boardScale;
  }, [boardScale, boardScaleSV]);
  useEffect(() => {
    closeOnReturnSV.value = closeOnReturn;
  }, [closeOnReturn, closeOnReturnSV]);

  const callbacksRef = useRef({ onStrokeStart, onStrokeEnd, onStrokeCancel, onStylusSeen });
  callbacksRef.current = { onStrokeStart, onStrokeEnd, onStrokeCancel, onStylusSeen };
  // Captured once by the gesture memo — only closes over the stable ref.
  const handleStart = () => callbacksRef.current.onStrokeStart();
  const handleEnd = (boardPoints: number[]) => callbacksRef.current.onStrokeEnd(boardPoints);
  const handleCancel = () => callbacksRef.current.onStrokeCancel();
  const handleStylusSeen = () => callbacksRef.current.onStylusSeen?.();

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
    const reportStylus = () => {
      'worklet';
      if (stylusReportedSV.value) return;
      stylusReportedSV.value = true;
      runOnJS(handleStylusSeen)();
    };
    // Whether a screen point is the move's, through the same inverse transform
    // the samples use and the move's own claim at touch-down
    // (`selectedDragIdAt`): inside the selection's grab radius (its radius or a
    // fingertip at this zoom, whichever is bigger) AND named by the full hit
    // test. Declining any less would leave a small ring claimed by both
    // gestures on the same DOWN; declining any more would leave a neighbour
    // inside that radius claimed by neither. Always false without the opt-in.
    const touchesSelection = (screenX: number, screenY: number) => {
      'worklet';
      if (declineOnSelectionSV === undefined) return false;
      const selected = declineOnSelectionSV.value;
      if (selected.length < 4) return false;
      const centreX = containerWidthSV.value / 2;
      const centreY = containerHeightSV.value / 2;
      const boardX = ((screenX - translateXSV.value - centreX) / scaleSV.value + centreX) * boardScaleSV.value;
      const boardY = ((screenY - translateYSV.value - centreY) / scaleSV.value + centreY) * boardScaleSV.value;
      const hitHolds = declineHitHoldsSV === undefined ? NO_HIT_HOLDS : declineHitHoldsSV.value;
      const fallbackRadius = fallbackRadiusAt(boardScaleSV.value, scaleSV.value);
      return selectedDragIdAt(hitHolds, selected, boardX, boardY, fallbackRadius) !== 0;
    };
    // Whether the next sample brings the live stroke back to its first one, in
    // which case it is NOT appended: the implicit closing edge from the last
    // kept sample to the head is the line the climber meant. Otherwise the
    // caller appends it, and its reach is recorded here.
    const returnsToHead = (current: number[], boardX: number, boardY: number) => {
      'worklet';
      const count = current.length;
      if (count < 2) return false;
      if (
        closeOnReturnSV.value &&
        strokeReturnsToHead(
          current[0],
          current[1],
          current[count - 2],
          current[count - 1],
          boardX,
          boardY,
          farthestSV.value,
          (CORNERS_CLOSE_TARGET_PT * boardScaleSV.value) / scaleSV.value,
        )
      ) {
        return true;
      }
      farthestSV.value = Math.max(farthestSV.value, Math.hypot(boardX - current[0], boardY - current[1]));
      return false;
    };
    if (acceptStationaryTaps) {
      // A manually activated UIPan recognizer need not deliver onStart/onEnd
      // for a stationary touch. Add owns raw pointer events instead: DOWN seeds
      // a stroke and its matching UP commits it, including a zero-length tap.
      /** Appends a kept sample; true when it closed the loop instead. */
      const appendSample = (screenX: number, screenY: number) => {
        'worklet';
        const centreX = containerWidthSV.value / 2;
        const centreY = containerHeightSV.value / 2;
        const boardX = ((screenX - translateXSV.value - centreX) / scaleSV.value + centreX) * boardScaleSV.value;
        const boardY = ((screenY - translateYSV.value - centreY) / scaleSV.value + centreY) * boardScaleSV.value;
        const current = pointsSV.value;
        const count = current.length;
        if (count >= MAX_STROKE_NUMBERS) return false;
        if (count > 0) {
          const deltaX = boardX - current[count - 2];
          const deltaY = boardY - current[count - 1];
          if (deltaX * deltaX + deltaY * deltaY < MIN_SAMPLE_DISTANCE_SQUARED) return false;
        }
        if (returnsToHead(current, boardX, boardY)) return true;
        pointsSV.value = [...current, boardX, boardY];
        return false;
      };
      /** Commits the live stroke: on UP, or the moment it closes its loop. */
      const commitStroke = (manager: GestureStateManager) => {
        'worklet';
        isDrawingSV.value = false;
        ownerPointerIdSV.value = -1;
        stopLoupe(loupe);
        runOnJS(handleEnd)(pointsSV.value);
        manager.end();
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
          if (isStylus) reportStylus();
          const pointer = event.changedTouches[0];
          if (!pointer || (!isStylus && (!fingerDrawSV.value || event.numberOfTouches > 1))) {
            manager.fail();
            return;
          }
          // On the selected hold: the ancestor's move has it.
          if (touchesSelection(pointer.x, pointer.y)) {
            manager.fail();
            return;
          }
          ownerPointerIdSV.value = pointer.id;
          strokeIsStylusSV.value = isStylus;
          strokeDownAtSV.value = Date.now();
          isDrawingSV.value = true;
          if (strokeZoomSV) strokeZoomSV.value = scaleSV.value;
          pointsSV.value = [];
          farthestSV.value = 0;
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
          // Back at the start: the outline is done, whatever the pointer does next.
          if (appendSample(pointer.x, pointer.y)) {
            commitStroke(manager);
            return;
          }
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
          commitStroke(manager);
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
          // The loop already closed and is only waiting on the move that ends
          // the pan: keep it, rather than drop a finished outline for a pinch.
          if (returnedSV.value) {
            manager.end();
            return;
          }
          // A finger stroke is live and another finger landed: that's a pinch.
          // Drop the stroke and step aside for the board's zoom.
          abandonedSV.value = true;
          pointsSV.value = [];
          stopLoupe(loupe);
          manager.fail();
          return;
        }
        const isStylus = event.pointerType === STYLUS_POINTER_TYPE;
        if (isStylus) reportStylus();
        // Two fingers at once are a pinch from the start, not a stroke.
        if (isStylus || (fingerDrawSV.value && event.numberOfTouches < 2)) {
          const touch = event.changedTouches[0] ?? event.allTouches[0];
          if (touch && touchesSelection(touch.x, touch.y)) {
            manager.fail();
            return;
          }
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
        if (strokeZoomSV) strokeZoomSV.value = scaleSV.value;
        farthestSV.value = 0;
        returnedSV.value = false;
        pointsSV.value = [renderX * boardScaleSV.value, renderY * boardScaleSV.value];
        followWithLoupe(event.x, event.y);
        runOnJS(handleStart)();
      })
      .onUpdate((event) => {
        'worklet';
        if (returnedSV.value) return;
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
        if (returnsToHead(current, boardX, boardY)) {
          returnedSV.value = true;
          return;
        }
        pointsSV.value = [...current, boardX, boardY];
      })
      .onTouchesMove((_event, manager) => {
        'worklet';
        // onUpdate can't end the pan; this does, so onEnd commits the closed
        // loop now rather than when the pointer lifts.
        if (returnedSV.value) manager.end();
      })
      .onEnd((_event, success) => {
        'worklet';
        if (!success || abandonedSV.value) return;
        runOnJS(handleEnd)(pointsSV.value);
      })
      .onFinalize((_event, success) => {
        'worklet';
        isDrawingSV.value = false;
        returnedSV.value = false;
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
    // handleStart/handleEnd/handleCancel/handleStylusSeen are intentionally not deps — they're
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
    closeOnReturnSV,
    farthestSV,
    returnedSV,
    isDrawingSV,
    strokeIsStylusSV,
    abandonedSV,
    stylusReportedSV,
    declineOnSelectionSV,
    declineHitHoldsSV,
    strokeZoomSV,
    pinchRef,
  ]);

  return (
    <GestureDetector gesture={gesture}>
      <View collapsable={false} style={StyleSheet.absoluteFill} />
    </GestureDetector>
  );
});
