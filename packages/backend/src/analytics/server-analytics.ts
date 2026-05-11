import { PostHog } from 'posthog-node';
import {
  type AnalyticsEventProperties,
  type AnalyticsSanitizedProperties,
  isValidDistinctId,
  SERVER_DISTINCT_ID_HEADER,
} from '@boardsesh/shared-schema';

export type ServerEventProperties = AnalyticsEventProperties;
export { SERVER_DISTINCT_ID_HEADER };

let posthogClient: PostHog | null = null;
let posthogInitAttempted = false;
// Same env var name as the web client/server wrapper. Backend doesn't see
// NEXT_PUBLIC_* runtime injections, but ops can set this directly.
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

export type ContextAttribution = {
  distinctId: string;
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
  connectionId: string;
}): ContextAttribution {
  if (ctx.isAuthenticated && ctx.userId) {
    return { distinctId: ctx.userId, isAuthenticated: true, userId: ctx.userId };
  }
  if (ctx.distinctId) {
    return { distinctId: ctx.distinctId, isAuthenticated: false };
  }
  return { distinctId: `server-anon-${ctx.connectionId}`, isAuthenticated: false };
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
  distinctId: string;
  properties?: ServerEventProperties;
};

export function trackServer(eventName: string, args: TrackArgs): boolean {
  if (process.env.NODE_ENV !== 'production' && shouldDebug) {
    console.info('[analytics] track', eventName, { distinctId: args.distinctId, ...args.properties });
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

// `distinctId` is the canonical/surviving person id; `alias` is the alternate
// that gets merged into it. See packages/web/app/lib/analytics.server.ts for
// the full contract — for anonymous → authenticated linking, pass
// distinctId=userId and alias=anonProfileId.
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

// Test-only: reset lazy singleton so tests can re-initialize with fresh env.
export function __resetServerAnalyticsForTests(): void {
  posthogClient = null;
  posthogInitAttempted = false;
}
