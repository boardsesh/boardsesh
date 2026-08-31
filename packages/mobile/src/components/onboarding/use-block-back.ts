import { useEffect } from 'react';
import { BackHandler } from 'react-native';
import { useIsFocused } from 'expo-router';

/**
 * Swallow the Android hardware back button while a mandatory onboarding step is
 * the screen in front of the climber.
 *
 * The onboarding route is registered `presentation: 'fullScreenModal'` with
 * `gestureEnabled: false` (app/_layout.tsx), which closes the iOS swipe-dismiss.
 * Android's hardware back is a separate exit and pops the screen regardless — so
 * without this, every "no way to skip" step still has one, and it is the exit
 * that leaves no trace in the funnel beyond a Dismissed event.
 *
 * Returning `true` marks the press handled and stops the default pop.
 *
 * **Focus-gated, and that is not optional.** `BackHandler` dispatches to its
 * listeners newest-first and stops at the first one to return `true`. React
 * Navigation registers its own handler once, when the container mounts, so a
 * blocker added later always runs ahead of it — including while the step sits
 * mounted UNDERNEATH a pushed screen. Without the focus check, tapping "Find
 * another board" would leave this handler eating back presses inside `/boards`,
 * `/boards/create` and `/gyms`, killing the back button across the whole
 * find-a-board detour rather than on the one step that wants it blocked.
 *
 * There is deliberately no escape argument: a step that can be backed out of is
 * not a mandatory step, and the one screen that legitimately needs an exit (the
 * board step with no connection and nothing cached) offers it as a button.
 */
export function useBlockBack(): void {
  const isFocused = useIsFocused();

  useEffect(() => {
    if (!isFocused) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => subscription.remove();
  }, [isFocused]);
}
