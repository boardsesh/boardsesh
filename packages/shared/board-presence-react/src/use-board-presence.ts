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

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  boardPresenceReducer,
  initialBoardPresenceState,
  mapBoardPresenceEnvelopeToAction,
  type BoardPresenceState,
} from '@boardsesh/board-presence';
import type {
  BoardConnectionHolder,
  BoardLayersSnapshot,
  BoardPresenceClimb,
  BoardPresenceEvent,
  BoardPresenceStats,
  ClimbQueueItemInput,
  ReportBoardLayer,
} from '@boardsesh/shared-schema';
import type { BoardPresenceClient } from './types';

// Three missed 10-second controller reports make the occupancy roster unsafe
// to use. This mirrors the backend grace window, but runs client-side so an
// already-subscribed app fails open even when no expiry event can be published.
const BOARD_LAYERS_HEARTBEAT_GRACE_MS = 30_000;
type BoardPresenceTimerHost = {
  setTimeout: (callback: () => void, delayMs: number) => unknown;
  clearTimeout: (timer: unknown) => void;
};
const boardPresenceTimerHost = globalThis as unknown as BoardPresenceTimerHost;

/**
 * Why a catch-up (re-fetch of recent climbs + stats + connection) ran. Live
 * events ride Redis pub/sub, which has no replay — so anything published while
 * this client's socket was mid-reconnect is gone, and the durable Redis history
 * list is the only recovery source. These are the four triggers that pull it:
 * - `gap`: a live event arrived with a seq jump (we already missed something).
 * - `reconnect`: the WebSocket reconnected (events in the gap window are lost).
 * - `foreground`: the app returned to the foreground (socket may have been
 *   suspended by the OS without a clean reconnect).
 * - `manual`: an explicit user refresh (pull-to-refresh).
 */
export type BoardPresenceCatchUpReason = 'gap' | 'reconnect' | 'foreground' | 'manual';

/** Telemetry payload emitted after a catch-up completes. */
export type BoardPresenceCatchUpInfo = {
  reason: BoardPresenceCatchUpReason;
  /**
   * How far the catch-up advanced the observed seq beyond what we'd seen when
   * it started — a proxy for the number of live events that had been silently
   * missed and were just recovered. `0` means the catch-up found nothing new.
   */
  recoveredThroughSeqDelta: number;
};

export type UseBoardPresenceResult = {
  currentClimb: BoardPresenceCurrentState['currentClimb'];
  previousClimb: BoardPresenceCurrentState['previousClimb'];
  undoTarget: BoardPresenceCurrentState['undoTarget'];
  holder: BoardPresenceCurrentState['holder'];
  layers: BoardPresenceState['layers'];
  history: BoardPresenceFeedState['history'];
  stats: BoardPresenceFeedState['stats'];
  isLive: BoardPresenceCurrentState['isLive'];
  reportClimb: BoardPresenceActions['reportClimb'];
  reportClimbWithUndoTarget: BoardPresenceActions['reportClimbWithUndoTarget'];
  reportDisconnect: BoardPresenceActions['reportDisconnect'];
  reportLayers: BoardPresenceActions['reportLayers'];
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
  /** Publish a controller-confirmed roster after an explicit readback. */
  reportLayers: (layers: readonly ReportBoardLayer[]) => Promise<BoardLayersSnapshot | null>;
  /** Latest captured undo target for action-only consumers that need a ref-like read. */
  getUndoTarget: () => BoardPresenceClimb | null;
  /**
   * Force a catch-up: re-fetch recent climbs + stats + connection from the
   * durable Redis-backed source and merge them in (deduped by seq). Use for
   * pull-to-refresh (`manual`) and app-foreground recovery (`foreground`). A
   * no-op while inert; coalesced with any in-flight catch-up.
   */
  refresh: (reason?: BoardPresenceCatchUpReason) => void;
};

