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
      boards {
        boardName
        layoutId
        sizeId
        setIds
        angle
      }
      users {
        id
        username
        isLeader
        avatarUrl
        userId
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
      isLeader
      goal
      isPublic
      startedAt
      endedAt
      isPermanent
      color
      boards {
        boardName
        layoutId
        sizeId
        setIds
        angle
      }
      users {
        id
        username
        isLeader
        avatarUrl
        userId
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
    }
  }
`;
