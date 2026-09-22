/**
 * Pure board-presence state reducer. No React, no DOM — works in any JS
 * runtime. The React `useReducer` wrapper lives in a separate
 * `@boardsesh/board-presence-react` package.
 *
 * Ordering & dedup model: every presence event carries a monotonic per-board
 * `seq`. A late joiner backfills history (one batch) and then follows the live
 * stream, so the same `(climbUuid, seq)` can arrive twice; Redis fan-out can
 * also deliver messages out of order. The reducer is therefore idempotent:
 * stale sets never regress the wall, but they can still be merged into history
 * when they represent a real older wall state that has not been recorded yet.
 */

import type { BoardPresenceClimb } from '@boardsesh/shared-schema';
import { compareBoardDisplayTimes, mergeBoardHistory } from './history';
import type { BoardPresenceState, BoardPresenceAction } from './types';

/** Newest-first history is capped so a long session can't grow unbounded. */
export const HISTORY_CAP = 50;

export const initialBoardPresenceState: BoardPresenceState = {
  currentClimb: null,
  previousClimb: null,
  history: [],
  lastSeq: 0,
  lastClearedAt: null,
  stats: null,
  lastStatsSeq: 0,
  holder: null,
  lastConnectionSeq: 0,
};

/** True when an entry with the same `(climbUuid, seq)` is already in history. */
function historyHasEntry(history: BoardPresenceClimb[], climb: BoardPresenceClimb): boolean {
  return history.some((entry) => entry.climbUuid === climb.climbUuid && entry.seq === climb.seq);
}

/**
 * Merge into history, dedup by `(climbUuid, seq)`, sort newest-first, cap.
 *
 * Identity-preserving: seeded from `existing` FIRST, so an incoming entry that
 * duplicates an already-present key is skipped rather than replacing it — the
 * existing object identity wins. This is what lets `React.memo`'d history rows
 * bail on a backfill that repeats everything the client already has (every app
 * resume, foreground catch-up, and pull-to-refresh when nothing new happened).
 * When the merged result is element-wise identical to `existing`, we return
 * `existing` itself so callers can cheaply detect "nothing changed" by
 * reference.
 *
 * On "the same key is the same data": that holds within one source (the live
 * feed and `boardRecentClimbs` share the Redis-backed payload verbatim), but
 * the durable `boardHistory` query is a known asymmetry — it re-resolves the
 * sender identity via a live users/profiles join and nulls `queueItemUuid` /
 * `gradeColor` (backend board-presence queries.ts), so the same
 * `(climbUuid, seq)` CAN differ in those fields across sources. Existing-wins
 * is still the right policy (the live-feed shape is the richer one), but a
 * future caller routing `fetchHistory` results through BACKFILL_HISTORY should
 * know the merge keeps the already-present variant rather than "refreshing"
 * those fields.
 */
function mergeHistory(existing: BoardPresenceClimb[], incoming: BoardPresenceClimb[]): BoardPresenceClimb[] {
  return mergeBoardHistory(existing, incoming, HISTORY_CAP);
}

/**
 * Native sequence numbers order native sets/clears. Imported sequence numbers
 * describe arrival, so they never advance that cursor. Across sources, the
 * latest display timestamp wins; native wins an exact timestamp tie.
 */
function updateWallFromHistory(
  state: BoardPresenceState,
  history: BoardPresenceClimb[],
  lastSeq: number,
  lastClearedAt = state.lastClearedAt,
): BoardPresenceState {
  const native =
    history.find((climb) => climb.source !== 'kilter' && climb.seq === lastSeq) ??
    (state.currentClimb?.source !== 'kilter' && state.currentClimb?.seq === lastSeq ? state.currentClimb : null);
  const imported = history.find(
    (climb) =>
      climb.source === 'kilter' &&
      Number.isFinite(Date.parse(climb.sentAt)) &&
      (lastClearedAt === null ||
        (Number.isFinite(Date.parse(lastClearedAt)) && compareBoardDisplayTimes(climb.sentAt, lastClearedAt) > 0)),
  );
  const currentClimb =
    imported && (!native || compareBoardDisplayTimes(imported.sentAt, native.sentAt) > 0) ? imported : native;
  if (
    history === state.history &&
    currentClimb === state.currentClimb &&
    lastSeq === state.lastSeq &&
    lastClearedAt === state.lastClearedAt
  ) {
    return state;
  }
  return {
    ...state,
    history,
    currentClimb,
    previousClimb: currentClimb === state.currentClimb ? state.previousClimb : state.currentClimb,
    lastSeq,
    lastClearedAt,
  };
}

