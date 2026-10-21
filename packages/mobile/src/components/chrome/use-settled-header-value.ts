import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { useIsFocused } from 'expo-router';

// The player's dismiss ceiling (see `use-player-dismiss-and-wait.ts`): long enough
// for the transparent `/play` modal to finish sliding away. The covered tab screen
// gets no transitionEnd of its own for that animation, so a timer is the signal.
export const HEADER_SETTLE_MS = Platform.OS === 'ios' ? 550 : 350;

/**
 * Hold a value that drives native header options while the screen is covered, and
 * for `HEADER_SETTLE_MS` after it is uncovered.
 *
 * Swapping `headerLargeTitle` or the title view while a modal is animating over or
 * off the screen can wedge UIKit's navigation bar (#6619). A board-presence event
 * can land at any moment, so the screen keeps showing the last value it had while
 * focused, and takes the newest one once the dismiss animation has settled.
 */
export function useSettledHeaderValue<T>(value: T): T {
  const isFocused = useIsFocused();
  // True only once the screen has stayed focused past the settle window. Starts
  // true for a screen that mounts focused: nothing is animating over it yet.
  const [settled, setSettled] = useState(isFocused);
  const [held, setHeld] = useState(value);
  const live = isFocused && settled;

  useEffect(() => {
    if (!isFocused) {
      setSettled(false);
      return undefined;
    }
    if (settled) return undefined;
    const timer = setTimeout(() => setSettled(true), HEADER_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [isFocused, settled]);

  useEffect(() => {
    if (live) setHeld(value);
  }, [live, value]);

  return live ? value : held;
}
