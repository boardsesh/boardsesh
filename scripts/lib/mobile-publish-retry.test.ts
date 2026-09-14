/// <reference types="node" />

import { describe, expect, it, vi } from 'vitest';
import {
  classifyPublishFailure,
  PublishFailureEvidenceScanner,
  publishPlatformsSequentially,
  publishSelfHostedPlatformWithRetry,
  minimumPublishJobTimeoutMinutes,
  SELF_HOSTED_PUBLISH_MAX_ATTEMPTS,
  SELF_HOSTED_PUBLISH_RETRY_DELAYS_MS,
  SELF_HOSTED_PUBLISH_WORST_CASE_MINUTES_PER_PLATFORM,
  type PublishCommandRunner,
  type TextOutput,
} from './mobile-publish-retry';

// The repo's Next global.d.ts augments NodeJS.ProcessEnv to require NODE_ENV, so
// a bare `{}` literal isn't assignable. These cases never read the child
// environment, so an empty one is the honest fixture.
const emptyChildEnvironment = {} as NodeJS.ProcessEnv;

function outputCollector(): { output: TextOutput; read: () => string } {
  const chunks: string[] = [];
  return {
    output: { write: (chunk) => chunks.push(chunk) },
    read: () => chunks.join(''),
  };
}

describe('self-hosted publish failure classification', () => {
  it('recognizes only the complete S3 SlowDown XML evidence', () => {
    expect(
      classifyPublishFailure('<Error><Code>SlowDown</Code><Message>Please reduce your request rate.</Message></Error>'),
    ).toBe('s3-slowdown');
    expect(classifyPublishFailure('S3 SlowDown: please retry')).toBe('unknown');
    expect(classifyPublishFailure('<Code>SlowDown</Code>')).toBe('unknown');
  });

  it('recognizes explicit HTTP 5xx statuses but not unrelated numbers', () => {
    expect(classifyPublishFailure('request failed with HTTP/1.1 503 Service Unavailable')).toBe('http-5xx');
    expect(classifyPublishFailure('response status: 502')).toBe('http-5xx');
    expect(classifyPublishFailure('Response code: 503')).toBe('http-5xx');
    expect(classifyPublishFailure('uploaded 503 assets')).toBe('unknown');
  });

  it('lets permanent evidence veto retryable evidence', () => {
    expect(classifyPublishFailure('HTTP 503, then response status 403')).toBe('permanent');
    expect(classifyPublishFailure('Response code: 503; retry returned Response code: 401')).toBe('permanent');
    expect(
      classifyPublishFailure(
        '<Code>SlowDown</Code><Message>Please reduce your request rate.</Message><Code>AccessDenied</Code>',
      ),
    ).toBe('permanent');
  });

  it('classifies evidence split across output chunks', () => {
    const scanner = new PublishFailureEvidenceScanner();
    scanner.push('<Error><Code>Slow');
    scanner.push('Down</Code><Message>Please reduce your request');
    scanner.push(' rate.</Message></Error>');
    expect(scanner.classify()).toBe('s3-slowdown');
  });
});

describe('self-hosted publish backoff budget', () => {
  // The point of the ladder is to outlast the object store's throttle, not just
  // to retry. Run 30855435091 stayed throttled across a 17-minute window and the
  // 30/60/120s ladder gave up ~8 minutes in; anything under 30 minutes of total
  // backoff would reintroduce that failure.
  const OBSERVED_THROTTLE_WINDOW_MINUTES = 17;

  it('waits longer than the observed throttle window', () => {
    const totalBackoffMinutes =
      SELF_HOSTED_PUBLISH_RETRY_DELAYS_MS.reduce((total, delayMs) => total + delayMs, 0) / 60_000;
    expect(totalBackoffMinutes).toBeGreaterThan(OBSERVED_THROTTLE_WINDOW_MINUTES);
    expect(totalBackoffMinutes).toBeGreaterThanOrEqual(30);
  });

  it('grows the delays monotonically so early failures still retry quickly', () => {
    const delays = [...SELF_HOSTED_PUBLISH_RETRY_DELAYS_MS];
    expect(delays.length).toBeGreaterThan(0);
    expect(delays[0]).toBeLessThanOrEqual(60_000);
    for (let index = 1; index < delays.length; index++) {
      expect(delays[index]).toBeGreaterThanOrEqual(delays[index - 1]);
    }
  });

  it('derives a job timeout floor that scales with the platforms a job publishes', () => {
    // Each extra platform a job publishes must add that platform's whole worst
    // case to the floor. A floor that grew by less would let a two-platform job
    // be sized as if the second platform retried for free.
    const onePlatformFloor = minimumPublishJobTimeoutMinutes(1);
    const twoPlatformFloor = minimumPublishJobTimeoutMinutes(2);
    expect(twoPlatformFloor - onePlatformFloor).toBeGreaterThanOrEqual(
      Math.floor(SELF_HOSTED_PUBLISH_WORST_CASE_MINUTES_PER_PLATFORM),
    );
    // Whole minutes only — `timeout-minutes` rejects a fraction.
    expect(Number.isInteger(twoPlatformFloor)).toBe(true);
    expect(Number.isInteger(onePlatformFloor)).toBe(true);
  });
});

