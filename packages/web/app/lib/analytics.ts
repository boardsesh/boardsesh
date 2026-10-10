import * as Sentry from '@sentry/nextjs';
import { PostHog } from 'posthog-js-lite';
import { createAnalytics } from '@boardsesh/analytics';
import { isAdminAnalyticsUrl, isEmbedAnalyticsUrl, isKioskAnalyticsUrl } from './analytics-paths';
import { getWebConsentRecord, hasAnalyticsConsent, subscribeWebConsent } from './consent';
import { isAnalyticsGranted } from '@boardsesh/consent';

import { getBackendHttpUrl } from './backend-url';
import { getSessionInboundCampaign, type InboundCampaign } from './inbound-campaign';
import { isAutomatedCrawlerUserAgent } from './is-crawler';
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
let posthogPersisted = false;
let suspendedPosthogClient: PostHog | null = null;
const suspendedClients = new WeakSet<PostHog>();
let flagAccountId: string | null = null;
const featureFlagListeners = new Set<() => void>();
let unsubscribeSdkFlags: (() => void) | null = null;
const retiredClients = new WeakSet<PostHog>();
const activeRequests = new WeakMap<PostHog, Set<AbortController>>();
type PersistedKey = Parameters<PostHog['setPersistedProperty']>[0];
const QUEUE_KEYS = ['queue', 'ai_queue', 'ai_capture_queue', 'logs_queue'] as const;

function clearPosthogStorage(): void {
  if (typeof window === 'undefined') return;
  try {
    // oxlint-disable-next-line no-restricted-globals -- remove legacy third-party analytics identifiers on withdrawal
    const storage = localStorage;
    for (const key of Object.keys(storage)) if (key.startsWith('ph_')) storage.removeItem(key);
  } catch {
    /* Storage can be unavailable; the SDK still switches to memory. */
  }
}
function retirePosthog(client: PostHog): void {
  retiredClients.add(client);
  activeRequests.get(client)?.forEach((controller) => controller.abort());
  void client.optOut().catch(() => {});
  // reset([]) preserves all four SDK queues, and shutdown flushes even after optOut.
  for (const key of QUEUE_KEYS) client.setPersistedProperty(key as PersistedKey, null);
  client.reset([]);
  void client.optOut().catch(() => {});
  for (const key of QUEUE_KEYS) client.setPersistedProperty(key as PersistedKey, null);
  // An old in-flight flush can otherwise recreate its localStorage blob after cleanup.
  client.setPersistedProperty = () => {};
  void client.shutdown(100).catch(() => {});
}
function installConsentTransport(client: PostHog): void {
  const sdkFetch = client.fetch.bind(client);
  const requests = new Set<AbortController>();
  activeRequests.set(client, requests);
  client.fetch = async (url, options) => {
    const flagsRequest = /\/(flags|decide)\/?(?:\?|$)/.test(url);
    if (retiredClients.has(client) || suspendedClients.has(client) || (!flagsRequest && !hasAnalyticsConsent())) {
      throw new Error('Analytics consent does not permit this request');
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) controller.abort();
    requests.add(controller);
    try {
      return await sdkFetch(url, { ...options, signal: controller.signal });
    } finally {
      requests.delete(controller);
      options.signal?.removeEventListener('abort', abort);
    }
  };
}
function bindFeatureFlags(client: PostHog): void {
  unsubscribeSdkFlags?.();
  unsubscribeSdkFlags = client.onFeatureFlags(() => featureFlagListeners.forEach((listener) => listener()));
  featureFlagListeners.forEach((listener) => listener());
}
function refreshAnalyticsConsent(): void {
  const deviceGranted = isAnalyticsGranted(getWebConsentRecord());
  if (!deviceGranted) {
    if (suspendedPosthogClient) {
      retirePosthog(suspendedPosthogClient);
      suspendedPosthogClient = null;
    }
    clearPosthogStorage();
  }
  if (!posthogClient) return;
  if (posthogPersisted !== hasAnalyticsConsent()) {
    const oldClient = posthogClient;
    posthogClient = null;
    if (posthogPersisted && deviceGranted) {
      // Account authority is temporarily unresolved. Keep events captured with
      // consent and their anonymous acquisition identity, but stop transport.
      suspendedPosthogClient = oldClient;
      suspendedClients.add(oldClient);
      activeRequests.get(oldClient)?.forEach((controller) => controller.abort());
      void oldClient.optOut().catch(() => {});
    } else {
      retirePosthog(oldClient);
    }
    if (!isAnalyticsGranted(getWebConsentRecord())) clearPosthogStorage();
    posthogInitAttempted = false;
    if (hasAnalyticsConsent() && suspendedPosthogClient) {
      posthogClient = suspendedPosthogClient;
      suspendedPosthogClient = null;
      suspendedClients.delete(posthogClient);
      posthogPersisted = true;
      void posthogClient.optIn().catch(() => {});
      bindFeatureFlags(posthogClient);
      posthogClient.reloadFeatureFlags();
      return;
    }
    getPosthog();
  }
}
subscribeWebConsent(refreshAnalyticsConsent);
export function setAnalyticsFlagAccountId(accountId: string | null): void {
  if (flagAccountId === accountId) return;
  // Only anonymous → signed-in may retain acquisition history. A sign-out or
  // account switch must never resume the previous account's queued events.
  if (flagAccountId !== null && suspendedPosthogClient) {
    retirePosthog(suspendedPosthogClient);
    suspendedPosthogClient = null;
  }
  flagAccountId = accountId;
  if (!posthogClient || posthogPersisted) return;
  const oldClient = posthogClient;
  posthogClient = null;
  retirePosthog(oldClient);
  posthogInitAttempted = false;
  getPosthog();
}
const shouldDebugAnalytics = process.env.NEXT_PUBLIC_ANALYTICS_DEBUG === '1';

