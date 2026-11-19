/**
 * The only retries the browser-session suite allows (#7596 B7 review): this
 * suite tests races, and a blanket Playwright retry would hide one. Three named
 * infrastructure errors get one more try each:
 *
 *   restart-www-timeout          a `restartStack` that timed out waiting for www (servers.ts)
 *   webkit-internal-error        WebKit failing a navigation, its document or one of its
 *                                scripts with "internal error"; the navigation is tried again
 *                                (fixtures.ts)
 *   webkit-network-process-lost  WebKit failing loads with "internal error" and the context
 *                                losing its cookies with them; the test runs once more, and
 *                                only such a test may (harness-retry-reporter.ts)
 *
 * Each is logged with the `[harness-retry]` marker. The setup process counts
 * them (the control server takes a worker's report) and teardown fails the run
 * when there were more than MAX_HARNESS_RETRIES.
 */

export type HarnessRetryKind = 'restart-www-timeout' | 'webkit-internal-error' | 'webkit-network-process-lost';
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

const lostContexts = new WeakSet<object>();

/**
 * True the first time a context's loss is reported: every page of a lost
 * context sees the loss at once, and it counts against the budget once.
 */
export function firstLossOfContext(context: object): boolean {
  if (lostContexts.has(context)) return false;
  lostContexts.add(context);
  return true;
}

/** The line a test's log carries when WebKit lost its context; the reporter allows a retry only after it. */
export const NETWORK_PROCESS_LOST_LOG_MARKER = '[harness-retry] webkit-network-process-lost';

export function isHarnessRetryKind(kind: unknown): kind is HarnessRetryKind {
  return kind === 'restart-www-timeout' || kind === 'webkit-internal-error' || kind === 'webkit-network-process-lost';
}
