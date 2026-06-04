import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View, useColorScheme, useWindowDimensions } from 'react-native';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { Gesture } from 'react-native-gesture-handler';
import { StatusBar } from 'expo-status-bar';
import { useSessionScreen } from '../../providers/session-screen-provider';
import { GlassSurface } from '../GlassSurface';
import { SessionScreen } from './SessionScreen';
import { springs } from '../../theme/animations';

// Drag down past this fraction of the screen (or flick faster than this) to
// dismiss; otherwise the overlay springs back to fully presented.
const DISMISS_DISTANCE_FRACTION = 0.2;
const DISMISS_VELOCITY = 800;

/**
 * Full-screen Strava-style overlay that hosts the Session screen. Mounted once
 * at the app root next to DrawerHostProvider; reads its open/close state from
 * SessionScreenContext. The background is a GlassSurface so the layered
 * Liquid-Glass language from the rest of the chrome (tab bar, persistent bar,
 * sheets) keeps reading as one system as the overlay rises.
 */
export function SessionScreenHost() {
  const { isOpen, close } = useSessionScreen();
  const colorScheme = useColorScheme();
  // useWindowDimensions re-runs on rotation, Stage Manager resize, and
  // foldable unfold — Dimensions.get('window').height at module scope would
  // freeze us at the boot-time size and miscompute the dismiss distance.
  const { height: screenHeight } = useWindowDimensions();

  // translateY: 0 = fully presented, screenHeight = fully dismissed below.
  const translateY = useSharedValue(screenHeight);
  // `mounted` lives in React state so the dismount actually triggers a
  // re-render — driving it from a shared value worked on the worklet thread
  // but never scheduled React work, leaving the (absoluteFill) overlay host
  // mounted forever and intercepting nothing useful.
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setMounted(true);
      translateY.value = withSpring(0, springs.gentle);
    } else if (mounted) {
      translateY.value = withTiming(
        screenHeight,
        { duration: 240, easing: Easing.in(Easing.cubic) },
        (finished) => {
          if (finished) runOnJS(setMounted)(false);
        },
      );
    }
  }, [isOpen, mounted, screenHeight, translateY]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  const backdropStyle = useAnimatedStyle(() => {
    // Fade a dim layer in proportionally as the sheet rises. Stays subtle —
    // the GlassSurface already provides separation; the backdrop just damps
    // the underlying UI so the tab bar doesn't compete for attention.
    const progress = 1 - translateY.value / screenHeight;
    return {
      opacity: progress * 0.4,
    };
  });

  // Swipe-down-to-dismiss, attached to the header (so it never fights the
  // in-session body scroll). Drives the same translateY the open/close
  // animation uses; on release we either dismiss (which lets the close effect
  // finish the exit) or spring back to fully presented.
  const dragStartY = useSharedValue(0);
  const headerGesture = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetY(10)
        .onStart(() => {
          dragStartY.value = translateY.value;
        })
        .onUpdate((event) => {
          translateY.value = Math.max(0, dragStartY.value + event.translationY);
        })
        .onEnd((event) => {
          if (translateY.value > screenHeight * DISMISS_DISTANCE_FRACTION || event.velocityY > DISMISS_VELOCITY) {
            runOnJS(close)();
          } else {
            translateY.value = withSpring(0, springs.gentle);
          }
        }),
    [screenHeight, close, translateY, dragStartY],
  );

  if (!isOpen && !mounted) {
    return null;
  }

  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      {isOpen ? <StatusBar style={colorScheme === 'dark' ? 'light' : 'dark'} animated /> : null}
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.backdrop, backdropStyle]} />
      <Animated.View style={[StyleSheet.absoluteFill, animatedStyle]}>
        <View style={StyleSheet.absoluteFill}>
          <GlassSurface glassEffectStyle="regular" style={StyleSheet.absoluteFill} />
          <SessionScreen onClose={close} headerGesture={headerGesture} />
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    backgroundColor: '#000',
  },
});
