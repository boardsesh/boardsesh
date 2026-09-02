import { pathToFileURL } from 'node:url';
import { parseSnapshotManifest } from '@boardsesh/offline-sync';
import { DEFAULT_SNAPSHOT_MAX_CUTOFF_AGE_SECONDS } from './snapshot-contract';

const LIVE_KEY_PREFIX = 'board-snapshots/v1-gzip';
const DEFAULT_REFRESH_MAX_AGE_SECONDS = 45 * 60;
const DEFAULT_FULL_MAX_AGE_SECONDS = 30 * 60 * 60;
const MAX_FUTURE_CLOCK_SKEW_SECONDS = 5 * 60;
const HEARTBEAT_FETCH_TIMEOUT_MS = 10_000;
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

type SnapshotRunKind = 'refresh' | 'full';
type SnapshotHeartbeatLineage = { systemIdentifier: string; timelineId: number };

type HeartbeatCheck = {
  stale: boolean;
  ageSeconds: number | null;
  reason: string;
};

export type SnapshotHeartbeatDecision = {
  checkedAt: string;
  refresh: HeartbeatCheck;
  full: HeartbeatCheck;
};

type HeartbeatPayload = {
  formatVersion: number;
  completedAt: string;
  runKind: SnapshotRunKind;
  source: 'primary' | 'replica';
  imageDigest: string;
  keyPrefix: string;
  stableBefore: string;
  targetLsn: string;
  replayLsn: string;
  systemIdentifier: string;
  timelineId: number;
  manifestGeneratedAt: string;
};

type FetchHeartbeat = (url: string) => Promise<unknown>;
type FetchedHeartbeat = { ok: true; payload: unknown } | { ok: false; reason: string };
type LiveManifestAnchor = { generatedAt: string; content: string };

