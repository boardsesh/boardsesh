import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildHealthQuery,
  buildLatestUpdateQuery,
  evaluateOtaHealth,
  OTA_UPDATE_STATUS_EVENT,
  parseHealthCheckArgs,
  runHealthCheck,
  safeSanitizeUpdateId,
  sanitizeUpdateId,
  summarizeVerdict,
  type HealthCheckArgs,
  type HealthMetrics,
} from '../mobile-ota-health-check';
import { OTA_UPDATE_STATUS_EVENT as MOBILE_OTA_UPDATE_STATUS_EVENT } from '../../packages/mobile/src/lib/ota-telemetry';

describe('event-name parity with the mobile telemetry source of truth', () => {
  it('queries the exact event the app fires', () => {
    expect(OTA_UPDATE_STATUS_EVENT).toBe(MOBILE_OTA_UPDATE_STATUS_EVENT);
  });
});

describe('safeSanitizeUpdateId', () => {
  it('passes a valid id through', () => {
    expect(safeSanitizeUpdateId('abc-123')).toBe('abc-123');
  });

  it('returns null for a non-string or malformed value (untrusted PostHog response)', () => {
    expect(safeSanitizeUpdateId(null)).toBeNull();
    expect(safeSanitizeUpdateId(42)).toBeNull();
    expect(safeSanitizeUpdateId("x'; DROP TABLE events; --")).toBeNull();
  });
});

describe('parseHealthCheckArgs', () => {
  it('uses sane defaults with no flags', () => {
    expect(parseHealthCheckArgs([])).toEqual({
      updateId: null,
      hours: 24,
      minSamples: 30,
      threshold: 0.1,
      gate: 'launches',
      outFile: null,
      json: false,
    });
  });

  it('parses space-separated and = flag forms', () => {
    const spaced = parseHealthCheckArgs([
      '--update-id',
      'abc-123',
      '--hours',
      '6',
      '--min-samples',
      '50',
      '--threshold',
      '0.2',
      '--out',
      'x.md',
      '--gate',
      'installs',
      '--json',
    ]);
    expect(spaced).toEqual({
      updateId: 'abc-123',
      hours: 6,
      minSamples: 50,
      threshold: 0.2,
      gate: 'installs',
      outFile: 'x.md',
      json: true,
    });

    const equals = parseHealthCheckArgs([
      '--update-id=abc-123',
      '--hours=6',
      '--threshold=0.2',
      '--out=x.md',
      '--gate=installs',
    ]);
    expect(equals).toMatchObject({ updateId: 'abc-123', hours: 6, threshold: 0.2, outFile: 'x.md', gate: 'installs' });
  });

  it('keeps the launches gate for an unknown --gate value', () => {
    expect(parseHealthCheckArgs(['--gate', 'phones']).gate).toBe('launches');
    expect(parseHealthCheckArgs(['--gate']).gate).toBe('launches');
  });

  it('clamps out-of-range numbers', () => {
    expect(parseHealthCheckArgs(['--hours', '0', '--min-samples', '0', '--threshold', '5'])).toMatchObject({
      hours: 1,
      minSamples: 1,
      threshold: 1,
    });
    expect(parseHealthCheckArgs(['--threshold', '-1'])).toMatchObject({ threshold: 0 });
  });

  it('treats a blank update id as none', () => {
    expect(parseHealthCheckArgs(['--update-id', '   ']).updateId).toBeNull();
  });
});

describe('sanitizeUpdateId', () => {
  it('accepts update-id shapes', () => {
    expect(sanitizeUpdateId('7f3c1e2a-9b8d-4c5e-a1b2-c3d4e5f60718')).toBe('7f3c1e2a-9b8d-4c5e-a1b2-c3d4e5f60718');
    expect(sanitizeUpdateId('abc_123.v2:ios')).toBe('abc_123.v2:ios');
  });

  it('rejects injection attempts', () => {
    expect(() => sanitizeUpdateId("x' OR '1'='1")).toThrow();
    expect(() => sanitizeUpdateId('drop; select')).toThrow();
    expect(() => sanitizeUpdateId('')).toThrow();
  });
});

