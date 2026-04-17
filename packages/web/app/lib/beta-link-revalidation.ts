import { and, eq } from 'drizzle-orm';
import { dbz } from '@/app/lib/db/db';
import { UNIFIED_TABLES } from '@/app/lib/db/queries/util/table-select';
import { checkInstagramAccessibility } from '@/app/lib/instagram-validation';

// Re-check each link at most every 7 days. Instagram posts flip state
// rarely, so once we know a link is live (or dead) we don't need to
// re-probe for a while.
const REVALIDATION_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

// Module-level dedupe so concurrent requests for the same climb don't fire
// parallel outbound fetches to Instagram for the same URL. This is
// per-server-instance — good enough; a few duplicate checks across
// instances are cheap.
const inFlightChecks = new Set<string>();

export type BetaLinkRevalidationRow = {
  boardType: string;
  climbUuid: string;
  link: string;
  isAccessible: boolean | null;
  checkedAt: Date | null;
};

export function needsRevalidation(row: BetaLinkRevalidationRow): boolean {
  if (row.isAccessible === null) return true;
  if (!row.checkedAt) return true;
  return Date.now() - row.checkedAt.getTime() > REVALIDATION_INTERVAL_MS;
}

export function queueBetaLinkRevalidation(row: BetaLinkRevalidationRow): void {
  const key = `${row.boardType}:${row.climbUuid}:${row.link}`;
  if (inFlightChecks.has(key)) return;
  inFlightChecks.add(key);

  const { betaLinks } = UNIFIED_TABLES;

  void (async () => {
    try {
      const accessible = await checkInstagramAccessibility(row.link);
      await dbz
        .update(betaLinks)
        .set({ isAccessible: accessible, checkedAt: new Date() })
        .where(
          and(
            eq(betaLinks.boardType, row.boardType),
            eq(betaLinks.climbUuid, row.climbUuid),
            eq(betaLinks.link, row.link),
          ),
        );
    } catch (error) {
      console.error('Beta link revalidation failed:', row.link, error);
    } finally {
      inFlightChecks.delete(key);
    }
  })();
}

/**
 * Filter out rows we've affirmatively marked broken, and fire-and-forget
 * background revalidation for unknown or stale rows. Never blocks.
 *
 * Rows with `isAccessible === null` render optimistically (shown until the
 * first probe lands). Rows with `isAccessible === false` are hidden.
 */
export function filterAndRevalidateBetaLinks<T extends BetaLinkRevalidationRow>(
  rows: T[],
): T[] {
  const visible = rows.filter((row) => row.isAccessible !== false);
  for (const row of visible) {
    if (needsRevalidation(row)) {
      queueBetaLinkRevalidation(row);
    }
  }
  return visible;
}
