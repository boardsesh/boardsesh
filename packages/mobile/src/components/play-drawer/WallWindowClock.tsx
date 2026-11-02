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
  type SharedValue,
} from 'react-native-reanimated';
import { readAutoDisconnectDeadlineMs } from '../../lib/auto-disconnect-deadline';
import { withAlpha } from '../../theme/colors';
import { Text } from '../Text';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../../theme/typography';
import { clampWindowEnd, useDriveWindowExpiresAt, useDriveWindowMs } from './drive-mode-store';
import { WINDOW_BAR_HEIGHT, WINDOW_BAR_INSET, WINDOW_BAR_TRACK_ALPHA } from './wall-control';
import { formatWindowClock, windowSecondsLeft, windowValueSeconds } from './wall-control-text';

/** A renewal refills the bar this fast before it drains again. */
const WINDOW_BAR_REFILL_MS = 250;

/**
 * How far the shown end may move under a running drain before the drain is
 * aimed again. Auto-disconnect's deadline moves with no change of the window
 * (a press, a hold, a short swipe, a preview, a new timeout in the sheet), and
 * the digits re-read it every second; the drain checks on the same beat.
 */
const WINDOW_DRAIN_RETARGET_MS = 500;

/**
 * The live window's end and length, or null outside one. Two primitive
 * subscriptions, so a climb counted outside a window re-renders nothing here.
 */
function useWindowTiming(): { expiresAt: number; totalMs: number } | null {
  const expiresAt = useDriveWindowExpiresAt();
  const totalMs = useDriveWindowMs();
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
  /**
   * A drag or the peek wipes over the button: the bar steps aside but stays
   * mounted, so its drain keeps running and it comes back where it stood.
   */
  hidden?: boolean;
};

/** How much of the window is left, 0 to 1: where the drain stands now. */
function windowFractionLeft(expiresAt: number, totalMs: number): number {
  return Math.min(1, Math.max(0, remainingMs(expiresAt)) / totalMs);
}

/**
 * The window's drain: 1 at a renewal, 0 at the shown end. On the UI thread (a
 * shared value with a linear `withTiming`), so the bar and a bulb's ring
 * (`WallWindowRing`) move with no React render per frame; under Reduce Motion
 * it steps with the clock's seconds instead, and a refill jumps. A 1 s check
 * (a timer, no render) re-aims it when auto-disconnect's end moves the shown
 * end. `active` is false outside a window.
 *
 * Mounted mid-window (the player opening on a running window), it starts where
 * the window stands, and only a renewal after that (a new end) refills: a
 * mount is not a climb lighting.
 */
export function useWindowDrain(reduceMotion: boolean): { fraction: SharedValue<number>; active: boolean } {
  const timing = useWindowTiming();
  const expiresAt = timing?.expiresAt ?? null;
  const totalMs = timing?.totalMs ?? null;
  const [startFraction] = useState(() =>
    expiresAt !== null && totalMs !== null && totalMs > 0 ? windowFractionLeft(expiresAt, totalMs) : 1,
  );
  const fraction = useSharedValue(startFraction);
  // The end the drain last ran toward: a different one is a renewal.
  const drainedForRef = useRef(expiresAt);
  // Under Reduce Motion the bar steps with the clock's seconds; otherwise this
  // only wakes every 10 s and the shared value does the moving.
  const stepped = useWindowSecondsLeft(reduceMotion ? 1 : 10);
  const steppedFraction =
    stepped && stepped.totalMs > 0 ? Math.min(1, (stepped.secondsLeft * 1000) / stepped.totalMs) : null;

  useEffect(() => {
    const renewed = drainedForRef.current !== expiresAt;
    drainedForRef.current = expiresAt;
    if (expiresAt === null || totalMs === null || totalMs <= 0) return undefined;
    const shownEnd = () => clampWindowEnd(expiresAt, readAutoDisconnectDeadlineMs());
    const left = Math.max(0, remainingMs(expiresAt));
    if (reduceMotion) {
      cancelAnimation(fraction);
      fraction.value = Math.min(1, left / totalMs);
      return undefined;
    }
    // To where the bar should be now (over 250 ms for a refill or a re-aim, at
    // once otherwise), then linearly to empty at the shown end.
    const drain = (leftMs: number, glide: boolean) => {
      const glideMs = glide ? WINDOW_BAR_REFILL_MS : 0;
      fraction.value = withSequence(
        withTiming(Math.min(1, leftMs / totalMs), { duration: glideMs }),
        withTiming(0, { duration: Math.max(0, leftMs - glideMs), easing: Easing.linear }),
      );
    };
    drain(left, renewed);
    // Aim the drain again when the shown end moves under it, as the digits do.
    let drainingTo = shownEnd();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const check = () => {
      const end = shownEnd();
      const now = Date.now();
      if (Math.abs(end - drainingTo) > WINDOW_DRAIN_RETARGET_MS) {
        drainingTo = end;
        drain(Math.max(0, end - now), true);
      }
      timer = end > now ? setTimeout(check, 1000) : null;
    };
    timer = setTimeout(check, 1000);
    return () => {
      if (timer !== null) clearTimeout(timer);
      cancelAnimation(fraction);
    };
  }, [expiresAt, totalMs, reduceMotion, fraction]);

  useEffect(() => {
    if (!reduceMotion || steppedFraction === null) return;
    fraction.value = steppedFraction;
  }, [reduceMotion, steppedFraction, fraction]);

  return { fraction, active: timing !== null };
}

/** The drain bar: full at a renewal, empty at the shown end (`useWindowDrain`). */
function WallWindowBarComponent({ color, width, reduceMotion, hidden = false }: WallWindowBarProps) {
  const { fraction, active } = useWindowDrain(reduceMotion);
  const trackWidth = Math.max(0, width - WINDOW_BAR_INSET * 2);

  // Drains toward the bulb, at the leading edge: the fill slides out past it.
  const direction = I18nManager.isRTL ? 1 : -1;
  const fillStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: direction * trackWidth * (1 - fraction.value) }],
  }));

  if (!active || trackWidth <= 0) return null;
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.track,
        { width: trackWidth, backgroundColor: withAlpha(color, WINDOW_BAR_TRACK_ALPHA) },
        hidden && styles.hidden,
      ]}
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
  hidden: {
    opacity: 0,
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
