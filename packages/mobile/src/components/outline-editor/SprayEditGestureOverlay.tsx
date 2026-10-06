import React, { useCallback, useEffect, useMemo, useRef, type MutableRefObject } from 'react';
import { StyleSheet, View, type AccessibilityActionEvent, type AccessibilityActionInfo } from 'react-native';
import { Gesture, GestureDetector, type GestureType } from 'react-native-gesture-handler';
import { runOnJS, useSharedValue, type SharedValue } from 'react-native-reanimated';
import { fallbackRadiusAt, holdIdAtPoint, screenToBoard, selectedDragIdAt } from './spray-gesture-math';

/**
 * Tap window, matching the board's own hold taps (`use-zoomed-hold-tap-gesture`)
 * so a tap on this editor feels like a tap on every other board.
 */
const TAP_MAX_DURATION_MS = 300;
const TAP_MAX_DISTANCE_PX = 15;
/** How long a finger rests on a ring before it is picked up, or on bare wall before a hold is placed. */
const PICK_UP_MIN_DURATION_MS = 400;
/** How far a finger may wander before a pick-up is abandoned. RNGH's own long-press default. */
const PICK_UP_MAX_DISTANCE_PX = 10;
/** How far a picked-up ring's finger moves before the drag takes over. Under the board pan's 8 px. */
const PICK_UP_DRAG_SLOP_PX = 4;

/** What a screen reader hears, and can do, on the wall. Memoise it: the overlay is `React.memo`'d. */
export type SprayWallAccessibility = {
  /** The wall and its counts. */
  label: string;
  /** The cursor's hold — "Hold 12 of 213, on" — or that there is none. */
  value: string;
  hint: string;
  /** `increment`, `decrement`, `activate` and the named hold actions. */
  actions: readonly AccessibilityActionInfo[];
  /**
   * An action fired. `viewCentreX/Y` is the middle of the visible board in board
   * px, for an action that needs a place and has no finger to give one.
   * `activate` is routed here from both platforms' double tap.
   */
  onAction: (actionName: string, viewCentreX: number, viewCentreY: number) => void;
};

type SprayEditGestureOverlayProps = {
  /** The board's live zoom transform, from `FilterBoardTransformContext`. */
  scaleSV: SharedValue<number>;
  translateXSV: SharedValue<number>;
  translateYSV: SharedValue<number>;
  containerWidthSV: SharedValue<number>;
  containerHeightSV: SharedValue<number>;
  isPinchingSV: SharedValue<boolean>;
  /** Declared as a relation, never composed — see `FilterBoardTransformContext.pinchGesture`. */
  pinchRef: MutableRefObject<GestureType | undefined>;
  /** Board px per render px. */
  boardScale: number;
  /** Every ring a long press can pick up, as `[id, cx, cy, r, ...]` in board px. */
  hitHoldsSV: SharedValue<number[]>;
  /** The selected hold as `[id, cx, cy, r]`, or empty. Written by the screen AND by a pick-up. */
  selectedHoldSV: SharedValue<number[]>;
  /** The live move preview, in board px. `SelectedHoldOverlay` draws it. */
  dragOffsetXSV: SharedValue<number>;
  dragOffsetYSV: SharedValue<number>;
  /**
   * The hold a drag is moving right now, 0 when none. Written only here; read by
   * `SelectedHoldOverlay` so a selection that lands mid-drag does not zero the
   * live offset under the finger.
   */
  dragHoldIdSV: SharedValue<number>;
  /** False while Join is waiting for its second hold: taps still count, drags and pick-ups do not. */
  canMove: boolean;
  /**
   * The wall is under the hold cap. False makes a press and hold on bare wall
   * step aside at touch-down, like any other touch with nothing to do.
   */
  canAdd: boolean;
  /** The wall's median radius in board px: the size a press and hold places. Mirrored by the screen. */
  medianRadiusSV: SharedValue<number>;
  /**
   * The hold a press and hold is placing, `[x, y, r]` in board px, or empty.
   * Written here as the finger slides; `SprayPlacementPreview` draws it, and the
   * screen clears it once the placed hold has rendered (or was refused).
   */
  placeHoldSV: SharedValue<number[]>;
  /**
   * The screen-reader path. The rings are one drawing, not one view each, so the
   * wall is ONE adjustable element: swipe up / down walks a cursor through the
   * holds (the screen selects each, which brings up the chip bar), a double tap
   * switches the cursor's hold, and the named actions mirror the chips.
   */
  accessibility: SprayWallAccessibility;
  /** A tap at a board point; `zoom` is the board scale at the time, for the hit-test fallback. */
  onTap: (boardX: number, boardY: number, zoom: number) => void;
  /** A long press landed on this ring. */
  onPickUp: (holdId: number) => void;
  /** A drag of this ring ended this far from where it started, in board px. */
  onMoveEnd: (holdId: number, deltaX: number, deltaY: number) => void;
  /** A press and hold on bare wall has just put a circle under the finger. */
  onPlaceStart: () => void;
  /** That finger lifted here, in board px: place the hold. */
  onPlace: (boardX: number, boardY: number) => void;
};

