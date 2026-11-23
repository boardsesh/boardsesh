// @vitest-environment node

import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vite-plus/test';

type ScenarioResult = {
  scenario: string;
  outcome: string;
  status?: number;
};

type ProxyFixtureResult = {
  stress: { completed: number; aborted: number; gzipCompleted: number; bodyMatches: number };
  scenarios: ScenarioResult[];
  warnings: { count: number; type: string }[];
  defaultLimit: number;
  responseLimits: number[];
  proxyErrors: { scenario: string; code: string }[];
  upstream: {
    requests: number;
    closed: number;
    bodyMismatches: number;
    binaryBodiesVerified: number;
    pathMismatches: number;
    connections: number;
  };
  trackedResponses: number;
  survivingResponses: number;
};

const runFixture = promisify(execFile);
let report: ProxyFixtureResult;

beforeAll(async () => {
  // Separate the instrumented application from the uninstrumented local load
  // driver. Sentry uses a no-op transport; every HTTP endpoint is loopback.
  const { stdout } = await runFixture(
    process.execPath,
    [fileURLToPath(new URL('./fixtures/next-proxy-close.cjs', import.meta.url))],
    {
      env: { ...process.env, NODE_OPTIONS: '', NODE_ENV: 'test' },
      timeout: 30_000,
      maxBuffer: 128 * 1024,
    },
  );
  report = JSON.parse(stdout) as ProxyFixtureResult;
}, 35_000);

describe('installed Next proxy close cleanup', () => {
  it('proxies gzip POST bytes through keepalive without exceeding the default listener budget', () => {
    expect(report.stress).toEqual({ completed: 51, aborted: 13, gzipCompleted: 51, bodyMatches: 51 });
    expect(report.defaultLimit).toBe(10);
    expect(report.responseLimits).toEqual([10]);
    expect(report.warnings).toHaveLength(0);
    expect(report.upstream.bodyMismatches).toBe(0);
    expect(report.upstream.binaryBodiesVerified).toBe(1);
    expect(report.upstream.pathMismatches).toBe(0);
    expect(report.upstream.connections).toBeLessThan(report.upstream.requests);
  });

  it('preserves normal completion, disconnects and upstream error propagation', () => {
    expect(report.scenarios).toEqual([
      { scenario: 'complete', outcome: 'complete', status: 200 },
      { scenario: 'client-preheaders', outcome: 'ECONNRESET' },
      { scenario: 'client-midbody', outcome: 'response-aborted', status: 200 },
      { scenario: 'upstream-preheaders-error', outcome: 'complete', status: 500 },
      { scenario: 'upstream-midbody-error', outcome: 'response-aborted', status: 200 },
      { scenario: 'downstream-error', outcome: 'ECONNRESET' },
    ]);
    expect(report.proxyErrors).toEqual([{ scenario: 'upstream-preheaders-error', code: 'ECONNRESET' }]);
  });

  it('closes every upstream response and releases frontend responses after socket pools drain', () => {
    expect(report.upstream.requests).toBe(70);
    expect(report.upstream.closed).toBe(70);
    expect(report.trackedResponses).toBe(70);
    expect(report.survivingResponses).toBe(0);
  });
});
