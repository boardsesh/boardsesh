import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type MutableRefObject,
  type RefObject,
} from 'react';
import type { ViewStyle } from 'react-native';
import { Gesture, type GestureType } from 'react-native-gesture-handler';
import {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  cancelAnimation,
  runOnJS,
  type SharedValue,
  type AnimatedStyle,
} from 'react-native-reanimated';
import { MIN_SCALE, MAX_SCALE, ZOOM_THRESHOLD } from '@boardsesh/play-view';
import type { BoardRenderTelemetryProps } from '@boardsesh/analytics';
import { timing } from '../../theme/animations';
import { noteBoardPinch } from '../../lib/climb-view-session';

type UseZoomPanGestureOptions = {
  enabled?: boolean;
  containerWidth: number;
  containerHeight: number;
  /** When set, the 1-finger zoom-pan only activates after the finger moves this
   * many px in either axis. Use this when the pan is composed with stationary
   * tap/long-press gestures on the same overlay (the interactive boards), so a
   * slightly-sloppy stationary tap isn't stolen by the pan. Left unset, the pan
   * keeps its default activation (the play-drawer carousel relies on that). */
  panActivationOffset?: number;
  /** RNGH ref to the surrounding scroll. Declares the pinch simultaneous with it
   * so a 2-finger zoom isn't cancelled by the scroll (the plain RN ScrollView the
   * play route briefly used wasn't in RNGH's tree), and makes that scroll wait on
   * the zoomed-only pan so a downward drag pans the board instead of scrolling the
   * drawer. Typed as RNGH's GestureRef shape so the method call needs no cast. */
  scrollRef?: RefObject<ComponentType | undefined | null>;
  /** When set, the pinch gesture is tagged with this ref so the interactive
   * boards' per-hold tap/long-press detectors can mark themselves
   * `simultaneousWithExternalGesture(pinchRef)`. Without that relation, two
   * fingers landing on two different per-hold detectors each claim a pointer and
   * the ancestor pinch can't acquire both — pinch-to-zoom stalls on Android.
   * The play-drawer board has no per-hold detectors, so it leaves this unset. */
  pinchRef?: MutableRefObject<GestureType | undefined>;
  /**
   * When set, a pinch gesture that clears the minimum scale delta fires
   * `Board Pinch` (issue #2202) once at gesture end via `noteBoardPinch`. Left
   * unset on the boards this A/B doesn't care about (create-climb, search) —
   * their pinches simply don't fire the event. Read from a ref, not a gesture
   * dependency: an object that churns identity every render would recompose
   * the gesture mid-session, which has left RNGH in a bad state on iOS before
   * (see the other *SV mirrors below).
   */
  boardRenderTelemetryProps?: BoardRenderTelemetryProps;
};

type UseZoomPanGestureReturn = {
  pinchGesture: GestureType;
  zoomPanGesture: GestureType;
  isZoomed: boolean;
  isZoomedSV: SharedValue<boolean>;
  /** True while a 2-finger pinch is in progress. The interactive boards gate
   * their per-hold tap/long-press on this: those legs are
   * `simultaneousWithExternalGesture(pinchRef)`, so RNGH no longer fails them
   * when the pinch activates — without the gate a small or slow pinch could also
   * paint a hold or open the role sheet. Stays false on boards with no pinchRef. */
  isPinchingSV: SharedValue<boolean>;
  /** Live zoom scale on the UI thread, so an overlay inside the transform can
   * convert screen-pixel drag deltas into unscaled board-pixel deltas. */
  scaleSV: SharedValue<number>;
  /** Live pan translation on the UI thread. With scaleSV + the container size,
   * an overlay above the transform can invert animatedZoomStyle to map a screen
   * tap back into board-local coordinates (see use-zoomed-hold-tap-gesture). */
  translateXSV: SharedValue<number>;
  translateYSV: SharedValue<number>;
  /** Live container size on the UI thread — the transform's center origin
   * (containerWidth/2, containerHeight/2). Mirrored so the inverse-transform
   * worklet reads it without re-creating gesture objects on a layout change. */
  containerWidthSV: SharedValue<number>;
  containerHeightSV: SharedValue<number>;
  resetZoom: () => void;
  /**
   * Animate the board to an explicit transform — the programmatic twin of a
   * pinch, used by the outline editor to frame the placement being corrected.
   *
   * Writes the same shared values the gestures do, so a pan or pinch started
   * mid-flight simply takes over: both snapshot from the live animated value at
   * `onStart` and assigning a shared value cancels its running animation.
   * Callers are responsible for handing over an already-clamped transform (see
   * `zoomTargetForHold`), because nothing here re-clamps it.
   */
  zoomTo: (target: { scale: number; translateX: number; translateY: number }) => void;
  animatedZoomStyle: AnimatedStyle<ViewStyle>;
};

