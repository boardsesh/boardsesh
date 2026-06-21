import type { Climb, SearchRequestPagination, ParsedBoardRouteParameters } from '@/app/lib/types';
import type { SessionUser } from '@boardsesh/shared-schema';
import type { ConnectionState } from '../connection-manager/websocket-connection-manager';
import type {
  QueueState as SharedQueueState,
  QueueAction as SharedQueueAction,
  AddToQueueSource,
} from '@boardsesh/queue';

// TYPE SEAM: The web defines its own ClimbQueueItem, Climb, and QueueItemUser
// types with web-specific fields (e.g. Climb.boardType). The shared
// @boardsesh/queue package defines structurally compatible types with wider
// nullability (e.g. description?: string | null). TypeScript accepts the
// structural overlap but the two type trees are not identical.
//
// QueueState and QueueAction are aliased to the shared generics. Action
// payloads use the shared ClimbQueueItem (from @boardsesh/queue), while
// the web QueueContextType surfaces the web's own ClimbQueueItem. This
// works because the shared ClimbQueueItem's Climb type is structurally
// wider — the web Climb satisfies it — but callers should be aware that
// action payloads and context data use different (but compatible) Climb
// definitions.

// Re-export pure value types from the shared package for backward compatibility.
// Types that embed Climb (PlaylistSuggestionSource, SetCurrentClimbOptions) are
// defined locally because they reference the web's Climb type (which carries
// web-specific fields like boardType).
export type { QueueSearchParams, AddToQueueSource, PeerId, UserName } from '@boardsesh/queue';

export type PlaylistSuggestionSource = {
  playlistUuid: string;
  activatedClimbUuid: string;
  boardKey: string;
  climbs: Climb[];
};

export type SetCurrentClimbOptions = {
  playlistSuggestionSource: PlaylistSuggestionSource | null;
};

export type QueueItemUser = {
  id: string;
  username: string;
  avatarUrl?: string | null;
};

export type ClimbQueueItem = {
  addedBy?: string | null;
  addedByUser?: QueueItemUser;
  tickedBy?: (string | null)[];
  climb: Climb;
  uuid: string;
  suggested?: boolean;
};

export type ClimbQueue = ClimbQueueItem[];

export type QueueState = SharedQueueState<SearchRequestPagination>;

export type QueueAction = SharedQueueAction<SearchRequestPagination>;

// Stable action functions — identity rarely changes
export type QueueActionsType = {
  addToQueue: (climb: Climb, source?: AddToQueueSource) => void;
  removeFromQueue: (item: ClimbQueueItem) => void;
  /** Sets the climb as current. Resolves to the freshly-created ClimbQueueItem
   *  so callers can capture its uuid (e.g. the create form tracks this uuid
   *  to later replace the item in place on subsequent saves). Resolves to
   *  null when validation fails or the mutation is guarded. */
  setCurrentClimb: (climb: Climb, options: SetCurrentClimbOptions) => Promise<ClimbQueueItem | null>;
  setCurrentClimbQueueItem: (item: ClimbQueueItem) => void;
  /** Browse-initiated drawer open. Always-live model: equivalent to
   *  setCurrentClimb + opening the play drawer for every participant — the
   *  climb is sent to the wall (and broadcast to other members when a party
   *  session is active) exactly like solo. */
  previewClimbFromBrowse: (climb: Climb) => void;
  setPlaylistSuggestionSource: (source: PlaylistSuggestionSource | null) => void;
  refreshPlaylistSuggestionSource: (source: PlaylistSuggestionSource) => void;
  /** Replace an existing queue item (by its queue-item uuid) with a new climb,
   *  preserving addedBy attribution. Used by the create form to keep the
   *  tracked queue item in sync as the user keeps editing a climb. */
  replaceQueueItem: (queueItemUuid: string, climb: Climb) => void;
  setClimbSearchParams: (params: SearchRequestPagination) => void;
  setCountSearchParams: (params: SearchRequestPagination) => void;
  mirrorClimb: () => void;
  fetchMoreClimbs: () => void;
  /** Returns the next ClimbQueueItem after `from` (defaults to the current
   *  wall climb). Walks the shared queue first, then falls through to
   *  suggested climbs once the queue is exhausted. Every participant navigates
   *  the same shared queue (always-live model). */
  getNextClimbQueueItem: (options?: { from?: ClimbQueueItem | null }) => ClimbQueueItem | null;
  /** Returns the previous ClimbQueueItem before `from` (defaults to the
   *  current wall climb). Walks the shared queue (no suggestions
   *  fall-through). */
  getPreviousClimbQueueItem: (options?: { from?: ClimbQueueItem | null }) => ClimbQueueItem | null;
  setQueue: (queue: ClimbQueueItem[]) => void;
  disconnect?: () => void;
  /** Dispatch an optimistic current-climb update from a native widget navigation.
   *  The native WebSocket already sent the server mutation, so this only updates
   *  the local reducer state and registers the correlationId for echo suppression. */
  dispatchWidgetNavigation?: (item: ClimbQueueItem, correlationId: string) => void;
  /** Tell the session this client's own BLE link to the wall dropped so every
   *  member's wall-confirmed lightbulb clears. Best-effort; a no-op in solo
   *  (no active session). The current climb is preserved. */
  reportWallDisconnect: () => Promise<void>;
};

// Frequently-changing state data
export type QueueDataType = {
  queue: ClimbQueue;
  currentClimbQueueItem: ClimbQueueItem | null;
  currentClimb: Climb | null;
  climbSearchParams: SearchRequestPagination;
  climbSearchResults: Climb[] | null;
  suggestedClimbs: Climb[];
  playlistSuggestionSource: PlaylistSuggestionSource | null;
  totalSearchResultCount: number | null;
  hasMoreResults: boolean;
  isFetchingClimbs: boolean;
  isFetchingNextPage: boolean;
  hasDoneFirstFetch: boolean;
  viewOnlyMode: boolean;
  parsedParams: ParsedBoardRouteParameters;
  connectionState?: ConnectionState;
  canMutate?: boolean;
  users?: SessionUser[];
  clientId?: string | null;
  /** Local user's stable participant id for the current session, or null
   *  outside a session. Use this for comparisons against `SessionUser.id`. */
  participantId?: string | null;
  isLeader?: boolean;
  /** Session-scoped "the wall is currently lit" indicator (party only). Turns
   *  on via `WallConfirmedClimb`, off via `WallDisconnected`. Always false in
   *  solo. */
  wallConfirmed?: boolean;
  /** Most recent BLE board serial the session has paired to (party). Null in
   *  solo and when no member has ever paired. Used by the drawer's lightbulb
   *  fallback to auto-connect to the same board another member is paired to. */
  lastConnectedBoardSerial?: string | null;
  isBackendMode?: boolean;
  hasConnected?: boolean;
  connectionError?: Error | null;
  isDisconnected: boolean;
};

// Combined type for backward compatibility
export type QueueContextType = QueueDataType & QueueActionsType;
