// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

// GraphQL Operations for Boardsesh Queue Client
// These operations are used by the web app to communicate with the backend

// Fragment for reusable climb fields.
//
// This selection set is the READ half of the queue climb boundary and must stay
// in lockstep with what clients WRITE (`ClimbInput`). A field that is written
// but not selected here does not merely go missing — it FLAPS: the peer rebuilds
// the item without it, and that peer's next full-queue write pushes the gap back
// to everyone, so the originator loses it on the following FullSync. The exact
// field set is enforced by
// `packages/backend/src/__tests__/queue-climb-field-contract.test.ts`. See #3927.
const CLIMB_FIELDS = `
  uuid
  boardType
  layoutId
  setter_username
  userId
  name
  description
  frames
  framesCount
  framesPace
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
  is_draft
  published_at
  boardseshDifficulty
  boardseshConfidence
  compatibleSizeIds
`;

const QUEUE_ITEM_USER_FIELDS = `
  id
  username
  avatarUrl
`;

const QUEUE_ITEM_FIELDS = `
  uuid
  climb {
    ${CLIMB_FIELDS}
  }
  addedBy
  addedByUser {
    ${QUEUE_ITEM_USER_FIELDS}
  }
  tickedBy
  suggested
`;

// Mutations
export const JOIN_SESSION = `
  mutation JoinSession($sessionId: ID!, $boardPath: String!, $username: String, $avatarUrl: String, $participantId: ID, $initialQueue: [ClimbQueueItemInput!], $initialCurrentClimb: ClimbQueueItemInput, $sessionName: String) {
    joinSession(sessionId: $sessionId, boardPath: $boardPath, username: $username, avatarUrl: $avatarUrl, participantId: $participantId, initialQueue: $initialQueue, initialCurrentClimb: $initialCurrentClimb, sessionName: $sessionName) {
      id
      name
      boardPath
      clientId
      participantId
      isLeader
      lastConnectedBoardSerial
      goal
      isPublic
      startedAt
      endedAt
      isPermanent
      color
      users {
        id
        username
        isLeader
        avatarUrl
        userId
        connectionState
      }
      queueState {
        sequence
        stateHash
        stateHashOrdered
        queue {
          ${QUEUE_ITEM_FIELDS}
        }
        currentClimbQueueItem {
          ${QUEUE_ITEM_FIELDS}
        }
      }
    }
  }
`;

export const LEAVE_SESSION = `
  mutation LeaveSession {
    leaveSession
  }
`;

// Re-announce the current connection's display name + avatar to everyone in the
// session. Used when the authenticated profile resolves after we've already
// joined (cold launch into a restored session) or when the user edits their
// profile mid-session — JOIN_SESSION carries identity for the common case.
export const UPDATE_USERNAME = `
  mutation UpdateUsername($username: String!, $avatarUrl: String) {
    updateUsername(username: $username, avatarUrl: $avatarUrl)
  }
`;

export const END_SESSION = `
  mutation EndSession($sessionId: ID!, $timezone: String) {
    endSession(sessionId: $sessionId, timezone: $timezone) {
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
`;

export const ADD_QUEUE_ITEM = `
  mutation AddQueueItem($item: ClimbQueueItemInput!, $position: Int) {
    addQueueItem(item: $item, position: $position) {
      ${QUEUE_ITEM_FIELDS}
    }
  }
`;

export const REMOVE_QUEUE_ITEM = `
  mutation RemoveQueueItem($uuid: ID!) {
    removeQueueItem(uuid: $uuid)
  }
`;

export const REORDER_QUEUE_ITEM = `
  mutation ReorderQueueItem($uuid: ID!, $oldIndex: Int!, $newIndex: Int!) {
    reorderQueueItem(uuid: $uuid, oldIndex: $oldIndex, newIndex: $newIndex)
  }
`;

export const SET_CURRENT_CLIMB = `
  mutation SetCurrentClimb($item: ClimbQueueItemInput, $shouldAddToQueue: Boolean, $correlationId: ID) {
    setCurrentClimb(item: $item, shouldAddToQueue: $shouldAddToQueue, correlationId: $correlationId) {
      ${QUEUE_ITEM_FIELDS}
    }
  }
`;

export const MIRROR_CURRENT_CLIMB = `
  mutation MirrorCurrentClimb($mirrored: Boolean!) {
    mirrorCurrentClimb(mirrored: $mirrored) {
      ${QUEUE_ITEM_FIELDS}
    }
  }
`;

export const PUBLISH_PLAYBACK_STATE = `
  mutation PublishPlaybackState($input: PlaybackStateInput!) {
    publishPlaybackState(input: $input)
  }
`;

export const REPLACE_QUEUE_ITEM = `
  mutation ReplaceQueueItem($uuid: ID!, $item: ClimbQueueItemInput!) {
    replaceQueueItem(uuid: $uuid, item: $item) {
      ${QUEUE_ITEM_FIELDS}
    }
  }
`;

