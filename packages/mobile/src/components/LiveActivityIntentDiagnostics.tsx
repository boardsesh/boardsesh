import { useEffect } from 'react';
import { AppState } from 'react-native';
import {
  consumeInterruptedLiveActivityIntentRuns,
  markLiveActivityIntentReactRootMounted,
} from '../lib/live-activity/live-activity-plugin';
import { captureLiveActivityIntentDiagnostic, isSentryEnabled } from '../lib/sentry';

export async function consumeAndReportInterruptedLiveActivityIntents(): Promise<void> {
  // Consuming is destructive — the native store drops the records — so leave
  // them stored until a reporter exists. A production build whose Sentry DSN
  // is missing or mis-injected must not silently destroy the evidence #4077
  // needs; the store is ring- and TTL-bounded, so deferring costs nothing.
  if (!isSentryEnabled) return;
  const diagnostics = await consumeInterruptedLiveActivityIntentRuns();
  for (const diagnostic of diagnostics) {
    captureLiveActivityIntentDiagnostic(diagnostic);
  }
}

/**
 * Root-mounted lifecycle seam for #4077. Its effect proves React committed in
 * this process, then consumes interrupted previous-process intent markers only
 * while the app is foregrounded. It renders no UI and is safe on Android, web,
 * Expo Go, and iOS binaries that predate the optional native methods.
 */
export function LiveActivityIntentDiagnostics() {
  useEffect(() => {
    let disposed = false;
    // AppState can emit repeated `active` notifications during one transition.
    // Keep native consumption single-flight so the once-only store is not read
    // concurrently and each returned diagnostic is reported at most once.
    let consumptionInFlight = false;

    const consumeIfForegrounded = async () => {
      if (disposed || consumptionInFlight || AppState.currentState !== 'active') return;
      consumptionInFlight = true;
      try {
        await consumeAndReportInterruptedLiveActivityIntents();
      } finally {
        consumptionInFlight = false;
      }
    };

    // This runs after the actual root commit, not during module evaluation.
    void markLiveActivityIntentReactRootMounted().then(() => consumeIfForegrounded());

    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        void consumeIfForegrounded();
      }
    });

    return () => {
      disposed = true;
      subscription.remove();
    };
  }, []);

  return null;
}