describe('self-hosted publish retries', () => {
  it('retries through the whole backoff ladder before succeeding', async () => {
    const attempts: number[] = [];
    const runner: PublishCommandRunner = async ({ onStderr }) => {
      attempts.push(attempts.length + 1);
      if (attempts.length < SELF_HOSTED_PUBLISH_MAX_ATTEMPTS) {
        onStderr('HTTP 503 Service Unavailable\n');
        return { exitCode: 1 };
      }
      return { exitCode: 0 };
    };
    const sleeper = vi.fn(async (_delayMs: number) => undefined);
    const stdout = outputCollector();
    const stderr = outputCollector();

    const outcome = await publishSelfHostedPlatformWithRetry(
      { platform: 'ios', command: 'vp', args: ['dlx', 'eoas', 'publish'], cwd: '/repo', env: emptyChildEnvironment },
      { runner, sleeper, stdout: stdout.output, stderr: stderr.output },
    );

    expect(outcome).toEqual({
      platform: 'ios',
      success: true,
      attempts: SELF_HOSTED_PUBLISH_MAX_ATTEMPTS,
      failureKind: null,
      noChange: false,
    });
    expect(attempts).toHaveLength(SELF_HOSTED_PUBLISH_MAX_ATTEMPTS);
    expect(sleeper.mock.calls.map(([delayMs]) => delayMs)).toEqual([...SELF_HOSTED_PUBLISH_RETRY_DELAYS_MS]);
  });

  it('does not retry permanent or mixed evidence', async () => {
    const runner = vi.fn<PublishCommandRunner>(async ({ onStdout, onStderr }) => {
      onStdout('HTTP 503 Service Unavailable\n');
      onStderr('response status: 401\n');
      return { exitCode: 1 };
    });
    const sleeper = vi.fn(async () => undefined);
    const stderr = outputCollector();

    const outcome = await publishSelfHostedPlatformWithRetry(
      { platform: 'android', command: 'vp', args: [], cwd: '/repo', env: emptyChildEnvironment },
      { runner, sleeper, stdout: outputCollector().output, stderr: stderr.output },
    );

    expect(outcome).toEqual({
      platform: 'android',
      success: false,
      attempts: 1,
      failureKind: 'permanent',
      noChange: false,
    });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(sleeper).not.toHaveBeenCalled();
  });

  it('preserves classified evidence when the retry sleeper rejects without exposing the thrown detail', async () => {
    const runner = vi.fn<PublishCommandRunner>(async ({ onStderr }) => {
      onStderr('HTTP 503 Service Unavailable\n');
      return { exitCode: 1 };
    });
    const sleeper = vi.fn(async () => {
      throw new Error('EOO_TOKEN=eoo_fixture_sleep_secret');
    });
    const stderr = outputCollector();

    const outcome = await publishSelfHostedPlatformWithRetry(
      { platform: 'ios', command: 'vp', args: [], cwd: '/repo', env: emptyChildEnvironment },
      { runner, sleeper, stdout: outputCollector().output, stderr: stderr.output },
    );

    expect(outcome).toEqual({
      platform: 'ios',
      success: false,
      attempts: 1,
      failureKind: 'http-5xx',
      noChange: false,
    });
    expect(runner).toHaveBeenCalledOnce();
    expect(sleeper).toHaveBeenCalledOnce();
    expect(sleeper).toHaveBeenCalledWith(SELF_HOSTED_PUBLISH_RETRY_DELAYS_MS[0]);
    expect(stderr.read()).toContain('retry wait failed; not retrying');
    expect(stderr.read()).not.toContain('eoo_fixture_sleep_secret');
  });

  it('streams child output once without copying a raw token into diagnostics', async () => {
    const sensitiveOutput = 'server detail: EOO_TOKEN=eoo_fixture_secret\n';
    const runner: PublishCommandRunner = async ({ onStderr }) => {
      onStderr(sensitiveOutput);
      return { exitCode: 1 };
    };
    const stderr = outputCollector();

    await publishSelfHostedPlatformWithRetry(
      { platform: 'ios', command: 'vp', args: [], cwd: '/repo', env: emptyChildEnvironment },
      { runner, stdout: outputCollector().output, stderr: stderr.output },
    );

    expect(stderr.read().match(/eoo_fixture_secret/g)).toHaveLength(1);
    expect(stderr.read()).toContain('no retryable error evidence');
  });
});

