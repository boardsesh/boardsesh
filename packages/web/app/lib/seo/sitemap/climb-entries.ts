import { toBoardName } from '@boardsesh/board-config';
import type { PopularBoardConfig } from '@boardsesh/shared-schema';
import { resolveClimbDisplayName } from '@/app/lib/string-utils';
import { constructBoardSlugViewUrl, tryConstructSlugViewUrl } from '@/app/lib/url-utils';
import type { SitemapItem } from './entries';
import { isIndexableClimbConfig } from './indexable-boards';

/**
 * A board configuration the climbs shard may build URLs from.
 *
 * `sprayWallSlug` is set by exactly one source — `getPublicSprayWallConfigs()`
 * in `spray-wall-configs.ts` — and only for a wall its owner made public. It is
 * the consent token SW-16 (#5449) keys on, and it is also the only way a spray
 * climb HAS a URL: `/spray/...` config tuples are not routed on www.
 */
export type SitemapClimbConfig = PopularBoardConfig & { sprayWallSlug?: string };

/**
 * The board configuration a climb's sitemap URL is built from.
 *
 * Size and set ids are NOT properties of a climb — `board_climbs` carries
 * `board_type`, `layout_id`, `compatible_size_ids[]` and `required_set_ids[]`,
 * and a climb renders on many configurations. The sitemap therefore has to
 * *choose* one per climb, and it chooses per `(board_type, layout_id)` group so
 * a climb's URL never depends on which query happened to reach it first.
 */
export type ClimbConfigGroup = {
  boardType: string;
  layoutId: number;
  sizeId: number;
  setIds: number[];
  /**
   * The `user_boards.slug` of a public spray wall, carried through from the
   * config. Present only for spray, and its presence is what makes the group
   * resolvable at all — see `isResolvableGroup`.
   */
  boardSlug?: string;
};

/** One tier-2 row: the climb, at the one angle the shard publishes. */
export type ClimbSitemapRow = {
  uuid: string;
  name: string | null;
  angle: number;
  updatedAt: Date;
};

/** Stable id for a `(board_type, layout_id)` group. */
function groupKey(boardType: string, layoutId: number): string {
  return `${boardType}:${layoutId}`;
}

/** Numeric lexicographic order for the already-sorted set-id arrays. */
function isLowerSetIdList(candidate: readonly number[], incumbent: readonly number[]): boolean {
  const sharedLength = Math.min(candidate.length, incumbent.length);

  for (let index = 0; index < sharedLength; index += 1) {
    if (candidate[index] !== incumbent[index]) return candidate[index] < incumbent[index];
  }

  return candidate.length < incumbent.length;
}

/**
 * The winner is the config with the most physical boards, then the most listed
 * climbs, then the lowest size id, then the lowest set-id list. Determinism is
 * the point, not the ranking: an unstable pick churns the whole emitted set between crawls
 * and teaches Google that every climb URL is ephemeral.
 */
function isBetterConfig(candidate: PopularBoardConfig, incumbent: PopularBoardConfig): boolean {
  if (candidate.boardCount !== incumbent.boardCount) return candidate.boardCount > incumbent.boardCount;
  if (candidate.climbCount !== incumbent.climbCount) return candidate.climbCount > incumbent.climbCount;
  if (candidate.sizeId !== incumbent.sizeId) return candidate.sizeId < incumbent.sizeId;
  return isLowerSetIdList(candidate.setIds, incumbent.setIds);
}

/**
 * One config per `(board_type, layout_id)`, ordered deterministically.
 *
 * A group whose config can't be resolved to readable URL segments is dropped
 * here rather than per row: `resolveReadableBoardSegments` — the resolver behind
 * `tryConstructSlugViewUrl` — depends only on `(board, layout, size, sets)`, not
 * on the angle, uuid or climb name, so a group either yields readable URLs for
 * every one of its climbs or for none. Dropping it up front keeps the count
 * query and the item builder selecting the identical set, which is what makes
 * the page count honest.
 *
 * A layout with no listed board config contributes zero URLs. That is the
 * expected gap between the addressable tier-2 universe and the shipped shard
 * count, and it is what the branch-time reconciliation measures.
 */
