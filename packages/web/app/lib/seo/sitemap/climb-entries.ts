import { toBoardName } from '@boardsesh/board-config';
import { resolveCanonicalClimbConfig, type ClimbConfigCompatibility } from '@/app/lib/canonical-climb-config';
import { resolveClimbDisplayName } from '@/app/lib/string-utils';
import { constructBoardSlugViewUrl, tryConstructSlugViewUrl } from '@/app/lib/url-utils';
import type { SitemapItem } from './entries';
import type { ClimbConfigGroup } from '@boardsesh/db/queries/sitemap';
export { resolveClimbSitemapGroups, isResolvableGroup } from '@boardsesh/db/queries/sitemap';
export type { ClimbConfigGroup, SitemapClimbConfig } from '@boardsesh/db/queries/sitemap';

/** One tier-2 row: the climb, at the one angle the shard publishes. */
export type ClimbSitemapRow = ClimbConfigCompatibility & {
  uuid: string;
  name: string | null;
  angle: number;
  updatedAt: Date;
};

/**
 * Tier-2 rows → sitemap items, one URL per climb.
 *
 * Two rules carry the whole shard's value:
 *
 *  1. **The name goes through `resolveClimbDisplayName`** — the exact call the
 *     climb page's `generateMetadata` and `<h1>` make. An unnamed climb's
 *     canonical carries the `-{board} Climb-` slug; a sitemap URL built from the
 *     raw null name would not, and Google would drop all of them as "alternate
 *     page with proper canonical".
 *  2. **The size and sets use `resolveCanonicalClimbConfig`**, also used by
 *     `buildCanonicalClimbViewUrl`. If the climb has no catalogue config, the
 *     eligible group supplies the tuple. We only submit readable URLs.
 *
 * Deliberately no `<changefreq>`/`<priority>`: Google ignores both, and they
 * cost ~55 bytes per URL — ~550 KB on a full 10,000-URL page, on top of the
 * 203-297 B/URL the paths themselves spend. Against `pagedShardByteBudget`'s
 * 5 MB that is 11% of the page bought for nothing, and the worst page
 * (MoonBoard Masters 2019) is already at 59%. The byte budget is a contract
 * here, not a preference.
 */
export function climbRowsToItems(
  rows: readonly ClimbSitemapRow[],
  group: ClimbConfigGroup,
): { items: SitemapItem[]; dropped: number } {
  const items: SitemapItem[] = [];
  let dropped = 0;

  const boardName = toBoardName(group.boardType);
  for (const row of rows) {
    const climbName = resolveClimbDisplayName(row.name, group.boardType);
    const canonicalConfig = boardName ? resolveCanonicalClimbConfig(boardName, group.layoutId, row) : undefined;
    // A spray wall's climb lives at `/b/{slug}/{angle}/view/...`, which is the
    // same builder and the same resolved name the spray climb view page emits as
    // its own canonical, so the two are byte-identical. The config-tuple builder
    // below would answer null for it, and rule 2 would then silently drop every
    // climb on the wall.
    const path = group.boardSlug
      ? constructBoardSlugViewUrl(group.boardSlug, row.angle, row.uuid, climbName)
      : tryConstructSlugViewUrl(
          group.boardType,
          group.layoutId,
          canonicalConfig?.sizeId ?? group.sizeId,
          canonicalConfig?.setIds ?? group.setIds,
          row.angle,
          row.uuid,
          climbName,
        );

    if (!path) {
      dropped += 1;
      continue;
    }

    // The row's own timestamp, passed through — never synthesised. A `new Date()`
    // here would claim every climb changed on every crawl.
    items.push({ path, lastModified: row.updatedAt });
  }

  return { items, dropped };
}