describe('platform aggregation', () => {
  it('runs iOS then Android and continues after an iOS failure', async () => {
    const calls: string[] = [];
    const outcomes = await publishPlatformsSequentially(['ios', 'android'], async (platform) => {
      calls.push(platform);
      return {
        platform,
        success: platform === 'android',
        attempts: 1,
        failureKind: platform === 'ios' ? 'unknown' : null,
        noChange: false,
      };
    });

    expect(calls).toEqual(['ios', 'android']);
    expect(outcomes).toEqual([
      { platform: 'ios', success: false, attempts: 1, failureKind: 'unknown', noChange: false },
      { platform: 'android', success: true, attempts: 1, failureKind: null, noChange: false },
    ]);
  });

  it('records a thrown callback as failed and still runs the next platform', async () => {
    const calls: string[] = [];
    const outcomes = await publishPlatformsSequentially(['ios', 'android'], async (platform) => {
      calls.push(platform);
      if (platform === 'ios') throw new Error('fixture callback failure');
      return { platform, success: true, attempts: 1, failureKind: null, noChange: false };
    });

    expect(calls).toEqual(['ios', 'android']);
    expect(outcomes).toEqual([
      { platform: 'ios', success: false, attempts: 0, failureKind: 'unknown', noChange: false },
      { platform: 'android', success: true, attempts: 1, failureKind: null, noChange: false },
    ]);
  });
});

// The real thing, from run 34775177168 (#5422): every asset uploaded, then the
// finalize call outlived Cloudflare's 100s origin cap.
const FINALIZE_524 =
  '▲  Retry 0 after HTTP 524 from https://updates.boardsesh.com/007e6fd7-f200-448c-9449-8d48ba5d51fc/markUpdateAsUploaded/pr-5422\n';

// The real thing, from run 34755541101 (#5417): the Android bundle came out
// identical to the previous publish, so xprem declined to create an update —
// and eoas exited 0 regardless.
const NO_CHANGE_OUTPUT = [
  '●  ⚠️ There is no change in the update for android, ignored...',
  '▲  ⚠️ No changes found in the update, nothing to deploy',
  '',
].join('\n');

function runnerEmitting(chunk: string, exitCode: number): PublishCommandRunner {
  return async (request) => {
    request.onStdout(chunk);
    return { exitCode };
  };
}

const SILENT = { write: () => undefined };

function invocation() {
  return {
    platform: 'ios' as const,
    command: 'vp',
    args: ['dlx', 'eoas@3.1.2', 'publish'],
    cwd: '/repo/packages/mobile',
    env: {} as NodeJS.ProcessEnv,
  };
}

