import { describe, expect, it, vi } from 'vitest';
import type { SchedulerConfig } from '../config';
import type { CronScheduleOptions, CronScheduler, CronTask } from '../cron/scheduler';
import type { JobDefinition } from '../jobs/types';
import type { LogFields, SchedulerLogger } from '../logger';
import { createCronMonitor, type CronMonitorConfig, type WithMonitorFn } from '../monitoring/cron-monitor';
import { createScheduler, OVERDUE_GRACE_MS } from '../runner';

type RecordedRegistration = {
  expression: string;
  handler: () => void;
  options: CronScheduleOptions;
  stopped: boolean;
};

function createFakeCron() {
  const registrations: RecordedRegistration[] = [];

  const cron: CronScheduler = {
    schedule(expression, handler, options): CronTask {
      const registration: RecordedRegistration = { expression, handler, options, stopped: false };
      registrations.push(registration);
      return {
        expression,
        timezone: options.timezone,
        stop() {
          registration.stopped = true;
        },
      };
    },
    stop() {
      for (const registration of registrations) {
        registration.stopped = true;
      }
    },
  };

  return { cron, registrations };
}

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

const baseConfig: SchedulerConfig = {
  webBaseUrl: 'https://web.test',
  backendGraphqlUrl: 'https://backend.test/graphql',
  cronSecret: 'secret',
  port: 8080,
  disabledJobs: [],
};

type RecordedMonitorCall = { slug: string; config: CronMonitorConfig };

/** Records what would have been sent to Sentry, and passes the run through. */
function createRecordingMonitor() {
  const calls: RecordedMonitorCall[] = [];
  const withMonitor: WithMonitorFn = (slug, callback, config) => {
    calls.push({ slug, config });
    return callback();
  };
  return { calls, monitor: createCronMonitor(withMonitor) };
}

const defineJob = (overrides: Partial<JobDefinition> = {}): JobDefinition => ({
  name: 'cleanup',
  schedule: '0 5 * * *',
  timezone: 'UTC',
  timeoutMs: 120_000,
  run: async () => ({ ok: true }),
  ...overrides,
});

