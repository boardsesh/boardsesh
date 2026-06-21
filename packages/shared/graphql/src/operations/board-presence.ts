// GraphQL operations for board presence ("now on the wall").
//
// A board's live feed is keyed on the shared board_id (userBoards.id, resolved
// from the BLE serial). The subscription streams the climb currently lit; the
// queries backfill recent history + durable stats; the mutations report a fresh
// send and bind a serial to a board. Modelled on the queue-session operations
// in queue-session.ts so codegen (documents glob `packages/shared/graphql/src/**`)
// picks these up the same way.

// All display + ordering fields of a BoardPresenceClimb. Reused across the
// subscription, the recent-climbs query, and anywhere a climb is rendered on
// the wall feed so every surface decodes the same shape.
const BOARD_PRESENCE_CLIMB_FIELDS = `
  climbUuid
  queueItemUuid
  name
  grade
  gradeColor
  frames
  angle
  setter
  sentByDisplayName
  sentByAvatarUrl
  sentByUserId
  sentAt
  seq
`;

// Durable stat tiles for a board's wall feed. Shared between the cold-fetch
// query and the live BoardStatsUpdated subscription payload so both decode the
// same shape.
const BOARD_PRESENCE_STATS_FIELDS = `
  climbsSentCount
  distinctClimbersCount
  hardestGrade
  hardestSend {
    climbUuid
    name
    grade
    sentByUserId
    sentByDisplayName
    sentByAvatarUrl
    sentAt
  }
  topGrade
  lastSentAt
`;

// Subscription — the live "now on the wall" feed for a board. Emits a
// BoardPresenceEvent union discriminated by __typename: a BoardClimbSet carries
// the full climb, a BoardClimbCleared carries only the clear timestamp + seq,
// a BoardStatsUpdated carries the recomputed stat tiles (pushed when a tick
// lands on the wall) so the tiles update live instead of re-fetching, and a
// BoardConnectionChanged carries the current connection holder (or null when the
// board goes free) so consumers can show held-vs-free distinct from the lit climb.
export const BOARD_NOW_PLAYING = `
  subscription BoardNowPlaying($boardId: Int!) {
    boardNowPlaying(boardId: $boardId) {
      __typename
      ... on BoardClimbSet {
        climb {
          ${BOARD_PRESENCE_CLIMB_FIELDS}
        }
      }
      ... on BoardClimbCleared {
        clearedAt
        seq
      }
      ... on BoardStatsUpdated {
        stats {
          ${BOARD_PRESENCE_STATS_FIELDS}
        }
        seq
      }
      ... on BoardConnectionChanged {
        holder {
          userId
          displayName
          avatarUrl
          lastSentAt
        }
        seq
      }
    }
  }
`;

// Mutation — report the climb a connected phone just lit on the wall. The
// sender's identity is server-derived; this is fire-and-forget after the BLE
// write succeeds. Returns Boolean! (accepted).
export const REPORT_BOARD_CLIMB = `
  mutation ReportBoardClimb($boardId: Int!, $climb: ClimbQueueItemInput!, $angle: Int) {
    reportBoardClimb(boardId: $boardId, climb: $climb, angle: $angle)
  }
`;

// Mutation — resolve (and bind) the shared board for a BLE serial. Called once
// on BLE connect; the board-config args are used only to create the board the
// first time a serial is seen. Returns the one board everyone at this wall shares.
export const RESOLVE_BOARD_FOR_SERIAL = `
  mutation ResolveBoardForSerial(
    $serial: String!
    $boardType: String!
    $layoutId: Int!
    $sizeId: Int!
    $setIds: String!
  ) {
    resolveBoardForSerial(
      serial: $serial
      boardType: $boardType
      layoutId: $layoutId
      sizeId: $sizeId
      setIds: $setIds
    ) {
      boardId
      boardName
      boardType
      layoutId
      sizeId
      setIds
    }
  }
`;

