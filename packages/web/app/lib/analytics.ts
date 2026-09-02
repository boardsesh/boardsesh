import * as Sentry from '@sentry/nextjs';
import { PostHog } from 'posthog-js-lite';
import { createAnalytics } from '@boardsesh/analytics';
import { analyticsPathname, isAdminAnalyticsUrl } from './analytics-paths';
import { getBackendHttpUrl } from './backend-url';
import { isProductionHost } from './production-hosts';

// The property values a tracked event may carry. `undefined` is accepted at the
// call site and dropped before capture (sanitizeForPosthog in
// @boardsesh/analytics), so an optional field can be spread in without a
// conditional; `null` is a real value and reaches PostHog as one.
type AllowedPropertyValues = string | number | boolean | null | undefined;
type EventProperties = Record<string, AllowedPropertyValues>;

const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';
let posthogClient: PostHog | null = null;
let posthogInitAttempted = false;
const shouldDebugAnalytics = process.env.NEXT_PUBLIC_ANALYTICS_DEBUG === '1';

function getPosthog(): PostHog | null {
  if (typeof window === 'undefined') return null;
  if (posthogClient) return posthogClient;
  if (posthogInitAttempted) return null;
  posthogInitAttempted = true;

  // Hostname-gate to production, mirroring Sentry (instrumentation-client.ts).
  // Exact-host match via production-hosts.ts, NOT a substring: preview deploys
  // run at `<pr>.preview.boardsesh.com`, which contains "boardsesh.com" and
  // would pass a naive `.includes()` check, leaking preview sessions into the
  // prod PostHog project (#3814).
  if (!isProductionHost(window.location.hostname)) return null;

  const apiKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!apiKey) {
    // We're on a production boardsesh.com host but NEXT_PUBLIC_POSTHOG_KEY was
    // not inlined into the client bundle at build time, so the SDK can't start
    // and every client-side event silently goes dark. This exact gap blacked
    // out product analytics for days after the May 2026 deploy-pipeline move to
    // CI `vercel build` (the key stopped reaching the build). Fail loud so a
    // missing key surfaces in minutes, not days. Fires once per page load —
    // posthogInitAttempted (set above) gates re-entry.
    const message =
      'PostHog client key (NEXT_PUBLIC_POSTHOG_KEY) is missing on a production host — client analytics is disabled. Check the web build env.';
    console.error(`[analytics] ${message}`);
    Sentry.captureMessage(message, 'error');
    return null;
  }
  // Default to the boardsesh backend's PostHog reverse proxy so events look
  // first-party to ad-blockers. NEXT_PUBLIC_POSTHOG_HOST overrides for incident
  // recovery (point straight at us.i.posthog.com if the proxy is down).
  const backendUrl = getBackendHttpUrl();
  const configuredHost = process.env.NEXT_PUBLIC_POSTHOG_HOST?.trim() || null;
  const host = configuredHost ?? (backendUrl ? `${backendUrl}/api/posthog` : DEFAULT_POSTHOG_HOST);
  if (!configuredHost && !backendUrl) {
    const message =
      'PostHog proxy URL could not be derived on a production host; using direct PostHog ingestion. Check NEXT_PUBLIC_WS_URL or NEXT_PUBLIC_POSTHOG_HOST in the web build env.';
    console.warn(`[analytics] ${message}`);
    Sentry.captureMessage(message, 'warning');
  }

  posthogClient = new PostHog(apiKey, {
    host,
    autocapture: false,
    captureHistoryEvents: false,
    // Persist distinct_id in localStorage so anonymous → authed merges and
    // cross-session retention cohorts work. This blob holds BOTH the distinct id
    // and the anonymous id, and `AnalyticsIdentity`
    // (components/providers/analytics-identity.tsx) reads the pair back to
    // decide whether this browser is anonymous or already pinned to a person.
    // Keeping that decision inside the SDK's own storage is deliberate: a
    // second store of ours would start empty on every existing browser and
    // disagree with this one.
    //
    // CLAUDE.md mandates IndexedDB for client persistence (the no-restricted-globals
    // lint rule enforces it on bare globals, which is why this config string
    // doesn't trigger it). posthog-js-lite only exposes
    // 'localStorage' | 'sessionStorage' | 'cookie' | 'memory' — there is no
    // IDB option in the lite SDK. 'memory' (the prior setting) regenerated a
    // fresh anon id on every reload, which broke retention math. Until/unless
    // we migrate to the full posthog-js SDK or self-host IDB-backed persistence,
    // this is the documented exception. Do not copy this pattern for other
    // persistence needs — use idb-helper.ts as usual.
    persistence: 'localStorage',
  });

  registerWebEnvironment(posthogClient);

  return posthogClient;
}

