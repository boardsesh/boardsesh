import { toBoardName } from '@boardsesh/board-config';
import type { PopularBoardConfig } from '@boardsesh/shared-schema';
import { tryBuildReadableClimbViewPath } from '@boardsesh/play-view/readable-url-utils';
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

/** Selection needs IDs and counts only; backend display fields may be nullable. */
export type SitemapClimbConfigInput = Pick<
  PopularBoardConfig,
  'boardType' | 'layoutId' | 'sizeId' | 'setIds' | 'climbCount' | 'boardCount'
> & { sprayWallSlug?: string };

/**
 * The board configuration used to select climbs for the sitemap.
 *
 * Size and set ids are NOT properties of a climb — `board_climbs` carries
 * `board_type`, `layout_id`, `compatible_size_ids[]` and `required_set_ids[]`,
 * and a climb renders on many configurations. The sitemap therefore has to
 * choose one per climb. A popular config per `(board_type, layout_id)` keeps
 * tier-2 eligibility stable. The page and the shard resolve the URL tuple
 * separately from the climb's own size and hold-set compatibility.
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
function isBetterConfig(candidate: SitemapClimbConfigInput, incumbent: SitemapClimbConfigInput): boolean {
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
export function resolveClimbSitemapGroups(configs: readonly SitemapClimbConfigInput[]): ClimbConfigGroup[] {
  const best = new Map<string, SitemapClimbConfigInput>();

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
      // Spray only. A non-spray group is validated through the config-tuple
      // probe but would be EMITTED at the `/b/{slug}` shape, so a slug that
      // leaked onto one would mean validating one URL and submitting another.
      // Unreachable today — `getPublicSprayWallConfigs` is the only writer of
      // the field — and this keeps it that way if a future source is careless.
      boardSlug: config.boardType === 'spray' ? config.sprayWallSlug : undefined,
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
    tryBuildReadableClimbViewPath({
      boardName: group.boardType,
      layoutId: group.layoutId,
      sizeId: group.sizeId,
      setIds: group.setIds.join(','),
      angle: 0,
      climbUuid: PROBE_UUID,
      climbName: 'probe',
    }) !== null
  );
}
