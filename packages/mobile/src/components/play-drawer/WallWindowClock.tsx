// Put on board's keep-lighting window on the wall button (2.7, spec B2): the
// clock beside "Each pick lights", and a 4 pt violet bar that drains toward the
// bulb and refills when a climb lights.
//
//   |*   Each pick lights · 0:38   << (M)  |
//   |   ===================.........       |
//
// Both read the drive store themselves, so the clock's 1 Hz tick re-renders
// only these leaves, never PlayCore or the board. The shown end is the sooner
// of the window's own and auto-disconnect's (`clampWindowEnd`).

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { I18nManager, StyleSheet, View, type ColorValue } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { readAutoDisconnectDeadlineMs } from '../../lib/auto-disconnect-deadline';
import { withAlpha } from '../../theme/colors';
import { Text } from '../Text';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../../theme/typography';
import { clampWindowEnd, useDriveMode } from './drive-mode-store';
import { WINDOW_BAR_HEIGHT, WINDOW_BAR_INSET, WINDOW_BAR_TRACK_ALPHA } from './wall-control';
import { formatWindowClock, windowSecondsLeft, windowValueSeconds } from './wall-control-text';

/** A renewal refills the bar this fast before it drains again. */
const WINDOW_BAR_REFILL_MS = 250;

/** The live window's end and length, or null outside one. */
function useWindowTiming(): { expiresAt: number; totalMs: number } | null {
  const drive = useDriveMode();
  const expiresAt = drive?.phase === 'live' && drive.windowMs !== null ? drive.expiresAt : null;
  const totalMs = drive?.windowMs ?? null;
  if (expiresAt === null || totalMs === null) return null;
  return { expiresAt, totalMs };
}

/** Milliseconds to the shown end: the window's, or auto-disconnect's when that is sooner. */
function remainingMs(expiresAt: number, now = Date.now()): number {
  return clampWindowEnd(expiresAt, readAutoDisconnectDeadlineMs()) - now;
}

/**
 * The window's time left in whole seconds, or null outside a window: the clock's
 * (`step` 1, rounded up), or the screen-reader value's (`step` 10:
 * `windowValueSeconds`, 30 from 30 to 39 s, 0 under ten). Re-renders only when
 * that number changes.
 */
export function useWindowSecondsLeft(step: 1 | 10): { secondsLeft: number; totalMs: number } | null {
  const timing = useWindowTiming();
  const expiresAt = timing?.expiresAt ?? null;
  const read = useCallback(() => {
    if (expiresAt === null) return null;
    const left = remainingMs(expiresAt);
    return step === 1 ? windowSecondsLeft(left) : windowValueSeconds(left);
  }, [expiresAt, step]);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(read);
  // Set only on a change: a same-value set can still render this component once.
  const shownRef = useRef(secondsLeft);
  useEffect(() => {
    const show = (next: number | null) => {
      if (shownRef.current === next) return;
      shownRef.current = next;
      setSecondsLeft(next);
    };
    show(read());
    if (expiresAt === null) return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      show(read());
      const left = remainingMs(expiresAt);
      if (left <= 0) return;
      // To the next whole second; a timer that fires a beat early just ticks again.
      timer = setTimeout(tick, left % 1000 || 1000);
    };
    tick();
    return () => {
      if (timer !== null) clearTimeout(timer);
    };
  }, [expiresAt, read]);
  if (timing === null || secondsLeft === null) return null;
  return { secondsLeft, totalMs: timing.totalMs };
}

type WallWindowDigitsProps = { color: ColorValue; compact?: boolean };

/** " · 0:38" beside the label. Drawing only: the button speaks the time as its value. */
function WallWindowDigitsComponent({ color }: WallWindowDigitsProps) {
  const clock = useWindowSecondsLeft(1);
  if (!clock) return null;
  return (
    <Text
      variant="subheadline"
      color={color}
      numeric
      numberOfLines={1}
      maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
      style={styles.digits}
      accessibilityElementsHidden
      importantForAccessibility="no"
      testID="play-drawer-wall-control-window-clock"
    >
      {`· ${formatWindowClock(clock.secondsLeft * 1000)}`}
    </Text>
  );
}

export const WallWindowDigits = memo(WallWindowDigitsComponent);

type WallWindowBarProps = {
  /** The bar's violet; its track is 16% of it. */
  color: string;
  /** The button's width; the bar spans it less `WINDOW_BAR_INSET` at each end. */
  width: number;
  /** Reduce Motion / Remove animations: the bar steps once a second with the clock, and a refill jumps. */
  reduceMotion: boolean;
};

/**
 * The drain bar: full at a renewal, empty at the shown end. On the UI thread
 * (a shared value with a linear `withTiming`), so it moves with no React render
 * per frame; under Reduce Motion it steps with the clock instead.
 */
function WallWindowBarComponent({ color, width, reduceMotion }: WallWindowBarProps) {
  const timing = useWindowTiming();
  const trackWidth = Math.max(0, width - WINDOW_BAR_INSET * 2);
  const fraction = useSharedValue(1);
  const expiresAt = timing?.expiresAt ?? null;
  const totalMs = timing?.totalMs ?? null;
  // Under Reduce Motion the bar steps with the clock's seconds; otherwise this
  // only wakes every 10 s and the shared value does the moving.
  const stepped = useWindowSecondsLeft(reduceMotion ? 1 : 10);
  const steppedFraction =
    stepped && stepped.totalMs > 0 ? Math.min(1, (stepped.secondsLeft * 1000) / stepped.totalMs) : null;

  useEffect(() => {
    if (expiresAt === null || totalMs === null || totalMs <= 0) return undefined;
    const left = Math.max(0, remainingMs(expiresAt));
    const start = Math.min(1, left / totalMs);
    if (reduceMotion) {
      cancelAnimation(fraction);
      fraction.value = start;
      return undefined;
    }
    const drainMs = Math.max(0, left - WINDOW_BAR_REFILL_MS);
    fraction.value = withSequence(
      withTiming(start, { duration: WINDOW_BAR_REFILL_MS }),
      withTiming(0, { duration: drainMs, easing: Easing.linear }),
    );
    return () => cancelAnimation(fraction);
  }, [expiresAt, totalMs, reduceMotion, fraction]);

  useEffect(() => {
    if (!reduceMotion || steppedFraction === null) return;
    fraction.value = steppedFraction;
  }, [reduceMotion, steppedFraction, fraction]);

  // Drains toward the bulb, at the leading edge: the fill slides out past it.
  const direction = I18nManager.isRTL ? 1 : -1;
  const fillStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: direction * trackWidth * (1 - fraction.value) }],
  }));

  if (timing === null || trackWidth <= 0) return null;
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.track, { width: trackWidth, backgroundColor: withAlpha(color, WINDOW_BAR_TRACK_ALPHA) }]}
      testID="play-drawer-wall-control-window-bar"
    >
      <Animated.View style={[styles.fill, { backgroundColor: color }, fillStyle]} />
    </View>
  );
}

export const WallWindowBar = memo(WallWindowBarComponent);

const styles = StyleSheet.create({
  digits: {
    fontWeight: '600',
  },
  track: {
    position: 'absolute',
    bottom: 5,
    left: WINDOW_BAR_INSET,
    height: WINDOW_BAR_HEIGHT,
    borderRadius: WINDOW_BAR_HEIGHT / 2,
    overflow: 'hidden',
  },
  fill: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    borderRadius: WINDOW_BAR_HEIGHT / 2,
  },
});
