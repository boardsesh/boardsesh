// The "Live" dot. Every dot on screen reads ONE module-level shared value, so a
// rail of ten cards runs one animation, in phase, instead of ten `withRepeat`
// loops ticking off-screen. Surfaces that show dots drive it with
// `useLivePulseDriver(active)`; a ref count keeps the rail and the board sheet
// from stopping each other.

import { memo, useEffect } from 'react';
import { StyleSheet, type ColorValue } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  makeMutable,
  useAnimatedStyle,
  useReducedMotion,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

/** 0 = at rest (full-opacity dot), 1 = dimmest point of the pulse. */
const livePulse = makeMutable(0);

/** Half of one 1.8s breath. */
const HALF_BREATH_MS = 900;
/**
 * Three breaths, then the dot rests. Motion that runs longer than five seconds
 * with no way to stop it fails WCAG 2.2.2; a refocus starts a fresh three.
 */
const PULSE_HALF_CYCLES = 6;
const PULSE_MIN_OPACITY = 0.35;

let activeDrivers = 0;

function startPulse(): void {
  cancelAnimation(livePulse);
  livePulse.value = 0;
  livePulse.value = withRepeat(
    withTiming(1, { duration: HALF_BREATH_MS, easing: Easing.inOut(Easing.quad) }),
    PULSE_HALF_CYCLES,
    true,
  );
}

function stopPulse(): void {
  cancelAnimation(livePulse);
  livePulse.value = 0;
}

/**
 * Runs the shared pulse while `active`. Pass false when the surface is blurred
 * or the app is backgrounded. Reduce Motion keeps the dot static at full
 * opacity.
 */
export function useLivePulseDriver(active: boolean): void {
  const reduceMotion = useReducedMotion();
  const running = active && !reduceMotion;
  useEffect(() => {
    if (!running) return;
    activeDrivers += 1;
    if (activeDrivers === 1) startPulse();
    return () => {
      activeDrivers = Math.max(0, activeDrivers - 1);
      if (activeDrivers === 0) stopPulse();
    };
  }, [running]);
}

type LiveDotProps = {
  color: ColorValue;
  size?: number;
};

export const LiveDot = memo(function LiveDot({ color, size = 7 }: LiveDotProps) {
  const pulseStyle = useAnimatedStyle(() => ({
    opacity: 1 - livePulse.value * (1 - PULSE_MIN_OPACITY),
  }));

  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.dot, { width: size, height: size, borderRadius: size / 2, backgroundColor: color }, pulseStyle]}
    />
  );
});

const styles = StyleSheet.create({
  dot: { flexShrink: 0 },
});
