import 'server-only';
import { PostHog } from 'posthog-node';

let client: PostHog | null = null;
let initAttempted = false;

function getClient(): PostHog | null {
  if (client) return client;
  if (initAttempted) return null;
  initAttempted = true;

  // Match Sentry gating: only enable on production deploys. See sentry.server.config.ts.
  if (process.env.VERCEL_ENV !== 'production') return null;

  const apiKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  const host = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://us.i.posthog.com';
  if (!apiKey) return null;

  client = new PostHog(apiKey, {
    host,
    // Flush every event immediately — serverless functions die after the response,
    // so deferred batching would drop events.
    flushAt: 1,
    flushInterval: 0,
  });

  return client;
}

type AllowedPropertyValues = string | number | boolean | null;
type EventProperties = Record<string, AllowedPropertyValues>;

// Mirrors the @vercel/analytics/server signature: `await track(name, props, { headers })`.
// `headers` is accepted for source compatibility but unused — PostHog identifies via
// the project key, not request headers.
export async function track(
  event: string,
  properties?: EventProperties,
  _options?: { headers?: Headers },
): Promise<void> {
  if (process.env.NODE_ENV !== 'production') {
    console.debug('[analytics:server] track', event, properties);
  }

  const ph = getClient();
  if (!ph) return;

  ph.capture({
    distinctId: 'system',
    event,
    properties,
  });

  await ph.flush();
}
