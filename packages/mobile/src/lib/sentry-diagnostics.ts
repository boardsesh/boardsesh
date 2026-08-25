export const UNCAUGHT_SENTRY_TEST_MESSAGE = 'Sentry test: uncaught JS exception — diagnostics';

/** Queue an error outside React's event boundary so Sentry sees an uncaught JS exception. */
export function scheduleUncaughtSentryTestError(): void {
  setTimeout(() => {
    throw new Error(UNCAUGHT_SENTRY_TEST_MESSAGE);
  }, 0);
}
