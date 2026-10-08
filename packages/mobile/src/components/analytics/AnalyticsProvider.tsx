import { useAnalyticsConsent } from '../../lib/consent-hooks';
import { useEffect, type ReactNode } from 'react';
import { setSessionRecordingEnabled } from '../../lib/analytics';
import { startConnectivityTracking } from '../../lib/analytics-connectivity';
import { loadSessionRecordingEnabled } from '../../lib/session-recording-preference';

// Reviewed manual capture calls use the singleton directly. Keeping the tree
// stable avoids remounting auth and SQLite when analytics becomes available.
export function AnalyticsProvider({ children }: { children: ReactNode }) {
  const granted = useAnalyticsConsent();

  // Apply the session-recording preference at startup. Recording is opt-in only:
  // absent an explicit Privacy-toggle choice, the resolved preference is OFF.
  // Starts recording when the resolved preference is on. No-op when analytics is
  // disabled (setSessionRecordingEnabled guards on a null client). Runs once.
  useEffect(() => {
    loadSessionRecordingEnabled()
      .then((enabled) => {
        setSessionRecordingEnabled(enabled && granted);
      })
      .catch(() => {
        // A failed preference read leaves recording off (the safe default).
      });
  }, [granted]);

  // Stamp `connectivity` on every event and keep it current for the launch.
  // Declared BEFORE the `!client` early return so the hook order stays stable
  // when analytics is disabled; startConnectivityTracking is itself a no-op
  // against a null client, so running it either way costs nothing.
  useEffect(() => startConnectivityTracking(), []);

  return <>{children}</>;
}
