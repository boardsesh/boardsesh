import { gql } from 'graphql-request';
import type {
  UserProfile,
  UpdateProfileInput,
  UserBoard,
  UserBoardConnection,
  Climb,
  ClimbSearchInput,
  Grade,
  SetterStat,
  SetterStatsInput,
  Angle,
  MyBoardsInput,
  SearchBoardsInput,
  PopularBoardConfig,
  PopularBoardConfigsInput,
  CreateBoardInput,
  SessionSummary,
  PublicUserProfile,
  FollowConnection,
  TickStatus,
  SessionUser,
  SessionStatus,
  SessionFeedParticipant,
  SessionGradeDistributionItem,
  SessionHealthExport,
  UserSearchConnection,
} from '@boardsesh/shared-schema';
import type { SubscriptionQueueItem } from '../queue-conversion';

// ============================================
// Field Fragments (string interpolation, not GQL fragments)
// ============================================

const BOARD_FIELDS = `
  uuid
  slug
  ownerId
  ownerDisplayName
  ownerAvatarUrl
  boardType
  layoutId
  sizeId
  setIds
  name
  description
  locationName
  latitude
  longitude
  isPublic
  isUnlisted
  hideLocation
  isOwned
  angle
  isAngleAdjustable
  createdAt
  layoutName
  sizeName
  sizeDescription
  setNames
  totalAscents
  uniqueClimbers
  followerCount
  commentCount
  isFollowedByMe
  gymId
  gymUuid
  gymName
  distanceMeters
  serialNumber
`;

const CLIMB_SEARCH_FIELDS = `
  uuid
  boardType
  layoutId
  setter_username
  userId
  name
  frames
  angle
  ascensionist_count
  difficulty
  quality_average
  stars
  difficulty_error
  benchmark_difficulty
  is_draft
  is_no_match
  characteristics
  published_at
  created_at
  userAscents
  userAttempts
  framesCount
  framesPace
`;

const CLIMB_DETAIL_FIELDS = `
  uuid
  boardType
  layoutId
  setter_username
  userId
  name
  description
  frames
  angle
  ascensionist_count
  difficulty
  quality_average
  stars
  difficulty_error
  mirrored
  benchmark_difficulty
  is_no_match
  characteristics
  userAscents
  userAttempts
  is_draft
  created_at
  published_at
  framesCount
  framesPace
`;

// ============================================
// User Profile Queries
// ============================================

export const GET_PROFILE = gql`
  query GetProfile {
    profile {
      id
      email
      displayName
      avatarUrl
      isTester
    }
  }
`;

export type GetProfileQueryResponse = {
  profile: UserProfile | null;
};

export const UPDATE_PROFILE = gql`
  mutation UpdateProfile($input: UpdateProfileInput!) {
    updateProfile(input: $input) {
      id
      email
      displayName
      avatarUrl
      isTester
    }
  }
`;

export type UpdateProfileMutationVariables = {
  input: UpdateProfileInput;
};

export type UpdateProfileMutationResponse = {
  updateProfile: UserProfile;
};

export const GET_PUBLIC_PROFILE = gql`
  query GetPublicProfile($userId: ID!) {
    publicProfile(userId: $userId) {
      id
      displayName
      avatarUrl
      followerCount
      followingCount
      isFollowedByMe
    }
  }
`;

export type GetPublicProfileQueryVariables = {
  userId: string;
};

export type GetPublicProfileQueryResponse = {
  publicProfile: PublicUserProfile | null;
};

// ============================================
// Board Configuration Queries
// ============================================

export const GET_GRADES = gql`
  query GetGrades($boardName: String!) {
    grades(boardName: $boardName) {
      difficultyId
      name
    }
  }
`;

export type GetGradesQueryVariables = {
  boardName: string;
};

export type GetGradesQueryResponse = {
  grades: Grade[];
};

export const GET_ANGLES = gql`
  query GetAngles($boardName: String!, $layoutId: Int!) {
    angles(boardName: $boardName, layoutId: $layoutId) {
      angle
    }
  }
`;