// Registers `environment: 'production'` as a persistent super property on every
// event, mirroring mobile's registerAppEnvironment() in
// packages/mobile/src/lib/posthog-client.ts. Without this, web PostHog events
// carried no `environment` tag at all, so a dashboard filter of
// `environment = 'production'` silently dropped 100% of web volume while still
// counting mobile and backend correctly (#3945).
//
// Hardcoded to 'production' rather than resolved dynamically: getPosthog() is
// gated by isProductionHost() a few lines above, and posthogClient is only ever
// constructed when that gate passes, so 'production' is correct by
// construction. If that gate is ever relaxed (e.g. preview deploys get their
// own PostHog key), this must become dynamic like mobile's
// resolveAppEnvironment().
//
// register() IS in posthog-js-lite's public typings (inherited from
// @posthog/core's PostHogCoreStateless) — no structural cast needed here,
// unlike registerSessionSuperProperties() below.
//
// Best-effort, exactly like mobile's registerAppEnvironment: a failure here
// must never block analytics init, so a rejection AND a synchronous throw are
// both swallowed. register() is declared `async` in @posthog/core 1.46.1, so
// today it can only reject — the Promise.resolve() + try/catch keeps that from
// being a silent version coupling if a future SDK makes it sync.
function registerWebEnvironment(client: PostHog): void {
  try {
    void Promise.resolve(client.register({ environment: 'production' })).catch((error: unknown) => {
      warnEnvironmentRegistrationFailed(error);
    });
  } catch (error) {
    warnEnvironmentRegistrationFailed(error);
  }
}

function warnEnvironmentRegistrationFailed(error: unknown): void {
  if (shouldDebugAnalytics) console.warn('[analytics] failed to register environment super property', error);
}

type PosthogProperties = Record<string, string | number | boolean | null>;
// `sendEvent: false` suppresses the SDK's `$feature_flag_called` capture. Verified
// in @posthog/core 1.46.1 (shared by posthog-js-lite and posthog-react-native):
// `_getFeatureFlagResult` gates the capture on it, and both `getFeatureFlag` and
// `isFeatureEnabled` forward it. Flag VALUES are unaffected.
type FeatureFlagReadOptions = { sendEvent?: boolean };
type PosthogFeatureFlagClient = {
  getFeatureFlag?: (key: string, options?: FeatureFlagReadOptions) => unknown;
  isFeatureEnabled?: (key: string, options?: FeatureFlagReadOptions) => unknown;
  reloadFeatureFlags?: () => unknown;
  onFeatureFlags?: (callback: () => void) => unknown;
};

function isCurrentAdminAnalyticsPage(): boolean {
  return typeof window !== 'undefined' && isAdminAnalyticsUrl(window.location.pathname, window.location.origin);
}

// The SDK-agnostic capture/identity logic (sanitize, null-client guards, the
// boolean "did it send" contract) lives in @boardsesh/analytics and is shared
// with mobile. Web keeps the platform-specific bits in this file: the production
// hostname gate inside getPosthog(), the admin-page skip, and URL pageviews.
const core = createAnalytics(getPosthog, { shouldSkip: isCurrentAdminAnalyticsPage });

export function track(name: string, properties?: EventProperties): void {
  if (isCurrentAdminAnalyticsPage()) return;

  if (process.env.NODE_ENV !== 'production' && shouldDebugAnalytics) {
    console.info('[analytics] track', name, properties);
  }

  // PostHog is the only sink. It stays hostname-gated inside getPosthog(), so a
  // dev or preview build sends nothing at all — set NEXT_PUBLIC_ANALYTICS_DEBUG=1
  // to see what a call would have carried.
  core.track(name, properties);
}

