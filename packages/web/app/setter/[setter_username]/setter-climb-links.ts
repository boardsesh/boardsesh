import { toBoardName } from '@boardsesh/board-config';
import type { PopularBoardConfig } from '@boardsesh/shared-schema';
import { getBoardDetailsForPlaylist } from '@/app/lib/board-config-for-playlist';
import { getBoardDetailsForBoard } from '@/app/lib/board-utils';
import { resolveClimbSitemapGroups, type ClimbConfigGroup } from '@/app/lib/seo/sitemap/climb-entries';
import type { BoardDetails } from '@/app/lib/types';
import type { SetterClimbRow } from './server-setter-data';

/**
 * Which board configuration each of a setter's climbs is linked under.
 *
 * A setter's climbs span layouts and boards, and `board_climbs` carries no size
 * or set: a climb renders on many configurations, so any link has to *choose*
 * one. The client list used to choose the largest size plus every set
 * (`getBoardDetailsForPlaylist`), while `/sitemaps/climbs/N.xml` chooses the
 * config with the most physical boards. Those are different tuples, and the
 * climb view page self-canonicalises to whichever one it is served under — so
 * every row was manufacturing a second indexable URL for a climb Google had
 * already been told about at a different address.
 *
 * This module closes that by calling `resolveClimbSitemapGroups` — the same
 * chooser, on the same input — so a setter row and the climbs sitemap name one
 * URL per climb. `setter-climb-links.test.ts` pins it by computing the expected
 * href from `climbRowsToItems` rather than by hardcoding a string.
 *
 * There is no MoonBoard special case here on purpose. MoonBoard is absent from
 * the resolved groups today (its set slugs do not round-trip through the
 * MoonBoard page's parser — see `hasRoundTrippableSetSlug`), so its climbs land
 * in `unlinkedClimbUuids` and render as plain rows. When that parser is fixed
 * the groups start including MoonBoard and these links start working, with no
 * second edit here.
 */
export type SetterClimbLinks = {
  /** Per-climb board override for `StaticClimbList`, keyed by climb uuid. */
  boardDetailsByClimb: Record<string, BoardDetails>;
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
  fallbackBoardDetails: BoardDetails | null;
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

  if (group.setIds.length === 0) {
    return climb.requiredSetIds.length === 0;
  }

  if (isMoonboard && climb.requiredSetIds.length === 0) {
    return true;
  }

  return climb.requiredSetIds.every((setId) => group.setIds.includes(setId));
}

/** Board art for a climb we will not link — cached per `(board_type, layout_id)`. */
function displayDetailsByLayout(climb: SetterClimbRow, cache: Map<string, BoardDetails | null>): BoardDetails | null {
  const key = groupKey(climb.boardType, climb.layoutId);
  if (!cache.has(key)) {
    cache.set(key, getBoardDetailsForPlaylist(climb.boardType, climb.layoutId));
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

  const boardDetailsByClimb: Record<string, BoardDetails> = {};
  const unlinkedClimbUuids = new Set<string>();
  const detailsByGroup = new Map<string, BoardDetails>();
  const displayCache = new Map<string, BoardDetails | null>();
  const linkedPerGroup = new Map<string, number>();

  for (const climb of climbs) {
    const key = groupKey(climb.boardType, climb.layoutId);
    const group = groups.get(key);

    if (!group || !climbFitsGroup(climb, group)) {
      // Unlinked, but still drawn on its own board. `getBoardDetailsForPlaylist`
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

    let details = detailsByGroup.get(key);
    if (!details) {
      try {
        details = getBoardDetailsForBoard({
          board_name: group.boardType,
          layout_id: group.layoutId,
          size_id: group.sizeId,
          set_ids: group.setIds,
        });
      } catch {
        // A group the static board tables can't render is not a link we can
        // prove: a plain row beats an invented URL.
        unlinkedClimbUuids.add(climb.uuid);
        continue;
      }
      detailsByGroup.set(key, details);
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
  const fallbackBoardDetails =
    (primaryKey ? detailsByGroup.get(primaryKey) : undefined) ?? Object.values(boardDetailsByClimb)[0] ?? null;

  return { boardDetailsByClimb, unlinkedClimbUuids, primaryGroup, fallbackBoardDetails };
}
