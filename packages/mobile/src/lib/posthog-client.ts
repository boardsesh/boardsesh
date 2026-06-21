import { PostHog } from 'posthog-react-native';

// PostHog flags events with an empty User-Agent as bots, and the RN SDK sends no
// UA it stores — so without this, real mobile traffic hides behind the bot filter.
// Static, non-bot constant (not `react-native` Platform) to keep the RN Flow
// barrel out of this module's graph, which would break the node-env test runner.
export const MOBILE_USER_AGENT = 'Boardsesh Mobile';

// Registers the non-bot User-Agent as a super property on every event. Exported
// so the call site is unit-testable: getPostHogClient() returns null before
// reaching its own call to this whenever analytics is disabled (no token, or
// __DEV__ — both hold in the test env), so the live path can't run in tests.
// Best-effort: a failure must never block analytics init.
export function registerMobileUserAgent(client: Pick<PostHog, 'register'>): void {
  try {
    client.register({ $raw_user_agent: MOBILE_USER_AGENT });
  } catch (error) {
    if (__DEV__) console.warn('[analytics] failed to register $raw_user_agent super property', error);
  }
}

// PostHog project token. Intentionally the SAME project as web so a signed-in
// user's web + mobile activity resolves to one person. `EXPO_PUBLIC_*` vars are
// inlined into the JS bundle at build time, so this must be set when the bundle
// (OTA or native) is built, not merely present at runtime.
const apiKey = process.env.EXPO_PUBLIC_POSTHOG_KEY;
// Native apps have no ad-blocker / first-party-cookie concern, so we talk to
// PostHog cloud directly rather than the backend reverse proxy the web app uses.
const host = process.env.EXPO_PUBLIC_POSTHOG_HOST ?? 'https://us.i.posthog.com';

// Live only in non-dev builds with a key configured. Preview (TestFlight /
// internal) and production builds are both `!__DEV__`, so telemetry flows from
// them; local Metro dev never sends.
export const isAnalyticsEnabled = !!apiKey && !__DEV__;

let client: PostHog | null = null;
let initAttempted = false;

// Construct or return the single PostHog client. Returns null in dev / when
// unkeyed, which makes every wrapper method a no-op. PostHog is product
// analytics only — error/crash reporting goes to Sentry (src/lib/sentry.ts).
export function getPostHogClient(): PostHog | null {
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
  // anonymous distinct_id before PartyProfileProvider has run identify() with
  // the party-profile UUID (and, for signed-in users, the alias to the user).
  // PostHog merges those early events into the person record once the alias is
  // processed, so this is acceptable (web has the same cold-start window), but
  // don't be surprised to see a few lifecycle events on a transient anon id.
  client = new PostHog(apiKey, {
    host,
    // `enableSessionReplay` defaults false, so the SDK never auto-records.
    // Capture only begins when setSessionRecordingEnabled() calls
    // startSessionRecording(), which lazily initialises the native replay SDK.
    sessionReplayConfig: {
      maskAllTextInputs: true,
      maskAllImages: true,
      captureLog: true,
    },
  });
  registerMobileUserAgent(client);
  return client;
}

if (isAnalyticsEnabled) {
  getPostHogClient();
}
