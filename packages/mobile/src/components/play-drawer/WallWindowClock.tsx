// Put on board's timed drive on the wall button (2.7, Stop driving after): the
// same frost and You are driving the wall as any drive, a clock beside the
// label, and the frost shrinking toward the bulb as the time runs out. Each
// climb that lights refills it.
//
//   |*   You are driving the wall · 0:38   (M)|   frost: the whole pill
//   |*   You are driving the wall · 0:12   (M)|   frost: 12/45 of it, at the bulb
//
// The clock and the shrink read the drive store themselves, so the clock's
// 1 Hz tick re-renders only its own leaf, never PlayCore or the board, and the
// shrink runs on the UI thread with no React render at all.

import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { I18nManager, StyleSheet, type ColorValue } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { Text } from '../Text';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../../theme/typography';
import { useDriveWindowExpiresAt, useDriveWindowMs } from './drive-mode-store';
import { formatWindowClock, windowSecondsLeft, windowValueSeconds } from './wall-control-text';

/** A renewal refills the frost this fast before it shrinks again. */
export const WINDOW_FROST_REFILL_MS = 250;

/** Under Reduce Motion the frost shrinks in steps of this much time left, not smoothly. */
export const WINDOW_FROST_STEP_MS = 5_000;

/**
 * The live timed drive's end and length, or null outside one. Two primitive
 * subscriptions, so a climb counted outside a timed drive re-renders nothing here.
 */
function useWindowTiming(): { expiresAt: number; totalMs: number } | null {
  const expiresAt = useDriveWindowExpiresAt();
  const totalMs = useDriveWindowMs();
  if (expiresAt === null || totalMs === null) return null;
  return { expiresAt, totalMs };
}

/**
 * The timed drive's time left in whole seconds, or null outside one: the
 * clock's (`step` 1, rounded up), or the screen-reader value's (`step` 10:
 * `windowValueSeconds`, 30 from 30 to 39 s, 0 under ten). Re-renders only when
 * that number changes.
 */
