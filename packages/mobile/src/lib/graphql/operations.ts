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
  HoldOutlineConfigInput,
  HoldOutlineKind,
  PlacementOutline,
  UpsertHoldOutlineOverrideInput,
  DeleteHoldOutlineOverrideInput,
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
  timerName
  canEdit
`;

const CLIMB_SEARCH_FIELDS = `
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
  boardseshDifficulty
  boardseshConfidence
  compatibleSizeIds
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
  boardseshDifficulty
  boardseshConfidence
  compatibleSizeIds
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
      createdAt
      favoriteCount
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
  query GetBoardsBySerialNumbers($serialNumbers: [String!]!, $boardType: String) {
    boardsBySerialNumbers(serialNumbers: $serialNumbers, boardType: $boardType) {
      ${BOARD_FIELDS}
    }
  }
`;

export type GetBoardsBySerialNumbersQueryVariables = {
  serialNumbers: string[];
  // The board type advertised in the BLE device name. Sent only when every
  // serial in the request advertises the same type; a mixed scan omits it and
  // the caller filters per serial instead. See lib/ble/advertised-board-type.ts.
  boardType?: string;
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
    renderBoard {
      layoutId
      sizeId
      setIds
    }
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
  notes
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
  mutation EndSession($sessionId: ID!, $timezone: String, $notes: String) {
    endSession(sessionId: $sessionId, timezone: $timezone, notes: $notes) {
      ${SESSION_SUMMARY_FIELDS}
    }
  }
`;

