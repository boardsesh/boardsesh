import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { NETWORK_PROCESS_LOST_LOG_MARKER } from './harness-retries';

/**
 * The one test-level retry the suite allows (harness-retries.ts): WebKit's
 * network process lost the context. The WebKit project may run a failed test
 * once more (playwright.config.ts), and this reporter fails the run when a
 * test was run again after an attempt whose log does not carry that marker,
 * so any other failure still fails the run even if the second attempt passes.
 */
/** The parts of an attempt the check reads. */
export type RetriedAttempt = {
  title: string;
  result: Pick<TestResult, 'status' | 'stdout' | 'stderr'>;
};

function loggedText(result: RetriedAttempt['result']): string {
  return [...result.stdout, ...result.stderr]
    .map((chunk) => (typeof chunk === 'string' ? chunk : chunk.toString('utf8')))
    .join('');
}

export function unsanctionedRetries(results: readonly RetriedAttempt[]): string[] {
  return results
    .filter(({ result }) => result.status !== 'passed' && result.status !== 'skipped')
    .filter(({ result }) => !loggedText(result).includes(NETWORK_PROCESS_LOST_LOG_MARKER))
    .map(({ title }) => title);
}

export default class HarnessRetryReporter implements Reporter {
  private readonly retriedAttempts: RetriedAttempt[] = [];

  onTestEnd(test: TestCase, result: TestResult): void {
    // An expected outcome (a `test.fail` case that failed) is never run again.
    if (result.status === test.expectedStatus) return;
    // An attempt that is followed by another: the test has retries left and did not pass.
    if (result.status !== 'passed' && result.status !== 'skipped' && result.retry < test.retries)
      this.retriedAttempts.push({ title: test.titlePath().join(' › '), result });
  }

  async onEnd(result: FullResult): Promise<{ status?: FullResult['status'] } | undefined> {
    const refused = unsanctionedRetries(this.retriedAttempts);
    if (refused.length === 0) return undefined;
    for (const title of refused)
      console.info(`[harness-retry] refused: ${title} failed for another reason than a lost WebKit context`);
    return { status: result.status === 'passed' ? 'failed' : result.status };
  }
}
