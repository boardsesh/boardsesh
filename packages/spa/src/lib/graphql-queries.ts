import { gql } from 'graphql-request'

/**
 * Resolve a board entity by its slug.
 */
export const BOARD_BY_SLUG = gql`
  query BoardBySlug($slug: String!) {
    boardBySlug(slug: $slug) {
      uuid
      slug
      ownerId
      boardType
      layoutId
      sizeId
      setIds
      name
      description
      locationName
      isPublic
      isOwned
      angle
      isAngleAdjustable
      layoutName
      sizeName
      sizeDescription
      setNames
    }
  }
`

/**
 * Search climbs with filtering, sorting, and pagination.
 */
export const SEARCH_CLIMBS = gql`
  query SearchClimbs($input: ClimbSearchInput!) {
    searchClimbs(input: $input) {
      climbs {
        uuid
        name
        setter_username
        difficulty
        quality_average
        ascensionist_count
        frames
        angle
        stars
        difficulty_error
        litUpHoldsMap
        benchmark_difficulty
        userAscents
        userAttempts
      }
      totalCount
      hasMore
    }
  }
`

/**
 * Get full climb detail including lit-up holds.
 */
export const CLIMB_DETAIL = gql`
  query ClimbDetail(
    $boardName: String!
    $layoutId: Int!
    $sizeId: Int!
    $setIds: String!
    $angle: Int!
    $climbUuid: String!
  ) {
    climbDetail(
      boardName: $boardName
      layoutId: $layoutId
      sizeId: $sizeId
      setIds: $setIds
      angle: $angle
      climbUuid: $climbUuid
    ) {
      uuid
      setter_username
      name
      description
      frames
      angle
      ascensionist_count
      difficulty
      quality_average
      difficulty_error
      benchmark_difficulty
      litUpHoldsMap
    }
  }
`

/**
 * Get climb stats for all angles.
 */
export const CLIMB_STATS = gql`
  query ClimbStats($boardName: String!, $climbUuid: String!) {
    climbStats(boardName: $boardName, climbUuid: $climbUuid) {
      angle
      ascensionistCount
      qualityAverage
      difficultyAverage
      displayDifficulty
      faUsername
      faAt
      difficulty
    }
  }
`

/**
 * Get beta (video) links for a climb.
 */
export const CLIMB_BETA_LINKS = gql`
  query ClimbBetaLinks($boardName: String!, $climbUuid: String!) {
    climbBetaLinks(boardName: $boardName, climbUuid: $climbUuid) {
      climbUuid
      link
      foreignUsername
      angle
      thumbnail
      isListed
      createdAt
    }
  }
`

/**
 * Get difficulty grades for a board type.
 */
export const GRADES = gql`
  query Grades($boardName: String!) {
    grades(boardName: $boardName) {
      difficultyId
      name
    }
  }
`

/**
 * Get all user playlists across boards.
 */
export const ALL_USER_PLAYLISTS = gql`
  query AllUserPlaylists($input: GetAllUserPlaylistsInput!) {
    allUserPlaylists(input: $input) {
      id
      uuid
      boardType
      layoutId
      name
      description
      isPublic
      color
      icon
      createdAt
      updatedAt
      climbCount
      userRole
      followerCount
      isFollowedByMe
    }
  }
`

/**
 * Get a specific playlist by ID.
 */
export const PLAYLIST = gql`
  query Playlist($playlistId: ID!) {
    playlist(playlistId: $playlistId) {
      id
      uuid
      boardType
      layoutId
      name
      description
      isPublic
      color
      icon
      createdAt
      updatedAt
      climbCount
      userRole
      followerCount
      isFollowedByMe
    }
  }
`

/**
 * Get climbs in a playlist.
 */
export const PLAYLIST_CLIMBS = gql`
  query PlaylistClimbs($input: GetPlaylistClimbsInput!) {
    playlistClimbs(input: $input) {
      climbs {
        uuid
        name
        setter_username
        difficulty
        quality_average
        ascensionist_count
        frames
        angle
        stars
        difficulty_error
        litUpHoldsMap
        benchmark_difficulty
      }
      totalCount
      hasMore
    }
  }
`

