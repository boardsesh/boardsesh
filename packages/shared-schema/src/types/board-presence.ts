// Board Presence — "now on the wall"
// Types mirror the SDL in schema/board-presence.ts. Keyed on the shared
// board_id (userBoards.id), resolved from the BLE serial.

export type BoardPresenceClimb = {
  climbUuid: string;
  queueItemUuid?: string | null;
  name?: string | null;
  grade?: string | null;
  gradeColor?: string | null;
  frames?: string | null;
  angle?: number | null;
  setter?: string | null;
  /** Server-derived from the caller; never client-supplied. */
  sentByDisplayName?: string | null;
  sentByAvatarUrl?: string | null;
  /** Boardsesh user id of the sender, for profile links. Server-derived; null when anonymous. */
  sentByUserId?: string | null;
  /** ISO 8601, server-stamped. */
  sentAt: string;
  /** Monotonic per-board sequence for ordering + dedup. */
  seq: number;
};

export type BoardClimbSet = {
  __typename: 'BoardClimbSet';
  climb: BoardPresenceClimb;
};

export type BoardClimbCleared = {
  __typename: 'BoardClimbCleared';
  clearedAt: string;
  seq: number;
};

export type BoardStatsUpdated = {
  __typename: 'BoardStatsUpdated';
  stats: BoardPresenceStats;
  seq: number;
};

/** Who's connected + writing to a board now. Anonymous holders carry nulls. */
export type BoardConnectionHolder = {
  userId?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
  lastSentAt?: string | null;
};

export type BoardConnectionChanged = {
  __typename: 'BoardConnectionChanged';
  /** Current holder, or null when the board went free. */
  holder: BoardConnectionHolder | null;
  seq: number;
};

export type BoardPresenceEvent = BoardClimbSet | BoardClimbCleared | BoardStatsUpdated | BoardConnectionChanged;

export type BoardPresenceHardestSend = {
  climbUuid: string;
  name?: string | null;
  grade: string;
  sentByUserId: string;
  sentByDisplayName?: string | null;
  sentByAvatarUrl?: string | null;
  sentAt: string;
};

export type ResolvedBoard = {
  boardId: number;
  boardName: string;
  boardType: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
};

/**
 * One board sharing a non-unique BLE serial, for the disambiguation prompt.
 * Location fields are redacted server-side for non-public boards the caller
 * doesn't own.
 */
export type BoardCandidate = {
  boardId: number;
  boardUuid: string;
  boardName: string;
  boardType: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  locationName?: string | null;
  gymName?: string | null;
  isOwnedByMe: boolean;
  isPublic: boolean;
  lastSentAt?: string | null;
};

/** Result of `resolveBoardCandidatesForSerial`: exactly one field is set. */
export type ResolveBoardResult = {
  board?: ResolvedBoard | null;
  candidates?: BoardCandidate[] | null;
};

export type BoardPresenceStats = {
  climbsSentCount: number;
  distinctClimbersCount: number;
  hardestGrade?: string | null;
  hardestSend?: BoardPresenceHardestSend | null;
  topGrade?: string | null;
  lastSentAt?: string | null;
};
