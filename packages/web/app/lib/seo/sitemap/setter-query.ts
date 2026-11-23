import 'server-only';
import { withSerialPlan } from '@boardsesh/db/queries';
import {
  getStoredSetterSitemapSummary,
  resolveClimbSitemapGroups,
  runSetterSitemapQuery,
  setterRowsToItems,
  type SetterSitemapQueryRow,
} from '@boardsesh/db/queries/sitemap';
import { dbz, dbzRead } from '@/app/lib/db/db';
import { getAllBoardConfigsOrThrow } from '@/app/lib/server-popular-configs';
import type { SitemapItem } from './entries';
export { buildSetterSitemapSql, runSetterSitemapQuery, setterRowsToItems } from '@boardsesh/db/queries/sitemap';
export type { SetterSitemapQueryRow } from '@boardsesh/db/queries/sitemap';

const ITEMS_TTL_MS = 6 * 60 * 60 * 1000;
export type SetterSitemapSummary = { itemCount: number; lastModified: Date | null };

/** The index reads a small persisted row; it never runs the catalogue scan. */
export async function fetchSetterSitemapSummary(): Promise<SetterSitemapSummary> {
  const summary = await getStoredSetterSitemapSummary(dbz);
  if (!summary) throw new Error('[sitemap] setters summary is not populated; waiting for backend refresh');
  return { itemCount: summary.itemCount, lastModified: summary.lastModified };
}

async function fetchSetterRows(): Promise<SetterSitemapQueryRow[]> {
  const groups = resolveClimbSitemapGroups(await getAllBoardConfigsOrThrow());
  return [...(await withSerialPlan(dbzRead, async (transactionDb) => runSetterSitemapQuery(transactionDb, groups)))];
}

let cachedItems: { builtAt: number; items: SitemapItem[] } | null = null;
let itemsInFlight: Promise<SitemapItem[]> | null = null;

/**
 * The full ordered item list, behind a 6-hour TTL and a single-flight promise.
 *
 * Not in the Next Data Cache, and for the same reason the climb items are not:
 * a crawl burst across N pages on N cold lambdas really does cost N builds, and
 * per-page cache entries would not help because building page N still needs the
 * whole ordered list before it can slice. This is a per-instance defence.
 */
export async function buildSetterSitemapItems(): Promise<SitemapItem[]> {
  if (cachedItems && Date.now() - cachedItems.builtAt < ITEMS_TTL_MS) {
    return cachedItems.items;
  }
  if (itemsInFlight) {
    return itemsInFlight;
  }

  const build = fetchSetterRows()
    .then((rows) => setterRowsToItems(rows))
    .then(({ items, dropped }) => {
      // A drop is unreachable by construction — the SQL predicate rejects
      // everything the round-trip check could — so one means the two rules have
      // disagreed and the item list no longer matches the summary that sized the
      // pages. Throwing 503s the page and retries; caching the short list
      // instead would serve a wrong or empty shard for the full six-hour TTL
      // behind a single `console.warn` nobody reads.
      if (dropped > 0) {
        throw new Error(
          `[sitemap] setters shard dropped ${dropped} of ${dropped + items.length} usernames the SQL predicate should have excluded — refusing to cache a list the summary does not describe`,
        );
      }
      cachedItems = { builtAt: Date.now(), items };
      return items;
    });
  itemsInFlight = build;

  try {
    return await build;
  } finally {
    itemsInFlight = null;
  }
}

/** Test seam: drops only this process's item cache; summaries are persisted. */
export function resetSetterSitemapCachesForTests(): void {
  cachedItems = null;
  itemsInFlight = null;
}
