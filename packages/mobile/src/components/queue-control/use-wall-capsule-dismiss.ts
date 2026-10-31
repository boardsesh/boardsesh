import { useCallback, useLayoutEffect, useRef } from 'react';
import type { LayoutChangeEvent } from 'react-native';
import { usePanGesture } from 'react-native-gesture-handler';
import {
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { springs, timing } from '../../theme/animations';

export type WallCapsuleDismissOptions = {
  occurrenceKey: string;
  onDismiss?: (occurrenceKey: string) => void;
  reduceMotion: boolean;
};

/** An occurrence owns its drag and completion, even if presence changes mid-swipe. */
export function useWallCapsuleDismiss({ occurrenceKey, onDismiss, reduceMotion }: WallCapsuleDismissOptions) {
  const translateX = useSharedValue(0);
  const width = useSharedValue(0);
  const currentOccurrence = useSharedValue(occurrenceKey);
  const startedOccurrence = useSharedValue(occurrenceKey);
  const activated = useSharedValue(false);
  const dismissing = useSharedValue(false);
  const latest = useRef({ occurrenceKey, onDismiss });
  latest.current = { occurrenceKey, onDismiss };
  const mounted = useRef(true);
  const committed = useRef<string | null>(null);
  const panned = useRef(false);
  const clearPanTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const commitDismiss = useCallback((origin: string) => {
    if (!mounted.current || origin !== latest.current.occurrenceKey || committed.current === origin) return;
    const dismiss = latest.current.onDismiss;
    if (!dismiss) return;
    committed.current = origin;
    dismiss(origin);
  }, []);
  const beginTouch = useCallback(() => {
    if (clearPanTimer.current !== null) clearTimeout(clearPanTimer.current);
    clearPanTimer.current = null;
    panned.current = false;
  }, []);
  const markPanned = useCallback(() => {
    panned.current = true;
  }, []);
  const finishTouch = useCallback(() => {
    // Native Pressable/LargeContentViewer may deliver their release after the pan.
    if (clearPanTimer.current !== null) clearTimeout(clearPanTimer.current);
    clearPanTimer.current = setTimeout(() => {
      clearPanTimer.current = null;
      panned.current = false;
    }, 0);
  }, []);

  useLayoutEffect(() => {
    currentOccurrence.value = occurrenceKey;
    cancelAnimation(translateX);
    translateX.value = 0;
    dismissing.value = false;
    activated.value = false;
    committed.current = null;
  }, [occurrenceKey, currentOccurrence, translateX, dismissing, activated]);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancelAnimation(translateX);
      if (clearPanTimer.current !== null) clearTimeout(clearPanTimer.current);
    };
  }, [translateX]);

  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      width.value = event.nativeEvent.layout.width;
    },
    [width],
  );
  const gesture = usePanGesture({
    enabled: onDismiss != null,
    activeOffsetX: -10,
    failOffsetY: [-14, 14],
    maxPointers: 1,
    onBegin: () => {
      'worklet';
      if (occurrenceKey !== currentOccurrence.value || dismissing.value) return;
      startedOccurrence.value = occurrenceKey;
      activated.value = false;
      runOnJS(beginTouch)();
    },
    onActivate: () => {
      'worklet';
      if (occurrenceKey !== currentOccurrence.value) return;
      runOnJS(markPanned)();
      if (startedOccurrence.value !== currentOccurrence.value || dismissing.value) return;
      activated.value = true;
      cancelAnimation(translateX);
    },
    onUpdate: (event) => {
      'worklet';
      if (
        occurrenceKey !== currentOccurrence.value ||
        !activated.value ||
        startedOccurrence.value !== currentOccurrence.value ||
        dismissing.value
      )
        return;
      translateX.value = Math.max(-width.value, Math.min(0, event.translationX));
    },
    onDeactivate: (event) => {
      'worklet';
      if (
        occurrenceKey !== currentOccurrence.value ||
        !activated.value ||
        startedOccurrence.value !== currentOccurrence.value ||
        dismissing.value
      )
        return;
      const progress = width.value > 0 ? Math.max(0, -event.translationX / width.value) : 0;
      const commits = progress >= 0.55 || (progress >= 0.25 && event.velocityX <= -800);
      if (event.canceled || !commits) {
        translateX.value = reduceMotion ? 0 : withSpring(0, springs.interactive);
        return;
      }
      dismissing.value = true;
      const origin = startedOccurrence.value;
      if (reduceMotion) {
        runOnJS(commitDismiss)(origin);
        return;
      }
      translateX.value = withTiming(-width.value, { duration: timing.fast }, (finished) => {
        'worklet';
        if (finished && currentOccurrence.value === origin) runOnJS(commitDismiss)(origin);
      });
    },
    onFinalize: () => {
      'worklet';
      if (occurrenceKey !== currentOccurrence.value) return;
      activated.value = false;
      runOnJS(finishTouch)();
    },
  });
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ translateX: translateX.value }] }));
  const consumePanned = useCallback(() => panned.current, []);
  const dismiss = useCallback(() => commitDismiss(occurrenceKey), [commitDismiss, occurrenceKey]);

  return { gesture, animatedStyle, onLayout, consumePanned, dismiss };
}
