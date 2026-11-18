/**
 * The only retries the browser-session suite allows (#7596 B7 review): this
 * suite tests races, and a blanket Playwright retry would hide one. Two named
 * infrastructure errors get one more try each:
 *
 *   restart-www-timeout      a `restartStack` that timed out waiting for www (servers.ts)
 *   webkit-internal-error    WebKit failing a navigation, its document or one of its
 *                            scripts with "internal error", or an app navigation left
 *                            blank for 30 s after a request failed that way (fixtures.ts)
 *
 * Each is logged with the `[harness-retry]` marker. The setup process counts
 * them (the control server takes a worker's report) and teardown fails the run
 * when there were more than MAX_HARNESS_RETRIES.
 */

export type HarnessRetryKind = 'restart-www-timeout' | 'webkit-internal-error';
export const MAX_HARNESS_RETRIES = 2;

const recorded: HarnessRetryKind[] = [];

/** In the setup process: counts one retry and logs its marker. */
export function recordHarnessRetry(kind: HarnessRetryKind): void {
  recorded.push(kind);
  console.info(`[harness-retry] ${kind} (${recorded.length} this run)`);
}

export function harnessRetries(): readonly HarnessRetryKind[] {
  return recorded;
}

/** For teardown: an error when the run needed more retries than it may have. */
export function harnessRetryBudgetError(): Error | undefined {
  if (recorded.length <= MAX_HARNESS_RETRIES) return undefined;
  return new Error(
    `The run needed ${recorded.length} harness retries (${recorded.join(', ')}); at most ${MAX_HARNESS_RETRIES} are allowed.`,
  );
}
