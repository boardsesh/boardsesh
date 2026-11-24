import { captureBackendEvent } from './analytics/posthog';
import { logger } from '../utils/logger';

const FLUSH_INTERVAL_MS = 60_000;
const MAX_BUCKETS = 1000;
const OVERFLOW = '(overflow)';
// Fixed, bounded histogram: latency tracking never retains individual requests.
const LATENCY_BOUNDS_MS = [10, 25, 50, 100, 250, 500, 1000, 2000, 5000, 10_000, 30_000, 60_000];

interface UsageBucket {
  clientId: string;
  surface: 'api' | 'oauth' | 'mcp';
  requests: number;
  clientErrors: number;
  serverErrors: number;
  rateLimited: number;
  connectionCapRefusals: number;
  pendingAuthAddressRefusals: number;
  latency: number[];
}

let buckets = new Map<string, UsageBucket>();
let reporter: ReturnType<typeof setInterval> | undefined;
const lastAlertAt = new Map<string, number>();
const ALERT_COOLDOWN_MS = 15 * 60_000;

function bucketFor(clientId: string | undefined, surface: UsageBucket['surface']): UsageBucket {
  const identity = clientId ?? '(unauthenticated)';
  const candidateKey = `${surface}:${identity}`;
  // Preserve one fixed anonymous MCP bucket even when dynamic app cardinality
  // is full, so pre-auth admission counters never acquire another attribution.
  const reservedAnonymousMcp = clientId === undefined && surface === 'mcp';
  const key =
    buckets.has(candidateKey) || buckets.size < MAX_BUCKETS || reservedAnonymousMcp
      ? candidateKey
      : `${surface}:${OVERFLOW}`;
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = {
      clientId: key === candidateKey ? identity : OVERFLOW,
      surface,
      requests: 0,
      clientErrors: 0,
      serverErrors: 0,
      rateLimited: 0,
      connectionCapRefusals: 0,
      pendingAuthAddressRefusals: 0,
      latency: Array.from({ length: LATENCY_BOUNDS_MS.length }, () => 0),
    };
    buckets.set(key, bucket);
  }
  return bucket;
}

/** Only pass a client id established by authentication, never a request field. */
export function recordPublicApiRequest(
  clientId: string | undefined,
  surface: UsageBucket['surface'],
  status: number,
  durationMs: number,
): void {
  const bucket = bucketFor(clientId, surface);
  bucket.requests += 1;
  if (status >= 400 && status < 500) bucket.clientErrors += 1;
  if (status >= 500) bucket.serverErrors += 1;
  if (status === 429) bucket.rateLimited += 1;
  const boundary = LATENCY_BOUNDS_MS.findIndex((upperBound) => durationMs <= upperBound);
  bucket.latency[boundary === -1 ? LATENCY_BOUNDS_MS.length - 1 : boundary] += 1;
}

/** Called only after the connection and app policy have been locked. */
export function recordPartnerConnectionCapRefusal(clientId: string): void {
  bucketFor(clientId, 'oauth').connectionCapRefusals += 1;
}

/** No actor is established yet; never label these refusals with request identities. */
export function recordGymMcpPendingAuthAddressRefusal(): void {
  bucketFor(undefined, 'mcp').pendingAuthAddressRefusals += 1;
}

export function flushPublicApiUsage(): void {
  const completed = buckets;
  buckets = new Map();
  for (const bucket of completed.values()) {
    let observed = 0;
    const percentileIndex = bucket.latency.findIndex((count) => {
      observed += count;
      return observed >= Math.ceil(bucket.requests * 0.95);
    });
    const summary = {
      client_id: bucket.clientId,
      surface: bucket.surface,
      requests: bucket.requests,
      client_errors: bucket.clientErrors,
      server_errors: bucket.serverErrors,
      rate_limited: bucket.rateLimited,
      connection_cap_refusals: bucket.connectionCapRefusals,
      pending_auth_address_refusals: bucket.pendingAuthAddressRefusals,
      p95_ms: bucket.requests === 0 ? 0 : LATENCY_BOUNDS_MS[Math.max(0, percentileIndex)],
    };
    logger.info('[public-api-usage] per-minute summary', summary);
    captureBackendEvent('Public API Usage Summary', {
      systemDistinctId: 'system:public-api-usage',
      properties: summary,
    });
    // A minimum sample prevents one expired token or one retry paging operators.
    if (
      bucket.connectionCapRefusals > 0 ||
      (bucket.requests >= 100 &&
        (bucket.serverErrors / bucket.requests >= 0.05 ||
          bucket.rateLimited / bucket.requests >= 0.2 ||
          bucket.clientErrors / bucket.requests >= 0.5))
    ) {
      const now = Date.now();
      for (const [key, previous] of lastAlertAt) if (now - previous >= ALERT_COOLDOWN_MS) lastAlertAt.delete(key);
      const appKey = `${bucket.surface}:${bucket.clientId}`;
      const key = lastAlertAt.has(appKey) || lastAlertAt.size < MAX_BUCKETS ? appKey : OVERFLOW;
      if (!lastAlertAt.has(key)) {
        lastAlertAt.set(key, now);
        logger.error('[public-api-usage] app needs attention', {
          ...summary,
          error: new Error('Partner API error ratio or connection cap threshold exceeded'),
        });
      }
    }
  }
}

export function startPublicApiUsageReporter(): void {
  if (reporter) return;
  reporter = setInterval(flushPublicApiUsage, FLUSH_INTERVAL_MS);
  reporter.unref();
}

export function stopPublicApiUsageReporter(): void {
  if (reporter) clearInterval(reporter);
  reporter = undefined;
  flushPublicApiUsage();
}
