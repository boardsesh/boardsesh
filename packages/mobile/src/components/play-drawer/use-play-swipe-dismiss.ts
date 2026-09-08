import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import { useNavigation, useRouter } from 'expo-router';
import { runOnJS, runOnUI, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { springs } from '../../theme/animations';
import type { SwipeDismissAnimation } from './use-drawer-dismiss-gesture';

/** Route-local motion: native open/button close, continuous UI-thread swipe close. */
export function usePlaySwipeDismiss() {
  const navigation = useNavigation();
  const router = useRouter();
  const { height: windowHeight } = useWindowDimensions();
  const translateY = useSharedValue(0);
  const height = useSharedValue(windowHeight);
  const isDismissing = useSharedValue(false);
  const mountedRef = useRef(false);
  const removalRequestedRef = useRef(false);
  const [offscreen, setOffscreen] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      height.value = event.nativeEvent.layout.height;
    },
    [height],
  );

  const onComplete = useCallback(() => {
    if (!mountedRef.current || removalRequestedRef.current) return;
    removalRequestedRef.current = true;
    setOffscreen(true);
  }, []);

  useEffect(() => {
    if (!offscreen) return;

    // The surface is already offscreen. Commit the option update separately
    // from removal, then give Fabric a frame to apply it to RNSScreen before
    // popping. Never change options and dismiss in the same mounting batch:
    // UIKit could otherwise start a second native slide with the old option.
    navigation.setOptions({ animation: 'none' });
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        if (!mountedRef.current) return;
        if (navigation.isFocused()) {
          router.dismiss();
        } else {
          // A different modal covered /play while JS was busy. Restore this
          // player underneath it instead of popping that newer route.
          navigation.setOptions({ animation: 'slide_from_bottom' });
          translateY.value = withSpring(0, springs.interactive);
          isDismissing.value = false;
          removalRequestedRef.current = false;
          setOffscreen(false);
        }
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [offscreen, navigation, router, translateY, isDismissing]);

  const dismissNative = useCallback(() => {
    if (!mountedRef.current) return;
    if (navigation.isFocused()) router.dismiss();
    else isDismissing.value = false;
  }, [navigation, router, isDismissing]);

  const close = useCallback(() => {
    // A chevron tap retains the native close, but cannot race a released swipe.
    runOnUI(() => {
      'worklet';
      if (isDismissing.value) return;
      isDismissing.value = true;
      runOnJS(dismissNative)();
    })();
  }, [isDismissing, dismissNative]);

  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ translateY: translateY.value }] }));
  const swipeDismiss = useMemo<SwipeDismissAnimation>(
    () => ({ translateY, height, isDismissing, onComplete }),
    [translateY, height, isDismissing, onComplete],
  );

  return { swipeDismiss, animatedStyle, onLayout, close };
}
