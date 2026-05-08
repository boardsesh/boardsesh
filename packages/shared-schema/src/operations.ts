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

const USER_PICK_FIELDS = `
  userId
  item {
    ${QUEUE_ITEM_FIELDS}
  }
  updatedAt
`;

const BOARD_SEND_FIELDS = `
  id
  sessionId
  item {
    ${QUEUE_ITEM_FIELDS}
  }
  climbUuid
  sentByUserId
  activeClimberUserId
  correlationId
  sequence
  createdAt
`;

const QUEUE_STATE_FIELDS = `
  sequence
  stateHash
  queue {
    ${QUEUE_ITEM_FIELDS}
  }
  currentClimbQueueItem {
    ${QUEUE_ITEM_FIELDS}
  }
  picks {
    ${USER_PICK_FIELDS}
  }
  activeClimberUserId
`;

// Mutations
export const JOIN_SESSION = `
  mutation JoinSession($sessionId: ID!, $boardPath: String!, $username: String, $avatarUrl: String, $initialQueue: [ClimbQueueItemInput!], $initialCurrentClimb: ClimbQueueItemInput, $sessionName: String) {
    joinSession(sessionId: $sessionId, boardPath: $boardPath, username: $username, avatarUrl: $avatarUrl, initialQueue: $initialQueue, initialCurrentClimb: $initialCurrentClimb, sessionName: $sessionName) {
      id
      name
      boardPath
      clientId
      isLeader
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
      }
      queueState {
        ${QUEUE_STATE_FIELDS}
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

export const SET_MY_PICK = `
  mutation SetMyPick($item: ClimbQueueItemInput!, $correlationId: ID) {
    setMyPick(item: $item, correlationId: $correlationId) {
      ${USER_PICK_FIELDS}
    }
  }
`;

export const CLAIM_TURN = `
  mutation ClaimTurn($correlationId: ID) {
    claimTurn(correlationId: $correlationId) {
      ${QUEUE_ITEM_FIELDS}
    }
  }
`;

export const YIELD_TURN = `
  mutation YieldTurn($toUserId: ID!, $correlationId: ID) {
    yieldTurn(toUserId: $toUserId, correlationId: $correlationId) {
      ${QUEUE_ITEM_FIELDS}
    }
  }
`;

export const CLEAR_MY_PICK = `
  mutation ClearMyPick {
    clearMyPick
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

export const SET_QUEUE = `
  mutation SetQueue($queue: [ClimbQueueItemInput!]!, $currentClimbQueueItem: ClimbQueueItemInput) {
    setQueue(queue: $queue, currentClimbQueueItem: $currentClimbQueueItem) {
      ${QUEUE_STATE_FIELDS}
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
      isLeader
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
      }
      queueState {
        ${QUEUE_STATE_FIELDS}
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
        }
      }
      ... on UserLeft {
        userId
      }
      ... on LeaderChanged {
        leaderId
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
            ${QUEUE_STATE_FIELDS}
          }
        }
        ... on QueueItemAdded {
          sequence
          addedItem: item {
            ${QUEUE_ITEM_FIELDS}
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
        ... on CurrentClimbChanged {
          sequence
          currentItem: item {
            ${QUEUE_ITEM_FIELDS}
          }
          clientId
          correlationId
        }
        ... on ClimbMirrored {
          sequence
          mirrored
        }
        ... on PickChanged {
          sequence
          userId
          pick {
            ${QUEUE_ITEM_FIELDS}
          }
          correlationId
        }
        ... on ActiveClimberChanged {
          sequence
          activeClimberUserId: userId
          correlationId
        }
        ... on BoardSendAdded {
          sequence
          boardSend {
            ${BOARD_SEND_FIELDS}
          }
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
          ${QUEUE_STATE_FIELDS}
        }
      }
      ... on QueueItemAdded {
        sequence
        addedItem: item {
          ${QUEUE_ITEM_FIELDS}
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
      ... on CurrentClimbChanged {
        sequence
        currentItem: item {
          ${QUEUE_ITEM_FIELDS}
        }
        clientId
        correlationId
      }
      ... on ClimbMirrored {
        sequence
        mirrored
      }
      ... on PickChanged {
        sequence
        userId
        pick {
          ${QUEUE_ITEM_FIELDS}
        }
        correlationId
      }
      ... on ActiveClimberChanged {
        sequence
        activeClimberUserId: userId
        correlationId
      }
      ... on BoardSendAdded {
        sequence
        boardSend {
          ${BOARD_SEND_FIELDS}
        }
      }
    }
  }
`;

export const BOARD_SENDS = `
  query BoardSends($sessionId: ID!, $deduplicate: Boolean) {
    boardSends(sessionId: $sessionId, deduplicate: $deduplicate) {
      ${BOARD_SEND_FIELDS}
    }
  }
`;