export function useWindowSecondsLeft(step: 1 | 10): { secondsLeft: number; totalMs: number } | null {
  const timing = useWindowTiming();
  const expiresAt = timing?.expiresAt ?? null;
  const read = useCallback(() => {
    if (expiresAt === null) return null;
    const left = expiresAt - Date.now();
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
      const left = expiresAt - Date.now();
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

type WallWindowDigitsProps = { color: ColorValue };

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

/** How much of the timed drive is left, 0 to 1: how much of the frost shows now. */
export function windowFractionLeft(leftMs: number, totalMs: number): number {
  if (totalMs <= 0) return 0;
  return Math.min(1, Math.max(0, leftMs) / totalMs);
}

/**
 * The same under Reduce Motion: the time left rounded up to the next 5 s step,
 * so the frost holds still between steps and is full until the first 5 s pass.
 */
export function steppedWindowFraction(leftMs: number, totalMs: number): number {
  if (leftMs <= 0) return 0;
  return windowFractionLeft(Math.ceil(leftMs / WINDOW_FROST_STEP_MS) * WINDOW_FROST_STEP_MS, totalMs);
}

/**
 * The timed drive's drain: 1 at a renewal, 0 at its end. On the UI thread (a
 * shared value with a linear `withTiming` from the store's `expiresAt`), so
 * the frost and a bulb's ring (`WallWindowRing`) move with no JS and no React
 * render per frame. Under Reduce Motion it steps every 5 s instead, from a
 * timer that only writes the shared value (no render either), and a refill
 * jumps. `active` is false outside a timed drive, and wherever `timed` says
 * this view doesn't draw one (the preview-first card's picture of a drive,
 * which stays whole while a real timed drive runs).
 *
 * Mounted mid-drive (the player opening on a running one), it starts where the
 * drive stands (on its 5 s step under Reduce Motion, so the frost never grows
 * back a frame later), and only a renewal after that (a new end) refills: a
 * mount is not a climb lighting.
 */
export function useWindowDrain(
  reduceMotion: boolean,
  timed = true,
): { fraction: SharedValue<number>; active: boolean } {
  const storeTiming = useWindowTiming();
  const timing = timed ? storeTiming : null;
  const expiresAt = timing?.expiresAt ?? null;
  const totalMs = timing?.totalMs ?? null;
  const [startFraction] = useState(() => {
    if (expiresAt === null || totalMs === null) return 1;
    const left = expiresAt - Date.now();
    return reduceMotion ? steppedWindowFraction(left, totalMs) : windowFractionLeft(left, totalMs);
  });
  const fraction = useSharedValue(startFraction);
  // The end the drain last ran toward: a different one is a renewal.
  const drainedForRef = useRef(expiresAt);

  useEffect(() => {
    const renewed = drainedForRef.current !== expiresAt;
    drainedForRef.current = expiresAt;
    if (expiresAt === null || totalMs === null || totalMs <= 0) return undefined;
    if (reduceMotion) {
      cancelAnimation(fraction);
      let timer: ReturnType<typeof setTimeout> | null = null;
      const step = () => {
        const left = expiresAt - Date.now();
        fraction.value = steppedWindowFraction(left, totalMs);
        if (left <= 0) return;
        // To the next 5 s step; a timer that fires a beat early just steps again.
        timer = setTimeout(step, left % WINDOW_FROST_STEP_MS || WINDOW_FROST_STEP_MS);
      };
      step();
      return () => {
        if (timer !== null) clearTimeout(timer);
      };
    }
    // To where the frost should be now (over 250 ms for a refill, at once
    // otherwise), then linearly to nothing at the drive's end.
    const left = Math.max(0, expiresAt - Date.now());
    const glideMs = renewed ? WINDOW_FROST_REFILL_MS : 0;
    fraction.value = withSequence(
      withTiming(windowFractionLeft(left, totalMs), { duration: glideMs }),
      withTiming(0, { duration: Math.max(0, left - glideMs), easing: Easing.linear }),
    );
    return () => {
      cancelAnimation(fraction);
    };
  }, [expiresAt, totalMs, reduceMotion, fraction]);

  return { fraction, active: timing !== null };
}

type WallWindowFrostProps = {
  /** The button's width: the frost is this wide at full. */
  width: number;
  /** Reduce Motion / Remove animations: the frost shrinks in 5 s steps, and a refill jumps. */
  reduceMotion: boolean;
  /**
   * This button draws Put on board's timed drive (`model.lightWindow`). False,
   * the frost stays whole whatever the drive store says: a swipe drive, or the
   * preview-first card's picture of one.
   */
  timed: boolean;
  /** The frost itself (`WallGlow`, or the flat amber where there are no holds to frost). */
  children: ReactNode;
};

/**
 * The drive's frost, clipped to the time left in a timed drive (`useWindowDrain`):
 * full at a renewal, shrinking toward the bulb at the leading edge, gone at
 * the end. Outside a timed drive it is the whole frost, as any drive shows it.
 * The clip slides toward the bulb and the frost slides back by the same
 * amount, so the frost stays put and only its trailing edge moves: two
 * transforms, no layout per frame. Drawing only.
 */
function WallWindowFrostComponent({ width, reduceMotion, timed, children }: WallWindowFrostProps) {
  const { fraction, active } = useWindowDrain(reduceMotion, timed);
  // The bulb sits at the leading edge: left, or right in a right-to-left layout.
  const toward = I18nManager.isRTL ? 1 : -1;
  const clipStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: active ? toward * width * (1 - fraction.value) : 0 }],
  }));
  const frostStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: active ? -toward * width * (1 - fraction.value) : 0 }],
  }));
  return (
    <Animated.View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.fill, styles.clip, clipStyle]}
      testID={active ? 'play-drawer-wall-control-window-frost' : undefined}
    >
      <Animated.View style={[styles.fill, frostStyle]}>{children}</Animated.View>
    </Animated.View>
  );
}

export const WallWindowFrost = memo(WallWindowFrostComponent);

const styles = StyleSheet.create({
  digits: {
    fontWeight: '600',
  },
  fill: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
  },
  clip: {
    overflow: 'hidden',
  },
});
