// Shared server-side PostHog wrapper used by both the Next.js app and the
// GraphQL backend. Holds the singleton PostHog client, enforces the same
// env-based gating, sanitizes event properties, and exposes the same surface
// (track / identify / alias / flush / shutdown). Per-package wrappers add
// runtime-specific helpers like NextAuth session resolution or GraphQL
// context attribution.

import { PostHog } from 'posthog-node';
import type { AnalyticsEventProperties, AnalyticsSanitizedProperties } from '@boardsesh/shared-schema';

export type ServerEventProperties = AnalyticsEventProperties;

// Sentinel distinct id for OG image fetches. These are server-to-server bot
// requests (Slack, iMessage, Twitter previewers); attributing each to a fresh
// PostHog person would inflate person counts without adding signal. All OG
// events bucket into this single person and the contextual data lives in
// event properties (kind, climbUuid/userId/etc).
export const OG_BOT_DISTINCT_ID = 'og-bot';

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

export type CoreTrackArgs = {
  /** Required. Pass undefined when no attribution is available; the event is then dropped (callers shouldn't fabricate IDs). */
  distinctId: string | undefined;
  properties?: AnalyticsEventProperties;
};

export function trackCore(eventName: string, args: CoreTrackArgs): boolean {
  if (!args.distinctId) return false;

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

export function identifyCore(distinctId: string, properties?: AnalyticsEventProperties): boolean {
  const posthog = getPosthog();
  if (!posthog) return false;
  posthog.identify({ distinctId, properties: sanitize(properties) });
  return true;
}

// `distinctId` is the canonical/surviving person id; `alias` is the alternate
// that gets merged into it. For sign-up:
//   aliasCore(userId, anonProfileId)
// makes the new authenticated userId the surviving person and folds the
// pre-signup anonymous activity into it.
export function aliasCore(distinctId: string, alias: string): boolean {
  const posthog = getPosthog();
  if (!posthog) return false;
  posthog.alias({ distinctId, alias });
  return true;
}

export async function flushAnalytics(): Promise<void> {
  const posthog = posthogClient;
  if (!posthog) return;
  await posthog.flush();
}

export async function shutdownAnalytics(): Promise<void> {
  const posthog = posthogClient;
  if (!posthog) return;
  await posthog.shutdown();
  posthogClient = null;
  posthogInitAttempted = false;
}

// Test-only: reset lazy singleton so tests can re-initialize with fresh env.
export function __resetAnalyticsForTests(): void {
  posthogClient = null;
  posthogInitAttempted = false;
}
