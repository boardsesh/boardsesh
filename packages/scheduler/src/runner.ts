import type { SchedulerConfig } from './config';
import { parseCronExpression } from './cron/expression';
import { createPreviousRunFinder } from './cron/previous-run';
import type { CronScheduler, CronTask } from './cron/scheduler';
import { describeError, type SchedulerLogger } from './logger';
import type { JobDefinition } from './jobs/types';
import { noopCronMonitor, type CronMonitor } from './monitoring/cron-monitor';

export type JobStatus = {
  readonly name: string;
  readonly schedule: string;
  readonly timezone: string;
  readonly scheduled: boolean;
  readonly running: boolean;
  readonly lastRunAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly lastDurationMs: number | null;
  readonly lastError: string | null;
  readonly runCount: number;
  readonly failureCount: number;
  readonly skippedCount: number;
  /**
   * The most recent instant the schedule says this job should have started,
   * or null for a disabled job (or when the schedule has no occurrence in the
   * last 8 days).
   */
  readonly expectedLastRunAt: string | null;
  /**
   * True when {@link expectedLastRunAt} passed more than the job's
   * `timeoutMs` plus 5 minutes ago and no run has started since — the ticker
   * missed it. Always false for a disabled job.
   */
  readonly overdue: boolean;
};

/**
 * How late past its own `timeoutMs` a scheduled run may be before the job
 * counts as overdue. Five minutes is the same margin the Sentry monitor gives a
 * check-in: enough to ride out a Railway deploy swap.
 */
export const OVERDUE_GRACE_MS = 5 * 60_000;

export type Scheduler = {
  /** Every known job, including ones held back by SCHEDULER_DISABLED_JOBS. */
  readonly jobs: readonly JobDefinition[];
  /** Jobs actually registered with the cron ticker. */
  readonly scheduledJobs: readonly JobDefinition[];
  getStatus(): JobStatus[];
  /**
   * Runs one job now. Throws on failure — used by `scheduler run <job>`.
   *
   * Bypasses the tick-level in-flight guard on purpose: an operator asking for
   * a run gets one even if a scheduled run is still going. `JobDefinition.run`
   * documents the contract that makes that safe.
   *
   * Because it records `lastRunAt` on this instance, a call here clears an
   * `overdue` flag. The `scheduler run <job>` CLI does not: it runs in its own
   * process and never sees the ticking instance's state (docs/scheduler.md,
   * "Health endpoints").
   */
  runJob(jobName: string): Promise<unknown>;
  stop(): void;
};

export type CreateSchedulerOptions = {
  readonly jobs: readonly JobDefinition[];
  readonly config: SchedulerConfig;
  readonly cron: CronScheduler;
  readonly logger: SchedulerLogger;
  /**
   * Set false for the one-shot `scheduler run <job>` path so an operator's
   * manual run can never also start the recurring schedule. Defaults to true.
   */
  readonly registerSchedules?: boolean;
  /**
   * Reports each *scheduled* run of a job flagged `sentryMonitor` to a Sentry
   * cron monitor. Defaults to a no-op,
   * which is what `scheduler run <job>` and every test get: a manual run is not
   * a scheduled occurrence, and checking one in would mark a genuinely missed
   * occurrence as healthy.
   */
  readonly monitor?: CronMonitor;
  /**
   * Clock for run timestamps and overdue checks. Injected for tests; defaults
   * to the wall clock. Read once at creation as the process start, so a job
   * whose slot passed before a restart is not reported overdue.
   */
  readonly now?: () => Date;
};

type MutableJobState = {
  running: boolean;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastDurationMs: number | null;
  lastError: string | null;
  runCount: number;
  failureCount: number;
  skippedCount: number;
};

function createInitialState(): MutableJobState {
  return {
    running: false,
    lastRunAt: null,
    lastSuccessAt: null,
    lastDurationMs: null,
    lastError: null,
    runCount: 0,
    failureCount: 0,
    skippedCount: 0,
  };
}

