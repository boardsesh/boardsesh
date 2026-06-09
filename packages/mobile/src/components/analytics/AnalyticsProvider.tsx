import { useEffect, type ReactNode } from 'react';
import { StyleSheet } from 'react-native';
import { PostHogProvider } from 'posthog-react-native';
import { getAnalyticsClient, setSessionRecordingEnabled } from '../../lib/analytics';
import { loadSessionRecordingEnabled } from '../../lib/session-recording-preference';

// PostHogProvider renders a touch-capturing View around its subtree; without
// flex:1 it would collapse the app layout to zero height.
const styles = StyleSheet.create({ root: { flex: 1 } });

// Wraps the app in PostHogProvider when analytics is live. Touch and screen
// autocapture stay OFF: the app has auth forms and free-text fields, and
// posthog-react-native can't read Expo Router's navigation container reliably
// anyway. AnalyticsScreenTracker emits explicit $screen events instead, and
// user actions are tracked from reviewed call sites. When analytics is disabled
// (dev / no key) this renders children untouched — mirroring how wrapWithSentry
// returns the component unchanged when Sentry is off.
export function AnalyticsProvider({ children }: { children: ReactNode }) {
  const client = getAnalyticsClient();

  // Restore the user's session-recording opt-in at startup. Off by default —
  // this only resumes recording for someone who previously turned diagnostics on.
  // No-op when analytics is disabled (setSessionRecordingEnabled guards on a null
  // client). Runs once.
  useEffect(() => {
    loadSessionRecordingEnabled()
      .then((enabled) => {
        if (enabled) setSessionRecordingEnabled(true);
      })
      .catch(() => {
        // A failed preference read leaves recording off (the safe default).
      });
  }, []);

  if (!client) return <>{children}</>;
  return (
    <PostHogProvider client={client} autocapture={{ captureTouches: false, captureScreens: false }} style={styles.root}>
      {children}
    </PostHogProvider>
  );
}
