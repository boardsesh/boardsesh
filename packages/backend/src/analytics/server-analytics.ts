import { type AnalyticsEventProperties, isValidDistinctId, SERVER_DISTINCT_ID_HEADER } from '@boardsesh/shared-schema';
import {
  aliasCore,
  flushAnalytics,
  identifyCore,
  shutdownAnalytics,
  trackCore,
  __resetAnalyticsForTests,
} from '@boardsesh/analytics-server';

export type ServerEventProperties = AnalyticsEventProperties;
export { SERVER_DISTINCT_ID_HEADER };

export type ContextAttribution = {
  // undefined when the WS connection has neither a NextAuth user nor a
  // client-supplied distinct id. Callers pass this through to trackServer
  // and the event is silently dropped.
  distinctId: string | undefined;
  isAuthenticated: boolean;
  userId?: string;
};

// Resolve attribution from a GraphQL connection context. Authenticated users prefer
// session.userId; otherwise the client supplies its IndexedDB partyProfile UUID via the
// x-bs-distinct-id header (parsed in yoga.ts/websocket setup and stashed on the context).
export function resolveContextAttribution(ctx: {
  isAuthenticated?: boolean;
  userId?: string;
  distinctId?: string;
}): ContextAttribution {
  if (ctx.isAuthenticated && ctx.userId) {
    return { distinctId: ctx.userId, isAuthenticated: true, userId: ctx.userId };
  }
  if (ctx.distinctId) {
    return { distinctId: ctx.distinctId, isAuthenticated: false };
  }
  return { distinctId: undefined, isAuthenticated: false };
}

// Read and validate the x-bs-distinct-id header off an incoming request. Returns
// undefined when missing, oversized, or not a UUID (the only shape the client
// ever sends).
export function readDistinctIdHeader(
  headers: Headers | Record<string, string | string[] | undefined>,
): string | undefined {
  const raw =
    headers instanceof Headers
      ? headers.get(SERVER_DISTINCT_ID_HEADER)
      : (() => {
          const value = headers[SERVER_DISTINCT_ID_HEADER];
          if (Array.isArray(value)) return value[0] ?? null;
          return value ?? null;
        })();
  return isValidDistinctId(raw) ? raw : undefined;
}

type TrackArgs = {
  distinctId: string | undefined;
  properties?: AnalyticsEventProperties;
};

export function trackServer(eventName: string, args: TrackArgs): boolean {
  return trackCore(eventName, { distinctId: args.distinctId, properties: args.properties });
}

export function identifyServer(distinctId: string, properties?: AnalyticsEventProperties): boolean {
  return identifyCore(distinctId, properties);
}

// `distinctId` is the canonical/surviving person id; `alias` is the alternate
// that gets merged into it. See packages/web/app/lib/analytics.server.ts for
// the full contract — for anonymous → authenticated linking, pass
// distinctId=userId and alias=anonProfileId.
export function aliasServer(distinctId: string, alias: string): boolean {
  return aliasCore(distinctId, alias);
}

export async function flushServerAnalytics(): Promise<void> {
  await flushAnalytics();
}

export async function shutdownServerAnalytics(): Promise<void> {
  await shutdownAnalytics();
}

// Test-only: reset lazy singleton so tests can re-initialize with fresh env.
export function __resetServerAnalyticsForTests(): void {
  __resetAnalyticsForTests();
}
