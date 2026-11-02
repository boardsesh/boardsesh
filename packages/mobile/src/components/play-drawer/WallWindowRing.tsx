// Put on board's timed drive on a bulb (2.7, spec B3): the first row's bulb and
// every MiniPlayer bulb (the bar's own, the last pick's, and the one standing
// in for the wall button beside a tablet's player). A bulb draws no frost to
// shrink, so an amber ring round its edge drains as the button's frost does
// (`useWindowDrain`): the Live Activity's ring, in the same amber (owner
// decision 2026-11-02). The ring is the clock; no digits sit beside it.
//
// It has no track and no halo under it: the arc meets the bar (or the
// player's row) itself, the only ground on which the light scheme's amber
// clears the 3:1 a graphic needs everywhere. On the held Material bar a 16%
// amber track behind the arc's end left that end at 2.6:1 against it.

import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import Animated, { useAnimatedProps } from 'react-native-reanimated';
import Svg, { Circle } from 'react-native-svg';
import { useReduceMotion } from '../../hooks/use-reduce-motion';
import { useTheme } from '../../providers/theme-provider';
import { WINDOW_RING_WIDTH } from './wall-control';
import { windowBulbValue } from './wall-control-text';
import { useWindowDrain, useWindowSecondsLeft } from './WallWindowClock';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

/**
 * The first row's bulb's screen-reader value during the timed drive, on the
 * button's 10 s step, or null outside one: "You are driving the wall, stops in
 * 30 seconds", for a bulb labelled Board lights. The MiniPlayer's bulbs say
 * "Driving the wall" with no number instead, so the bar never re-renders on a
 * tick.
 */
export function useWindowValueText(active: boolean): string | null {
  const { t } = useTranslation('session');
  const clock = useWindowSecondsLeft(10);
  if (!active || !clock) return null;
  return windowBulbValue(clock.secondsLeft * 1000, t);
}

type WallWindowRingProps = {
  /** The bulb's round touch area, the ring's diameter. */
  size: number;
  /**
   * `drain` (the default): the timed drive's arc, full at each lit climb and
   * gone at its end, drawn only while one runs. `whole`: an open-ended
   * drive's ring, always full, for a bulb that draws no amber disc for it
   * (`BulbDriveCue`); the caller decides when it shows.
   */
  kind?: 'drain' | 'whole';
};

/** The amber ring round a bulb while this phone drives the wall. Drawing only: the bulb speaks. */
function WallWindowRingComponent({ size, kind = 'drain' }: WallWindowRingProps) {
  const { brandColors } = useTheme();
  const reduceMotion = useReduceMotion();
  const whole = kind === 'whole';
  // A whole ring never drains, so it asks the store for no timed drive.
  const { fraction, active } = useWindowDrain(reduceMotion, !whole);
  const radius = Math.max(0, (size - WINDOW_RING_WIDTH) / 2);
  const circumference = 2 * Math.PI * radius;
  const arcProps = useAnimatedProps(() => ({ strokeDashoffset: circumference * (1 - fraction.value) }));
  if ((!whole && !active) || radius <= 0) return null;
  const centre = size / 2;
  // The Live Activity ring's amber: the deep one in light, the bright one in dark.
  const color = brandColors.warning;
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.ring, { width: size, height: size }]}
      testID={whole ? 'wall-drive-ring-whole' : 'wall-window-ring'}
    >
      <Svg width={size} height={size}>
        {whole ? (
          <Circle cx={centre} cy={centre} r={radius} stroke={color} strokeWidth={WINDOW_RING_WIDTH} fill="none" />
        ) : (
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
        )}
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
