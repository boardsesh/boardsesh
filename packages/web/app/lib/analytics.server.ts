import 'server-only';

import { track as vercelTrack } from '@vercel/analytics/server';
import { getServerSession, type Session } from 'next-auth';
import { type AnalyticsEventProperties, isValidDistinctId, SERVER_DISTINCT_ID_HEADER } from '@boardsesh/shared-schema';
import {
  aliasCore,
  flushAnalytics,
  identifyCore,
  shutdownAnalytics,
  trackCore,
  __resetAnalyticsForTests,
} from '@boardsesh/analytics-server';
import { authOptions } from './auth/auth-options';
import { isAdminAnalyticsUrl } from './analytics-paths';

export const track: typeof vercelTrack = (eventName, properties, options) => {
  return vercelTrack(eventName, properties, options);
};

export type ServerEventProperties = AnalyticsEventProperties;
export { SERVER_DISTINCT_ID_HEADER };

const shouldDebug = process.env.NEXT_PUBLIC_ANALYTICS_DEBUG === '1';

export type RequestAttribution = {
  // undefined when no usable identity could be resolved (no NextAuth session
  // and no client-supplied distinct id header). Callers should pass this
  // through to trackServer; events with undefined distinctId are silently
  // dropped rather than fabricating throwaway PostHog persons.
  distinctId: string | undefined;
  isAuthenticated: boolean;
  userId?: string;
};

// Resolution order: NextAuth session -> x-bs-distinct-id header (anonymous client distinct
// id propagated by analytics-distinct-id.ts) -> undefined (event dropped).
//
// `userIdOverride` lets callers that already loaded the session via getServerSession
// avoid a redundant cookie-decode round-trip.
export async function resolveRequestAttribution(
  req: Request,
  options?: { userIdOverride?: string },
): Promise<RequestAttribution> {
  if (options?.userIdOverride) {
    return { distinctId: options.userIdOverride, isAuthenticated: true, userId: options.userIdOverride };
  }

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
  if (isValidDistinctId(headerId)) {
    return { distinctId: headerId, isAuthenticated: false };
  }

  return { distinctId: undefined, isAuthenticated: false };
}

type TrackArgs = {
  distinctId: string | undefined;
  properties?: AnalyticsEventProperties;
  // If set, the event is dropped when the route is the admin surface. Pass the path
  // that triggered the event (route handler URL or referer pathname).
  route?: string;
};

export function trackServer(eventName: string, args: TrackArgs): boolean {
  if (args.route && isAdminAnalyticsUrl(args.route)) return false;
  return trackCore(eventName, { distinctId: args.distinctId, properties: args.properties });
}

export function identifyServer(distinctId: string, properties?: AnalyticsEventProperties): boolean {
  return identifyCore(distinctId, properties);
}

// `distinctId` is the canonical/surviving person id; `alias` is the alternate
// that gets merged into it. For sign-up:
//   aliasServer(userId, anonProfileId)
// makes the new authenticated userId the surviving person and folds the
// pre-signup anonymous activity into it.
export function aliasServer(distinctId: string, alias: string): boolean {
  return aliasCore(distinctId, alias);
}

export async function flushServerAnalytics(): Promise<void> {
  await flushAnalytics();
}

export async function shutdownServerAnalytics(): Promise<void> {
  await shutdownAnalytics();
}

// Derive a low-cardinality, leak-safe error kind for analytics from an
// arbitrary thrown value. Avoids putting raw error.message in event
// properties — those routinely contain DB constraint names, table names,
// stack frames, or user-controlled text.
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
  __resetAnalyticsForTests();
}
