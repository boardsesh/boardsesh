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
  selectClearedClimbUuid,
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

/**
 * Whether a board-read error is the server's denial (`NOT_FOUND`, the mask every
 * board gate throws) rather than a transport failure. Reads both shapes a
 * transport can deliver: a `GraphQLOperationError`-like object carrying
 * `graphqlErrors`/`extensions`, and a raw `GraphQLError[]` array.
 */
export function isBoardReadDenied(error: unknown): boolean {
  const isNotFound = (candidate: unknown): boolean =>
    typeof candidate === 'object' &&
    candidate !== null &&
    (candidate as { extensions?: { code?: unknown } | null }).extensions?.code === 'NOT_FOUND';
  if (Array.isArray(error)) return error.some(isNotFound);
  if (typeof error !== 'object' || error === null) return false;
  const graphqlErrors = (error as { graphqlErrors?: unknown }).graphqlErrors;
  return isNotFound(error) || (Array.isArray(graphqlErrors) && graphqlErrors.some(isNotFound));
}

export type UseBoardPresenceResult = {
  currentClimb: BoardPresenceCurrentState['currentClimb'];
  previousClimb: BoardPresenceCurrentState['previousClimb'];
  undoTarget: BoardPresenceCurrentState['undoTarget'];
  holder: BoardPresenceCurrentState['holder'];
  lastConnectionSeq: BoardPresenceCurrentState['lastConnectionSeq'];
  clearedClimbUuid: BoardPresenceCurrentState['clearedClimbUuid'];
  history: BoardPresenceFeedState['history'];
  stats: BoardPresenceFeedState['stats'];
  isLive: BoardPresenceCurrentState['isLive'];
  /**
   * True once the server refused this reader (a `NOT_FOUND` read, or the live
   * stream ended by its access recheck). The loaded wall is cleared and stays
   * retired until the board, held link or client changes. A transport failure
   * never sets it: that only turns `isLive` off.
   */
  isDenied: boolean;
  reportClimb: BoardPresenceActions['reportClimb'];
  reportClimbWithUndoTarget: BoardPresenceActions['reportClimbWithUndoTarget'];
  reportDisconnect: BoardPresenceActions['reportDisconnect'];
  reportClear: BoardPresenceActions['reportClear'];
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
  /** Sequence of the latest holder event; initial backfill keeps this at zero. */
  lastConnectionSeq: number;
  /**
   * The climb a "Turn off all lights" left dark, while nothing has been lit
   * since (#7015); `null` otherwise. Compare it with the climb on screen, never
   * read it as "the wall is dark": a peer's queue moves before the presence
   * echo, and its new climb must not read as turned off.
   */
  clearedClimbUuid: string | null;
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
  /**
   * Tell every viewer this client turned off all the wall's lights (#7015).
   * Resolves `false` when inert, when another emitter holds the board, or when
   * the injected client does not implement `reportClear`.
   */
  reportClear: () => Promise<boolean>;
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
    case 'BoardHistoryUpdated':
      return event.seq;
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
  boardUuid: string | null = null,
): UseBoardPresenceResult {
  const [state, dispatch] = useReducer(boardPresenceReducer, initialBoardPresenceState);
  const [isLive, setIsLive] = useState(false);
  const [isDenied, setIsDenied] = useState(false);
  const [undoTarget, setUndoTarget] = useState<BoardPresenceClimb | null>(null);
  const [snapshotScope, setSnapshotScope] = useState({ boardId, boardUuid, client });
  const scopeMatches =
    snapshotScope.boardId === boardId && snapshotScope.boardUuid === boardUuid && snapshotScope.client === client;
  const visibleState = scopeMatches ? state : initialBoardPresenceState;
  const visibleUndoTarget = scopeMatches ? undoTarget : null;
  const visibleIsLive = scopeMatches && isLive;
  const visibleIsDenied = scopeMatches && isDenied;

  // Live refs so the action callbacks stay identity-stable while still reading
  // the current board, client, and restore target.
  const boardIdRef = useRef(boardId);
  boardIdRef.current = boardId;
  const boardUuidRef = useRef(boardUuid);
  boardUuidRef.current = boardUuid;
  const clientRef = useRef(client);
  clientRef.current = client;
  const actionScopeRef = useRef({ boardId, boardUuid, client });
  if (
    actionScopeRef.current.boardId !== boardId ||
    actionScopeRef.current.boardUuid !== boardUuid ||
    actionScopeRef.current.client !== client
  ) {
    actionScopeRef.current = { boardId, boardUuid, client };
  }
  const currentClimbRef = useRef<BoardPresenceClimb | null>(visibleState.currentClimb);
  currentClimbRef.current = visibleState.currentClimb;
  const undoTargetRef = useRef<BoardPresenceClimb | null>(visibleUndoTarget);
  undoTargetRef.current = visibleUndoTarget;
  const observedSeqRef = useRef(0);
  // Keep the telemetry callback in a ref so it can change without forcing the
  // subscription effect (keyed on [boardId, client]) to tear down and re-attach.
  const onCatchUpRef = useRef(onCatchUp);
  onCatchUpRef.current = onCatchUp;
  // Points at the active effect-run's `runCatchUp`, so the stable `refresh()`
  // action and the AppState/reconnect triggers can invoke it without being
  // listed in the effect deps. Null while inert.
  const catchUpRef = useRef<((reason: BoardPresenceCatchUpReason) => void) | null>(null);

  useEffect(() => {
    setSnapshotScope({ boardId, boardUuid, client });
    // No board or no transport: collapse to the initial state and stay inert.
    // RESET clears stats too (they live in the reducer now).
    setIsDenied(false);
    if (boardId === null || client === null) {
      dispatch({ type: 'RESET' });
      setIsLive(false);
      setUndoTarget(null);
      observedSeqRef.current = 0;
      catchUpRef.current = null;
      return;
    }

    // Reset for the board we're about to attach to, so the prior board's
    // history/current/stats never bleed into this one.
    dispatch({ type: 'RESET' });
    setUndoTarget(null);
    observedSeqRef.current = 0;

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
    const capabilityArgs: [] | [string] = boardUuid ? [boardUuid] : [];
    const isCurrent = () =>
      isActive &&
      boardIdRef.current === subscribedBoardId &&
      boardUuidRef.current === boardUuid &&
      clientRef.current === client;

    const retireReader = () => {
      if (!isCurrent()) return;
      isActive = false;
      catchUpRef.current = null;
      observedSeqRef.current = 0;
      dispatch({ type: 'RESET' });
      setUndoTarget(null);
      setIsLive(false);
      setIsDenied(true);
    };
    // Set by a stream error that was not a denial, so the completion graphql-ws
    // delivers after an error result is not read as the server ending the stream.
    let streamFailed = false;
    const onStreamError = (error: unknown) => {
      if (!isCurrent()) return;
      if (isBoardReadDenied(error)) {
        retireReader();
        return;
      }
      // A transport failure (including graphql-ws giving up reconnecting) or a
      // non-denial server error: keep the loaded wall, refresh and catch-ups,
      // and only drop the live flag.
      streamFailed = true;
      setIsLive(false);
    };
    const onStreamComplete = () => {
      if (!isCurrent()) return;
      if (streamFailed) {
        setIsLive(false);
        return;
      }
      // The server ended the stream without an error: its per-event access
      // recheck no longer admits this reader.
      retireReader();
    };

    const runCatchUp = (reason: BoardPresenceCatchUpReason) => {
      if (!isCurrent()) {
        return;
      }
      if (catchUpInFlight) {
        catchUpRequested = true;
        catchUpRequestedReason = reason;
        return;
      }

      catchUpInFlight = true;
      const startedAtSeq = observedSeqRef.current;
      const connectionFetch = client.fetchConnection?.bind(client);
      const connectionPromise =
        connectionFetch === undefined
          ? Promise.resolve<BoardConnectionHolder | null | undefined>(undefined)
          : connectionFetch(boardId, ...capabilityArgs);

      void Promise.allSettled([
        client.fetchRecentClimbs(boardId, ...capabilityArgs),
        client.fetchStats(boardId, ...capabilityArgs),
        connectionPromise,
        client.fetchRecentHistory?.(boardId, ...capabilityArgs) ?? Promise.resolve([]),
      ] as const)
        .then(([recentResult, statsResult, connectionResult, historyResult]) => {
          if (!isCurrent()) {
            return;
          }

          let repairedThroughSeq = startedAtSeq;
          if (historyResult.status === 'fulfilled') {
            dispatch({ type: 'MERGE_HISTORY', payload: historyResult.value });
            observedSeqRef.current = Math.max(observedSeqRef.current, highestClimbSeq(historyResult.value));
          }
          if (recentResult.status === 'fulfilled') {
            const recentClimbs = recentResult.value;
            repairedThroughSeq = Math.max(repairedThroughSeq, highestClimbSeq(recentClimbs));
            observedSeqRef.current = Math.max(observedSeqRef.current, repairedThroughSeq);
            dispatch({ type: 'BACKFILL_HISTORY', payload: recentClimbs });
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
          if (!isCurrent()) {
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
        if (!isCurrent()) {
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
        const action = mapBoardPresenceEnvelopeToAction(event);
        if (action) {
          dispatch(action);
        }
      },
      onStreamError,
      onStreamComplete,
      ...capabilityArgs,
    );
    setIsLive(isCurrent());
    if (!isCurrent()) return unsubscribe;

    // 1b) Catch up on every reconnect. graphql-ws transparently re-subscribes
    //     after a dropped socket, but the live feed rides Redis pub/sub (no
    //     replay), so any climb pushed during the gap window is lost for this
    //     client and the seq-gap detector above only fires if a *later* event
    //     happens to arrive. Proactively re-read the durable Redis history on
    //     reconnect so a just-missed send shows up without waiting for the next
    //     one. Optional on the client (web omits it); returns an unsubscribe.
    const unsubscribeReconnect = client.onReconnect?.(() => runCatchUp('reconnect'));

    void client
      .fetchRecentHistory?.(boardId, ...capabilityArgs)
      .then((history) => {
        if (isCurrent()) {
          dispatch({ type: 'MERGE_HISTORY', payload: history });
          observedSeqRef.current = Math.max(observedSeqRef.current, highestClimbSeq(history));
        }
      })
      .catch(() => {
        /* Native wall state and durable paging remain available. */
      });

    // 2) Backfill recent history, then 3) seed stats. Both guarded against
    //    unmount and against a board switch (a late resolve for the previous
    //    board must not write into the new board's state). The stats fetch is
    //    only the initial SEED — from here on, every tick on this wall pushes a
    //    fresh `BoardStatsUpdated` over the subscription above (handled by the
    //    reducer), so the tiles update live without re-fetching. SEED_STATS is a
    //    no-op once any live push has landed, so it can't clobber fresher data.
    void client
      .fetchRecentClimbs(boardId, ...capabilityArgs)
      .then((recentClimbs) => {
        if (isCurrent()) {
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
      .fetchStats(boardId, ...capabilityArgs)
      .then((nextStats) => {
        if (isCurrent()) {
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
      .fetchConnection?.(boardId, ...capabilityArgs)
      .then((holder) => {
        if (isCurrent()) {
          dispatch({ type: 'SEED_CONNECTION', payload: holder });
        }
      })
      .catch(() => {
        // Holder seed is best-effort; absence renders as "board free" until a push.
      });

    return () => {
      isActive = false;
      setIsLive(false);
      catchUpRef.current = null;
      unsubscribeReconnect?.();
      unsubscribe();
    };
  }, [boardId, boardUuid, client]);

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
      const requestScope = actionScopeRef.current;
      if (activeBoardId === null || activeClient === null) {
        return { accepted: false, undoTarget: null };
      }

      const capturedUndoTarget = currentClimbRef.current;
      const accepted = await activeClient.reportClimb(activeBoardId, climb, angle);
      if (
        !accepted ||
        boardIdRef.current !== activeBoardId ||
        actionScopeRef.current !== requestScope ||
        clientRef.current !== activeClient
      ) {
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

  const reportClear = useCallback(async (): Promise<boolean> => {
    const activeBoardId = boardIdRef.current;
    const activeClient = clientRef.current;
    if (activeBoardId === null || activeClient?.reportClear == null) {
      return false;
    }
    return activeClient.reportClear(activeBoardId);
  }, []);

  const clearedClimbUuid = selectClearedClimbUuid(visibleState);

  return useMemo<UseBoardPresenceResult>(
    () => ({
      currentClimb: visibleState.currentClimb,
      previousClimb: visibleState.previousClimb,
      undoTarget: visibleUndoTarget,
      holder: visibleState.holder,
      lastConnectionSeq: visibleState.lastConnectionSeq,
      clearedClimbUuid,
      history: visibleState.history,
      stats: visibleState.stats,
      isLive: visibleIsLive,
      isDenied: visibleIsDenied,
      reportClimb,
      reportClimbWithUndoTarget,
      reportDisconnect,
      reportClear,
      getUndoTarget,
      refresh,
    }),
    [
      visibleState.currentClimb,
      visibleState.previousClimb,
      visibleUndoTarget,
      visibleState.holder,
      visibleState.lastConnectionSeq,
      clearedClimbUuid,
      visibleState.history,
      visibleState.stats,
      visibleIsLive,
      visibleIsDenied,
      reportClimb,
      reportClimbWithUndoTarget,
      reportDisconnect,
      reportClear,
      getUndoTarget,
      refresh,
    ],
  );
}
