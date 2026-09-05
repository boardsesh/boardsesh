import { createContext, useContext } from 'react';
import type {
  QueueState,
  QueueAction,
  ClimbQueueItem,
  PlaylistSuggestionSource,
  SetCurrentClimbOptions,
} from '@boardsesh/queue';
import type { PublishPlaybackStateInput } from '@boardsesh/queue-react';
import type { PlaybackStateChangedEvent, SessionSummary, SessionUser, UserBoard } from '@boardsesh/shared-schema';
import type { SessionLiveStatsEvent } from '../../lib/graphql/operations';

export type StartSessionConfig = {
  name?: string;
  goal?: string;
  color?: string;
  discoverable?: boolean;
  isPermanent?: boolean;
};

type QueueContextValue = {
  state: QueueState;
  dispatch: React.Dispatch<QueueAction>;
  sessionId: string | null;
  setSessionId: (id: string | null) => void;
  /** Most recently published physical board serial for this session, if any. */
  lastConnectedBoardSerial: string | null;
  /** Our own participant id for the active session (marks "you" in rosters). */
  participantId: string | null;
  /**
   * Whether the session's current climb is confirmed lit on a physical wall by
   * any member. Flipped on by `WallConfirmedClimb` (a member relayed the climb
   * over BLE) and off by `WallDisconnected` (a member's BLE link dropped). Drives
   * the lightbulb's lit indicator; the current climb is never cleared by either.
   */
  isSessionWallLit: boolean;
  /**
   * Queue a climb. Resolves `'cancelled'` when the climb belongs to another
   * board and the climber backed out of the cross-board prompt — callers that
   * sequence something on the add (activating the climb, closing a sheet)
   * should await it; fire-and-forget callers can `void` it.
   */
  addToQueue: (item: ClimbQueueItem) => Promise<'added' | 'cancelled'>;
  removeFromQueue: (uuid: string) => void;
  reorderQueue: (uuid: string, oldIndex: number, newIndex: number) => void;
  clearQueue: () => void;
  /** Replace the entire queue (optimistic local UPDATE_QUEUE + best-effort party sync). */
  setQueue: (queue: ClimbQueueItem[], currentClimbQueueItem?: ClimbQueueItem | null) => void;
  /**
   * Read the live queue + current climb without subscribing to state. Stable
   * identity (backed by the internal stateRef), so action-only consumers — e.g.
   * playlist activation deciding whether replacing the queue would clear future
   * items — can read the latest queue at tap time without re-rendering on every
   * queue change.
   */
  getQueueSnapshot: () => { queue: ClimbQueueItem[]; currentClimbQueueItem: ClimbQueueItem | null };
  /** Append a generated session behind the live queue, leaving the current climb where it is. */
  appendGeneratedSession: (items: ClimbQueueItem[]) => void;
  setCurrentClimb: (item: ClimbQueueItem, options?: SetCurrentClimbOptions) => void;
  nextClimb: () => void;
  previousClimb: () => void;
  /**
   * Board-render A/B telemetry (issue #2202): fire `Climb View Opened` for a
   * climb drawn on the board WITHOUT being the queue's current climb.
   *
   * The provider fires views off its own current-climb change, which covers
   * every path through the queue. The play drawer's preview latch is the one
   * surface that puts a different climb on the board without touching the
   * queue — swiping while a preview is pinned, or a signed-out reader tapping
   * through Similar Climbs — so it reports those itself. Everything else
   * should change the current climb and stay out of this.
   *
   * Stable identity; a no-op until the resolved render settings are known (see
   * `renderSettingsPending` in queue-provider.tsx) and with no active board.
   */
  noteClimbViewed: (climbUuid: string) => void;
  /**
   * Apply a widget Next/Previous navigation by absolute index. Dispatches the
   * current-climb change with the provided correlationId (so the racing
   * `CurrentClimbChanged` server echo is suppressed) WITHOUT sending a fresh JS
   * mutation — the native widget intent already sent the server mutation. Using
   * the absolute item (not a relative `nextClimb`) keeps this idempotent, so it
   * can't double-advance when the WebSocket echo lands before the Darwin event.
   * Mirrors web's `dispatchWidgetNavigation`.
   */
  dispatchWidgetNavigation: (item: ClimbQueueItem, correlationId: string) => void;
  /** Replace the playlist suggestion source that drives swipe-through climbs. */
  setPlaylistSuggestionSource: (source: PlaylistSuggestionSource | null) => void;
  /** Refresh the suggestion source in place (no-op unless it matches the active one). */
  refreshPlaylistSuggestionSource: (source: PlaylistSuggestionSource) => void;
  /**
   * Reset the active session locally. Pass `{ notifyServer: true }` on an
   * intentional leave (e.g. switching sessions) to emit LEAVE_SESSION so peers
   * see the departure immediately instead of after the disconnect grace timer.
   */
  clearSession: (options?: { notifyServer?: boolean }) => Promise<void>;
  /**
   * End the active session. An optional recap (`notes`) is trimmed and sent only
   * when non-empty; the returned SessionSummary echoes it back for the summary
   * screen. Resolves null when there's no active session or the mutation failed.
   */
  endSession: (options?: { notes?: string }) => Promise<SessionSummary | null>;
  /**
   * Explicitly create a session with optional config (name, goal, etc.).
   * Returns the new sessionId, or null if there is no active board or the
   * mutation failed. No-op (returns existing id) when a session is live.
   */
  startSession: (config?: StartSessionConfig) => Promise<string | null>;
  /**
   * Join an existing session created by someone else (party mode). Switches the
   * active board to the session's board, sets + persists the sessionId, and
   * relies on the session effect to run JOIN_SESSION + open the realtime
   * subscriptions. No-ops if already in this session. Differs from
   * `startSession`, which *reads* the active board to create a new session;
   * `joinSession` *writes* the active board from the session's boardPath.
   */
  joinSession: (sessionId: string, opts: { boardPath: string; userBoard: UserBoard }) => Promise<void>;
  /**
   * Broadcast the session's boardPath so every party member follows the same
   * angle/board. Best-effort; a true no-op in solo (never creates a session).
   */
  setSessionBoardPath: (boardPath: string) => Promise<void>;
  /**
   * Broadcast that this phone successfully wrote a climb to the physical wall.
   * The local wall-confirm bus is handled by the Bluetooth provider; this
   * mutation notifies party peers through the session subscription.
   */
  confirmClimbOnWall: (climbUuid: string) => Promise<void>;
  /**
   * Broadcast that this phone's BLE link to the wall dropped so every member
   * turns the lightbulb off (the current climb is preserved). Best-effort;
   * a true no-op in solo (never creates a session).
   */
  reportWallDisconnect: () => Promise<void>;
  /**
   * Store the connected board serial on the active session so native peers can
   * reconnect to the same physical wall without showing the picker.
   */
  setSessionBoardSerial: (serial: string) => Promise<void>;
  /** Subscribe to transient PlaybackStateChanged events that never reach the
   * queue reducer. Returns an unsubscribe function. */
  subscribeToPlaybackEvents: (listener: (event: PlaybackStateChangedEvent) => void) => () => void;
  /** Broadcast local route-playback state to party peers. Best-effort; no-op solo. */
  publishPlaybackState: (input: PublishPlaybackStateInput) => Promise<void>;
};

