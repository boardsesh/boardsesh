// Injected platform I/O for the board-presence React hook.
//
// This package never imports a GraphQL client (it must stay renderer-agnostic
// and platform-free), so the consumer supplies a `BoardPresenceClient` that
// wires the actual transport — graphql-ws on web/mobile, or a fake in tests.
// The hook only sees these five methods.

import type {
  BoardConnectionHolder,
  BoardPresenceClimb,
  BoardPresenceEvent,
  BoardPresenceStats,
  ClimbQueueItemInput,
  ResolvedBoard,
} from '@boardsesh/shared-schema';

/**
 * Keyset cursor for `fetchHistory` paging: the stringified `seq` of the last
 * row from the previous page. `seq` is a number everywhere else, but the
 * GraphQL `boardHistory(before: String)` arg is a String and rejects a
 * non-integer `before` with BAD_USER_INPUT — so always stringify the seq.
 * Branded so the only way to make one is `boardHistoryCursor`, never an ad-hoc string.
 */
export type BoardHistoryCursor = string & { readonly _brand: 'BoardHistoryCursor' };

/** Cursor for the next page back: the `seq` of a climb (or a raw seq), stringified. */
export function boardHistoryCursor(climbOrSeq: BoardPresenceClimb | number): BoardHistoryCursor {
  return (typeof climbOrSeq === 'number' ? climbOrSeq : climbOrSeq.seq).toString() as BoardHistoryCursor;
}

export interface BoardPresenceClient {
  /**
   * Subscribe to a board's live "now on the wall" feed. Each event is one
   * `BoardPresenceEvent` (set or cleared). Returns an unsubscribe function the
   * hook calls on board change / unmount. `onError` (optional) reports a
   * transport-level failure without tearing down the hook's state.
   */
  subscribeNowPlaying(
    boardId: number,
    onEvent: (event: BoardPresenceEvent) => void,
    onError?: (err: unknown) => void,
    onComplete?: () => void,
  ): () => void;

  /**
   * Register a callback fired whenever the underlying transport reconnects
   * (i.e. on every reconnect, not the first connect). The hook uses this to
   * catch up the durable history after a dropped socket — live events ride
   * Redis pub/sub with no replay, so anything pushed during the reconnect
   * window is otherwise lost for this client. Returns an unsubscribe function.
   * Optional so read-only / web clients that don't expose reconnect events
   * still satisfy the interface (their feed self-heals on the next live event).
   */
  onReconnect?(callback: () => void): () => void;

  /** Newest-first recent climbs, used to backfill history for a late joiner. */
  fetchRecentClimbs(boardId: number): Promise<BoardPresenceClimb[]>;

  /**
   * Durable, keyset-paged history of what was lit on the board, from the
   * `board_climb_events` log — beyond the ~50 / 24h window `fetchRecentClimbs`
   * covers. Newest-first; pass `before` (the `seq` of the previous page's last
   * row) to page back, and `limit` (server-capped 1–100, default 50) for page
   * size. Optional so read-only / web clients that only need the live feed plus
   * recent backfill still satisfy the interface.
   */
  fetchHistory?(boardId: number, opts?: { limit?: number; before?: BoardHistoryCursor }): Promise<BoardPresenceClimb[]>;

  /** Durable + live stats for the board's wall feed. */
  fetchStats(boardId: number): Promise<BoardPresenceStats>;

  /**
   * Current connection holder for the board, used to seed a late joiner before
   * any live `BoardConnectionChanged` push lands. Resolves to `null` when the
   * board is free. Optional so a client that doesn't track holders still
   * satisfies the interface.
   */
  fetchConnection?(boardId: number): Promise<BoardConnectionHolder | null>;

  /**
   * Release this client's hold on the board (e.g. on BLE disconnect). Resolves
   * to the server's accepted flag. Optional so a read-only client still
   * satisfies the interface.
   */
  reportDisconnect?(boardId: number): Promise<boolean>;

  /**
   * Report the climb just lit on the wall. `angle` is the wall angle (null =
   * unspecified). Resolves to the server's accepted flag.
   */
  reportClimb(boardId: number, climb: ClimbQueueItemInput, angle: number | null): Promise<boolean>;

  /** Resolve (and bind) the shared board for a BLE serial. */
  resolveBoardForSerial(args: {
    serial: string;
    boardType: string;
    layoutId: number;
    sizeId: number;
    setIds: string;
  }): Promise<ResolvedBoard>;

  /** Resolve the selected named board's wall feed before BLE connects. */
  resolveBoardForUuid?(args: { boardUuid: string }): Promise<ResolvedBoard>;

  /**
   * Resolve the shared board by configuration when the BLE controller exposes no
   * serial. Aurora boards should use `resolveBoardForSerial`; serial-less boards
   * like MoonBoard use this per-config fallback when the backend supports it.
   */
  resolveBoardForConfig?(args: {
    boardType: string;
    layoutId: number;
    sizeId: number;
    setIds: string;
  }): Promise<ResolvedBoard>;
}