describe('createScheduler', () => {
  it('registers each job with its exact expression and timezone', () => {
    const { cron, registrations } = createFakeCron();
    const { logger } = createRecordingLogger();

    createScheduler({
      jobs: [defineJob(), defineJob({ name: 'other', schedule: '30 4 * * 0', timezone: 'UTC' })],
      config: baseConfig,
      cron,
      logger,
    });

    expect(registrations).toHaveLength(2);
    expect(registrations[0].expression).toBe('0 5 * * *');
    expect(registrations[0].options).toEqual({ timezone: 'UTC' });
    expect(registrations[1].expression).toBe('30 4 * * 0');
    expect(registrations[1].options).toEqual({ timezone: 'UTC' });
  });

  it('skips and warns on a tick whose predecessor is still in flight', async () => {
    const { cron, registrations } = createFakeCron();
    const { logger, logs } = createRecordingLogger();
    let releaseFirstRun: () => void = () => undefined;
    const run = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          releaseFirstRun = () => resolve({ ok: true });
        }),
    );

    const scheduler = createScheduler({ jobs: [defineJob({ run })], config: baseConfig, cron, logger });

    registrations[0].handler();
    registrations[0].handler();
    expect(run).toHaveBeenCalledTimes(1);
    expect(logs.some((log) => log.level === 'warn' && log.message.includes('still in flight'))).toBe(true);
    expect(scheduler.getStatus()[0].skippedCount).toBe(1);

    releaseFirstRun();
    await vi.waitFor(() => expect(scheduler.getStatus()[0].running).toBe(false));

    // Once the first run finishes the next tick is accepted again.
    registrations[0].handler();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('catches a rejecting job, records it, and stays scheduled', async () => {
    const { cron, registrations } = createFakeCron();
    const { logger, logs } = createRecordingLogger();
    const run = vi.fn().mockRejectedValue(new Error('web returned HTTP 500'));

    const scheduler = createScheduler({ jobs: [defineJob({ run })], config: baseConfig, cron, logger });

    expect(() => registrations[0].handler()).not.toThrow();
    await vi.waitFor(() => expect(scheduler.getStatus()[0].failureCount).toBe(1));

    const status = scheduler.getStatus()[0];
    expect(status.lastError).toBe('web returned HTTP 500');
    expect(status.running).toBe(false);
    expect(registrations[0].stopped).toBe(false);
    expect(logs.some((log) => log.level === 'error' && log.message === 'job failed')).toBe(true);

    run.mockResolvedValueOnce({ ok: true });
    registrations[0].handler();
    await vi.waitFor(() => expect(scheduler.getStatus()[0].lastError).toBeNull());
  });

  it('passes the job timeout and a shutdown signal into the run context', async () => {
    const { cron } = createFakeCron();
    const { logger } = createRecordingLogger();
    const run = vi.fn().mockResolvedValue(null);

    const scheduler = createScheduler({
      jobs: [defineJob({ run, timeoutMs: 4_242 })],
      config: baseConfig,
      cron,
      logger,
    });
    await scheduler.runJob('cleanup');

    const runContext = run.mock.calls[0][0];
    expect(runContext.timeoutMs).toBe(4_242);
    expect(runContext.config).toBe(baseConfig);
    expect(runContext.shutdownSignal.aborted).toBe(false);

    scheduler.stop();
    expect(runContext.shutdownSignal.aborted).toBe(true);
  });

  it('leaves SCHEDULER_DISABLED_JOBS entries unregistered but still runnable on demand', async () => {
    const { cron, registrations } = createFakeCron();
    const { logger, logs } = createRecordingLogger();
    const run = vi.fn().mockResolvedValue({ ok: true });

    const scheduler = createScheduler({
      jobs: [defineJob({ run }), defineJob({ name: 'other', run })],
      config: { ...baseConfig, disabledJobs: ['cleanup'] },
      cron,
      logger,
    });

    expect(registrations).toHaveLength(1);
    expect(scheduler.scheduledJobs.map((job) => job.name)).toEqual(['other']);
    expect(scheduler.getStatus().find((status) => status.name === 'cleanup')?.scheduled).toBe(false);
    expect(logs.some((log) => log.level === 'warn' && log.message.includes('disabled'))).toBe(true);

    await expect(scheduler.runJob('cleanup')).resolves.toEqual({ ok: true });
  });

  it('warns when SCHEDULER_DISABLED_JOBS names a job that does not exist', () => {
    const { cron } = createFakeCron();
    const { logger, logs } = createRecordingLogger();

    createScheduler({ jobs: [defineJob()], config: { ...baseConfig, disabledJobs: ['typo'] }, cron, logger });

    expect(logs.some((log) => log.level === 'warn' && log.message.includes('no such job'))).toBe(true);
  });

  it('registers nothing when registerSchedules is false', () => {
    const { cron, registrations } = createFakeCron();
    const { logger } = createRecordingLogger();

    createScheduler({ jobs: [defineJob()], config: baseConfig, cron, logger, registerSchedules: false });

    expect(registrations).toHaveLength(0);
  });

  it('rejects duplicate job names', () => {
    const { cron } = createFakeCron();
    const { logger } = createRecordingLogger();

    expect(() => createScheduler({ jobs: [defineJob(), defineJob()], config: baseConfig, cron, logger })).toThrow(
      /duplicate job name/,
    );
  });

  it('throws a helpful error for an unknown job name', async () => {
    const { cron } = createFakeCron();
    const { logger } = createRecordingLogger();
    const scheduler = createScheduler({ jobs: [defineJob()], config: baseConfig, cron, logger });

    await expect(scheduler.runJob('nope')).rejects.toThrow(/unknown job "nope"; known jobs: cleanup/);
  });

  it('destroys every registered task on stop()', () => {
    const { cron, registrations } = createFakeCron();
    const { logger } = createRecordingLogger();
    const scheduler = createScheduler({
      jobs: [defineJob(), defineJob({ name: 'other' })],
      config: baseConfig,
      cron,
      logger,
    });

    scheduler.stop();
    expect(registrations.every((registration) => registration.stopped)).toBe(true);
  });

  it('reports a scheduled tick to the cron monitor with the job schedule', async () => {
    const { cron, registrations } = createFakeCron();
    const { logger } = createRecordingLogger();
    const { calls, monitor } = createRecordingMonitor();
    const run = vi.fn().mockResolvedValue({ ok: true });

    const scheduler = createScheduler({
      jobs: [defineJob({ run, name: 'profile-percentiles', schedule: '30 4 * * 0', sentryMonitor: true })],
      config: baseConfig,
      cron,
      logger,
      monitor,
    });

    registrations[0].handler();
    await vi.waitFor(() => expect(scheduler.getStatus()[0].runCount).toBe(1));

    expect(calls).toEqual([
      {
        slug: 'scheduler-profile-percentiles',
        config: expect.objectContaining({
          schedule: { type: 'crontab', value: '30 4 * * 0' },
          timezone: 'UTC',
        }),
      },
    ]);
  });

  it('sends no check-in for a manual runJob, only for a scheduled tick', async () => {
    // `scheduler run <job>` is an operator debugging a job, not an occurrence
    // of the schedule. An "ok" check-in from a hand-run would resolve a
    // genuinely missed occurrence and report a dead ticker as healthy.
    const { cron, registrations } = createFakeCron();
    const { logger } = createRecordingLogger();
    const { calls, monitor } = createRecordingMonitor();
    const run = vi.fn().mockResolvedValue({ ok: true });

    const scheduler = createScheduler({
      jobs: [defineJob({ run, sentryMonitor: true })],
      config: baseConfig,
      cron,
      logger,
      monitor,
    });

    await scheduler.runJob('cleanup');
    expect(run).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);

    // The scheduled path through the same scheduler still checks in.
    registrations[0].handler();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
  });

  it('sends no check-in for a tick skipped while its predecessor is in flight', async () => {
    // A skipped tick did not run. Letting Sentry record the occurrence as
    // missed is the honest outcome for a job overrunning its own interval.
    const { cron, registrations } = createFakeCron();
    const { logger } = createRecordingLogger();
    const { calls, monitor } = createRecordingMonitor();
    const run = vi.fn(() => new Promise<unknown>(() => undefined));

    createScheduler({ jobs: [defineJob({ run, sentryMonitor: true })], config: baseConfig, cron, logger, monitor });

    registrations[0].handler();
    registrations[0].handler();

    expect(run).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
  });

  it('still records a failure after the monitor wrapper rethrows', async () => {
    const { cron, registrations } = createFakeCron();
    const { logger, logs } = createRecordingLogger();
    const { calls, monitor } = createRecordingMonitor();
    const run = vi.fn().mockRejectedValue(new Error('web returned HTTP 500'));

    const scheduler = createScheduler({
      jobs: [defineJob({ run, sentryMonitor: true })],
      config: baseConfig,
      cron,
      logger,
      monitor,
    });

    expect(() => registrations[0].handler()).not.toThrow();
    await vi.waitFor(() => expect(scheduler.getStatus()[0].failureCount).toBe(1));

    expect(calls).toHaveLength(1);
    expect(scheduler.getStatus()[0].lastError).toBe('web returned HTTP 500');
    expect(logs.some((log) => log.level === 'error' && log.message === 'job failed')).toBe(true);
  });

  it('runs unmonitored when no monitor is supplied', async () => {
    const { cron, registrations } = createFakeCron();
    const { logger } = createRecordingLogger();
    const run = vi.fn().mockResolvedValue({ ok: true });

    const scheduler = createScheduler({ jobs: [defineJob({ run })], config: baseConfig, cron, logger });

    registrations[0].handler();
    await vi.waitFor(() => expect(scheduler.getStatus()[0].runCount).toBe(1));
    expect(scheduler.getStatus()[0].lastError).toBeNull();
  });

  it('records duration and success timestamps', async () => {
    const { cron } = createFakeCron();
    const { logger } = createRecordingLogger();
    const scheduler = createScheduler({ jobs: [defineJob()], config: baseConfig, cron, logger });

    await scheduler.runJob('cleanup');

    const status = scheduler.getStatus()[0];
    expect(status.runCount).toBe(1);
    expect(status.failureCount).toBe(0);
    expect(status.lastRunAt).not.toBeNull();
    expect(status.lastSuccessAt).not.toBeNull();
    expect(status.lastDurationMs).not.toBeNull();
  });
});

