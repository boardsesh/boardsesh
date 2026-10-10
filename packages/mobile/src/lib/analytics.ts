import type { PostHog } from 'posthog-react-native';
import { createAnalytics, type GlowFalloffSource } from '@boardsesh/analytics';
import { resetScreenSessionGate, shouldEmitScreenForSession } from './analytics-screen-session-gate';
import { getPostHogClient, registerAppSuperProperties } from './posthog-client';
import { registerConnectivitySuperProperty } from './analytics-connectivity';
import { reregisterOfflineEngineState } from './analytics-offline-engine-state';
import { reregisterActiveGym } from './analytics-gym';
import { reregisterLowPowerMode } from './analytics-low-power-mode';
import { reregisterConnectStepArm } from './analytics-connect-step-arm';
import { isProductAnalyticsGranted } from './consent-state';
import { applyPosthogConsent, subscribePosthogInitialized, clearPosthogQueues } from './posthog-client';
import { applySessionReplayConsent } from './session-replay-consent';
import {
  isPosthogFlagResponseCurrent,
  isPosthogFlagBagCurrent,
  subscribePosthogFlagAuthority,
} from './posthog-flag-authority';

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
  getFeatureFlagDetails?: () => { requestId?: unknown } | undefined;
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
  void applySessionReplayConsent(client, enabled).catch(() => {});
}

// Exposed so AnalyticsProvider can hand the same instance to PostHogProvider for
// touch autocapture — one client drives both manual events and autocapture.
export function getAnalyticsClient(): PostHog | null {
  return getClient();
}

// Who the SDK says this device is, read from its persisted state. Null when
// there is no client (dev / no key) or the SDK has not loaded its storage yet:
// both ids come back empty until then, and an empty id answers nothing.
//
// Reading the anonymous id mints and persists one when there is none. That is
// the SDK's own lazy behaviour and it would happen on the next capture anyway.
export function getAnalyticsIdentity(): { distinctId: string; anonymousId: string } | null {
  const client = getClient();
  if (!client) return null;
  const distinctId = client.getDistinctId();
  const anonymousId = client.getAnonymousId();
  if (!distinctId || !anonymousId) return null;
  return { distinctId, anonymousId };
}

// True when the SDK is pinned to a person: `identify()` moved its distinct id
// off its anonymous id. False when it is anonymous, and false when it cannot
// say yet. Callers use this to decide whether a reset() has anything to forget,
// so "cannot say" must not read as "reset": a reset on an anonymous SDK throws
// away the anonymous id a later sign-in needs to merge on. The identity effect
// in party-profile-provider.tsx waits for the SDK and covers that case.
export function isAnalyticsPinnedToAPerson(): boolean {
  const identity = getAnalyticsIdentity();
  return identity !== null && identity.distinctId !== identity.anonymousId;
}

