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
    // Carried from the feed, not zeroed. The drawer does NOT refetch a preview
    // whose angle already matches (`previewNeedsAngleReanchor`), so zeros here
    // would render as "0 ascents, no stars" on a climb that has both — the
    // regression the old climb-page route did not have.
    ascensionist_count: item.ascensionistCount ?? 0,
    difficulty: item.difficultyName ?? '',
    difficulty_error: '',
    quality_average: item.qualityAverage == null ? '0' : String(item.qualityAverage),
    setter_username: item.setterUsername ?? '',
    stars: item.qualityAverage ?? 0,
    benchmark_difficulty: item.isBenchmark ? (item.difficultyName ?? null) : null,
    mirrored: item.isMirror ?? false,
    is_no_match: item.isNoMatch ?? false,
    boardType: item.boardType ?? undefined,
    layoutId: item.layoutId,
    // The ownership gates key on this, not on the mutable setter username.
    userId: item.actorId,
  };
}
