import { track as vercelTrack } from '@vercel/analytics';
import { PostHog } from 'posthog-js-lite';

// Mirror @vercel/analytics' AllowedPropertyValues so existing call sites
// type-check unchanged when they swap to this wrapper.
type AllowedPropertyValues = string | number | boolean | null | undefined;
type EventProperties = Record<string, AllowedPropertyValues>;
type FlagsDataInput = Parameters<typeof vercelTrack>[2];

let posthogClient: PostHog | null = null;
let posthogInitAttempted = false;

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

export function track(name: string, properties?: EventProperties, options?: { flags?: FlagsDataInput }): void {
  if (process.env.NODE_ENV !== 'production') {
    console.info('[analytics] track', name, properties);
  }

  vercelTrack(name, properties, options);

  const posthog = getPosthog();
  if (posthog) posthog.capture(name, sanitizeForPosthog(properties));
}

export function identify(distinctId: string, properties?: PosthogProperties): void {
  const posthog = getPosthog();
  if (!posthog) return;
  posthog.identify(distinctId, properties);
}

// Sends a $create_alias event linking the current distinct_id to `newId`.
// Use this on signup/login to merge the anonymous IndexedDB UUID into the
// authenticated user UUID, then call identify(newId) to switch.
export function alias(newId: string): void {
  const posthog = getPosthog();
  if (!posthog) return;
  posthog.alias(newId);
}

export function reset(): void {
  const posthog = getPosthog();
  if (!posthog) return;
  posthog.reset();
}

export function pageview(url: string): void {
  const posthog = getPosthog();
  if (!posthog) return;
  posthog.capture('$pageview', { $current_url: url });
}

export type { AllowedPropertyValues };
