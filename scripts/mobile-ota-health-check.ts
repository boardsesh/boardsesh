/// <reference types="node" />

/**
 * Post-publish health gate for production self-hosted OTA updates.
 *
 * Production OTAs publish to our self-hosted expo-open-ota server (NOT EAS), so
 * `eas update:insights` can't see them. Instead we read the app's own launch
 * telemetry: `OtaUpdateTracker` (packages/mobile/src/components/analytics/
 * OtaUpdateTracker.tsx) fires an anonymous `OTA Update Status` event to PostHog
 * once per launch with `{ isEmbeddedLaunch, isEmergencyLaunch, updateId,
 * channel, runtimeVersion, ... }`.
 *
 * An `isEmergencyLaunch === true` launch is expo-updates' automatic safety net:
 * the downloaded JS failed to boot, so the binary fell back to its EMBEDDED
 * bundle. A spike in the production emergency rate after a publish is the
 * tell-tale of a broken OTA. (Note: an emergency launch runs the embedded
 * bundle, so its `updateId` is the embedded one — you CANNOT attribute the
 * failure to the bad update's id. That's why the gate measures the fleet-wide
 * production emergency rate over a window, not a per-updateId rate. The target
 * update's adoption is reported separately, for context only.)
 *
 * Two ways to count, chosen with `--gate`:
 *
 * - `launches` (the default): emergency launches / launches. Every event is one
 *   launch whichever id it carries, so this rate means the same before and
 *   after the per-install id.
 * - `installs`: installs with at least one emergency launch / installs that
 *   reported, so one phone crash-looping counts once. The event's distinct id
 *   is one random id per install (`ota-install:<uuid>`,
 *   packages/mobile/src/lib/anonymous-install-id.ts) — but only in JS from the
 *   October 2026 change on. An emergency launch runs the EMBEDDED JS, and every
 *   store binary built before that change still sends a new `ota-launch:<uuid>`
 *   per launch from it. Until those binaries are gone, each emergency launch
 *   counts as an install of its own while healthy launches dedupe per install,
 *   so this rate reads several times high and a normal day trips the gate.
 *
 * Switch to `--gate installs` on binary adoption evidence only: App Store
 * Connect and the Play Console show at least 95% of active installs on a store
 * build whose EMBEDDED JS carries the per-install id (the first store release
 * cut after the October 2026 change; its version goes in the docs). The
 * `legacy launches` line (every launch still on `ota-launch:`) is context, not
 * evidence: an old binary that already runs the new OTA sends `ota-install:`
 * on every healthy launch, so the line can read 0 for weeks while such
 * binaries remain, and their next emergency launch still falls back to the
 * per-launch id. The date of the switch goes in docs/mobile-ota-updates.md
 * ("The health check").
 *
 * Exit code is non-zero ONLY when the gated rate exceeds the threshold AND the
 * gated denominator reached `--min-samples` — so low-volume noise (the minutes
 * right after a publish, before installs relaunch) never trips it. Every other
 * outcome (healthy / insufficient sample / missing key / API error) exits 0, so
 * the CI step stays non-blocking.
 *
 * Usage:
 *   tsx scripts/mobile-ota-health-check.ts                      # latest production update, last 24h
 *   tsx scripts/mobile-ota-health-check.ts --update-id <id>     # adoption context for a specific update
 *   tsx scripts/mobile-ota-health-check.ts --hours 6 --min-samples 50 --threshold 0.1
 *   tsx scripts/mobile-ota-health-check.ts --out health.md      # also write a Discord-ready summary
 *   tsx scripts/mobile-ota-health-check.ts --gate installs      # gate per install (see above for when)
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
// (OTA_UPDATE_STATUS_EVENT), mirrored here rather than imported so this root
// script never pulls a mobile module graph. Exported so a unit test can assert it
// stays equal to the mobile constant — a drift would silently query the wrong
// event and report a healthy fleet.
export const OTA_UPDATE_STATUS_EVENT = 'OTA Update Status';
const PRODUCTION_CHANNEL = 'production';

const DEFAULT_HOURS = 24;
const DEFAULT_MIN_SAMPLES = 30;
const DEFAULT_THRESHOLD = 0.1; // 10% of production launches (or installs) falling back to embedded

/** What the gate divides: see the header for why `launches` is the default for now. */
export type GateMode = 'launches' | 'installs';
const DEFAULT_GATE: GateMode = 'launches';

export interface HealthCheckArgs {
  updateId: string | null;
  hours: number;
  minSamples: number;
  threshold: number;
  gate: GateMode;
  outFile: string | null;
  json: boolean;
}

export interface HealthMetrics {
  /** Distinct installs that reported a launch in the window: the `installs` gate's denominator. */
  installs: number;
  /** Distinct installs with at least one emergency launch in the window. */
  emergencyInstalls: number;
  /** Launch counts: the `launches` gate's numerator and denominator. */
  launches: number;
  emergencyLaunches: number;
  /** Launches, healthy or emergency, still sent under a per-launch id (`ota-launch:`): pre-change JS. */
  legacyLaunches: number;
  /** Installs running the target update id (isEmbeddedLaunch false). null when no id resolved. */
  targetUpdateInstalls: number | null;
  updateId: string | null;
}

export interface HealthVerdict {
  gate: GateMode;
  /** The gated rate: emergency launches / launches, or emergency installs / installs. */
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
  let gate: GateMode = DEFAULT_GATE;
  let outFile: string | null = null;
  let json = false;

