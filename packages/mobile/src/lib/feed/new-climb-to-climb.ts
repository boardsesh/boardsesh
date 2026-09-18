import type { ActivityFeedItem, Climb } from '@boardsesh/shared-schema';

/**
 * Build a play-drawer-ready `Climb` from a crew-feed new-climb entry.
 *
 * The feed already carries everything the drawer needs — the card draws board
 * art from the same `frames` — so a tap opens the drawer in place instead of
 * routing through the climb redirector to fetch a climb we were already holding.
 * The sibling of `tickToClimb`, which does the same for a session tick.
 *
 * Returns `null` when the entry has no frames (nothing to draw) or no climb
 * uuid; the caller then leaves the card inert rather than opening an empty board.
 */
export function newClimbToClimb(item: ActivityFeedItem): Climb | null {
  if (!item.frames || !item.climbUuid) return null;
  return {
    uuid: item.climbUuid,
    name: item.climbName ?? item.climbUuid,
    frames: item.frames,
    angle: item.angle ?? 0,
    // A climb this new has no ascents and no community rating yet; the drawer
    // refreshes both from the server once it is open.
    ascensionist_count: 0,
    difficulty: item.difficultyName ?? '',
    difficulty_error: '',
    quality_average: '0',
    setter_username: item.setterUsername ?? '',
    stars: 0,
    benchmark_difficulty: item.isBenchmark ? (item.difficultyName ?? null) : null,
    mirrored: item.isMirror ?? false,
    is_no_match: item.isNoMatch ?? false,
    boardType: item.boardType ?? undefined,
    layoutId: item.layoutId,
    // The ownership gates key on this, not on the mutable setter username.
    userId: item.actorId,
  };
}
