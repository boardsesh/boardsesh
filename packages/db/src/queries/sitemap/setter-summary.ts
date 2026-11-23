import { eq } from 'drizzle-orm';
import { sitemapShardRefreshes } from '../../schema';
import type { SerialPlanDb } from '../util/serial-plan';

export const SETTERS_SHARD_ID = 'setters';
export const SETTER_SUMMARY_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export type StoredSetterSitemapSummary = {
  itemCount: number;
  lastModified: Date | null;
  computedAt: Date;
};

/** Read on the primary so a just-published refresh is visible after a web restart. */
export async function getStoredSetterSitemapSummary(db: SerialPlanDb): Promise<StoredSetterSitemapSummary | null> {
  const [summary] = await db
    .select({
      itemCount: sitemapShardRefreshes.itemCount,
      lastModified: sitemapShardRefreshes.lastModified,
      computedAt: sitemapShardRefreshes.computedAt,
    })
    .from(sitemapShardRefreshes)
    .where(eq(sitemapShardRefreshes.shardId, SETTERS_SHARD_ID))
    .limit(1);
  if (!summary) return null;
  if (
    !Number.isSafeInteger(summary.itemCount) ||
    summary.itemCount <= 0 ||
    !Number.isFinite(summary.computedAt.getTime()) ||
    (summary.lastModified !== null && !Number.isFinite(summary.lastModified.getTime()))
  ) {
    // Cache corruption is a miss: both the web recovery and backend writer can
    // replace it without ever advertising invalid page counts.
    return null;
  }
  return summary;
}