export type GetAnglesQueryVariables = {
  boardName: string;
  layoutId: number;
};

export type GetAnglesQueryResponse = {
  angles: Angle[];
};

// ============================================
// Board Entity Queries
// ============================================

export const GET_MY_BOARDS = gql`
  query GetMyBoards($input: MyBoardsInput) {
    myBoards(input: $input) {
      boards {
        ${BOARD_FIELDS}
      }
      totalCount
      hasMore
    }
  }
`;

export type GetMyBoardsQueryVariables = {
  input?: MyBoardsInput;
};

export type GetMyBoardsQueryResponse = {
  myBoards: UserBoardConnection;
};

export const GET_BOARD = gql`
  query GetBoard($boardUuid: ID!) {
    board(boardUuid: $boardUuid) {
      ${BOARD_FIELDS}
    }
  }
`;

export type GetBoardQueryVariables = {
  boardUuid: string;
};

export type GetBoardQueryResponse = {
  board: UserBoard | null;
};

export const SEARCH_BOARDS = gql`
  query SearchBoards($input: SearchBoardsInput!) {
    searchBoards(input: $input) {
      boards {
        ${BOARD_FIELDS}
      }
      totalCount
      hasMore
    }
  }
`;

export type SearchBoardsQueryVariables = {
  input: SearchBoardsInput;
};

export type SearchBoardsQueryResponse = {
  searchBoards: UserBoardConnection;
};

export const GET_BOARDS_BY_SERIAL_NUMBERS = gql`
  query GetBoardsBySerialNumbers($serialNumbers: [String!]!) {
    boardsBySerialNumbers(serialNumbers: $serialNumbers) {
      ${BOARD_FIELDS}
    }
  }
`;

export type GetBoardsBySerialNumbersQueryVariables = {
  serialNumbers: string[];
};

export type GetBoardsBySerialNumbersQueryResponse = {
  boardsBySerialNumbers: UserBoard[];
};

export const GET_POPULAR_BOARD_CONFIGS = gql`
  query GetPopularBoardConfigs($input: PopularBoardConfigsInput) {
    popularBoardConfigs(input: $input) {
      configs {
        boardType
        layoutId
        layoutName
        sizeId
        sizeName
        sizeDescription
        setIds
        setNames
        climbCount
        totalAscents
        boardCount
        displayName
      }
      totalCount
      hasMore
    }
  }
`;

export type GetPopularBoardConfigsQueryVariables = {
  input?: PopularBoardConfigsInput;
};

export type GetPopularBoardConfigsQueryResponse = {
  popularBoardConfigs: {
    configs: PopularBoardConfig[];
    totalCount: number;
    hasMore: boolean;
  };
};

export const CREATE_BOARD = gql`
  mutation CreateBoard($input: CreateBoardInput!) {
    createBoard(input: $input) {
      ${BOARD_FIELDS}
    }
  }
`;

export type CreateBoardMutationVariables = {
  input: CreateBoardInput;
};

export type CreateBoardMutationResponse = {
  createBoard: UserBoard;
};

// ============================================
// Climb Queries
// ============================================

export const SEARCH_CLIMBS = gql`
  query SearchClimbs($input: ClimbSearchInput!) {
    searchClimbs(input: $input) {
      climbs {
        ${CLIMB_SEARCH_FIELDS}
      }
      hasMore
    }
  }
`;

export type SearchClimbsQueryVariables = {
  input: ClimbSearchInput;
};

export type SearchClimbsQueryResponse = {
  searchClimbs: {
    climbs: Climb[];
    hasMore: boolean;
  };
};

export const GET_SETTER_STATS = gql`
  query GetSetterStats($input: SetterStatsInput!) {
    setterStats(input: $input) {
      setterUsername
      climbCount
    }
  }
`;

export type GetSetterStatsQueryVariables = {
  input: SetterStatsInput;
};

export type GetSetterStatsQueryResponse = {
  setterStats: SetterStat[];
};

