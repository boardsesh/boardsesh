import { sql } from 'drizzle-orm';
import { sitemapShardRefreshes } from '@boardsesh/db/schema';
import { setSerialPlan } from '@boardsesh/db/queries';
import {
  getStoredSetterSitemapSummary,
  resolveClimbSitemapGroups,
  runSetterSitemapQuery,
  setterRowsToItems,
  SETTERS_SHARD_ID,
  SETTER_SUMMARY_MAX_AGE_MS,
  type StoredSetterSitemapSummary,
} from '@boardsesh/db/queries/sitemap';
import { db } from '../db/client';
import { getPopularConfigs } from './popular-board-configs';

// Adjacent to the climbs refresh's 19_554_523 in the reserved application range.
export const SETTER_SITEMAP_REFRESH_LOCK_KEY = 19_554_524;

export type SetterSitemapSummaryRefreshResult = {
  refreshed: boolean;
  itemCount: number | null;
  lastModified: string | null;
  computedAt: string | null;
  skipped: 'fresh' | 'locked' | null;
};

function refreshResult(
  summary: StoredSetterSitemapSummary | null,
  skipped: SetterSitemapSummaryRefreshResult['skipped'],
): SetterSitemapSummaryRefreshResult {
  return {
    refreshed: skipped === null,
    itemCount: summary?.itemCount ?? null,
    lastModified: summary?.lastModified?.toISOString() ?? null,
    computedAt: summary?.computedAt.toISOString() ?? null,
    skipped,
  };
}

/**
 * Persist the exact item list's small summary so a web restart never scans the
 * catalogue while the index's three-second deadline is running. The primary
 * transaction owns both the advisory lock and the bounded scan: no lock is left
 * idle on one connection while another pool works.
 */
export async function refreshSetterSitemapSummary({ force = false }: { force?: boolean } = {}) {
  return db.transaction(async (transactionDb): Promise<SetterSitemapSummaryRefreshResult> => {
    const locks = await transactionDb.execute<{ locked: boolean }>(
      sql`SELECT pg_try_advisory_xact_lock(${SETTER_SITEMAP_REFRESH_LOCK_KEY}) AS locked`,
    );
    const previous = await getStoredSetterSitemapSummary(transactionDb);
    if (!locks[0]?.locked) return refreshResult(previous, 'locked');

    if (!force && previous && Date.now() - previous.computedAt.getTime() < SETTER_SUMMARY_MAX_AGE_MS) {
      return refreshResult(previous, 'fresh');
    }

    const configs = await getPopularConfigs();
    if (configs.length === 0) {
      throw new Error('Cannot refresh the setters sitemap without the public board catalogue');
    }

    await setSerialPlan(transactionDb);
    await transactionDb.execute(sql`SET LOCAL statement_timeout = '45s'`);
    const groups = resolveClimbSitemapGroups(configs);
    const rows = await runSetterSitemapQuery(transactionDb, groups);
    const { items, dropped } = setterRowsToItems([...rows]);
    if (dropped > 0 || items.length === 0) {
      throw new Error('Refusing to persist an empty or incomplete setters sitemap summary');
    }

    let lastModified: Date | null = null;
    for (const item of items) {
      if (item.lastModified === null) continue;
      if (!Number.isFinite(item.lastModified.getTime())) {
        throw new Error('Refusing to persist an invalid setters sitemap timestamp');
      }
      if (lastModified === null || item.lastModified > lastModified) lastModified = item.lastModified;
    }

    const summary = { itemCount: items.length, lastModified, computedAt: new Date() };
    await transactionDb
      .insert(sitemapShardRefreshes)
      .values({ shardId: SETTERS_SHARD_ID, ...summary })
      .onConflictDoUpdate({ target: sitemapShardRefreshes.shardId, set: summary });
    return refreshResult(summary, null);
  });
}
