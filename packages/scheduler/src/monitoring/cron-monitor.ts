/**
 * Sentry cron monitors for scheduled job runs (#1876).
 *
 * `automaticVercelMonitors` only ever worked because Vercel handed Sentry the
 * cron metadata out of a deploy. Off Vercel there is no such metadata, so a job
 * that stops firing stops being observed — silently, which is the failure mode
 * this module exists to prevent.
 *
 * The important half is absence, not failure. A failing job already surfaces in
 * `/health/jobs` and in the logs; a job that never runs at all produces nothing
 * to look at. A Sentry monitor knows the schedule, so it can raise an issue for
 * an occurrence that never checked in — a dead container, a wrong `TZ`, a
 * ticker that stopped — none of which the process itself can report.
 */
import type { JobDefinition } from '../jobs/types';

/**
 * Monitor slugs must survive redeploys: Sentry keys a monitor's whole history
 * (schedule, past check-ins, open issues) on the slug, so a changed slug reads
 * as a brand-new monitor and abandons the old one still expecting check-ins.
 * Job names are asserted kebab-case in `registry.test.ts` for exactly this.
 */
export function monitorSlugForJob(jobName: string): string {
  return `scheduler-${jobName}`;
}

/**
 * Minutes a check-in may be late before Sentry calls the occurrence missed.
 *
 * The ticker fires on the minute, so anything late is a real fault (the
 * container is down, mid-redeploy, or its clock has drifted). Five minutes
 * absorbs a Railway deploy swap without swallowing an outage, and stays well
 * inside the 15-minute stagger between the heatmap prewarms.
 */
const CHECKIN_MARGIN_MINUTES = 5;

/**
 * Sentry expects `maxRuntime` in whole minutes. A run is already hard-bounded
 * by `timeoutMs`, so derive from that rather than inventing a second number,
 * and round up plus a minute: the check-in closes after the job returns, and a
 * `maxRuntime` that equals the timeout exactly would flag the slowest legal run
 * as a runtime failure.
 */
function maxRuntimeMinutes(timeoutMs: number): number {
  return Math.ceil(timeoutMs / 60_000) + 1;
}

/** The `MonitorConfig` shape Sentry upserts from the first check-in. */
export type CronMonitorConfig = {
  readonly schedule: { readonly type: 'crontab'; readonly value: string };
  readonly timezone: string;
  readonly checkinMargin: number;
  readonly maxRuntime: number;
  readonly failureIssueThreshold: number;
  readonly recoveryThreshold: number;
};

export function monitorConfigForJob(job: JobDefinition): CronMonitorConfig {
  return {
    // Sentry derives "when should the next check-in arrive" from this, which is
    // what makes a *missed* run detectable. It must be the registry's own
    // expression — a stale copy here would have Sentry waiting for the wrong
    // minute and reporting a healthy job as missed.
    schedule: { type: 'crontab', value: job.schedule },
    timezone: job.timezone,
    checkinMargin: CHECKIN_MARGIN_MINUTES,
    maxRuntime: maxRuntimeMinutes(job.timeoutMs),
    // These jobs are weekly. Waiting for a second consecutive failure before
    // filing an issue would mean hearing about a broken prewarm two weeks late,
    // so alert on the first one and clear on the first success.
    failureIssueThreshold: 1,
    recoveryThreshold: 1,
  };
}

export type CronMonitor = {
  /**
   * Runs `run` as one monitored occurrence of `job`. Must rethrow whatever
   * `run` throws — the runner's own bookkeeping and `/health/jobs` depend on
   * seeing the failure, and a monitor that swallowed it would leave the job
   * looking green everywhere except Sentry.
   */
  monitor<T>(job: JobDefinition, run: () => Promise<T>): Promise<T>;
};

/**
 * What the scheduler uses when `SENTRY_DSN` is unset — local runs, CI, and any
 * deployment that has deliberately not been given a DSN. Calls straight
 * through, so job behaviour is identical with and without monitoring.
 */
export const noopCronMonitor: CronMonitor = {
  monitor: (_job, run) => run(),
};

/** The one Sentry function this package needs; injected so tests can record it. */
export type WithMonitorFn = <T>(slug: string, callback: () => T, config: CronMonitorConfig) => T;

export function createCronMonitor(withMonitor: WithMonitorFn): CronMonitor {
  return {
    monitor: (job, run) => withMonitor(monitorSlugForJob(job.name), run, monitorConfigForJob(job)),
  };
}
