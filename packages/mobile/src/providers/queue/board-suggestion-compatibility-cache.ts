import { canAddClimbToBoard, type BoardCompatibilityTarget } from '@boardsesh/board-config';
import { withPlaylistTrackClimbs, type Climb, type PlaylistSuggestionSource } from '@boardsesh/queue';
import { BOARD_FEED_SUGGESTION_SOURCE_ID } from '../../lib/playlists/board-feed-suggestion-source';

type CompatibilityRecord = {
  inputClimbs: Climb[];
  target: BoardCompatibilityTarget;
  credentialEpoch: number;
  compatibleClimbs: Climb[];
  climbsWithFirstAnchor: Climb[];
  previousSource: PlaylistSuggestionSource | null;
  previousNormalized: PlaylistSuggestionSource | null;
};

/** One immutable sequence/board snapshot per provider. Source cursors stay live. */
export function createBoardSuggestionCompatibilityCache() {
  let cached: CompatibilityRecord | null = null;
  return {
    normalize(
      source: PlaylistSuggestionSource,
      target: BoardCompatibilityTarget,
      credentialEpoch: number,
    ): PlaylistSuggestionSource {
      if (
        !cached ||
        cached.inputClimbs !== source.climbs ||
        cached.target !== target ||
        cached.credentialEpoch !== credentialEpoch
      ) {
        let firstClimbCompatible = false;
        const filteredClimbs = source.climbs.filter((climb, index) => {
          const compatible = canAddClimbToBoard(climb, target).ok;
          if (index === 0) firstClimbCompatible = compatible;
          return compatible;
        });
        const compatibleClimbs = filteredClimbs.length === source.climbs.length ? source.climbs : filteredClimbs;
        const firstClimb = source.climbs[0];
        const withFirstAnchor =
          firstClimb && !firstClimbCompatible ? [firstClimb, ...compatibleClimbs] : compatibleClimbs;
        cached = {
          inputClimbs: source.climbs,
          target,
          credentialEpoch,
          compatibleClimbs,
          climbsWithFirstAnchor: withFirstAnchor.length === source.climbs.length ? source.climbs : withFirstAnchor,
          previousSource: null,
          previousNormalized: null,
        };
      }
      // A synthetic feed alone may retain its foreign FIRST anchor. The
      // exemption depends on the current source cursor, never the cache key.
      const keepFirstAnchor =
        source.playlistUuid === BOARD_FEED_SUGGESTION_SOURCE_ID && source.climbs[0]?.uuid === source.activatedClimbUuid;
      const climbs = keepFirstAnchor ? cached.climbsWithFirstAnchor : cached.compatibleClimbs;
      if (climbs === source.climbs) return source;
      if (cached.previousSource === source && cached.previousNormalized?.climbs === climbs)
        return cached.previousNormalized;
      // Dropping a climb moves every position after it, so the count goes too.
      const normalized = withPlaylistTrackClimbs(source, climbs);
      cached.previousSource = source;
      cached.previousNormalized = normalized;
      return normalized;
    },
    clear() {
      cached = null;
    },
  };
}