// Wall confirmation — the BLE-capable phone tells the backend that the climb
// was successfully relayed to the board. Server broadcasts WallConfirmedClimb
// to every session participant so non-BLE clients can flip the lightbulb to
// confirmed and dismiss their fallback timer. The optional $queueItemUuid
// disambiguates which queued press the confirmation matches when the same
// climb is queued twice. Returns Session! so optimistic-UI callers can apply
// server-derived state without a follow-up query.
export const CONFIRM_CLIMB_ON_WALL = `
  mutation ConfirmClimbOnWall($climbUuid: ID!, $queueItemUuid: ID) {
    confirmClimbOnWall(climbUuid: $climbUuid, queueItemUuid: $queueItemUuid) {
      id
      lastConnectedBoardSerial
    }
  }
`;

// Wall disconnect — the session-scoped counterpart to board-presence's
// reportBoardDisconnect. The BLE-capable phone tells the backend its link to
// the wall dropped so the server broadcasts WallDisconnected and every member
// turns the lightbulb off. The current climb is preserved; pressing the
// lightbulb re-asserts it.
export const REPORT_WALL_DISCONNECT = `
  mutation ReportWallDisconnect {
    reportWallDisconnect {
      id
      lastConnectedBoardSerial
    }
  }
`;

// Session board serial — when a phone pairs with a physical board over BLE,
// it records the serial on the session so other (mobile) participants can
// auto-connect without picking from a list. Returns Session! so optimistic-UI
// callers can apply server-derived state without a follow-up query.
export const SET_SESSION_BOARD_SERIAL = `
  mutation SetSessionBoardSerial($serial: String!) {
    setSessionBoardSerial(serial: $serial) {
      id
      lastConnectedBoardSerial
    }
  }
`;

// Session board path — broadcasts angle (and any presentational route
// changes) across all session participants. The angle selector pushes the URL
// locally for instant feedback, then fires this mutation so the backend
// persists the new boardPath and broadcasts SessionBoardPathChanged to other
// members, who then router.replace into the new angle.
export const SET_SESSION_BOARD_PATH = `
  mutation SetSessionBoardPath($boardPath: String!) {
    setSessionBoardPath(boardPath: $boardPath) {
      id
      boardPath
    }
  }
`;

export const SET_QUEUE = `
  mutation SetQueue($queue: [ClimbQueueItemInput!]!, $currentClimbQueueItem: ClimbQueueItemInput) {
    setQueue(queue: $queue, currentClimbQueueItem: $currentClimbQueueItem) {
      sequence
      stateHash
      stateHashOrdered
      queue {
        ${QUEUE_ITEM_FIELDS}
      }
      currentClimbQueueItem {
        ${QUEUE_ITEM_FIELDS}
      }
    }
  }
`;

// Same mutation, plus the caller's baseline sequence so the server can re-append
// climbs a party member added while this payload was being composed (#3933).
//
// A SEPARATE document rather than an extra variable on SET_QUEUE above, because
// an unknown argument is a document-level GraphQL validation error — passing the
// variable as undefined does not help. One document naming `baselineSequence`
// would hard-fail EVERY setQueue (web's Clear button included) against a backend
// that hasn't deployed the argument yet: the Vercel-web/Railway-backend skew
// window, web preview deploys pointed at prod, and mobile preview channels
// running a branch build. Callers pick this document only when they actually
// have a baseline, and fall back to SET_QUEUE if the server rejects it.
export const SET_QUEUE_WITH_BASELINE = `
  mutation SetQueueWithBaseline($queue: [ClimbQueueItemInput!]!, $currentClimbQueueItem: ClimbQueueItemInput, $baselineSequence: Int) {
    setQueue(queue: $queue, currentClimbQueueItem: $currentClimbQueueItem, baselineSequence: $baselineSequence) {
      sequence
      stateHash
      stateHashOrdered
      queue {
        ${QUEUE_ITEM_FIELDS}
      }
      currentClimbQueueItem {
        ${QUEUE_ITEM_FIELDS}
      }
    }
  }
`;

export const CREATE_SESSION = `
  mutation CreateSession($input: CreateSessionInput!) {
    createSession(input: $input) {
      id
      name
      boardPath
      clientId
      participantId
      isLeader
      lastConnectedBoardSerial
      goal
      isPublic
      startedAt
      endedAt
      isPermanent
      color
      users {
        id
        username
        isLeader
        avatarUrl
        userId
        connectionState
      }
      queueState {
        sequence
        stateHash
        stateHashOrdered
        queue {
          ${QUEUE_ITEM_FIELDS}
        }
        currentClimbQueueItem {
          ${QUEUE_ITEM_FIELDS}
        }
      }
    }
  }
`;

