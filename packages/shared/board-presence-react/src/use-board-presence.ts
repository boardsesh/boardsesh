// Renderer-agnostic React hook over the pure board-presence reducer.
//
// Binds a `BoardPresenceClient` (injected transport) to
// `boardPresenceReducer`, exposing the wall's "now playing" state plus actions
// for reporting a fresh climb and reading the captured undo target. All platform
// I/O is injected — this package imports no GraphQL client and no host
// components, so it runs unchanged on web and mobile.
//
// Catch-up ordering (the load-bearing bit): on a new board we SUBSCRIBE FIRST,
// so any live event that lands during the async backfill is already buffered
// into the reducer; only then do we fetch recent climbs and dispatch
// BACKFILL_HISTORY. The reducer's per-board `seq` dedup makes that safe — a
// stale backfill can't clobber a newer live `current` (see board-presence
// reducer). We also guard every async result against unmount and against a
// board switch (late results for a previous board are ignored).

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
} from 'react';
import {
  boardPresenceReducer,
  initialBoardPresenceState,
  mapBoardPresenceEnvelopeToAction,
  type BoardPresenceAction,
  type BoardPresenceState,
} from '@boardsesh/board-presence';
import type {
  BoardConnectionHolder,
  BoardPresenceClimb,
  BoardPresenceEvent,
  BoardPresenceStats,
  ClimbQueueItemInput,
} from '@boardsesh/shared-schema';
import type { BoardPresenceClient } from './types';

export type UseBoardPresenceResult = {
  currentClimb: BoardPresenceCurrentState['currentClimb'];
  previousClimb: BoardPresenceCurrentState['previousClimb'];
  undoTarget: BoardPresenceCurrentState['undoTarget'];
  holder: BoardPresenceCurrentState['holder'];
  history: BoardPresenceFeedState['history'];
  stats: BoardPresenceFeedState['stats'];
  isHydrating: BoardPresenceFeedState['isHydrating'];
  isRefreshing: BoardPresenceFeedState['isRefreshing'];
  isLive: BoardPresenceCurrentState['isLive'];
  reportClimb: BoardPresenceActions['reportClimb'];
  reportClimbWithUndoTarget: BoardPresenceActions['reportClimbWithUndoTarget'];
  reportDisconnect: BoardPresenceActions['reportDisconnect'];
  getUndoTarget: BoardPresenceActions['getUndoTarget'];
  refresh: BoardPresenceActions['refresh'];
};

export type BoardPresenceReportResult = {
  accepted: boolean;
  undoTarget: BoardPresenceClimb | null;
};

export type BoardPresenceCurrentState = {
  currentClimb: BoardPresenceState['currentClimb'];
  previousClimb: BoardPresenceState['previousClimb'];
  /**
   * The wall climb that should be restored for this device's latest accepted
   * report. Platforms should relight this over BLE, then report the restored
   * climb after the BLE write succeeds.
   */
  undoTarget: BoardPresenceClimb | null;
  /**
   * Who is currently connected to (and writing to) the board, or `null` when the
   * board is free. Distinct from `currentClimb`: the holder is the live
   * connection owner, the climb is whatever LEDs are lit.
   */
  holder: BoardConnectionHolder | null;
  /** True while a live subscription is attached for the active board. */
  isLive: boolean;
};

export type BoardPresenceFeedState = {
  history: BoardPresenceState['history'];
  stats: BoardPresenceStats | null;
  /**
   * True from the moment a board binds until the initial backfill (recent climbs
   * + stats) settles. Lets the feed surface a skeleton on first open instead of
   * the empty state, which is otherwise indistinguishable from a quiet board.
   */
  isHydrating: boolean;
  /** True while a user-triggered `refresh()` is in flight. */
  isRefreshing: boolean;
};

export type BoardPresenceActions = {
  /** Report a freshly-lit climb to the active board. Resolves to the accepted flag. */
  reportClimb: (climb: ClimbQueueItemInput, angle: number | null) => Promise<boolean>;
  /**
   * Report a freshly-lit climb and return the locally captured undo target for
   * this report. Use this in platform snackbar flows so the button restores the
   * exact climb that was current before the report, even if the live echo has
   * not round-tripped yet.
   */
  reportClimbWithUndoTarget: (climb: ClimbQueueItemInput, angle: number | null) => Promise<BoardPresenceReportResult>;
  /**
   * Release this client's hold on the active board (e.g. on BLE disconnect).
   * Resolves to the accepted flag; resolves `false` when inert or when the
   * injected client does not implement `reportDisconnect`.
   */
  reportDisconnect: () => Promise<boolean>;
  /** Latest captured undo target for action-only consumers that need a ref-like read. */
  getUndoTarget: () => BoardPresenceClimb | null;
  /**
   * Force a re-fetch of the active board's recent climbs, stats, and connection
   * holder, dispatching the same catch-up actions the live-gap path uses. Resolves
   * when the fetch settles; no-op when inert or already refreshing.
   */
  refresh: () => Promise<void>;
};

