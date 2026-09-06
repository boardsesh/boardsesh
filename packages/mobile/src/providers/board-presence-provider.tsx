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
import {
  createScreenshotBoardPresenceClient,
  SCREENSHOT_SEED_BOARD_ID,
} from '../lib/board-presence/screenshot-wall-seed';
import { getWsClient } from '../lib/graphql/ws-client';
import { selectOfflineMode, useConnectivityField } from '../lib/connectivity/use-connectivity';
import { track } from '../lib/analytics';
import { BoardDisambiguationSheet } from '../components/board-discovery/BoardDisambiguationSheet';

/** Board config needed to find-or-bind the shared board on first sighting. */
export type ResolveBoardArgs = {
  serial: string;
  boardType: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  /**
   * The board type the connected controller advertised over BLE, from the
   * connection snapshot. Distinct from `boardType`, which is the route the
   * climber is on: Aurora numbers each board app separately, so this is what
   * keeps the serial lookup on the hardware in front of them.
   */
  advertisedBoardType?: string;
};

// No serial means no advertisement to read a type from.
export type ResolveBoardConfigArgs = Omit<ResolveBoardArgs, 'serial' | 'advertisedBoardType'>;

export type ResolveBoardUuidArgs = {
  boardUuid: string;
};

/** Stable identity needed by BLE lifetime attribution. Resolver callers must
 * not depend on the backend's richer board payload. */
export type BoardBindingIdentity = Pick<ResolvedBoard, 'boardId'>;

type BoardBindingResolutionKind = 'serial' | 'config' | 'uuid';

type PendingBoardBindingResolution = {
  key: string;
  kind: BoardBindingResolutionKind;
  promise: Promise<BoardBindingIdentity | null>;
  settle: (binding: BoardBindingIdentity | null) => void;
  choiceInFlight: boolean;
};

function createPendingBoardBindingResolution(
  key: string,
  kind: BoardBindingResolutionKind,
): PendingBoardBindingResolution {
  let resolvePromise: (binding: BoardBindingIdentity | null) => void = () => {};
  let settled = false;
  const promise = new Promise<BoardBindingIdentity | null>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    key,
    kind,
    promise,
    choiceInFlight: false,
    settle: (binding) => {
      if (settled) return;
      settled = true;
      resolvePromise(binding);
    },
  };
}

function boardConfigResolveKey({ boardType, layoutId, sizeId, setIds }: ResolveBoardConfigArgs): string {
  return `config:${boardType}:${layoutId}:${sizeId}:${setIds}`;
}

function boardSerialResolveKey(args: ResolveBoardArgs): string {
  // `advertisedBoardType` is part of the key because it changes which board the
  // serial resolves to. Left out, a cached binding from a connect that reported
  // no type would be reused for one that does.
  return `serial:${args.serial}:${args.boardType}:${args.layoutId}:${args.sizeId}:${args.setIds}:${args.advertisedBoardType ?? ''}`;
}

