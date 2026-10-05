import { PostHog, type PostHogOptions } from 'posthog-react-native';
import { resolveAnalyticsUserAgent } from './analytics-user-agent';
import { resolveAppEnvironment } from './app-environment';

// Registers the User-Agent as a super property on every event: the static,
// non-bot app constant on native, the real browser UA in the Expo browser app
// (see analytics-user-agent.web.ts), and nothing at all when that browser has
// no UA, so PostHog flags the event as it does on www. Exported so the call site is unit-testable:
// getPostHogClient() returns null before reaching its own call to this whenever
// analytics is disabled (no token, or __DEV__ — both hold in the test env), so
// the live path can't run in tests. Best-effort: a failure must never block
// analytics init.
export function registerMobileUserAgent(client: Pick<PostHog, 'register'>): void {
  const userAgent = resolveAnalyticsUserAgent();
  if (!userAgent) return;
  try {
    void Promise.resolve(client.register({ $raw_user_agent: userAgent })).catch((error: unknown) => {
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

// Pure so the options are unit-testable without constructing a real PostHog
// client (isAnalyticsEnabled is always false in the test env).
//
// There is no `bootstrap` on purpose. The SDK mints and persists its own
// anonymous id, and that id is the only anonymous identity the app has: see the
// header of packages/shared/analytics/src/reconcile-identity.ts. The option
// used to carry the party-profile UUID, but the slot it read was still empty
// when this module was evaluated (expo-router loads `app/(tabs)/_layout.tsx`,
// which reaches this file, before the root layout that filled the slot), so it
// never took effect on a device.
export function buildPostHogOptions(postHogHost: string): PostHogOptions {
  return {
    host: postHogHost,
    // Every event builds a person, signed out included. The SDK default,
    // `identified_only`, sends signed-out events personless until something
    // identifies or sets a person property. The app never ran that way: its old
    // signed-out identify() switched person processing on at every launch. That
    // call is gone (reconcile-identity.ts, rule 2), so this keeps what it did for
    // person counts and `person.properties` breakdowns on signed-out traffic.
    // It does not mark anyone identified: an anonymous person made this way
    // still merges into an account on sign-in.
    personProfiles: 'always',
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
  if (!isAnalyticsEnabled || !apiKey) return null;
  if (client) return client;
  if (initAttempted) return null;
  initAttempted = true;
  client = new PostHog(apiKey, buildPostHogOptions(host));
  registerAppSuperProperties(client);
  return client;
}

if (isAnalyticsEnabled) {
  getPostHogClient();
}
