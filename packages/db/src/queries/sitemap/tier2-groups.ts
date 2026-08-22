import { toBoardName } from '@boardsesh/board-config';
import type { PopularBoardConfig } from '@boardsesh/shared-schema';

/**
 * The fields the ranking actually reads.
 *
 * A structural subset rather than the full `PopularBoardConfig` so the refresh
 * job can rank the raw SQL rows (`fetchPopularBoardConfigRows`) without inventing
 * a `displayName` it has no use for. Every `PopularBoardConfig` satisfies it, so
 * the web read path passes its GraphQL configs through unchanged.
 */
export type RankableBoardConfig = Pick<
  PopularBoardConfig,
  'boardType' | 'layoutId' | 'sizeId' | 'setIds' | 'climbCount' | 'boardCount'
>;

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
export function climbGroupKey(boardType: string, layoutId: number): string {
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
export function isBetterConfig(candidate: RankableBoardConfig, incumbent: RankableBoardConfig): boolean {
  if (candidate.boardCount !== incumbent.boardCount) return candidate.boardCount > incumbent.boardCount;
  if (candidate.climbCount !== incumbent.climbCount) return candidate.climbCount > incumbent.climbCount;
  if (candidate.sizeId !== incumbent.sizeId) return candidate.sizeId < incumbent.sizeId;
  return isLowerSetIdList(candidate.setIds, incumbent.setIds);
}

/**
 * One config per `(board_type, layout_id)`, ordered deterministically.
 *
 * Shared between the web read path and the `refresh-sitemap-tier2` job, which is
 * the whole point of it living here: the job materialises the rows and the read
 * path emits their URLs, so a second copy of this ranking would be a way for the
 * two to select different sets without anything going red.
 *
 * Deliberately NOT filtered by URL resolvability. `tryConstructSlugViewUrl` is a
 * web-side concern (readable board segments, locale slugs) and the job has no
 * business owning it: the job materialises every winning group, and the read
 * path drops the ones it cannot address from both its page arithmetic and its
 * emitted set. Kilter layout 5 ("Spire", 69 climbs) is the one such group today —
 * ~7 KB of wasted storage, and worth it to keep the URL rule in exactly one place.
 */
export function chooseWinningConfigPerLayout(configs: readonly RankableBoardConfig[]): ClimbConfigGroup[] {
  const best = new Map<string, RankableBoardConfig>();

  for (const config of configs) {
    if (!toBoardName(config.boardType)) continue;
    if (config.climbCount <= 0) continue;

    const key = climbGroupKey(config.boardType, config.layoutId);
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
    .sort((left, right) =>
      left.boardType === right.boardType ? left.layoutId - right.layoutId : left.boardType < right.boardType ? -1 : 1,
    );
}
