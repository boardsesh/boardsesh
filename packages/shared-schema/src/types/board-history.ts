// Board history types — the canonical "what was on the wall" log emitted
// per physical board (keyed by BLE serial). Mirrors the GraphQL types in
// `schema/board-history.ts` and `schema/session.ts`.

export type BoardHistorySource = 'BLE_SEND' | 'MANUAL' | 'SHARED_QUEUE_RELAY';

export type BoardHistoryEntry = {
  id: string;
  uuid: string;
  boardSerial: string;
  boardId?: string | null;
  climbUuid: string;
  angle: number;
  isMirror: boolean;
  source: BoardHistorySource;
  userId: string;
  username?: string | null;
  sessionId?: string | null;
  // ISO 8601 timestamp string. We use String! at the schema layer to match
  // existing timestamp serialisation; no DateTime custom scalar is defined.
  sentAt: string;
  sequence: number;
};

export type BoardHistoryFullSync = {
  __typename: 'BoardHistoryFullSync';
  sequence: number;
  entries: BoardHistoryEntry[];
};

export type BoardHistoryEntryAdded = {
  __typename: 'BoardHistoryEntryAdded';
  sequence: number;
  entry: BoardHistoryEntry;
};

export type BoardHistoryEvent = BoardHistoryFullSync | BoardHistoryEntryAdded;

export type RecordBoardSendInput = {
  uuid: string;
  boardSerial: string;
  boardId?: string | null;
  climbUuid: string;
  // Board family the climb belongs to (e.g. 'kilter', 'tension'). Denormalised
  // onto the history row so per-board-type filters don't need to join userBoards.
  boardType: string;
  // Aurora layout id the climb belongs to. Denormalised for the same reason.
  layoutId: number;
  angle: number;
  isMirror?: boolean | null;
  frames?: string | null;
  source: BoardHistorySource;
  sessionId?: string | null;
  sharedPlaylistMode: boolean;
};

// Lightweight "BoardSession" view returned by setSharedPlaylistEnabled.
// Distinct from the larger `Session` type used by joinSession — only carries
// the fields a client needs to react to a shared-playlist toggle.
export type BoardSession = {
  id: string;
  boardPath: string;
  name?: string | null;
  sharedPlaylistEnabled: boolean;
  startedAt?: string | null;
  endedAt?: string | null;
};
