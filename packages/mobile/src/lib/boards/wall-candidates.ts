// A gym's existing walls (#8151) as the gym-first flow draws them: which shelf
// each wall goes on, what its row says, and the counts its analytics carry.
// Pure, so the shelf rules are a table in the tests.

import type { ExistingWallCandidate, UserBoard } from '@boardsesh/shared-schema';
import { boardSetupLabelParts, toBoardName } from '@boardsesh/board-config';
import type { DiscoveryBoardItem } from '../../components/board-discovery/BoardDiscoveryCardView';
import { boardTypeLabel } from '../../components/board-discovery/board-builder-labels';

/**
 * The wall list's shelves, in the order they are drawn.
 *
 * - `same_setup` / `set_up_differently`: walls classified against a draft (the
 *   builder's "already has" sheet sends the climber's setup). The find step has
 *   no draft yet, so its walls land on `at_gym` instead.
 * - `listed_nearby`: walls on another public listing within 150 m, whatever
 *   their match, because the gym itself is what is in question there.
 */
export type WallShelfKey = 'same_setup' | 'set_up_differently' | 'at_gym' | 'listed_nearby';

export const WALL_SHELF_ORDER: readonly WallShelfKey[] = [
  'same_setup',
  'set_up_differently',
  'at_gym',
  'listed_nearby',
];

/** `Board Wall Candidate Used`'s `match`. */
export type WallCandidateMatch = 'exact' | 'near_miss' | 'nearby' | 'at_gym' | 'other_type';

export function wallShelfFor(candidate: Pick<ExistingWallCandidate, 'matchKind' | 'source'>): WallShelfKey {
  if (candidate.source === 'NEARBY_LISTING') return 'listed_nearby';
  switch (candidate.matchKind) {
    case 'EXACT':
      return 'same_setup';
    case 'SETS_DIFFER':
    case 'LAYOUT_OR_SIZE_DIFFERS':
      return 'set_up_differently';
    case null:
      return 'at_gym';
  }
}

export function wallCandidateMatch(candidate: Pick<ExistingWallCandidate, 'matchKind' | 'source'>): WallCandidateMatch {
  switch (wallShelfFor(candidate)) {
    case 'same_setup':
      return 'exact';
    case 'set_up_differently':
      return 'near_miss';
    case 'listed_nearby':
      return 'nearby';
    case 'at_gym':
      return 'at_gym';
  }
}

export type WallShelf = { key: WallShelfKey; candidates: ExistingWallCandidate[] };

/**
 * The candidates on their shelves, keeping the server's rank inside each one
 * (`compareWallCandidates`). Empty shelves are left out.
 */
export function groupWallCandidates(candidates: readonly ExistingWallCandidate[]): WallShelf[] {
  const byShelf = new Map<WallShelfKey, ExistingWallCandidate[]>();
  for (const candidate of candidates) {
    const key = wallShelfFor(candidate);
    const shelf = byShelf.get(key);
    if (shelf) shelf.push(candidate);
    else byShelf.set(key, [candidate]);
  }
  return WALL_SHELF_ORDER.flatMap((key) => {
    const shelfCandidates = byShelf.get(key);
    return shelfCandidates ? [{ key, candidates: shelfCandidates }] : [];
  });
}

/** The counts `Board Wall Candidates Shown` carries. */
export function countWallCandidates(candidates: readonly ExistingWallCandidate[]) {
  let exactCount = 0;
  let nearMissCount = 0;
  let nearbyCount = 0;
  let atGymCount = 0;
  for (const candidate of candidates) {
    switch (wallShelfFor(candidate)) {
      case 'same_setup':
        exactCount += 1;
        break;
      case 'set_up_differently':
        nearMissCount += 1;
        break;
      case 'listed_nearby':
        nearbyCount += 1;
        break;
      case 'at_gym':
        atGymCount += 1;
        break;
    }
  }
  return { exactCount, nearMissCount, nearbyCount, atGymCount };
}

/** The words a wall row needs, resolved by the screen (this module can't translate). */
export type WallRowCopy = {
  adjustable: string;
  stats: (counts: { climbers: number; sends: number }) => string;
  addedBy: (name: string) => string;
  nearbyGym: (gym: string, distanceMeters: number) => string;
  yourBoard: string;
  following: string;
};

/**
 * Whose board it is, as far as the viewer is concerned: theirs, followed, or
 * someone else's. Ownership needs the viewer's id; signed out it's nobody's.
 */
export function wallRelation(board: UserBoard, viewerId: string | null | undefined): 'owner' | 'following' | null {
  if (viewerId && board.ownerId === viewerId) return 'owner';
  if (board.isFollowedByMe) return 'following';
  return null;
}

/**
 * One wall as a `BoardRow` item:
 *
 * - title: the board's name
 * - subtitle: "MoonBoard 2019 · 40°", plus "Adjustable" when it is
 * - detail lines: the nearby listing and its distance (Listed nearby only),
 *   every hold set, the climber and send counts, and "Added by" on a public,
 *   listed board only
 * - badge: "Your board" or "Following"
 *
 * Layout and set names come from the bundled catalogue: the server sends them
 * as null. A board type this build can't draw returns null and is left out.
 */
export function wallCandidateItem(
  board: UserBoard,
  {
    copy,
    viewerId,
    nearby,
  }: {
    copy: WallRowCopy;
    viewerId?: string | null;
    /** The listing a Listed nearby wall is on. */
    nearby?: { gymName: string; distanceMeters: number | null } | null;
  },
): DiscoveryBoardItem | null {
  const boardName = toBoardName(board.boardType);
  if (boardName === null) return null;
  const parts = boardSetupLabelParts(board.boardType, board);
  const what = [boardTypeLabel(boardName), parts.layout].filter(Boolean).join(' ');
  const subtitle = [what, `${board.angle}°`, board.isAngleAdjustable ? copy.adjustable : null]
    .filter(Boolean)
    .join(' · ');
  const relation = wallRelation(board, viewerId);
  const showsOwner = board.isPublic && !board.isUnlisted && !!board.ownerDisplayName && relation !== 'owner';
  const detailLines = [
    nearby && nearby.distanceMeters != null ? copy.nearbyGym(nearby.gymName, Math.round(nearby.distanceMeters)) : null,
    parts.sets.length > 0 ? parts.sets.join(', ') : null,
    copy.stats({ climbers: board.uniqueClimbers ?? 0, sends: board.totalAscents ?? 0 }),
    showsOwner && board.ownerDisplayName ? copy.addedBy(board.ownerDisplayName) : null,
  ].filter((line): line is string => line !== null);
  return {
    key: board.uuid,
    boardName,
    layoutId: board.layoutId,
    sizeId: board.sizeId,
    setIds: board.setIds,
    title: board.name,
    subtitle,
    detailLines,
    badge: relation === 'owner' ? copy.yourBoard : relation === 'following' ? copy.following : null,
  };
}

/**
 * The uuids the climber was shown on the builder's "already has" sheet and
 * said are different walls: what `acknowledgedWallUuids` carries. Repeats
 * dropped, the first ones kept, capped at the server's 40.
 */
export const MAX_ACKNOWLEDGED_WALLS = 40;

export function acknowledgedWallUuids(boardUuids: readonly string[]): string[] {
  return [...new Set(boardUuids)].slice(0, MAX_ACKNOWLEDGED_WALLS);
}
