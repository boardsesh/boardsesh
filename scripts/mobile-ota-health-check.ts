/// <reference types="node" />

/**
 * Post-publish health gate for production self-hosted OTA updates.
 *
 * Production OTAs publish to our self-hosted expo-open-ota server (NOT EAS), so
 * `eas update:insights` can't see them. Instead we read the app's own launch
 * telemetry: `OtaUpdateTracker` (packages/mobile/src/components/analytics/
 * OtaUpdateTracker.tsx) fires an `OTA Update Status` event to PostHog once per
 * launch with `{ isEmbeddedLaunch, isEmergencyLaunch, emergencyLaunchReason,
 * updateId, channel, runtimeVersion, ... }`.
 *
 * An `isEmergencyLaunch === true` launch is expo-updates' automatic safety net:
 * the downloaded JS failed to boot, so the binary fell back to its EMBEDDED
 * bundle. A spike in the emergency-launch RATE across the production fleet after
 * a publish is the tell-tale of a broken OTA. (Note: an emergency launch runs the
 * embedded bundle, so its `updateId` is the embedded one — you CANNOT attribute
 * the failure to the bad update's id. That's why the gate measures the
 * fleet-wide production emergency rate over a window, not a per-updateId rate.
 * The target update's adoption is reported separately, for context only.)
 *
 * Exit code is non-zero ONLY when the emergency-launch rate exceeds the threshold
 * AND the sample size is sufficient — so low-volume noise (the minutes right after
 * a publish, before installs relaunch) never trips it. Every other outcome
 * (healthy / insufficient sample / missing key / API error) exits 0, so the CI
 * step stays non-blocking.
 *
 * Usage:
 *   tsx scripts/mobile-ota-health-check.ts                      # latest production update, last 24h
 *   tsx scripts/mobile-ota-health-check.ts --update-id <id>     # adoption context for a specific update
 *   tsx scripts/mobile-ota-health-check.ts --hours 6 --min-samples 50 --threshold 0.1
 *   tsx scripts/mobile-ota-health-check.ts --out health.md      # also write a Discord-ready summary
 *
 * Env (read at run time, defaults match scripts/refresh-recommendations.ts):
 *   POSTHOG_PERSONAL_API_KEY  required — without it the check is SKIPPED (exit 0).
 *   POSTHOG_PROJECT_ID        optional — defaults to 412845 (not a secret).
 *   POSTHOG_HOST              optional — defaults to https://us.posthog.com.
 *
 * See docs/mobile-ota-updates.md ("Health monitoring & rollback").
 */

import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Source of truth for the literal is packages/mobile/src/lib/ota-telemetry.ts
// (OTA_UPDATE_STATUS_EVENT), guarded by that package's unit tests. Mirrored here
// rather than imported so this root script never pulls a mobile module graph.
const OTA_UPDATE_STATUS_EVENT = 'OTA Update Status';
const PRODUCTION_CHANNEL = 'production';

const DEFAULT_HOURS = 24;
const DEFAULT_MIN_SAMPLES = 30;
const DEFAULT_THRESHOLD = 0.1; // 10% of production launches falling back to embedded

export interface HealthCheckArgs {
  updateId: string | null;
  hours: number;
  minSamples: number;
  threshold: number;
  outFile: string | null;
  json: boolean;
}

export interface HealthMetrics {
  launches: number;
  emergencyLaunches: number;
  installs: number;
  emergencyInstalls: number;
  /** Distinct installs running the target update id (isEmbeddedLaunch false). null when no id resolved. */
  targetUpdateInstalls: number | null;
  updateId: string | null;
}

export interface HealthVerdict {
  emergencyRate: number;
  sufficientSample: boolean;
  unhealthy: boolean;
  exitCode: 0 | 1;
}

