import 'server-only';

import { track as vercelTrack } from '@vercel/analytics/server';
import { PostHog } from 'posthog-node';
import { getServerSession, type Session } from 'next-auth';
import {
  type AnalyticsEventProperties,
  type AnalyticsSanitizedProperties,
  MAX_DISTINCT_ID_LENGTH,
  SERVER_DISTINCT_ID_HEADER,
} from '@boardsesh/shared-schema';
import { authOptions } from './auth/auth-options';
import { isAdminAnalyticsUrl } from './analytics-paths';

export const track: typeof vercelTrack = (eventName, properties, options) => {
  return vercelTrack(eventName, properties, options);
};

export type ServerEventProperties = AnalyticsEventProperties;
export { SERVER_DISTINCT_ID_HEADER };

let posthogClient: PostHog | null = null;
let posthogInitAttempted = false;
const shouldDebug = process.env.NEXT_PUBLIC_ANALYTICS_DEBUG === '1';

function shouldEnableServerAnalytics(): boolean {
  if (!process.env.NEXT_PUBLIC_POSTHOG_KEY) return false;
  if (process.env.NODE_ENV === 'production') return true;
  return process.env.BOARDSESH_ENABLE_SERVER_ANALYTICS === '1';
}

function getPosthog(): PostHog | null {
  if (posthogClient) return posthogClient;
  if (posthogInitAttempted) return null;
  posthogInitAttempted = true;

  if (!shouldEnableServerAnalytics()) return null;

  const apiKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!apiKey) return null;
  const host = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://us.i.posthog.com';

  posthogClient = new PostHog(apiKey, {
    host,
    flushAt: 20,
    flushInterval: 10_000,
  });

  return posthogClient;
}

function sanitize(properties?: AnalyticsEventProperties): AnalyticsSanitizedProperties | undefined {
  if (!properties) return undefined;
  const out: AnalyticsSanitizedProperties = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export type RequestAttribution = {
  distinctId: string;
  isAuthenticated: boolean;
  userId?: string;
};

// Resolution order: NextAuth session -> x-bs-distinct-id header (anonymous client distinct
// id propagated by api-client.ts) -> ephemeral server-anon UUID. The last branch produces a
// new PostHog person per event and should be rare; it's only hit when the client never
// hydrated the IndexedDB partyProfile (e.g. server-to-server cron callbacks).
export async function resolveRequestAttribution(req: Request): Promise<RequestAttribution> {
  let session: Session | null = null;
  try {
    session = await getServerSession(authOptions);
  } catch (err) {
    if (shouldDebug) console.warn('[analytics.server] getServerSession failed', err);
  }

  if (session?.user?.id) {
    return { distinctId: session.user.id, isAuthenticated: true, userId: session.user.id };
  }

  const headerId = req.headers.get(SERVER_DISTINCT_ID_HEADER);
  if (headerId && headerId.length > 0 && headerId.length <= MAX_DISTINCT_ID_LENGTH) {
    return { distinctId: headerId, isAuthenticated: false };
  }

  return { distinctId: `server-anon-${crypto.randomUUID()}`, isAuthenticated: false };
}

type TrackArgs = {
  distinctId: string;
  properties?: ServerEventProperties;
  // If set, the event is dropped when the route is the admin surface. Pass the path
  // that triggered the event (route handler URL or referer pathname).
  route?: string;
};

export function trackServer(eventName: string, args: TrackArgs): boolean {
  if (args.route && isAdminAnalyticsUrl(args.route)) return false;

  if (process.env.NODE_ENV !== 'production' && shouldDebug) {
    console.info('[analytics.server] track', eventName, { distinctId: args.distinctId, ...args.properties });
  }

  const posthog = getPosthog();
  if (!posthog) return false;
  posthog.capture({
    distinctId: args.distinctId,
    event: eventName,
    properties: sanitize(args.properties),
  });
  return true;
}

export function identifyServer(distinctId: string, properties?: ServerEventProperties): boolean {
  const posthog = getPosthog();
  if (!posthog) return false;
  posthog.identify({ distinctId, properties: sanitize(properties) });
  return true;
}

// Matches posthog-node's own alias() shape: `distinctId` is the surviving
// person, `alias` is the other ID that gets merged into it. For the
// anonymous → authenticated flow, pass distinctId=anonymousId and
// alias=newUserId — this mirrors what posthog-js-lite does on the client
// when we call alias(userId) while still identified as the anon profile.
// See `node_modules/posthog-node/src/client.ts::alias` for the canonical
// example which uses the same direction.
export function aliasServer(distinctId: string, alias: string): boolean {
  const posthog = getPosthog();
  if (!posthog) return false;
  posthog.alias({ distinctId, alias });
  return true;
}

export async function flushServerAnalytics(): Promise<void> {
  const posthog = posthogClient;
  if (!posthog) return;
  await posthog.flush();
}

export async function shutdownServerAnalytics(): Promise<void> {
  const posthog = posthogClient;
  if (!posthog) return;
  await posthog.shutdown();
  posthogClient = null;
  posthogInitAttempted = false;
}

// Derive a low-cardinality, leak-safe error kind for analytics from an
// arbitrary thrown value. Avoids putting raw error.message in event
// properties — those routinely contain DB constraint names, table names,
// stack frames, or user-controlled text.
//
// Handles common shapes:
//   - HTTP-status-prefixed messages like "401: Unauthorized" → "401"
//   - "HTTP error! status=503" patterns → "http_error"
//   - falls back to error.name (TypeError, ZodError, …) or 'unknown'
const HTTP_STATUS_PREFIX = /^([1-5]\d{2})\b/;

export function safeErrorKind(err: unknown): string {
  if (!(err instanceof Error)) return 'unknown';
  const statusMatch = err.message.match(HTTP_STATUS_PREFIX);
  if (statusMatch) return statusMatch[1];
  if (err.message.startsWith('HTTP error!')) return 'http_error';
  if (err.name && err.name !== 'Error') return err.name;
  return 'unknown';
}

// Test-only: reset the lazy singleton so tests can re-initialize with new env.
export function __resetServerAnalyticsForTests(): void {
  posthogClient = null;
  posthogInitAttempted = false;
}