/**
 * Get a public user profile.
 */
export const PUBLIC_PROFILE = gql`
  query PublicProfile($userId: ID!) {
    publicProfile(userId: $userId) {
      id
      displayName
      avatarUrl
      followerCount
      followingCount
      isFollowedByMe
    }
  }
`

/**
 * Get user profile stats.
 */
export const USER_PROFILE_STATS = gql`
  query UserProfileStats($userId: ID!) {
    userProfileStats(userId: $userId) {
      totalSends
      totalAttempts
      distinctClimbsSent
      gradeCounts {
        grade
        count
      }
    }
  }
`

/**
 * Get a setter profile by username.
 */
export const SETTER_PROFILE = gql`
  query SetterProfile($input: SetterProfileInput!) {
    setterProfile(input: $input) {
      username
      climbCount
      boardTypes
      followerCount
      isFollowedByMe
      linkedUserId
      linkedUserDisplayName
      linkedUserAvatarUrl
    }
  }
`

/**
 * Get climbs by a setter.
 */
export const SETTER_CLIMBS = gql`
  query SetterClimbs($input: SetterClimbsInput!) {
    setterClimbs(input: $input) {
      climbs {
        uuid
        name
        boardType
        layoutId
        angle
        difficultyName
        qualityAverage
        ascensionistCount
        createdAt
      }
      totalCount
      hasMore
    }
  }
`

/**
 * Get a session by ID.
 */
export const SESSION = gql`
  query Session($sessionId: ID!) {
    session(sessionId: $sessionId) {
      id
      name
      boardPath
      users {
        id
        username
        isLeader
        avatarUrl
      }
      isLeader
      isPublic
      startedAt
      endedAt
      goal
    }
  }
`

/**
 * Get session summary.
 */
export const SESSION_SUMMARY = gql`
  query SessionSummary($sessionId: ID!) {
    sessionSummary(sessionId: $sessionId) {
      sessionId
      totalSends
      totalAttempts
      gradeDistribution {
        grade
        count
      }
      hardestClimb {
        climbUuid
        climbName
        grade
      }
      participants {
        userId
        displayName
        avatarUrl
        sends
        attempts
      }
      startedAt
      endedAt
      durationMinutes
      goal
    }
  }
`

/**
 * Get grouped notifications.
 */
export const GROUPED_NOTIFICATIONS = gql`
  query GroupedNotifications($limit: Int, $offset: Int) {
    groupedNotifications(limit: $limit, offset: $offset) {
      groups {
        uuid
        type
        entityType
        entityId
        actorCount
        actors {
          id
          displayName
          avatarUrl
        }
        commentBody
        climbName
        climbUuid
        boardType
        proposalUuid
        setterUsername
        isRead
        createdAt
      }
      totalCount
      unreadCount
      hasMore
    }
  }
`

/**
 * Get current user profile.
 */
export const PROFILE = gql`
  query Profile {
    profile {
      id
      email
      displayName
      avatarUrl
    }
  }
`

/**
 * Get Aurora credential statuses.
 */
export const AURORA_CREDENTIALS = gql`
  query AuroraCredentials {
    auroraCredentials {
      boardType
      username
      userId
      syncedAt
      hasToken
    }
  }
`

/**
 * Get user's favorite climbs.
 */
export const USER_FAVORITE_CLIMBS = gql`
  query UserFavoriteClimbs($input: GetUserFavoriteClimbsInput!) {
    userFavoriteClimbs(input: $input) {
      climbs {
        uuid
        name
        setter_username
        difficulty
        quality_average
        ascensionist_count
        frames
        angle
        stars
        difficulty_error
        litUpHoldsMap
        benchmark_difficulty
      }
      totalCount
      hasMore
    }
  }
`
