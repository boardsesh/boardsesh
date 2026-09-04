// Builds the continuation feed that `next` follows after the climber switches
// boards (issue #5099).
//
// The suggestion source is a generic continuation feed despite the name: the
// climbs list, the queue sheet and real playlists all write the same provider
// slot. When the held source belongs to the board the climber just left, the
// provider masks it out and re-anchors onto a board-scoped popular feed built
// here.
//
// The anchor matters. `getNextPlaylistClimb` (in @boardsesh/play-view) looks the
// CURRENT climb up inside `source.climbs` and hands back the entry after it, so
// a feed that does not contain the current climb resolves to nothing — the same
// dead end this fix exists to remove. The current climb after a board switch is
// a climb from the old board, which a board-scoped feed will never contain, so
// put it at the head rather than letting `mergeUniquePlaylistClimbs` append it
// at the tail.

import type { Climb, PlaylistSuggestionSource } from '@boardsesh/queue';

/**
 * Synthetic suggestion-source id for the board-scoped continuation feed —
 * distinct from real playlist activations, the climbs list (`'climblist'`) and
 * the queue sheet (`'queue-suggestions'`). Nothing validates uuid format;
 * `PlaylistSuggestionSource.playlistUuid` is typed `string`.
 */
export const BOARD_FEED_SUGGESTION_SOURCE_ID = 'board-feed';

/**
 * Build a continuation source for `board`, anchored on the climb the climber is
 * looking at so a forward swipe has somewhere to go.
 *
 * Returns null for an empty feed rather than a one-climb source: a source
 * containing only the anchor is a dead end that would also block the caller
 * from retrying once the feed resolves.
 */
export function createBoardFeedSuggestionSource({
  anchorClimb,
  feedClimbs,
  boardKey,
}: {
  anchorClimb: Climb;
  feedClimbs: Climb[];
  boardKey: string;
}): PlaylistSuggestionSource | null {
  if (feedClimbs.length === 0) return null;
  const anchorIndex = feedClimbs.findIndex((climb) => climb.uuid === anchorClimb.uuid);
  return {
    playlistUuid: BOARD_FEED_SUGGESTION_SOURCE_ID,
    activatedClimbUuid: anchorClimb.uuid,
    boardKey,
    climbs: anchorIndex >= 0 ? feedClimbs : [anchorClimb, ...feedClimbs],
  };
}
