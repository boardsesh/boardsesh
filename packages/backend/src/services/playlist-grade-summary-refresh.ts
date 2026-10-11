/**
 * Keeps `playlist_grade_summaries` (the grade band on playlist cards and
 * Discover's grade filter) in step with grades that drift under it
 * (docs/playlist-grade-summaries.md).
 *
 * - **Daily, on the job queue.** `PLAYLIST_GRADE_SUMMARY_REFRESH_QUEUE` is
 *   created by the migrator with the `exclusive` policy, so one run is queued
 *   or running across every replica.
 * - **Every playlist, every run.** A run walks every playlist in id order and
 *   writes only the summaries whose values moved, so an unchanged night costs
 *   reads and no writes.
 * - **The first backfill.** While the table is empty, registering the job also
 *   queues one run now instead of waiting for the next 07:41 UTC. Once any
 *   summary exists nothing more runs on boot. The `exclusive` queue collapses
 *   every replica's request into one run.
 */
import type { PgBoss } from 'pg-boss';
import { PLAYLIST_GRADE_SUMMARY_REFRESH_QUEUE } from '@boardsesh/db/job-queue-schema';
import { refreshAllPlaylistGradeSummaries } from '@boardsesh/db/queries';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../db/client';
import { logger } from '../utils/logger';

/**
 * Daily at 07:41 UTC: after the 06:00 `refresh-recommendations` run (which
 * recomputes its cohort playlists' bands itself; this run repairs any it had
 * to skip), and clear of the 06:15-07:15 nightlies and the :00, :17 and :23 jobs.
 */
export const PLAYLIST_GRADE_SUMMARY_REFRESH_CRON = '41 7 * * *';

/**
 * A run stops starting new chunks after this long, under the queue's 1,800 s
 * expiry, so pg-boss never expires a live run and starts a second beside it.
 * A stopped run is picked up by the next day's, which starts from the top.
 */
export const PLAYLIST_GRADE_SUMMARY_RUN_BUDGET_MS = 25 * 60 * 1000;

/** The body of the refresh job. Throws on a database error so pg-boss retries. */
export async function runPlaylistGradeSummaryRefresh(): Promise<void> {
  const deadline = Date.now() + PLAYLIST_GRADE_SUMMARY_RUN_BUDGET_MS;
  const result = await refreshAllPlaylistGradeSummaries(db, {
    shouldContinue: () => Date.now() < deadline,
  });
  if (!result.completed) {
    // Every run starts from the first playlist, so a pass that keeps hitting
    // the budget never reaches the playlists past where it stops. Loud on
    // purpose: that is the signal to add a resume cursor.
    logger.error('[PlaylistGradeSummaries] Refresh stopped at its time budget before the last playlist', result);
    return;
  }
  logger.info('[PlaylistGradeSummaries] Refreshed', result);
}

async function summariesAreEmpty(): Promise<boolean> {
  const rows = await db
    .select({ playlistId: dbSchema.playlistGradeSummaries.playlistId })
    .from(dbSchema.playlistGradeSummaries)
    .limit(1);
  return rows.length === 0;
}

export async function startPlaylistGradeSummaryRefresh(boss: PgBoss): Promise<void> {
  await boss.schedule(PLAYLIST_GRADE_SUMMARY_REFRESH_QUEUE, PLAYLIST_GRADE_SUMMARY_REFRESH_CRON, null, {
    tz: 'UTC',
  });
  await boss.work(PLAYLIST_GRADE_SUMMARY_REFRESH_QUEUE, async () => {
    await runPlaylistGradeSummaryRefresh();
  });
  if (await summariesAreEmpty()) {
    await boss.send(PLAYLIST_GRADE_SUMMARY_REFRESH_QUEUE, {});
  }
}
