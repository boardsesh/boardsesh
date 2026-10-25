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
  // Boardsesh grade (COALESCE(universal, local) on the shared difficulty scale)
  // + confidence tier, carried through the queue so a climb rendered from a
  // party-peer broadcast shows the grade without a per-climb refetch.
  boardseshDifficulty?: number | null;
  boardseshConfidence?: string | null;
  // `board_climbs.compatible_size_ids` — the product sizes this climb fits on.
  // Null/undefined means no compatibility data (legacy row, or a fetch path
  // that doesn't project it) and imposes no constraint. Carried through the
  // queue because a party peer on a different-sized wall needs it: on Woods the
  // 8x10's hold ids all exist on the 12x12 as different holds, so this is the
  // only field that stops an 8x10 climb lighting up wrong (canAddClimbToBoard
  // rule 5).
  compatibleSizeIds?: number[] | null;
  // `board_climbs.missing_hold_count` — how many of this climb's holds are no
  // longer on the wall after a spray-wall hold edit. Null/undefined means
  // "unknown", which every catalogue board is: holds do not come off a Kilter.
  // Carried through the queue because board compatibility reads it to keep a
  // climb that lost a hold queueable, loggable and playable on its own wall.
  missingHoldCount?: number | null;
  // `board_climbs.holds_revision_number` as the client that queued the climb
  // read it (#6023): the version at which its holds last moved. Null/undefined
  // means unknown. LOCAL ONLY for now: the queue documents are pinned by the
  // App Store screenshot fixtures and cannot select it, so it is not written to
  // the wire either, and an item rebuilt from a server echo has none. The sent
  // glyph then counts every tick on the climb. No tick sends a version.
  holdsRevisionNumber?: number | null;
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
  /**
   * What the player calls this list: "From {label}". Absent for a track the
   * climber did not pick from a named list (the queue sheet's suggestions, the
   * board feed), and the player then names nothing.
   */
  label?: string;
  /**
   * How many climbs the list holds, as the server counts it. Kept only while
   * `climbs` is that list one for one from its first climb, so a climb's index
   * here is its place in the list; anything that drops, reorders or appends out
   * of line clears it. Absent means the player shows the name without a count.
   */
  total?: number;
  /**
   * The server has climbs past the last one loaded. `loaderId` names the page
   * loader the screen that built this track registered (it holds the query);
   * `nextPage` is the page to ask it for. Absent means `climbs` is the whole track.
   */
  continuation?: PlaylistTrackContinuation;
  /**
   * Set while the player plays Up next in the middle of this list (issue
   * #6777): Next walks the queue before the list continues, and this is the
   * list climb it left from, so the list picks up after it once Up next is
   * played. Absent while the player is on the list itself. Client-only, like
   * the rest of the track.
   */
  resume?: PlaylistTrackResume;
  /**
   * The `resume` the walk held while it last played Up next, kept once it came
   * back to the list. From the list climb it picked up at, Previous retraces
   * that stretch of Up next exactly, back to the list climb it left, even when
   * older list-walk entries sit between them in the queue. Set and cleared by
   * `withPlaylistTrackResume` alone: clearing `resume` moves it here, setting a
   * new one drops it. Client-only, like the rest of the track.
   */
  detour?: PlaylistTrackResume;
};

/**
 * The list climb a walk left for Up next. See {@link PlaylistSuggestionSource.resume}.
 *
 * Both halves matter: `climbUuid` is where the list picks up again, and
 * `queueItemUuid` is the queue entry the walk left from, so stepping back onto
 * it (Previous from the first queued climb) is back on the list, while a queued
 * repeat of the same climb is still Up next. That entry is usually the
 * climb's own. After Previous retraced Up next from a list climb whose older
 * list-walk entry sits before the detour, it is that older entry instead (see
 * selectPreviousQueueItemWithSuggestions in `@boardsesh/play-view`).
 */
export type PlaylistTrackResume = {
  climbUuid: string;
  queueItemUuid: string;
};

/** Where a track's next page comes from. See {@link PlaylistSuggestionSource}. */
export type PlaylistTrackContinuation = {
  loaderId: string;
  nextPage: number;
};

/**
 * One page fetched past a track's loaded end, ready to append.
 *
 * `climbs` has already been through the track's own filter; `filteredOut` says
 * whether that filter dropped anything, which is what breaks the one-for-one
 * mapping a count needs.
 */
export type PlaylistTrackPage = {
  /** The page index this came from, in pages of `pageSize`. */
  page: number;
  pageSize: number;
  climbs: Climb[];
  filteredOut: boolean;
  /** The page after this one, or null when this was the last the track may load. */
  nextPage: number | null;
  /** The list's total, when the response carried one. */
  total?: number;
};

/**
 * What made a climb the current one, when it was more than a plain pick.
 *
 * - `climb_saved`: the create screen putting a just-saved climb on the queue.
 *   Nobody picked a climb to climb, so a measure of "made a climb active" has
 *   to be able to leave it out.
 * - `put_on_wall`: a pinned preview committed on purpose: the Put on the wall
 *   (or Set active) button under it, or the lightbulb relaying it to the board
 *   holder. A real choice, kept apart so the crew browse rollout (#4281) can
 *   count it; the event's `participantCount` tells a crew's commits from solo
 *   ones.
 */
