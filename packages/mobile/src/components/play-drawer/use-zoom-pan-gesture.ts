import { useCallback, useEffect, useMemo, useState } from 'react';
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

type UseZoomPanGestureOptions = {
  enabled?: boolean;
  containerWidth: number;
  containerHeight: number;
};

type UseZoomPanGestureReturn = {
  pinchGesture: GestureType;
  zoomPanGesture: GestureType;
  isZoomed: boolean;
  isZoomedSV: SharedValue<boolean>;
  /** Live zoom scale on the UI thread, so an overlay inside the transform can
   * convert screen-pixel drag deltas into unscaled board-pixel deltas. */
  scaleSV: SharedValue<number>;
  resetZoom: () => void;
  animatedZoomStyle: AnimatedStyle;
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
}: UseZoomPanGestureOptions): UseZoomPanGestureReturn {
  const scale = useSharedValue(MIN_SCALE);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);

  const savedScale = useSharedValue(MIN_SCALE);
  const savedTranslateX = useSharedValue(0);
  const savedTranslateY = useSharedValue(0);

  const pinchFocalX = useSharedValue(0);
  const pinchFocalY = useSharedValue(0);

  // Mirror JS values onto the UI thread so worklets can gate without putting
  // them in gesture useMemo deps — recomposing gestures mid-session left
  // RNGH in a bad state on iOS (swipe.onEnd stopped firing). containerHeight
  // also starts at 0 and updates after first onLayout; reading from a shared
  // value keeps the gesture objects stable across that one-shot update.
  const isZoomedSV = useSharedValue(false);
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

  const pinchGesture = useMemo(
    () =>
      Gesture.Pinch()
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
        }),
    [
      scale,
      translateX,
      translateY,
      savedScale,
      savedTranslateX,
      savedTranslateY,
      pinchFocalX,
      pinchFocalY,
      isZoomedSV,
      enabledSV,
      containerWidthSV,
      containerHeightSV,
      updateZoomState,
    ],
  );

  // zoomPanGesture is rendered into a separate GestureDetector that only
  // mounts while zoomed (see SwipeBoardCarousel). That way it doesn't claim
  // 1-finger touches in the idle state — which would otherwise block the
  // parent BottomSheetScrollView from scrolling. With maxPointers(1) it
  // also fails harmlessly during 2-finger pinches, so the outer pinch
  // gesture stays responsive even with this overlay above the board.
  const zoomPanGesture = useMemo(
    () =>
      Gesture.Pan()
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
        }),
    [scale, translateX, translateY, savedTranslateX, savedTranslateY, containerWidthSV, containerHeightSV],
  );

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
    scaleSV: scale,
    resetZoom,
    animatedZoomStyle,
  };
}
