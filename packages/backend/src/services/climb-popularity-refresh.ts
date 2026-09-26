/**
 * Keeps `board_climb_popularity`, the popular sort's ranking table, in step
 * with `board_climb_stats` (docs/climb-popularity.md).
 *
 * - **Hourly, on the job queue.** `CLIMB_POPULARITY_REFRESH_QUEUE` is created by
 *   the migrator with the `exclusive` policy, so one run is queued or running
 *   across every replica.
 * - **Incremental most hours.** A run re-reads only the climbs whose stats
 *   changed since the last run, through `board_climb_stats_sync_cursor_idx`.
 *   A board's first run, and one run a week after that, is a full pass.
 * - **A deploy costs nothing.** Nothing runs on boot. Until a board's first full
 *   pass finishes, the popular sort keeps its old aggregation for that board.
 */
import type { PgBoss } from 'pg-boss';
import { CLIMB_POPULARITY_REFRESH_QUEUE } from '@boardsesh/db/job-queue-schema';
import { refreshClimbPopularity } from '@boardsesh/db/queries';
import { db } from '../db/client';
import { logger } from '../utils/logger';

/** Every hour at :23, away from the :00 and :17 jobs. */
export const CLIMB_POPULARITY_REFRESH_CRON = '23 * * * *';

/**
 * A run stops starting new statements after this long. It sits under the
 * queue's 1,800 s expiry, so pg-boss never expires a live run and starts a
 * second one beside it. A stopped full pass leaves `full_built_at` alone and
 * the next run starts it again.
 */
export const CLIMB_POPULARITY_RUN_BUDGET_MS = 25 * 60 * 1000;

/** The body of the refresh job. Throws on a database error so pg-boss retries. */
export async function runClimbPopularityRefresh(): Promise<void> {
  const deadline = Date.now() + CLIMB_POPULARITY_RUN_BUDGET_MS;
  const results = await refreshClimbPopularity(db, {
    shouldContinue: () => Date.now() < deadline,
  });
  for (const result of results) {
    if (result.mode === 'empty') continue;
    logger.info('[ClimbPopularity] Refreshed', result);
  }
}

export async function startClimbPopularityRefresh(boss: PgBoss): Promise<void> {
  await boss.schedule(CLIMB_POPULARITY_REFRESH_QUEUE, CLIMB_POPULARITY_REFRESH_CRON, null, { tz: 'UTC' });
  await boss.work(CLIMB_POPULARITY_REFRESH_QUEUE, async () => {
    await runClimbPopularityRefresh();
  });
}