export type EndSessionMutationVariables = {
  sessionId: string;
  /** IANA timezone of the ending device, for local-time export to platforms like Strava. */
  timezone?: string;
  /** Optional free-text end-of-session recap persisted on the session. */
  notes?: string;
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

// Who started the active session, read in-session to decide whether to offer
// the destructive End action at all (#3502). Deliberately its OWN document
// rather than another field on GET_SESSION: that query also backs the
// join-by-link screen (app/join/[sessionId].tsx), and GraphQL validates whole
// documents — a new-bundle/old-backend skew would fail the entire query and
// break joining, which is far worse than the bug this fixes. Isolated here, the
// same skew just leaves ownership unknown and the exit UI falls back to its
// permissive default.
//
// `createdByUserId` is redacted to null for non-members server-side, and it is
// NOT an authorization signal — endSession re-checks creator/leader.
export const GET_SESSION_OWNER = gql`
  query GetSessionOwner($sessionId: ID!) {
    session(sessionId: $sessionId) {
      id
      createdByUserId
    }
  }
`;

export type SessionOwner = {
  id: string;
  createdByUserId: string | null;
};

export type GetSessionOwnerQueryResponse = {
  session: SessionOwner | null;
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
    // Null when the caller isn't a session member (e.g. this resync races a
    // leaveSession, or the backend can't verify HTTP membership) — the
    // resolver returns a redacted preview rather than an error. Callers
    // already null-guard this (see resyncQueueFromServer in queue-provider.tsx).
    queueState: {
      // Selected so the caller can re-baseline the shared sync gate
      // (createQueueSyncGate) to this snapshot's authoritative sequence/hash
      // after applying it — see resyncQueueFromServer in queue-provider.tsx.
      sequence: number;
      stateHash: string;
      // Order-sensitive (v2) hash — optional during the dual-hash rollout.
      stateHashOrdered?: string | null;
      queue: SubscriptionQueueItem[];
      currentClimbQueueItem: SubscriptionQueueItem | null;
    } | null;
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
    /**
     * Client-generated tick id. The offline adapter stamps it before the local
     * write so the SQLite row, the queued replay and any network fall-through
     * all name the same server row — `saveTick` returns the existing tick for a
     * repeat uuid instead of logging a second send.
     */
    uuid?: string;
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
      ... on SessionRosterSnapshot {
        users { id username isLeader avatarUrl userId connectionState }
        boardPath
      }
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
      ... on SessionNameChanged {
        name
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
  // SessionBoardPathChanged / SessionNameChanged
  boardPath?: string;
  changedByParticipantId?: string | null;
  // SessionNameChanged — new title, or null when cleared
  name?: string | null;
  // UserJoined / UserPresenceChanged
  user?: SessionUser;
  // SessionRosterSnapshot — full authoritative roster seeded on subscribe
  users?: SessionUser[];
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
//
// Must stay in sync with `SubscriptionClimb` / `toClimbQueueItem` in
// lib/queue-conversion.ts and with `climbToQueueItem` in
// lib/climb-to-queue-item.ts. When these drift, queue items received from the
// server (FullSync on connect, peer mutations) arrive with the missing field
// blank — and worse, a field we WRITE but don't select here flaps: this client
// rebuilds the item without it, then its next full-queue write pushes the gap
// back to every peer. `userAscents` / `userAttempts` are the deliberate
// exception; see the contract test for why.
//
// Exported so `lib/__tests__/queue-conversion.test.ts` can assert the rebuild
// covers exactly this set instead of hand-listing it. The exact field set is
// enforced by packages/backend/src/__tests__/queue-climb-field-contract.test.ts
// (which reads this const straight out of the source). See #3927.
export const SUBSCRIPTION_CLIMB_FIELDS = `
  uuid
  boardType
  layoutId
  userId
  name
  description
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
  is_draft
  published_at
  framesCount
  framesPace
  boardseshDifficulty
  boardseshConfidence
  compatibleSizeIds
`;

// The item-level fields that cross the wire alongside the climb. This client now
// WRITES all four (`toQueueItemWireInput` in lib/climb-to-queue-item.ts), so
// omitting them here would make them FLAP: we would rebuild every peer item
// without attribution and our next full-queue write would push the gap back to
// the whole crew — the exact bug #3995 was filed for, one level up from #3927.
//
// Exported so `lib/__tests__/queue-conversion.test.ts` can assert the rebuild
// covers exactly this set, and read straight out of this source by
// packages/backend/src/__tests__/queue-climb-field-contract.test.ts, which ties
// it to the GraphQL `ClimbQueueItemInput`.
export const SUBSCRIPTION_QUEUE_ITEM_FIELDS = `
  uuid
  climb { ${SUBSCRIPTION_CLIMB_FIELDS} }
  addedBy
  addedByUser { id username avatarUrl }
  tickedBy
  suggested
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
          stateHashOrdered
          queue { ${SUBSCRIPTION_QUEUE_ITEM_FIELDS} }
          currentClimbQueueItem { ${SUBSCRIPTION_QUEUE_ITEM_FIELDS} }
        }
      }
      ... on QueueItemAdded {
        sequence
        stateHash
        stateHashOrdered
        addedItem: item { ${SUBSCRIPTION_QUEUE_ITEM_FIELDS} }
        position
        clientId
      }
      ... on QueueItemRemoved {
        sequence
        stateHash
        stateHashOrdered
        uuid
        clientId
      }
      ... on QueueReordered {
        sequence
        stateHash
        stateHashOrdered
        uuid
        oldIndex
        newIndex
      }
      ... on CurrentClimbChanged {
        sequence
        stateHash
        stateHashOrdered
        currentItem: item { ${SUBSCRIPTION_QUEUE_ITEM_FIELDS} }
        clientId
        correlationId
      }
      ... on ClimbMirrored {
        sequence
        stateHash
        stateHashOrdered
        mirroredUuid: uuid
        mirrored
      }
      ... on PlaybackStateChanged {
        sequence
        climbUuid
        frameIndex
        frameCount
        isPlaying
        speed
        paceMs
        anchorTimestamp
        clientId
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
        sequence
        stateHash
        stateHashOrdered
        queue { ${SUBSCRIPTION_QUEUE_ITEM_FIELDS} }
        currentClimbQueueItem { ${SUBSCRIPTION_QUEUE_ITEM_FIELDS} }
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

// ============================================
// Sync Pull Queries
// ============================================

export type SyncCursorInput = {
  updatedAt: string;
  syncSeq: string;
};

export type SyncCursor = {
  updatedAt: string;
  syncSeq: string;
};

export type SyncResult = {
  documents: Record<string, unknown>[];
  cursor: SyncCursor;
  hasMore: boolean;
};

export type SyncDeletionRecord = {
  tableName: string;
  recordId: string;
  deletedAt: string;
};

export type SyncDeletionsResult = {
  deletions: SyncDeletionRecord[];
  cursor: SyncCursor;
  hasMore: boolean;
};

export const SYNC_TICKS = gql`
  query SyncTicks($cursor: SyncCursorInput, $limit: Int! = 500) {
    syncTicks(cursor: $cursor, limit: $limit) {
      documents
      cursor {
        updatedAt
        syncSeq
      }
      hasMore
    }
  }
`;

export type SyncTicksQueryVariables = {
  cursor?: SyncCursorInput;
  limit?: number;
};

export type SyncTicksQueryResponse = {
  syncTicks: SyncResult;
};

export const SYNC_PLAYLISTS = gql`
  query SyncPlaylists($cursor: SyncCursorInput, $limit: Int! = 500) {
    syncPlaylists(cursor: $cursor, limit: $limit) {
      documents
      cursor {
        updatedAt
        syncSeq
      }
      hasMore
    }
  }
`;

export type SyncPlaylistsQueryVariables = {
  cursor?: SyncCursorInput;
  limit?: number;
};

export type SyncPlaylistsQueryResponse = {
  syncPlaylists: SyncResult;
};

export const SYNC_PLAYLIST_CLIMBS = gql`
  query SyncPlaylistClimbs($cursor: SyncCursorInput, $limit: Int! = 500) {
    syncPlaylistClimbs(cursor: $cursor, limit: $limit) {
      documents
      cursor {
        updatedAt
        syncSeq
      }
      hasMore
    }
  }
`;

export type SyncPlaylistClimbsQueryVariables = {
  cursor?: SyncCursorInput;
  limit?: number;
};

export type SyncPlaylistClimbsQueryResponse = {
  syncPlaylistClimbs: SyncResult;
};

export const SYNC_FAVORITES = gql`
  query SyncFavorites($cursor: SyncCursorInput, $limit: Int! = 500) {
    syncFavorites(cursor: $cursor, limit: $limit) {
      documents
      cursor {
        updatedAt
        syncSeq
      }
      hasMore
    }
  }
`;

export type SyncFavoritesQueryVariables = {
  cursor?: SyncCursorInput;
  limit?: number;
};

export type SyncFavoritesQueryResponse = {
  syncFavorites: SyncResult;
};

export const SYNC_USER_FOLLOWS = gql`
  query SyncUserFollows($cursor: SyncCursorInput, $limit: Int! = 500) {
    syncUserFollows(cursor: $cursor, limit: $limit) {
      documents
      cursor {
        updatedAt
        syncSeq
      }
      hasMore
    }
  }
`;

export type SyncUserFollowsQueryVariables = {
  cursor?: SyncCursorInput;
  limit?: number;
};

export type SyncUserFollowsQueryResponse = {
  syncUserFollows: SyncResult;
};

export const SYNC_SETTER_FOLLOWS = gql`
  query SyncSetterFollows($cursor: SyncCursorInput, $limit: Int! = 500) {
    syncSetterFollows(cursor: $cursor, limit: $limit) {
      documents
      cursor {
        updatedAt
        syncSeq
      }
      hasMore
    }
  }
`;

export type SyncSetterFollowsQueryVariables = {
  cursor?: SyncCursorInput;
  limit?: number;
};

export type SyncSetterFollowsQueryResponse = {
  syncSetterFollows: SyncResult;
};

export const SYNC_PLAYLIST_FOLLOWS = gql`
  query SyncPlaylistFollows($cursor: SyncCursorInput, $limit: Int! = 500) {
    syncPlaylistFollows(cursor: $cursor, limit: $limit) {
      documents
      cursor {
        updatedAt
        syncSeq
      }
      hasMore
    }
  }
`;

export type SyncPlaylistFollowsQueryVariables = {
  cursor?: SyncCursorInput;
  limit?: number;
};

export type SyncPlaylistFollowsQueryResponse = {
  syncPlaylistFollows: SyncResult;
};

export const SYNC_CLIMBS = gql`
  query SyncClimbs($boardType: String!, $cursor: SyncCursorInput, $limit: Int! = 500) {
    syncClimbs(boardType: $boardType, cursor: $cursor, limit: $limit) {
      documents
      cursor {
        updatedAt
        syncSeq
      }
      hasMore
    }
  }
`;

export type SyncClimbsQueryVariables = {
  boardType: string;
  cursor?: SyncCursorInput;
  limit?: number;
};

export type SyncClimbsQueryResponse = {
  syncClimbs: SyncResult;
};

export const SYNC_CLIMB_STATS = gql`
  query SyncClimbStats($boardType: String!, $cursor: SyncCursorInput, $limit: Int! = 500) {
    syncClimbStats(boardType: $boardType, cursor: $cursor, limit: $limit) {
      documents
      cursor {
        updatedAt
        syncSeq
      }
      hasMore
    }
  }
`;

export type SyncClimbStatsQueryVariables = {
  boardType: string;
  cursor?: SyncCursorInput;
  limit?: number;
};

export type SyncClimbStatsQueryResponse = {
  syncClimbStats: SyncResult;
};

export const SYNC_DELETIONS = gql`
  query SyncDeletions($cursor: SyncCursorInput, $limit: Int! = 500) {
    syncDeletions(cursor: $cursor, limit: $limit) {
      deletions {
        tableName
        recordId
        deletedAt
      }
      cursor {
        updatedAt
        syncSeq
      }
      hasMore
    }
  }
`;

export type SyncDeletionsQueryVariables = {
  cursor?: SyncCursorInput;
  limit?: number;
};

export type SyncDeletionsQueryResponse = {
  syncDeletions: SyncDeletionsResult;
};

// ============================================
// Push Token Mutations
// ============================================

export const REGISTER_ACTIVITY_PUSH_TOKEN = gql`
  mutation RegisterActivityPushToken($sessionId: ID!, $token: String!) {
    registerActivityPushToken(sessionId: $sessionId, token: $token)
  }
`;

export type RegisterActivityPushTokenMutationVariables = {
  sessionId: string;
  token: string;
};

export type RegisterActivityPushTokenMutationResponse = {
  registerActivityPushToken: boolean;
};

export const UNREGISTER_ACTIVITY_PUSH_TOKEN = gql`
  mutation UnregisterActivityPushToken($sessionId: ID!, $token: String!) {
    unregisterActivityPushToken(sessionId: $sessionId, token: $token)
  }
`;

export type UnregisterActivityPushTokenMutationVariables = {
  sessionId: string;
  token: string;
};

export type UnregisterActivityPushTokenMutationResponse = {
  unregisterActivityPushToken: boolean;
};

// ============================================
// Favorite Mutations (Idempotent)
// ============================================

export type AddFavoriteInput = {
  boardName: string;
  climbUuid: string;
  angle: number;
};

export type RemoveFavoriteInput = {
  boardName: string;
  climbUuid: string;
  angle: number;
};

export const ADD_FAVORITE = gql`
  mutation AddFavorite($input: AddFavoriteInput!) {
    addFavorite(input: $input)
  }
`;

export type AddFavoriteMutationVariables = {
  input: AddFavoriteInput;
};

export type AddFavoriteMutationResponse = {
  addFavorite: boolean;
};

export const REMOVE_FAVORITE = gql`
  mutation RemoveFavorite($input: RemoveFavoriteInput!) {
    removeFavorite(input: $input)
  }
`;

export type RemoveFavoriteMutationVariables = {
  input: RemoveFavoriteInput;
};

export type RemoveFavoriteMutationResponse = {
  removeFavorite: boolean;
};

// ============================================
// Hold Outline Overrides (admin outline editor)
// ============================================

/**
 * The viewer's admin flag, asked for on its own rather than added to
 * `GET_PROFILE`.
 *
 * `UserProfile.isAdmin` ships in a backend deploy that lands AFTER this JS does
 * (mobile updates over the air, the backend on its own cadence). Folded into the
 * profile document, an unknown field would fail the whole query and blank the
 * You tab for everyone until the backend caught up. On its own it fails alone,
 * and the hook reading it falls closed to "not an admin".
 */
export const GET_PROFILE_ADMIN_FLAG = gql`
  query ProfileAdminFlag {
    profile {
      id
      isAdmin
    }
  }
`;

export type GetProfileAdminFlagQueryResponse = {
  profile: { id: string; isAdmin: boolean } | null;
};

export const GET_HOLD_OUTLINES = gql`
  query HoldOutlines($input: HoldOutlineConfigInput!) {
    holdOutlines(input: $input) {
      boardName
      layoutId
      sizeId
      shardOutlines {
        placementId
        outline
      }
      overrides {
        placementId
        kind
        outline
        note
        authorId
        authorDisplayName
        updatedAt
      }
    }
  }
`;

export type HoldOutlinesQueryVariables = {
  input: HoldOutlineConfigInput;
};

/**
 * Hand-written response type: `packages/mobile` is deliberately outside the
 * codegen globs, so every operation in this file declares the exact selection it
 * asks for. Narrower than the schema's `BoardHoldOutlines` — the config echo is
 * dropped from the override rows because the query already knows it.
 */
export type HoldOutlinesQueryResponse = {
  holdOutlines: {
    boardName: string;
    layoutId: number;
    sizeId: number;
    shardOutlines: PlacementOutline[];
    overrides: HoldOutlineOverrideRow[];
  };
};

/** One override as this document selects it. */
export type HoldOutlineOverrideRow = {
  placementId: number;
  kind: HoldOutlineKind;
  outline: number[];
  note: string | null;
  authorId: string | null;
  authorDisplayName: string | null;
  updatedAt: string;
};

export const UPSERT_HOLD_OUTLINE_OVERRIDE = gql`
  mutation UpsertHoldOutlineOverride($input: UpsertHoldOutlineOverrideInput!) {
    upsertHoldOutlineOverride(input: $input) {
      placementId
      kind
      outline
      note
      authorId
      authorDisplayName
      updatedAt
    }
  }
`;

export type UpsertHoldOutlineOverrideMutationVariables = {
  input: UpsertHoldOutlineOverrideInput;
};

export type UpsertHoldOutlineOverrideMutationResponse = {
  upsertHoldOutlineOverride: HoldOutlineOverrideRow;
};

export const DELETE_HOLD_OUTLINE_OVERRIDE = gql`
  mutation DeleteHoldOutlineOverride($input: DeleteHoldOutlineOverrideInput!) {
    deleteHoldOutlineOverride(input: $input)
  }
`;

export type DeleteHoldOutlineOverrideMutationVariables = {
  input: DeleteHoldOutlineOverrideInput;
};

export type DeleteHoldOutlineOverrideMutationResponse = {
  deleteHoldOutlineOverride: boolean;
};