export type SetCurrentClimbTrigger = 'climb_saved' | 'put_on_wall';

export type SetCurrentClimbOptions = {
  /**
   * The playlist the climb was activated from, or null to clear that context.
   * Left out, the context is untouched, the same as passing no options.
   */
  playlistSuggestionSource?: PlaylistSuggestionSource | null;
  /**
   * A queued climb a look reached went up on the wall (issue #6777): a preview
   * that walked the queue from the current climb, then Put on the wall. Where
   * the climb is Up next on the held track, the track keeps steering and
   * learns where the list picks up, as Next stepping into Up next does;
   * otherwise it is cleared, like `playlistSuggestionSource: null`. Passed
   * instead of `playlistSuggestionSource`.
   */
  keepTrackIfUpNext?: boolean;
  trigger?: SetCurrentClimbTrigger;
};

/**
 * The fields of a climb its setter can change by saving it again in the editor.
 * `REFRESH_AUTHORED_CLIMB` patches these onto every copy of the climb already in
 * the queue. Deliberately not the whole `Climb`: the editor's copy carries
 * placeholder grade and send counts, and writing those over a queued climb would
 * blank the grade it was fetched with. Keyed by `climb.uuid`.
 */
export type ClimbAuthoredPatch = Pick<Climb, 'name' | 'frames'> &
  Partial<
    Pick<
      Climb,
      'description' | 'is_draft' | 'published_at' | 'is_no_match' | 'characteristics' | 'framesCount' | 'framesPace'
    >
  >;

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
  benchmark_difficulty: string | null;
  difficulty_error?: string;
  // Explicit nulls (not omitted) so an angle with no boardsesh grade row
  // clears a stale value carried over from the climb's previous angle.
  boardseshDifficulty?: number | null;
  boardseshConfidence?: string | null;
};

/** A local read addresses a particular committed representation, not just a climb UUID. */
export type QueueClimbReadTarget = {
  role: 'queue' | 'current';
  uuid: string;
  expectedClimb: Climb;
  angle: number;
};

export type QueueSearchParams = Record<string, unknown>;

/**
 * This client's latest move of the shared wall that the session has not
 * confirmed yet: the climb it moved onto, and the climbs it moved off.
 *
 * A server snapshot (a reconnect FullSync, an HTTP resync) can be older than a
 * move that is still on its way. Applied as is, it puts the wall back on the
 * previous climb and drops the move's correlation id, so the move's own echo is
 * then applied as if a peer sent it. The reducer instead compares the
 * snapshot with this record:
 *   - shows the move's climb → the session has it; the record is done.
 *   - carries the sequence this client last applied, and shows one of
 *     `movedOff` → nothing happened in the session since this client last
 *     heard from it, so the move simply has not landed; keep it.
 *   - anything else → something happened that this client never saw (its own
 *     move landing and a crewmate moving the wall back looks exactly like a
 *     stale climb otherwise); take the snapshot.
 *
 * Only a move sent to a party session is recorded, and only a snapshot read
 * from that same session is compared with it. Every other way the current
 * climb changes (a peer's move, a local move that is not sent) retires it.
 * The climb itself is not copied: the record is only ever alive while the
 * current climb is the one it names.
 */
export type UnconfirmedQueueMove = {
  /** The party session the move was sent to. */
  sessionId: string;
  /** Correlation id of the latest send of this move; its echo confirms it. */
  correlationId: string;
  /** Queue-item uuid of the climb the move put on the wall. */
  itemUuid: string;
  shouldAddToQueue: boolean;
  insertAfterCurrent: boolean;
  /**
   * Uuids of the current climbs this client moved the wall off since the
   * session last confirmed one of its moves, oldest first.
   *
   * `null` means the wall had no current climb before a move (the first pick
   * of a session, or after a clear). It is kept on purpose: the reducer's
   * `movedOff.includes(snapshotCurrentUuid)` reads a snapshot with no current
   * climb as `null`, so one at an unchanged sequence counts as predating the
   * move (the session has not seen it yet) and the move is kept, exactly as for
   * a climb it moved off. At a later sequence the snapshot wins as usual.
   */
  movedOff: Array<string | null>;
  /**
   * The chain moved off more climbs than `movedOff` keeps, so the list may lack
   * the one the session still holds. Every snapshot then wins, as before the
   * record existed, and a send that missed the session is given up at once.
   */
  movedOffTruncated: boolean;
  /**
   * Re-send state for a send that never reached the session (the connection
   * had not re-joined yet, or the socket closed for good):
   *   - `none`:              no re-send wanted.
   *   - `awaiting-snapshot`: wait for a live snapshot to prove nobody else moved the wall.
   *   - `ready`:             that snapshot came and still predates the move: re-send now.
   *   - `resent`:            re-sent once. A second loss falls back to a resync.
   */
  resend: 'none' | 'awaiting-snapshot' | 'ready' | 'resent';
};

