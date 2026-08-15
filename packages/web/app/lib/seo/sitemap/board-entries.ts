import { ANGLES, toBoardName } from '@boardsesh/board-config';
import type { PopularBoardConfig } from '@boardsesh/shared-schema';
import { buildCanonicalClimbListUrl } from '@/app/lib/url-utils';
import type { SitemapItem } from './entries';

/**
 * One entry per (board config × angle). Angles are genuinely different content —
 * grades shift with the wall angle and each angle page is self-canonical — so all
 * of them ship. With ~51 listed configs that is ~765 items (~3,060 locale-expanded
 * URLs), far inside the 11,250-item shard budget.
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
    if (!boardName) continue;

    // A config with no listed climbs is a thin page — it spends crawl budget the
    // climb shards (W-23) need and offers nothing to rank.
    if (config.climbCount <= 0) continue;

    const identity = {
      board_name: boardName,
      layout_id: config.layoutId,
      size_id: config.sizeId,
      set_ids: config.setIds,
      layout_name: config.layoutName ?? undefined,
      size_name: config.sizeName ?? undefined,
      size_description: config.sizeDescription ?? undefined,
      set_names: config.setNames,
    };

    for (const angle of ANGLES[boardName]) {
      items.push({
        // The same builder both `/list` front doors canonicalise to, so the
        // sitemap and the pages emit one identical string. Page 1 only — never
        // `?page=N`; crawlers walk the rel=next chain from here.
        path: buildCanonicalClimbListUrl(identity, angle),
        changeFrequency: 'weekly',
        priority: 0.7,
      });
    }
  }

  return items;
}