describe('createScheduler Sentry monitor opt-in', () => {
  it('wraps a scheduled tick in the monitor when the job sets sentryMonitor', async () => {
    const { cron, registrations } = createFakeCron();
    const { logger } = createRecordingLogger();
    const { calls, monitor } = createRecordingMonitor();

    const scheduler = createScheduler({
      jobs: [defineJob({ sentryMonitor: true })],
      config: baseConfig,
      cron,
      logger,
      monitor,
    });

    registrations[0].handler();
    await vi.waitFor(() => expect(scheduler.getStatus()[0].runCount).toBe(1));
    expect(calls.map((call) => call.slug)).toEqual(['scheduler-cleanup']);
  });

  it('runs a job without sentryMonitor unwrapped, so it costs no monitor', async () => {
    const { cron, registrations } = createFakeCron();
    const { logger } = createRecordingLogger();
    const { calls, monitor } = createRecordingMonitor();
    const run = vi.fn().mockRejectedValue(new Error('web returned HTTP 500'));

    const scheduler = createScheduler({
      jobs: [defineJob({ name: 'refresh-sitemap-climbs', schedule: '0 */6 * * *', run })],
      config: baseConfig,
      cron,
      logger,
      monitor,
    });

    expect(() => registrations[0].handler()).not.toThrow();
    await vi.waitFor(() => expect(scheduler.getStatus()[0].failureCount).toBe(1));
    expect(calls).toEqual([]);
    expect(scheduler.getStatus()[0].lastError).toBe('web returned HTTP 500');
  });
});

