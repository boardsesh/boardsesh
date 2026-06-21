// MobileBoardPresenceProvider — wires the renderer-agnostic
// `@boardsesh/board-presence-react` into the mobile app.
//
// It owns two things:
//   1. The connected `boardId` (resolved from the BLE serial on connect). This
//      is the channel key the wall feed is keyed on.
//   2. A mobile `BoardPresenceClient` (graphql-ws transport) handed to the
//      shared `BoardPresenceProvider`, which runs `useBoardPresence(boardId)`
//      (subscribe + backfill + reducer) and exposes the wall's now-playing
//      state via the split board-presence contexts.
//
// Board presence is always-on (the `board-presence` flag was removed when the
// feature went GA). `enabled` now just reports whether this provider is mounted:
// it is `true` inside the provider and `false` only for the outside-provider
// fallback (DISABLED_CONTROLS), so BLE-flow callers that may render before the
// provider mounts still degrade safely.
//
// The bluetooth provider (mounted inside this one) calls
// `useBoardPresenceControls()` to (a) resolve+store the boardId on connect and
// (b) report a freshly-lit climb on wall-confirm. Reads of the wall's current
// climb go through `@boardsesh/board-presence-react`'s split contexts.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import {
  BoardPresenceProvider,
  useBoardPresenceActions,
  type BoardPresenceCatchUpInfo,
} from '@boardsesh/board-presence-react';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import type { BoardCandidate, ClimbQueueItemInput, ResolvedBoard } from '@boardsesh/shared-schema';
import {
  createMobileBoardPresenceClient,
  type MobileBoardPresenceClient,
} from '../lib/board-presence/board-presence-client';
import { getWsClient } from '../lib/graphql/ws-client';
import { track } from '../lib/analytics';
import { BoardDisambiguationSheet } from '../components/board-discovery/BoardDisambiguationSheet';

/** Board config needed to find-or-bind the shared board on first sighting. */
export type ResolveBoardArgs = {
  serial: string;
  boardType: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
};

export type ResolveBoardConfigArgs = Omit<ResolveBoardArgs, 'serial'>;

export type ResolveBoardUuidArgs = {
  boardUuid: string;
};

function boardConfigResolveKey({ boardType, layoutId, sizeId, setIds }: ResolveBoardConfigArgs): string {
  return `${boardType}:${layoutId}:${sizeId}:${setIds}`;
}

type BoardPresenceControlsValue = {
  /** True when the provider is mounted (always-on); false only for the
   * outside-provider fallback. */
  enabled: boolean;
  /** The board currently bound to the connected serial, or null when none. */
  boardId: number | null;
  /**
   * Resolve (and bind) the shared board for a just-connected serial, then store
   * its boardId so the wall feed subscribes. No-op (resolves null) when no
   * transport/client is available (e.g. the outside-provider fallback).
   * Idempotent for an unchanged serial.
   */
  resolveAndBindBoard: (args: ResolveBoardArgs) => Promise<ResolvedBoard | null>;
  /**
   * Resolve a board by config when no serial is available, then store its
   * boardId. No-op when the active transport does not support config fallback.
   */
  resolveAndBindBoardByConfig: (args: ResolveBoardConfigArgs) => Promise<ResolvedBoard | null>;
  /**
   * Resolve a selected named board by UUID, then store its boardId. This is the
   * preferred non-BLE path for board sheet stats/history.
   */
  resolveAndBindBoardByUuid: (args: ResolveBoardUuidArgs) => Promise<ResolvedBoard | null>;
  /**
   * Report directly to a specific board id. Used immediately after a connect
   * resolve when the React boardId context has not re-rendered yet.
   */
  reportClimbForBoard: (boardId: number, climb: ClimbQueueItemInput, angle: number | null) => Promise<boolean>;
  /**
   * Tell the backend this client released its board hold (explicit lightbulb-off
   * or a detected BLE drop) so the "who's connected" indicator frees. No-op when
   * someone else already took over (atomic compare-and-delete server-side).
   * Resolves false when no transport is available.
   */
  reportDisconnectForBoard: (boardId: number) => Promise<boolean>;
  /** Clear the current board binding and force the shared presence hook inert. */
  resetPresence: () => void;
};