function positiveSeconds(raw: string | undefined, fallback: number, name: string): number {
  if (!raw?.trim()) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number of seconds`);
  return parsed;
}

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);
}

function normalizedPublicBaseUrl(rawPublicBaseUrl: string): string {
  const publicBaseUrl = rawPublicBaseUrl.trim().replace(/\/+$/, '');
  if (!publicBaseUrl) throw new Error('publicBaseUrl is required');

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(publicBaseUrl);
  } catch {
    throw new Error('publicBaseUrl must be an absolute URL');
  }
  const hostname = parsedUrl.hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  const isExplicitLoopback = LOOPBACK_HOSTNAMES.has(hostname);
  if (parsedUrl.protocol !== 'https:' && !(parsedUrl.protocol === 'http:' && isExplicitLoopback)) {
    throw new Error('publicBaseUrl must use HTTPS outside an explicit loopback host');
  }
  if (parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
    throw new Error('publicBaseUrl must not contain credentials, a query, or a fragment');
  }
  return publicBaseUrl;
}

function parseHeartbeat(
  candidate: unknown,
  expectedRunKind: SnapshotRunKind,
  expectedImageDigest: string,
  expectedManifestGeneratedAt: string | null,
  expectedLineage: SnapshotHeartbeatLineage | null,
): HeartbeatPayload {
  if (!isRecord(candidate)) throw new Error('heartbeat is not a JSON object');
  if (candidate.formatVersion !== 1) throw new Error('unsupported heartbeat formatVersion');
  if (candidate.runKind !== expectedRunKind) throw new Error(`expected ${expectedRunKind} heartbeat`);
  if (candidate.source !== 'primary' && candidate.source !== 'replica') throw new Error('invalid heartbeat source');
  if (candidate.keyPrefix !== LIVE_KEY_PREFIX) throw new Error(`heartbeat is not for ${LIVE_KEY_PREFIX}`);
  if (typeof candidate.completedAt !== 'string' || !Number.isFinite(Date.parse(candidate.completedAt))) {
    throw new Error('invalid heartbeat completedAt');
  }
  if (typeof candidate.imageDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(candidate.imageDigest)) {
    throw new Error('heartbeat does not identify an immutable exporter image');
  }
  if (candidate.imageDigest !== expectedImageDigest) {
    throw new Error('heartbeat exporter digest does not match the configured release');
  }
  for (const field of ['stableBefore', 'targetLsn', 'replayLsn', 'manifestGeneratedAt'] as const) {
    if (typeof candidate[field] !== 'string' || candidate[field].trim() === '') {
      throw new Error(`heartbeat is missing ${field}`);
    }
  }
  if (typeof candidate.stableBefore !== 'string' || !Number.isFinite(Date.parse(candidate.stableBefore))) {
    throw new Error('heartbeat has an invalid stableBefore');
  }
  if (typeof candidate.systemIdentifier !== 'string' || !/^\d+$/.test(candidate.systemIdentifier)) {
    throw new Error('heartbeat is missing a PostgreSQL system identifier');
  }
  if (
    typeof candidate.timelineId !== 'number' ||
    !Number.isSafeInteger(candidate.timelineId) ||
    candidate.timelineId <= 0
  ) {
    throw new Error('heartbeat is missing a valid PostgreSQL timeline');
  }
  if (expectedManifestGeneratedAt && candidate.manifestGeneratedAt !== expectedManifestGeneratedAt) {
    throw new Error('heartbeat does not describe the currently published manifest');
  }
  if (
    expectedLineage &&
    (candidate.systemIdentifier !== expectedLineage.systemIdentifier ||
      candidate.timelineId !== expectedLineage.timelineId)
  ) {
    throw new Error('heartbeat PostgreSQL lineage does not match the current refresh publisher');
  }
  return candidate as HeartbeatPayload;
}

type HeartbeatEvaluationParams = {
  payload: unknown;
  expectedRunKind: SnapshotRunKind;
  expectedImageDigest: string;
  expectedManifestGeneratedAt: string | null;
  expectedLineage?: SnapshotHeartbeatLineage | null;
  nowMs: number;
  maxAgeSeconds: number;
  maxCutoffAgeSeconds?: number;
};

/**
 * The freshness verdict plus the payload it was derived from. Callers that need
 * a field off the heartbeat itself (the PostgreSQL lineage the full check is
 * validated against) read it here instead of parsing the same object twice.
 * `heartbeat` is null exactly when validation failed.
 */
type HeartbeatEvaluation = { check: HeartbeatCheck; heartbeat: HeartbeatPayload | null };

function evaluateHeartbeatPayload(params: HeartbeatEvaluationParams): HeartbeatEvaluation {
  try {
    const heartbeat = parseHeartbeat(
      params.payload,
      params.expectedRunKind,
      params.expectedImageDigest,
      params.expectedManifestGeneratedAt,
      params.expectedLineage ?? null,
    );
    const completedAtMs = Date.parse(heartbeat.completedAt);
    const stableBeforeMs = Date.parse(heartbeat.stableBefore);
    const ageSeconds = (params.nowMs - completedAtMs) / 1000;
    if (ageSeconds < -MAX_FUTURE_CLOCK_SKEW_SECONDS) {
      return {
        check: { stale: true, ageSeconds, reason: 'heartbeat completedAt is too far in the future' },
        heartbeat,
      };
    }
    if (ageSeconds > params.maxAgeSeconds) {
      return {
        check: { stale: true, ageSeconds, reason: `heartbeat is older than ${params.maxAgeSeconds}s` },
        heartbeat,
      };
    }
    const cutoffAgeAtCompletionSeconds = (completedAtMs - stableBeforeMs) / 1000;
    const maxCutoffAgeSeconds = params.maxCutoffAgeSeconds ?? DEFAULT_SNAPSHOT_MAX_CUTOFF_AGE_SECONDS;
    if (cutoffAgeAtCompletionSeconds < 0) {
      return {
        check: { stale: true, ageSeconds, reason: 'heartbeat stableBefore is later than completedAt' },
        heartbeat,
      };
    }
    if (cutoffAgeAtCompletionSeconds > maxCutoffAgeSeconds) {
      return {
        check: {
          stale: true,
          ageSeconds,
          reason: `heartbeat cutoff was older than ${maxCutoffAgeSeconds}s at completion`,
        },
        heartbeat,
      };
    }
    return { check: { stale: false, ageSeconds, reason: 'fresh' }, heartbeat };
  } catch (error) {
    return {
      check: {
        stale: true,
        ageSeconds: null,
        reason: error instanceof Error ? error.message : String(error),
      },
      heartbeat: null,
    };
  }
}

export function evaluateSnapshotHeartbeat(params: HeartbeatEvaluationParams): HeartbeatCheck {
  return evaluateHeartbeatPayload(params).check;
}

async function fetchHeartbeatJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    cache: 'no-store',
    headers: { 'cache-control': 'no-cache' },
    signal: AbortSignal.timeout(HEARTBEAT_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`GET ${new URL(url).pathname} returned ${response.status}`);
  return response.json() as Promise<unknown>;
}

async function fetchOne(url: string, fetchHeartbeat: FetchHeartbeat): Promise<FetchedHeartbeat> {
  try {
    return { ok: true, payload: await fetchHeartbeat(url) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function liveManifestAnchor(payload: unknown): LiveManifestAnchor {
  const manifest = parseSnapshotManifest(payload);
  if (!manifest) throw new Error('live snapshot manifest failed schema validation');
  return { generatedAt: manifest.generatedAt, content: JSON.stringify(manifest) };
}

function evaluateFetched(params: {
  fetched: FetchedHeartbeat;
  runKind: SnapshotRunKind;
  nowMs: number;
  maxAgeSeconds: number;
  expectedImageDigest: string;
  expectedManifestGeneratedAt: string | null;
  expectedLineage?: SnapshotHeartbeatLineage | null;
  maxCutoffAgeSeconds: number;
}): HeartbeatEvaluation {
  if (!params.fetched.ok) {
    return { check: { stale: true, ageSeconds: null, reason: params.fetched.reason }, heartbeat: null };
  }
  return evaluateHeartbeatPayload({
    payload: params.fetched.payload,
    expectedRunKind: params.runKind,
    expectedImageDigest: params.expectedImageDigest,
    expectedManifestGeneratedAt: params.expectedManifestGeneratedAt,
    expectedLineage: params.expectedLineage,
    nowMs: params.nowMs,
    maxAgeSeconds: params.maxAgeSeconds,
    maxCutoffAgeSeconds: params.maxCutoffAgeSeconds,
  });
}

export async function snapshotHeartbeatDecision(params: {
  publicBaseUrl: string;
  expectedImageDigest: string;
  nowMs?: number;
  refreshMaxAgeSeconds?: number;
  fullMaxAgeSeconds?: number;
  maxCutoffAgeSeconds?: number;
  fetchHeartbeat?: FetchHeartbeat;
}): Promise<SnapshotHeartbeatDecision> {
  const publicBaseUrl = normalizedPublicBaseUrl(params.publicBaseUrl);
  if (!/^sha256:[0-9a-f]{64}$/.test(params.expectedImageDigest)) {
    throw new Error('expectedImageDigest must be an exact sha256 digest');
  }
  const nowMs = params.nowMs ?? Date.now();
  const cacheBuster = encodeURIComponent(String(nowMs));
  const fetchHeartbeat = params.fetchHeartbeat ?? fetchHeartbeatJson;
  let initialManifest: LiveManifestAnchor;
  try {
    const manifestPayload = await fetchHeartbeat(
      `${publicBaseUrl}/${LIVE_KEY_PREFIX}/manifest.json?watchdog=${cacheBuster}-manifest-before`,
    );
    initialManifest = liveManifestAnchor(manifestPayload);
  } catch (error) {
    const reason = `live manifest unavailable: ${error instanceof Error ? error.message : String(error)}`;
    const stale = { stale: true, ageSeconds: null, reason };
    return { checkedAt: new Date(nowMs).toISOString(), refresh: stale, full: stale };
  }
  const refreshMaxAgeSeconds = params.refreshMaxAgeSeconds ?? DEFAULT_REFRESH_MAX_AGE_SECONDS;
  const fullMaxAgeSeconds = params.fullMaxAgeSeconds ?? DEFAULT_FULL_MAX_AGE_SECONDS;
  const maxCutoffAgeSeconds = params.maxCutoffAgeSeconds ?? DEFAULT_SNAPSHOT_MAX_CUTOFF_AGE_SECONDS;
  const [refreshFetched, fullFetched] = await Promise.all([
    fetchOne(`${publicBaseUrl}/board-snapshots/ops/refresh.json?watchdog=${cacheBuster}-heartbeats`, fetchHeartbeat),
    fetchOne(`${publicBaseUrl}/board-snapshots/ops/full.json?watchdog=${cacheBuster}-heartbeats`, fetchHeartbeat),
  ]);
  let finalManifest: LiveManifestAnchor;
  try {
    const manifestPayload = await fetchHeartbeat(
      `${publicBaseUrl}/${LIVE_KEY_PREFIX}/manifest.json?watchdog=${cacheBuster}-manifest-after`,
    );
    finalManifest = liveManifestAnchor(manifestPayload);
  } catch (error) {
    const reason = `live manifest recheck unavailable: ${error instanceof Error ? error.message : String(error)}`;
    const stale = { stale: true, ageSeconds: null, reason };
    return { checkedAt: new Date(nowMs).toISOString(), refresh: stale, full: stale };
  }
  if (finalManifest.generatedAt !== initialManifest.generatedAt || finalManifest.content !== initialManifest.content) {
    const stale = {
      stale: true,
      ageSeconds: null,
      reason: 'live manifest changed while snapshot heartbeats were read',
    };
    return { checkedAt: new Date(nowMs).toISOString(), refresh: stale, full: stale };
  }
  const manifestGeneratedAt = initialManifest.generatedAt;
  const refreshEvaluation = evaluateFetched({
    fetched: refreshFetched,
    runKind: 'refresh',
    nowMs,
    maxAgeSeconds: refreshMaxAgeSeconds,
    expectedImageDigest: params.expectedImageDigest,
    expectedManifestGeneratedAt: manifestGeneratedAt,
    maxCutoffAgeSeconds,
  });
  // A refresh heartbeat that failed validation yields no payload, and
  // `refreshEvaluation.check` already carries the actionable reason. Without a
  // valid current refresh anchor, an older full heartbeat cannot prove that it
  // belongs to the same PostgreSQL system/timeline.
  const currentRefreshLineage: SnapshotHeartbeatLineage | null = refreshEvaluation.heartbeat
    ? {
        systemIdentifier: refreshEvaluation.heartbeat.systemIdentifier,
        timelineId: refreshEvaluation.heartbeat.timelineId,
      }
    : null;
  const full: HeartbeatCheck = currentRefreshLineage
    ? evaluateFetched({
        fetched: fullFetched,
        runKind: 'full',
        nowMs,
        maxAgeSeconds: fullMaxAgeSeconds,
        expectedImageDigest: params.expectedImageDigest,
        // A later threshold refresh legitimately advances the live manifest
        // without changing the age of the most recent full rebuild. Full is
        // generation-independent but must remain on the current lineage.
        expectedManifestGeneratedAt: null,
        expectedLineage: currentRefreshLineage,
        maxCutoffAgeSeconds,
      }).check
    : {
        stale: true,
        ageSeconds: null,
        reason: 'current refresh heartbeat is unavailable for PostgreSQL lineage validation',
      };
  return { checkedAt: new Date(nowMs).toISOString(), refresh: refreshEvaluation.check, full };
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (invokedPath === import.meta.url) {
  const publicBaseUrl = process.env.SNAPSHOT_PUBLIC_BASE_URL?.trim();
  if (!publicBaseUrl) throw new Error('SNAPSHOT_PUBLIC_BASE_URL is required');
  const expectedImageDigest = process.env.SNAPSHOT_EXPORTER_IMAGE_DIGEST?.trim();
  if (!expectedImageDigest) throw new Error('SNAPSHOT_EXPORTER_IMAGE_DIGEST is required');
  const decision = await snapshotHeartbeatDecision({
    publicBaseUrl,
    expectedImageDigest,
    refreshMaxAgeSeconds: positiveSeconds(
      process.env.SNAPSHOT_REFRESH_HEARTBEAT_MAX_AGE_SECONDS,
      DEFAULT_REFRESH_MAX_AGE_SECONDS,
      'SNAPSHOT_REFRESH_HEARTBEAT_MAX_AGE_SECONDS',
    ),
    fullMaxAgeSeconds: positiveSeconds(
      process.env.SNAPSHOT_FULL_HEARTBEAT_MAX_AGE_SECONDS,
      DEFAULT_FULL_MAX_AGE_SECONDS,
      'SNAPSHOT_FULL_HEARTBEAT_MAX_AGE_SECONDS',
    ),
    maxCutoffAgeSeconds: positiveSeconds(
      process.env.SNAPSHOT_MAX_CUTOFF_AGE_SECONDS,
      DEFAULT_SNAPSHOT_MAX_CUTOFF_AGE_SECONDS,
      'SNAPSHOT_MAX_CUTOFF_AGE_SECONDS',
    ),
  });
  process.stdout.write(`${JSON.stringify(decision)}\n`);
}