describe('createScheduler overdue detection', () => {
  /** A settable clock; starts at the given instant. */
  function createClock(startIso: string) {
    let currentMs = Date.parse(startIso);
    return {
      now: () => new Date(currentMs),
      set(iso: string) {
        currentMs = Date.parse(iso);
      },
    };
  }

  // Daily 05:00 UTC, 120 s timeout: overdue once 05:00 + 2 min + 5 min passes.
  const dailyJob = defineJob({ run: vi.fn().mockResolvedValue({ ok: true }) });

  it('is not overdue right after a restart, even past a slot that fired before it', () => {
    const { cron } = createFakeCron();
    const { logger } = createRecordingLogger();
    const clock = createClock('2026-09-26T09:00:00.000Z');

    const scheduler = createScheduler({ jobs: [dailyJob], config: baseConfig, cron, logger, now: clock.now });

    const status = scheduler.getStatus()[0];
    expect(status.expectedLastRunAt).toBe('2026-09-26T05:00:00.000Z');
    expect(status.overdue).toBe(false);
  });

  it('turns overdue when a slot passes the timeout plus grace with no run', () => {
    const { cron } = createFakeCron();
    const { logger } = createRecordingLogger();
    const clock = createClock('2026-09-26T09:00:00.000Z');
    const scheduler = createScheduler({ jobs: [dailyJob], config: baseConfig, cron, logger, now: clock.now });

    const graceEndsMs = Date.parse('2026-09-27T05:00:00.000Z') + dailyJob.timeoutMs + OVERDUE_GRACE_MS;

    clock.set(new Date(graceEndsMs).toISOString());
    expect(scheduler.getStatus()[0].overdue).toBe(false);

    clock.set(new Date(graceEndsMs + 60_000).toISOString());
    const status = scheduler.getStatus()[0];
    expect(status.expectedLastRunAt).toBe('2026-09-27T05:00:00.000Z');
    expect(status.overdue).toBe(true);
  });

  it('clears overdue once a tick starts at or after the expected slot', async () => {
    const { cron, registrations } = createFakeCron();
    const { logger } = createRecordingLogger();
    const clock = createClock('2026-09-26T09:00:00.000Z');
    const scheduler = createScheduler({ jobs: [dailyJob], config: baseConfig, cron, logger, now: clock.now });

    clock.set('2026-09-27T05:00:00.400Z');
    registrations[0].handler();
    await vi.waitFor(() => expect(scheduler.getStatus()[0].running).toBe(false));

    clock.set('2026-09-27T12:00:00.000Z');
    expect(scheduler.getStatus()[0].overdue).toBe(false);
  });

  it('flags a tick skipped behind a still-running predecessor once grace runs out', () => {
    const { cron, registrations } = createFakeCron();
    const { logger } = createRecordingLogger();
    const clock = createClock('2026-09-26T00:00:00.000Z');
    const scheduler = createScheduler({
      jobs: [
        defineJob({ name: 'refresh-sitemap-climbs', schedule: '0 */6 * * *', run: () => new Promise(() => undefined) }),
      ],
      config: baseConfig,
      cron,
      logger,
      now: clock.now,
    });

    clock.set('2026-09-26T00:00:00.300Z');
    registrations[0].handler();
    clock.set('2026-09-26T06:00:00.300Z');
    registrations[0].handler();
    expect(scheduler.getStatus()[0].skippedCount).toBe(1);

    // Still inside timeoutMs + grace (2 + 5 min) of the skipped 06:00 slot:
    // the in-flight run may yet be legitimately working, so nothing is flagged.
    clock.set('2026-09-26T06:07:00.000Z');
    expect(scheduler.getStatus()[0].overdue).toBe(false);

    clock.set('2026-09-26T06:07:01.000Z');
    expect(scheduler.getStatus()[0].overdue).toBe(true);
  });

  it('counts a run that started exactly on the slot as covering it', async () => {
    const { cron, registrations } = createFakeCron();
    const { logger } = createRecordingLogger();
    const clock = createClock('2026-09-26T09:00:00.000Z');
    const scheduler = createScheduler({ jobs: [dailyJob], config: baseConfig, cron, logger, now: clock.now });

    clock.set('2026-09-27T05:00:00.000Z');
    registrations[0].handler();
    await vi.waitFor(() => expect(scheduler.getStatus()[0].running).toBe(false));

    clock.set('2026-09-27T23:59:00.000Z');
    const status = scheduler.getStatus()[0];
    expect(status.lastRunAt).toBe(status.expectedLastRunAt);
    expect(status.overdue).toBe(false);
  });

  it('never marks a disabled job overdue', () => {
    const { cron } = createFakeCron();
    const { logger } = createRecordingLogger();
    const clock = createClock('2026-09-26T09:00:00.000Z');
    const scheduler = createScheduler({
      jobs: [dailyJob],
      config: { ...baseConfig, disabledJobs: ['cleanup'] },
      cron,
      logger,
      now: clock.now,
    });

    clock.set('2026-10-10T09:00:00.000Z');
    const status = scheduler.getStatus()[0];
    expect(status.overdue).toBe(false);
    expect(status.expectedLastRunAt).toBeNull();
  });

  it('never marks a job overdue in a one-shot run process', () => {
    const { cron } = createFakeCron();
    const { logger } = createRecordingLogger();
    const clock = createClock('2026-09-26T09:00:00.000Z');
    const scheduler = createScheduler({
      jobs: [dailyJob],
      config: baseConfig,
      cron,
      logger,
      registerSchedules: false,
      now: clock.now,
    });

    clock.set('2026-10-10T09:00:00.000Z');
    expect(scheduler.getStatus()[0].overdue).toBe(false);
  });
});
