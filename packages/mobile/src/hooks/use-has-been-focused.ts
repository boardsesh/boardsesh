import { useState } from 'react';
import { useIsFocused } from 'expo-router';

/**
 * Whether this screen has been focused at least once. Latches true on the first
 * focus and stays true after the screen blurs.
 *
 * `NativeTabs` renders every tab's screen at launch and keeps it mounted, unlike
 * the JS `Tabs` navigator, which mounted a tab lazily on first visit. A tab root
 * uses this latch to hold back its launch-time network reads and heavy work until
 * the climber first opens it, which restores the old lazy cost on a cold start.
 * The focused tab is focused on its first render, so it pays no extra frame.
 *
 * A latch rather than `useIsFocused()` itself: once a tab has loaded, its queries
 * stay enabled while hidden so the cache keeps serving it and live updates keep
 * landing. Screens that want reads paused while hidden (the You page) gate on
 * `useIsFocused()` directly.
 */
export function useHasBeenFocused(): boolean {
  const isFocused = useIsFocused();
  const [hasBeenFocused, setHasBeenFocused] = useState(isFocused);
  // Render-phase update of this component's own state: React re-runs the render
  // with the latched value before committing, so no extra commit is spent.
  if (isFocused && !hasBeenFocused) setHasBeenFocused(true);
  return hasBeenFocused || isFocused;
}
