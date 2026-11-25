// Re-reads a permission when the app comes back to the front.
//
// expo's permission hooks (`useCameraPermissions`) read the status once, on
// mount. A climber who taps Open Settings, turns the camera on and switches
// back finds the scan screen still mounted, so without this it would keep
// saying the camera is off until they left and came back.

import { useEffect } from 'react';
import { AppState } from 'react-native';

/**
 * Calls `recheck` each time the app returns to `active` from the background or
 * an interruption. Pass a stable function (expo's permission getter is one).
 */
export function useRecheckOnForeground(recheck: () => Promise<unknown>): void {
  useEffect(() => {
    let previousState = AppState.currentState;
    const subscription = AppState.addEventListener('change', (nextState) => {
      const cameBack = nextState === 'active' && previousState !== 'active';
      previousState = nextState;
      // A failed re-read keeps the last answer on screen.
      if (cameBack) recheck().catch(() => undefined);
    });
    return () => subscription.remove();
  }, [recheck]);
}
