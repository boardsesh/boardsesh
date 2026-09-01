import { triggerWebCron } from './trigger-web-cron';
import type { JobDefinition } from './types';

/**
 * `/api/internal/*` cron paths still owned by `packages/web/vercel.json`.
 *
 * This is a checked-in mirror of that file's `crons` array, minus whatever has
 * already moved here. `registry.test.ts` diffs it against the real vercel.json
 * and against {@link JOBS}, so a migration PR that only edits one side fails
 * CI instead of leaving a job double-scheduled or unscheduled.
 */
export const VERCEL_OWNED_CRON_PATHS: readonly string[] = [
  '/api/internal/prewarm-heatmap/kilter',
  '/api/internal/prewarm-heatmap/tension',
  '/api/internal/prewarm-heatmap/decoy',
  '/api/internal/prewarm-heatmap/touchstone',
  '/api/internal/prewarm-heatmap/grasshopper',
  '/api/internal/profile-percentiles',
];

// `/api/internal/cleanup` declares `maxDuration = 60`; give the request room to
// finish plus headroom rather than cutting a legitimate run short.
const CLEANUP_TIMEOUT_MS = 120_000;

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
];

export function findJob(jobName: string): JobDefinition | undefined {
  return JOBS.find((job) => job.name === jobName);
}