/**
 * How long a click may hold the browser before we give up and navigate anyway.
 * A quarter of a second is under the ~300ms a cross-origin document swap costs
 * on its own, and the flush is a single small POST that normally lands well
 * inside it.
 */
const NAVIGATION_FLUSH_BUDGET_MS = 250;

/**
 * Track an event whose page is about to be replaced — a link to another origin,
 * a full page reload — and resolve once the event is on the wire (or the budget
 * runs out). Callers navigate in `.finally()`.
 *
 * Plain `track()` does not survive that: `posthog-js-lite` batches through
 * `@posthog/core`, which flushes at 20 queued events or every 10s, and neither
 * bundle registers a `pagehide`/`beforeunload` handler or uses `sendBeacon`, so
 * a capture in the click handler of a cross-origin `<a>` is discarded with the
 * document about a millisecond later.
 *
 * The full `posthog-js` SDK solves this at the capture site with
 * `{ transport: 'sendBeacon' }` / `send_instantly`. posthog-js-lite@4.10.1 has
 * neither — its `PostHogCaptureOptions` is `{ uuid, timestamp, disableGeoip }`
 * — so `flush()` is the only delivery lever it exposes, and holding the
 * navigation for it is the only way to guarantee the event leaves. Keep the
 * caller's real `href` on the anchor so crawlers and JS-off readers are
 * unaffected.
 */
export async function trackBeforeNavigation(name: string, properties?: EventProperties): Promise<void> {
  track(name, properties);

  const posthog = getPosthog();
  if (!posthog) return;

  const budget = new Promise<void>((resolve) => {
    window.setTimeout(resolve, NAVIGATION_FLUSH_BUDGET_MS);
  });
  // A flush rejection (ad-blocker, proxy down) must never strand the reader on
  // the page they clicked away from.
  await Promise.race([posthog.flush().catch(() => {}), budget]);
}

export function capturePosthog(name: string, properties?: PosthogProperties): boolean {
  return core.capture(name, properties);
}

export function identify(distinctId: string, properties?: PosthogProperties): boolean {
  return core.identify(distinctId, properties);
}

/**
 * The distinct id the PostHog client currently believes it is, or `null` when
 * there is no client at all (server render, dev, preview deploys, a production
 * host whose build lost NEXT_PUBLIC_POSTHOG_KEY) or the SDK has not finished
 * initialising — @posthog/core returns `''` in that window. Callers use the
 * `null` to skip identity work entirely rather than acting on a half-known id.
 *
 * Every event this browser sends carries this id. After identify() it is the
 * authenticated user id; before it, the anonymous one.
 */
export function getAnalyticsDistinctId(): string | null {
  const posthog = getPosthog();
  if (!posthog) return null;
  return posthog.getDistinctId() || null;
}

/**
 * The anonymous id the PostHog client keeps alongside the distinct id, or
 * `null` under the same conditions as getAnalyticsDistinctId().
 *
 * Both live in the SAME localStorage blob (`persistence: 'localStorage'`
 * above), which is what makes the pair trustworthy: they cannot drift apart the
 * way a second store of our own would. `distinctId !== anonymousId` is
 * therefore the exact test for "this browser is already pinned to an identified
 * person" — @posthog/core's own `_isIdentified()` falls back to that same
 * comparison for clients identified before it started writing `PersonMode`,
 * which is most of the existing fleet.
 *
 * Do not read this to decide what to merge FROM: `identify()` overwrites the
 * stored anonymous id with the previous distinct id, so after a second
 * identify() without an intervening reset() it would hold a user id.
 * `AnalyticsIdentity` resets before identifying a different person precisely so
 * that never happens.
 */
export function getAnalyticsAnonymousId(): string | null {
  const posthog = getPosthog();
  if (!posthog) return null;
  return posthog.getAnonymousId() || null;
}

// Sets person properties on the current distinct_id. `setOnce` properties are
// only written if they don't already exist on the user (use for first-touch
// attributes like signup_at, auth_method). `set` overwrites every call.
export function setPersonProperties(set?: PosthogProperties, setOnce?: PosthogProperties): boolean {
  return core.setPersonProperties(set, setOnce);
}