/**
 * The hold editor's one gesture surface: tap, pick up, move, and press and hold
 * to place.
 *
 * Three gestures race on one full-bleed view, all of them single-finger and all
 * of them `simultaneousWithExternalGesture(pinchRef)` so a pinch always zooms —
 * two fingers never edit. Each also bails on `isPinchingSV`, because being
 * simultaneous with the pinch means the pinch no longer fails them.
 *
 * - **Tap** (≤ 300 ms, ≤ 15 px): handed to JS as a board point; the screen's
 *   tested hit test decides what it meant.
 * - **Pick up / place** (a 400 ms rest): on a ring, it selects that ring and arms
 *   the drag, so the same touch can carry straight on into a move. On bare wall
 *   it PLACES a hold instead: a median-size circle appears under the finger
 *   (`placeHoldSV`), slides with it, and lands where the finger lifts — one
 *   `onPlace`. It steps aside at touch-down only when there is nothing it could
 *   do: Join waiting, a second finger, or bare wall on a wall at the hold cap.
 *   A zoomed board's pan still wins a finger that moves: the pan activates at
 *   8 px, inside this gesture's 10 px allowance.
 * - **Drag** (`manualActivation`): claims the touch AT TOUCH-DOWN when it lands
 *   on the selected ring by the full hit test (a neighbour inside a big
 *   selection's grab radius is the neighbour's touch) — which is what beats the zoomed board's own one-finger
 *   pan to it — and otherwise waits for a pick-up, failing as soon as the
 *   finger wanders without one so the board's pan (when zoomed) takes over. A
 *   drag that barely moved is a tap on the selected ring, and is reported as one.
 *
 * Mounted through `renderAboveBoard`, so while zoomed it is a child of the
 * board's pan overlay and a touch this surface declines falls through to that
 * pan; at rest there is no pan and a one-finger drag off the selection simply
 * does nothing.
 *
 * The move preview runs entirely on the UI thread through the shared values
 * above. `runOnJS` fires only when a gesture starts or ends — never per frame.
 */