export const SEARCH_CLIMBS_COUNT = gql`
  query SearchClimbsCount($input: ClimbSearchInput!) {
    searchClimbs(input: $input) {
      totalCount
    }
  }
`;

export type SearchClimbsCountQueryResponse = {
  searchClimbs: {
    totalCount: number;
  };
};

export const GET_CLIMB = gql`
  query GetClimb(
    $boardName: String!
    $layoutId: Int!
    $sizeId: Int!
    $setIds: String!
    $angle: Int!
    $climbUuid: ID!
  ) {
    climb(
      boardName: $boardName
      layoutId: $layoutId
      sizeId: $sizeId
      setIds: $setIds
      angle: $angle
      climbUuid: $climbUuid
    ) {
      ${CLIMB_DETAIL_FIELDS}
    }
  }
`;

export type GetClimbQueryVariables = {
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
  climbUuid: string;
};

export type GetClimbQueryResponse = {
  climb: Climb | null;
};

// ============================================
// Session Queries & Mutations
// ============================================

const SESSION_SUMMARY_FIELDS = `
  sessionId
  totalSends
  totalFlashes
  totalAttempts
  gradeDistribution {
    grade
    flash
    send
    attempt
  }
  hardestClimb {
    climbUuid
    climbName
    grade
    frames
    layoutId
    boardType
    isMirror
  }
  participants {
    userId
    displayName
    avatarUrl
    sends
    flashes
    attempts
  }
  startedAt
  endedAt
  durationMinutes
  goal
`;

const SESSION_HEALTH_EXPORT_FIELDS = `
  sessionId
  startedAt
  endedAt
  durationMinutes
  boardType
  totalSends
  totalAttempts
  hardestClimb {
    climbUuid
    climbName
    grade
  }
  laps {
    tickUuid
    climbedAt
    climbUuid
    climbName
    grade
    status
    attemptCount
    boardType
    angle
  }
  healthKitWorkoutId
`;

export const CREATE_SESSION = gql`
  mutation CreateSession($input: CreateSessionInput!) {
    createSession(input: $input) {
      id
      name
      boardPath
      goal
      isPublic
      isPermanent
      color
      startedAt
    }
  }
`;

export type CreateSessionInput = {
  boardPath: string;
  latitude: number;
  longitude: number;
  name?: string;
  discoverable: boolean;
  goal?: string;
  isPermanent?: boolean;
  boardIds?: number[];
  color?: string;
};

export type CreateSessionMutationVariables = {
  input: CreateSessionInput;
};

export type CreateSessionMutationResponse = {
  createSession: {
    id: string;
    name: string | null;
    boardPath: string;
    goal: string | null;
    isPublic: boolean;
    isPermanent: boolean;
    color: string | null;
    startedAt: string;
  };
};

export const END_SESSION = gql`
  mutation EndSession($sessionId: ID!) {
    endSession(sessionId: $sessionId) {
      ${SESSION_SUMMARY_FIELDS}
    }
  }
`;

export type EndSessionMutationVariables = {
  sessionId: string;
};

export type EndSessionMutationResponse = {
  endSession: SessionSummary | null;
};

export const GET_SESSION_SUMMARY = gql`
  query GetSessionSummary($sessionId: ID!) {
    sessionSummary(sessionId: $sessionId) {
      ${SESSION_SUMMARY_FIELDS}
    }
  }
`;

export type GetSessionSummaryQueryVariables = {
  sessionId: string;
};

export type GetSessionSummaryQueryResponse = {
  sessionSummary: SessionSummary | null;
};

export const GET_SESSION_HEALTH_EXPORT = gql`
  query GetSessionHealthExport($sessionId: ID!) {
    sessionHealthExport(sessionId: $sessionId) {
      ${SESSION_HEALTH_EXPORT_FIELDS}
    }
  }
`;

export type GetSessionHealthExportQueryVariables = {
  sessionId: string;
};

export type GetSessionHealthExportQueryResponse = {
  sessionHealthExport: SessionHealthExport | null;
};

