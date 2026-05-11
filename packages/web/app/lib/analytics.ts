import { track as vercelTrack } from '@vercel/analytics';
import { PostHog } from 'posthog-js-lite';
import { analyticsPathname, isAdminAnalyticsUrl } from './analytics-paths';

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
  if (posthogClient) return posthogClient;
  if (posthogInitAttempted) return null;
  posthogInitAttempted = true;

  // Hostname-gate to production, mirroring Sentry. Dev/preview deploys stay
  // out of the prod PostHog project.
  if (!window.location.hostname.includes('boardsesh.com')) return null;

  const apiKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!apiKey) return null;
  const host = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://us.i.posthog.com';

  posthogClient = new PostHog(apiKey, {
    host,
    autocapture: false,
    captureHistoryEvents: false,
    // PartyProfileProvider identifies the IndexedDB party-profile UUID after
    // hydration. Events captured before that resolve use PostHog's temporary
    // in-memory anonymous ID and are not guaranteed to merge later.
    persistence: 'memory',
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

  const posthog = getPosthog();
  if (!posthog) return false;
  posthog.capture(name, properties);
  return true;
}

export function identify(distinctId: string, properties?: PosthogProperties): boolean {
  if (isCurrentAdminAnalyticsPage()) return false;

  const posthog = getPosthog();
  if (!posthog) return false;
  posthog.identify(distinctId, properties);
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

export function pageview(url: string, prevPageviewProperties?: PosthogProperties): void {
  if (isAdminAnalyticsUrl(url)) return;

  const posthog = getPosthog();
  if (!posthog) return;
  posthog.capture('$pageview', {
    $current_url: analyticsPathname(url),
    ...prevPageviewProperties,
  });
}

export function pageleave(url: string, prevPageviewProperties?: PosthogProperties): void {
  if (isAdminAnalyticsUrl(url)) return;

  const posthog = getPosthog();
  if (!posthog) return;
  posthog.capture('$pageleave', {
    $current_url: analyticsPathname(url),
    ...prevPageviewProperties,
  });
}

export type { AllowedPropertyValues };
