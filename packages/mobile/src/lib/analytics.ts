import { PostHog } from 'posthog-react-native';
import { createAnalytics } from '@boardsesh/analytics';

// PostHog project token. Intentionally the SAME project as web so a signed-in
// user's web + mobile activity resolves to one person. `EXPO_PUBLIC_*` vars are
// inlined into the JS bundle at build time, so this must be set when the bundle
// (OTA or native) is built — not merely present at runtime.
const apiKey = process.env.EXPO_PUBLIC_POSTHOG_KEY;
// Native apps have no ad-blocker / first-party-cookie concern, so we talk to
// PostHog cloud directly rather than the backend reverse proxy the web app uses.
const host = process.env.EXPO_PUBLIC_POSTHOG_HOST ?? 'https://us.i.posthog.com';

// Mirrors src/lib/sentry.ts (isSentryEnabled): live only in non-dev builds with
// a key configured. Preview (TestFlight / internal) and production builds are
// both `!__DEV__`, so analytics flows from them; local Metro dev never sends.
export const isAnalyticsEnabled = !!apiKey && !__DEV__;

let client: PostHog | null = null;
let initAttempted = false;

// Lazily construct a single PostHog client. Returns null in dev / when unkeyed,
// which makes every wrapper method a no-op. In dev the createAnalytics debug
// hook still logs the event so you can watch instrumentation fire without
// sending anything.
function getClient(): PostHog | null {
  if (!isAnalyticsEnabled || !apiKey) return null;
  if (client) return client;
  if (initAttempted) return null;
  initAttempted = true;
  // captureAppLifecycleEvents defaults on (Application Opened/Backgrounded etc.);
  // expo-device + expo-application (installed) enrich events with $device_model,
  // $os_version, $app_version. Screen autocapture is handled in AnalyticsProvider.
  //
  // Known gap: this client is constructed at AnalyticsProvider mount (top of the
  // tree), so the first Application Opened fires under PostHog's auto-generated
  // anonymous distinct_id — before PartyProfileProvider has run identify() with
  // the party-profile UUID (and, for signed-in users, the alias to the user).
  // PostHog merges those early events into the person record once the alias is
  // processed, so this is acceptable (web has the same cold-start window), but
  // don't be surprised to see a few lifecycle events on a transient anon id.
  client = new PostHog(apiKey, {
    host,
    // Session replay stays OFF by construction: `enableSessionReplay` defaults
    // false, so the SDK NEVER auto-records — capture only ever begins when a user
    // opts in via setSessionRecordingEnabled() → startSessionRecording(), which
    // lazily initialises the native replay SDK. The masking below is what gets
    // applied at that point: text inputs + images stay masked (the app has auth
    // forms and white dark-mode input fields), and console capture is left on so
    // the BLE console.warn/error lines land on the replay timeline.
    sessionReplayConfig: {
      maskAllTextInputs: true,
      maskAllImages: true,
      captureLog: true,
    },
  });
  return client;
}

// Opt-in diagnostics session recording. Off by default — nothing records until a
// climber turns it on (see session-recording-preference). startSessionRecording()
// lazily initialises the native replay SDK with the masking config above;
// stopSessionRecording() halts it. No-op when analytics is disabled (dev / no
// key) because getClient() returns null. Safe to call before the client is built
// — getClient() constructs it on demand.
export function setSessionRecordingEnabled(enabled: boolean): void {
  const client = getClient();
  if (!client) return;
  if (enabled) {
    void client.startSessionRecording();
  } else {
    void client.stopSessionRecording();
  }
}

// Exposed so AnalyticsProvider can hand the same instance to PostHogProvider for
// touch autocapture — one client drives both manual events and autocapture.
export function getAnalyticsClient(): PostHog | null {
  return getClient();
}

const analytics = createAnalytics(getClient, {
  onDebug: __DEV__ ? (name, properties) => console.info('[analytics]', name, properties ?? {}) : undefined,
});

export const { track, identify, setPersonProperties, alias, reset } = analytics;

// Manual screen view — the RN analogue of web's $pageview. PostHog's screen
// autocapture can't read Expo Router's navigation, so AnalyticsScreenTracker
// calls this from a route-change effect. `screen()` emits the native $screen
// event PostHog's mobile insights key off.
export function trackScreen(path: string): void {
  if (__DEV__) console.info('[analytics] $screen', path);
  void getClient()?.screen(path);
}
