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

/**
 * The gate for a profile card. `isPrivate` is read here and checked before any
 * other read: a private account has no card at all.
 */
export const OG_PROFILE_GATE = parse(/* GraphQL */ `
  query OgProfileGate($userId: ID!) {
    publicProfile(userId: $userId) {
      displayName
      avatarUrl
      isPrivate
    }
  }
`);

export const OG_PROFILE_STATS = parse(/* GraphQL */ `
  query OgProfileStats($userId: ID!) {
    userProfileStats(userId: $userId) {
      totalDistinctClimbs
      layoutStats {
        boardType
        distinctClimbCount
        gradeCounts {
          grade
          count
        }
      }
    }
  }
`);

/** The hardest send a stranger may see: `userAscentsFeed` already applies tick privacy and spray visibility. */
export const OG_PROFILE_HARDEST_SEND = parse(/* GraphQL */ `
  query OgProfileHardestSend($userId: ID!, $input: AscentFeedInput) {
    userAscentsFeed(userId: $userId, input: $input) {
      items {
        climbName
        boardType
        difficulty
        consensusDifficulty
        frames
        renderBoard {
          layoutId
          sizeId
          setIds
        }
      }
    }
  }
`);

/**
 * What the setter card draws about the setter. Not the gate: this counts every
 * climb the setter has, which is about a second on a prolific one, so it sits
 * behind `setterHasVisibleClimbs` and a short memory.
 */
export const OG_SETTER_SUMMARY = parse(/* GraphQL */ `
  query OgSetterSummary($input: SetterProfileInput!) {
    setterProfile(input: $input) {
      climbCount
      boardTypes
      linkedUserDisplayName
      linkedUserAvatarUrl
    }
  }
`);

export const OG_SETTER_TOTAL_ASCENTS = parse(/* GraphQL */ `
  query OgSetterTotalAscents($input: SetterProfileInput!) {
    setterProfile(input: $input) {
      totalAscents
    }
  }
`);

/** The single most-sent climb. `listableSetterClimbConditions` keeps drafts, hidden and private-wall climbs out. */
export const OG_SETTER_TOP_CLIMB = parse(/* GraphQL */ `
  query OgSetterTopClimb($input: SetterClimbsFullInput!) {
    setterClimbsFull(input: $input) {
      climbs {
        uuid
        name
        boardType
        layoutId
        frames
        ascensionist_count
        compatibleSizeIds
        requiredSetIds
      }
    }
  }
`);

/** The gym card's gate. What boards it has is read after it, with a stranger's visibility. */
export const OG_PLACE_GYM = parse(/* GraphQL */ `
  query OgPlaceGym($slug: String!) {
    gymBySlug(slug: $slug) {
      uuid
      name
      imageUrl
    }
  }
`);

/** The board card's gate. `locationName` is masked for a stranger by the field resolver. */
export const OG_PLACE_BOARD = parse(/* GraphQL */ `
  query OgPlaceBoard($slug: String!) {
    boardBySlug(slug: $slug) {
      uuid
      boardType
      layoutId
      sizeId
      setIds
      name
      angle
      locationName
    }
  }
`);