describe('buildHealthQuery / buildLatestUpdateQuery', () => {
  it('inlines a sanitized update id and the adoption column when given an id', () => {
    const query = buildHealthQuery({ hours: 6, updateId: 'abc-123' });
    expect(query).toContain("properties.updateId = 'abc-123'");
    expect(query).toContain('target_update_installs');
    // Per install: an install is one distinct_id (anonymous-install-id.ts).
    expect(query).toContain('uniqExact(distinct_id) AS installs');
    expect(query).toContain(
      "uniqExactIf(distinct_id, toString(properties.isEmergencyLaunch) = 'true') AS emergency_installs",
    );
    expect(query).toContain("event = 'OTA Update Status'");
    expect(query).toContain("properties.channel = 'production'");
    expect(query).toContain('INTERVAL 6 HOUR');
    // Every launch still on a per-launch id, healthy ones included, tells when
    // the installs gate can take over: emergencies alone read 0 on a healthy week.
    expect(query).toContain("countIf(startsWith(distinct_id, 'ota-launch:')) AS legacy_launches");
    expect(query).not.toMatch(/ota-launch:'\)\s+AND/);
  });

  it('emits a constant 0 adoption column when no id is given', () => {
    expect(buildHealthQuery({ hours: 24, updateId: null })).toContain('0 AS target_update_installs');
  });

  it('refuses to build a query for a malicious update id', () => {
    expect(() => buildHealthQuery({ hours: 6, updateId: "x'; DROP TABLE events; --" })).toThrow();
  });

  it('scopes the latest-update lookup to production OTA launches', () => {
    const query = buildLatestUpdateQuery(6);
    expect(query).toContain("properties.channel = 'production'");
    expect(query).toContain("toString(properties.isEmbeddedLaunch) = 'false'");
    expect(query).toContain('ORDER BY last_seen DESC');
    expect(query).toContain('LIMIT 1');
  });
});

describe('evaluateOtaHealth', () => {
  const installs = { minSamples: 30, threshold: 0.1, gate: 'installs' } as const;
  const launches = { minSamples: 30, threshold: 0.1, gate: 'launches' } as const;
  const metrics = (installCount: number, emergencyInstalls: number): HealthMetrics => ({
    installs: installCount,
    emergencyInstalls,
    launches: installCount * 3,
    emergencyLaunches: emergencyInstalls * 5,
    legacyLaunches: 0,
    targetUpdateInstalls: null,
    updateId: null,
  });

  it('gates on launches by default: emergency launches / launches', () => {
    const verdict = evaluateOtaHealth(
      {
        installs: 100,
        emergencyInstalls: 1,
        launches: 140,
        emergencyLaunches: 40,
        legacyLaunches: 0,
        targetUpdateInstalls: null,
        updateId: null,
      },
      launches,
    );
    expect(verdict.gate).toBe('launches');
    expect(verdict.emergencyRate).toBeCloseTo(40 / 140);
    expect(verdict.unhealthy).toBe(true);
  });

  it('with --gate installs, rates installs: one install crash-looping is one emergency', () => {
    const verdict = evaluateOtaHealth(
      {
        installs: 100,
        emergencyInstalls: 1,
        launches: 140,
        emergencyLaunches: 40,
        legacyLaunches: 0,
        targetUpdateInstalls: null,
        updateId: null,
      },
      installs,
    );
    expect(verdict.emergencyRate).toBeCloseTo(0.01);
    expect(verdict.unhealthy).toBe(false);
  });

  // The fleet today: healthy launches on OTA'd JS dedupe to one `ota-install:`
  // id per phone, while emergencies run the embedded JS of an older store
  // binary and send a new `ota-launch:` id per launch, each its own "install".
  const mixedFleet: HealthMetrics = {
    // 100 phones x 4 healthy launches on `ota-install:`, plus 12 emergency
    // launches on 12 `ota-launch:` ids.
    installs: 100 + 12,
    emergencyInstalls: 12,
    launches: 400 + 12,
    emergencyLaunches: 12,
    legacyLaunches: 12,
    targetUpdateInstalls: null,
    updateId: null,
  };

  it('does not trip on a mixed ota-launch / ota-install fleet under the launches gate', () => {
    const verdict = evaluateOtaHealth(mixedFleet, launches);
    expect(verdict.emergencyRate).toBeCloseTo(12 / 412);
    expect(verdict).toMatchObject({ unhealthy: false, exitCode: 0 });
  });

  it('would trip on the same fleet under the installs gate, which is why it is not the default yet', () => {
    const verdict = evaluateOtaHealth(mixedFleet, installs);
    expect(verdict.emergencyRate).toBeCloseTo(12 / 112);
    expect(verdict).toMatchObject({ unhealthy: true, exitCode: 1 });
  });

  it('needs enough of the gated unit, however many of the other there are', () => {
    const fewInstalls: HealthMetrics = {
      installs: 10,
      emergencyInstalls: 8,
      launches: 400,
      emergencyLaunches: 300,
      legacyLaunches: 0,
      targetUpdateInstalls: null,
      updateId: null,
    };
    expect(evaluateOtaHealth(fewInstalls, installs)).toMatchObject({ sufficientSample: false, unhealthy: false });
    expect(evaluateOtaHealth({ ...fewInstalls, launches: 20, emergencyLaunches: 15 }, launches)).toMatchObject({
      sufficientSample: false,
      unhealthy: false,
    });
  });

  it('flags unhealthy only when rate beats threshold AND sample is sufficient', () => {
    const verdict = evaluateOtaHealth(metrics(100, 20), installs);
    expect(verdict).toMatchObject({ unhealthy: true, sufficientSample: true, exitCode: 1 });
    expect(verdict.emergencyRate).toBeCloseTo(0.2);
  });

  it('does NOT flag a high rate on a tiny sample', () => {
    const verdict = evaluateOtaHealth(metrics(10, 8), installs);
    expect(verdict).toMatchObject({ unhealthy: false, sufficientSample: false, exitCode: 0 });
  });

  it('does NOT flag a healthy fleet with plenty of data', () => {
    expect(evaluateOtaHealth(metrics(500, 5), installs)).toMatchObject({ unhealthy: false, exitCode: 0 });
    expect(evaluateOtaHealth(metrics(500, 5), launches)).toMatchObject({ unhealthy: false, exitCode: 0 });
  });

  it('does NOT trip exactly at the threshold (strict greater-than)', () => {
    expect(evaluateOtaHealth(metrics(100, 10), installs)).toMatchObject({ unhealthy: false });
  });

  it('treats zero reports as a 0 rate (no divide-by-zero)', () => {
    for (const options of [installs, launches]) {
      expect(evaluateOtaHealth(metrics(0, 0), options)).toMatchObject({
        emergencyRate: 0,
        unhealthy: false,
        exitCode: 0,
      });
    }
  });
});

describe('summarizeVerdict', () => {
  const args = parseHealthCheckArgs(['--hours', '6']);
  const evaluate = (metrics: HealthMetrics, gateArgs: HealthCheckArgs = args) =>
    evaluateOtaHealth(metrics, { minSamples: gateArgs.minSamples, threshold: gateArgs.threshold, gate: gateArgs.gate });

  it('renders an unhealthy verdict with the gate, both rates, the legacy count and the adoption line', () => {
    const metrics: HealthMetrics = {
      installs: 100,
      emergencyInstalls: 20,
      launches: 150,
      emergencyLaunches: 35,
      legacyLaunches: 30,
      targetUpdateInstalls: 60,
      updateId: 'abc-123',
    };
    const lines = summarizeVerdict(metrics, evaluate(metrics), args);
    const text = lines.join('\n');
    expect(lines[0]).toContain('UNHEALTHY');
    expect(text).toContain('gate: launches, rate 23.3%');
    expect(text).toContain('launches: 150, emergency launches: 35');
    expect(text).toContain('installs: 100, with an emergency launch: 20 → 20.0%');
    expect(text).toContain('legacy launches (per-launch id, pre-change JS; healthy and emergency): 30');
    expect(text).toContain('abc-123');
    expect(text).toContain('60 install(s)');
  });

  it('reports legacy launches on a healthy fleet, so zero emergencies never reads as "switch now"', () => {
    // A week with no emergency at all, on a fleet where old binaries still
    // run their embedded pre-change JS on some launches.
    const healthyOldFleet: HealthMetrics = {
      installs: 200,
      emergencyInstalls: 0,
      launches: 900,
      emergencyLaunches: 0,
      legacyLaunches: 140,
      targetUpdateInstalls: null,
      updateId: null,
    };
    const text = summarizeVerdict(healthyOldFleet, evaluate(healthyOldFleet), args).join('\n');
    expect(text).toContain('healthy');
    expect(text).toContain('legacy launches (per-launch id, pre-change JS; healthy and emergency): 140');
  });

  it('names the installs gate when it is chosen', () => {
    const installArgs = parseHealthCheckArgs(['--gate', 'installs']);
    const metrics: HealthMetrics = {
      installs: 100,
      emergencyInstalls: 2,
      launches: 300,
      emergencyLaunches: 9,
      legacyLaunches: 0,
      targetUpdateInstalls: null,
      updateId: null,
    };
    expect(summarizeVerdict(metrics, evaluate(metrics, installArgs), installArgs).join('\n')).toContain(
      'gate: installs, rate 2.0%',
    );
  });

  it('marks a low-sample result inconclusive and omits the adoption line without an id', () => {
    const metrics: HealthMetrics = {
      installs: 4,
      emergencyInstalls: 2,
      launches: 9,
      emergencyLaunches: 6,
      legacyLaunches: 6,
      targetUpdateInstalls: null,
      updateId: null,
    };
    const text = summarizeVerdict(metrics, evaluate(metrics), args).join('\n');
    expect(text).toContain('inconclusive (too few launches)');
    expect(text).not.toContain('running it');
  });
});

describe('runHealthCheck (networked path)', () => {
  const tmpDirs: string[] = [];
  const baseArgs = (overrides: Partial<HealthCheckArgs> = {}): HealthCheckArgs => ({
    updateId: 'abc-123', // pin the id so only the single health query runs (no latest-update lookup)
    hours: 6,
    minSamples: 30,
    threshold: 0.1,
    gate: 'launches',
    outFile: null,
    json: false,
    ...overrides,
  });
  const outPath = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'ota-health-'));
    tmpDirs.push(dir);
    return join(dir, 'health.md');
  };

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    while (tmpDirs.length > 0) rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
  });

  it('skips (exit 0) and writes nothing when the API key is absent', async () => {
    vi.stubEnv('POSTHOG_PERSONAL_API_KEY', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const out = outPath();

    await expect(runHealthCheck(baseArgs({ outFile: out }))).resolves.toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(() => readFileSync(out)).toThrow(); // no summary written
  });

  it('exits 1 and writes an UNHEALTHY summary when the emergency rate clears the gate', async () => {
    vi.stubEnv('POSTHOG_PERSONAL_API_KEY', 'phx_test');
    // [installs, emergency_installs, launches, emergency_launches, target_update_installs, legacy_launches]
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ results: [[100, 20, 180, 45, 60, 40]] }) })),
    );
    const out = outPath();

    await expect(runHealthCheck(baseArgs({ outFile: out }))).resolves.toBe(1);
    expect(readFileSync(out, 'utf8')).toContain('UNHEALTHY');
  });

  it('exits 0 when the fleet is healthy', async () => {
    vi.stubEnv('POSTHOG_PERSONAL_API_KEY', 'phx_test');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ results: [[500, 5, 900, 12, 300, 12]] }) })),
    );
    await expect(runHealthCheck(baseArgs())).resolves.toBe(0);
  });

  it('gates per install with --gate installs', async () => {
    vi.stubEnv('POSTHOG_PERSONAL_API_KEY', 'phx_test');
    // 3% of launches but 12% of installs had an emergency.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ results: [[100, 12, 400, 12, 50, 0]] }) })),
    );
    await expect(runHealthCheck(baseArgs())).resolves.toBe(0);
    await expect(runHealthCheck(baseArgs({ gate: 'installs' }))).resolves.toBe(1);
  });

  it('exits 0 (operational error never reads as unhealthy) when PostHog returns an error', async () => {
    vi.stubEnv('POSTHOG_PERSONAL_API_KEY', 'phx_test');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, text: async () => 'boom' })),
    );
    await expect(runHealthCheck(baseArgs())).resolves.toBe(0);
  });
});