describe('finalize gateway timeouts', () => {
  it('still classifies a finalize 524 as a retryable 5xx', () => {
    // The short-circuit below is an optimisation layered on top; if the probe is
    // unavailable the ladder must still treat this as transient.
    expect(classifyPublishFailure(FINALIZE_524)).toBe('http-5xx');
  });

  it('tells a finalize timeout apart from any other 5xx', () => {
    const finalize = new PublishFailureEvidenceScanner();
    finalize.push(FINALIZE_524);
    expect(finalize.sawFinalizeTimeout()).toBe(true);

    // A 503 mid-upload says nothing about whether an update was recorded, so it
    // must not trigger a "did it land anyway?" probe.
    const upload = new PublishFailureEvidenceScanner();
    upload.push('HTTP 503 from https://updates.boardsesh.com/.../uploadLocalFile\n');
    expect(upload.sawFinalizeTimeout()).toBe(false);
  });

  it('refuses to read a 524 as "probably landed" when a permanent error is also present', () => {
    const scanner = new PublishFailureEvidenceScanner();
    scanner.push(FINALIZE_524);
    scanner.push('authentication failed\n');
    expect(scanner.sawFinalizeTimeout()).toBe(false);
  });

  it('accepts a confirmed 524 as published instead of re-exporting the bundle', async () => {
    const sleeper = vi.fn(async () => undefined);
    const confirmPublished = vi.fn(async () => true);
    const runner = vi.fn(runnerEmitting(FINALIZE_524, 1));

    const outcome = await publishSelfHostedPlatformWithRetry(invocation(), {
      runner,
      sleeper,
      confirmPublished,
      stdout: SILENT,
      stderr: SILENT,
    });

    expect(outcome).toEqual({ platform: 'ios', success: true, attempts: 1, failureKind: null, noChange: false });
    // The whole point: one export, no backoff. #5422 spent 2h09m doing this six times.
    expect(runner).toHaveBeenCalledTimes(1);
    expect(sleeper).not.toHaveBeenCalled();
  });

  it('falls back to the retry ladder when the server says the update did not land', async () => {
    const sleeper = vi.fn(async () => undefined);
    const confirmPublished = vi.fn(async () => false);
    const runner = vi.fn(runnerEmitting(FINALIZE_524, 1));

    const outcome = await publishSelfHostedPlatformWithRetry(invocation(), {
      runner,
      sleeper,
      confirmPublished,
      stdout: SILENT,
      stderr: SILENT,
    });

    expect(outcome.success).toBe(false);
    expect(outcome.attempts).toBe(6);
    expect(sleeper).toHaveBeenCalledTimes(5);
  });

  it('treats a probe that throws as no evidence rather than a failure of its own', async () => {
    const confirmPublished = vi.fn(async () => {
      throw new Error('DNS went away');
    });

    const outcome = await publishSelfHostedPlatformWithRetry(invocation(), {
      runner: runnerEmitting(FINALIZE_524, 1),
      sleeper: async () => undefined,
      confirmPublished,
      stdout: SILENT,
      stderr: SILENT,
    });

    expect(outcome.success).toBe(false);
    expect(outcome.failureKind).toBe('http-5xx');
  });

  it('leaves publishes without a confirmation hook exactly as they were', async () => {
    const sleeper = vi.fn(async () => undefined);

    const outcome = await publishSelfHostedPlatformWithRetry(invocation(), {
      runner: runnerEmitting(FINALIZE_524, 1),
      sleeper,
      stdout: SILENT,
      stderr: SILENT,
    });

    expect(outcome.success).toBe(false);
    expect(sleeper).toHaveBeenCalledTimes(5);
  });
});

describe('deduplicated exports', () => {
  it('reports a skipped publish as no-change rather than a plain success', async () => {
    const outcome = await publishSelfHostedPlatformWithRetry(invocation(), {
      runner: runnerEmitting(NO_CHANGE_OUTPUT, 0),
      sleeper: async () => undefined,
      stdout: SILENT,
      stderr: SILENT,
    });

    // Still a success — the command did what it was asked. But the caller can now
    // tell "we published" from "an identical update was already there", which is
    // the distinction #5417 needed and nothing recorded.
    expect(outcome.success).toBe(true);
    expect(outcome.noChange).toBe(true);
  });

  it('does not flag an ordinary publish as no-change', async () => {
    const outcome = await publishSelfHostedPlatformWithRetry(invocation(), {
      runner: runnerEmitting('●  ✅ Update ready for ios\n', 0),
      sleeper: async () => undefined,
      stdout: SILENT,
      stderr: SILENT,
    });

    expect(outcome.noChange).toBe(false);
  });
});