/** Parse CLI flags only. Env is read in `main` so this stays pure + testable. */
export function parseHealthCheckArgs(argv: string[]): HealthCheckArgs {
  let updateId: string | null = null;
  let hours = DEFAULT_HOURS;
  let minSamples = DEFAULT_MIN_SAMPLES;
  let threshold = DEFAULT_THRESHOLD;
  let outFile: string | null = null;
  let json = false;

  const readNumber = (raw: string | undefined, fallback: number): number => {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--') continue;

    if (argument === '--update-id' || argument === '-u') {
      updateId = argv[++index] ?? null;
    } else if (argument.startsWith('--update-id=')) {
      updateId = argument.slice('--update-id='.length);
    } else if (argument === '--hours') {
      hours = readNumber(argv[++index], DEFAULT_HOURS);
    } else if (argument.startsWith('--hours=')) {
      hours = readNumber(argument.slice('--hours='.length), DEFAULT_HOURS);
    } else if (argument === '--min-samples') {
      minSamples = readNumber(argv[++index], DEFAULT_MIN_SAMPLES);
    } else if (argument.startsWith('--min-samples=')) {
      minSamples = readNumber(argument.slice('--min-samples='.length), DEFAULT_MIN_SAMPLES);
    } else if (argument === '--threshold') {
      threshold = readNumber(argv[++index], DEFAULT_THRESHOLD);
    } else if (argument.startsWith('--threshold=')) {
      threshold = readNumber(argument.slice('--threshold='.length), DEFAULT_THRESHOLD);
    } else if (argument === '--out') {
      outFile = argv[++index] ?? null;
    } else if (argument.startsWith('--out=')) {
      outFile = argument.slice('--out='.length);
    } else if (argument === '--json') {
      json = true;
    }
  }

  // Clamp to sane bounds so a bad flag can't widen the window or invert the gate.
  hours = Math.max(1, Math.floor(hours));
  minSamples = Math.max(1, Math.floor(minSamples));
  threshold = Math.min(1, Math.max(0, threshold));

  return { updateId: updateId?.trim() || null, hours, minSamples, threshold, outFile, json };
}

/**
 * Reject anything that isn't an expo update id shape before it reaches HogQL.
 * Update ids are uuids / base64url-ish; this whitelist forecloses SQL injection
 * via an attacker-controlled `--update-id`.
 */
export function sanitizeUpdateId(raw: string): string {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(raw)) {
    throw new Error(`Invalid --update-id "${raw}" (allowed: A–Z a–z 0–9 . _ : -, max 128 chars).`);
  }
  return raw;
}

/** Most-recently-seen production updateId actually running on installs (OTA, not embedded). */
export function buildLatestUpdateQuery(hours: number): string {
  return `
    SELECT properties.updateId AS update_id, max(timestamp) AS last_seen, count() AS launches
    FROM events
    WHERE event = '${OTA_UPDATE_STATUS_EVENT}'
      AND properties.channel = '${PRODUCTION_CHANNEL}'
      AND toString(properties.isEmbeddedLaunch) = 'false'
      AND properties.updateId IS NOT NULL
      AND properties.updateId != ''
      AND timestamp > now() - INTERVAL ${Math.floor(hours)} HOUR
    GROUP BY update_id
    ORDER BY last_seen DESC
    LIMIT 1
  `;
}

/**
 * Fleet health over the window: total production launches, how many fell back to
 * the embedded bundle (emergency), and — when a target id is known — how many
 * distinct installs are successfully running it.
 */
export function buildHealthQuery(options: { hours: number; updateId: string | null }): string {
  const { hours, updateId } = options;
  const targetInstalls =
    updateId !== null
      ? `count(DISTINCT if(properties.updateId = '${sanitizeUpdateId(updateId)}' AND toString(properties.isEmbeddedLaunch) = 'false', person_id, NULL))`
      : '0';
  return `
    SELECT
      count() AS launches,
      countIf(toString(properties.isEmergencyLaunch) = 'true') AS emergency_launches,
      count(DISTINCT person_id) AS installs,
      count(DISTINCT if(toString(properties.isEmergencyLaunch) = 'true', person_id, NULL)) AS emergency_installs,
      ${targetInstalls} AS target_update_installs
    FROM events
    WHERE event = '${OTA_UPDATE_STATUS_EVENT}'
      AND properties.channel = '${PRODUCTION_CHANNEL}'
      AND timestamp > now() - INTERVAL ${Math.floor(hours)} HOUR
  `;
}

/** The gate: unhealthy iff the emergency-launch rate beats the threshold AND there's enough data. */
export function evaluateOtaHealth(
  metrics: HealthMetrics,
  options: { minSamples: number; threshold: number },
): HealthVerdict {
  const emergencyRate = metrics.launches > 0 ? metrics.emergencyLaunches / metrics.launches : 0;
  const sufficientSample = metrics.launches >= options.minSamples;
  const unhealthy = sufficientSample && emergencyRate > options.threshold;
  return { emergencyRate, sufficientSample, unhealthy, exitCode: unhealthy ? 1 : 0 };
}

const formatPercent = (rate: number): string => `${(rate * 100).toFixed(1)}%`;

