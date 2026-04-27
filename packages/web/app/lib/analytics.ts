import { PostHog } from 'posthog-js-lite';

let client: PostHog | null = null;
let initAttempted = false;

function getClient(): PostHog | null {
  if (typeof window === 'undefined') return null;
  if (client) return client;
  if (initAttempted) return null;
  initAttempted = true;

  // Match Sentry gating: only enable on production domain so dev and preview
  // deploys don't pollute the production project. See instrumentation-client.ts.
  if (!window.location.hostname.includes('boardsesh.com')) {
    return null;
  }

  const apiKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  const host = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://us.i.posthog.com';
  if (!apiKey) return null;

  client = new PostHog(apiKey, {
    host,
    // We do all event capture manually via track() — no autocapture or history
    // events, keeps the lite SDK as small as possible.
    autocapture: false,
    captureHistoryEvents: false,
    persistence: 'localStorage',
  });

  return client;
}

// Mirrors @vercel/analytics' AllowedPropertyValues so existing call sites
// type-check unchanged against the new wrapper.
type AllowedPropertyValues = string | number | boolean | null;
type EventProperties = Record<string, AllowedPropertyValues>;

export function track(event: string, properties?: EventProperties): void {
  if (process.env.NODE_ENV !== 'production') {
    console.debug('[analytics] track', event, properties);
  }

  const ph = getClient();
  if (!ph) return;

  ph.capture(event, properties);
}
