import { PostHog, type PostHogOptions } from 'posthog-react-native';
import { getAnalyticsBootstrapId } from './analytics-bootstrap-id';
import { resolveAppEnvironment } from './app-environment';
import { assertNetworkAllowed, isNetworkAllowed, subscribeNetworkPolicy } from './network-policy';

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
    void Promise.resolve(client.register({ $raw_user_agent: MOBILE_USER_AGENT })).catch((error: unknown) => {
      if (__DEV__) console.warn('[analytics] failed to register $raw_user_agent super property', error);
    });
  } catch (error) {
    if (__DEV__) console.warn('[analytics] failed to register $raw_user_agent super property', error);
  }
}

// Registers the resolved app environment ('production' / 'preview', shared with
// Sentry — see app-environment.ts) as a super property on every event. Without
// this, mobile PostHog events carried no environment tag at all — `pr-*` OTA
// preview traffic was indistinguishable from real production usage in every
// event except the once-per-launch `OTA Update Status` event (#3814). Exported
// like registerMobileUserAgent so the call site is unit-testable; same
// best-effort contract (a failure here must never block analytics init).
export function registerAppEnvironment(client: Pick<PostHog, 'register'>): void {
  try {
    void Promise.resolve(client.register({ environment: resolveAppEnvironment() })).catch((error: unknown) => {
      if (__DEV__) console.warn('[analytics] failed to register environment super property', error);
    });
  } catch (error) {
    if (__DEV__) console.warn('[analytics] failed to register environment super property', error);
  }
}

// The super properties that describe the app build rather than the person, so
// they belong on every event no matter who is signed in. Registered at client
// construction AND re-registered after analytics.reset(): PostHog's reset()
// clears every registered super property, and getPostHogClient() caches the
// singleton, so without a re-register a logout / forced sign-out / account
// switch drops them for the rest of the launch — `environment` (preview traffic
// would look like production again, reopening #3814) and `$raw_user_agent`
// (PostHog bot-filters events that have no UA).
export function registerAppSuperProperties(client: Pick<PostHog, 'register'>): void {
  registerMobileUserAgent(client);
  registerAppEnvironment(client);
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

/**
 * The SDK owns timer, AppState, flag and remote-config requests that do not pass
 * through Boardsesh's `track()` wrapper. Keep the policy at its final transport
 * seam too, so an already-created client cannot make a request after the user
 * enables hard-offline mode.
 */
export class NetworkPolicyPostHog extends PostHog {
  override fetch(url: string, options: Parameters<PostHog['fetch']>[1]): ReturnType<PostHog['fetch']> {
    assertNetworkAllowed('telemetry');
    return super.fetch(url, options);
  }
}

// Pure so the bootstrap wiring is unit-testable without constructing a real
// PostHog client (isAnalyticsEnabled is always false in the test env).
// `bootstrapDistinctId` is the party-profile UUID resolved synchronously by the
// caller, or null if that read/create failed — in which case bootstrap is
// omitted entirely and the SDK falls back to its own anonymous id, exactly as
// before this option existed.
export function buildPostHogOptions(postHogHost: string, bootstrapDistinctId: string | null): PostHogOptions {
  return {
    host: postHogHost,
    bootstrap: bootstrapDistinctId ? { distinctId: bootstrapDistinctId, isIdentifiedId: false } : undefined,
    // The app already emits explicit $screen events plus reviewed product
    // events. SDK lifecycle autocapture adds high-volume foreground/background
    // noise and does not help answer product or BLE reliability questions.
    captureAppLifecycleEvents: false,
    // `enableSessionReplay` defaults false, so the SDK never auto-records.
    // Capture only begins when setSessionRecordingEnabled() calls
    // startSessionRecording(), which lazily initialises the native replay SDK.
    sessionReplayConfig: {
      maskAllTextInputs: true,
      maskAllImages: true,
      captureLog: true,
    },
  };
}

// Construct or return the single PostHog client. Returns null in dev / when
// unkeyed, which makes every wrapper method a no-op. PostHog is product
// analytics only — error/crash reporting goes to Sentry (src/lib/sentry.ts).
export function getPostHogClient(): PostHog | null {
  if (!isAnalyticsEnabled || !apiKey || !isNetworkAllowed('telemetry')) return null;
  if (client) return client;
  if (initAttempted) return null;
  initAttempted = true;
  // getAnalyticsBootstrapId() reads a slot that analytics-bootstrap.ts (wired
  // up in app/_layout.tsx, ahead of anything that imports this module)
  // resolves synchronously via expo-secure-store's JSI sync API. We still pass
  // it as `bootstrap` so the SDK's anonymous id is stable before explicit
  // screen/action events start flowing.
  const bootstrapDistinctId = getAnalyticsBootstrapId();
  client = new NetworkPolicyPostHog(apiKey, buildPostHogOptions(host, bootstrapDistinctId));
  registerAppSuperProperties(client);
  return client;
}

// A native replay may outlive the React effect that enabled it. Stop that
// independently from getPostHogClient(), which intentionally returns null once
// telemetry is blocked. The transport subclass above remains the hard network
// boundary while the native stop settles.
subscribeNetworkPolicy(() => {
  if (!isNetworkAllowed('telemetry') && client) void client.stopSessionRecording();
});

if (isAnalyticsEnabled && isNetworkAllowed('telemetry')) {
  getPostHogClient();
}