export const QueueContext = createContext<QueueContextValue | null>(null);

/**
 * QueueProvider intentionally exposes several narrow hooks. Pick the smallest
 * subscription that matches the read:
 * - useQueue(): legacy/full reducer state plus actions; use only when state shape is required.
 * - useQueueData(): the live queue + current climb item, without the rest of state; for the play drawer / queue sheet.
 * - useQueueActions(): stable command surface for enqueue/session/playback writes.
 * - useQueueSessionId(): rare session-id changes for structural chrome.
 * - useQueueSessionControls(): session id, serial/wall controls, and the member-userId set for party surfaces.
 * - useQueueLiveStats(): high-frequency live stats and roster updates.
 * - useIsSharedSession(): "is anyone else here" — browse-by-default gating.
 * - useActiveClimbUuid(): row-level active-climb highlighting.
 * - useHasActiveClimb(): presence-only bottom chrome metrics.
 * - usePlaylistSuggestionSource(): playlist peek/suggestion navigation.
 */
type QueueSessionControlContextValue = Pick<
  QueueContextValue,
  | 'sessionId'
  | 'participantId'
  | 'lastConnectedBoardSerial'
  | 'isSessionWallLit'
  | 'confirmClimbOnWall'
  | 'reportWallDisconnect'
  | 'setSessionBoardSerial'
