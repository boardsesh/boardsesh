import {
  useCallback,
  useEffect,
  useMemo,
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
import { timing } from '../../theme/animations';
import { clampAxisTranslation, transformOriginInViewport, type ZoomViewport } from './zoom-viewport-clamp';

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
  /** Deepest zoom a pinch may reach. Defaults to `MAX_SCALE` (4×), which every
   * board uses; the spray hold editor raises it so small holds tucked beside big
   * ones can be framed. Read on the UI thread from a shared value, so changing it
   * never rebuilds the gesture objects. `zoomTo` does not clamp against it — its
   * caller pre-clamps (see `zoomTargetForHold`'s own `maxScale`). */
  maxScale?: number;
  /** The pinch also pans: the board follows the two fingers' midpoint as it
   * moves, not just their spread. Off by default, where the one-finger zoomed
   * pan does the moving. The spray hold editor turns it on because its draw
   * tools take every one-finger touch, so two fingers are the only way to move
   * across a zoomed wall mid-edit. Mirrored into a shared value like `maxScale`. */
  pinchPans?: boolean;
  /** RNGH ref to the play drawer's pull-down-to-dismiss Pan (an ANCESTOR of this
   * board). Both want a downward one-finger drag, so the zoomed-only pan declares
   * `.blocksExternalGesture(dismissRef)` and the dismiss waits for it to fail —
   * a downward drag on a zoomed board pans the board instead of pulling the
   * drawer down. Unzoomed there's no overlay and no relation, so pull-to-dismiss
   * keeps the whole surface. Only the play drawer passes it. */
  dismissRef?: MutableRefObject<GestureType | undefined>;
  /**
   * The area the zoomed board is drawn and panned in, when it is bigger than
   * the board's own render box (the spray hold editor lets a zoomed photo fill
   * the screen). Pans clamp so every photo edge can reach the viewport's
   * visible band, and a pinch scales about the photo's centre inside it. Left
   * unset, the viewport is the render box and nothing changes. Mirrored into
   * shared values, so a layout change never rebuilds the gestures.
   */
  viewport?: ZoomViewport;
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
   * (containerWidth/2, containerHeight/2), measured in the render box. With a
   * `viewport` that box sits at the viewport offset, and this stays the
   * render box's size. Mirrored so the inverse-transform worklet reads it
   * without re-creating gesture objects on a layout change. */
  containerWidthSV: SharedValue<number>;
  containerHeightSV: SharedValue<number>;
  /**
   * The viewport the board is panned in (see the `viewport` option), on the UI
   * thread: its size and where the unzoomed board sits in it. Without a
   * viewport these are the container size and 0. An overlay laid out over the
   * whole viewport adds the offset to `translateX/YSV` to map board points.
   */
  viewportWidthSV: SharedValue<number>;
  viewportHeightSV: SharedValue<number>;
  viewportOffsetXSV: SharedValue<number>;
  viewportOffsetYSV: SharedValue<number>;
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

// The pan clamp lives in ./zoom-viewport-clamp (one per-axis worklet, shared
// with zoomTargetForHold in outline-editor/hold-navigation.ts so a programmatic
// zoom lands where a manual pan would). With no viewport it reduces exactly to
// clampTranslation from @boardsesh/play-view, the original spec.

/**
 * The scale a pinch lands on: the gesture's raw scale held inside
 * [minScale, maxScale]. A worklet so the pinch's onUpdate can call it on the UI
 * thread; exported so the clamp itself is unit-testable.
 */
export function clampPinchScale(scale: number, minScale: number, maxScale: number): number {
  'worklet';
  return Math.max(minScale, Math.min(maxScale, scale));
}

export function useZoomPanGesture({
  enabled = true,
  containerWidth,
  containerHeight,
  panActivationOffset,
  scrollRef,
  pinchRef,
  maxScale = MAX_SCALE,
  pinchPans = false,
  dismissRef,
  viewport,
}: UseZoomPanGestureOptions): UseZoomPanGestureReturn {
  const scale = useSharedValue(MIN_SCALE);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);

  const savedScale = useSharedValue(MIN_SCALE);
  const savedTranslateX = useSharedValue(0);
  const savedTranslateY = useSharedValue(0);

  const pinchFocalX = useSharedValue(0);
  const pinchFocalY = useSharedValue(0);
  // `pinchPans` only: the pointer count and the gesture's own scale at the last
  // rebase. A finger lifting or landing mid-pinch moves the focal point to a new
  // midpoint in one frame; rebasing there keeps the board from lurching.
  const pinchPointers = useSharedValue(0);
  const pinchScaleBase = useSharedValue(1);

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
  const maxScaleSV = useSharedValue(maxScale);
  const pinchPansSV = useSharedValue(pinchPans);
  // The viewport, or the render box standing in for one. Its own shared values
  // for the same reason as the container size above.
  const viewportWidth = viewport?.width ?? containerWidth;
  const viewportHeight = viewport?.height ?? containerHeight;
  const viewportOffsetX = viewport?.offsetX ?? 0;
  const viewportOffsetY = viewport?.offsetY ?? 0;
  const bandStartX = viewport?.bandStartX ?? 0;
  const bandEndX = viewport?.bandEndX ?? containerWidth;
  const bandStartY = viewport?.bandStartY ?? 0;
  const bandEndY = viewport?.bandEndY ?? containerHeight;
  const viewportWidthSV = useSharedValue(viewportWidth);
  const viewportHeightSV = useSharedValue(viewportHeight);
  const viewportOffsetXSV = useSharedValue(viewportOffsetX);
  const viewportOffsetYSV = useSharedValue(viewportOffsetY);
  const bandStartXSV = useSharedValue(bandStartX);
  const bandEndXSV = useSharedValue(bandEndX);
  const bandStartYSV = useSharedValue(bandStartY);
  const bandEndYSV = useSharedValue(bandEndY);
  useEffect(() => {
    viewportWidthSV.value = viewportWidth;
    viewportHeightSV.value = viewportHeight;
    viewportOffsetXSV.value = viewportOffsetX;
    viewportOffsetYSV.value = viewportOffsetY;
    bandStartXSV.value = bandStartX;
    bandEndXSV.value = bandEndX;
    bandStartYSV.value = bandStartY;
    bandEndYSV.value = bandEndY;
  }, [
    viewportWidth,
    viewportHeight,
    viewportOffsetX,
    viewportOffsetY,
    bandStartX,
    bandEndX,
    bandStartY,
    bandEndY,
    viewportWidthSV,
    viewportHeightSV,
    viewportOffsetXSV,
    viewportOffsetYSV,
    bandStartXSV,
    bandEndXSV,
    bandStartYSV,
    bandEndYSV,
  ]);
  useEffect(() => {
    pinchPansSV.value = pinchPans;
  }, [pinchPans, pinchPansSV]);
  useEffect(() => {
    enabledSV.value = enabled;
  }, [enabled, enabledSV]);
  useEffect(() => {
    containerWidthSV.value = containerWidth;
  }, [containerWidth, containerWidthSV]);
  useEffect(() => {
    containerHeightSV.value = containerHeight;
  }, [containerHeight, containerHeightSV]);
  useEffect(() => {
    maxScaleSV.value = maxScale;
  }, [maxScale, maxScaleSV]);

  const [isZoomed, setIsZoomed] = useState(false);

  const updateZoomState = useCallback(
    (zoomed: boolean) => {
      isZoomedSV.value = zoomed;
      setIsZoomed(zoomed);
    },
    [isZoomedSV],
  );

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
      // Mirrors resetZoom, and belt-and-braces rather than load-bearing: both
      // gestures re-snapshot these from the LIVE animated values in their own
      // onStart (see the pinch's snapshot comment below), so a gesture that
      // begins mid-animation already picks the board up where it visually is.
      // These keep the saved state coherent for anything that reads it without
      // a gesture start in front of it.
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
        pinchPointers.value = event.numberOfPointers;
        pinchScaleBase.value = 1;
      })
      .onUpdate((event) => {
        'worklet';
        if (!enabledSV.value) return;
        if (pinchPansSV.value && event.numberOfPointers !== pinchPointers.value) {
          savedScale.value = scale.value;
          savedTranslateX.value = translateX.value;
          savedTranslateY.value = translateY.value;
          pinchFocalX.value = event.focalX;
          pinchFocalY.value = event.focalY;
          pinchPointers.value = event.numberOfPointers;
          pinchScaleBase.value = event.scale > 0 ? event.scale : 1;
          return;
        }
        const newScale = clampPinchScale(
          (savedScale.value * event.scale) / pinchScaleBase.value,
          MIN_SCALE,
          maxScaleSV.value,
        );

        // Measured from the transform's origin — the unzoomed photo's centre in
        // the viewport, which is the container centre when there is no viewport.
        const focalOffsetX =
          pinchFocalX.value - transformOriginInViewport(viewportOffsetXSV.value, containerWidthSV.value);
        const focalOffsetY =
          pinchFocalY.value - transformOriginInViewport(viewportOffsetYSV.value, containerHeightSV.value);
        const scaleDelta = newScale / savedScale.value;
        // Inlined from computeFocalPinchTranslation in @boardsesh/play-view
        // — keep in sync. Direct call from worklet across module boundaries
        // isn't reliable; the shared function exists for unit tests + spec.
        // With `pinchPans`, the midpoint's travel since the pinch began is added
        // on top, so the point under the fingers stays under them as they move.
        const panX = pinchPansSV.value ? event.focalX - pinchFocalX.value : 0;
        const panY = pinchPansSV.value ? event.focalY - pinchFocalY.value : 0;
        const newTranslateX = focalOffsetX * (1 - scaleDelta) + scaleDelta * savedTranslateX.value + panX;
        const newTranslateY = focalOffsetY * (1 - scaleDelta) + scaleDelta * savedTranslateY.value + panY;

        scale.value = newScale;
        translateX.value = clampAxisTranslation(
          newTranslateX,
          newScale,
          containerWidthSV.value,
          viewportOffsetXSV.value,
          bandStartXSV.value,
          bandEndXSV.value,
        );
        translateY.value = clampAxisTranslation(
          newTranslateY,
          newScale,
          containerHeightSV.value,
          viewportOffsetYSV.value,
          bandStartYSV.value,
          bandEndYSV.value,
        );
      })
      .onEnd(() => {
        'worklet';
        if (!enabledSV.value) return;
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
    pinchPointers,
    pinchScaleBase,
    isZoomedSV,
    isPinchingSV,
    enabledSV,
    containerWidthSV,
    containerHeightSV,
    viewportOffsetXSV,
    viewportOffsetYSV,
    bandStartXSV,
    bandEndXSV,
    bandStartYSV,
    bandEndYSV,
    maxScaleSV,
    pinchPansSV,
    updateZoomState,
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
        translateX.value = clampAxisTranslation(
          newX,
          scale.value,
          containerWidthSV.value,
          viewportOffsetXSV.value,
          bandStartXSV.value,
          bandEndXSV.value,
        );
        translateY.value = clampAxisTranslation(
          newY,
          scale.value,
          containerHeightSV.value,
          viewportOffsetYSV.value,
          bandStartYSV.value,
          bandEndYSV.value,
        );
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
    // Same relation against the drawer's pull-down-to-dismiss Pan, which sits on an
    // ancestor and competes for the very same downward drag. Without it the dismiss
    // can win and the drawer slides away mid-pan instead of the board moving.
    if (dismissRef) pan.blocksExternalGesture(dismissRef);
    return pan;
  }, [
    scale,
    translateX,
    translateY,
    savedTranslateX,
    savedTranslateY,
    containerWidthSV,
    containerHeightSV,
    viewportOffsetXSV,
    viewportOffsetYSV,
    bandStartXSV,
    bandEndXSV,
    bandStartYSV,
    bandEndYSV,
    panActivationOffset,
    scrollRef,
    dismissRef,
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
    viewportWidthSV,
    viewportHeightSV,
    viewportOffsetXSV,
    viewportOffsetYSV,
    resetZoom,
    zoomTo,
    animatedZoomStyle,
  };
}
