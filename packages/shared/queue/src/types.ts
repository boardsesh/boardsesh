/**
 * Pure queue state machine types. No React, no DOM, no web-specific imports.
 *
 * The queue package defines its OWN Climb / ClimbQueueItem / QueueItemUser
 * types that are wide enough for both the web app (non-nullable optionals,
 * e.g. `mirrored?: boolean`) and shared-schema (nullable optionals, e.g.
 * `mirrored?: boolean | null`).  The reducer only reads `uuid` and `mirrored`
 * on a climb and spreads the rest opaquely, so consumers can pass either
 * variant without double-casting.
 *
 * Web-specific types like QueueContextType, QueueDataType, and
 * QueueActionsType stay in the web app.
 */

export type QueueItemUser = {
  id: string;
  username: string;
  avatarUrl?: string | null;
};

export type Climb = {
  uuid: string;
  layoutId?: number | null;
  boardType?: string;
  setter_username: string;
  userId?: string | null;
  name: string;
  description?: string | null;
  frames: string;
  angle: number;
  ascensionist_count: number;
  // Per-source ascensionist counts (all nullable). Carried through queue
  // conversion so a queued climb's row can honour the "Ascent counts" setting.
  // The total `ascensionist_count` is GREATEST(kilter, aurora) + boardsesh.
  kilterAscensionistCount?: number | null;
  auroraAscensionistCount?: number | null;
  boardseshAscensionistCount?: number | null;
  difficulty: string;
  quality_average: string;
  stars: number;
  difficulty_error: string;
  mirrored?: boolean | null;
  benchmark_difficulty: string | null;
  is_draft?: boolean | null;
  is_no_match?: boolean | null;
  /** Structured climb characteristics (e.g. 'no_match', 'method_footless'). */
  characteristics?: string[] | null;
  userAscents?: number | null;
  userAttempts?: number | null;
  created_at?: string | null;
  published_at?: string | null;
  // Multi-frame playback metadata: how many snapshots the climb has and the
  // setter-chosen per-frame pace (ms). Carried through queue conversion so
  // multi-frame playback uses the setter's pace instead of DEFAULT_PACE_MS.
  framesCount?: number | null;
  framesPace?: number | null;
};

export type ClimbQueueItem = {
  uuid: string;
  climb: Climb;
  addedBy?: string | null;
  addedByUser?: QueueItemUser;
  tickedBy?: (string | null)[];
  suggested?: boolean;
};

export type ClimbQueue = ClimbQueueItem[];

export type AddToQueueSource = 'search' | 'playlist' | 'climb_detail' | 'peer_broadcast' | 'unknown';

export type PeerId = string | null;
export type UserName = PeerId;

export type PlaylistSuggestionSource = {
  playlistUuid: string;
  activatedClimbUuid: string;
  boardKey: string;
  climbs: Climb[];
};

export type SetCurrentClimbOptions = {
  playlistSuggestionSource: PlaylistSuggestionSource | null;
};

/**
 * Per-climb grade fields that change when the board angle changes. A climb's
 * difficulty/quality/sends are angle-specific (stored per-angle server-side),
 * but a `Climb` carries a single set baked in for the angle it was fetched at.
 * `REGRADE_CLIMBS` patches these onto the climbs already in the queue so they
 * render the new angle's grade without re-adding them. Keyed by `climb.uuid`.
 */
export type ClimbRegradePatch = {
  angle: number;
  difficulty: string;
  quality_average: string;
  ascensionist_count: number;
  // Per-source counts are angle-specific too — patch them alongside the total so
  // a queued climb's Board app / Boardsesh subtitle and the drawer headline
  // follow the new angle instead of keeping the angle it was fetched at.
  kilterAscensionistCount?: number | null;
  auroraAscensionistCount?: number | null;
  boardseshAscensionistCount?: number | null;
  benchmark_difficulty: string | null;
  difficulty_error?: string;
};

export type QueueSearchParams = Record<string, unknown>;

export type QueueState<TSearchParams extends QueueSearchParams = QueueSearchParams> = {
  queue: ClimbQueue;
  currentClimbQueueItem: ClimbQueueItem | null;
  climbSearchParams: TSearchParams;
  playlistSuggestionSource: PlaylistSuggestionSource | null;
  hasDoneFirstFetch: boolean;
  initialQueueDataReceivedFromPeers: boolean;
  pendingCurrentClimbUpdates: string[];
  lastReceivedSequence: number | null;
  lastReceivedStateHash: string | null;
  needsResync: boolean;
};

export type QueueAction<TSearchParams extends QueueSearchParams = QueueSearchParams> =
  | { type: 'ADD_TO_QUEUE'; payload: ClimbQueueItem }
  | { type: 'REMOVE_FROM_QUEUE'; payload: ClimbQueueItem[] }
  | { type: 'SET_CURRENT_CLIMB'; payload: ClimbQueueItem }
  | { type: 'SET_CURRENT_CLIMB_QUEUE_ITEM'; payload: ClimbQueueItem }
  | { type: 'SET_CLIMB_SEARCH_PARAMS'; payload: TSearchParams }
  | {
      type: 'UPDATE_QUEUE';
      payload: { queue: ClimbQueue; currentClimbQueueItem?: ClimbQueueItem | null };
    }
  | {
      type: 'INITIAL_QUEUE_DATA';
      payload: { queue: ClimbQueue; currentClimbQueueItem?: ClimbQueueItem | null };
    }
  | { type: 'SET_FIRST_FETCH'; payload: boolean }
  | { type: 'MIRROR_CLIMB' }
  | { type: 'DELTA_ADD_QUEUE_ITEM'; payload: { item: ClimbQueueItem; position?: number } }
  | { type: 'DELTA_REMOVE_QUEUE_ITEM'; payload: { uuid: string } }
  | {
      type: 'DELTA_REORDER_QUEUE_ITEM';
      payload: { uuid: string; oldIndex: number; newIndex: number };
    }
  | {
      type: 'DELTA_UPDATE_CURRENT_CLIMB';
      payload: {
        item: ClimbQueueItem | null;
        shouldAddToQueue?: boolean;
        insertAfterCurrent?: boolean;
        isServerEvent?: boolean;
        eventClientId?: string;
        myClientId?: string;
        correlationId?: string;
        serverCorrelationId?: string;
        playlistSuggestionSource?: PlaylistSuggestionSource | null;
      };
    }
  | { type: 'DELTA_MIRROR_CURRENT_CLIMB'; payload: { mirrored: boolean; mirroredUuid: string | null } }
  | { type: 'DELTA_REPLACE_QUEUE_ITEM'; payload: { uuid: string; item: ClimbQueueItem } }
  | { type: 'SET_PLAYLIST_SUGGESTION_SOURCE'; payload: PlaylistSuggestionSource | null }
  | { type: 'REFRESH_PLAYLIST_SUGGESTION_SOURCE'; payload: PlaylistSuggestionSource }
  | { type: 'CLEANUP_PENDING_UPDATE'; payload: { correlationId: string } }
  | { type: 'CLEANUP_PENDING_UPDATES_BATCH'; payload: { correlationIds: string[] } }
  | { type: 'CLEAR_RESYNC_FLAG' }
  | { type: 'REGRADE_CLIMBS'; payload: { grades: Record<string, ClimbRegradePatch> } }
  | { type: 'CLEAR_QUEUE' };