// Worklet-callable copy of clampTranslation from @boardsesh/play-view. The
// shared version is the canonical spec / test target; reanimated can't
// reliably call non-worklet functions across module boundaries so we keep a
// 'worklet'-marked clone here. Keep in sync.
function clampTranslation(
  translationX: number,
  translationY: number,
  currentScale: number,
  containerWidth: number,
  containerHeight: number,
): { x: number; y: number } {
  'worklet';
  if (currentScale <= 1) return { x: 0, y: 0 };

  const maxX = (containerWidth * (currentScale - 1)) / 2;
  const maxY = (containerHeight * (currentScale - 1)) / 2;

  return {
    x: Math.max(-maxX, Math.min(maxX, translationX)),
    y: Math.max(-maxY, Math.min(maxY, translationY)),
  };
}

export function useZoomPanGesture({
  enabled = true,
  containerWidth,
  containerHeight,
  panActivationOffset,
  scrollRef,
  pinchRef,
  boardRenderTelemetryProps,
}: UseZoomPanGestureOptions): UseZoomPanGestureReturn {
  const scale = useSharedValue(MIN_SCALE);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);

  const savedScale = useSharedValue(MIN_SCALE);
  const savedTranslateX = useSharedValue(0);
  const savedTranslateY = useSharedValue(0);

  const pinchFocalX = useSharedValue(0);
  const pinchFocalY = useSharedValue(0);
  // Extremes of the absolute scale reached during the CURRENT pinch gesture,
  // both reset to the starting scale at onStart. UI-thread-only arithmetic (no
  // bridge crossing), so tracking them on every onUpdate frame is cheap — the
  // bridge hop only happens once, at onEnd.
  //
  // The MIN is not decoration. The reported delta has to be signed end-minus-
  // start, because a pinch that only zooms OUT never exceeds its own starting
  // scale: a max-minus-start delta is exactly 0 for every one of them, and the
  // 0.15 jitter gate then throws the whole gesture away. Keeping both extremes
  // also lets a query tell "zoomed in, then released back out" apart from
  // "pulled straight out", which one signed number cannot.
  const pinchScaleMaxSV = useSharedValue(MIN_SCALE);
  const pinchScaleMinSV = useSharedValue(MIN_SCALE);
  // Read on the JS thread from handlePinchEnd (never from a worklet), so a
  // plain ref kept current during render is enough — no shared value needed,
  // and its identity is why handlePinchEnd itself never needs to change.
  const boardRenderTelemetryPropsRef = useRef(boardRenderTelemetryProps);
  boardRenderTelemetryPropsRef.current = boardRenderTelemetryProps;

  // Mirror JS values onto the UI thread so worklets can gate without putting
  // them in gesture useMemo deps — recomposing gestures mid-session left
  // RNGH in a bad state on iOS (swipe.onEnd stopped firing). containerHeight
  // also starts at 0 and updates after first onLayout; reading from a shared
  // value keeps the gesture objects stable across that one-shot update.
  const isZoomedSV = useSharedValue(false);
  // See isPinchingSV in the return type. Only the interactive boards (pinchRef
  // set) drive it; it stays false everywhere else.
  const isPinchingSV = useSharedValue(false);
  const enabledSV = useSharedValue(enabled);
  const containerWidthSV = useSharedValue(containerWidth);
  const containerHeightSV = useSharedValue(containerHeight);
  useEffect(() => {
    enabledSV.value = enabled;
  }, [enabled, enabledSV]);
  useEffect(() => {
    containerWidthSV.value = containerWidth;
  }, [containerWidth, containerWidthSV]);
  useEffect(() => {
    containerHeightSV.value = containerHeight;
  }, [containerHeight, containerHeightSV]);

  const [isZoomed, setIsZoomed] = useState(false);

  const updateZoomState = useCallback(
    (zoomed: boolean) => {
      isZoomedSV.value = zoomed;
      setIsZoomed(zoomed);
    },
    [isZoomedSV],
  );

  // JS-thread pinch-end telemetry (issue #2202). Reads the ref rather than
  // closing over `boardRenderTelemetryProps` directly, so this callback's own
  // identity never changes — safe to list in the gesture's useMemo deps
  // without risking a mid-session gesture recomposition (see the ref comment
  // above). No-op when the caller passed no telemetry props (the boards this
  // A/B doesn't cover); `noteBoardPinch` itself gates on the minimum scale
  // delta, so every gesture end can call this unconditionally.
  const handlePinchEnd = useCallback((scaleMax: number, scaleMin: number, scaleDelta: number) => {
    const commonProps = boardRenderTelemetryPropsRef.current;
    if (!commonProps) return;
    noteBoardPinch(commonProps, { scaleMax, scaleMin, scaleDelta });
  }, []);

  const resetZoom = useCallback(() => {
    cancelAnimation(scale);
    cancelAnimation(translateX);
    cancelAnimation(translateY);

    scale.value = withTiming(MIN_SCALE, { duration: timing.normal });
    translateX.value = withTiming(0, { duration: timing.normal });
    translateY.value = withTiming(0, { duration: timing.normal });
    savedScale.value = MIN_SCALE;
    savedTranslateX.value = 0;
    savedTranslateY.value = 0;
    updateZoomState(false);
  }, [scale, translateX, translateY, savedScale, savedTranslateX, savedTranslateY, updateZoomState]);

  const zoomTo = useCallback(
    (target: { scale: number; translateX: number; translateY: number }) => {
      cancelAnimation(scale);
      cancelAnimation(translateX);
      cancelAnimation(translateY);

      scale.value = withTiming(target.scale, { duration: timing.normal });
      translateX.value = withTiming(target.translateX, { duration: timing.normal });
      translateY.value = withTiming(target.translateY, { duration: timing.normal });
      // Keep the gesture snapshots in step so a pan that starts before the
      // animation settles doesn't jump back to the pre-zoom origin.
      savedScale.value = target.scale;
      savedTranslateX.value = target.translateX;
      savedTranslateY.value = target.translateY;
      // Mirror the pinch's own threshold: anything at or under it is "not
      // zoomed", which is what mounts the pan overlay and the reset control.
      updateZoomState(target.scale > ZOOM_THRESHOLD);
    },
    [scale, translateX, translateY, savedScale, savedTranslateX, savedTranslateY, updateZoomState],
  );

  const pinchGesture = useMemo(() => {
    const pinch = Gesture.Pinch()
      .onStart((event) => {
        'worklet';
        if (!enabledSV.value) return;
        // Snapshot from the live animated values so a pinch that starts
        // mid-reset-animation picks up where the animation currently is.
        savedScale.value = scale.value;
        savedTranslateX.value = translateX.value;
        savedTranslateY.value = translateY.value;
        pinchFocalX.value = event.focalX;
        pinchFocalY.value = event.focalY;
        // Reset both extreme trackers to this gesture's starting scale — they
        // describe "how far this gesture pushed it", not a running range
        // across gestures.
        pinchScaleMaxSV.value = savedScale.value;
        pinchScaleMinSV.value = savedScale.value;
      })
      .onUpdate((event) => {
        'worklet';
        if (!enabledSV.value) return;
        const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, savedScale.value * event.scale));

        const focalOffsetX = pinchFocalX.value - containerWidthSV.value / 2;
        const focalOffsetY = pinchFocalY.value - containerHeightSV.value / 2;
        const scaleDelta = newScale / savedScale.value;
        // Inlined from computeFocalPinchTranslation in @boardsesh/play-view
        // — keep in sync. Direct call from worklet across module boundaries
        // isn't reliable; the shared function exists for unit tests + spec.
        const newTranslateX = focalOffsetX * (1 - scaleDelta) + scaleDelta * savedTranslateX.value;
        const newTranslateY = focalOffsetY * (1 - scaleDelta) + scaleDelta * savedTranslateY.value;

        const clamped = clampTranslation(
          newTranslateX,
          newTranslateY,
          newScale,
          containerWidthSV.value,
          containerHeightSV.value,
        );
        scale.value = newScale;
        translateX.value = clamped.x;
        translateY.value = clamped.y;
        // Cheap UI-thread arithmetic — no runOnJS here. Telemetry only reads
        // these once, at onEnd.
        if (newScale > pinchScaleMaxSV.value) pinchScaleMaxSV.value = newScale;
        if (newScale < pinchScaleMinSV.value) pinchScaleMinSV.value = newScale;
      })
      .onEnd(() => {
        'worklet';
        if (!enabledSV.value) return;
        // Snapshot before either branch below overwrites savedScale/scale —
        // this is the one and only JS-thread hop this gesture makes for
        // telemetry (issue #2202), matching the existing updateZoomState
        // pattern. The delta is END minus START (signed), not peak minus
        // start, so a zoom-out reports its real magnitude instead of 0.
        runOnJS(handlePinchEnd)(pinchScaleMaxSV.value, pinchScaleMinSV.value, scale.value - savedScale.value);
        if (scale.value < ZOOM_THRESHOLD) {
          scale.value = withTiming(MIN_SCALE, { duration: timing.fast });
          translateX.value = withTiming(0, { duration: timing.fast });
          translateY.value = withTiming(0, { duration: timing.fast });
          savedScale.value = MIN_SCALE;
          savedTranslateX.value = 0;
          savedTranslateY.value = 0;
          isZoomedSV.value = false;
          runOnJS(updateZoomState)(false);
        } else {
          savedScale.value = scale.value;
          savedTranslateX.value = translateX.value;
          savedTranslateY.value = translateY.value;
          // Set the shared value synchronously on UI thread so the swipe
          // gesture's onEnd, which fires in the same frame, sees the new
          // value and skips navigation. runOnJS hops a tick later.
          isZoomedSV.value = true;
          runOnJS(updateZoomState)(true);
        }
      });
    // Tag the pinch so per-hold detectors can declare themselves simultaneous
    // with it (see pinchRef doc above). Only the interactive boards pass a ref.
    if (pinchRef) {
      pinch.withRef(pinchRef);
      // Drive isPinchingSV off the ancestor pinch's pointer stream — it sees
      // every finger on the board, including those landing on per-hold targets.
      // Set on the 2nd finger; cleared only when a fresh single-finger touch
      // begins, never on pinch end. That way a hold's tap, which recognizes on
      // finger-lift, still sees the pinch as active and bails (the lift would
      // otherwise race the pinch's onEnd and leak a paint).
      pinch.onTouchesDown((event) => {
        'worklet';
        if (event.numberOfTouches >= 2) {
          isPinchingSV.value = true;
        } else if (event.numberOfTouches === 1) {
          isPinchingSV.value = false;
        }
      });
    }
    // Declare the pinch simultaneous with the surrounding RNGH ScrollView so a
    // 2-finger zoom isn't cancelled by the scroll. (The zoom-pan overlay lives on a
    // separate, zoomed-only GestureDetector and takes the opposite relation — it
    // BLOCKS the scroll; see zoomPanGesture below.)
    if (scrollRef) pinch.simultaneousWithExternalGesture(scrollRef);
    return pinch;
  }, [
    scale,
    translateX,
    translateY,
    savedScale,
    savedTranslateX,
    savedTranslateY,
    pinchFocalX,
    pinchFocalY,
    pinchScaleMaxSV,
    pinchScaleMinSV,
    isZoomedSV,
    isPinchingSV,
    enabledSV,
    containerWidthSV,
    containerHeightSV,
    updateZoomState,
    handlePinchEnd,
    scrollRef,
    pinchRef,
  ]);

  // zoomPanGesture is rendered into a separate GestureDetector that only
  // mounts while zoomed (see SwipeBoardCarousel). That way it doesn't claim
  // 1-finger touches in the idle state — which would otherwise block the
  // parent BottomSheetScrollView from scrolling. With maxPointers(1) it
  // also fails harmlessly during 2-finger pinches, so the outer pinch
  // gesture stays responsive even with this overlay above the board.
  const zoomPanGesture = useMemo(() => {
    const pan = Gesture.Pan()
      .minPointers(1)
      .maxPointers(1)
      .onStart(() => {
        'worklet';
        savedTranslateX.value = translateX.value;
        savedTranslateY.value = translateY.value;
      })
      .onUpdate((event) => {
        'worklet';
        if (scale.value <= MIN_SCALE) return;
        const newX = savedTranslateX.value + event.translationX;
        const newY = savedTranslateY.value + event.translationY;
        const clamped = clampTranslation(newX, newY, scale.value, containerWidthSV.value, containerHeightSV.value);
        translateX.value = clamped.x;
        translateY.value = clamped.y;
      })
      .onEnd(() => {
        'worklet';
        savedTranslateX.value = translateX.value;
        savedTranslateY.value = translateY.value;
      });
    // Composed with stationary tap/long-press on the interactive boards: require
    // a deliberate drag so a stationary tap falls through to the tap detector
    // instead of being eaten by the pan.
    if (panActivationOffset != null) {
      pan
        .activeOffsetX([-panActivationOffset, panActivationOffset])
        .activeOffsetY([-panActivationOffset, panActivationOffset]);
    }
    // Make the surrounding scroll wait for this pan to fail. The detector only mounts
    // while zoomed, so claiming the drag there is exactly what we want: the board pans
    // instead of the play drawer scrolling out from under a downward drag. Idle
    // scrolling is untouched (no overlay, no relation).
    if (scrollRef) pan.blocksExternalGesture(scrollRef);
    return pan;
  }, [
    scale,
    translateX,
    translateY,
    savedTranslateX,
    savedTranslateY,
    containerWidthSV,
    containerHeightSV,
    panActivationOffset,
    scrollRef,
  ]);

  const animatedZoomStyle = useAnimatedStyle(() => ({
    // [translate, scale] order: RN matrix-composes left-to-right, so scale
    // applies to the point first and translate adds in screen-pixel units.
    // The reverse order would scale the translation by `scale` (pan too fast).
    transform: [{ translateX: translateX.value }, { translateY: translateY.value }, { scale: scale.value }],
  }));

  return {
    pinchGesture,
    zoomPanGesture,
    isZoomed,
    isZoomedSV,
    isPinchingSV,
    scaleSV: scale,
    translateXSV: translateX,
    translateYSV: translateY,
    containerWidthSV,
    containerHeightSV,
    resetZoom,
    zoomTo,
    animatedZoomStyle,
  };
}
