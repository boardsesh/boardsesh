import type { PostHog } from 'posthog-react-native';
import { createAnalytics, type GlowFalloffSource } from '@boardsesh/analytics';
import { getPostHogClient, registerAppSuperProperties } from './posthog-client';
import { registerConnectivitySuperProperty } from './analytics-connectivity';
import { reregisterOfflineEngineState } from './analytics-offline-engine-state';
import { reregisterActiveGym } from './analytics-gym';
import { reregisterLowPowerMode } from './analytics-low-power-mode';

// `sendEvent: false` suppresses the SDK's `$feature_flag_called` capture. Verified
// in @posthog/core 1.46.1 (shared by posthog-react-native and posthog-js-lite):
// `_getFeatureFlagResult` gates the capture on it, and both `getFeatureFlag` and
// `isFeatureEnabled` forward it. Flag VALUES are unaffected.
type FeatureFlagReadOptions = { sendEvent?: boolean };
type PosthogFeatureFlagClient = {
  getFeatureFlag?: (key: string, options?: FeatureFlagReadOptions) => unknown;
  isFeatureEnabled?: (key: string, options?: FeatureFlagReadOptions) => unknown;
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

/**
 * Coerce one raw PostHog flag value to what the catalog expects.
 *
 * A definition carrying a `variants` list is **multivariate**: PostHog resolves
 * it to one of those strings, and only a declared member survives verbatim.
 * Anything else — a boolean (which is what PostHog returns when the flag
 * matched no variant), an unknown string, an unresolved read — is `undefined`,
 * meaning "fall back to the shipped default".
 *
 * Without a `variants` list the flag is a plain boolean and anything that is
 * not one reads as `undefined`, which also absorbs a stale variant string left
 * over from when a flag used to be multivariate.
 */
function coerceFeatureFlagValue(value: unknown, variants?: readonly string[]): boolean | string | undefined {
  if (variants && variants.length > 0) {
    return typeof value === 'string' && variants.includes(value) ? value : undefined;
  }

  if (typeof value === 'boolean') return value;
  // The SDK sometimes hands back the string form; normalise it rather than
  // dropping a flag that IS resolved.
  if (value === 'true') return true;
  if (value === 'false') return false;
  // Anything else — including a stale variant string from when a flag was
  // multivariate — reads as unresolved.
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

// FeatureFlagsProvider re-reads the WHOLE flag catalog on every flags-changed
// tick, so leaving exposure events on cost ~173k events / 30 days across mobile +
// web — 13% of the project's entire volume — for a signal nothing consumed: the
// project runs no experiments, and the only insights referencing
// `$feature_flag_called` are PostHog's auto-generated "<flag> Usage" boilerplate.
// Drop the option at a specific call site if that flag ever needs real exposure
// analysis (an experiment reads these events to assign variants to outcomes).
const READ_WITHOUT_EXPOSURE_EVENT: FeatureFlagReadOptions = { sendEvent: false };

/**
 * The minimal shape `readPosthogFeatureFlags` needs from a flag definition.
 * Declared locally (not imported from feature-flags-provider.tsx) because that
 * module already imports this function — a type-only import back would form a
 * circular dependency for no benefit.
 */
type FeatureFlagDefinitionLike = { key: string; variants?: readonly string[] };

export function readPosthogFeatureFlags(
  definitions: readonly FeatureFlagDefinitionLike[],
): Record<string, boolean | string> {
  const posthog = getClient();
  if (!posthog) return {};
  const featureFlagClient = asFeatureFlagClient(posthog);
  const flags: Record<string, boolean | string> = {};

  for (const definition of definitions) {
    let rawFlagValue: unknown;
    if (typeof featureFlagClient.getFeatureFlag === 'function') {
      rawFlagValue = featureFlagClient.getFeatureFlag(definition.key, READ_WITHOUT_EXPOSURE_EVENT);
    } else if (typeof featureFlagClient.isFeatureEnabled === 'function') {
      rawFlagValue = featureFlagClient.isFeatureEnabled(definition.key, READ_WITHOUT_EXPOSURE_EVENT);
    }
    const flagValue = coerceFeatureFlagValue(rawFlagValue, definition.variants);
    if (flagValue !== undefined) {
      flags[definition.key] = flagValue;
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

/**
 * Stamp the board-render A/B state (issue #2202) as PostHog super properties,
 * so every event fired for the rest of the launch — not just the board-render
 * events themselves — can be sliced by which drawing and which glow falloff
 * this climber is on. Mirrors `registerConnectivitySuperProperty` /
 * `registerOfflineEngineState`: best-effort, and a no-op when analytics is
 * disabled (dev / no key).
 *
 * Call it whenever `effectiveRenderSettings` changes, not on every render —
 * each call is a persisted `register()` write.
 */
export function registerRenderSuperProperties(effective: {
  mode: 'classic' | 'aura';
  glowFalloff: 'soft' | 'plateau';
  // The shared type, not a copy of it. Spelling the union out here is what let
  // it keep listing `'flag'` after `board-glow-falloff` was retired — a value
  // nothing could emit, reaching a super property and splitting every query by
  // a cohort that does not exist.
  glowFalloffSource: GlowFalloffSource;
}): void {
  registerSuperProperties({
    render_mode: effective.mode,
    glow_falloff: effective.glowFalloff,
    glow_falloff_source: effective.glowFalloffSource,
  });
}

// PostHog's reset() clears the distinct id AND every registered super property,
// but getPostHogClient() caches the singleton, so the registrations it does at
// construction never run again. Re-register the build-level ones straight after
// so a logout / forced sign-out / account switch doesn't silently drop them for
// the rest of the launch — `environment` (without it, a tester's preview traffic
// reads as production again, reopening #3814) and `$raw_user_agent` (without it,
// PostHog bot-filters the events). Person-scoped properties are meant to be
// cleared and are deliberately not restored.
//
// `connectivity` goes back on for the same reason: it is registered once at
// startup and then only on a network transition, so a sign-out that dropped it
// would leave every remaining event of the launch unattributed to online or
// offline unless the user happened to change networks (issue #4317).
//
// `offline_engine_state` is the same shape of problem and worse: it is
// registered exactly once, from a flag effect that will not run again for the
// rest of the launch, so a dropped value never comes back on its own and the
// #4312 bake measurement would stop at the first sign-out.
//
// `gym_uuid` / `gym_name` are restored for the same reason: the active board
// does not change on sign-out, so AnalyticsGymProperties' effect will not re-run
// and every remaining event of the launch would lose its venue.
//
// `low_power_mode` too: it only moves on a power-state transition, so a
// sign-out would strip it from every event until the climber plugs in.
export function reset(): boolean {
  const didReset = analytics.reset();
  const client = getClient();
  if (client) {
    registerAppSuperProperties(client);
    registerConnectivitySuperProperty(client);
    reregisterOfflineEngineState(client);
    reregisterActiveGym(client);
    reregisterLowPowerMode(client);
  }
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
