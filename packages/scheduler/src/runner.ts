import type { SchedulerConfig } from './config';
import type { CronScheduler, CronTask } from './cron/scheduler';
import { describeError, type SchedulerLogger } from './logger';
import type { JobDefinition } from './jobs/types';

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
};

export type Scheduler = {
  /** Every known job, including ones held back by SCHEDULER_DISABLED_JOBS. */
  readonly jobs: readonly JobDefinition[];
  /** Jobs actually registered with the cron ticker. */
  readonly scheduledJobs: readonly JobDefinition[];
  getStatus(): JobStatus[];
  /** Runs one job now. Throws on failure — used by `scheduler run <job>`. */
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
}: CreateSchedulerOptions): Scheduler {
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

  const executeJob = async (job: JobDefinition): Promise<unknown> => {
    const state = stateByJobName.get(job.name);
    if (!state) {
      throw new Error(`no state for job ${job.name}`);
    }

    state.running = true;
    state.lastRunAt = new Date().toISOString();
    state.runCount += 1;
    const startedAt = Date.now();

    try {
      const result = await job.run({
        config,
        logger,
        timeoutMs: job.timeoutMs,
        shutdownSignal: shutdownController.signal,
      });
      state.lastDurationMs = Date.now() - startedAt;
      state.lastSuccessAt = new Date().toISOString();
      state.lastError = null;
      logger.info('job succeeded', { job: job.name, durationMs: state.lastDurationMs, result });
      return result;
    } catch (error) {
      state.lastDurationMs = Date.now() - startedAt;
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
        return;
      }

      logger.info('job tick', { job: job.name, schedule: job.schedule, timezone: job.timezone });
      // A throwing job must never escape into the cron callback — an unhandled
      // rejection here would take the whole scheduler process down.
      void executeJob(job).catch(() => undefined);
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
