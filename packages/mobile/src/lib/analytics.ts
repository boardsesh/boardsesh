import type { PostHog } from 'posthog-react-native';
import { createAnalytics } from '@boardsesh/analytics';
import { getPostHogClient, registerAppSuperProperties } from './posthog-client';

type PosthogFeatureFlagClient = {
  getFeatureFlag?: (key: string) => unknown;
  isFeatureEnabled?: (key: string) => unknown;
  reloadFeatureFlags?: () => unknown;
  onFeatureFlags?: (callback: () => void) => unknown;
};

// Lazily construct a single PostHog client. Returns null in dev / when unkeyed,
// which makes every wrapper method a no-op. In dev the createAnalytics debug
// hook still logs the event so you can watch instrumentation fire without
// sending anything.
function getClient(): PostHog | null {
  return getPostHogClient();
}

// Start/stop session recording. The resolved preference decides whether it runs
// (opt-in only — see session-recording-preference); this just applies it.
// startSessionRecording() lazily initialises the native replay SDK with the
// masking config above; stopSessionRecording() halts it. No-op when analytics is
// disabled (dev / no key) because getClient() returns null. Safe to call before
// the client is built — getClient() constructs it on demand.
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

// Register PostHog super properties — values stamped onto every subsequent event
// from this client until unregistered / reset. OtaUpdateTracker uses this to tag
// the OTA cohort (update id, embedded-vs-OTA, fingerprint) onto all events so any
// existing funnel can be sliced by it. Guarded like the optional feature-flag
// methods: no-op when analytics is disabled (dev / no key) or the SDK build
// lacks register().
export function registerSuperProperties(properties: Record<string, string | number | boolean | null>): void {
  const client = getClient();
  if (!client) return;
  // PostHog.register is part of the typed API, so this is compile-time safe — no
  // duck-typing. Fire-and-forget (it returns a Promise) to match track()'s
  // ergonomics; no-op when analytics is disabled (getClient() returned null).
  void client.register(properties);
}

function coerceFeatureFlagBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function asFeatureFlagClient(posthog: PostHog): PosthogFeatureFlagClient {
  return posthog as unknown as PosthogFeatureFlagClient;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const thenValue = (value as { then?: unknown }).then;
  return typeof thenValue === 'function';
}

export function readPosthogFeatureFlags(keys: readonly string[]): Record<string, boolean> {
  const posthog = getClient();
  if (!posthog) return {};
  const featureFlagClient = asFeatureFlagClient(posthog);
  const flags: Record<string, boolean> = {};

  for (const key of keys) {
    let rawFlagValue: unknown;
    if (typeof featureFlagClient.getFeatureFlag === 'function') {
      rawFlagValue = featureFlagClient.getFeatureFlag(key);
    } else if (typeof featureFlagClient.isFeatureEnabled === 'function') {
      rawFlagValue = featureFlagClient.isFeatureEnabled(key);
    }
    const flagValue = coerceFeatureFlagBoolean(rawFlagValue);
    if (flagValue !== undefined) {
      flags[key] = flagValue;
    }
  }

  return flags;
}

export function subscribePosthogFeatureFlags(onChange: () => void): () => void {
  const posthog = getClient();
  if (!posthog) return () => {};
  const featureFlagClient = asFeatureFlagClient(posthog);

  const reloadResult =
    typeof featureFlagClient.reloadFeatureFlags === 'function' ? featureFlagClient.reloadFeatureFlags() : undefined;
  if (isPromiseLike(reloadResult)) {
    void Promise.resolve(reloadResult)
      .then(onChange)
      .catch(() => {});
  }

  if (typeof featureFlagClient.onFeatureFlags !== 'function') {
    return () => {};
  }

  const unsubscribe = featureFlagClient.onFeatureFlags(onChange);
  if (typeof unsubscribe === 'function') {
    return unsubscribe as () => void;
  }
  return () => {};
}

const analytics = createAnalytics(getClient, {
  onDebug: __DEV__ ? (name, properties) => console.info('[analytics]', name, properties ?? {}) : undefined,
});

export const { track, identify, setPersonProperties, alias } = analytics;

// PostHog's reset() clears the distinct id AND every registered super property,
// but getPostHogClient() caches the singleton, so the registrations it does at
// construction never run again. Re-register the build-level ones straight after
// so a logout / forced sign-out / account switch doesn't silently drop them for
// the rest of the launch — `environment` (without it, a tester's preview traffic
// reads as production again, reopening #3814) and `$raw_user_agent` (without it,
// PostHog bot-filters the events). Person-scoped properties are meant to be
// cleared and are deliberately not restored.
export function reset(): boolean {
  const didReset = analytics.reset();
  const client = getClient();
  if (client) registerAppSuperProperties(client);
  return didReset;
}

// Manual screen view — the RN analogue of web's $pageview. PostHog's screen
// autocapture can't read Expo Router's navigation, so AnalyticsScreenTracker
// calls this from a route-change effect. `screen()` emits the native $screen
// event PostHog's mobile insights key off.
export function trackScreen(path: string): void {
  if (__DEV__) console.info('[analytics] $screen', path);
  void getClient()?.screen(path);
}