// Runs `callback` once the SDK has loaded its persisted state, which is when
// getAnalyticsIdentity() starts answering. Never runs it when analytics is
// disabled. Returns a cancel function for effect cleanup.
//
// Synchronous when the SDK is already loaded, which is every call after the
// first few hundred milliseconds of a launch. Callers depend on that: two
// effects in one commit run in declaration order only if neither is deferred,
// and party-profile-provider.tsx needs its identify() on the wire before the
// person properties that belong to the identified user.
//
// `ready()` is marked @internal in the SDK typings. It only awaits the storage
// preload. posthog-sdk-contract.test.ts pins that the shipped SDK build still
// has it, so an SDK bump that drops the method fails a test, not a launch.
export function onAnalyticsReady(callback: () => void): () => void {
  const client = getClient();
  if (!client) return () => {};
  if (getAnalyticsIdentity() !== null) {
    callback();
    return () => {};
  }
  let cancelled = false;
  void client
    .ready()
    .then(() => {
      if (!cancelled) callback();
    })
    .catch((error: unknown) => {
      if (__DEV__) console.warn('[analytics] SDK did not become ready', error);
    });
  return () => {
    cancelled = true;
  };
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
  if (readPosthogFeatureFlagsRequestId() === undefined && !isPosthogFlagBagCurrent(posthog)) return {};
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

/**
 * The id of the `/flags` response the current flag bag came from, or undefined
 * when there is none (no client, no flags ever loaded). PostHog persists it
 * with the bag, so on a cold start it names the CACHED response until a new
 * one lands. A change in it is the only way to tell a fresh answer from the
 * cached bag being re-emitted after a failed request.
 *
 * `getFeatureFlagDetails()` is public on PostHogCore (posthog-core.d.ts:
 * `getFeatureFlagDetails(): PostHogFeatureFlagDetails | undefined`), which
 * stores `requestId` from every `/flags` response alongside the flags. On a
 * client without it this reads undefined forever, flags never count as fresh,
 * and the one thing gated on that (moving an early-updates member off their
 * track because the flag says off) never happens. That is the safe direction:
 * the row still hides, and nobody is moved on evidence that cannot be dated.
 */
export function readPosthogFeatureFlagsRequestId(): string | undefined {
  const posthog = getClient();
  if (!posthog) return undefined;
  const featureFlagClient = asFeatureFlagClient(posthog);
  if (typeof featureFlagClient.getFeatureFlagDetails !== 'function') return undefined;
  const requestId = featureFlagClient.getFeatureFlagDetails()?.requestId;
  return typeof requestId === 'string' && isPosthogFlagResponseCurrent(requestId) ? requestId : undefined;
}

export function subscribePosthogFeatureFlags(onChange: () => void): () => void {
  const unsubscribeAuthority = subscribePosthogFlagAuthority(onChange);
  const posthog = getClient();
  if (!posthog) {
    let unbind = () => {};
    const unsubscribeInitialized = subscribePosthogInitialized(() => {
      unbind();
      unbind = subscribePosthogFeatureFlags(onChange);
      onChange();
    });
    return () => {
      unsubscribeAuthority();
      unsubscribeInitialized();
      unbind();
    };
  }
  const featureFlagClient = asFeatureFlagClient(posthog);

  const reloadResult =
    typeof featureFlagClient.reloadFeatureFlags === 'function' ? featureFlagClient.reloadFeatureFlags() : undefined;
  if (isPromiseLike(reloadResult)) {
    void Promise.resolve(reloadResult)
      .then(onChange)
      .catch(() => {});
  }

  if (typeof featureFlagClient.onFeatureFlags !== 'function') {
    return unsubscribeAuthority;
  }

  const unsubscribe = featureFlagClient.onFeatureFlags(onChange);
  if (typeof unsubscribe === 'function') {
    return () => {
      unsubscribeAuthority();
      unsubscribe();
    };
  }
  return unsubscribeAuthority;
}

const analytics = createAnalytics(() => (isProductAnalyticsGranted() ? getClient() : null), {
  onDebug: __DEV__ ? (name, properties) => console.info('[analytics]', name, properties ?? {}) : undefined,
});

export const { track, identify, setPersonProperties } = analytics;

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
//
// `arm_connect_step` (#5654) is the connect-step test's arm. It is registered
// at exposure and on each launch for an enrolled account, and nothing else
// would put it back before the next account's enrolment is read, so the
// sign-out events of an enrolled climber would lose their arm.
export function reset(): boolean {
  const client = getClient();
  if (client) {
    client.reset([]);
    clearPosthogQueues(client);
  }
  const didReset = client !== null;
  void applyPosthogConsent().catch(() => {});
  // Clear the screen gate here rather than at each sign-out call site, so a new
  // "forget this person" path cannot forget it. analytics.reset() nulls the
  // SDK's persisted SessionId, which would re-arm the gate on the next
  // getSessionId() anyway — this just makes that explicit instead of a side
  // effect a reader has to know about.
  resetScreenSessionGate();
  if (client) {
    registerAppSuperProperties(client);
    registerConnectivitySuperProperty(client);
    reregisterOfflineEngineState(client);
    reregisterActiveGym(client);
    reregisterLowPowerMode(client);
    reregisterConnectStepArm(client);
  }
  return didReset;
}

// Manual screen view — the RN analogue of web's $pageview. PostHog's screen
// autocapture can't read Expo Router's navigation, so AnalyticsScreenTracker
// calls this from a route-change effect. `screen()` emits the native $screen
// event PostHog's mobile insights key off.
//
// Only the CAPTURE is gated to once per screen per session (see
// analytics-screen-session-gate.ts). `registerForSession` must run on EVERY
// navigation: the SDK's `screen()` calls it internally to keep `$screen_name`
// current, and that value is stamped onto every subsequent event — it is how
// `Tick Logged` knows it happened on /play. Gating the whole call would silently
// misattribute every other event to whatever screen last got past the gate, and
// the drift would worsen the longer a session ran. It is redundant on the
// emitting path and load-bearing on the suppressed one; keep it unconditional.
export function trackScreen(path: string): void {
  if (!isProductAnalyticsGranted()) return;
  if (__DEV__) console.info('[analytics] $screen', path);
  const client = getClient();
  if (!client) return;
  client.registerForSession({ $screen_name: path });
  if (!shouldEmitScreenForSession(path)) return;
  void client.screen(path);
}
