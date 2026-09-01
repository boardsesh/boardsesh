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
  /**
   * Must tolerate running concurrently with itself. The runner skips a *tick*
   * whose predecessor is still in flight, but `scheduler run <job>` (the
   * operator's on-demand trigger) goes straight to `run` and deliberately does
   * not check that guard — an operator debugging a stuck job needs the run to
   * happen, not to be silently swallowed. So a job must either be idempotent
   * or safe to overlap; `cleanup` is both, because it deletes rows older than
   * a fixed age in batches and a second pass finds nothing left.
   */
  readonly run: JobRun;
};
