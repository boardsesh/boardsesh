import { beginDiagnosticOperation, type DiagnosticOperation } from './mobile-diagnostics';

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

let pendingNativeAbort: { testRunId: string; operation: DiagnosticOperation } | undefined;

/** A failed native preparation must not leave a deliberate-crash operation active. */
export function finishUnavailableSentryNativeAbort(testRunId: string): void {
  if (pendingNativeAbort?.testRunId !== testRunId) return;
  pendingNativeAbort.operation.finish('failure', { failureCategory: 'native-abort-unavailable' });
  pendingNativeAbort = undefined;
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
  if (kind === 'native-abort') {
    pendingNativeAbort?.operation.finish('superseded');
    pendingNativeAbort = { testRunId, operation };
  }
  return testRunId;
}
