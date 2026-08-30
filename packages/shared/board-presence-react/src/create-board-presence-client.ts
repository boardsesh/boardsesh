// Renderer-agnostic factory for the board-presence GraphQL client.
//
// Builds a `FullBoardPresenceClient` (every optional method on the shared
// `BoardPresenceClient` interface implemented, plus the serial-disambiguation
// extension mobile's board picker needs) from a platform-injected `transport`
// — the three primitives (`execute`/`subscribe`/`onConnected`) that differ
// between web's and mobile's graphql-ws `Client`. This package still never
// imports a GraphQL client: `@boardsesh/graphql/operations/board-presence`
// exports plain query strings (not a client or a codegen'd DocumentNode), and
// the actual wire I/O is entirely the caller's — see `BoardPresenceTransport`.
//
// Both platform adapters (`packages/mobile/src/lib/board-presence/board-presence-client.ts`,
// `packages/web/app/lib/realtime/board-presence-client.ts`) are
// thin wrappers around this factory now — one place owns the operation
// strings, the response-unwrapping, and the reconnect-catch-up semantics, so a
// fix here (e.g. the reconnect catch-up mobile already had) lands on both
// platforms at once instead of drifting. That drift was exactly how web ended
// up without a reconnect catch-up before this factory existed.

import {
  BOARD_CONNECTION,
  BOARD_HISTORY,
  BOARD_NOW_PLAYING,
  BOARD_PRESENCE_STATS,
  BOARD_RECENT_CLIMBS,
  CHOOSE_BOARD_FOR_SERIAL,
  REPORT_BOARD_CLIMB,
  REPORT_BOARD_DISCONNECT,
  RESOLVE_BOARD_CANDIDATES_FOR_SERIAL,
  RESOLVE_BOARD_FOR_CONFIG,
  RESOLVE_BOARD_FOR_SERIAL,
  RESOLVE_BOARD_FOR_UUID,
} from '@boardsesh/graphql/operations/board-presence';
import type {
  BoardConnectionHolder,
  BoardPresenceClimb,
  BoardPresenceEvent,
  BoardPresenceStats,
  ClimbQueueItemInput,
  ResolveBoardResult,
  ResolvedBoard,
} from '@boardsesh/shared-schema';
import type { BoardPresenceClient } from './types';

type BoardNowPlayingData = { boardNowPlaying: BoardPresenceEvent };
type BoardRecentClimbsData = { boardRecentClimbs: BoardPresenceClimb[] };
type BoardHistoryData = { boardHistory: BoardPresenceClimb[] };
type BoardPresenceStatsData = { boardPresenceStats: BoardPresenceStats };
type BoardConnectionData = { boardConnection: BoardConnectionHolder | null };
type ReportBoardClimbData = { reportBoardClimb: boolean };
type ReportBoardDisconnectData = { reportBoardDisconnect: boolean };
type ResolveBoardForSerialData = { resolveBoardForSerial: ResolvedBoard };
type ResolveBoardForUuidData = { resolveBoardForUuid: ResolvedBoard };
type ResolveBoardForConfigData = { resolveBoardForConfig: ResolvedBoard };
type ResolveBoardCandidatesData = { resolveBoardCandidatesForSerial: ResolveBoardResult };
type ChooseBoardForSerialData = { chooseBoardForSerial: ResolvedBoard };

/** Config + serial needed to resolve a board (with possible disambiguation). */
export type SerialResolveArgs = {
  serial: string;
  boardType: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  /**
   * The board type the connected controller advertises in its BLE device name
   * (`Tension Board#12345@3`). Aurora numbers each board app separately, so the
   * same serial exists on controllers of different types; this scopes the
   * server's lookup to the hardware actually connected. Optional — `boardType`
   * above is the route the climber is on, which is not the same fact.
   */
  advertisedBoardType?: string;
};

/** A GraphQL operation: the query/mutation/subscription string plus variables. */
export type BoardPresenceOperation<TVariables = Record<string, unknown>> = {
  query: string;
  variables?: TVariables;
};

/** Callback sink for a subscription's push events, mirroring graphql-ws's `Sink`. */
export type BoardPresenceSink<TData> = {
  next: (data: TData) => void;
  error: (err: unknown) => void;
  complete: () => void;
};

/**
 * Platform I/O this factory needs: run a mutation/query, open a subscription,
 * and observe the transport's connect events. Both web and mobile inject this
 * bound to their graphql-ws `Client` (see the two adapters); tests inject a
 * fake transport.
 */
export type BoardPresenceTransport = {
  execute<TData>(operation: BoardPresenceOperation): Promise<TData>;
  subscribe<TData>(operation: BoardPresenceOperation, sink: BoardPresenceSink<TData>): () => void;
  /**
   * Register a callback fired on every `connected` event the transport emits
   * (including the very first connect). `createBoardPresenceClient` derives
   * `onReconnect` from this by skipping the first call per registration — see
   * there for why.
   */
  onConnected(callback: () => void): () => void;
};

/**
 * `BoardPresenceClient` with every optional method required, plus the serial
 * disambiguation extension (`resolveBoardCandidatesForSerial`,
 * `chooseBoardForSerial`) that neither platform's base interface needs but
 * both platform clients implement identically (mobile's board picker; web
 * currently has no caller for it, same as any other unused method). Both
 * adapters return this type — mobile's `MobileBoardPresenceClient` and web's
 * `WebBoardPresenceClient` are aliases of it.
 */
