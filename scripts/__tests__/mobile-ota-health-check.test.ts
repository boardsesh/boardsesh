import { describe, expect, it } from 'vitest';
import {
  buildHealthQuery,
  buildLatestUpdateQuery,
  evaluateOtaHealth,
  parseHealthCheckArgs,
  sanitizeUpdateId,
  summarizeVerdict,
  type HealthMetrics,
} from '../mobile-ota-health-check';

describe('parseHealthCheckArgs', () => {
  it('uses sane defaults with no flags', () => {
    expect(parseHealthCheckArgs([])).toEqual({
      updateId: null,
      hours: 24,
      minSamples: 30,
      threshold: 0.1,
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
      '--json',
    ]);
    expect(spaced).toEqual({
      updateId: 'abc-123',
      hours: 6,
      minSamples: 50,
      threshold: 0.2,
      outFile: 'x.md',
      json: true,
    });

    const equals = parseHealthCheckArgs(['--update-id=abc-123', '--hours=6', '--threshold=0.2', '--out=x.md']);
    expect(equals).toMatchObject({ updateId: 'abc-123', hours: 6, threshold: 0.2, outFile: 'x.md' });
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
    expect(query).toContain("event = 'OTA Update Status'");
    expect(query).toContain("properties.channel = 'production'");
    expect(query).toContain('INTERVAL 6 HOUR');
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
  const metrics = (launches: number, emergencyLaunches: number): HealthMetrics => ({
    launches,
    emergencyLaunches,
    installs: launches,
    emergencyInstalls: emergencyLaunches,
    targetUpdateInstalls: null,
    updateId: null,
  });

  it('flags unhealthy only when rate beats threshold AND sample is sufficient', () => {
    const verdict = evaluateOtaHealth(metrics(100, 20), { minSamples: 30, threshold: 0.1 });
    expect(verdict).toMatchObject({ unhealthy: true, sufficientSample: true, exitCode: 1 });
    expect(verdict.emergencyRate).toBeCloseTo(0.2);
  });

  it('does NOT flag a high rate on a tiny sample', () => {
    const verdict = evaluateOtaHealth(metrics(10, 8), { minSamples: 30, threshold: 0.1 });
    expect(verdict).toMatchObject({ unhealthy: false, sufficientSample: false, exitCode: 0 });
  });

  it('does NOT flag a healthy fleet with plenty of data', () => {
    const verdict = evaluateOtaHealth(metrics(500, 5), { minSamples: 30, threshold: 0.1 });
    expect(verdict).toMatchObject({ unhealthy: false, sufficientSample: true, exitCode: 0 });
  });

  it('does NOT trip exactly at the threshold (strict greater-than)', () => {
    expect(evaluateOtaHealth(metrics(100, 10), { minSamples: 30, threshold: 0.1 })).toMatchObject({ unhealthy: false });
  });

  it('treats zero launches as a 0 rate (no divide-by-zero)', () => {
    expect(evaluateOtaHealth(metrics(0, 0), { minSamples: 30, threshold: 0.1 })).toMatchObject({
      emergencyRate: 0,
      unhealthy: false,
      exitCode: 0,
    });
  });
});

describe('summarizeVerdict', () => {
  const args = parseHealthCheckArgs(['--hours', '6']);

  it('renders an unhealthy verdict with the adoption line', () => {
    const metrics: HealthMetrics = {
      launches: 100,
      emergencyLaunches: 20,
      installs: 80,
      emergencyInstalls: 18,
      targetUpdateInstalls: 60,
      updateId: 'abc-123',
    };
    const verdict = evaluateOtaHealth(metrics, { minSamples: args.minSamples, threshold: args.threshold });
    const lines = summarizeVerdict(metrics, verdict, args);
    expect(lines[0]).toContain('UNHEALTHY');
    expect(lines.join('\n')).toContain('abc-123');
    expect(lines.join('\n')).toContain('60 install(s)');
  });

  it('marks a low-sample result inconclusive and omits the adoption line without an id', () => {
    const metrics: HealthMetrics = {
      launches: 4,
      emergencyLaunches: 2,
      installs: 4,
      emergencyInstalls: 2,
      targetUpdateInstalls: null,
      updateId: null,
    };
    const verdict = evaluateOtaHealth(metrics, { minSamples: args.minSamples, threshold: args.threshold });
    const text = summarizeVerdict(metrics, verdict, args).join('\n');
    expect(text).toContain('inconclusive');
    expect(text).not.toContain('running it');
  });
});