// Sends a $create_alias event linking the current distinct_id to `newId`.
// Use this on signup/login to merge the anonymous IndexedDB UUID into the
// authenticated user UUID, then call identify(newId) to switch.
export function alias(newId: string): boolean {
  return core.alias(newId);
}

// PostHog's reset() clears the distinct id AND every registered super
// property, but getPosthog() caches the singleton, so the registration done at
// construction never runs again. Re-register `environment` straight after so a
// party-profile reset (party-profile-context.tsx) doesn't silently drop the tag
// for the rest of the page session — mirrors mobile's reset() in
// packages/mobile/src/lib/analytics.ts.
//
// Only re-registers when core.reset() actually forwarded to a real client
// (didReset === true): calling getPosthog() unconditionally would construct a
// client on the admin-page skip path, where core.reset() short-circuits before
// ever calling getPosthog() itself.
export function reset(): boolean {
  const didReset = core.reset();
  if (didReset) {
    const posthog = getPosthog();
    if (posthog) registerWebEnvironment(posthog);
  }
  return didReset;
}

type PosthogSuperPropertyClient = {
  registerForSession?: (properties: PosthogProperties) => unknown;
};

/**
 * Register SESSION-scoped PostHog super properties — attached to every event
 * for the current PostHog session only, never persisted to storage. Used by
 * the kiosk routes to stamp `kiosk: true` so 24/7 TV traffic is
 * distinguishable from real climbers in product analytics.
 *
 * Deliberately session-scoped (`registerForSession`, memory-backed in
 * @posthog/core) rather than the persistent `register`: the persistent
 * variant writes to localStorage, so a gym owner who previews their kiosk in
 * a normal browser would be stamped `kiosk: true` on every future event. The
 * TV re-registers on every page load anyway (and kiosks reload daily), so
 * persistence buys nothing. posthog-js-lite exposes `registerForSession` at
 * runtime but not in its public typings, hence the narrow structural cast
 * (same pattern as the feature-flag client above). Returns whether the
 * property was registered.
 */
export function registerSessionSuperProperties(properties: PosthogProperties): boolean {
  const posthog = getPosthog();
  if (!posthog) return false;
  const superPropertyClient = posthog as unknown as PosthogSuperPropertyClient;
  if (typeof superPropertyClient.registerForSession !== 'function') return false;
  void superPropertyClient.registerForSession(properties);
  return true;
}

export function pageview(url: string): void {
  if (isAdminAnalyticsUrl(url)) return;

  const posthog = getPosthog();
  if (!posthog) return;
  posthog.capture('$pageview', { $current_url: analyticsPathname(url) });
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

// This provider re-reads the WHOLE flag catalog on every flags-changed tick, so
// leaving exposure events on cost ~173k events / 30 days across web + mobile —
// 13% of the project's entire volume — for a signal nothing consumed: the project
// runs no experiments, and the only insights referencing `$feature_flag_called`
// are PostHog's auto-generated "<flag> Usage" boilerplate. Drop the option at a
// specific call site if that flag ever needs real exposure analysis.
const READ_WITHOUT_EXPOSURE_EVENT: FeatureFlagReadOptions = { sendEvent: false };

export function readPosthogFeatureFlags(keys: readonly string[]): Record<string, boolean> {
  const posthog = getPosthog();
  if (!posthog) return {};
  const featureFlagClient = asFeatureFlagClient(posthog);
  const flags: Record<string, boolean> = {};

  for (const key of keys) {
    let rawFlagValue: unknown;
    if (typeof featureFlagClient.getFeatureFlag === 'function') {
      rawFlagValue = featureFlagClient.getFeatureFlag(key, READ_WITHOUT_EXPOSURE_EVENT);
    } else if (typeof featureFlagClient.isFeatureEnabled === 'function') {
      rawFlagValue = featureFlagClient.isFeatureEnabled(key, READ_WITHOUT_EXPOSURE_EVENT);
    }
    const flagValue = coerceFeatureFlagBoolean(rawFlagValue);
    if (flagValue !== undefined) {
      flags[key] = flagValue;
    }
  }

  return flags;
}

export function subscribePosthogFeatureFlags(onChange: () => void): () => void {
  const posthog = getPosthog();
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

export type { AllowedPropertyValues };
