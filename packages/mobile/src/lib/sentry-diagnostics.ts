import { beginDiagnosticOperation } from './mobile-diagnostics';

export const UNCAUGHT_SENTRY_TEST_MESSAGE = 'Sentry test: uncaught JS exception — diagnostics';

/** Queue an error outside React's event boundary so Sentry sees an uncaught JS exception. */
export function scheduleUncaughtSentryTestError(): void {
  setTimeout(() => {
    throw new Error(UNCAUGHT_SENTRY_TEST_MESSAGE);
  }, 0);
}

/** Unique run IDs correlate tester events without changing issue grouping. */
export function beginSentryDiagnosticTest(kind: 'handled' | 'uncaught-js' | 'java-exception' | 'native-abort'): string {
  const operation = beginDiagnosticOperation('navigation', 'sentry-test', {
    userInitiated: true,
    attributes: { kind },
  });
  operation.step('trigger', { testRunId: operation.id, kind });
  if (kind === 'handled') operation.finish('success');
  return operation.id;
}
