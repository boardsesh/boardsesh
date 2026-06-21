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
import type { BoardPresenceState, BoardPresenceAction } from './types';

/** Newest-first history is capped so a long session can't grow unbounded. */
export const HISTORY_CAP = 50;

export const initialBoardPresenceState: BoardPresenceState = {
  currentClimb: null,
  previousClimb: null,
  history: [],
  lastSeq: 0,
  stats: null,
  lastStatsSeq: 0,
  holder: null,
  lastConnectionSeq: 0,
};

/** True when an entry with the same `(climbUuid, seq)` is already in history. */
function historyHasEntry(history: BoardPresenceClimb[], climb: BoardPresenceClimb): boolean {
  return history.some((entry) => entry.climbUuid === climb.climbUuid && entry.seq === climb.seq);
}

/** Merge into history, dedup by `(climbUuid, seq)`, sort newest-first, cap. */
function mergeHistory(existing: BoardPresenceClimb[], incoming: BoardPresenceClimb[]): BoardPresenceClimb[] {
  const byKey = new Map<string, BoardPresenceClimb>();
  for (const climb of [...existing, ...incoming]) {
    byKey.set(`${climb.climbUuid}:${climb.seq}`, climb);
  }
  return Array.from(byKey.values())
    .sort((left, right) => right.seq - left.seq)
    .slice(0, HISTORY_CAP);
}

export function boardPresenceReducer(state: BoardPresenceState, action: BoardPresenceAction): BoardPresenceState {
  switch (action.type) {
    case 'APPLY_CLIMB_SET': {
      const incomingClimb = action.payload;

      // Dedup + ordering: a stale live event must not regress the wall, but if
      // Redis delivers a real older set after a newer one, keep it in history.
      if (incomingClimb.seq <= state.lastSeq) {
        if (historyHasEntry(state.history, incomingClimb)) {
          return state;
        }
        return {
          ...state,
          history: mergeHistory(state.history, [incomingClimb]),
        };
      }

      if (historyHasEntry(state.history, incomingClimb)) {
        return state;
      }

      return {
        ...state,
        currentClimb: incomingClimb,
        previousClimb: state.currentClimb,
        history: [incomingClimb, ...state.history].slice(0, HISTORY_CAP),
        lastSeq: Math.max(state.lastSeq, incomingClimb.seq),
      };
    }

    case 'APPLY_CLIMB_CLEARED': {
      // Only honour a clear that is strictly newer than everything applied so
      // far; a stale/duplicate clear must not wipe a climb set after it.
      if (action.payload.seq <= state.lastSeq) {
        return state;
      }

      return {
        ...state,
        currentClimb: null,
        previousClimb: state.currentClimb,
        lastSeq: action.payload.seq,
      };
    }

    case 'BACKFILL_HISTORY': {
      const backfill = action.payload;
      if (backfill.length === 0) {
        return state;
      }

      const mergedHistory = mergeHistory(state.history, backfill);
      const highestSeq = backfill.reduce((highest, climb) => Math.max(highest, climb.seq), state.lastSeq);

      // The newest-by-seq item across the merged history is the candidate for
      // "current". Adopt only when it is newer than every sequence already
      // applied, because `lastSeq` also tracks clears. This prevents an older
      // backfill from resurrecting a wall that was cleared while catch-up was
      // in flight.
      const newestHistoryClimb = mergedHistory[0] ?? null;
      const shouldAdoptHistoryClimb = newestHistoryClimb !== null && newestHistoryClimb.seq > state.lastSeq;

      return {
        ...state,
        currentClimb: shouldAdoptHistoryClimb ? newestHistoryClimb : state.currentClimb,
        previousClimb: shouldAdoptHistoryClimb ? state.currentClimb : state.previousClimb,
        history: mergedHistory,
        lastSeq: highestSeq,
      };
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