export const GET_NEARBY_SESSIONS = gql`
  query GetNearbySessions($latitude: Float!, $longitude: Float!, $radiusMeters: Float) {
    nearbySessions(latitude: $latitude, longitude: $longitude, radiusMeters: $radiusMeters) {
      id
      name
      boardPath
      participantCount
      distance
      color
    }
  }
`;

export type GetNearbySessionsQueryVariables = {
  latitude: number;
  longitude: number;
  radiusMeters?: number;
};

export type DiscoverableSessionItem = {
  id: string;
  name: string | null;
  boardPath: string;
  participantCount: number;
  distance: number;
  color: string | null;
};

export type GetNearbySessionsQueryResponse = {
  nearbySessions: DiscoverableSessionItem[];
};

// Read-only session preview, used by the join-confirmation screen to show the
// host, board, and participant count before the user commits to joining. The
// `session` query does not join the session — joining happens via JOIN_SESSION
// once the user confirms (see QueueProvider.joinSession).
export const GET_SESSION = gql`
  query GetSession($sessionId: ID!) {
    session(sessionId: $sessionId) {
      id
      name
      boardPath
      color
      goal
      startedAt
      endedAt
      users {
        id
        username
        isLeader
        avatarUrl
        userId
        connectionState
      }
    }
  }
`;

export type GetSessionQueryVariables = {
  sessionId: string;
};

export type SessionPreview = {
  id: string;
  name: string | null;
  boardPath: string;
  color: string | null;
  goal: string | null;
  startedAt: string | null;
  endedAt: string | null;
  users: SessionUser[];
};

export type GetSessionQueryResponse = {
  session: SessionPreview | null;
};

// Presence-independent lifecycle check, read on cold start to decide whether a
// persisted session id should be restored or dropped (#2683). Unlike GET_SESSION
// (gated on live roster, so an ended session and a dormant-but-active solo
// session both read as null), this hits the durable session row. Returns the
// SessionStatus enum directly; null means the session does not exist.
export const SESSION_STATUS = gql`
  query SessionStatus($sessionId: ID!) {
    sessionStatus(sessionId: $sessionId)
  }
`;

export type SessionStatusQueryResponse = {
  sessionStatus: SessionStatus | null;
};

// Authoritative queue snapshot for the active session, fetched after a queue
// mutation fails so the local optimistic delta can't silently diverge from
// peers until the next reconnect FullSync. The shape mirrors the FullSync
// `state.queue` / `state.currentClimbQueueItem` selection — items map through
// `toClimbQueueItem` and feed an INITIAL_QUEUE_DATA dispatch. Declared after
// SUBSCRIPTION_CLIMB_FIELDS is interpolated below.
export type GetSessionQueueStateQueryVariables = {
  sessionId: string;
};

export type GetSessionQueueStateQueryResponse = {
  session: {
    queueState: {
      queue: SubscriptionQueueItem[];
      currentClimbQueueItem: SubscriptionQueueItem | null;
    };
  } | null;
};

// ============================================
// Tick Queries & Mutations
// ============================================

export const SAVE_TICK = gql`
  mutation SaveTick($input: SaveTickInput!) {
    saveTick(input: $input) {
      uuid
      climbUuid
      angle
      isMirror
      status
      attemptCount
      quality
      difficulty
      comment
      climbedAt
    }
  }
`;

export type SaveTickMutationVariables = {
  input: {
    boardType: string;
    climbUuid: string;
    angle: number;
    isMirror: boolean;
    status: TickStatus;
    attemptCount: number;
    quality?: number | null;
    difficulty?: number | null;
    isBenchmark: boolean;
    comment: string;
    climbedAt: string;
    sessionId?: string;
    layoutId?: number;
    sizeId?: number;
    setIds?: string;
  };
};

export type SaveTickMutationResponse = {
  saveTick: {
    uuid: string;
    climbUuid: string;
    angle: number;
    isMirror: boolean;
    status: string;
    attemptCount: number;
    quality: number | null;
    difficulty: number | null;
    comment: string;
    climbedAt: string;
  };
};