export function createScheduler({
  jobs,
  config,
  cron,
  logger,
  registerSchedules = true,
  monitor = noopCronMonitor,
  now = () => new Date(),
}: CreateSchedulerOptions): Scheduler {
  const processStartedAt = now();
  const duplicateName = jobs.find((job, index) => jobs.findIndex((other) => other.name === job.name) !== index);
  if (duplicateName) {
    throw new Error(`duplicate job name ${JSON.stringify(duplicateName.name)}`);
  }

  const stateByJobName = new Map<string, MutableJobState>(jobs.map((job) => [job.name, createInitialState()]));
  const shutdownController = new AbortController();
  const tasks: CronTask[] = [];

  const disabledJobNames = new Set(config.disabledJobs);
  const unknownDisabled = [...disabledJobNames].filter((jobName) => !jobs.some((job) => job.name === jobName));
  if (unknownDisabled.length > 0) {
    logger.warn('SCHEDULER_DISABLED_JOBS names no such job', { jobs: unknownDisabled });
  }

  const scheduledJobs = jobs.filter((job) => !disabledJobNames.has(job.name));
  // Only the jobs this instance actually ticks can be overdue: a one-shot
  // `scheduler run <job>` process registers nothing, so nothing is due.
  // One memoised finder per job: `/health` is polled every few seconds, and a
  // cold walk back to last Sunday costs ~10,000 `Intl` formats.
  const findPreviousRunByJobName = new Map<string, (currentTime: Date) => Date | null>(
    (registerSchedules ? scheduledJobs : []).map((job) => [
      job.name,
      createPreviousRunFinder(parseCronExpression(job.schedule), job.timezone),
    ]),
  );

  const describeSchedulePosition = (job: JobDefinition, state: MutableJobState) => {
    const findPreviousRun = findPreviousRunByJobName.get(job.name);
    if (!findPreviousRun) {
      return { expectedLastRunAt: null, overdue: false };
    }
    const currentTime = now();
    const expectedLastRun = findPreviousRun(currentTime);
    if (!expectedLastRun) {
      return { expectedLastRunAt: null, overdue: false };
    }
    // A run that started at or after the expected slot covers it; so does a
    // process that started after it (a fresh restart has no history to judge).
    const lastStartedMs = state.lastRunAt === null ? processStartedAt.getTime() : Date.parse(state.lastRunAt);
    const missedSlot = lastStartedMs < expectedLastRun.getTime();
    const pastGrace = currentTime.getTime() - expectedLastRun.getTime() > job.timeoutMs + OVERDUE_GRACE_MS;
    return { expectedLastRunAt: expectedLastRun.toISOString(), overdue: missedSlot && pastGrace };
  };

  const executeJob = async (job: JobDefinition): Promise<unknown> => {
    const state = stateByJobName.get(job.name);
    if (!state) {
      throw new Error(`no state for job ${job.name}`);
    }

    state.running = true;
    const startedAt = now().getTime();
    state.lastRunAt = new Date(startedAt).toISOString();
    state.runCount += 1;

    try {
      const result = await job.run({
        config,
        logger,
        timeoutMs: job.timeoutMs,
        shutdownSignal: shutdownController.signal,
      });
      const finishedAt = now().getTime();
      state.lastDurationMs = finishedAt - startedAt;
      state.lastSuccessAt = new Date(finishedAt).toISOString();
      state.lastError = null;
      logger.info('job succeeded', { job: job.name, durationMs: state.lastDurationMs, result });
      return result;
    } catch (error) {
      state.lastDurationMs = now().getTime() - startedAt;
      state.lastError = describeError(error);
      state.failureCount += 1;
      logger.error('job failed', { job: job.name, durationMs: state.lastDurationMs, error: state.lastError });
      throw error;
    } finally {
      state.running = false;
    }
  };

  for (const job of registerSchedules ? scheduledJobs : []) {
    const handler = () => {
      const state = stateByJobName.get(job.name);
      if (state?.running) {
        state.skippedCount += 1;
        logger.warn('job tick skipped; previous run still in flight', { job: job.name, schedule: job.schedule });
        // No check-in on purpose. A skipped tick did not run, so letting Sentry
        // record the occurrence as missed is the honest outcome — a job slow
        // enough to overrun its own interval is worth an issue, and an "ok"
        // check-in here would report a stuck job as healthy.
        return;
      }

      logger.info('job tick', { job: job.name, schedule: job.schedule, timezone: job.timezone });
      // A throwing job must never escape into the cron callback — an unhandled
      // rejection here would take the whole scheduler process down. The monitor
      // still sees the rejection first: it wraps executeJob, and .catch() is
      // applied to the wrapper's result, not to executeJob directly.
      //
      // Only jobs flagged `sentryMonitor` are wrapped: each Sentry monitor is
      // billed, so one job keeps it as the canary that the ticker is alive and
      // the rest rely on `overdue` in `/health/jobs`.
      const run = job.sentryMonitor === true ? monitor.monitor(job, () => executeJob(job)) : executeJob(job);
      void run.catch(() => undefined);
    };

    tasks.push(cron.schedule(job.schedule, handler, { timezone: job.timezone }));
    logger.info('job scheduled', { job: job.name, schedule: job.schedule, timezone: job.timezone });
  }

  if (registerSchedules) {
    for (const jobName of disabledJobNames) {
      if (jobs.some((job) => job.name === jobName)) {
        logger.warn('job disabled by SCHEDULER_DISABLED_JOBS', { job: jobName });
      }
    }
  }

  return {
    jobs,
    scheduledJobs,
    getStatus() {
      return jobs.map((job) => {
        const state = stateByJobName.get(job.name) ?? createInitialState();
        return {
          name: job.name,
          schedule: job.schedule,
          timezone: job.timezone,
          scheduled: !disabledJobNames.has(job.name),
          running: state.running,
          lastRunAt: state.lastRunAt,
          lastSuccessAt: state.lastSuccessAt,
          lastDurationMs: state.lastDurationMs,
          lastError: state.lastError,
          runCount: state.runCount,
          failureCount: state.failureCount,
          skippedCount: state.skippedCount,
          ...describeSchedulePosition(job, state),
        };
      });
    },
    async runJob(jobName) {
      const job = jobs.find((candidate) => candidate.name === jobName);
      if (!job) {
        const knownNames = jobs.map((candidate) => candidate.name).join(', ');
        throw new Error(`unknown job ${JSON.stringify(jobName)}; known jobs: ${knownNames}`);
      }
      return executeJob(job);
    },
    stop() {
      shutdownController.abort(new Error('scheduler stopping'));
      for (const task of tasks) {
        task.stop();
      }
      tasks.length = 0;
    },
  };
}
