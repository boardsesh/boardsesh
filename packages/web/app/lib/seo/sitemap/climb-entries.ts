import { supportsStaticBoardRender, toBoardName } from '@boardsesh/board-config';
import type { PopularBoardConfig } from '@boardsesh/shared-schema';
import { resolveClimbDisplayName } from '@/app/lib/string-utils';
import { tryConstructSlugViewUrl } from '@/app/lib/url-utils';
import type { SitemapItem } from './entries';

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
export function resolveClimbSitemapGroups(configs: readonly PopularBoardConfig[]): ClimbConfigGroup[] {
  const best = new Map<string, PopularBoardConfig>();

  for (const config of configs) {
    if (!toBoardName(config.boardType)) continue;
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
 * MoonBoard configurations are held out of the shard, and `isResolvableGroup`
 * cannot see why.
 *
 * The set slug this builder emits does not round-trip through the parser the
 * MoonBoard page uses. `generateSetSlug` joins set-name slugs with `_`
 * (`readable-url-utils.ts`), while `getMoonBoardSetsBySlug`
 * (`url-utils.server.ts`) splits the slug on `-` and substring-matches the
 * parts — so `…/wooden-holds_screw_original-school-holds_…` parses back to a
 * DIFFERENT set-id list, and `generateMetadata` then emits a `<link
 * rel="canonical">` that is not the URL we submitted. Measured over the static
 * MoonBoard tables: 212 of 227 layout×set combinations mismatch, including the
 * full set list on masters-2017 and masters-2019. Every such URL is one Google
 * drops as "alternate page with proper canonical".
 *
 * `tryConstructSlugViewUrl` returns a URL for all 227, so the resolvability
 * probe is green on every one of them — which is precisely why this is a
 * separate, named exclusion rather than a tweak to the probe.
 *
 * Not live today (`getPopularConfigs()` emits no MoonBoard rows — there is no
 * `board_product_sizes_layouts_sets` seed for it, and `/sitemaps/boards.xml`
 * carries zero `/moonboard/` URLs), so this costs nothing now and stops the
 * shard from going wrong the moment a seed lands. Lifting it means making
 * `getMoonBoardSetsBySlug` an exact `generateSetNameSlug` match on `_`-split
 * parts — a routing-parser change, not a sitemap one.
 */
function hasRoundTrippableSetSlug(group: ClimbConfigGroup): boolean {
  const boardName = toBoardName(group.boardType);
  return boardName !== null && supportsStaticBoardRender(boardName) && boardName !== 'moonboard';
}

export function isResolvableGroup(group: ClimbConfigGroup): boolean {
  return (
    hasRoundTrippableSetSlug(group) &&
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
 * cost ~55 bytes per URL — 7 MB across tier 2, against a 4 MB per-shard ceiling.
 * The byte budget is a contract here, not a preference.
 */
export function climbRowsToItems(
  rows: readonly ClimbSitemapRow[],
  group: ClimbConfigGroup,
): { items: SitemapItem[]; dropped: number } {
  const items: SitemapItem[] = [];
  let dropped = 0;

  for (const row of rows) {
    const climbName = resolveClimbDisplayName(row.name, group.boardType);
    const path = tryConstructSlugViewUrl(
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
