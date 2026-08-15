import { pathToFileURL } from 'node:url';
import { parseSnapshotManifest } from '@boardsesh/offline-sync';

const LIVE_KEY_PREFIX = 'board-snapshots/v1-gzip';
const DEFAULT_REFRESH_MAX_AGE_SECONDS = 45 * 60;
const DEFAULT_FULL_MAX_AGE_SECONDS = 30 * 60 * 60;
const DEFAULT_MAX_CUTOFF_AGE_SECONDS = 10 * 60;
const MAX_FUTURE_CLOCK_SKEW_SECONDS = 5 * 60;
const HEARTBEAT_FETCH_TIMEOUT_MS = 10_000;

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

function positiveSeconds(raw: string | undefined, fallback: number, name: string): number {
  if (!raw?.trim()) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number of seconds`);
  return parsed;
}

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);
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

export function evaluateSnapshotHeartbeat(params: {
  payload: unknown;
  expectedRunKind: SnapshotRunKind;
  expectedImageDigest: string;
  expectedManifestGeneratedAt: string | null;
  expectedLineage?: SnapshotHeartbeatLineage | null;
  nowMs: number;
  maxAgeSeconds: number;
  maxCutoffAgeSeconds?: number;
}): HeartbeatCheck {
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
      return { stale: true, ageSeconds, reason: 'heartbeat completedAt is too far in the future' };
    }
    if (ageSeconds > params.maxAgeSeconds) {
      return {
        stale: true,
        ageSeconds,
        reason: `heartbeat is older than ${params.maxAgeSeconds}s`,
      };
    }
    const cutoffAgeAtCompletionSeconds = (completedAtMs - stableBeforeMs) / 1000;
    const maxCutoffAgeSeconds = params.maxCutoffAgeSeconds ?? DEFAULT_MAX_CUTOFF_AGE_SECONDS;
    if (cutoffAgeAtCompletionSeconds < 0) {
      return {
        stale: true,
        ageSeconds,
        reason: 'heartbeat stableBefore is later than completedAt',
      };
    }
    if (cutoffAgeAtCompletionSeconds > maxCutoffAgeSeconds) {
      return {
        stale: true,
        ageSeconds,
        reason: `heartbeat cutoff was older than ${maxCutoffAgeSeconds}s at completion`,
      };
    }
    return { stale: false, ageSeconds, reason: 'fresh' };
  } catch (error) {
    return {
      stale: true,
      ageSeconds: null,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
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

function evaluateFetched(params: {
  fetched: FetchedHeartbeat;
  runKind: SnapshotRunKind;
  nowMs: number;
  maxAgeSeconds: number;
  expectedImageDigest: string;
  expectedManifestGeneratedAt: string | null;
  expectedLineage?: SnapshotHeartbeatLineage | null;
  maxCutoffAgeSeconds: number;
}): HeartbeatCheck {
  if (!params.fetched.ok) return { stale: true, ageSeconds: null, reason: params.fetched.reason };
  return evaluateSnapshotHeartbeat({
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
  const publicBaseUrl = params.publicBaseUrl.trim().replace(/\/+$/, '');
  if (!publicBaseUrl) throw new Error('publicBaseUrl is required');
  if (!/^sha256:[0-9a-f]{64}$/.test(params.expectedImageDigest)) {
    throw new Error('expectedImageDigest must be an exact sha256 digest');
  }
  const nowMs = params.nowMs ?? Date.now();
  const cacheBuster = encodeURIComponent(String(nowMs));
  const fetchHeartbeat = params.fetchHeartbeat ?? fetchHeartbeatJson;
  let manifestGeneratedAt: string;
  try {
    const manifestPayload = await fetchHeartbeat(
      `${publicBaseUrl}/${LIVE_KEY_PREFIX}/manifest.json?watchdog=${cacheBuster}`,
    );
    const manifest = parseSnapshotManifest(manifestPayload);
    if (!manifest) throw new Error('live snapshot manifest failed schema validation');
    manifestGeneratedAt = manifest.generatedAt;
  } catch (error) {
    const reason = `live manifest unavailable: ${error instanceof Error ? error.message : String(error)}`;
    const stale = { stale: true, ageSeconds: null, reason };
    return { checkedAt: new Date(nowMs).toISOString(), refresh: stale, full: stale };
  }
  const refreshMaxAgeSeconds = params.refreshMaxAgeSeconds ?? DEFAULT_REFRESH_MAX_AGE_SECONDS;
  const fullMaxAgeSeconds = params.fullMaxAgeSeconds ?? DEFAULT_FULL_MAX_AGE_SECONDS;
  const maxCutoffAgeSeconds = params.maxCutoffAgeSeconds ?? DEFAULT_MAX_CUTOFF_AGE_SECONDS;
  const [refreshFetched, fullFetched] = await Promise.all([
    fetchOne(`${publicBaseUrl}/board-snapshots/ops/refresh.json?watchdog=${cacheBuster}`, fetchHeartbeat),
    fetchOne(`${publicBaseUrl}/board-snapshots/ops/full.json?watchdog=${cacheBuster}`, fetchHeartbeat),
  ]);
  const refreshHeartbeat = evaluateFetched({
    fetched: refreshFetched,
    runKind: 'refresh',
    nowMs,
    maxAgeSeconds: refreshMaxAgeSeconds,
    expectedImageDigest: params.expectedImageDigest,
    expectedManifestGeneratedAt: manifestGeneratedAt,
    maxCutoffAgeSeconds,
  });
  let currentRefreshLineage: SnapshotHeartbeatLineage | null = null;
  if (refreshFetched.ok) {
    try {
      const currentRefresh = parseHeartbeat(
        refreshFetched.payload,
        'refresh',
        params.expectedImageDigest,
        manifestGeneratedAt,
        null,
      );
      currentRefreshLineage = {
        systemIdentifier: currentRefresh.systemIdentifier,
        timelineId: currentRefresh.timelineId,
      };
    } catch {
      // `refreshHeartbeat` carries the actionable validation failure. Without
      // a valid current refresh anchor, an older full heartbeat cannot prove
      // that it belongs to the same PostgreSQL system/timeline.
    }
  }
  const full = currentRefreshLineage
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
      })
    : {
        stale: true,
        ageSeconds: null,
        reason: 'current refresh heartbeat is unavailable for PostgreSQL lineage validation',
      };
  return { checkedAt: new Date(nowMs).toISOString(), refresh: refreshHeartbeat, full };
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
      DEFAULT_MAX_CUTOFF_AGE_SECONDS,
      'SNAPSHOT_MAX_CUTOFF_AGE_SECONDS',
    ),
  });
  process.stdout.write(`${JSON.stringify(decision)}\n`);
}