// Mutation — resolve a BLE serial for clients that can disambiguate. Returns a
// single `board` when the serial is unambiguous (remembered choice, only one
// match, or freshly created), or `candidates` when several boards share the
// serial and the user must pick. Confirm the pick with CHOOSE_BOARD_FOR_SERIAL.
export const RESOLVE_BOARD_CANDIDATES_FOR_SERIAL = `
  mutation ResolveBoardCandidatesForSerial(
    $serial: String!
    $boardType: String!
    $layoutId: Int!
    $sizeId: Int!
    $setIds: String!
  ) {
    resolveBoardCandidatesForSerial(
      serial: $serial
      boardType: $boardType
      layoutId: $layoutId
      sizeId: $sizeId
      setIds: $setIds
    ) {
      board {
        boardId
        boardName
        boardType
        layoutId
        sizeId
        setIds
      }
      candidates {
        boardId
        boardUuid
        boardName
        boardType
        layoutId
        sizeId
        setIds
        locationName
        gymName
        isOwnedByMe
        isPublic
        lastSentAt
      }
    }
  }
`;

// Mutation — confirm which board a (non-unique) serial routes to after the user
// picks from a disambiguation prompt. Remembers the choice per user so the
// prompt doesn't reappear.
export const CHOOSE_BOARD_FOR_SERIAL = `
  mutation ChooseBoardForSerial($boardId: Int!, $serial: String!) {
    chooseBoardForSerial(boardId: $boardId, serial: $serial) {
      boardId
      boardName
      boardType
      layoutId
      sizeId
      setIds
    }
  }
`;

// Mutation — resolve the selected named board's wall feed before BLE connects.
// Unlike the per-config fallback, this uses the actual UserBoard row so durable
// board stats and live presence stay on the same board_id.
export const RESOLVE_BOARD_FOR_UUID = `
  mutation ResolveBoardForUuid($boardUuid: ID!) {
    resolveBoardForUuid(boardUuid: $boardUuid) {
      boardId
      boardName
      boardType
      layoutId
      sizeId
      setIds
    }
  }
`;

// Mutation — resolve a shared board by configuration when a BLE controller
// exposes no serial. This gives serial-less boards a per-config wall feed.
export const RESOLVE_BOARD_FOR_CONFIG = `
  mutation ResolveBoardForConfig(
    $boardType: String!
    $layoutId: Int!
    $sizeId: Int!
    $setIds: String!
  ) {
    resolveBoardForConfig(
      boardType: $boardType
      layoutId: $layoutId
      sizeId: $sizeId
      setIds: $setIds
    ) {
      boardId
      boardName
      boardType
      layoutId
      sizeId
      setIds
    }
  }
`;

// Query — newest-first recent climbs for a board, used by a late joiner to
// backfill history before following the live subscription.
export const BOARD_RECENT_CLIMBS = `
  query BoardRecentClimbs($boardId: Int!) {
    boardRecentClimbs(boardId: $boardId) {
      ${BOARD_PRESENCE_CLIMB_FIELDS}
    }
  }
`;

// Query — durable, keyset-paged history of what was lit on a board, from
// `board_climb_events` (survives past the 24h Redis window that backs
// BOARD_RECENT_CLIMBS). Newest-first; `before` is an opaque cursor equal to the
// `seq` of the previous page's last row, and `limit` is server-capped 1–100
// (default 50). Reuses the same climb fields as the live feed so every wall
// surface decodes one shape.
export const BOARD_HISTORY = `
  query BoardHistory($boardId: Int!, $limit: Int, $before: String) {
    boardHistory(boardId: $boardId, limit: $limit, before: $before) {
      ${BOARD_PRESENCE_CLIMB_FIELDS}
    }
  }
`;

// Query — durable + live stats for a board's wall feed.
export const BOARD_PRESENCE_STATS = `
  query BoardPresenceStats($boardId: Int!) {
    boardPresenceStats(boardId: $boardId) {
      ${BOARD_PRESENCE_STATS_FIELDS}
    }
  }
`;

// Query — the current connection holder for a board, used by a late joiner to
// seed held-vs-free before the live BoardConnectionChanged subscription pushes.
// Resolves null when the board is free.
export const BOARD_CONNECTION = `query BoardConnection($boardId: Int!) { boardConnection(boardId: $boardId) { userId displayName avatarUrl lastSentAt } }`;

// Mutation — release this client's hold on a board (e.g. on BLE disconnect).
// Returns Boolean! (accepted).
export const REPORT_BOARD_DISCONNECT = `mutation ReportBoardDisconnect($boardId: Int!) { reportBoardDisconnect(boardId: $boardId) }`;
