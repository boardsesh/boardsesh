import { useEffect, type ReactNode } from 'react';
import { StyleSheet } from 'react-native';
import { PostHogProvider } from 'posthog-react-native';
import { getAnalyticsClient, setSessionRecordingEnabled } from '../../lib/analytics';
import { startConnectivityTracking } from '../../lib/analytics-connectivity';
import { loadSessionRecordingEnabled } from '../../lib/session-recording-preference';
import { isNetworkAllowed, subscribeNetworkPolicy } from '../../lib/network-policy';

// PostHogProvider renders a touch-capturing View around its subtree; without
// flex:1 it would collapse the app layout to zero height.
const styles = StyleSheet.create({ root: { flex: 1 } });

// Wraps the app in PostHogProvider when analytics is live. Touch and screen
// autocapture stay OFF: the app has auth forms and free-text fields, and
// posthog-react-native can't read Expo Router's navigation container reliably
// anyway. AnalyticsScreenTracker emits explicit $screen events instead, and
// user actions are tracked from reviewed call sites. When analytics is disabled
// (dev / no key) this renders children untouched.
export function AnalyticsProvider({ children }: { children: ReactNode }) {
  const client = getAnalyticsClient();

  // Apply the session-recording preference at startup. Recording is opt-in only:
  // absent an explicit Privacy-toggle choice, the resolved preference is OFF.
  // Starts recording when the resolved preference is on. No-op when analytics is
  // disabled (setSessionRecordingEnabled guards on a null client). Runs once.
  useEffect(() => {
    let mounted = true;
    let recordingPreference = false;
    const applyPolicy = () => {
      if (!mounted) return;
      setSessionRecordingEnabled(recordingPreference && isNetworkAllowed('telemetry'));
    };
    const unsubscribe = subscribeNetworkPolicy(applyPolicy);
    loadSessionRecordingEnabled()
      .then((enabled) => {
        recordingPreference = enabled;
        applyPolicy();
      })
      .catch(() => {
        // A failed preference read leaves recording off (the safe default).
      });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  // Stamp `connectivity` on every event and keep it current for the launch.
  // Declared BEFORE the `!client` early return so the hook order stays stable
  // when analytics is disabled; startConnectivityTracking is itself a no-op
  // against a null client, so running it either way costs nothing.
  useEffect(() => startConnectivityTracking(), []);

  if (!client) return <>{children}</>;
  return (
    <PostHogProvider client={client} autocapture={{ captureTouches: false, captureScreens: false }} style={styles.root}>
      {children}
    </PostHogProvider>
  );
}