export const SprayEditGestureOverlay = React.memo(function SprayEditGestureOverlay({
  scaleSV,
  translateXSV,
  translateYSV,
  containerWidthSV,
  containerHeightSV,
  isPinchingSV,
  pinchRef,
  boardScale,
  hitHoldsSV,
  selectedHoldSV,
  dragOffsetXSV,
  dragOffsetYSV,
  dragHoldIdSV,
  canMove,
  canAdd,
  medianRadiusSV,
  placeHoldSV,
  accessibility,
  onTap,
  onPickUp,
  onMoveEnd,
  onPlaceStart,
  onPlace,
}: SprayEditGestureOverlayProps) {
  // Mirrored into shared values rather than captured: a captured value would be
  // a gesture dependency, and rebuilding a live RNGH gesture mid-session has
  // wedged iOS before (see use-zoom-pan-gesture).
  const boardScaleSV = useSharedValue(boardScale);
  const canMoveSV = useSharedValue(canMove);
  useEffect(() => {
    boardScaleSV.value = boardScale;
  }, [boardScale, boardScaleSV]);
  useEffect(() => {
    canMoveSV.value = canMove;
  }, [canMove, canMoveSV]);
  const canAddSV = useSharedValue(canAdd);
  useEffect(() => {
    canAddSV.value = canAdd;
  }, [canAdd, canAddSV]);

  /** The ring a long press is resting on, from touch-down; 0 for none. */
  const pickUpIdSV = useSharedValue(0);
  /** The long press fired during this touch. */
  const pickedUpSV = useSharedValue(false);
  /** The drag claimed the touch because it started on the selection. */
  const startedOnSelectionSV = useSharedValue(false);
  /** A second finger landed mid-drag: throw the move away. */
  const dragAbandonedSV = useSharedValue(false);
  const touchStartXSV = useSharedValue(0);
  const touchStartYSV = useSharedValue(0);
  const touchStartMsSV = useSharedValue(0);
  const dragActiveSV = useSharedValue(false);
  /** The press started on bare wall: if it rests long enough, it places a hold. */
  const placeArmedSV = useSharedValue(false);
  /** A placement is live: the circle is under the finger. */
  const placingSV = useSharedValue(false);
  /** Where the press started, in board px — the placed circle's origin before any slide. */
  const placeStartXSV = useSharedValue(0);
  const placeStartYSV = useSharedValue(0);

  const callbacksRef = useRef({
    onTap,
    onPickUp,
    onMoveEnd,
    onPlaceStart,
    onPlace,
    onAccessibilityAction: accessibility.onAction,
  });
  callbacksRef.current = {
    onTap,
    onPickUp,
    onMoveEnd,
    onPlaceStart,
    onPlace,
    onAccessibilityAction: accessibility.onAction,
  };
  // Captured once by the gesture memo — only close over the stable ref.
  const handleTap = (boardX: number, boardY: number, zoom: number) => callbacksRef.current.onTap(boardX, boardY, zoom);
  const handlePickUp = (holdId: number) => callbacksRef.current.onPickUp(holdId);
  const handleMoveEnd = (holdId: number, deltaX: number, deltaY: number) =>
    callbacksRef.current.onMoveEnd(holdId, deltaX, deltaY);
  const handlePlaceStart = () => callbacksRef.current.onPlaceStart();
  const handlePlace = (boardX: number, boardY: number) => callbacksRef.current.onPlace(boardX, boardY);

  const gesture = useMemo(() => {
    /** The finger lifted on a live placement: hand it to JS, which clears the preview once the hold is in. */
    const commitPlacement = () => {
      'worklet';
      const placing = placeHoldSV.value;
      placingSV.value = false;
      if (placing.length >= 3) runOnJS(handlePlace)(placing[0], placing[1]);
    };
    /** A second finger or a pinch took the touch: the circle goes, nothing is placed. */
    const abandonPlacement = () => {
      'worklet';
      if (!placingSV.value) return;
      placingSV.value = false;
      placeHoldSV.value = [];
    };

    const tap = Gesture.Tap()
      .maxDuration(TAP_MAX_DURATION_MS)
      .maxDistance(TAP_MAX_DISTANCE_PX)
      .onTouchesDown((event, manager) => {
        'worklet';
        // Every finger on the board lands on this full-bleed view, so the tap can
        // see a second one itself: that is a pinch starting, never an edit. Its
        // own count, not only the pinch's shared flag, so a tap can never be
        // swallowed by a flag another handler failed to clear.
        if (event.numberOfTouches > 1) manager.fail();
      })
      .onStart((event) => {
        'worklet';
        if (isPinchingSV.value) return;
        const point = screenToBoard(
          event.x,
          event.y,
          scaleSV.value,
          translateXSV.value,
          translateYSV.value,
          containerWidthSV.value,
          containerHeightSV.value,
          boardScaleSV.value,
        );
        runOnJS(handleTap)(point.x, point.y, scaleSV.value);
      });

    const pickUp = Gesture.LongPress()
      .minDuration(PICK_UP_MIN_DURATION_MS)
      .maxDistance(PICK_UP_MAX_DISTANCE_PX)
      .onTouchesDown((event, manager) => {
        'worklet';
        pickedUpSV.value = false;
        pickUpIdSV.value = 0;
        placeArmedSV.value = false;
        const touch = event.allTouches[0];
        // Not `isPinchingSV` here: it is cleared by the pinch's own touch-down for
        // a fresh single finger, which may run after this one.
        if (!canMoveSV.value || event.numberOfTouches > 1 || !touch) {
          manager.fail();
          return;
        }
        const point = screenToBoard(
          touch.x,
          touch.y,
          scaleSV.value,
          translateXSV.value,
          translateYSV.value,
          containerWidthSV.value,
          containerHeightSV.value,
          boardScaleSV.value,
        );
        const holdId = holdIdAtPoint(
          hitHoldsSV.value,
          point.x,
          point.y,
          fallbackRadiusAt(boardScaleSV.value, scaleSV.value),
        );
        if (holdId === 0) {
          // Bare wall: a rest here places a hold. At the cap there is nothing to
          // place, so step aside at once rather than sit on the touch for 400 ms.
          if (!canAddSV.value) {
            manager.fail();
            return;
          }
          placeArmedSV.value = true;
          placeStartXSV.value = point.x;
          placeStartYSV.value = point.y;
          return;
        }
        pickUpIdSV.value = holdId;
      })
      .onStart(() => {
        'worklet';
        if (placeArmedSV.value) {
          if (isPinchingSV.value || dragActiveSV.value) return;
          placeHoldSV.value = [placeStartXSV.value, placeStartYSV.value, medianRadiusSV.value];
          placingSV.value = true;
          // Lets the drag below take over once the finger slides, exactly as a pick-up does.
          pickedUpSV.value = true;
          runOnJS(handlePlaceStart)();
          return;
        }
        const holdId = pickUpIdSV.value;
        if (holdId === 0 || isPinchingSV.value) return;
        // The drag already claimed this touch for the selected hold: picking up
        // a different ring now would select one hold while the drag moves the
        // other. The touch stays the drag's.
        if (dragActiveSV.value && dragHoldIdSV.value !== holdId) return;
        const flat = hitHoldsSV.value;
        for (let index = 0; index + 3 < flat.length; index += 4) {
          if (flat[index] !== holdId) continue;
          // Written here as well as by the screen, so a move that starts before
          // JS has re-rendered the selection still drags from the right place.
          selectedHoldSV.value = [holdId, flat[index + 1], flat[index + 2], flat[index + 3]];
          dragOffsetXSV.value = 0;
          dragOffsetYSV.value = 0;
          break;
        }
        pickedUpSV.value = true;
        runOnJS(handlePickUp)(holdId);
      });

    const drag = Gesture.Pan()
      .manualActivation(true)
      .onTouchesDown((event, manager) => {
        'worklet';
        if (dragActiveSV.value) {
          // A second finger mid-drag is the start of a pinch. The pinch has it;
          // this move is abandoned rather than committed at a centroid nobody
          // meant.
          if (event.numberOfTouches > 1) {
            dragAbandonedSV.value = true;
            dragOffsetXSV.value = 0;
            dragOffsetYSV.value = 0;
            abandonPlacement();
            manager.end();
          }
          return;
        }
        const touch = event.allTouches[0];
        // Not `isPinchingSV` here: it is cleared by the pinch's own touch-down for
        // a fresh single finger, which may run after this one.
        if (!canMoveSV.value || event.numberOfTouches > 1 || !touch) {
          // A second finger on a circle still resting where it was placed.
          abandonPlacement();
          manager.fail();
          return;
        }
        dragHoldIdSV.value = 0;
        dragAbandonedSV.value = false;
        startedOnSelectionSV.value = false;
        touchStartXSV.value = touch.x;
        touchStartYSV.value = touch.y;
        touchStartMsSV.value = Date.now();
        const point = screenToBoard(
          touch.x,
          touch.y,
          scaleSV.value,
          translateXSV.value,
          translateYSV.value,
          containerWidthSV.value,
          containerHeightSV.value,
          boardScaleSV.value,
        );
        // Claimed at touch-down only when the finger is ON the selected hold by
        // the same hit test a tap uses — see `selectedDragIdAt`.
        const claimedId = selectedDragIdAt(
          hitHoldsSV.value,
          selectedHoldSV.value,
          point.x,
          point.y,
          fallbackRadiusAt(boardScaleSV.value, scaleSV.value),
        );
        if (claimedId !== 0) {
          startedOnSelectionSV.value = true;
          dragHoldIdSV.value = claimedId;
          dragActiveSV.value = true;
          manager.activate();
        }
      })
      .onTouchesMove((event, manager) => {
        'worklet';
        if (dragActiveSV.value) return;
        const touch = event.allTouches[0];
        if (!touch) return;
        const moved = Math.hypot(touch.x - touchStartXSV.value, touch.y - touchStartYSV.value);
        if (pickedUpSV.value && (pickUpIdSV.value !== 0 || placingSV.value)) {
          if (moved < PICK_UP_DRAG_SLOP_PX) return;
          dragHoldIdSV.value = pickUpIdSV.value;
          dragActiveSV.value = true;
          manager.activate();
          return;
        }
        // Wandering with nothing picked up is a pan (zoomed) or nothing (at
        // rest). Either way it is not this gesture's.
        if (moved > PICK_UP_MAX_DISTANCE_PX) manager.fail();
      })
      .onTouchesUp((_event, manager) => {
        'worklet';
        if (dragActiveSV.value) return;
        // A placement that never slid lands where it was placed.
        if (placingSV.value) commitPlacement();
        // A touch that never became a drag ends here, rather than leaving the pan
        // sitting in BEGAN.
        manager.fail();
      })
      .onUpdate((event) => {
        'worklet';
        if (dragAbandonedSV.value || isPinchingSV.value) return;
        const scale = scaleSV.value;
        if (placingSV.value) {
          const placing = placeHoldSV.value;
          placeHoldSV.value = [
            placeStartXSV.value + (event.translationX / scale) * boardScaleSV.value,
            placeStartYSV.value + (event.translationY / scale) * boardScaleSV.value,
            placing.length >= 3 ? placing[2] : medianRadiusSV.value,
          ];
          return;
        }
        dragOffsetXSV.value = (event.translationX / scale) * boardScaleSV.value;
        dragOffsetYSV.value = (event.translationY / scale) * boardScaleSV.value;
      })
      .onEnd((event) => {
        'worklet';
        if (placingSV.value) {
          if (dragAbandonedSV.value || isPinchingSV.value) abandonPlacement();
          else commitPlacement();
          return;
        }
        const holdId = dragHoldIdSV.value;
        if (dragAbandonedSV.value || isPinchingSV.value || holdId === 0) {
          dragOffsetXSV.value = 0;
          dragOffsetYSV.value = 0;
          return;
        }
        const moved = Math.hypot(event.translationX, event.translationY);
        if (moved < TAP_MAX_DISTANCE_PX) {
          dragOffsetXSV.value = 0;
          dragOffsetYSV.value = 0;
          // Claimed at touch-down, so the Tap in this race never saw it: a quick
          // still touch on the selected ring is reported as the tap it was.
          if (startedOnSelectionSV.value && Date.now() - touchStartMsSV.value <= TAP_MAX_DURATION_MS) {
            const point = screenToBoard(
              touchStartXSV.value,
              touchStartYSV.value,
              scaleSV.value,
              translateXSV.value,
              translateYSV.value,
              containerWidthSV.value,
              containerHeightSV.value,
              boardScaleSV.value,
            );
            runOnJS(handleTap)(point.x, point.y, scaleSV.value);
          }
          return;
        }
        const deltaX = dragOffsetXSV.value;
        const deltaY = dragOffsetYSV.value;
        // Fold the offset into the preview's base in the same UI frame, so the
        // ring stays exactly where the finger left it while JS commits the move.
        const selected = selectedHoldSV.value;
        if (selected.length >= 4 && selected[0] === holdId) {
          selectedHoldSV.value = [holdId, selected[1] + deltaX, selected[2] + deltaY, selected[3]];
        }
        dragOffsetXSV.value = 0;
        dragOffsetYSV.value = 0;
        runOnJS(handleMoveEnd)(holdId, deltaX, deltaY);
      })
      .onFinalize(() => {
        'worklet';
        // Anything still placing here was cancelled from outside (the board's pan
        // won the touch, the system took it): no hold.
        abandonPlacement();
        placeArmedSV.value = false;
        dragActiveSV.value = false;
        dragHoldIdSV.value = 0;
        pickedUpSV.value = false;
        pickUpIdSV.value = 0;
      });

    // Relations on the board's pinch, never compositions of it, so a two-finger
    // zoom recognises while a finger sits here without this detector claiming
    // the pinch's handler tag.
    tap.simultaneousWithExternalGesture(pinchRef);
    pickUp.simultaneousWithExternalGesture(pinchRef);
    drag.simultaneousWithExternalGesture(pinchRef);

    // The pick-up and the drag run together — the drag has to be tracking the
    // touch when the pick-up fires so the same finger can carry on into a move.
    // Both race the tap: a tap wins a quick still touch, and either of the other
    // two activating cancels it.
    return Gesture.Race(Gesture.Simultaneous(pickUp, drag), tap);
    // handleTap/handlePickUp/handleMoveEnd/handlePlaceStart/handlePlace are intentionally not deps — captured
    // once and read render-scoped values through callbacksRef.
  }, [
    scaleSV,
    translateXSV,
    translateYSV,
    containerWidthSV,
    containerHeightSV,
    isPinchingSV,
    pinchRef,
    boardScaleSV,
    canMoveSV,
    canAddSV,
    medianRadiusSV,
    placeHoldSV,
    placeArmedSV,
    placingSV,
    placeStartXSV,
    placeStartYSV,
    hitHoldsSV,
    selectedHoldSV,
    dragOffsetXSV,
    dragOffsetYSV,
    pickUpIdSV,
    pickedUpSV,
    dragHoldIdSV,
    startedOnSelectionSV,
    dragAbandonedSV,
    touchStartXSV,
    touchStartYSV,
    touchStartMsSV,
    dragActiveSV,
  ]);

  const fireAccessibilityAction = useCallback(
    (actionName: string) => {
      const containerWidth = containerWidthSV.value;
      const containerHeight = containerHeightSV.value;
      const centre = screenToBoard(
        containerWidth / 2,
        containerHeight / 2,
        scaleSV.value,
        translateXSV.value,
        translateYSV.value,
        containerWidth,
        containerHeight,
        boardScaleSV.value,
      );
      callbacksRef.current.onAccessibilityAction(actionName, centre.x, centre.y);
    },
    [containerWidthSV, containerHeightSV, scaleSV, translateXSV, translateYSV, boardScaleSV],
  );
  const handleAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => fireAccessibilityAction(event.nativeEvent.actionName),
    [fireAccessibilityAction],
  );
  // iOS on Fabric sends a VoiceOver double tap to `onAccessibilityTap` only,
  // never as the `activate` action; Android sends it as the action. Both land on
  // the screen's `activate`, which acts on the cursor's hold and nothing else.
  // Handling it at all is what stops iOS falling back to a synthetic touch at
  // the view's centre — which the tap gesture would read as an edit to
  // whichever hold happens to sit there.
  const handleAccessibilityTap = useCallback(() => fireAccessibilityAction('activate'), [fireAccessibilityAction]);

  return (
    <GestureDetector gesture={gesture}>
      <View
        collapsable={false}
        style={StyleSheet.absoluteFill}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={accessibility.label}
        accessibilityValue={{ text: accessibility.value }}
        accessibilityHint={accessibility.hint}
        accessibilityActions={accessibility.actions}
        onAccessibilityAction={handleAccessibilityAction}
        onAccessibilityTap={handleAccessibilityTap}
      />
    </GestureDetector>
  );
});
