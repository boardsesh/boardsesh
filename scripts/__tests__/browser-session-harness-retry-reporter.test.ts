import { describe, expect, it } from 'vitest';
import HarnessRetryReporter, {
  unsanctionedRetries,
  type RetriedAttempt,
} from '../../packages/web/e2e/browser-session/harness-retry-reporter';
import { firstLossOfContext } from '../../packages/web/e2e/browser-session/harness-retries';

function attempt(status: RetriedAttempt['result']['status'], stdout: string[]): RetriedAttempt['result'] {
  return { status, stdout, stderr: [] };
}

describe('browser-session harness retry reporter', () => {
  it('allows a retry only after an attempt that logged a lost WebKit context', () => {
    expect(
      unsanctionedRetries([
        {
          title: 'lost context',
          result: attempt('failed', ['[harness-retry] webkit-network-process-lost: the context lost its cookies\n']),
        },
      ]),
    ).toEqual([]);
  });

  it('refuses a retry after any other failure, timeout included', () => {
    expect(
      unsanctionedRetries([
        { title: 'assertion', result: attempt('failed', ['[webkit] request failed: GET x (internal error)\n']) },
        { title: 'slow', result: attempt('timedOut', []) },
      ]),
    ).toEqual(['assertion', 'slow']);
  });
});

describe('the lost WebKit context budget', () => {
  it('counts one lost context once, however many of its pages see it (review of #7810)', () => {
    const contextOne = {};
    const contextTwo = {};
    expect(firstLossOfContext(contextOne)).toBe(true);
    expect(firstLossOfContext(contextOne)).toBe(false);
    expect(firstLossOfContext(contextTwo)).toBe(true);
  });
});

describe('the reporter and expected failures', () => {
  type ReportedTest = Parameters<HarnessRetryReporter['onTestEnd']>[0];
  type ReportedAttempt = Parameters<HarnessRetryReporter['onTestEnd']>[1];
  type RunResult = Parameters<HarnessRetryReporter['onEnd']>[0];
  function attemptOf(status: ReportedAttempt['status'], retry: number): ReportedAttempt {
    return { status, retry, stdout: [], stderr: [] } as unknown as ReportedAttempt;
  }
  function testOf(expectedStatus: ReportedTest['expectedStatus']): ReportedTest {
    return {
      retries: 1,
      expectedStatus,
      titlePath: () => ['webkit', 'cookie-order.spec.ts', 'a case'],
    } as unknown as ReportedTest;
  }

  it('does not count a test.fail case that failed as expected, which Playwright never retries (run 44427604183)', async () => {
    const reporter = new HarnessRetryReporter();
    reporter.onTestEnd(testOf('failed'), attemptOf('failed', 0));
    expect(await reporter.onEnd({ status: 'passed' } as RunResult)).toBeUndefined();
  });

  it('still counts a failed attempt of a test expected to pass', async () => {
    const reporter = new HarnessRetryReporter();
    reporter.onTestEnd(testOf('passed'), attemptOf('failed', 0));
    expect(await reporter.onEnd({ status: 'passed' } as RunResult)).toEqual({ status: 'failed' });
  });
});