function getPosthog(): PostHog | null {
  if (typeof window === 'undefined') return null;
  if (isEmbedAnalyticsUrl(window.location.pathname) || isKioskAnalyticsUrl(window.location.pathname)) return null;
  if (posthogClient) return posthogClient;
  if (posthogInitAttempted) return null;
  posthogInitAttempted = true;

  // Hostname-gate to production, mirroring Sentry (instrumentation-client.ts).
  // Exact-host match via production-hosts.ts, NOT a substring: preview deploys
  // run at `<pr>.preview.boardsesh.com`, which contains "boardsesh.com" and
  // would pass a naive `.includes()` check, leaking preview sessions into the
  // prod PostHog project (#3814).
  if (!isProductionHost(window.location.hostname)) return null;

  // Crawlers that execute our JS boot this SDK and, holding no cookies, mint a
  // fresh person per page load: Applebot was 917 of the 946 web "users" on 2026-09-10.
  // Not isCrawlerUserAgent — that one counts real YandexSearch users as bots. docs/feature-flags.md.
  if (isAutomatedCrawlerUserAgent(navigator.userAgent)) return null;

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

  if (!isAnalyticsGranted(getWebConsentRecord())) clearPosthogStorage();
  posthogClient = new PostHog(apiKey, {
    host,
    autocapture: false,
    captureHistoryEvents: false,
    // Persistence is constructor-fixed in lite. Consent transitions replace the instance.
    persistence: hasAnalyticsConsent() ? 'localStorage' : 'memory',
    defaultOptIn: false,
    sendFeatureFlagEvent: false,
    preloadFeatureFlags: false,
    bootstrap:
      !hasAnalyticsConsent() && flagAccountId ? { distinctId: flagAccountId, isIdentifiedId: true } : undefined,
  });

  posthogPersisted = hasAnalyticsConsent();
  installConsentTransport(posthogClient);
  if (posthogPersisted) void posthogClient.optIn().catch(() => {});
  else void posthogClient.optOut().catch(() => {});
  registerWebSuperProperties(posthogClient);
  bindFeatureFlags(posthogClient);
  posthogClient.reloadFeatureFlags();

  return posthogClient;
}

// posthog-js caps the UA it sends at 1000 characters too (997 plus "...").
const MAX_RAW_USER_AGENT_LENGTH = 1000;

// An empty UA leaves `$raw_user_agent` unset, so PostHog flags the event: a real
// browser always has one.
function webSuperProperties(userAgent: string): Record<string, string> {
  const properties: Record<string, string> = { environment: 'production' };
  if (userAgent) properties.$raw_user_agent = userAgent.slice(0, MAX_RAW_USER_AGENT_LENGTH);
  return properties;
}

// Registers the super properties every web event carries: `environment` and
// `$raw_user_agent`.
//
// `$raw_user_agent`: posthog-js-lite (unlike the full posthog-js) never puts
// the browser UA on an event — its getContext() sends $browser/$os/$device
// only. PostHog's `$virt_is_bot` reads the event property, not the request
// header the backend proxy forwards (#3139), so every web event landed with no
// UA and was classed as a bot: 0 of ~660k `$lib = js` events carried one over
// the 120 days to 2026-09-25, and all of them were `$virt_is_bot = true`
// (#5653). Mobile registers its own
// constant for the same reason (registerMobileUserAgent in posthog-client.ts).
//
// `environment: 'production'` mirrors mobile's registerAppEnvironment() in
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
// @posthog/core's PostHogCoreStateless) — no structural cast needed here.
//
// Best-effort, exactly like mobile's registerAppEnvironment: a failure here
// must never block analytics init, so a rejection AND a synchronous throw are
// both swallowed. register() is declared `async` in @posthog/core 1.46.1, so
// today it can only reject — the Promise.resolve() + try/catch keeps that from
// being a silent version coupling if a future SDK makes it sync.
function registerWebSuperProperties(client: PostHog): void {
  try {
    void Promise.resolve(client.register(webSuperProperties(navigator.userAgent))).catch((error: unknown) => {
      warnSuperPropertyRegistrationFailed(error);
    });
  } catch (error) {
    warnSuperPropertyRegistrationFailed(error);
  }
}