const BoardPresenceControlsContext = createContext<BoardPresenceControlsValue | null>(null);

export function MobileBoardPresenceProvider({ children }: { children: ReactNode }) {
  // Always-on: presence shipped GA, so the provider is never inert. `enabled` is
  // kept (constant true here) so consumers and the outside-provider fallback can
  // still branch on provider availability.
  const enabled = true;
  const [boardId, setBoardId] = useState<number | null>(null);
  // When a serial maps to several boards the user must pick which wall they're
  // at. We hold the candidates + serial here and surface a picker; binding waits
  // for the choice.
  const [pendingDisambiguation, setPendingDisambiguation] = useState<{
    serial: string;
    candidates: BoardCandidate[];
  } | null>(null);

  // The injected transport, built once. Presence is always-on, so the shared
  // hook always has a client to attach its subscription to.
  const client = useMemo<MobileBoardPresenceClient | null>(() => createMobileBoardPresenceClient(getWsClient), []);
  const clientRef = useRef(client);
  clientRef.current = client;

  // The serial last resolved, so a reconnect to the same wall doesn't re-resolve.
  const lastResolvedSerialRef = useRef<string | null>(null);
  const lastResolvedConfigKeyRef = useRef<string | null>(null);
  const lastResolvedBoardUuidRef = useRef<string | null>(null);
  const resolveGenerationRef = useRef(0);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  // Mirror boardId into a ref so the empty-dep callback can read it without
  // re-resolving an already-bound serial.
  const boardIdRef = useRef(boardId);
  boardIdRef.current = boardId;
  // Mirror the pending disambiguation so the empty-dep `chooseBoard` callback
  // reads the serial it must confirm against.
  const pendingDisambiguationRef = useRef(pendingDisambiguation);
  pendingDisambiguationRef.current = pendingDisambiguation;

  const resetPresence = useCallback(() => {
    lastResolvedSerialRef.current = null;
    lastResolvedConfigKeyRef.current = null;
    lastResolvedBoardUuidRef.current = null;
    resolveGenerationRef.current += 1;
    setPendingDisambiguation(null);
    setBoardId(null);
  }, []);

  const resolveAndBindBoard = useCallback(async (args: ResolveBoardArgs): Promise<ResolvedBoard | null> => {
    const activeClient = clientRef.current;
    if (!enabledRef.current || activeClient === null) {
      return null;
    }
    if (lastResolvedSerialRef.current === args.serial && boardIdRef.current !== null) {
      return null;
    }
    const resolveGeneration = resolveGenerationRef.current + 1;
    resolveGenerationRef.current = resolveGeneration;
    lastResolvedConfigKeyRef.current = null;
    lastResolvedBoardUuidRef.current = null;
    lastResolvedSerialRef.current = args.serial;
    setBoardId(null);
    try {
      const result = await activeClient.resolveBoardCandidatesForSerial(args);
      if (resolveGenerationRef.current !== resolveGeneration) {
        return null;
      }
      if (result.board) {
        setPendingDisambiguation(null);
        setBoardId(result.board.boardId);
        return result.board;
      }
      if (result.candidates && result.candidates.length > 0) {
        // Several boards share this serial — ask the user which wall they're at.
        // Binding waits for `chooseBoard`; leave boardId null so the wall feed
        // stays inert until then.
        setPendingDisambiguation({ serial: args.serial, candidates: result.candidates });
        // Allow a later reconnect to re-prompt if they dismiss without picking.
        lastResolvedSerialRef.current = null;
        return null;
      }
      return null;
    } catch (error) {
      if (resolveGenerationRef.current === resolveGeneration) {
        lastResolvedSerialRef.current = null;
      }
      console.warn('[board-presence] resolveBoardCandidatesForSerial failed', error);
      return null;
    }
  }, []);

  const resolveAndBindBoardByUuid = useCallback(async (args: ResolveBoardUuidArgs): Promise<ResolvedBoard | null> => {
    const activeClient = clientRef.current;
    if (!enabledRef.current || activeClient === null || !activeClient.resolveBoardForUuid) {
      return null;
    }
    if (lastResolvedBoardUuidRef.current === args.boardUuid) {
      return null;
    }
    const resolveGeneration = resolveGenerationRef.current + 1;
    resolveGenerationRef.current = resolveGeneration;
    lastResolvedBoardUuidRef.current = args.boardUuid;
    lastResolvedConfigKeyRef.current = null;
    lastResolvedSerialRef.current = null;
    setBoardId(null);
    try {
      const resolved = await activeClient.resolveBoardForUuid(args);
      if (resolveGenerationRef.current !== resolveGeneration) {
        return null;
      }
      setBoardId(resolved.boardId);
      return resolved;
    } catch (error) {
      if (resolveGenerationRef.current === resolveGeneration) {
        lastResolvedBoardUuidRef.current = null;
      }
      console.warn('[board-presence] resolveBoardForUuid failed', error);
      return null;
    }
  }, []);

  const resolveAndBindBoardByConfig = useCallback(
    async (args: ResolveBoardConfigArgs): Promise<ResolvedBoard | null> => {
      const activeClient = clientRef.current;
      if (!enabledRef.current || activeClient === null || !activeClient.resolveBoardForConfig) {
        return null;
      }
      const configKey = boardConfigResolveKey(args);
      if (lastResolvedConfigKeyRef.current === configKey && boardIdRef.current !== null) {
        return null;
      }
      const resolveGeneration = resolveGenerationRef.current + 1;
      resolveGenerationRef.current = resolveGeneration;
      lastResolvedConfigKeyRef.current = configKey;
      lastResolvedBoardUuidRef.current = null;
      lastResolvedSerialRef.current = null;
      setBoardId(null);
      try {
        const resolved = await activeClient.resolveBoardForConfig(args);
        if (resolveGenerationRef.current !== resolveGeneration || lastResolvedConfigKeyRef.current !== configKey) {
          return null;
        }
        setBoardId(resolved.boardId);
        return resolved;
      } catch (error) {
        if (resolveGenerationRef.current === resolveGeneration && lastResolvedConfigKeyRef.current === configKey) {
          lastResolvedConfigKeyRef.current = null;
        }
        console.warn('[board-presence] resolveBoardForConfig failed', error);
        return null;
      }
    },
    [],
  );

  const reportClimbForBoard = useCallback(
    async (targetBoardId: number, climb: ClimbQueueItemInput, angle: number | null): Promise<boolean> => {
      const activeClient = clientRef.current;
      if (!enabledRef.current || activeClient === null) {
        return false;
      }
      try {
        return await activeClient.reportClimb(targetBoardId, climb, angle);
      } catch (error) {
        console.warn('[board-presence] reportBoardClimb failed', error);
        return false;
      }
    },
    [],
  );

  const reportDisconnectForBoard = useCallback(async (targetBoardId: number): Promise<boolean> => {
    const activeClient = clientRef.current;
    if (!enabledRef.current || activeClient?.reportDisconnect == null) {
      return false;
    }
    try {
      return await activeClient.reportDisconnect(targetBoardId);
    } catch (error) {
      console.warn('[board-presence] reportBoardDisconnect failed', error);
      return false;
    }
  }, []);

  // Confirm the board the user picked from the disambiguation prompt: remember
  // the choice server-side and bind it as the active wall.
  const chooseDisambiguatedBoard = useCallback(async (chosenBoardId: number): Promise<void> => {
    const activeClient = clientRef.current;
    const pending = pendingDisambiguationRef.current;
    if (!enabledRef.current || activeClient === null || pending === null) {
      return;
    }
    const resolveGeneration = resolveGenerationRef.current + 1;
    resolveGenerationRef.current = resolveGeneration;
    try {
      const resolved = await activeClient.chooseBoardForSerial({ boardId: chosenBoardId, serial: pending.serial });
      if (resolveGenerationRef.current !== resolveGeneration) {
        return;
      }
      lastResolvedSerialRef.current = pending.serial;
      setPendingDisambiguation(null);
      setBoardId(resolved.boardId);
    } catch (error) {
      console.warn('[board-presence] chooseBoardForSerial failed', error);
    }
  }, []);

  const cancelDisambiguation = useCallback(() => {
    setPendingDisambiguation(null);
  }, []);

  // Telemetry for every catch-up. `recoveredThroughSeqDelta > 0` means the live
  // feed silently dropped pushes (Redis pub/sub has no replay) and we just
  // recovered them — the measurable "history was slow to update" signal. Stable
  // identity (reads boardIdRef) so it never re-binds the presence subscription.
  const handleCatchUp = useCallback((info: BoardPresenceCatchUpInfo) => {
    track(SHARED_EVENTS.BoardHistoryCatchUp, {
      boardId: boardIdRef.current ?? undefined,
      reason: info.reason,
      recoveredThroughSeqDelta: info.recoveredThroughSeqDelta,
    });
  }, []);

  const controls = useMemo<BoardPresenceControlsValue>(
    () => ({
      enabled,
      boardId,
      resolveAndBindBoard,
      resolveAndBindBoardByConfig,
      resolveAndBindBoardByUuid,
      reportClimbForBoard,
      reportDisconnectForBoard,
      resetPresence,
    }),
    [
      enabled,
      boardId,
      resolveAndBindBoard,
      resolveAndBindBoardByConfig,
      resolveAndBindBoardByUuid,
      reportClimbForBoard,
      reportDisconnectForBoard,
      resetPresence,
    ],
  );

  return (
    <BoardPresenceControlsContext.Provider value={controls}>
      <BoardPresenceProvider boardId={boardId} client={client} onCatchUp={handleCatchUp}>
        <BoardPresenceForegroundSync />
        {children}
      </BoardPresenceProvider>
      <BoardDisambiguationSheet
        visible={pendingDisambiguation !== null}
        candidates={pendingDisambiguation?.candidates ?? []}
        onPick={chooseDisambiguatedBoard}
        onCancel={cancelDisambiguation}
      />
    </BoardPresenceControlsContext.Provider>
  );
}

