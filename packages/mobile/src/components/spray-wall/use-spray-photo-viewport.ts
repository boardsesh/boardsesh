import { useCallback, useEffect, useMemo, useRef, type MutableRefObject } from 'react';
import { Gesture, type GestureType } from 'react-native-gesture-handler';
import { runOnJS, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { clampViewportPan, focalZoomPan } from './tnut-corner-viewport';

/** The detector remains untransformed: focal coordinates never feed back through the image. */
export function useSprayPhotoViewport(
  width: number,
  height: number,
  onInteractionChange?: (active: boolean) => void,
  panEnabled = true,
  failures: readonly MutableRefObject<GestureType | undefined>[] = [],
) {
  const zoom = useSharedValue(1),
    panX = useSharedValue(0),
    panY = useSharedValue(0);
  const isPinching = useSharedValue(false),
    pinchStarted = useSharedValue(false),
    interactions = useSharedValue(0);
  const callback = useRef(onInteractionChange);
  callback.current = onInteractionChange;
  const mounted = useRef(true);
  const reportInteraction = useCallback((active: boolean) => {
    if (mounted.current) callback.current?.(active);
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      callback.current?.(false);
    };
  }, []);
  useEffect(() => {
    zoom.value = 1;
    panX.value = 0;
    panY.value = 0;
  }, [width, height, zoom, panX, panY]);
  const pointerCount = useSharedValue(0);
  const pinchRef = useRef<GestureType | undefined>(undefined);
  const startZoom = useSharedValue(1),
    startScale = useSharedValue(1),
    startX = useSharedValue(0),
    startY = useSharedValue(0),
    focalX = useSharedValue(0),
    focalY = useSharedValue(0);
  const lastX = useSharedValue(0),
    lastY = useSharedValue(0),
    panning = useSharedValue(false);
  const viewportGesture = useMemo(() => {
    const releasePinch = () => {
      'worklet';
      if (!isPinching.value) return;
      isPinching.value = false;
      interactions.value--;
      if (interactions.value === 0) runOnJS(reportInteraction)(false);
    };
    const pinch = Gesture.Pinch()
      .withRef(pinchRef)
      .onTouchesDown((event) => {
        if (event.numberOfTouches < 2 || isPinching.value) return;
        isPinching.value = true;
        interactions.value++;
        if (interactions.value === 1) runOnJS(reportInteraction)(true);
      })
      // iOS never begins a two-finger tap that doesn't pinch, so no onFinalize
      // comes to return the lock taken above.
      .onTouchesUp((event) => {
        if (event.numberOfTouches === 0 && !pinchStarted.value) releasePinch();
      })
      // A cancel covers every touch, though iOS still reports the count from before it.
      .onTouchesCancelled(() => {
        if (!pinchStarted.value) releasePinch();
      })
      .onStart((event) => {
        pinchStarted.value = true;
        if (!isPinching.value) {
          isPinching.value = true;
          interactions.value++;
          if (interactions.value === 1) runOnJS(reportInteraction)(true);
        }
        pointerCount.value = event.numberOfPointers;
        startZoom.value = zoom.value;
        startScale.value = event.scale || 1;
        startX.value = panX.value;
        startY.value = panY.value;
        focalX.value = event.focalX;
        focalY.value = event.focalY;
      })
      .onUpdate((event) => {
        // Android keeps pinch ACTIVE until the final finger lifts. Its focal then
        // jumps to the remaining finger; that is not a request to move the photo.
        const count = event.numberOfPointers;
        if (count < 2) {
          pointerCount.value = count;
          return;
        }
        if (count !== pointerCount.value) {
          pointerCount.value = count;
          startZoom.value = zoom.value;
          startScale.value = event.scale || 1;
          startX.value = panX.value;
          startY.value = panY.value;
          focalX.value = event.focalX;
          focalY.value = event.focalY;
          return;
        }
        const next = Math.max(1, Math.min(6, (startZoom.value * event.scale) / startScale.value));
        panX.value = focalZoomPan(focalX.value, event.focalX, width, startZoom.value, next, startX.value);
        panY.value = focalZoomPan(focalY.value, event.focalY, height, startZoom.value, next, startY.value);
        zoom.value = next;
      })
      .onFinalize(() => {
        pinchStarted.value = false;
        releasePinch();
      });
    const pan = Gesture.Pan()
      .maxPointers(1)
      .manualActivation(true)
      .onTouchesMove((_event, manager) => {
        if (panEnabled && zoom.value > 1 && !isPinching.value) manager.activate();
        else manager.fail();
      })
      .onStart((event) => {
        lastX.value = event.translationX;
        lastY.value = event.translationY;
        panning.value = true;
        interactions.value++;
        if (interactions.value === 1) runOnJS(reportInteraction)(true);
      })
      .onUpdate((event) => {
        const dx = event.translationX - lastX.value,
          dy = event.translationY - lastY.value;
        lastX.value = event.translationX;
        lastY.value = event.translationY;
        if (isPinching.value) return;
        panX.value = clampViewportPan(panX.value + dx, width, zoom.value);
        panY.value = clampViewportPan(panY.value + dy, height, zoom.value);
      })
      .onFinalize(() => {
        if (!panning.value) return;
        panning.value = false;
        interactions.value--;
        if (interactions.value === 0) runOnJS(reportInteraction)(false);
      });
    if (failures.length) pan.requireExternalGestureToFail(...failures);
    return Gesture.Simultaneous(pinch, pan);
  }, [
    width,
    height,
    panEnabled,
    failures,
    zoom,
    panX,
    panY,
    isPinching,
    pinchStarted,
    interactions,
    reportInteraction,
    startZoom,
    startScale,
    startX,
    startY,
    focalX,
    focalY,
    lastX,
    lastY,
    panning,
    pointerCount,
  ]);
  const imageTransform = useAnimatedStyle(() => ({
    transform: [{ translateX: panX.value }, { translateY: panY.value }, { scale: zoom.value }],
  }));
  return { zoom, panX, panY, isPinching, interactions, reportInteraction, pinchRef, viewportGesture, imageTransform };
}