function boardPresenceEventSeq(event: BoardPresenceEvent): number | null {
  switch (event.__typename) {
    case 'BoardClimbSet':
      return event.climb.seq;
    case 'BoardClimbCleared':
    case 'BoardStatsUpdated':
    case 'BoardConnectionChanged':
      return event.seq;
    default:
      return null;
  }
}

function highestClimbSeq(climbs: BoardPresenceClimb[]): number {
  return climbs.reduce((highestSeq, climb) => Math.max(highestSeq, climb.seq), 0);
}

/**
 * Shared catch-up body for both the live-gap path and the user `refresh()`:
 * re-fetch recent climbs + stats + connection holder for `boardId` and dispatch
 * the seq-guarded merge actions. `observedSeqRef` is advanced past anything the
 * recent fetch repaired so a later live event doesn't re-trigger catch-up for
 * the same gap. `shouldApply` is re-checked AFTER the fetch settles — when it
 * returns false (unmount or a board switch landed mid-flight) nothing is applied,
 * so a late result for a superseded board can't clobber the new board's state.
 * Callers own their own in-flight guarding.
 */
async function applyBoardPresenceCatchUp(
  client: BoardPresenceClient,
  boardId: number,
  dispatch: Dispatch<BoardPresenceAction>,
  observedSeqRef: MutableRefObject<number>,
  shouldApply: () => boolean,
): Promise<void> {
  const startedAtSeq = observedSeqRef.current;
  const connectionFetch = client.fetchConnection;
  const connectionPromise =
    connectionFetch === undefined
      ? Promise.resolve<BoardConnectionHolder | null | undefined>(undefined)
      : connectionFetch(boardId);

  const [recentResult, statsResult, connectionResult] = await Promise.allSettled([
    client.fetchRecentClimbs(boardId),
    client.fetchStats(boardId),
    connectionPromise,
  ] as const);

  if (!shouldApply()) {
    return;
  }

  let repairedThroughSeq = startedAtSeq;
  if (recentResult.status === 'fulfilled') {
    const recentClimbs = recentResult.value;
    repairedThroughSeq = Math.max(repairedThroughSeq, highestClimbSeq(recentClimbs));
    observedSeqRef.current = Math.max(observedSeqRef.current, repairedThroughSeq);
    dispatch({ type: 'BACKFILL_HISTORY', payload: recentClimbs });
  }

  if (statsResult.status === 'fulfilled') {
    dispatch({ type: 'REFRESH_STATS', payload: { stats: statsResult.value, upToSeq: repairedThroughSeq } });
  }

  if (connectionFetch !== undefined && connectionResult.status === 'fulfilled') {
    dispatch({
      type: 'REFRESH_CONNECTION',
      payload: { holder: connectionResult.value ?? null, upToSeq: repairedThroughSeq },
    });
  }
}

type HydrationBindKey = { boardId: number | null; client: BoardPresenceClient | null };

