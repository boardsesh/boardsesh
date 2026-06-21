import * as Sentry from '@sentry/nextjs';
import { track as vercelTrack } from '@vercel/analytics';
import { PostHog } from 'posthog-js-lite';
import { createAnalytics } from '@boardsesh/analytics';
import { analyticsPathname, isAdminAnalyticsUrl } from './analytics-paths';
import { getBackendHttpUrl } from './backend-url';

// Mirror @vercel/analytics' AllowedPropertyValues so existing call sites
// type-check unchanged when they swap to this wrapper.
type AllowedPropertyValues = string | number | boolean | null | undefined;
type EventProperties = Record<string, AllowedPropertyValues>;
type FlagsDataInput = Parameters<typeof vercelTrack>[2];

const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';
let posthogClient: PostHog | null = null;
let posthogInitAttempted = false;
const shouldDebugAnalytics = process.env.NEXT_PUBLIC_ANALYTICS_DEBUG === '1';

function getPosthog(): PostHog | null {
  if (typeof window === 'undefined') return null;
  if (posthogClient) return posthogClient;
  if (posthogInitAttempted) return null;
  posthogInitAttempted = true;

  // Hostname-gate to production, mirroring Sentry. Dev/preview deploys stay
  // out of the prod PostHog project.
  if (!window.location.hostname.includes('boardsesh.com')) return null;

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
type PosthogFeatureFlagClient = {
  getFeatureFlag?: (key: string) => unknown;
  isFeatureEnabled?: (key: string) => unknown;
  reloadFeatureFlags?: () => unknown;
  onFeatureFlags?: (callback: () => void) => unknown;
};

function isCurrentAdminAnalyticsPage(): boolean {
  return typeof window !== 'undefined' && isAdminAnalyticsUrl(window.location.pathname, window.location.origin);
}

// The SDK-agnostic capture/identity logic (sanitize, null-client guards, the
// boolean "did it send" contract) lives in @boardsesh/analytics and is shared
// with mobile. Web keeps the platform-specific bits in this file: the Vercel
// dual-write, the production hostname gate inside getPosthog(), the admin-page
// skip, and URL pageviews.
const core = createAnalytics(getPosthog, { shouldSkip: isCurrentAdminAnalyticsPage });

export function track(name: string, properties?: EventProperties, options?: { flags?: FlagsDataInput }): void {
  if (isCurrentAdminAnalyticsPage()) return;

  if (process.env.NODE_ENV !== 'production' && shouldDebugAnalytics) {
    console.info('[analytics] track', name, properties);
  }

  vercelTrack(name, properties, options);

  // Preserve the existing Vercel behavior in dev/preview; PostHog stays
  // hostname-gated inside getPosthog() so staging cannot write to prod.
  core.track(name, properties);
}

export function capturePosthog(name: string, properties?: PosthogProperties): boolean {
  return core.capture(name, properties);
}

export function identify(distinctId: string, properties?: PosthogProperties): boolean {
  return core.identify(distinctId, properties);
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

export function reset(): boolean {
  return core.reset();
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

export function readPosthogFeatureFlags(keys: readonly string[]): Record<string, boolean> {
  const posthog = getPosthog();
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
