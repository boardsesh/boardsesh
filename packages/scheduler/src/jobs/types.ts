import type { SchedulerConfig } from '../config';
import type { SchedulerLogger } from '../logger';

export type JobContext = {
  readonly config: SchedulerConfig;
  readonly logger: SchedulerLogger;
  /** Hard ceiling for a single run, from the job definition. */
  readonly timeoutMs: number;
  /** Aborted when the process is shutting down. */
  readonly shutdownSignal?: AbortSignal;
};

export type JobRun = (context: JobContext) => Promise<unknown>;

export type JobDefinition = {
  readonly name: string;
  /** Standard 5-field cron expression. */
  readonly schedule: string;
  /** IANA timezone the schedule is evaluated in. */
  readonly timezone: string;
  readonly timeoutMs: number;
  /**
   * The `/api/internal/*` path this job triggers, when it is an HTTP trigger.
   * Used by the drift guard that keeps a path from being scheduled both here
   * and in `packages/web/vercel.json`.
   */
  readonly webPath?: string;
  readonly run: JobRun;
};
