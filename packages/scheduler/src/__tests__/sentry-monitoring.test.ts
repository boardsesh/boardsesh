import { describe, expect, it } from 'vitest';
import type { LogFields, SchedulerLogger } from '../logger';
import { noopCronMonitor } from '../monitoring/cron-monitor';
import { setupCronMonitoring } from '../monitoring/sentry';

type RecordedLog = { level: 'info' | 'warn' | 'error'; message: string; fields?: LogFields };

function createRecordingLogger() {
  const logs: RecordedLog[] = [];
  const logger: SchedulerLogger = {
    info: (message, fields) => logs.push({ level: 'info', message, fields }),
    warn: (message, fields) => logs.push({ level: 'warn', message, fields }),
    error: (message, fields) => logs.push({ level: 'error', message, fields }),
  };
  return { logger, logs };
}

describe('setupCronMonitoring', () => {
  // Only the no-DSN branch is exercised here. Calling the other one would run
  // `Sentry.init` against the real SDK for the whole test process — a global
  // side effect the rest of the suite would inherit. `createCronMonitor` is
  // tested directly against a fake withMonitor in cron-monitor.test.ts instead.

  it('degrades to a no-op monitor when SENTRY_DSN is unset', () => {
    const { logger, logs } = createRecordingLogger();

    const monitor = setupCronMonitoring({ env: {}, logger });

    expect(monitor).toBe(noopCronMonitor);
    expect(logs.filter((log) => log.level === 'warn' && log.message.includes('SENTRY_DSN'))).toHaveLength(1);
  });

  it('treats a blank SENTRY_DSN as unset rather than initialising with it', () => {
    // Railway hands an unset variable through as an empty string; passing that
    // to Sentry.init would produce a client that silently drops everything.
    const { logger, logs } = createRecordingLogger();

    expect(setupCronMonitoring({ env: { SENTRY_DSN: '   ' }, logger })).toBe(noopCronMonitor);
    expect(logs.some((log) => log.level === 'warn' && log.message.includes('SENTRY_DSN'))).toBe(true);
  });

  it('says how to turn monitors on rather than only that they are off', () => {
    const { logger, logs } = createRecordingLogger();
    setupCronMonitoring({ env: {}, logger });

    expect(logs[0].fields?.hint).toContain('SENTRY_DSN');
  });
});
