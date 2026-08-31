import { useEffect } from 'react';
import { BackHandler } from 'react-native';

/**
 * Swallow the Android hardware back button while a mandatory onboarding step is
 * mounted.
 *
 * The onboarding route is registered `presentation: 'fullScreenModal'` with
 * `gestureEnabled: false` (app/_layout.tsx), which closes the iOS swipe-dismiss.
 * Android's hardware back is a separate exit and pops the screen regardless — so
 * without this, every "no way to skip" step still has one, and it is the exit
 * that leaves no trace in the funnel beyond a Dismissed event.
 *
 * Returning `true` marks the press handled and stops the default pop. There is
 * deliberately no escape argument: a step that can be backed out of is not a
 * mandatory step, and the one screen that legitimately needs an exit (the board
 * step with no connection and nothing cached) offers it as a visible button.
 */
export function useBlockBack(): void {
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => subscription.remove();
  }, []);
}
