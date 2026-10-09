import { gql } from 'graphql-request';
import type {
  UserProfile,
  UpdateProfileInput,
  Climb,
  Grade,
  SetterStat,
  SetterStatsInput,
  Angle,
  SessionUser,
  SessionStatus,
  SessionFeedParticipant,
  SessionGradeDistributionItem,
  SessionHealthExport,
  HoldOutlineConfigInput,
  HoldOutlineKind,
  PlacementOutline,
  UpsertHoldOutlineOverrideInput,
  DeleteHoldOutlineOverrideInput,
} from '@boardsesh/shared-schema';
import type { SubscriptionQueueItem } from '../queue-conversion';

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

// The board documents (GetMyBoards, SearchBoards, CreateBoard, ...) live in
// @boardsesh/graphql/operations/boards; import them from there. GetBoard is
// the one re-export kept: providers/bluetooth-provider.tsx imports it from
// here, and repointing that import would be a Bluetooth-file edit made only to
// delete this line.
export {
  GET_BOARD,
  type GetBoardQueryVariables,
  type GetBoardQueryResponse,
} from '@boardsesh/graphql/operations/boards';

// ============================================
// Climb Queries
// ============================================

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

// ============================================
// Session Queries & Mutations
// ============================================

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
      isPublic
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
  /** Shown in live-session listings. The creator flips it from the Record tab. */
  isPublic: boolean;
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
// Subscription Operations
//
// Subscriptions are plain strings (not gql-tagged) because they go
// through graphql-ws, not graphql-request's HTTP transport.
//
// SessionUpdates and QueueUpdates are the two operations still defined both
// here and in @boardsesh/graphql/operations/queue-session. These are the texts
// the app sends and the screenshot replay set recorded; the shared copies are
// sent only by the backend test harness. Do not swap one for the other: the
// shared SessionUpdates selects different fields, and both shared texts miss
// the recorded fixtures. What merging them takes is written down beside
// KNOWN_DUPLICATES in __tests__/no-duplicate-operations.test.ts.
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
  missingHoldCount
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

// ============================================
// Board account sync ("Sync now")
// ============================================

export const REQUEST_PROVIDER_SYNC = gql`
  mutation RequestProviderSync($boardType: String!) {
    requestProviderSync(boardType: $boardType) {
      runId
      status
      coalesced
    }
  }
`;

export type RequestProviderSyncMutationVariables = {
  boardType: string;
};

export type RequestProviderSyncMutationResponse = {
  requestProviderSync: { runId: string; status: string; coalesced: boolean };
};