export type QueueState<TSearchParams extends QueueSearchParams = QueueSearchParams> = {
  /** Server sequence committed with this queue snapshot. */
  serverSequence?: number;
  queue: ClimbQueue;
  currentClimbQueueItem: ClimbQueueItem | null;
  climbSearchParams: TSearchParams;
  playlistSuggestionSource: PlaylistSuggestionSource | null;
  hasDoneFirstFetch: boolean;
  pendingCurrentClimbUpdates: string[];
  needsResync: boolean;
  /** See `UnconfirmedQueueMove`. Optional so state built before it existed still type-checks. */
  unconfirmedMove?: UnconfirmedQueueMove | null;
  /**
   * The party session `serverSequence` counts in: the one the last
   * INITIAL_QUEUE_DATA named, null after one that named none. A sequence is
   * only comparable within one session, and switching rooms keeps the old
   * room's number until the new room's first snapshot.
   */
  serverSequenceSessionId?: string | null;
};

export type QueueAction<TSearchParams extends QueueSearchParams = QueueSearchParams> =
  QueueActionPayload<TSearchParams> & {
    serverSequence?: number;
  };

type QueueActionPayload<TSearchParams extends QueueSearchParams> =
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
      payload: {
        queue: ClimbQueue;
        currentClimbQueueItem?: ClimbQueueItem | null;
        /**
         * The party session this snapshot was read from. Set it only on a real
         * server snapshot: only then is it compared with the unconfirmed move
         * sent to that session. Any other INITIAL_QUEUE_DATA retires the move.
         * Pass the snapshot's sequence as the action's `serverSequence`.
         */
        sessionId?: string;
        /**
         * The snapshot opened the stream this client is subscribed on, so every
         * later change in the session reaches it as an event. Only such a
         * snapshot can release a re-send (`awaiting-snapshot` → `ready`). An
         * HTTP resync is a point read and leaves it unset.
         */
        live?: boolean;
      };
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
        /**
         * Whether a `playlistSuggestionSource` activation also drops `suggested`
         * items after the new current climb. Defaults to true. The prune is
         * local-only (no queue mutation reaches the server), so a client that is
         * in a party session passes false — otherwise its queue diverges from the
         * room's and the ordered-hash watchdog resyncs it back within a minute.
         */
        pruneSuggestedAfterCurrent?: boolean;
        /**
         * Local moves only: the party session a setCurrentClimb mutation for
         * this move is being sent to. Set it only when that mutation really goes
         * out; the reducer then records the move as unconfirmed (see
         * `UnconfirmedQueueMove`). Needs `correlationId`.
         */
        sessionId?: string;
      };
    }
  | { type: 'DELTA_MIRROR_CURRENT_CLIMB'; payload: { mirrored: boolean; mirroredUuid: string | null } }
  | { type: 'DELTA_REPLACE_QUEUE_ITEM'; payload: { uuid: string; item: ClimbQueueItem } }
  | { type: 'SET_PLAYLIST_SUGGESTION_SOURCE'; payload: PlaylistSuggestionSource | null }
  | { type: 'REFRESH_PLAYLIST_SUGGESTION_SOURCE'; payload: PlaylistSuggestionSource }
  | { type: 'CLEANUP_PENDING_UPDATE'; payload: { correlationId: string } }
  /**
   * The send of the unconfirmed move with this correlation id never reached the
   * session. `serverViewIsLive`: the client has applied the opening snapshot of
   * its current connection's stream and is receiving its live events, so a
   * re-send can go now; otherwise it waits for a live snapshot. Ignored unless
   * the id is the record's latest and no re-send was asked for yet.
   */
  | { type: 'UNCONFIRMED_MOVE_NOT_SENT'; payload: { correlationId: string; serverViewIsLive: boolean } }
  /** The re-send of this move went out. Ignored unless the record is `ready` for it. */
  | { type: 'UNCONFIRMED_MOVE_RESENT'; payload: { correlationId: string } }
  /** Forget the unconfirmed move (only the one with this correlation id, when given). */
  | { type: 'UNCONFIRMED_MOVE_DROPPED'; payload: { correlationId?: string } }
  | { type: 'CLEANUP_PENDING_UPDATES_BATCH'; payload: { correlationIds: string[] } }
  | { type: 'CLEAR_RESYNC_FLAG' }
  | {
      type: 'HYDRATE_CLIMBS';
      payload: {
        climb: Climb;
        targets: QueueClimbReadTarget[];
        boardType: string;
        layoutId: number;
        activeAngle: number;
      };
    }
  | {
      type: 'REGRADE_CLIMBS';
      payload: {
        grades: Record<string, ClimbRegradePatch>;
        targets?: QueueClimbReadTarget[];
        boardType?: string;
        layoutId?: number;
      };
    }
  | { type: 'REFRESH_AUTHORED_CLIMB'; payload: { climbUuid: string; patch: ClimbAuthoredPatch } }
  | { type: 'CLEAR_QUEUE' };
