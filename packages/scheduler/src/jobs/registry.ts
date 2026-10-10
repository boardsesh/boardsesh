import { triggerWebCron } from './trigger-web-cron';
import { refreshGymActivityStats } from './refresh-gym-activity-stats';
import { purgeSprayWallPhotos } from './purge-spray-wall-photos';
import { purgeUserActivity, snapshotActiveUsers } from './active-users';
import { exportSprayTraining } from './export-spray-training';
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
 * The percentile route declares `maxDuration = 300`. That number is not a
 * measurement — it is Vercel's Pro ceiling, the largest value the platform
 * accepts, and the route was pinned to it precisely because there was nothing
 * higher to ask for.
 *
 * A long-lived container has no such ceiling, so the scheduler grants the real
 * headroom the work wanted: 15 minutes. While web still serves from Vercel the
 * route's own 300 s limit bites first and the scheduler simply observes the
 * resulting 504; once web moves to Railway (`WEB_DEPLOY_TARGETS`, #4648) the
 * `maxDuration` export goes inert and this timeout becomes the only bound.
 */
const WEEKLY_WARMUP_TIMEOUT_MS = 900_000;

/**
 * The climb sitemap refresh scans sixteen `(board_type, layout_id)` groups
 * sequentially — deliberately sequential, because concurrent `DISTINCT ON`
 * scans against a ten-connection pool is the #4461 starvation — and then writes
 * ~53,000 URL rows in 1,000-row chunks inside one transaction. Measured on the
 * full-board dev image the largest single group alone is 16.7 s cold, and the
 * whole build was 51 s in production (#4552).
 *
 * The route still exports `maxDuration = 300`, so on Vercel it would be cut off
 * first; off Vercel that export is inert and this is the only bound. 15 minutes
 * — the same headroom the weekly percentile recompute gets — leaves a cold, contended run
 * room to finish rather than turning a slow refresh into a failed one, and a
 * genuinely wedged scan still cannot outlive the six-hour gap to the next tick.
 */
const SITEMAP_REFRESH_TIMEOUT_MS = 900_000;
const GYM_ACTIVITY_REFRESH_TIMEOUT_MS = 900_000;

/**
 * The spray wall photo purge lists and deletes object-storage keys for up to 200
 * walls per run, one round trip per object. Nothing here scans a large table —
 * the candidate query is an index read on `spray_walls_deleted_at_idx`, the
 * partial index on `deleted_at IS NOT NULL` — so the bound is R2's latency, not
 * the database's. Ten minutes is well past a realistic batch — the whole run is a
 * few hundred DELETEs against R2 — and short enough that a wedged storage
 * endpoint cannot hold a worker until the next day's tick.
 *
 * The deletes inside one wall's prefix are serial on purpose: a wall is a handful
 * of objects (one photo plus one variant per version), 200 of them is still only
 * hundreds of round trips, and fanning them out would trade a bounded run for R2
 * rate-limit retries. A run that does not finish its batch is not a data loss —
 * nothing was cleared for the walls it did not reach, so tomorrow's run takes
 * them.
 */
const SPRAY_PHOTO_PURGE_TIMEOUT_MS = 600_000;

/**
 * The active-user snapshot is six `count(DISTINCT user_id)` reads over at most
 * 30 days of `user_activity_days` (one row per signed-in climber per day per
 * platform) through its `day` index, and the retention purge deletes about one
 * day's rows. Both finish in seconds; ten minutes is headroom for a cold,
 * contended primary, short enough that a wedged backend can't hold the run
 * until the next day's tick.
 */
const ACTIVE_USERS_TIMEOUT_MS = 600_000;

/**
 * The spray training export copies every approved version's `photo_key` inside
 * the private bucket and writes a few JSON files, one object at a time. That
 * key is the BASE photo: at most 2048 px on its long side, re-encoded as JPEG
 * on upload (`handlers/spray-wall-photos.ts` in the backend), never the
 * full-resolution copy. Its database reads are bounded by the approved set,
 * which an admin builds by hand.
 *
 * Fifteen minutes is the ceiling this job is allowed, not the time a run has.
 * The request ends sooner. On the default backend URL it passes through the
 * Cloudflare proxy, whose origin cap is 100 seconds (a 524, which is not
 * retried); on any URL, Node's own `fetch` gives up after 300 seconds without
 * response headers. Either way the job reports a failed run while the backend
 * keeps writing, up to its own 12-minute deadline; a run that passes that
 * writes no manifest, so the half-written export is ignored by the ML fetch
 * and deleted by the next run. docs/scheduler.md, "Spray wall training
 * export", has the table and where the 100 seconds comes from.
 */
const SPRAY_TRAINING_EXPORT_TIMEOUT_MS = 900_000;

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

  {
    name: 'profile-percentiles',
    // Sunday 06:00 UTC.
    schedule: '0 6 * * 0',
    timezone: 'UTC',
    timeoutMs: WEEKLY_WARMUP_TIMEOUT_MS,
    webPath: '/api/internal/profile-percentiles',
    run: triggerWebCron('/api/internal/profile-percentiles'),
  },

  // The one job that missed the #4654 migration. Vercel ran this cron at
  // `0 */6 * * *` from 2026-08-22 until the pause deleted the row on 2026-08-29
  // (`git show 98ef8e32b -- packages/web/vercel.json`), so by the time the crons
  // moved to the scheduler there was nothing left in `vercel.json` to carry
  // over. #4648 republishes the surface and brings the same slot back here.
  // docs/sitemap.md's runbook used to call for a separate one-shot Railway cron
  // service — this is that service, except it already exists, already has a
  // Sentry monitor, and already has a disable switch.
  //
  // Overlap-safe, which JobDefinition requires: the refresher takes
  // `pg_try_advisory_xact_lock` as the first statement of its write
  // transaction, so a second run that meets a first in flight answers
  // `skipped: "locked"` and writes nothing.
  {
    name: 'refresh-sitemap-climbs',
    // Six-hourly, the slot Vercel ran this on, against a shard whose pages the
    // CDN holds for six hours anyway.
    schedule: '0 */6 * * *',
    // Load-bearing for the same reason as every row above: a container's local
    // zone is not guaranteed to be UTC, and `0 */6 * * *` evaluated somewhere
    // else drifts the refresh off the window the cache expiry assumes.
    timezone: 'UTC',
    timeoutMs: SITEMAP_REFRESH_TIMEOUT_MS,
    webPath: '/api/internal/refresh-sitemap-climbs',
    // The only job with a Sentry cron monitor. Sentry bills per monitor, not
    // per check-in, and every job shares one ticker, so the most frequent job
    // is the cheapest canary: a dead ticker, container or clock misses a
    // six-hourly check-in within six hours, where the daily `cleanup` would
    // take up to a day. The other jobs' missed runs show up as `overdue` on
    // `/health/jobs`.
    sentryMonitor: true,
    run: triggerWebCron('/api/internal/refresh-sitemap-climbs'),
  },

  // Overlap-safe, which JobDefinition requires: the rebuild takes
  // `pg_try_advisory_xact_lock` as the first statement of its write
  // transaction, so a second run meeting a first in flight answers
  // `skipped: "locked"` and writes nothing.
  {
    name: 'refresh-gym-activity-stats',
    // Daily at 06:30 UTC — after the 06:00 Sunday percentile recompute rather
    // than alongside it, so two full-table scans never contend for database
    // time on the one morning they would otherwise share.
    schedule: '30 6 * * *',
    // Load-bearing for the same reason as every row above: a container's local
    // zone is not guaranteed to be UTC.
    timezone: 'UTC',
    timeoutMs: GYM_ACTIVITY_REFRESH_TIMEOUT_MS,
    run: refreshGymActivityStats,
  },

  // Storage retention for deleted spray walls (epic #5346 / SW-17): 30 days after
  // an owner deletes a wall, its photographs go. Daily, because the window is
  // measured in days and there is nothing to gain from checking more often.
  //
  // Overlap-safe, which JobDefinition requires: the mutation deletes objects and
  // then clears `photo_key`, so a second run meeting a first re-lists prefixes
  // that are already empty, deletes nothing twice, and never fails on a missing
  // object.
  {
    name: 'purge-spray-wall-photos',
    // 07:00 UTC — after the 06:30 gym activity rebuild rather than alongside it,
    // so the two daily jobs never share a tick.
    schedule: '0 7 * * *',
    // Load-bearing for the same reason as every row above: a container's local
    // zone is not guaranteed to be UTC.
    timezone: 'UTC',
    timeoutMs: SPRAY_PHOTO_PURGE_TIMEOUT_MS,
    run: purgeSprayWallPhotos,
  },

  // First-party active users (#2644, docs/analytics-consent.md): yesterday's
  // DAU and the trailing WAU/MAU from `user_activity_days`, sent to PostHog as
  // one aggregate event. Counted whatever climbers' analytics consent, which is
  // why it is the canonical MAU in docs/growth-metrics.md.
  //
  // Overlap-safe, which JobDefinition requires: the counts are reads, and the
  // event's uuid is derived from the day, so a second send collapses into the
  // first in PostHog.
  {
    name: 'snapshot-active-users',
    // 00:20 UTC: yesterday is complete, and twenty minutes clear of the
    // 00:00 sitemap refresh so the two never start on the same tick.
    schedule: '20 0 * * *',
    // Load-bearing: "yesterday" is a UTC day, and so is the schedule.
    timezone: 'UTC',
    timeoutMs: ACTIVE_USERS_TIMEOUT_MS,
    run: snapshotActiveUsers,
  },

  // Retention for `user_activity_days`: rows older than 13 months go. Daily,
  // so the table never holds more than a day past the window.
  //
  // Overlap-safe, which JobDefinition requires: a second run finds nothing
  // older than the cutoff and deletes nothing.
  {
    name: 'purge-user-activity',
    // 07:30 UTC — after the 07:00 spray wall photo purge rather than alongside it.
    schedule: '30 7 * * *',
    // Load-bearing for the same reason as every row above: a container's local
    // zone is not guaranteed to be UTC.
    timezone: 'UTC',
    timeoutMs: ACTIVE_USERS_TIMEOUT_MS,
    run: purgeUserActivity,
  },

  // The spray wall training set (SW-20, #5471). Every six hours, because the
  // promise to a climber who switches "Help train hold finding" off is that
  // their wall leaves every stored export within 24 hours, and each run retires
  // before it writes. Once a day would leave that promise no slack: a switch
  // flipped a second after the run read the walls waits the full 24 hours, and
  // one failed run makes it 48. At six hours it survives two failed runs in a
  // row.
  //
  // Four runs a day cost little. A run that finds nothing stale and nothing
  // changed reads the approved set and the stored exports' manifests (two
  // exports are kept), then answers `skipped: true` without downloading a
  // photo or writing an object.
  //
  // Overlap-safe, which JobDefinition requires: the mutation holds a lease row
  // for the whole run, so a second run meeting a first writes nothing (and this
  // job reports it as a failure, so a stuck run is seen).
  {
    name: 'export-spray-training',
    // 02:00, 08:00, 14:00 and 20:00 UTC, clear of every other job's tick. The
    // 08:00 one is an hour after the 07:00 photo purge, so a wall purged today
    // is already photo-less (and so ineligible) when that run reads it.
    schedule: '0 2,8,14,20 * * *',
    // Load-bearing for the same reason as every row above: a container's local
    // zone is not guaranteed to be UTC.
    timezone: 'UTC',
    timeoutMs: SPRAY_TRAINING_EXPORT_TIMEOUT_MS,
    run: exportSprayTraining,
  },
];

export function findJob(jobName: string): JobDefinition | undefined {
  return JOBS.find((job) => job.name === jobName);
}