// ToggleFavorite mutation + types live in @boardsesh/graphql/operations/favorites.
// Re-exported here so existing mobile imports (`from './operations'`) keep
// working without changing every call site at once. New code should import
// from the shared package directly.
export {
  TOGGLE_FAVORITE,
  type ToggleFavoriteMutationVariables,
  type ToggleFavoriteMutationResponse,
} from '@boardsesh/graphql/operations/favorites';

// ============================================
// Queue Mutations
// ============================================

export const ADD_QUEUE_ITEM = gql`
  mutation AddQueueItem($item: ClimbQueueItemInput!, $position: Int) {
    addQueueItem(item: $item, position: $position) {
      uuid
      climb {
        uuid
        name
        frames
      }
    }
  }
`;

export type AddQueueItemMutationVariables = {
  item: {
    uuid: string;
    climb: {
      uuid: string;
      name: string;
      frames: string;
      setter_username: string;
      angle: number;
      ascensionist_count: number;
      difficulty: string;
      quality_average: string;
      stars: number;
      difficulty_error: string;
      benchmark_difficulty: string | null;
    };
  };
  position?: number;
};

export type AddQueueItemMutationResponse = {
  addQueueItem: {
    uuid: string;
    climb: { uuid: string; name: string; frames: string };
  };
};

export const REMOVE_QUEUE_ITEM = gql`
  mutation RemoveQueueItem($uuid: ID!) {
    removeQueueItem(uuid: $uuid)
  }
`;

export type RemoveQueueItemMutationVariables = {
  uuid: string;
};

export type RemoveQueueItemMutationResponse = {
  removeQueueItem: boolean;
};

export const SET_CURRENT_CLIMB = gql`
  mutation SetCurrentClimb($item: ClimbQueueItemInput, $shouldAddToQueue: Boolean, $correlationId: ID) {
    setCurrentClimb(item: $item, shouldAddToQueue: $shouldAddToQueue, correlationId: $correlationId) {
      uuid
      climb {
        uuid
        name
        frames
      }
    }
  }
`;

export type SetCurrentClimbMutationVariables = {
  item: {
    uuid: string;
    climb: {
      uuid: string;
      name: string;
      frames: string;
      setter_username: string;
      angle: number;
      ascensionist_count: number;
      difficulty: string;
      quality_average: string;
      stars: number;
      difficulty_error: string;
      benchmark_difficulty: string | null;
    };
  } | null;
  shouldAddToQueue?: boolean;
  correlationId?: string;
};

export type SetCurrentClimbMutationResponse = {
  setCurrentClimb: {
    uuid: string;
    climb: { uuid: string; name: string; frames: string };
  } | null;
};

// ============================================
// Social Queries
// ============================================

export const GET_FOLLOWERS = gql`
  query GetFollowers($input: FollowListInput!) {
    followers(input: $input) {
      users {
        id
        displayName
        avatarUrl
        followerCount
        followingCount
        isFollowedByMe
      }
      totalCount
      hasMore
    }
  }
`;

export type GetFollowersQueryVariables = {
  input: { userId: string; limit?: number; offset?: number };
};

export type GetFollowersQueryResponse = {
  followers: FollowConnection;
};

export const GET_FOLLOWING = gql`
  query GetFollowing($input: FollowListInput!) {
    following(input: $input) {
      users {
        id
        displayName
        avatarUrl
        followerCount
        followingCount
        isFollowedByMe
      }
      totalCount
      hasMore
    }
  }
`;

export type GetFollowingQueryVariables = {
  input: { userId: string; limit?: number; offset?: number };
};

export type GetFollowingQueryResponse = {
  following: FollowConnection;
};

export const SEARCH_USERS = gql`
  query SearchUsers($input: SearchUsersInput!) {
    searchUsers(input: $input) {
      results {
        user {
          id
          displayName
          avatarUrl
          followerCount
          followingCount
          isFollowedByMe
        }
        recentAscentCount
        matchReason
      }
      totalCount
      hasMore
    }
  }
`;

export type SearchUsersQueryVariables = {
  input: { query: string; boardType?: string; limit?: number; offset?: number };
};

