import { parse } from 'graphql';

/** The gate read: run first, and nothing else runs if it answers no. */
export const OG_PLAYLIST_GATE = parse(/* GraphQL */ `
  query OgPlaylistGate($playlistId: ID!) {
    playlist(playlistId: $playlistId) {
      name
      boardType
      isPublic
      gradeSummary {
        p10Difficulty
        p90Difficulty
      }
    }
  }
`);

export const OG_PLAYLIST_CLIMBS = parse(/* GraphQL */ `
  query OgPlaylistClimbs($input: GetPlaylistClimbsInput!) {
    playlistClimbs(input: $input) {
      totalCount
      climbs {
        layoutId
        frames
      }
    }
  }
`);

export const OG_SESSION_GATE = parse(/* GraphQL */ `
  query OgSessionGate($sessionId: ID!) {
    session(sessionId: $sessionId) {
      boardPath
      users {
        userId
        username
        isLeader
      }
    }
  }
`);

/**
 * Only the config, never the board's name or location: a home board with
 * `hideLocation` must not be identifiable from a card, so those fields are not read.
 */
export const OG_BOARD_BY_SLUG = parse(/* GraphQL */ `
  query OgBoardBySlug($slug: String!) {
    boardBySlug(slug: $slug) {
      boardType
      layoutId
      sizeId
      setIds
      angle
    }
  }
`);