/** Human-readable verdict lines (also reused as the Discord summary body). */
export function summarizeVerdict(metrics: HealthMetrics, verdict: HealthVerdict, args: HealthCheckArgs): string[] {
  const status = verdict.unhealthy
    ? '🚨 UNHEALTHY'
    : verdict.sufficientSample
      ? '✅ healthy'
      : '➖ inconclusive (too few launches)';
  const lines = [
    `OTA health: ${status}`,
    `• window: last ${args.hours}h • channel: ${PRODUCTION_CHANNEL}`,
    `• launches: ${metrics.launches} (from ${metrics.installs} installs)`,
    `• emergency launches: ${metrics.emergencyLaunches} → rate ${formatPercent(verdict.emergencyRate)} (threshold ${formatPercent(args.threshold)}, min ${args.minSamples})`,
  ];
  if (metrics.updateId) {
    const adoption = metrics.targetUpdateInstalls ?? 0;
    lines.push(`• latest update ${metrics.updateId}: ${adoption} install(s) running it`);
  }
  return lines;
}

interface PostHogQueryResponse {
  results?: unknown[][];
}

async function queryPostHog(host: string, projectId: string, apiKey: string, hogql: string): Promise<unknown[][]> {
  const response = await fetch(`${host}/api/projects/${projectId}/query/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query: hogql } }),
  });
  if (!response.ok) {
    throw new Error(`PostHog query failed (${response.status}): ${await response.text()}`);
  }
  const payload = (await response.json()) as PostHogQueryResponse;
  return payload.results ?? [];
}

const toCount = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

export async function runHealthCheck(args: HealthCheckArgs): Promise<number> {
  const apiKey = process.env.POSTHOG_PERSONAL_API_KEY;
  // `||` (not `??`) so an empty CI var — `vars.X` resolves to '' when unset —
  // falls back to the default instead of producing a broken project id / host.
  const projectId = process.env.POSTHOG_PROJECT_ID || '412845';
  const host = process.env.POSTHOG_HOST || 'https://us.posthog.com';

  if (!apiKey) {
    console.log('[ota-health] POSTHOG_PERSONAL_API_KEY not set — skipping health check (non-blocking, exit 0).');
    console.log('[ota-health] Add the secret to activate the gate. See docs/mobile-ota-updates.md.');
    return 0;
  }

  try {
    // Resolve the target update id: explicit flag, else the freshest production
    // OTA actually seen on installs. Used only for the adoption context line.
    let updateId = args.updateId ? sanitizeUpdateId(args.updateId) : null;
    if (!updateId) {
      const latest = await queryPostHog(host, projectId, apiKey, buildLatestUpdateQuery(args.hours));
      const row = latest[0];
      updateId = row && typeof row[0] === 'string' ? row[0] : null;
    }

    const rows = await queryPostHog(host, projectId, apiKey, buildHealthQuery({ hours: args.hours, updateId }));
    const row = rows[0] ?? [];
    const metrics: HealthMetrics = {
      launches: toCount(row[0]),
      emergencyLaunches: toCount(row[1]),
      installs: toCount(row[2]),
      emergencyInstalls: toCount(row[3]),
      targetUpdateInstalls: updateId ? toCount(row[4]) : null,
      updateId,
    };

    const verdict = evaluateOtaHealth(metrics, { minSamples: args.minSamples, threshold: args.threshold });
    const lines = summarizeVerdict(metrics, verdict, args);

    if (args.json) {
      console.log(JSON.stringify({ metrics, verdict }, null, 2));
    } else {
      for (const line of lines) console.log(`[ota-health] ${line}`);
    }

    if (args.outFile) {
      writeFileSync(args.outFile, `${lines.join('\n')}\n`);
    }

    if (verdict.unhealthy) {
      console.error(
        `[ota-health] FAILED — emergency-launch rate ${formatPercent(verdict.emergencyRate)} over ${metrics.launches} launches exceeds the ${formatPercent(args.threshold)} threshold.`,
      );
    }
    return verdict.exitCode;
  } catch (error) {
    // Operational failures (network, auth, parse) must NOT read as "unhealthy" —
    // the gate is reserved for a real emergency-launch spike. Warn loudly, exit 0.
    console.error(`[ota-health] WARNING — could not evaluate OTA health: ${(error as Error).message}`);
    return 0;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runHealthCheck(parseHealthCheckArgs(process.argv.slice(2)))
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`[ota-health] WARNING — unexpected error: ${(error as Error).message}`);
      process.exit(0);
    });
}
