// Put on board's keep-lighting window on a bulb (2.7, spec B3): the first
// row's bulb and the MiniPlayer's, which stands in for the wall button beside
// a tablet's player. Without it a bulb shows a plain lit board for the whole
// window. A 2 pt violet arc round the bulb's edge drains like the button's bar
// (`useWindowDrain`), and the bulb speaks the time left as its value.

import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import Animated, { useAnimatedProps } from 'react-native-reanimated';
import Svg, { Circle } from 'react-native-svg';
import { useReduceMotion } from '../../hooks/use-reduce-motion';
import { useTheme } from '../../providers/theme-provider';
import { withAlpha } from '../../theme/colors';
import { WINDOW_BAR_TRACK_ALPHA, WINDOW_RING_WIDTH } from './wall-control';
import { windowBulbValue, windowTimeValue } from './wall-control-text';
import { useWindowDrain, useWindowSecondsLeft } from './WallWindowClock';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

/**
 * The window's time left as a bulb's screen-reader value, on the button's 10 s
 * step, or null outside a window. `bulb`: "Each pick lights, 30 seconds left",
 * for a bulb labelled Board lights. `time`: "30 seconds left", for one that
 * already carries the button's label (the MiniPlayer's).
 */
export function useWindowValueText(kind: 'bulb' | 'time', active: boolean): string | null {
  const { t } = useTranslation('session');
  const clock = useWindowSecondsLeft(10);
  if (!active || !clock) return null;
  const remainingMs = clock.secondsLeft * 1000;
  return kind === 'bulb' ? windowBulbValue(remainingMs, t) : windowTimeValue(remainingMs, t);
}

type WallWindowRingProps = {
  /** The bulb's round touch area, the ring's diameter. */
  size: number;
};

/** The draining arc round a bulb, drawn only during a live window. Drawing only: the bulb speaks. */
function WallWindowRingComponent({ size }: WallWindowRingProps) {
  const { brandColors } = useTheme();
  const reduceMotion = useReduceMotion();
  const { fraction, active } = useWindowDrain(reduceMotion);
  const radius = Math.max(0, (size - WINDOW_RING_WIDTH) / 2);
  const circumference = 2 * Math.PI * radius;
  const arcProps = useAnimatedProps(() => ({ strokeDashoffset: circumference * (1 - fraction.value) }));
  if (!active || radius <= 0) return null;
  const centre = size / 2;
  // The button's bar violet: the deeper one in light, the lighter one in dark.
  const color = brandColors.primaryStrong;
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.ring, { width: size, height: size }]}
      testID="wall-window-ring"
    >
      <Svg width={size} height={size}>
        <Circle
          cx={centre}
          cy={centre}
          r={radius}
          stroke={withAlpha(color, WINDOW_BAR_TRACK_ALPHA)}
          strokeWidth={WINDOW_RING_WIDTH}
          fill="none"
        />
        <AnimatedCircle
          cx={centre}
          cy={centre}
          r={radius}
          stroke={color}
          strokeWidth={WINDOW_RING_WIDTH}
          strokeLinecap="round"
          strokeDasharray={`${circumference} ${circumference}`}
          fill="none"
          // From 12 o'clock, draining clockwise.
          transform={`rotate(-90 ${centre} ${centre})`}
          animatedProps={arcProps}
        />
      </Svg>
    </View>
  );
}

export const WallWindowRing = memo(WallWindowRingComponent);

const styles = StyleSheet.create({
  ring: {
    position: 'absolute',
    top: 0,
    left: 0,
  },
});