export type FullBoardPresenceClient = Required<BoardPresenceClient> & {
  resolveBoardCandidatesForSerial(args: SerialResolveArgs): Promise<ResolveBoardResult>;
  chooseBoardForSerial(args: { boardId: number; serial: string }): Promise<ResolvedBoard>;
};

/**
 * Build a `FullBoardPresenceClient` over an injected `transport`. Both
 * platform adapters (mobile, web) are one-line wrappers that supply
 * `execute`/`subscribe`/`onConnected` bound to their own graphql-ws `Client` —
 * see the header comment for why this factory exists.
 */
export function createBoardPresenceClient(transport: BoardPresenceTransport): FullBoardPresenceClient {
  // Whether ANY `onReconnect` registration made through this factory instance
  // has observed a `connected` event. Factory-level, NOT per-registration, on
  // purpose: graphql-ws does not replay `connected` to a listener added on an
  // already-open socket, so after a mid-session re-registration (e.g. the
  // shared hook's effect re-running on a board switch) the new registration's
  // FIRST observed `connected` is a genuine reconnect — a per-registration
  // skip-first would swallow exactly the catch-up that registration exists
  // for. With this shared flag, only the first `connected` ever observed
  // through this factory instance (the initial connect, whose backfill already
  // covers it) is skipped; everything after fires, including a fresh
  // registration's first observed event. Erring toward an occasional extra
  // catch-up is safe — the hook's runCatchUp coalesces in-flight requests.
  let everConnected = false;
  return {
    subscribeNowPlaying(boardId, onEvent, onError, onComplete) {
      return transport.subscribe<BoardNowPlayingData>(
        { query: BOARD_NOW_PLAYING, variables: { boardId } },
        {
          next: (data) => {
            if (data?.boardNowPlaying) {
              onEvent(data.boardNowPlaying);
            }
          },
          error: (err) => {
            onError?.(err);
          },
          complete: () => {
            onComplete?.();
          },
        },
      );
    },

    onReconnect(callback) {
      // The transport fires `onConnected` on the first connect AND on every
      // reconnect. Skip the first ever observed through this factory (see
      // `everConnected` above for why the flag is factory-level) and fire on
      // each one after, so the hook can re-read the durable history for
      // anything the Redis pub/sub feed dropped during the gap.
      return transport.onConnected(() => {
        if (everConnected) {
          callback();
        }
        everConnected = true;
      });
    },

    async fetchRecentClimbs(boardId) {
      const data = await transport.execute<BoardRecentClimbsData>({
        query: BOARD_RECENT_CLIMBS,
        variables: { boardId },
      });
      return data.boardRecentClimbs ?? [];
    },

    async fetchHistory(boardId, opts) {
      const data = await transport.execute<BoardHistoryData>({
        query: BOARD_HISTORY,
        variables: { boardId, limit: opts?.limit ?? null, before: opts?.before ?? null },
      });
      return data.boardHistory ?? [];
    },

    async fetchStats(boardId) {
      const data = await transport.execute<BoardPresenceStatsData>({
        query: BOARD_PRESENCE_STATS,
        variables: { boardId },
      });
      return data.boardPresenceStats;
    },

    async reportClimb(boardId, climb: ClimbQueueItemInput, angle) {
      const data = await transport.execute<ReportBoardClimbData>({
        query: REPORT_BOARD_CLIMB,
        variables: { boardId, climb, angle },
      });
      return data.reportBoardClimb === true;
    },

    async fetchConnection(boardId) {
      const data = await transport.execute<BoardConnectionData>({
        query: BOARD_CONNECTION,
        variables: { boardId },
      });
      return data.boardConnection ?? null;
    },

    async reportDisconnect(boardId) {
      const data = await transport.execute<ReportBoardDisconnectData>({
        query: REPORT_BOARD_DISCONNECT,
        variables: { boardId },
      });
      return data.reportBoardDisconnect === true;
    },

    async resolveBoardForSerial(args) {
      const data = await transport.execute<ResolveBoardForSerialData>({
        query: RESOLVE_BOARD_FOR_SERIAL,
        variables: args,
      });
      return data.resolveBoardForSerial;
    },

    async resolveBoardForUuid(args) {
      const data = await transport.execute<ResolveBoardForUuidData>({
        query: RESOLVE_BOARD_FOR_UUID,
        variables: args,
      });
      return data.resolveBoardForUuid;
    },

    async resolveBoardForConfig(args) {
      const data = await transport.execute<ResolveBoardForConfigData>({
        query: RESOLVE_BOARD_FOR_CONFIG,
        variables: args,
      });
      return data.resolveBoardForConfig;
    },

    async resolveBoardCandidatesForSerial(args) {
      const data = await transport.execute<ResolveBoardCandidatesData>({
        query: RESOLVE_BOARD_CANDIDATES_FOR_SERIAL,
        variables: args,
      });
      return data.resolveBoardCandidatesForSerial;
    },

    async chooseBoardForSerial(args) {
      const data = await transport.execute<ChooseBoardForSerialData>({
        query: CHOOSE_BOARD_FOR_SERIAL,
        variables: args,
      });
      return data.chooseBoardForSerial;
    },
  };
}