> & {
  /**
   * Stable DB user UUIDs of the current session's members (including me). Used to
   * id-match the board-presence holder against "someone in my session" so the
   * lightbulb lights only for a session member's BLE link, not any board holder.
   * Empty when solo. Memoized by the sorted-id set so the ≤1/2s party push doesn't
   * churn its identity.
   */
  sessionMemberUserIds: ReadonlySet<string>;
};

export const QueueSessionControlContext = createContext<QueueSessionControlContextValue | null>(null);

/**
 * SessionId-only selector context. Its identity changes ONLY when the active
 * session id changes (session start / end / join — rare), never on queue
 * mutations or the ≤1/2s party pushes. Consumed by high-fanout *structural*
 * readers — the tab layout (which renders every tab inline), the board adapter,
 * and the session screen — so a queue change can't cascade a re-render through
 * the whole navigation tree. Narrower than QueueSessionControlContext, which
 * also churns on board-serial / wall-lit changes.
 */
type QueueSessionIdContextValue = {
  sessionId: string | null;
};

export const QueueSessionIdContext = createContext<QueueSessionIdContextValue | null>(null);

/**
 * Live session analytics + presence, split out of the main QueueContext so the
 * ≤1/2s `SessionStatsUpdated` party push (and roster deltas) re-renders only the
 * session screen — not every `useQueue()` consumer (climb list, persistent bar,
 * tab layout, board adapter, bluetooth provider, drawer host, live-activity
 * bridge). Consumed solely by SessionScreen + InSessionView.
 */
type QueueLiveStatsContextValue = {
  /**
   * Live aggregate stats for the active session, pushed over `sessionUpdates`
   * (the `SessionStatsUpdated` event) as ticks are logged. Null until the first
   * push arrives (or when there's no session).
   */
  liveStats: SessionLiveStatsEvent | null;
  /**
   * Connected participants in the active session. Seeded from the JOIN_SESSION
   * response and kept current via UserJoined/UserLeft/UserPresenceChanged.
   */
  sessionUsers: SessionUser[];
};

export const QueueLiveStatsContext = createContext<QueueLiveStatsContextValue | null>(null);

/**
 * "Is anyone else in this session with me" — a single boolean whose identity
 * flips ONLY across the solo ↔ crew boundary (`shouldDefaultToBrowse`).
 *
 * Its consumers are the surfaces that decide whether a gesture browses or takes
 * the wall: the play drawer's swipes and the climb list's row taps. Both are
 * hot — the climb list re-renders a virtualized FlashList, the drawer re-renders
 * board art — so neither can subscribe to {@link QueueLiveStatsContext}, whose
 * value is recreated by every ≤1/2s `SessionStatsUpdated` push and by every
 * presence delta. Deriving the boolean HERE means a fifth climber joining, a
 * peer's presence flapping, or a stats push costs those surfaces nothing: the
 * value only changes when the answer does.
 */
type QueueSharedSessionContextValue = {
  isSharedSession: boolean;
};

export const QueueSharedSessionContext = createContext<QueueSharedSessionContextValue | null>(null);

/**
 * Active-climb selector context. Changes identity ONLY when the active climb's
 * uuid changes, so the climb list (which highlights the active row) stops
 * re-rendering on every unrelated queue mutation or party push.
 */
type QueueActiveClimbContextValue = {
  activeClimbUuid: string | null;
};

export const QueueActiveClimbContext = createContext<QueueActiveClimbContextValue | null>(null);

/**
 * Boolean "is any climb currently active" selector. Identity changes ONLY when a
 * climb appears/disappears (none↔some) — NOT when navigating *between* climbs.
 * Consumed by bottom-chrome metrics (climbs, discover, You screens) so navigating
 * climbs in the play drawer no longer re-renders those whole tab screens.
 */
type QueueHasActiveClimbContextValue = {
  hasActiveClimb: boolean;
};

export const QueueHasActiveClimbContext = createContext<QueueHasActiveClimbContextValue | null>(null);

/**
 * Live queue data — the queue array plus the current climb item — split out so
 * the ~1040-line play drawer and the always-mounted queue sheets subscribe to
 * just the queue and stop re-rendering on session/wall-lit/roster churn. The
 * reducer spreads state on every update, so `state.queue` and
 * `state.currentClimbQueueItem` keep their identity across those unrelated
 * updates; the value is memoized on exactly that pair.
 */
