import type { Plugin } from 'graphql-yoga';
import {
  CLIENT_IDENTITY_MAX_LENGTH,
  type ClientIdentity,
  type ConnectionContext,
  parseClientIdentity,
  UNKNOWN_CLIENT,
} from '@boardsesh/shared-schema';
import { logger } from '../utils/logger';
import { captureBackendEvent } from './analytics/posthog';

/**
 * Per-client operation counters behind the once-a-minute usage summary.
 *
 * Every GraphQL operation (HTTP via the Yoga plugin below, WebSocket via the
 * graphql-ws per-operation `context` hook) bumps a counter keyed by the
 * client's name, version and transport. A missing or malformed identity lands
 * in the `unknown` bucket. Measurement only: nothing here gates, throttles or
 * rejects a request.
 *
 * Counters are in-process, so each replica reports its own share.
 */

export type ClientUsageTransport = 'http' | 'ws';

type ClientUsageBucket = {
  clientName: string;
  clientVersion: string;
  transport: ClientUsageTransport;
  operations: number;
};

export const CLIENT_USAGE_FLUSH_INTERVAL_MS = 60_000;
/** How many buckets one summary reports; the rest are counted in `droppedBuckets`. */
export const CLIENT_USAGE_REPORTED_BUCKETS = 50;
/**
 * Hard cap on distinct buckets held between flushes. The version field is
 * client-authored, so a client cycling versions could otherwise grow the map
 * without bound. Past the cap, new keys fold into one overflow bucket.
 */
export const CLIENT_USAGE_MAX_TRACKED_BUCKETS = 1_000;
export const CLIENT_USAGE_OVERFLOW_CLIENT = '(overflow)';

const ANALYTICS_DISTINCT_ID = 'system:client-usage';

let buckets = new Map<string, ClientUsageBucket>();
let reporterTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Normalise an incoming identity value (header or connectionParam) into the
 * two context fields. A non-string or blank value yields neither field. The
 * raw string is trimmed and capped at the parser's length limit so a hostile
 * value cannot bloat every log line it appears in.
 */
export function resolveClientIdentity(rawValue: unknown): {
  clientIdentity?: ClientIdentity;
  clientIdentityRaw?: string;
} {
  if (typeof rawValue !== 'string') return {};
  const trimmed = rawValue.trim();
  if (trimmed.length === 0) return {};
  return {
    clientIdentity: parseClientIdentity(trimmed),
    clientIdentityRaw: trimmed.slice(0, CLIENT_IDENTITY_MAX_LENGTH),
  };
}

export function recordClientOperation(
  clientIdentity: ClientIdentity | undefined,
  transport: ClientUsageTransport,
): void {
  const clientName = clientIdentity?.name ?? UNKNOWN_CLIENT;
  const clientVersion = clientIdentity?.version ?? UNKNOWN_CLIENT;
  const bucketKey = `${transport}\u0000${clientName}\u0000${clientVersion}`;
  let bucket = buckets.get(bucketKey);

  if (!bucket) {
    const isOverflow = buckets.size >= CLIENT_USAGE_MAX_TRACKED_BUCKETS;
    const resolvedKey = isOverflow ? `${transport}\u0000${CLIENT_USAGE_OVERFLOW_CLIENT}` : bucketKey;
    bucket = buckets.get(resolvedKey);
    if (!bucket) {
      bucket = {
        clientName: isOverflow ? CLIENT_USAGE_OVERFLOW_CLIENT : clientName,
        clientVersion: isOverflow ? CLIENT_USAGE_OVERFLOW_CLIENT : clientVersion,
        transport,
        operations: 0,
      };
      buckets.set(resolvedKey, bucket);
    }
  }

  bucket.operations += 1;
}

/** Record one operation from a resolved connection context. */
export function recordContextOperation(
  context: Pick<ConnectionContext, 'clientIdentity' | 'transport'>,
  fallbackTransport: ClientUsageTransport,
): void {
  recordClientOperation(context.clientIdentity, context.transport ?? fallbackTransport);
}

/**
 * Emit the summary for everything counted since the last flush and reset the
 * counters. Does nothing when no operation was counted.
 */
export function flushClientUsage(): void {
  if (buckets.size === 0) return;
  const flushed = buckets;
  buckets = new Map();

  const sorted = [...flushed.values()].sort((left, right) => right.operations - left.operations);
  const reported = sorted.slice(0, CLIENT_USAGE_REPORTED_BUCKETS);
  const totalOperations = sorted.reduce((sum, bucket) => sum + bucket.operations, 0);

  logger.info('[client-usage] per-minute summary', {
    buckets: reported,
    droppedBuckets: sorted.length - reported.length,
    totalOperations,
  });

  for (const bucket of reported) {
    captureBackendEvent('Client Usage Summary', {
      systemDistinctId: ANALYTICS_DISTINCT_ID,
      properties: {
        client_name: bucket.clientName,
        client_version: bucket.clientVersion,
        transport: bucket.transport,
        operations: bucket.operations,
      },
    });
  }
}

export function startClientUsageReporter(): void {
  if (reporterTimer !== null) return;
  reporterTimer = setInterval(() => {
    try {
      flushClientUsage();
    } catch (error) {
      logger.warn('[client-usage] Could not flush usage summary:', error);
    }
  }, CLIENT_USAGE_FLUSH_INTERVAL_MS);
  reporterTimer.unref();
}

/**
 * Stop the reporter. The partial minute is discarded rather than flushed:
 * shutdown tears PostHog down too, and a capture after that would re-create
 * the client.
 */
export function stopClientUsageReporter(): void {
  if (reporterTimer !== null) {
    clearInterval(reporterTimer);
    reporterTimer = null;
  }
  buckets = new Map();
}

/** Test-only view of the live counters. */
export function getClientUsageSnapshotForTests(): ClientUsageBucket[] {
  return [...buckets.values()].map((bucket) => ({ ...bucket }));
}

function readContextIdentity(contextValue: unknown): Pick<ConnectionContext, 'clientIdentity' | 'transport'> {
  if (typeof contextValue !== 'object' || contextValue === null) return {};
  const candidate = contextValue as Partial<ConnectionContext>;
  return { clientIdentity: candidate.clientIdentity, transport: candidate.transport };
}

/** Yoga plugin: counts each executed HTTP operation against its client. */
export function clientUsagePlugin(): Plugin {
  return {
    onExecute({ args }) {
      recordContextOperation(readContextIdentity(args.contextValue), 'http');
    },
  };
}