export function resolveClimbSitemapGroups(configs: readonly SitemapClimbConfig[]): ClimbConfigGroup[] {
  const best = new Map<string, SitemapClimbConfig>();

  for (const config of configs) {
    if (!toBoardName(config.boardType)) continue;
    // Never submit a private wall for crawling (see `isIndexableClimbConfig`):
    // every board type but spray is indexable, and spray only with the slug a
    // public wall carries.
    if (!isIndexableClimbConfig(config)) continue;
    if (config.climbCount <= 0) continue;

    const key = groupKey(config.boardType, config.layoutId);
    const incumbent = best.get(key);
    if (!incumbent || isBetterConfig(config, incumbent)) {
      best.set(key, config);
    }
  }

  return [...best.values()]
    .map((config) => ({
      boardType: config.boardType,
      layoutId: config.layoutId,
      sizeId: config.sizeId,
      setIds: config.setIds,
      boardSlug: config.sprayWallSlug,
    }))
    .filter((group) => isResolvableGroup(group))
    .sort((left, right) =>
      left.boardType === right.boardType ? left.layoutId - right.layoutId : left.boardType < right.boardType ? -1 : 1,
    );
}

/**
 * A uuid/name/angle that exist only to exercise the segment resolver. None of
 * the three can change its verdict (see `resolveReadableBoardSegments`), so the
 * probe answers the only question that matters: does this configuration have a
 * readable URL at all?
 */
const PROBE_UUID = '00000000000000000000000000000000';

/**
 * The one filter: does this configuration have a readable URL at all?
 *
 * A named MoonBoard exclusion used to sit alongside the probe, because the set
 * slug this builder emits did not round-trip through the parser the MoonBoard
 * page runs — `generateSetSlug` joins on `_` while `getMoonBoardSetsBySlug`
 * split on `-`, so a submitted URL rendered a canonical pointing elsewhere and
 * Google dropped it as "alternate page with proper canonical". That parser is
 * now an exact match (`url-utils.server.ts`), pinned by a 291-tuple round-trip
 * and by a byte-identity suite over these very groups, so the exclusion is gone
 * with the reason for it.
 *
 * The probe stays, and it is what still drops Kilter layout 5 ("Kilter Spire"):
 * an orphaned layout with no size associations, so it has no readable URL at any
 * tuple. 69 tier-2 climbs, documented rather than fixed.
 */
export function isResolvableGroup(group: ClimbConfigGroup): boolean {
  // Spray never passes the probe and never can: `boardHasDeepConfigRoute` does
  // not route `/spray/...`, so `tryConstructSlugViewUrl` correctly answers null
  // for every wall. Its URLs are the `/b/{slug}` shape instead, so the slug is
  // what "resolvable" means here — and a spray group without one is dropped, the
  // same way an unroutable tuple is.
  if (group.boardType === 'spray') return Boolean(group.boardSlug);

  return (
    tryConstructSlugViewUrl(group.boardType, group.layoutId, group.sizeId, group.setIds, 0, PROBE_UUID, 'probe') !==
    null
  );
}

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
 *  2. **Unresolvable means dropped, never a fallback.** `tryConstructSlugViewUrl`
 *     is the FIRST branch of `buildCanonicalClimbViewUrl`, so anything it
 *     resolves is byte-identical to the page's own canonical. The name-based and
 *     numeric fallbacks below it are URLs we cannot prove match, and submitting
 *     one is the own-goal this shard exists to avoid.
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

  for (const row of rows) {
    const climbName = resolveClimbDisplayName(row.name, group.boardType);
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
          group.sizeId,
          group.setIds,
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
