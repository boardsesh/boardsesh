import { triggerWebCron } from './trigger-web-cron';
import type { JobDefinition } from './types';

/**
 * `/api/internal/*` cron paths still owned by `packages/web/vercel.json`.
 *
 * Now empty: every cron has moved here, and `vercel.json` no longer declares a
 * `crons` key at all. The list stays because `registry.test.ts` diffs it
 * against the real vercel.json and against {@link JOBS} — with both sides
 * empty, re-adding a schedule on the Vercel side without dropping the job here
 * fails CI instead of leaving a job double-scheduled.
 *
 * `vercel.json` itself outlives this: it is deleted in the Phase 4 scrub
 * (#4648), not here.
 */
export const VERCEL_OWNED_CRON_PATHS: readonly string[] = [];

// `/api/internal/cleanup` declares `maxDuration = 60`; give the request room to
// finish plus headroom rather than cutting a legitimate run short.
const CLEANUP_TIMEOUT_MS = 120_000;

/**
 * The heatmap prewarm and percentile routes both declare `maxDuration = 300`.
 * That number is not a measurement — it is Vercel's Pro ceiling, the largest
 * value the platform accepts, and both routes were pinned to it precisely
 * because there was nothing higher to ask for.
 *
 * A long-lived container has no such ceiling, so the scheduler grants the real
 * headroom the work wanted: 15 minutes. While web still serves from Vercel the
 * route's own 300 s limit bites first and the scheduler simply observes the
 * resulting 504; once web moves to Railway (`WEB_DEPLOY_TARGETS`, #4648) the
 * `maxDuration` export goes inert and this timeout becomes the only bound.
 */
const WEEKLY_WARMUP_TIMEOUT_MS = 900_000;

export const JOBS: readonly JobDefinition[] = [
  {
    name: 'cleanup',
    // Same slot the Vercel cron used: 05:00 UTC daily.
    schedule: '0 5 * * *',
    // Load-bearing: Vercel crons are UTC and a container's local zone is not
    // guaranteed to be. Without this the job silently drifts off its slot.
    timezone: 'UTC',
    timeoutMs: CLEANUP_TIMEOUT_MS,
    webPath: '/api/internal/cleanup',
    run: triggerWebCron('/api/internal/cleanup'),
  },

  // The five heatmap prewarms keep the 15-minute stagger vercel.json used.
  // They are not independent of each other: each one hammers the same Postgres
  // with a fan-out of heatmap aggregates, and firing them together would put
  // five boards' worth of that load on the database at once. The stagger is the
  // rate limit.
  {
    name: 'prewarm-heatmap-kilter',
    schedule: '0 4 * * 0',
    timezone: 'UTC',
    timeoutMs: WEEKLY_WARMUP_TIMEOUT_MS,
    webPath: '/api/internal/prewarm-heatmap/kilter',
    run: triggerWebCron('/api/internal/prewarm-heatmap/kilter'),
  },
  {
    name: 'prewarm-heatmap-tension',
    schedule: '15 4 * * 0',
    timezone: 'UTC',
    timeoutMs: WEEKLY_WARMUP_TIMEOUT_MS,
    webPath: '/api/internal/prewarm-heatmap/tension',
    run: triggerWebCron('/api/internal/prewarm-heatmap/tension'),
  },
  {
    name: 'prewarm-heatmap-decoy',
    schedule: '30 4 * * 0',
    timezone: 'UTC',
    timeoutMs: WEEKLY_WARMUP_TIMEOUT_MS,
    webPath: '/api/internal/prewarm-heatmap/decoy',
    run: triggerWebCron('/api/internal/prewarm-heatmap/decoy'),
  },
  {
    name: 'prewarm-heatmap-touchstone',
    schedule: '45 4 * * 0',
    timezone: 'UTC',
    timeoutMs: WEEKLY_WARMUP_TIMEOUT_MS,
    webPath: '/api/internal/prewarm-heatmap/touchstone',
    run: triggerWebCron('/api/internal/prewarm-heatmap/touchstone'),
  },
  {
    name: 'prewarm-heatmap-grasshopper',
    schedule: '0 5 * * 0',
    timezone: 'UTC',
    timeoutMs: WEEKLY_WARMUP_TIMEOUT_MS,
    webPath: '/api/internal/prewarm-heatmap/grasshopper',
    run: triggerWebCron('/api/internal/prewarm-heatmap/grasshopper'),
  },
  {
    name: 'profile-percentiles',
    // Sunday 06:00 UTC — an hour after the last prewarm, so the recompute does
    // not contend with the heatmap warm-up for database time.
    schedule: '0 6 * * 0',
    timezone: 'UTC',
    timeoutMs: WEEKLY_WARMUP_TIMEOUT_MS,
    webPath: '/api/internal/profile-percentiles',
    run: triggerWebCron('/api/internal/profile-percentiles'),
  },
];

export function findJob(jobName: string): JobDefinition | undefined {
  return JOBS.find((job) => job.name === jobName);
}
