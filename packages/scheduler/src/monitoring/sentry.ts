/**
 * Sentry wiring for the scheduler process.
 *
 * Deliberately split from `cron-monitor.ts`, which is pure and takes the one
 * Sentry function it needs as a parameter. Only this module imports the SDK, so
 * the rest of the package (and every test) stays free of a global init.
 */
import * as Sentry from '@sentry/node';
import type { SchedulerLogger } from '../logger';
import { createCronMonitor, noopCronMonitor, type CronMonitor } from './cron-monitor';

export type SetupCronMonitoringOptions = {
  readonly env?: NodeJS.ProcessEnv;
  readonly logger: SchedulerLogger;
};

const DEFAULT_SENTRY_ENVIRONMENT = 'production';

/**
 * Initialises Sentry and returns the monitor the runner should use.
 *
 * Unlike `packages/web` and `packages/backend`, there is **no hardcoded DSN
 * fallback**. Those two run only where we deploy them; the scheduler CLI is
 * also what an operator runs by hand against production (`scheduler run
 * cleanup`, see docs/scheduler.md), and a baked-in DSN would file that
 * laptop's output against the production project. An unset `SENTRY_DSN` is a
 * supported configuration, not a mistake — so it degrades to a no-op monitor
 * and says so once, rather than throwing.
 *
 * Call exactly once, from `scheduler start`. The one-shot `run <job>` path
 * never calls it: a manual run is not a scheduled occurrence, and checking it
 * in would either resolve a genuinely missed occurrence or, worse, teach the
 * monitor that the job is healthy while the ticker is dead.
 */
export function setupCronMonitoring({ env = process.env, logger }: SetupCronMonitoringOptions): CronMonitor {
  const dsn = env.SENTRY_DSN?.trim();
  if (!dsn) {
    logger.warn('SENTRY_DSN is not set; scheduler cron monitors are disabled', {
      hint: 'Set SENTRY_DSN to the same DSN packages/web uses server-side to get missed-run alerts.',
    });
    return noopCronMonitor;
  }

  const environment = env.SENTRY_ENVIRONMENT?.trim() || DEFAULT_SENTRY_ENVIRONMENT;
  Sentry.init({
    dsn,
    environment,
    // Matches the backend.
    enableLogs: true,
    // Trace every run. The rates on web and backend are a budget problem —
    // millions of requests a month against a ~3M span/month ceiling. This
    // process makes roughly 30 job runs a month, so 100% of them is a rounding
    // error against that ceiling, and any lower rate would leave a job with no
    // samples at all in the month it went wrong.
    //
    // (This replaces a comment claiming tracing here would be noise. It was
    // written when nothing in the fleet emitted spans, so a scheduler trace
    // would have been an island. Now that web and backend are traced, a job's
    // outbound call to /api/internal/prewarm-heatmap/* — which has a 15-minute
    // timeout — is exactly the thing that needs a duration on it. The cron
    // check-in only records that a run finished, not how close to that ceiling
    // it came; the span is the warning before the timeout.)
    tracesSampleRate: 1.0,
    serverName: 'boardsesh-scheduler',
  });

  logger.info('sentry cron monitors enabled', { environment });
  return createCronMonitor(
    // Sentry's withMonitor is generic over the callback's return type; the
    // narrower WithMonitorFn signature is what the runner actually needs.
    (slug, callback, config) => Sentry.withMonitor(slug, callback, config),
  );
}
