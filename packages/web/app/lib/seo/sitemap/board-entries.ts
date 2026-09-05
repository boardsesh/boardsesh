import { ANGLES, toBoardName } from '@boardsesh/board-config';
import type { PopularBoardConfig } from '@boardsesh/shared-schema';
import { popularConfigListUrl } from '@/app/lib/url-utils';
import type { SitemapItem } from './entries';

/**
 * One entry per (board config × angle). Angles are genuinely different content —
 * grades shift with the wall angle and each angle page is self-canonical — so all
 * of them ship. Measured against the dev image on 2026-08-19: 45 listed configs
 * give 660 items — 45 × 15 is the pre-filter upper bound and the zero-climb skip
 * below brings it down — and the four MoonBoard configs
 * `board-config-source.ts` synthesises add 8 more at their own 2-angle set, for
 * 668. One URL each: the shard is `expansion: 'default-locale-only'` because
 * these pages cross-canonicalise to the default locale. Either way it sits far
 * inside the 11,250-item shard budget. Production is not reconciled against
 * these.
 *
 * Deliberately no `<lastmod>`, and the reason is not "the data carries no
 * timestamp" — it does. The reason is that no timestamp the *config* carries
 * describes *this page*. #4466 proposed a per-config
 * `MAX(board_climbs.created_at)`; measured against the dev database (the
 * 2026-01-31 catalog snapshot — every date below is relative to it) that value
 * is fabricated freshness, so it is not wired up here:
 *
 * - The URL below is page 1 only, at the default sort: the top
 *   `FRONT_DOOR_PAGE_SIZE` (50) climbs by ascents (`fetchFrontDoorListPage`).
 *   For `/kilter/…/40/list` (layout 1, size 10, sets 1+20) the rank-50 cutoff is
 *   21,407 ascents and the newest climb on that page was created 2021-02-11.
 *   The best-ascended climb created into that config in the snapshot's last 90
 *   days has 86 ascents — 0.4% of the cutoff — so a newly set climb cannot reach
 *   page 1 at all.
 * - Meanwhile 6,148 climbs were created into that one config in the snapshot's
 *   last 30 days (~205/day), so a config-wide `MAX(created_at)` advances every
 *   single day. It would stamp that URL 2026-01-31 for a page whose newest
 *   content is from 2021 — five years of freshness the page never had, refreshed
 *   daily. That is exactly what `SitemapItem.lastModified` warns about in
 *   `entries.ts`: not literally `new Date()`, but indistinguishable from it.
 * - It is also not angle-aware, and the page is — the list query INNER JOINs
 *   `board_climb_stats` at the URL's angle. One config-wide value stamped onto
 *   all 15 angle URLs is wrong per angle: for tension layout 11 / size 9 the
 *   honest page-1 timestamps run 2024-12-26 (65°) to 2026-01-26 (55°), and 70°
 *   has no page-1 content at all.
 *
 * The honest version is `MAX(created_at)` over the page-1 window *per angle*.
 * On the dev database that query costs 207 s against the 78 s the existing
 * `popularBoardConfigs` statement already spends, and the warm path holds a
 * 120 s Redis lock — so it does not fit where it would have to live. `<lastmod>`
 * is optional in the sitemap protocol and crawlers fall back to other freshness
 * signals, so omitting it stays the right call until that window is affordable.
 * Per-climb freshness already ships truthfully on the climbs shards, where
 * `climb-query.ts` uses `board_climbs.updated_at` per climb.
 */
export function boardConfigsToItems(configs: readonly PopularBoardConfig[]): SitemapItem[] {
  const items: SitemapItem[] = [];

  for (const config of configs) {
    const boardName = toBoardName(config.boardType);
    if (!boardName) continue;

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