/**
 * Refetch the wall feed when the app returns to the foreground. iOS can suspend
 * the WebSocket while the app is backgrounded without emitting a clean
 * reconnect, so climbs pushed in the meantime are dropped (Redis pub/sub has no
 * replay) and the seq-gap detector only recovers them if a *later* event
 * arrives. A foreground catch-up pulls them from the durable history right away.
 * Rendered inside `BoardPresenceProvider` so it can read the `refresh` action;
 * the catch-up coalescer dedups it against any reconnect/gap catch-up.
 */
function BoardPresenceForegroundSync(): null {
  const { refresh } = useBoardPresenceActions();
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextAppState) => {
      if (nextAppState === 'active') {
        refresh('foreground');
      }
    });
    return () => subscription.remove();
  }, [refresh]);
  return null;
}

/**
 * Imperative controls for resolving/binding the board and reading the
 * flag/boardId. Returns a stable no-op fallback when rendered outside the
 * provider, so callers (e.g. a BLE flow that may mount before the provider in
 * tests) never crash.
 */
export function useBoardPresenceControls(): BoardPresenceControlsValue {
  const value = useContext(BoardPresenceControlsContext);
  return value ?? DISABLED_CONTROLS;
}

const DISABLED_CONTROLS: BoardPresenceControlsValue = {
  enabled: false,
  boardId: null,
  resolveAndBindBoard: async () => null,
  resolveAndBindBoardByConfig: async () => null,
  resolveAndBindBoardByUuid: async () => null,
  reportClimbForBoard: async () => false,
  reportDisconnectForBoard: async () => false,
  resetPresence: () => {},
};

export { BoardPresenceControlsContext };
