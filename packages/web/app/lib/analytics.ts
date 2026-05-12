import { track as vercelTrack } from '@vercel/analytics';
import { PostHog } from 'posthog-js-lite';
import { analyticsPathname, isAdminAnalyticsUrl } from './analytics-paths';
import { getBackendHttpUrl } from './backend-url';
import { hasAnalyticsConsent } from './consent';

// Mirror @vercel/analytics' AllowedPropertyValues so existing call sites
// type-check unchanged when they swap to this wrapper.
type AllowedPropertyValues = string | number | boolean | null | undefined;
type EventProperties = Record<string, AllowedPropertyValues>;
type FlagsDataInput = Parameters<typeof vercelTrack>[2];

let posthogClient: PostHog | null = null;
let posthogInitAttempted = false;
const shouldDebugAnalytics = process.env.NEXT_PUBLIC_ANALYTICS_DEBUG === '1';

function getPosthog(): PostHog | null {
  if (typeof window === 'undefined') return null;
  // Consent gate: if analytics is denied or undecided, refuse to construct
  // the PostHog client AND refuse to return an existing one. The consent
  // check is evaluated BEFORE the `posthogInitAttempted` sticky check so
  // that flipping consent to granted later still allows lazy init.
  //
  // Caveat: when consent is revoked mid-session after a successful init,
  // `posthogClient` keeps its in-memory state and any keep-alive HTTP/2
  // connection until the page reloads. Future `track()` / `capture()`
  // calls short-circuit here so no new events are emitted, but the client
  // object itself is not torn down. Same caveat applies to Sentry (see
  // instrumentation-client.ts) — both honor a fresh page load to fully
  // detach. If we ever need synchronous teardown, switch to the full
  // posthog-js SDK which exposes `posthog.reset()` + `opt_out_capturing()`.
  if (!hasAnalyticsConsent()) return null;
  if (posthogClient) return posthogClient;
  if (posthogInitAttempted) return null;

  // Hostname-gate to production, mirroring Sentry. Dev/preview deploys stay
  // out of the prod PostHog project.
  if (!window.location.hostname.includes('boardsesh.com')) {
    // Mark as attempted so we don't re-check env vars on every event in
    // dev/preview. (Consent gate above already short-circuits when denied,
    // so flipping consent mid-session is unaffected.)
    posthogInitAttempted = true;
    return null;
  }

  const apiKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!apiKey) {
    posthogInitAttempted = true;
    return null;
  }
  // Default to the boardsesh backend's PostHog reverse proxy so events look
  // first-party to ad-blockers. NEXT_PUBLIC_POSTHOG_HOST overrides for incident
  // recovery (point straight at us.i.posthog.com if the proxy is down).
  const backendUrl = getBackendHttpUrl();
  const host = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? (backendUrl ? `${backendUrl}/api/posthog` : null);
  if (!host) {
    posthogInitAttempted = true;
    return null;
  }

  // Mark attempted only when we actually construct the client. This avoids
  // pinning the "no posthog" state when consent was denied earlier in the
  // session — once the user opts in, the next call to getPosthog() falls
  // through to construction.
  posthogInitAttempted = true;
  posthogClient = new PostHog(apiKey, {
    host,
    autocapture: false,
    captureHistoryEvents: false,
    // Persist distinct_id in localStorage so anonymous → authed merges and
    // cross-session retention cohorts work. The IndexedDB party-profile UUID
    // is still the canonical anon id; PartyProfileProvider calls identify()
    // on hydration to reconcile if storage was cleared.
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

  return posthogClient;
}

type PosthogProperties = Record<string, string | number | boolean | null>;

function sanitizeForPosthog(properties?: EventProperties): PosthogProperties | undefined {
  if (!properties) return undefined;
  const out: PosthogProperties = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function isCurrentAdminAnalyticsPage(): boolean {
  return typeof window !== 'undefined' && isAdminAnalyticsUrl(window.location.pathname, window.location.origin);
}

export function track(name: string, properties?: EventProperties, options?: { flags?: FlagsDataInput }): void {
  if (isCurrentAdminAnalyticsPage()) return;
  // Consent gate: skip BOTH Vercel and PostHog when analytics is denied or
  // undecided. The banner sits above content until the user picks one.
  if (!hasAnalyticsConsent()) return;

  if (process.env.NODE_ENV !== 'production' && shouldDebugAnalytics) {
    console.info('[analytics] track', name, properties);
  }

  vercelTrack(name, properties, options);

  // Preserve the existing Vercel behavior in dev/preview; PostHog stays
  // hostname-gated inside getPosthog() so staging cannot write to prod.
  const posthog = getPosthog();
  if (posthog) posthog.capture(name, sanitizeForPosthog(properties));
}

export function capturePosthog(name: string, properties?: PosthogProperties): boolean {
  if (isCurrentAdminAnalyticsPage()) return false;
  if (!hasAnalyticsConsent()) return false;

  const posthog = getPosthog();
  if (!posthog) return false;
  posthog.capture(name, properties);
  return true;
}

export function identify(distinctId: string, properties?: PosthogProperties): boolean {
  if (isCurrentAdminAnalyticsPage()) return false;
  if (!hasAnalyticsConsent()) return false;

  const posthog = getPosthog();
  if (!posthog) return false;
  posthog.identify(distinctId, properties);
  return true;
}

/**
 * Eagerly construct the PostHog client. Callers (e.g. the consent context
 * when the user flips analytics to granted mid-session) can invoke this to
 * warm up the client so the next `track()` doesn't pay init cost. No-ops
 * when consent is denied or undecided.
 */
export function initAnalytics(): void {
  getPosthog();
}

// Sets person properties on the current distinct_id. `setOnce` properties are
// only written if they don't already exist on the user (use for first-touch
// attributes like signup_at, auth_method). `set` overwrites every call.
export function setPersonProperties(set?: PosthogProperties, setOnce?: PosthogProperties): boolean {
  if (isCurrentAdminAnalyticsPage()) return false;

  const posthog = getPosthog();
  if (!posthog) return false;
  posthog.setPersonProperties(set, setOnce);
  return true;
}

// Sends a $create_alias event linking the current distinct_id to `newId`.
// Use this on signup/login to merge the anonymous IndexedDB UUID into the
// authenticated user UUID, then call identify(newId) to switch.
export function alias(newId: string): boolean {
  if (isCurrentAdminAnalyticsPage()) return false;

  const posthog = getPosthog();
  if (!posthog) return false;
  posthog.alias(newId);
  return true;
}

export function reset(): boolean {
  if (isCurrentAdminAnalyticsPage()) return false;

  const posthog = getPosthog();
  if (!posthog) return false;
  posthog.reset();
  return true;
}

export function pageview(url: string): void {
  if (isAdminAnalyticsUrl(url)) return;

  const posthog = getPosthog();
  if (!posthog) return;
  posthog.capture('$pageview', { $current_url: analyticsPathname(url) });
}

export type { AllowedPropertyValues };