// Subscriptions
export const SESSION_UPDATES = `
  subscription SessionUpdates($sessionId: ID!) {
    sessionUpdates(sessionId: $sessionId) {
      __typename
      ... on SessionRosterSnapshot {
        users {
          id
          username
          isLeader
          avatarUrl
          userId
          connectionState
        }
        boardPath
      }
      ... on UserJoined {
        user {
          id
          username
          isLeader
          avatarUrl
          userId
          connectionState
        }
      }
      ... on UserLeft {
        userId
      }
      ... on UserPresenceChanged {
        user {
          id
          username
          isLeader
          avatarUrl
          userId
          connectionState
        }
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
      ... on SessionBoardSerialChanged {
        lastConnectedBoardSerial
      }
      ... on SessionBoardPathChanged {
        boardPath
        changedByParticipantId
      }
      ... on SessionEnded {
        reason
        newPath
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
        ticks {
          uuid
          userId
          climbUuid
          climbName
          boardType
          layoutId
          angle
          status
          attemptCount
          difficulty
          difficultyName
          quality
          isMirror
          isBenchmark
          comment
          frames
          setterUsername
          climbedAt
          upvotes
          totalAttempts
        }
      }
    }
  }
`;

// Query for delta sync event replay (Phase 2)
export const EVENTS_REPLAY = `
  query EventsReplay($sessionId: ID!, $sinceSequence: Int!) {
    eventsReplay(sessionId: $sessionId, sinceSequence: $sinceSequence) {
      currentSequence
      events {
        __typename
        ... on FullSync {
          sequence
          state {
            sequence
            stateHash
            stateHashOrdered
            queue {
              ${QUEUE_ITEM_FIELDS}
            }
            currentClimbQueueItem {
              ${QUEUE_ITEM_FIELDS}
            }
          }
        }
        # No clientId on the add/remove fragments below, on purpose: delta replay only runs from
        # session-connection.ts's reconnect(), so every replayed event carries the PRE-reconnect
        # connectionId while the client already holds the new one. The self-echo comparison could
        # never match, so the field would be dead weight (see #3382 and #4042).
        ... on QueueItemAdded {
          sequence
          stateHash
          stateHashOrdered
          addedItem: item {
            ${QUEUE_ITEM_FIELDS}
          }
          position
        }
        ... on QueueItemRemoved {
          sequence
          stateHash
          stateHashOrdered
          uuid
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
          currentItem: item {
            ${QUEUE_ITEM_FIELDS}
          }
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
  }
`;

export const QUEUE_UPDATES = `
  subscription QueueUpdates($sessionId: ID!) {
    queueUpdates(sessionId: $sessionId) {
      __typename
      ... on FullSync {
        sequence
        state {
          sequence
          stateHash
          stateHashOrdered
          queue {
            ${QUEUE_ITEM_FIELDS}
          }
          currentClimbQueueItem {
            ${QUEUE_ITEM_FIELDS}
          }
        }
      }
      ... on QueueItemAdded {
        sequence
        stateHash
        stateHashOrdered
        addedItem: item {
          ${QUEUE_ITEM_FIELDS}
        }
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
        currentItem: item {
          ${QUEUE_ITEM_FIELDS}
        }
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

// Mirrors the native iOS subscription in SessionWebSocketManager.swift. Keeping
// a copy here lets the schema-validation test catch drift in fields that native
// decodes manually, including climb.mirrored for widget-triggered BLE updates.
export const NATIVE_IOS_QUEUE_UPDATES = `
  subscription QueueUpdates($sessionId: ID!) {
    queueUpdates(sessionId: $sessionId) {
      __typename
      ... on FullSync {
        sequence
        state {
          sequence
          stateHash
          queue {
            uuid
            climb { uuid setter_username name frames framesCount framesPace angle ascensionist_count difficulty quality_average stars difficulty_error mirrored benchmark_difficulty }
            addedBy
            suggested
          }
          currentClimbQueueItem {
            uuid
            climb { uuid setter_username name frames framesCount framesPace angle ascensionist_count difficulty quality_average stars difficulty_error mirrored benchmark_difficulty }
            addedBy
            suggested
          }
        }
      }
      ... on CurrentClimbChanged {
        sequence
        currentItem: item {
          uuid
          climb { uuid setter_username name frames framesCount framesPace angle difficulty mirrored }
          addedBy
          suggested
        }
        clientId
        correlationId
      }
      ... on QueueItemAdded {
        sequence
        addedItem: item {
          uuid
          climb { uuid setter_username name frames framesCount framesPace angle difficulty mirrored }
          addedBy
          suggested
        }
        position
      }
      ... on QueueItemRemoved {
        sequence
        uuid
      }
      ... on QueueReordered {
        sequence
        uuid
        oldIndex
        newIndex
      }
      ... on ClimbMirrored {
        sequence
        mirroredUuid: uuid
        mirrored
      }
    }
  }
`;
