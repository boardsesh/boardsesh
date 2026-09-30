import { beginDiagnosticOperation } from './mobile-diagnostics';

export const UNCAUGHT_SENTRY_TEST_MESSAGE = 'Sentry test: uncaught JS exception — diagnostics';

/** Queue an error outside React's event boundary so Sentry sees an uncaught JS exception. */
export function scheduleUncaughtSentryTestError(): void {
  setTimeout(() => {
    throw new Error(UNCAUGHT_SENTRY_TEST_MESSAGE);
  }, 0);
}

/** Unique run IDs correlate tester events without changing issue grouping. */
export function createSentryDiagnosticTestRunId(): string {
  return `test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function beginSentryDiagnosticTest(
  kind: 'handled' | 'uncaught-js' | 'java-exception' | 'native-abort',
  preparedRunId?: string,
): string {
  const operation = beginDiagnosticOperation('navigation', 'sentry-test', {
    userInitiated: true,
    attributes: { kind },
  });
  const testRunId = preparedRunId ?? operation.id;
  operation.step('trigger', { testRunId, kind });
  if (kind === 'handled') operation.finish('success');
  return testRunId;
}
