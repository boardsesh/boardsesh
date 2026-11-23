import { toBoardName } from '@boardsesh/board-config';
import type { PopularBoardConfig } from '@boardsesh/shared-schema';
import { getBoardImageDetailsForPlaylist } from '@/app/lib/board-image-details';
import { getBoardImageDetailsForBoard } from '@/app/lib/board-image-details';
import { resolveCanonicalClimbConfig } from '@/app/lib/canonical-climb-config';
import { resolveClimbSitemapGroups, type ClimbConfigGroup } from '@/app/lib/seo/sitemap/climb-entries';
import type { BoardImageDetails } from '@/app/lib/types';
import type { SetterClimbRow } from './server-setter-data';

/**
 * Which board configuration each of a setter's climbs is linked under.
 *
 * A setter's climbs span layouts and boards, and `board_climbs` carries no size
 * or set: a climb renders on many configurations, so any link has to *choose*
 * one. `resolveClimbSitemapGroups` gives the setter and sitemap the same
 * layout eligibility, and `resolveCanonicalClimbConfig` gives them the same
 * fitting size and hold sets for each linked climb.
 */
export type SetterClimbLinks = {
  /** Per-climb board override for `StaticClimbList`, keyed by climb uuid. */
  boardDetailsByClimb: Record<string, BoardImageDetails>;
  /** Climbs with no resolvable canonical config — rendered as plain rows. */
  unlinkedClimbUuids: ReadonlySet<string>;
  /** The board config the largest share of the linked climbs sit on, or null. */
  primaryGroup: ClimbConfigGroup | null;
  /**
   * `StaticClimbList`'s required per-list board, used only for a climb with no
   * entry in `boardDetailsByClimb`. Every climb gets an entry above — linked or
   * display-only — so this is a type obligation rather than a live code path,
   * and it is null only when not one of the setter's climbs resolved to any
   * renderable board at all.
   */
  fallbackBoardDetails: BoardImageDetails | null;
};

function groupKey(boardType: string, layoutId: number): string {
  return `${boardType}:${layoutId}`;
}

/**
 * Whether the climb genuinely renders on this configuration — the same two
 * predicates `buildChosenSubquery` applies before the climbs shard will name a
 * config in a climb's URL. Linking a climb to a board it does not fit on is a
 * URL that resolves to a page listing a climb that isn't there.
 *
 * MoonBoard has one fixed size and never populates `compatible_size_ids`, so it
 * is exempt from the size half — the same exemption the sitemap query makes.
 */
function climbFitsGroup(climb: SetterClimbRow, group: ClimbConfigGroup): boolean {
  const isMoonboard = toBoardName(group.boardType) === 'moonboard';

  if (!isMoonboard && !climb.compatibleSizeIds.includes(group.sizeId)) {
    return false;
  }

  if (group.setIds.length === 0) return true;
  if (climb.requiredSetIds == null) return isMoonboard;
  return climb.requiredSetIds.every((setId) => group.setIds.includes(setId));
}

/** Board art for a climb we will not link — cached per `(board_type, layout_id)`. */
function displayDetailsByLayout(
  climb: SetterClimbRow,
  cache: Map<string, BoardImageDetails | null>,
): BoardImageDetails | null {
  const key = groupKey(climb.boardType, climb.layoutId);
  if (!cache.has(key)) {
    cache.set(key, getBoardImageDetailsForPlaylist(climb.boardType, climb.layoutId));
  }
  return cache.get(key) ?? null;
}

export function resolveSetterClimbLinks(
  climbs: readonly SetterClimbRow[],
  configs: readonly PopularBoardConfig[],
): SetterClimbLinks {
  const groups = new Map<string, ClimbConfigGroup>();
  for (const group of resolveClimbSitemapGroups(configs)) {
    groups.set(groupKey(group.boardType, group.layoutId), group);
  }

  const boardDetailsByClimb: Record<string, BoardImageDetails> = {};
  const unlinkedClimbUuids = new Set<string>();
  const detailsByConfig = new Map<string, BoardImageDetails>();
  const displayCache = new Map<string, BoardImageDetails | null>();
  const linkedPerGroup = new Map<string, number>();

  for (const climb of climbs) {
    const key = groupKey(climb.boardType, climb.layoutId);
    const group = groups.get(key);
    const boardName = toBoardName(climb.boardType);

    if (!boardName || !group || !climbFitsGroup(climb, group)) {
      // Unlinked, but still drawn on its own board. `getBoardImageDetailsForPlaylist`
      // (largest size + every set) is a *rendering* choice, never a URL one:
      // the uuid is in `unlinkedClimbUuids`, so `StaticClimbRow` emits no anchor
      // for it. Using it for an href is the wrong-board-URL bug this module
      // exists to prevent.
      unlinkedClimbUuids.add(climb.uuid);
      const displayDetails = displayDetailsByLayout(climb, displayCache);
      if (displayDetails) {
        boardDetailsByClimb[climb.uuid] = displayDetails;
      }
      continue;
    }

    const config = resolveCanonicalClimbConfig(boardName, climb.layoutId, climb) ?? group;
    const configKey = `${key}:${config.sizeId}:${config.setIds.join(',')}`;
    let details = detailsByConfig.get(configKey);
    if (!details) {
      try {
        details = getBoardImageDetailsForBoard({
          board_name: boardName,
          layout_id: config.layoutId,
          size_id: config.sizeId,
          set_ids: config.setIds,
        });
      } catch {
        // A group the static board tables can't render is not a link we can
        // prove: a plain row beats an invented URL.
        unlinkedClimbUuids.add(climb.uuid);
        continue;
      }
      detailsByConfig.set(configKey, details);
    }

    boardDetailsByClimb[climb.uuid] = details;
    linkedPerGroup.set(key, (linkedPerGroup.get(key) ?? 0) + 1);
  }

  let primaryKey: string | null = null;
  let primaryCount = 0;
  for (const [key, linkedCount] of linkedPerGroup) {
    if (linkedCount > primaryCount) {
      primaryKey = key;
      primaryCount = linkedCount;
    }
  }

  const primaryGroup = primaryKey ? (groups.get(primaryKey) ?? null) : null;
  const boardDetails = Object.values(boardDetailsByClimb);
  const fallbackBoardDetails =
    boardDetails.find((details) => groupKey(details.board_name, details.layout_id) === primaryKey) ??
    boardDetails[0] ??
    null;

  return { boardDetailsByClimb, unlinkedClimbUuids, primaryGroup, fallbackBoardDetails };
}