function boardUuidResolveKey({ boardUuid }: ResolveBoardUuidArgs): string {
  return `uuid:${boardUuid}`;
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
   * An unchanged, already-bound serial/config returns its cached board identity
   * without another transport request so a new BLE generation can attribute
   * its eventual release. Same-key callers share an in-flight resolution,
   * including the deferred serial-disambiguation choice.
   */
  resolveAndBindBoard: (args: ResolveBoardArgs) => Promise<BoardBindingIdentity | null>;
  /**
   * Resolve a board by config when no serial is available, then store its
   * boardId. An unchanged bound config returns its cached identity, and
   * same-key callers share an in-flight result. No-op when the active transport
   * does not support config fallback.
   */
  resolveAndBindBoardByConfig: (args: ResolveBoardConfigArgs) => Promise<BoardBindingIdentity | null>;
  /**
   * Resolve a selected named board by UUID, then store its boardId. This is the
   * preferred non-BLE path for board sheet stats/history. An unchanged bound
   * UUID returns its cached identity; same-key callers share an in-flight result.
   */
  resolveAndBindBoardByUuid: (args: ResolveBoardUuidArgs) => Promise<BoardBindingIdentity | null>;
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
  // Screenshot mode: bind a sentinel board on boot so the iPad "On the Wall"
  // kiosk renders live (its `isWallLive` gate is `boardId !== null`) with the
  // seeded feed below, instead of the empty "Connect a board" state. The simulator
  // has no Bluetooth to set a real boardId. Dead-strips in normal builds (inlined
  // gate), which keep the null start.
  const [boardId, setBoardId] = useState<number | null>(
    process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1' ? SCREENSHOT_SEED_BOARD_ID : null,
  );
  // When a serial maps to several boards the user must pick which wall they're
  // at. We hold the candidates + serial here and surface a picker; binding waits
  // for the choice.
  const [pendingDisambiguation, setPendingDisambiguation] = useState<{
    serial: string;
    resolutionKey: string;
    candidates: BoardCandidate[];
  } | null>(null);

  // Screenshot builds swap in a seed client that serves canned real climbs (no
  // graphql-ws), so the kiosk lights up in the simulator; the branch dead-strips
  // in normal builds. Read once here so the offline gate below can tell a
  // network transport from a purely local one.
  const usesSeedTransport = process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1';

  // The injected transport, built once.
  const client = useMemo<MobileBoardPresenceClient | null>(
    () => (usesSeedTransport ? createScreenshotBoardPresenceClient() : createMobileBoardPresenceClient(getWsClient)),
    [usesSeedTransport],
  );
  const clientRef = useRef(client);
  clientRef.current = client;

  // Offline mode has to reach the wall feed too (issue #4862). The shared
  // presence hook subscribes whenever it holds a board AND a client, and every
  // one of its transport calls — the subscription, each catch-up fetch, the
  // foreground refresh — goes through `getWsClient()`, which OPENS a socket on
  // demand. So the socket `ConnectivityBridge` disposes would come straight back
  // the next time a board binds or the app is foregrounded.
  //
  // Handing the hook `null` is its documented inert state: it resets, subscribes
  // to nothing, and `refresh()` becomes a no-op. Passing the real client back on
  // the store's edge re-subscribes and catches up from the durable history in one
  // go — the same defer-and-resume shape as `use-session-realtime`, expressed
  // through the prop the hook already understands.
  //
  // Gated on `offlineMode` alone, NOT `effectiveOffline`. A dropped signal or a
  // backend blip already has an answer here: graphql-ws retries, the feed stays
  // on screen and goes not-live. Widening the gate would blank the wall's history
  // on every tunnel. Offline mode is a deliberate, sticky choice, and clearing a
  // live feed nobody is allowed to fetch is what the climber asked for.
  //
  // The imperative controls below keep the ungated `clientRef`: resolving and
  // binding a board, or reporting a lit climb, is one-shot and user-initiated, so
  // it fails visibly instead of redialling in the background.
  const offlineMode = useConnectivityField(selectOfflineMode);
  const liveClient = offlineMode && !usesSeedTransport ? null : client;

  // A bound identity is cached by the exact resolver key. A same-key reconnect
  // can reuse it; a different serial/config/UUID must resolve independently.
  const boundBoardBindingRef = useRef<{ resolutionKey: string; boardId: number } | null>(null);
  // Every exact key has at most one deferred resolution. Same-wall reconnects
  // share this promise so the newest BLE generation can attach the eventual ID
  // even when an older generation started the network request or picker.
  const pendingBoardBindingResolutionRef = useRef<PendingBoardBindingResolution | null>(null);
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

  const settleActiveResolution = useCallback(
    (pendingResolution: PendingBoardBindingResolution, binding: BoardBindingIdentity | null): boolean => {
      if (pendingBoardBindingResolutionRef.current !== pendingResolution) {
        return false;
      }
      pendingBoardBindingResolutionRef.current = null;
      setPendingDisambiguation(null);
      if (binding) {
        boundBoardBindingRef.current = {
          resolutionKey: pendingResolution.key,
          boardId: binding.boardId,
        };
        boardIdRef.current = binding.boardId;
        setBoardId(binding.boardId);
      } else {
        boundBoardBindingRef.current = null;
        boardIdRef.current = null;
        setBoardId(null);
      }
      pendingResolution.settle(binding);
      return true;
    },
    [],
  );

  const beginResolution = useCallback(
    (resolutionKey: string, kind: BoardBindingResolutionKind): PendingBoardBindingResolution => {
      const previousResolution = pendingBoardBindingResolutionRef.current;
      if (previousResolution) {
        pendingBoardBindingResolutionRef.current = null;
        previousResolution.settle(null);
      }
      setPendingDisambiguation(null);
      boundBoardBindingRef.current = null;
      boardIdRef.current = null;
      setBoardId(null);
      const pendingResolution = createPendingBoardBindingResolution(resolutionKey, kind);
      pendingBoardBindingResolutionRef.current = pendingResolution;
      return pendingResolution;
    },
    [],
  );

  const resetPresence = useCallback(() => {
    const pendingResolution = pendingBoardBindingResolutionRef.current;
    pendingBoardBindingResolutionRef.current = null;
    pendingResolution?.settle(null);
    boundBoardBindingRef.current = null;
    setPendingDisambiguation(null);
    boardIdRef.current = null;
    setBoardId(null);
  }, []);

  // A provider teardown must not leave a serial-disambiguation promise (and its
  // Bluetooth callers) pending forever. Avoid state writes during unmount.
  useEffect(
    () => () => {
      const pendingResolution = pendingBoardBindingResolutionRef.current;
      pendingBoardBindingResolutionRef.current = null;
      pendingResolution?.settle(null);
    },
    [],
  );

  const resolveAndBindBoard = useCallback(
    (args: ResolveBoardArgs): Promise<BoardBindingIdentity | null> => {
      const activeClient = clientRef.current;
      if (!enabledRef.current || activeClient === null) {
        return Promise.resolve(null);
      }
      const resolutionKey = boardSerialResolveKey(args);
      const pendingResolution = pendingBoardBindingResolutionRef.current;
      if (pendingResolution?.key === resolutionKey) {
        return pendingResolution.promise;
      }
      const boundBinding = boundBoardBindingRef.current;
      if (boundBinding?.resolutionKey === resolutionKey) {
        return Promise.resolve({ boardId: boundBinding.boardId });
      }

      const newResolution = beginResolution(resolutionKey, 'serial');
      void activeClient
        .resolveBoardCandidatesForSerial(args)
        .then((result) => {
          if (pendingBoardBindingResolutionRef.current !== newResolution) return;
          if (result.board) {
            settleActiveResolution(newResolution, { boardId: result.board.boardId });
            return;
          }
          if (result.candidates && result.candidates.length > 0) {
            // Keep the keyed promise pending through disambiguation. A same-wall
            // reconnect shares it and can attach the chosen ID to its newer BLE
            // generation; cancel/different-key/reset settle it with null.
            setPendingDisambiguation({
              serial: args.serial,
              resolutionKey,
              candidates: result.candidates,
            });
            return;
          }
          settleActiveResolution(newResolution, null);
        })
        .catch((error: unknown) => {
          settleActiveResolution(newResolution, null);
          console.warn('[board-presence] resolveBoardCandidatesForSerial failed', error);
        });
      return newResolution.promise;
    },
    [beginResolution, settleActiveResolution],
  );

  const resolveAndBindBoardByUuid = useCallback(
    (args: ResolveBoardUuidArgs): Promise<BoardBindingIdentity | null> => {
      const activeClient = clientRef.current;
      if (!enabledRef.current || activeClient === null || !activeClient.resolveBoardForUuid) {
        return Promise.resolve(null);
      }
      const resolutionKey = boardUuidResolveKey(args);
      const pendingResolution = pendingBoardBindingResolutionRef.current;
      if (pendingResolution?.key === resolutionKey) {
        return pendingResolution.promise;
      }
      const boundBinding = boundBoardBindingRef.current;
      if (boundBinding?.resolutionKey === resolutionKey) {
        return Promise.resolve({ boardId: boundBinding.boardId });
      }

      const newResolution = beginResolution(resolutionKey, 'uuid');
      void activeClient
        .resolveBoardForUuid(args)
        .then((resolved) => {
          settleActiveResolution(newResolution, { boardId: resolved.boardId });
        })
        .catch((error: unknown) => {
          settleActiveResolution(newResolution, null);
          console.warn('[board-presence] resolveBoardForUuid failed', error);
        });
      return newResolution.promise;
    },
    [beginResolution, settleActiveResolution],
  );

  const resolveAndBindBoardByConfig = useCallback(
    (args: ResolveBoardConfigArgs): Promise<BoardBindingIdentity | null> => {
      const activeClient = clientRef.current;
      if (!enabledRef.current || activeClient === null || !activeClient.resolveBoardForConfig) {
        return Promise.resolve(null);
      }
      const resolutionKey = boardConfigResolveKey(args);
      const pendingResolution = pendingBoardBindingResolutionRef.current;
      if (pendingResolution?.key === resolutionKey) {
        return pendingResolution.promise;
      }
      const boundBinding = boundBoardBindingRef.current;
      if (boundBinding?.resolutionKey === resolutionKey) {
        return Promise.resolve({ boardId: boundBinding.boardId });
      }

      const newResolution = beginResolution(resolutionKey, 'config');
      void activeClient
        .resolveBoardForConfig(args)
        .then((resolved) => {
          settleActiveResolution(newResolution, { boardId: resolved.boardId });
        })
        .catch((error: unknown) => {
          settleActiveResolution(newResolution, null);
          console.warn('[board-presence] resolveBoardForConfig failed', error);
        });
      return newResolution.promise;
    },
    [beginResolution, settleActiveResolution],
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
  const chooseDisambiguatedBoard = useCallback(
    async (chosenBoardId: number): Promise<void> => {
      const activeClient = clientRef.current;
      const pendingDisambiguationState = pendingDisambiguationRef.current;
      const pendingResolution = pendingBoardBindingResolutionRef.current;
      if (
        !enabledRef.current ||
        activeClient === null ||
        pendingDisambiguationState === null ||
        pendingResolution?.kind !== 'serial' ||
        pendingResolution.key !== pendingDisambiguationState.resolutionKey ||
        pendingResolution.choiceInFlight
      ) {
        return;
      }
      pendingResolution.choiceInFlight = true;
      try {
        const resolved = await activeClient.chooseBoardForSerial({
          boardId: chosenBoardId,
          serial: pendingDisambiguationState.serial,
        });
        settleActiveResolution(pendingResolution, { boardId: resolved.boardId });
      } catch (error) {
        settleActiveResolution(pendingResolution, null);
        console.warn('[board-presence] chooseBoardForSerial failed', error);
      }
    },
    [settleActiveResolution],
  );

  const cancelDisambiguation = useCallback(() => {
    const pendingDisambiguationState = pendingDisambiguationRef.current;
    const pendingResolution = pendingBoardBindingResolutionRef.current;
    if (
      pendingDisambiguationState &&
      pendingResolution?.kind === 'serial' &&
      pendingResolution.key === pendingDisambiguationState.resolutionKey
    ) {
      settleActiveResolution(pendingResolution, null);
      return;
    }
    setPendingDisambiguation(null);
  }, [settleActiveResolution]);

  // Telemetry only when a catch-up recovered missed wall events. Foreground and
  // reconnect catch-ups with a zero delta happen often and add no product signal.
  // Stable identity (reads boardIdRef) so it never re-binds the presence
  // subscription.
  const handleCatchUp = useCallback((info: BoardPresenceCatchUpInfo) => {
    if (info.recoveredThroughSeqDelta <= 0) return;
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
      <BoardPresenceProvider boardId={boardId} client={liveClient} onCatchUp={handleCatchUp}>
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