function boardPresenceEventSeq(event: BoardPresenceEvent): number | null {
  switch (event.__typename) {
    case 'BoardClimbSet':
      return event.climb.seq;
    case 'BoardClimbCleared':
    case 'BoardStatsUpdated':
    case 'BoardConnectionChanged':
      return event.seq;
    case 'BoardLayersChanged':
      return event.snapshot.seq;
    default:
      return null;
  }
}

function highestClimbSeq(climbs: BoardPresenceClimb[]): number {
  return climbs.reduce((highestSeq, climb) => Math.max(highestSeq, climb.seq), 0);
}

export function useBoardPresence(
  boardId: number | null,
  client: BoardPresenceClient | null,
  onCatchUp?: (info: BoardPresenceCatchUpInfo) => void,
): UseBoardPresenceResult {
  const [state, dispatch] = useReducer(boardPresenceReducer, initialBoardPresenceState);
  const [isLive, setIsLive] = useState(false);
  const [undoTarget, setUndoTarget] = useState<BoardPresenceClimb | null>(null);

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
  const observedLayersSeqRef = useRef(0);
  // Keep the telemetry callback in a ref so it can change without forcing the
  // subscription effect (keyed on [boardId, client]) to tear down and re-attach.
  const onCatchUpRef = useRef(onCatchUp);
  onCatchUpRef.current = onCatchUp;
  // Points at the active effect-run's `runCatchUp`, so the stable `refresh()`
  // action and the AppState/reconnect triggers can invoke it without being
  // listed in the effect deps. Null while inert.
  const catchUpRef = useRef<((reason: BoardPresenceCatchUpReason) => void) | null>(null);

  useEffect(() => {
    // No board or no transport: collapse to the initial state and stay inert.
    // RESET clears stats too (they live in the reducer now).
    if (boardId === null || client === null) {
      dispatch({ type: 'RESET' });
      setIsLive(false);
      setUndoTarget(null);
      observedSeqRef.current = 0;
      observedLayersSeqRef.current = 0;
      catchUpRef.current = null;
      return;
    }

    // Reset for the board we're about to attach to, so the prior board's
    // history/current/stats never bleed into this one.
    dispatch({ type: 'RESET' });
    setUndoTarget(null);
    observedSeqRef.current = 0;
    observedLayersSeqRef.current = 0;

    let isActive = true;
    let catchUpInFlight = false;
    let catchUpRequested = false;
    // Reason for a catch-up requested while another was already in flight; the
    // coalesced follow-up run reports the most recent trigger.
    let catchUpRequestedReason: BoardPresenceCatchUpReason = 'gap';
    // Once a baseline exists, a live gap may trigger catch-up even while the
    // initial backfill is still resolving. That overlap is safe: both paths
    // merge through BACKFILL_HISTORY, which dedups by (climbUuid, seq).
    let hasSequenceBaseline = false;
    // Identifies this effect run; late async results for a superseded board are
    // ignored by comparing against the ref, which the cleanup flips off.
    const subscribedBoardId = boardId;

    const runCatchUp = (reason: BoardPresenceCatchUpReason) => {
      if (!isActive || boardIdRef.current !== subscribedBoardId) {
        return;
      }
      if (catchUpInFlight) {
        catchUpRequested = true;
        catchUpRequestedReason = reason;
        return;
      }

      catchUpInFlight = true;
      const startedAtSeq = observedSeqRef.current;
      const startedAtLayersSeq = observedLayersSeqRef.current;
      const connectionFetch = client.fetchConnection;
      const connectionPromise =
        connectionFetch === undefined
          ? Promise.resolve<BoardConnectionHolder | null | undefined>(undefined)
          : connectionFetch(boardId);
      const layersFetch = client.fetchLayers;
      const layersPromise =
        layersFetch === undefined
          ? Promise.resolve<BoardLayersSnapshot | null | undefined>(undefined)
          : layersFetch(boardId);

      void Promise.allSettled([
        client.fetchRecentClimbs(boardId),
        client.fetchStats(boardId),
        connectionPromise,
        layersPromise,
      ] as const)
        .then(([recentResult, statsResult, connectionResult, layersResult]) => {
          if (!isActive || boardIdRef.current !== subscribedBoardId) {
            return;
          }

          let repairedThroughSeq = startedAtSeq;
          if (recentResult.status === 'fulfilled') {
            const recentClimbs = recentResult.value;
            repairedThroughSeq = Math.max(repairedThroughSeq, highestClimbSeq(recentClimbs));
            observedSeqRef.current = Math.max(observedSeqRef.current, repairedThroughSeq);
            dispatch({ type: 'BACKFILL_HISTORY', payload: recentClimbs });
          }

          if (layersFetch !== undefined && layersResult.status === 'fulfilled') {
            const fetchedSnapshot = layersResult.value ?? null;
            // A fetch has no trustworthy relative age: observedAt is a server
            // wall-clock timestamp and the device clock may be skewed. Keep
            // occupancy fail-open until a live controller heartbeat arrives.
            const snapshot = fetchedSnapshot?.stale
              ? fetchedSnapshot
              : fetchedSnapshot && { ...fetchedSnapshot, stale: true };
            if (snapshot !== null) {
              repairedThroughSeq = Math.max(repairedThroughSeq, snapshot.seq);
              observedSeqRef.current = Math.max(observedSeqRef.current, snapshot.seq);
              observedLayersSeqRef.current = Math.max(observedLayersSeqRef.current, snapshot.seq);
            }
            // A null fetch may clear only the layer state that existed when
            // this catch-up began. A live layer event received while the fetch
            // was in flight wins, just like a newer non-null snapshot does in
            // the reducer's sequence check.
            if (snapshot !== null || observedLayersSeqRef.current === startedAtLayersSeq) {
              dispatch({
                type: 'REFRESH_LAYERS',
                payload: { snapshot, upToSeq: snapshot?.seq ?? startedAtLayersSeq },
              });
            }
          }

          if (statsResult.status === 'fulfilled') {
            dispatch({
              type: 'REFRESH_STATS',
              payload: { stats: statsResult.value, upToSeq: repairedThroughSeq },
            });
          }

          if (connectionFetch !== undefined && connectionResult.status === 'fulfilled') {
            dispatch({
              type: 'REFRESH_CONNECTION',
              payload: { holder: connectionResult.value ?? null, upToSeq: repairedThroughSeq },
            });
          }

          // Emit telemetry: how far this catch-up advanced past what we'd seen
          // when it started ≈ the live events that had been silently dropped and
          // were just recovered. Drop the first backfill's apparent "gap" from a
          // zero baseline — that's the normal cold-start seed, not a recovery.
          const recoveredThroughSeqDelta = startedAtSeq > 0 ? Math.max(0, repairedThroughSeq - startedAtSeq) : 0;
          onCatchUpRef.current?.({ reason, recoveredThroughSeqDelta });
        })
        .finally(() => {
          if (!isActive) {
            return;
          }
          catchUpInFlight = false;
          if (catchUpRequested) {
            catchUpRequested = false;
            runCatchUp(catchUpRequestedReason);
          }
        });
    };
    catchUpRef.current = runCatchUp;

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
            runCatchUp('gap');
          }
          hasSequenceBaseline = true;
        }
        if (event.__typename === 'BoardLayersChanged') {
          observedLayersSeqRef.current = Math.max(observedLayersSeqRef.current, event.snapshot.seq);
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

    // 1b) Catch up on every reconnect. graphql-ws transparently re-subscribes
    //     after a dropped socket, but the live feed rides Redis pub/sub (no
    //     replay), so any climb pushed during the gap window is lost for this
    //     client and the seq-gap detector above only fires if a *later* event
    //     happens to arrive. Proactively re-read the durable Redis history on
    //     reconnect so a just-missed send shows up without waiting for the next
    //     one. Optional on the client (web omits it); returns an unsubscribe.
    const unsubscribeReconnect = client.onReconnect?.(() => runCatchUp('reconnect'));

    // 2) Backfill recent history, then 3) seed stats. Both guarded against
    //    unmount and against a board switch (a late resolve for the previous
    //    board must not write into the new board's state). The stats fetch is
    //    only the initial SEED — from here on, every tick on this wall pushes a
    //    fresh `BoardStatsUpdated` over the subscription above (handled by the
    //    reducer), so the tiles update live without re-fetching. SEED_STATS is a
    //    no-op once any live push has landed, so it can't clobber fresher data.
    void client
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

    void client
      .fetchStats(boardId)
      .then((nextStats) => {
        if (isActive && boardIdRef.current === subscribedBoardId) {
          dispatch({ type: 'SEED_STATS', payload: nextStats });
        }
      })
      .catch(() => {
        // Stats are best-effort; absence renders as "no stats yet".
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

    void client
      .fetchLayers?.(boardId)
      .then((snapshot) => {
        if (isActive && boardIdRef.current === subscribedBoardId) {
          observedSeqRef.current = Math.max(observedSeqRef.current, snapshot?.seq ?? 0);
          observedLayersSeqRef.current = Math.max(observedLayersSeqRef.current, snapshot?.seq ?? 0);
          dispatch({
            type: 'SEED_LAYERS',
            payload: snapshot?.stale ? snapshot : snapshot && { ...snapshot, stale: true },
          });
        }
      })
      .catch(() => {
        // Layer seed is best-effort; the live stream still supplies readbacks.
      });

    return () => {
      isActive = false;
      setIsLive(false);
      catchUpRef.current = null;
      unsubscribeReconnect?.();
      unsubscribe();
    };
  }, [boardId, client]);

  useEffect(() => {
    const layers = state.layers;
    if (layers === null || layers.stale) return;

    const timer = boardPresenceTimerHost.setTimeout(() => {
      dispatch({ type: 'MARK_LAYERS_STALE', payload: { boardId: layers.boardId, seq: layers.seq } });
    }, BOARD_LAYERS_HEARTBEAT_GRACE_MS);

    return () => boardPresenceTimerHost.clearTimeout(timer);
  }, [state.layers]);

  // Stable manual catch-up trigger. Defaults to `manual` (pull-to-refresh);
  // callers pass `foreground` for app-resume recovery. Reads the live
  // `catchUpRef` so it never re-binds the subscription effect.
  const refresh = useCallback((reason: BoardPresenceCatchUpReason = 'manual') => {
    catchUpRef.current?.(reason);
  }, []);

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

  const reportLayers = useCallback(async (layers: readonly ReportBoardLayer[]): Promise<BoardLayersSnapshot | null> => {
    const activeBoardId = boardIdRef.current;
    const activeClient = clientRef.current;
    if (activeBoardId === null || activeClient?.reportLayers == null) return null;
    return activeClient.reportLayers(activeBoardId, layers);
  }, []);

  return useMemo<UseBoardPresenceResult>(
    () => ({
      currentClimb: state.currentClimb,
      previousClimb: state.previousClimb,
      undoTarget,
      holder: state.holder,
      layers: state.layers,
      history: state.history,
      stats: state.stats,
      isLive,
      reportClimb,
      reportClimbWithUndoTarget,
      reportDisconnect,
      reportLayers,
      getUndoTarget,
      refresh,
    }),
    [
      state.currentClimb,
      state.previousClimb,
      undoTarget,
      state.holder,
      state.layers,
      state.history,
      state.stats,
      isLive,
      reportClimb,
      reportClimbWithUndoTarget,
      reportDisconnect,
      reportLayers,
      getUndoTarget,
      refresh,
    ],
  );
}
