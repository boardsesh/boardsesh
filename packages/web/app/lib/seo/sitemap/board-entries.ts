import { ANGLES, supportsStaticBoardRender, toBoardName } from '@boardsesh/board-config';
import type { PopularBoardConfig } from '@boardsesh/shared-schema';
import { popularConfigListUrl } from '@/app/lib/url-utils';
import type { SitemapItem } from './entries';

/**
 * One entry per (board config × angle). Angles are genuinely different content —
 * grades shift with the wall angle and each angle page is self-canonical — so all
 * of them ship. Measured against the dev database, 51 listed configs give 660
 * items (2,640 locale-expanded URLs): 51 × 15 is the pre-filter upper bound, and
 * the MoonBoard 2-angle set plus the zero-climb skip below bring it to 660.
 * Either way it sits far inside the 11,250-item shard budget.
 *
 * Deliberately no `<lastmod>`: there is no per-config content timestamp in the
 * data today, and `new Date()` would be a lie. `<lastmod>` is optional in the
 * sitemap protocol; crawlers fall back to other freshness signals. Follow-up to
 * add `lastClimbAt` to `popularBoardConfigs` is filed.
 */
export function boardConfigsToItems(configs: readonly PopularBoardConfig[]): SitemapItem[] {
  const items: SitemapItem[] = [];

  for (const config of configs) {
    const boardName = toBoardName(config.boardType);
    if (!boardName || !supportsStaticBoardRender(boardName)) continue;

    // A config with no listed climbs is a thin page — it spends crawl budget the
    // climb shards (W-23) need and offers nothing to rank.
    if (config.climbCount <= 0) continue;

    for (const angle of ANGLES[boardName]) {
      items.push({
        // The one popular-config → list-URL builder, shared with every other
        // caller that starts from this row shape, so the sitemap and the `/list`
        // front doors emit an identical string. Hand-rolling a
        // `BoardRouteIdentity` and calling `buildCanonicalClimbListUrl` would be
        // a sixth copy of the priority decision, and it takes the name branch on
        // a config whose `setNames` is empty — which renders an empty path
        // segment (`/kilter/layout/size//40/list`), i.e. a 404 submitted to
        // Google. Page 1 only — never `?page=N`; crawlers walk rel=next.
        path: popularConfigListUrl(config, angle),
        changeFrequency: 'weekly',
        priority: 0.7,
      });
    }
  }

  return items;
}