export type SearchUsersQueryResponse = {
  searchUsers: UserSearchConnection;
};

export const FOLLOW_USER = gql`
  mutation FollowUser($input: FollowInput!) {
    followUser(input: $input)
  }
`;

export type FollowUserMutationVariables = {
  input: { userId: string };
};

export type FollowUserMutationResponse = {
  followUser: boolean;
};

export const UNFOLLOW_USER = gql`
  mutation UnfollowUser($input: FollowInput!) {
    unfollowUser(input: $input)
  }
`;

export type UnfollowUserMutationVariables = {
  input: { userId: string };
};

export type UnfollowUserMutationResponse = {
  unfollowUser: boolean;
};

// ============================================
// Subscription Operations
//
// Subscriptions are plain strings (not gql-tagged) because they go
// through graphql-ws, not graphql-request's HTTP transport.
// ============================================

export const SESSION_UPDATES_SUBSCRIPTION = `
  subscription SessionUpdates($sessionId: ID!) {
    sessionUpdates(sessionId: $sessionId) {
      __typename
      ... on UserJoined {
        user { id username isLeader avatarUrl userId connectionState }
      }
      ... on UserLeft {
        userId
      }
      ... on UserPresenceChanged {
        user { id username isLeader avatarUrl userId connectionState }
      }
      ... on LeaderChanged {
        leaderId
        leaderConnectionId
      }
      ... on WallConfirmedClimb {
        climbUuid
        confirmedAt
        confirmedByParticipantId
        queueItemUuid
      }
      ... on WallDisconnected {
        disconnectedByParticipantId
      }
      ... on SessionEnded {
        reason
        newPath
      }
      ... on SessionBoardPathChanged {
        boardPath
        changedByParticipantId
      }
      ... on SessionBoardSerialChanged {
        lastConnectedBoardSerial
      }
      ... on SessionStatsUpdated {
        sessionId
        totalSends
        totalFlashes
        totalAttempts
        tickCount
        participants {
          userId
          displayName
          avatarUrl
          sends
          flashes
          attempts
        }
        gradeDistribution {
          grade
          flash
          send
          attempt
        }
        boardTypes
        hardestGrade
        durationMinutes
        goal
      }
    }
  }
`;

/**
 * Aggregate live-session stats pushed over `sessionUpdates` (the
 * `SessionStatsUpdated` event). Mirrors the feed/detail stat shape so the
 * in-session analytics view can render flashes + the flash/send/attempt grade
 * split without a separate poll. Ticks are intentionally omitted (the live view
 * shows aggregates only).
 */
export type SessionLiveStatsEvent = {
  sessionId: string;
  totalSends: number;
  totalFlashes: number;
  totalAttempts: number;
  tickCount: number;
  participants: SessionFeedParticipant[];
  gradeDistribution: SessionGradeDistributionItem[];
  boardTypes: string[];
  hardestGrade?: string | null;
  durationMinutes?: number | null;
  goal?: string | null;
};

// Envelope for the session-updates subscription. Fields specific to events the
// mobile app reacts to are optional so a plain `__typename` + field check
// narrows cleanly without a brittle discriminated union; events we don't handle
// fall through the guard. Extend as more event handling lands.
export type SessionUpdateEvent = {
  __typename: string;
  // SessionBoardPathChanged
  boardPath?: string;
  changedByParticipantId?: string | null;
  // UserJoined / UserPresenceChanged
  user?: SessionUser;
  // UserLeft
  userId?: string;
  // LeaderChanged
  leaderId?: string | null;
  leaderConnectionId?: string | null;
  // WallConfirmedClimb
  climbUuid?: string;
  confirmedAt?: string;
  confirmedByParticipantId?: string | null;
  queueItemUuid?: string | null;
  // WallDisconnected
  disconnectedByParticipantId?: string | null;
  // SessionBoardSerialChanged
  lastConnectedBoardSerial?: string | null;
  // SessionEnded
  reason?: string | null;
  newPath?: string | null;
  // SessionStatsUpdated (aggregate fields — see SessionLiveStatsEvent)
  sessionId?: string;
  totalSends?: number;
  totalFlashes?: number;
  totalAttempts?: number;
  tickCount?: number;
  participants?: SessionFeedParticipant[];
  gradeDistribution?: SessionGradeDistributionItem[];
  boardTypes?: string[];
  hardestGrade?: string | null;
  durationMinutes?: number | null;
  goal?: string | null;
};