export function boardPresenceReducer(state: BoardPresenceState, action: BoardPresenceAction): BoardPresenceState {
  switch (action.type) {
    case 'MERGE_HISTORY': {
      const history = mergeHistory(state.history, action.payload);
      const lastSeq = action.payload.reduce(
        (highest, climb) => (climb.source === 'kilter' ? highest : Math.max(highest, climb.seq)),
        state.lastSeq,
      );
      return updateWallFromHistory(state, history, lastSeq);
    }
    case 'APPLY_CLIMB_SET': {
      const incomingClimb = action.payload;

      // A stale native set can fill history, but cannot regress native wall state.
      if (incomingClimb.seq <= state.lastSeq) {
        if (historyHasEntry(state.history, incomingClimb)) return state;
        const history = mergeHistory(state.history, [incomingClimb]);
        return history === state.history ? state : { ...state, history };
      }
      return updateWallFromHistory(state, mergeHistory(state.history, [incomingClimb]), incomingClimb.seq);
    }

    case 'APPLY_CLIMB_CLEARED': {
      if (action.payload.seq <= state.lastSeq) return state;
      // Import arrival order cannot tell whether Kilter displayed a climb before
      // or after this clear. Keep its timestamp even after a later native set.
      return updateWallFromHistory(state, state.history, action.payload.seq, action.payload.clearedAt);
    }

    case 'BACKFILL_HISTORY': {
      const backfill = action.payload.filter((climb) => climb.source !== 'kilter');
      if (backfill.length === 0) return state;
      const history = mergeHistory(state.history, backfill);
      const lastSeq = backfill.reduce((highest, climb) => Math.max(highest, climb.seq), state.lastSeq);
      return updateWallFromHistory(state, history, lastSeq);
    }

    case 'APPLY_STATS_UPDATED': {
      // Live stats push. Stats events share the per-board seq counter with climb
      // events, so a stale/duplicate push (out-of-order Redis fan-out) is
      // ignored. Each push is a full recompute, so the highest-seq one wins.
      if (action.payload.seq <= state.lastStatsSeq) {
        return state;
      }
      return {
        ...state,
        stats: action.payload.stats,
        lastStatsSeq: action.payload.seq,
      };
    }

    case 'SEED_STATS': {
      // One-time initial fetch. Only fill the tiles if no stats have landed yet
      // (live or seeded); a live push that arrived during the fetch is fresher,
      // so never clobber it. Leaves `lastStatsSeq` at 0 so the next live push
      // always applies.
      if (state.stats !== null) {
        return state;
      }
      return {
        ...state,
        stats: action.payload,
      };
    }

    case 'REFRESH_STATS': {
      if (action.payload.upToSeq < state.lastStatsSeq) {
        return state;
      }
      return {
        ...state,
        stats: action.payload.stats,
        lastStatsSeq: action.payload.upToSeq,
      };
    }

    case 'APPLY_CONNECTION_CHANGED': {
      // Live connection push. Connection events share the per-board seq counter
      // with climb + stats events, so a stale/duplicate push (out-of-order Redis
      // fan-out) is ignored. The highest-seq holder wins; `holder: null` frees
      // the board.
      if (action.payload.seq <= state.lastConnectionSeq) {
        return state;
      }
      return {
        ...state,
        holder: action.payload.holder,
        lastConnectionSeq: action.payload.seq,
      };
    }

    case 'SEED_CONNECTION': {
      // One-time initial fetch. Only fill the holder if no live connection event
      // has landed yet; a live push that arrived during the fetch is fresher, so
      // never clobber it. Leaves `lastConnectionSeq` at 0 so the next live push
      // always applies.
      if (state.lastConnectionSeq !== 0) {
        return state;
      }
      return {
        ...state,
        holder: action.payload,
      };
    }

    case 'REFRESH_CONNECTION': {
      if (action.payload.upToSeq < state.lastConnectionSeq) {
        return state;
      }
      return {
        ...state,
        holder: action.payload.holder,
        lastConnectionSeq: action.payload.upToSeq,
      };
    }

    case 'RESET':
      return initialBoardPresenceState;

    default:
      return state;
  }
}