  const readNumber = (raw: string | undefined, fallback: number): number => {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  // An unknown value keeps the default rather than silently gating per install.
  const readGate = (raw: string | undefined): GateMode =>
    raw === 'installs' || raw === 'launches' ? raw : DEFAULT_GATE;

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
    } else if (argument === '--gate') {
      gate = readGate(argv[++index]);
    } else if (argument.startsWith('--gate=')) {
      gate = readGate(argument.slice('--gate='.length));
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

  return { updateId: updateId?.trim() || null, hours, minSamples, threshold, gate, outFile, json };
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

/** Sanitize an update id from an untrusted source (the PostHog response); null if it doesn't fit the shape. */
export function safeSanitizeUpdateId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  try {
    return sanitizeUpdateId(raw);
  } catch {
    return null;
  }
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
 * Fleet health over the window: launches and emergency launches, the same per
 * install (distinct `distinct_id`), launches still on a per-launch id, and —
 * when a target id is known — installs running it.
 */
export function buildHealthQuery(options: { hours: number; updateId: string | null }): string {
  const { hours, updateId } = options;
  const targetInstalls =
    updateId !== null
      ? `uniqExactIf(distinct_id, properties.updateId = '${sanitizeUpdateId(updateId)}' AND toString(properties.isEmbeddedLaunch) = 'false')`
      : '0';
  return `
    SELECT
      uniqExact(distinct_id) AS installs,
      uniqExactIf(distinct_id, toString(properties.isEmergencyLaunch) = 'true') AS emergency_installs,
      count() AS launches,
      countIf(toString(properties.isEmergencyLaunch) = 'true') AS emergency_launches,
      ${targetInstalls} AS target_update_installs,
      countIf(startsWith(distinct_id, 'ota-launch:')) AS legacy_launches
    FROM events
    WHERE event = '${OTA_UPDATE_STATUS_EVENT}'
      AND properties.channel = '${PRODUCTION_CHANNEL}'
      AND timestamp > now() - INTERVAL ${Math.floor(hours)} HOUR
  `;
}

/**
 * The gate: unhealthy iff the gated emergency rate beats the threshold AND the
 * gated denominator (launches or installs) reached `minSamples`.
 */
export function evaluateOtaHealth(
  metrics: HealthMetrics,
  options: { minSamples: number; threshold: number; gate: GateMode },
): HealthVerdict {
  const [emergencies, denominator] =
    options.gate === 'installs'
      ? [metrics.emergencyInstalls, metrics.installs]
      : [metrics.emergencyLaunches, metrics.launches];
  const emergencyRate = denominator > 0 ? emergencies / denominator : 0;
  const sufficientSample = denominator >= options.minSamples;
  const unhealthy = sufficientSample && emergencyRate > options.threshold;
  return { gate: options.gate, emergencyRate, sufficientSample, unhealthy, exitCode: unhealthy ? 1 : 0 };
}

const formatPercent = (rate: number): string => `${(rate * 100).toFixed(1)}%`;

const rateOf = (part: number, whole: number): number => (whole > 0 ? part / whole : 0);

/** Human-readable verdict lines (also reused as the Discord summary body). */
export function summarizeVerdict(metrics: HealthMetrics, verdict: HealthVerdict, args: HealthCheckArgs): string[] {
  const unit = verdict.gate === 'installs' ? 'installs' : 'launches';
  const status = verdict.unhealthy
    ? '🚨 UNHEALTHY'
    : verdict.sufficientSample
      ? '✅ healthy'
      : `➖ inconclusive (too few ${unit})`;
  const launchLine = `• launches: ${metrics.launches}, emergency launches: ${metrics.emergencyLaunches} → ${formatPercent(rateOf(metrics.emergencyLaunches, metrics.launches))}`;
  const installLine = `• installs: ${metrics.installs}, with an emergency launch: ${metrics.emergencyInstalls} → ${formatPercent(rateOf(metrics.emergencyInstalls, metrics.installs))}`;
  const gateLine = `• gate: ${unit}, rate ${formatPercent(verdict.emergencyRate)} (threshold ${formatPercent(args.threshold)}, min ${args.minSamples} ${unit})`;
  const lines = [
    `OTA health: ${status}`,
    `• window: last ${args.hours}h • channel: ${PRODUCTION_CHANNEL}`,
    gateLine,
    ...(verdict.gate === 'installs' ? [installLine, launchLine] : [launchLine, installLine]),
    `• legacy launches (per-launch id, pre-change JS; healthy and emergency): ${metrics.legacyLaunches}`,
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
      // Sanitize at the point of receipt — don't rely on buildHealthQuery's
      // later sanitize being kept in a refactor.
      updateId = safeSanitizeUpdateId(latest[0]?.[0]);
    }

    const rows = await queryPostHog(host, projectId, apiKey, buildHealthQuery({ hours: args.hours, updateId }));
    const row = rows[0] ?? [];
    const metrics: HealthMetrics = {
      installs: toCount(row[0]),
      emergencyInstalls: toCount(row[1]),
      launches: toCount(row[2]),
      emergencyLaunches: toCount(row[3]),
      legacyLaunches: toCount(row[5]),
      targetUpdateInstalls: updateId ? toCount(row[4]) : null,
      updateId,
    };

    const verdict = evaluateOtaHealth(metrics, {
      minSamples: args.minSamples,
      threshold: args.threshold,
      gate: args.gate,
    });
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
        `[ota-health] FAILED — ${formatPercent(verdict.emergencyRate)} of ${verdict.gate === 'installs' ? `${metrics.installs} installs` : `${metrics.launches} launches`} hit an emergency launch, over the ${formatPercent(args.threshold)} threshold.`,
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