// Fields the queue UI needs from each climb in a subscription payload.
// Must stay in sync with `climbToQueueItem` in PlayDrawer.tsx and with
// `SubscriptionClimb` in queue-conversion.ts — when these drift, queue
// items received from the server (FullSync on connect, peer mutations)
// arrive with empty grade / quality / rating, so the queue row and the
// re-opened drawer can't render the grade.
const SUBSCRIPTION_CLIMB_FIELDS = `
  uuid
  boardType
  layoutId
  name
  frames
  setter_username
  angle
  ascensionist_count
  difficulty
  quality_average
  stars
  difficulty_error
  benchmark_difficulty
  mirrored
  is_no_match
  characteristics
  framesCount
  framesPace
`;

// QueueItemAdded.item is ClimbQueueItem! and CurrentClimbChanged.item is
// ClimbQueueItem — GraphQL rejects overlapping field selections with
// differing nullability across union members ('Fields "item" conflict ...
// return conflicting types ClimbQueueItem! and ClimbQueueItem'). Alias
// per-variant to disambiguate, matching the shared @boardsesh/graphql
// QUEUE_UPDATES selection set. toSyncQueueEvent in queue-provider reads
// these aliased fields.
export const QUEUE_UPDATES_SUBSCRIPTION = `
  subscription QueueUpdates($sessionId: ID!) {
    queueUpdates(sessionId: $sessionId) {
      __typename
      ... on FullSync {
        sequence
        state {
          sequence
          stateHash
          queue { uuid climb { ${SUBSCRIPTION_CLIMB_FIELDS} } }
          currentClimbQueueItem { uuid climb { ${SUBSCRIPTION_CLIMB_FIELDS} } }
        }
      }
      ... on QueueItemAdded {
        sequence
        stateHash
        addedItem: item { uuid climb { ${SUBSCRIPTION_CLIMB_FIELDS} } }
        position
      }
      ... on QueueItemRemoved {
        sequence
        stateHash
        uuid
      }
      ... on QueueReordered {
        sequence
        stateHash
        uuid
        oldIndex
        newIndex
      }
      ... on CurrentClimbChanged {
        sequence
        stateHash
        currentItem: item { uuid climb { ${SUBSCRIPTION_CLIMB_FIELDS} } }
        clientId
        correlationId
      }
      ... on ClimbMirrored {
        sequence
        stateHash
        mirroredUuid: uuid
        mirrored
      }
    }
  }
`;

// Authoritative queue snapshot for the active session. Fetched over the HTTP
// transport (it's a query, not a subscription) after a queue mutation fails, so
// the local optimistic delta is reconciled against the server immediately
// instead of waiting for the next reconnect FullSync. Selects the same climb
// fields as the FullSync state so items map cleanly through toClimbQueueItem.
export const GET_SESSION_QUEUE_STATE = gql`
  query GetSessionQueueState($sessionId: ID!) {
    session(sessionId: $sessionId) {
      queueState {
        queue { uuid climb { ${SUBSCRIPTION_CLIMB_FIELDS} } }
        currentClimbQueueItem { uuid climb { ${SUBSCRIPTION_CLIMB_FIELDS} } }
      }
    }
  }
`;

export const NOTIFICATION_RECEIVED_SUBSCRIPTION = `
  subscription NotificationReceived {
    notificationReceived {
      notification {
        uuid
        type
        actorId
        actorDisplayName
        actorAvatarUrl
        entityType
        entityId
        commentBody
        climbName
        climbUuid
        boardType
        proposalUuid
        isRead
        createdAt
      }
    }
  }
`;