export function useBoardPresence(boardId: number | null, client: BoardPresenceClient | null): UseBoardPresenceResult {
  const [state, dispatch] = useReducer(boardPresenceReducer, initialBoardPresenceState);
  const [isLive, setIsLive] = useState(false);
  const [isHydrating, setIsHydrating] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [undoTarget, setUndoTarget] = useState<BoardPresenceClimb | null>(null);
  const isRefreshingRef = useRef(false);
  const mountedRef = useRef(true);

  // Raise the skeleton synchronously during render whenever the bound board (or
  // client) changes — including the first render. Doing it here (not in the bind
  // effect, which runs after render) avoids flashing the empty state for one frame
  // before the skeleton appears on a fresh bind or a board switch. The seed-settle
  // in the effect lowers it again. Mirrors the effect's `[boardId, client]` deps;
  // the guard keeps the render-phase update from looping.
  const [hydrationBindKey, setHydrationBindKey] = useState<HydrationBindKey | null>(null);
  if (hydrationBindKey === null || hydrationBindKey.boardId !== boardId || hydrationBindKey.client !== client) {
    setHydrationBindKey({ boardId, client });
    setIsHydrating(boardId !== null && client !== null);
  }

  // Live refs so the action callbacks stay identity-stable while still reading
  // the current board, client, and restore target.
  const boardIdRef = useRef(boardId);
  boardIdRef.current = boardId;
  const clientRef = useRef(client);
  clientRef.current = client;
  const currentClimbRef = useRef<BoardPresenceClimb | null>(state.currentClimb);
  currentClimbRef.current = state.currentClimb;
  const undoTargetRef = useRef<BoardPresenceClimb | null>(undoTarget);
  undoTargetRef.current = undoTarget;
  const observedSeqRef = useRef(0);

  // Tracks mount so async tails (e.g. a refresh resolving after unmount) can skip
  // their trailing state updates, matching the bind effect's per-run `isActive`.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    // No board or no transport: collapse to the initial state and stay inert.
    // RESET clears stats too (they live in the reducer now).
    if (boardId === null || client === null) {
      dispatch({ type: 'RESET' });
      setIsLive(false);
      setIsRefreshing(false);
      isRefreshingRef.current = false;
      setUndoTarget(null);
      observedSeqRef.current = 0;
      // isHydrating is driven by the render-phase bind-key reset above.
      return;
    }

    // Reset for the board we're about to attach to, so the prior board's
    // history/current/stats never bleed into this one.
    dispatch({ type: 'RESET' });
    setUndoTarget(null);
    observedSeqRef.current = 0;
    // Drop any in-flight refresh from the previous board. The skeleton is raised
    // by the render-phase bind-key reset above; the seed-settle below lowers it.
    isRefreshingRef.current = false;
    setIsRefreshing(false);

    let isActive = true;
    let catchUpInFlight = false;
    let catchUpRequested = false;
    // Once a baseline exists, a live gap may trigger catch-up even while the
    // initial backfill is still resolving. That overlap is safe: both paths
    // merge through BACKFILL_HISTORY, which dedups by (climbUuid, seq).
    let hasSequenceBaseline = false;
    // Identifies this effect run; late async results for a superseded board are
    // ignored by comparing against the ref, which the cleanup flips off.
    const subscribedBoardId = boardId;

    const runCatchUp = () => {
      if (!isActive || boardIdRef.current !== subscribedBoardId) {
        return;
      }
      if (catchUpInFlight) {
        catchUpRequested = true;
        return;
      }

      catchUpInFlight = true;
      void applyBoardPresenceCatchUp(
        client,
        boardId,
        dispatch,
        observedSeqRef,
        () => isActive && boardIdRef.current === subscribedBoardId,
      ).finally(() => {
        if (!isActive) {
          return;
        }
        catchUpInFlight = false;
        if (catchUpRequested) {
          catchUpRequested = false;
          runCatchUp();
        }
      });
    };

    // 1) Subscribe FIRST. Events arriving during the catch-up fetches below are
    //    buffered straight into the reducer; the reducer's seq-dedup then keeps
    //    a stale backfill from clobbering a newer live current.
    const unsubscribe = client.subscribeNowPlaying(
      boardId,
      (event) => {
        if (!isActive) {
          return;
        }
        const eventSeq = boardPresenceEventSeq(event);
        if (eventSeq !== null) {
          const previousObservedSeq = observedSeqRef.current;
          observedSeqRef.current = Math.max(previousObservedSeq, eventSeq);
          if (hasSequenceBaseline && eventSeq > previousObservedSeq + 1) {
            runCatchUp();
          }
          hasSequenceBaseline = true;
        }
        const action = mapBoardPresenceEnvelopeToAction(event);
        if (action) {
          dispatch(action);
        }
      },
      () => {
        if (isActive) {
          setIsLive(false);
        }
      },
      () => {
        if (isActive) {
          setIsLive(false);
        }
      },
    );
    setIsLive(true);

    // 2) Backfill recent history, then 3) seed stats. Both guarded against
    //    unmount and against a board switch (a late resolve for the previous
    //    board must not write into the new board's state). The stats fetch is
    //    only the initial SEED — from here on, every tick on this wall pushes a
    //    fresh `BoardStatsUpdated` over the subscription above (handled by the
    //    reducer), so the tiles update live without re-fetching. SEED_STATS is a
    //    no-op once any live push has landed, so it can't clobber fresher data.
    const recentSeed = client
      .fetchRecentClimbs(boardId)
      .then((recentClimbs) => {
        if (isActive && boardIdRef.current === subscribedBoardId) {
          observedSeqRef.current = Math.max(observedSeqRef.current, highestClimbSeq(recentClimbs));
          hasSequenceBaseline = true;
          dispatch({ type: 'BACKFILL_HISTORY', payload: recentClimbs });
        }
      })
      .catch(() => {
        // Backfill is best-effort; the live stream still drives the wall.
        hasSequenceBaseline = observedSeqRef.current > 0;
      });

    const statsSeed = client
      .fetchStats(boardId)
      .then((nextStats) => {
        if (isActive && boardIdRef.current === subscribedBoardId) {
          dispatch({ type: 'SEED_STATS', payload: nextStats });
        }
      })
      .catch(() => {
        // Stats are best-effort; absence renders as "no stats yet".
      });

    // Skeleton stays up until both seeds settle for this board; after that the
    // real history/stats (or the empty state) render.
    void Promise.allSettled([recentSeed, statsSeed]).then(() => {
      if (isActive && boardIdRef.current === subscribedBoardId) {
        setIsHydrating(false);
      }
    });

    // 4) Seed the current connection holder for a late joiner. `fetchConnection`
    //    is optional — `?.` skips clients that don't implement it (returns
    //    undefined; we skip). Same unmount/board-switch guard as the seeds above.
    //    SEED_CONNECTION is a no-op once any live BoardConnectionChanged has
    //    landed, so it can't clobber a fresher holder.
    void client
      .fetchConnection?.(boardId)
      .then((holder) => {
        if (isActive && boardIdRef.current === subscribedBoardId) {
          dispatch({ type: 'SEED_CONNECTION', payload: holder });
        }
      })
      .catch(() => {
        // Holder seed is best-effort; absence renders as "board free" until a push.
      });

    return () => {
      isActive = false;
      setIsLive(false);
      unsubscribe();
    };
  }, [boardId, client]);

  const reportClimbWithUndoTarget = useCallback(
    async (climb: ClimbQueueItemInput, angle: number | null): Promise<BoardPresenceReportResult> => {
      const activeBoardId = boardIdRef.current;
      const activeClient = clientRef.current;
      if (activeBoardId === null || activeClient === null) {
        return { accepted: false, undoTarget: null };
      }

      const capturedUndoTarget = currentClimbRef.current;
      const accepted = await activeClient.reportClimb(activeBoardId, climb, angle);
      if (!accepted) {
        return { accepted: false, undoTarget: null };
      }

      undoTargetRef.current = capturedUndoTarget;
      setUndoTarget(capturedUndoTarget);
      return { accepted: true, undoTarget: capturedUndoTarget };
    },
    [],
  );

  const reportClimb = useCallback(
    async (climb: ClimbQueueItemInput, angle: number | null): Promise<boolean> => {
      const result = await reportClimbWithUndoTarget(climb, angle);
      return result.accepted;
    },
    [reportClimbWithUndoTarget],
  );

  const getUndoTarget = useCallback((): BoardPresenceClimb | null => undoTargetRef.current, []);

  const reportDisconnect = useCallback(async (): Promise<boolean> => {
    const activeBoardId = boardIdRef.current;
    const activeClient = clientRef.current;
    if (activeBoardId === null || activeClient?.reportDisconnect == null) {
      return false;
    }
    return activeClient.reportDisconnect(activeBoardId);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    const activeBoardId = boardIdRef.current;
    const activeClient = clientRef.current;
    if (activeBoardId === null || activeClient === null || isRefreshingRef.current) {
      return;
    }
    isRefreshingRef.current = true;
    setIsRefreshing(true);
    try {
      // Ignore a late result if the board was switched out mid-flight.
      await applyBoardPresenceCatchUp(
        activeClient,
        activeBoardId,
        dispatch,
        observedSeqRef,
        () => boardIdRef.current === activeBoardId,
      );
    } finally {
      // Only clear the flags if still mounted and on the board this refresh was
      // for — a board switch already reset them and may have started a fresh one.
      if (mountedRef.current && boardIdRef.current === activeBoardId) {
        isRefreshingRef.current = false;
        setIsRefreshing(false);
      }
    }
  }, []);

  return useMemo<UseBoardPresenceResult>(
    () => ({
      currentClimb: state.currentClimb,
      previousClimb: state.previousClimb,
      undoTarget,
      holder: state.holder,
      history: state.history,
      stats: state.stats,
      isHydrating,
      isRefreshing,
      isLive,
      reportClimb,
      reportClimbWithUndoTarget,
      reportDisconnect,
      getUndoTarget,
      refresh,
    }),
    [
      state.currentClimb,
      state.previousClimb,
      undoTarget,
      state.holder,
      state.history,
      state.stats,
      isHydrating,
      isRefreshing,
      isLive,
      reportClimb,
      reportClimbWithUndoTarget,
      reportDisconnect,
      getUndoTarget,
      refresh,
    ],
  );
}
