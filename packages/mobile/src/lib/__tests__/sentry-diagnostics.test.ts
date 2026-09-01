import { afterEach, describe, expect, it, vi } from 'vitest';
import { scheduleUncaughtSentryTestError, UNCAUGHT_SENTRY_TEST_MESSAGE } from '../sentry-diagnostics';

describe('scheduleUncaughtSentryTestError', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('throws the diagnostic error asynchronously', () => {
    vi.useFakeTimers();
    scheduleUncaughtSentryTestError();

    expect(() => vi.runAllTimers()).toThrow(UNCAUGHT_SENTRY_TEST_MESSAGE);
  });
});
