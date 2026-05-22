// GraphQL Operations for Boardsesh Queue Client
// These operations are used by the web app to communicate with the backend

// Fragment for reusable climb fields
const CLIMB_FIELDS = `
  uuid
  setter_username
  name
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
      driverParticipantId
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

export const END_SESSION = `
  mutation EndSession($sessionId: ID!) {
    endSession(sessionId: $sessionId) {
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

export const REPLACE_QUEUE_ITEM = `
  mutation ReplaceQueueItem($uuid: ID!, $item: ClimbQueueItemInput!) {
    replaceQueueItem(uuid: $uuid, item: $item) {
      ${QUEUE_ITEM_FIELDS}
    }
  }
`;

// Driver mutations — claim or release the wall in a party session.
// In solo (no party), the web client short-circuits these without hitting the
// backend; the server-side mutations require an active session connection.
export const TAKE_CONTROL = `
  mutation TakeControl($climb: ClimbQueueItemInput) {
    takeControl(climb: $climb) {
      id
      participantId
      driverParticipantId
      queueState {
        sequence
        stateHash
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

export const RELEASE_CONTROL = `
  mutation ReleaseControl {
    releaseControl {
      id
      driverParticipantId
    }
  }
`;

// Wall confirmation — the BLE-capable phone tells the backend that the climb
// was successfully relayed to the board. Server broadcasts WallConfirmedClimb
// to every session participant so non-BLE clients can flip the lightbulb to
// confirmed and dismiss their fallback timer. The optional $queueItemUuid
// disambiguates which queued press the confirmation matches when the same
// climb is queued twice. Returns Session! for optimistic-UI symmetry with
// takeControl / releaseControl; the selection set mirrors releaseControl's.
export const CONFIRM_CLIMB_ON_WALL = `
  mutation ConfirmClimbOnWall($climbUuid: ID!, $queueItemUuid: ID) {
    confirmClimbOnWall(climbUuid: $climbUuid, queueItemUuid: $queueItemUuid) {
      id
      driverParticipantId
      lastConnectedBoardSerial
    }
  }
`;

// Session board serial — when a phone pairs with a physical board over BLE,
// it records the serial on the session so other (mobile) participants can
// auto-connect without picking from a list. Returns Session! for optimistic-UI
// symmetry with takeControl / releaseControl.
export const SET_SESSION_BOARD_SERIAL = `
  mutation SetSessionBoardSerial($serial: String!) {
    setSessionBoardSerial(serial: $serial) {
      id
      driverParticipantId
      lastConnectedBoardSerial
    }
  }
`;

// Session board path — broadcasts angle (and any presentational route
// changes) across all session participants. Optimistic-UI symmetry with
// takeControl / releaseControl: the angle selector pushes the URL locally
// for instant feedback, then fires this mutation so the backend persists
// the new boardPath and broadcasts SessionBoardPathChanged to other
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
      driverParticipantId
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
      ... on DriverChanged {
        driverParticipantId
        previousDriverParticipantId
      }
      ... on WallConfirmedClimb {
        climbUuid
        confirmedAt
        confirmedByParticipantId
        queueItemUuid
      }
      ... on SessionBoardSerialChanged {
        lastConnectedBoardSerial
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
          addedItem: item {
            ${QUEUE_ITEM_FIELDS}
          }
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
          currentItem: item {
            ${QUEUE_ITEM_FIELDS}
          }
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
        addedItem: item {
          ${QUEUE_ITEM_FIELDS}
        }
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
        currentItem: item {
          ${QUEUE_ITEM_FIELDS}
        }
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
            climb { uuid setter_username name frames angle ascensionist_count difficulty quality_average stars difficulty_error mirrored benchmark_difficulty }
            addedBy
            suggested
          }
          currentClimbQueueItem {
            uuid
            climb { uuid setter_username name frames angle ascensionist_count difficulty quality_average stars difficulty_error mirrored benchmark_difficulty }
            addedBy
            suggested
          }
        }
      }
      ... on CurrentClimbChanged {
        sequence
        currentItem: item {
          uuid
          climb { uuid setter_username name frames angle difficulty mirrored }
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
          climb { uuid setter_username name frames angle difficulty mirrored }
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
