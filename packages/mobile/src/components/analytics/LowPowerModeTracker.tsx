import { useEffect } from 'react';
import { addLowPowerModeListener, isLowPowerModeEnabledAsync } from 'expo-battery';
import { registerLowPowerMode } from '../../lib/analytics-low-power-mode';

/**
 * Keeps the `low_power_mode` super property in step with the phone's power
 * state (issue #5187). Reads it once on mount, then follows the OS event for
 * the rest of the launch. Renders nothing; mounted once near the app root
 * beside OtaUpdateTracker.
 *
 * Both calls are best effort. Expo web has no power-mode API and answers
 * `false`; a simulator answers `false` too. Neither is worth a warning.
 */
export function LowPowerModeTracker(): null {
  useEffect(() => {
    let cancelled = false;
    isLowPowerModeEnabledAsync()
      .then((lowPowerMode) => {
        if (!cancelled) registerLowPowerMode(lowPowerMode);
      })
      .catch(() => {
        // No power-state API on this platform: leave the property unset rather
        // than registering a guess.
      });
    // Same posture as the read above: a platform without the listener must
    // not turn into a thrown effect at the root layout.
    let subscription: { remove(): void } | undefined;
    try {
      subscription = addLowPowerModeListener(({ lowPowerMode }) => {
        registerLowPowerMode(lowPowerMode);
      });
    } catch {
      // No listener on this platform; the one-off read above is all there is.
    }
    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, []);
  return null;
}
