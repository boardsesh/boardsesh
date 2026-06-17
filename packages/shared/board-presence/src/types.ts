/**
 * Pure board-presence ("now on the wall") state machine types.
 * No React, no DOM, no react-native — works in any JS runtime.
 *
 * The wire types (`BoardPresenceClimb`, `BoardPresenceEvent`, etc.) live in
 * `@boardsesh/shared-schema`; this package only owns the reducer state and
 * action shapes. The React wrapper (a `useReducer` hook bound to a GraphQL
 * subscription) lives in a separate `@boardsesh/board-presence-react` package.
 */

import type { BoardConnectionHolder, BoardPresenceClimb, BoardPresenceStats } from '@boardsesh/shared-schema';

/**
 * The wall's "now playing" state, driven by the per-board presence stream.
 *
 * - `currentClimb`: the climb currently lit on the wall, or `null` if cleared.
 * - `previousClimb`: the climb that was current before the latest set/clear,
 *   so the UI can offer an Undo affordance.
 * - `history`: newest-first list of climbs that have been on the wall, capped
 *   at {@link HISTORY_CAP}.
 * - `lastSeq`: the highest per-board sequence number applied so far. Used to
 *   dedup the late-joiner backfill against the live stream and to reject
 *   out-of-order Redis messages.
 */
export type BoardPresenceState = {
  currentClimb: BoardPresenceClimb | null;
  previousClimb: BoardPresenceClimb | null;
  history: BoardPresenceClimb[];
  lastSeq: number;
  /**
   * The board's durable stat snapshot (sends/climbers/hardest/top), pushed live
   * over the same subscription as climb events. Null until the first seed/push.
   */
  stats: BoardPresenceStats | null;
  /**
   * Highest stats-event `seq` applied. Stats events share the per-board seq
   * counter with climb events, so an out-of-order/duplicate stats push (seq <=
   * this) is ignored. Separate from `lastSeq` so a stats push never advances the
   * climb-ordering cursor (and vice versa).
   */
  lastStatsSeq: number;
  /**
   * Who is currently connected to (and writing to) the board, or `null` when the
   * board is free. Distinct from `currentClimb`: the holder is the live
   * connection owner, the climb is whatever LEDs are lit. Null until the first
   * connection seed/push.
   */
  holder: BoardConnectionHolder | null;
  /**
   * Highest connection-event `seq` applied. Connection events share the
   * per-board seq counter with climb + stats events, so an out-of-order/duplicate
   * connection push (seq <= this) is ignored. Separate from `lastSeq` /
   * `lastStatsSeq` so a connection push never advances the climb-ordering or
   * stats cursors (and vice versa).
   */
  lastConnectionSeq: number;
};

export type BoardPresenceAction =
  | { type: 'APPLY_CLIMB_SET'; payload: BoardPresenceClimb }
  | { type: 'APPLY_CLIMB_CLEARED'; payload: { clearedAt: string; seq: number } }
  | { type: 'BACKFILL_HISTORY'; payload: BoardPresenceClimb[] }
  // Live stats push from the subscription (the freshly recomputed snapshot).
  | { type: 'APPLY_STATS_UPDATED'; payload: { stats: BoardPresenceStats; seq: number } }
  // One-time initial fetch seed; only fills the tiles before any live push.
  | { type: 'SEED_STATS'; payload: BoardPresenceStats }
  // Full-feed catch-up after a detected sequence gap. This is a snapshot, so it
  // replaces stale tiles and advances the stats cursor through the repaired seq.
  | { type: 'REFRESH_STATS'; payload: { stats: BoardPresenceStats; upToSeq: number } }
  // Live connection push from the subscription (holder, or null when freed).
  | { type: 'APPLY_CONNECTION_CHANGED'; payload: { holder: BoardConnectionHolder | null; seq: number } }
  // One-time initial fetch seed; only fills the holder before any live push.
  | { type: 'SEED_CONNECTION'; payload: BoardConnectionHolder | null }
  // Full-feed catch-up after a detected sequence gap. This is a snapshot, so it
  // replaces stale holder state and advances the connection cursor through the
  // repaired seq.
  | { type: 'REFRESH_CONNECTION'; payload: { holder: BoardConnectionHolder | null; upToSeq: number } }
  | { type: 'RESET' };