type QueueDataContextValue = {
  queue: ClimbQueueItem[];
  currentClimbQueueItem: ClimbQueueItem | null;
};

export const QueueDataContext = createContext<QueueDataContextValue | null>(null);

/**
 * Stable queue actions, split out so consumers that only dispatch actions (e.g.
 * the climb list's add-to-queue) don't subscribe to the whole reducer `state`.
 * Holds everything in QueueContextValue except volatile state and selector-only
 * values. Playlist suggestion state lives in QueuePlaylistSuggestionContext so
 * playlist activation does not wake every action-only consumer in the tab tree.
 */
type QueueActionsContextValue = Omit<
  QueueContextValue,
  | 'state'
  | 'dispatch'
  | 'sessionId'
  | 'setSessionId'
  | 'lastConnectedBoardSerial'
  | 'participantId'
  | 'isSessionWallLit'
>;

export const QueueActionsContext = createContext<QueueActionsContextValue | null>(null);

type QueuePlaylistSuggestionContextValue = {
  playlistSuggestionSource: PlaylistSuggestionSource | null;
};

export const QueuePlaylistSuggestionContext = createContext<QueuePlaylistSuggestionContextValue | null>(null);

export function useQueue(): QueueContextValue {
  const context = useContext(QueueContext);
  if (!context) throw new Error('useQueue must be used within QueueProvider');
  return context;
}

export function useQueueSessionControls(): QueueSessionControlContextValue {
  const context = useContext(QueueSessionControlContext);
  if (!context) throw new Error('useQueueSessionControls must be used within QueueProvider');
  return context;
}

export function useQueueSessionId(): QueueSessionIdContextValue {
  const context = useContext(QueueSessionIdContext);
  if (!context) throw new Error('useQueueSessionId must be used within QueueProvider');
  return context;
}

export function useQueueLiveStats(): QueueLiveStatsContextValue {
  const context = useContext(QueueLiveStatsContext);
  if (!context) throw new Error('useQueueLiveStats must be used within QueueProvider');
  return context;
}

/**
 * True when a party session is joined AND at least one other climber is on the
 * roster — the condition under which browse-shaped gestures default to
 * view-only. See {@link QueueSharedSessionContext}.
 */
export function useIsSharedSession(): boolean {
  const context = useContext(QueueSharedSessionContext);
  if (!context) throw new Error('useIsSharedSession must be used within QueueProvider');
  return context.isSharedSession;
}

export function useActiveClimbUuid(): string | null {
  const context = useContext(QueueActiveClimbContext);
  if (!context) throw new Error('useActiveClimbUuid must be used within QueueProvider');
  return context.activeClimbUuid;
}

export function useHasActiveClimb(): boolean {
  const context = useContext(QueueHasActiveClimbContext);
  if (!context) throw new Error('useHasActiveClimb must be used within QueueProvider');
  return context.hasActiveClimb;
}

export function useQueueData(): QueueDataContextValue {
  const context = useContext(QueueDataContext);
  if (!context) throw new Error('useQueueData must be used within QueueProvider');
  return context;
}

export function useQueueActions(): QueueActionsContextValue {
  const context = useContext(QueueActionsContext);
  if (!context) throw new Error('useQueueActions must be used within QueueProvider');
  return context;
}

/**
 * Returns the active playlist suggestion source, or null when no playlist
 * continuation is active. A missing context still throws: in-tree "no source"
 * is represented by `null`, while no provider means the hook was misused.
 */
export function usePlaylistSuggestionSource(): PlaylistSuggestionSource | null {
  const context = useContext(QueuePlaylistSuggestionContext);
  if (!context) throw new Error('usePlaylistSuggestionSource must be used within QueueProvider');
  return context.playlistSuggestionSource;
}

export type {
  QueueContextValue,
  QueueSessionControlContextValue,
  QueueSessionIdContextValue,
  QueueLiveStatsContextValue,
  QueueSharedSessionContextValue,
  QueueActiveClimbContextValue,
  QueueHasActiveClimbContextValue,
  QueueDataContextValue,
  QueueActionsContextValue,
  QueuePlaylistSuggestionContextValue,
};
