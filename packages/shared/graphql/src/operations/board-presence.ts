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
  source
  climbUuid
  queueItemUuid
  name
  grade
  gradeColor
  frames
  angle
  mirrored
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
// the full climb, a BoardClimbCleared carries the clear timestamp + seq and the
// climb that went dark (#7015; selected only from release/next, after the backend
// that serves the field was deployed from main),
// a BoardStatsUpdated carries the recomputed stat tiles (pushed when a tick
// lands on the wall) so the tiles update live instead of re-fetching, and a
// BoardConnectionChanged carries the current connection holder (or null when the
// board goes free) so consumers can show held-vs-free distinct from the lit climb.
export const BOARD_NOW_PLAYING = `
  subscription BoardNowPlaying($boardId: Int!, $boardUuid: ID) {
    boardNowPlaying(boardId: $boardId, boardUuid: $boardUuid) {
      __typename
      ... on BoardHistoryUpdated {
        seq
        climbs { ${BOARD_PRESENCE_CLIMB_FIELDS} }
      }
      ... on BoardClimbSet {
        climb {
          ${BOARD_PRESENCE_CLIMB_FIELDS}
        }
      }
      ... on BoardClimbCleared {
        clearedAt
        seq
        climbUuid
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

// Subscription — Relay mode (#7220): the same live feed as BOARD_NOW_PLAYING
// plus the relay fields. A separate document so the recorded BOARD_NOW_PLAYING
// never changes; a client opts in (createBoardPresenceClient's `relayMode`) once
// the backend serving these fields is deployed. A BoardClimbRelayRequested
// reaches only the holder's phone (the server filters it per subscriber), and
// BoardClimbSet.relayRequestId is the echo a relaying phone matches to confirm
// its climb landed.
export const BOARD_NOW_PLAYING_RELAY = `
  subscription BoardNowPlayingRelay($boardId: Int!, $boardUuid: ID) {
    boardNowPlaying(boardId: $boardId, boardUuid: $boardUuid, relay: true) {
      __typename
      ... on BoardHistoryUpdated {
        seq
        climbs { ${BOARD_PRESENCE_CLIMB_FIELDS} }
      }
      ... on BoardClimbSet {
        climb {
          ${BOARD_PRESENCE_CLIMB_FIELDS}
        }
        relayRequestId
      }
      ... on BoardClimbCleared {
        clearedAt
        seq
        climbUuid
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
      ... on BoardClimbRelayRequested {
        relayRequestId
        climb {
          climbUuid
          queueItemUuid
          name
          grade
          gradeColor
          frames
          setter
        }
        angle
        mirrored
        relayer {
          userId
          displayName
          avatarUrl
          anonymous
        }
        requestedAt
      }
    }
  }
`;

export const BOARD_RECENT_HISTORY = `
  query BoardRecentHistory($boardId: Int!, $boardUuid: ID) {
    boardRecentHistory(boardId: $boardId, boardUuid: $boardUuid) { ${BOARD_PRESENCE_CLIMB_FIELDS} }
  }
`;

export const BOARD_HISTORY_PAGE = `
  query BoardHistoryPage($boardId: Int!, $boardUuid: ID, $limit: Int, $before: String) {
    boardHistoryPage(boardId: $boardId, boardUuid: $boardUuid, limit: $limit, before: $before) {
      entries { ${BOARD_PRESENCE_CLIMB_FIELDS} }
      nextCursor
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

// Mutation — Relay mode (#7220): the holder lights a climb another phone relayed.
// A separate document from REPORT_BOARD_CLIMB so the recorded one (screenshot
// fixtures, installed bundles) never changes; the server echoes
// `relayRequestId` on the published BoardClimbSet.
export const REPORT_BOARD_CLIMB_RELAYED = `
  mutation ReportBoardClimbRelayed($boardId: Int!, $climb: ClimbQueueItemInput!, $angle: Int, $relayRequestId: ID!) {
    reportBoardClimb(boardId: $boardId, climb: $climb, angle: $angle, relayRequestId: $relayRequestId)
  }
`;

// Mutation — Relay mode (#7220): ask the phone holding a single-phone MoonBoard
// to light a climb. The status says whether it went (SENT) or why not; the
// holder is named under the boardConnection privacy rule.
export const RELAY_BOARD_CLIMB = `
  mutation RelayBoardClimb(
    $boardId: Int!
    $climb: ClimbQueueItemInput!
    $angle: Int
    $mirrored: Boolean
    $relayRequestId: ID!
  ) {
    relayBoardClimb(
      boardId: $boardId
      climb: $climb
      angle: $angle
      mirrored: $mirrored
      relayRequestId: $relayRequestId
    ) {
      status
      holder {
        userId
        displayName
        avatarUrl
        lastSentAt
      }
    }
  }
`;

// Mutation — Relay mode (#7220): the holder turns relayed climbs on or off for
// the board it holds. Returns Boolean! (false when the caller doesn't hold it).
export const SET_BOARD_RELAY_ACCEPTING = `mutation SetBoardRelayAccepting($boardId: Int!, $accepting: Boolean!) { setBoardRelayAccepting(boardId: $boardId, accepting: $accepting) }`;

// Mutation — resolve (and bind) the shared board for a BLE serial. Called once
// on BLE connect; the board-config args are used only to create the board the
// first time a serial is seen. `selectedBoardUuid` is the board the user
// already had picked (map finder / board picker) — when its config matches the
// controller it wins, so connecting never moves them off the wall they chose.
// Returns the one board everyone at this wall shares.
export const RESOLVE_BOARD_FOR_SERIAL = `
  mutation ResolveBoardForSerial(
    $serial: String!
    $boardType: String!
    $layoutId: Int!
    $sizeId: Int!
    $setIds: String!
    $advertisedBoardType: String
    $selectedBoardUuid: ID
  ) {
    resolveBoardForSerial(
      serial: $serial
      boardType: $boardType
      layoutId: $layoutId
      sizeId: $sizeId
      setIds: $setIds
      advertisedBoardType: $advertisedBoardType
      selectedBoardUuid: $selectedBoardUuid
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
    $advertisedBoardType: String
    $selectedBoardUuid: ID
  ) {
    resolveBoardCandidatesForSerial(
      serial: $serial
      boardType: $boardType
      layoutId: $layoutId
      sizeId: $sizeId
      setIds: $setIds
      advertisedBoardType: $advertisedBoardType
      selectedBoardUuid: $selectedBoardUuid
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
  query BoardRecentClimbs($boardId: Int!, $boardUuid: ID) {
    boardRecentClimbs(boardId: $boardId, boardUuid: $boardUuid) {
      ${BOARD_PRESENCE_CLIMB_FIELDS}
    }
  }
`;

// Query — durable, keyset-paged history of what was lit on a board, from
// `board_climb_events` (survives past the 1-week Redis window (BOARD_HISTORY_TTL)
// that backs BOARD_RECENT_CLIMBS). Newest-first; `before` is an opaque cursor equal to the
// `seq` of the previous page's last row, and `limit` is server-capped 1–100
// (default 50). Reuses the same climb fields as the live feed so every wall
// surface decodes one shape.
export const BOARD_HISTORY = `
  query BoardHistory($boardId: Int!, $boardUuid: ID, $limit: Int, $before: String) {
    boardHistory(boardId: $boardId, boardUuid: $boardUuid, limit: $limit, before: $before) {
      ${BOARD_PRESENCE_CLIMB_FIELDS}
    }
  }
`;

// Query — up to five distinct climbers who most recently sent/flashed this
// climb at the displayed angle on this physical board. The backend resolves
// canonical + alias UUIDs before reading ticks.
export const BOARD_CLIMB_RECENT_SENDERS = `
  query BoardClimbRecentSenders($boardId: Int!, $boardUuid: ID, $climbUuid: String!, $angle: Int!) {
    boardClimbRecentSenders(boardId: $boardId, boardUuid: $boardUuid, climbUuid: $climbUuid, angle: $angle) {
      userId
      displayName
      avatarUrl
      lastSentAt
    }
  }
`;

// Query — durable + live stats for a board's wall feed.
export const BOARD_PRESENCE_STATS = `
  query BoardPresenceStats($boardId: Int!, $boardUuid: ID) {
    boardPresenceStats(boardId: $boardId, boardUuid: $boardUuid) {
      ${BOARD_PRESENCE_STATS_FIELDS}
    }
  }
`;

// Query — the current connection holder for a board, used by a late joiner to
// seed held-vs-free before the live BoardConnectionChanged subscription pushes.
// Resolves null when the board is free.
export const BOARD_CONNECTION = `query BoardConnection($boardId: Int!, $boardUuid: ID) { boardConnection(boardId: $boardId, boardUuid: $boardUuid) { userId displayName avatarUrl lastSentAt } }`;

// Mutation — release this client's hold on a board (e.g. on BLE disconnect).
// Returns Boolean! (accepted).
export const REPORT_BOARD_DISCONNECT = `mutation ReportBoardDisconnect($boardId: Int!) { reportBoardDisconnect(boardId: $boardId) }`;

// Mutation — MoonBoard link-mode detection (#7220). Returns Boolean! (whether
// the stored detected value changed). Only ever moves a board toward relay.
export const REPORT_MOONBOARD_LINK_DETECTED = `mutation ReportMoonboardLinkDetected($boardId: Int!, $detected: MoonboardLinkMode!) { reportMoonboardLinkDetected(boardId: $boardId, detected: $detected) }`;

// Mutation — this client turned off all the wall's lights but kept its link
// (#7015). Publishes BoardClimbCleared to every viewer. Returns Boolean!
// (accepted; false when another emitter holds the board).
export const REPORT_BOARD_CLEAR = `mutation ReportBoardClear($boardId: Int!) { reportBoardClear(boardId: $boardId) }`;

// All fields of a redacted BoardQueuePreview (gym-kiosk "Up next"). Items
// deliberately carry ONLY climb-catalog display fields — never who added or
// ticked them. Shared between the cold-fetch query and the live subscription
// so both decode the same shape.
const BOARD_QUEUE_PREVIEW_FIELDS = `
  boardId
  current {
    queueItemUuid
    climbUuid
    name
    grade
    gradeColor
    frames
    angle
    setter
  }
  upNext {
    queueItemUuid
    climbUuid
    name
    grade
    gradeColor
    frames
    angle
    setter
  }
  queueLength
  updatedAt
`;

// Query — the current redacted "Up next" snapshot for a board, or null when
// no publicly previewable session is bound (double gate: anon-readable board
// AND isPublic active session). Used by kiosks for initial paint before the
// live subscription takes over.
export const BOARD_QUEUE_PREVIEW = `
  query BoardQueuePreview($boardId: Int!, $boardUuid: ID) {
    boardQueuePreview(boardId: $boardId, boardUuid: $boardUuid) {
      ${BOARD_QUEUE_PREVIEW_FIELDS}
    }
  }
`;

// Subscription — live redacted "Up next" previews for a board. Every event is
// a full snapshot (latest wins); the stream is seeded with the current
// snapshot when one exists, so late-joining kiosks paint without a separate
// query round-trip.
export const BOARD_QUEUE_PREVIEW_SUBSCRIPTION = `
  subscription BoardQueuePreviewUpdates($boardId: Int!, $boardUuid: ID) {
    boardQueuePreview(boardId: $boardId, boardUuid: $boardUuid) {
      ${BOARD_QUEUE_PREVIEW_FIELDS}
    }
  }
`;