function warnSuperPropertyRegistrationFailed(error: unknown): void {
  if (shouldDebugAnalytics) console.warn('[analytics] failed to register web super properties', error);
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
};

function isCurrentAdminAnalyticsPage(): boolean {
  return typeof window !== 'undefined' && isAdminAnalyticsUrl(window.location.pathname, window.location.origin);
}

// The SDK-agnostic capture/identity logic (sanitize, null-client guards, the
// boolean "did it send" contract) lives in @boardsesh/analytics and is shared
// with mobile. Web keeps the platform-specific bits in this file: the production
// hostname gate inside getPosthog(), the admin-page skip, and URL pageviews.
function shouldSkipProductAnalytics(): boolean {
  return (
    !hasAnalyticsConsent() ||
    isCurrentAdminAnalyticsPage() ||
    (typeof window !== 'undefined' &&
      (isEmbedAnalyticsUrl(window.location.pathname) || isKioskAnalyticsUrl(window.location.pathname)))
  );
}
const core = createAnalytics(getPosthog, { shouldSkip: shouldSkipProductAnalytics });

export function track(name: string, properties?: EventProperties): void {
  if (shouldSkipProductAnalytics()) return;

  if (process.env.NODE_ENV !== 'production' && shouldDebugAnalytics) {
    console.info('[analytics] track', name, properties);
  }

  // PostHog is the only sink. It stays hostname-gated inside getPosthog(), so a
  // dev or preview build sends nothing at all — set NEXT_PUBLIC_ANALYTICS_DEBUG=1
  // to see what a call would have carried.
  core.track(name, withInboundCampaign(properties));
}

/**
 * Add the campaign this visit landed with (`utm_*`, `gclid`) to an event's
 * properties (#6027).
 *
 * posthog-js-lite never parses campaign params, so nothing on www said where a
 * visit came from. Sending them as plain event properties is enough for the
 * session: PostHog derives `$entry_utm_source` from the first event that
 * carries them.
 *
 * It does NOT give a signed-out visitor a person property. This client sets no
 * `personProfiles`, so it runs on the SDK default `identified_only` and every
 * anonymous event goes out with `$process_person_profile: false`. The person's
 * `$initial_utm_source` exists only for someone identified on www. Break www
 * traffic down by the session property or by the event's own `utm_source`.
 *
 * They go on `$pageview` and on every `track()` event, `App Install Click`
 * included, so a store click can be broken down by the source that brought the
 * visitor. The caller's own properties win a key collision. An untagged visit
 * gets its properties back untouched — `undefined` stays `undefined` — so no
 * existing payload changes.
 */
function withInboundCampaign(): InboundCampaign | undefined;
function withInboundCampaign(properties: EventProperties | undefined): EventProperties | undefined;
function withInboundCampaign(properties?: EventProperties): EventProperties | undefined {
  const inboundCampaign = getSessionInboundCampaign();
  if (!inboundCampaign) return properties;
  return { ...inboundCampaign, ...properties };
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
  if (shouldSkipProductAnalytics()) return;
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

// PostHog's reset() clears the distinct id AND every registered super
// property, but getPosthog() caches the singleton, so the registration done at
// construction never runs again. Re-register `environment` and `$raw_user_agent`
// straight after so a party-profile reset (party-profile-context.tsx) doesn't silently drop them
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
    if (posthog) {
      if (hasAnalyticsConsent()) void posthog.optIn().catch(() => {});
      else void posthog.optOut().catch(() => {});
      registerWebSuperProperties(posthog);
    }
  }
  return didReset;
}

export function pageview(url: string): void {
  if (shouldSkipProductAnalytics() || isAdminAnalyticsUrl(url)) return;

  const posthog = getPosthog();
  if (!posthog) return;
  // No `$current_url` here. The SDK stamps the full `location.href` on every
  // event and spreads its own properties AFTER the caller's (@posthog/core
  // `enrichProperties`), so a pathname passed in was always overwritten.
  posthog.capture('$pageview', withInboundCampaign());
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
  featureFlagListeners.add(onChange);
  const client = getPosthog();
  client?.reloadFeatureFlags();
  return () => {
    featureFlagListeners.delete(onChange);
  };
}

export type { AllowedPropertyValues };
