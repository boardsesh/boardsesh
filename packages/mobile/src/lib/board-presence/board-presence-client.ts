// Mobile transport for the board-presence ("now on the wall") feature.
//
// `@boardsesh/board-presence-react` is renderer-agnostic: it never imports a
// GraphQL client. This factory adapts the mobile graphql-ws `Client` (the same
// one the queue provider uses) to the injected `BoardPresenceClient` interface,
// running the board-presence operations over the wire — the core feed/report
// plus the holder ops (fetchConnection / reportDisconnect) and the serial
// disambiguation extension. (The web client implements only the subset it needs
// and deliberately omits the optional holder ops — see board-presence-react's
// optional interface methods.)
//
// Mirrors how the queue provider runs SESSION_UPDATES/QUEUE_UPDATES (subscribe)
// and confirmClimbOnWall (execute), reusing the shared `execute`/`subscribe`
// helpers from @boardsesh/graphql-client.

import { type Client, execute, subscribe } from '@boardsesh/graphql-client';
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
import type { BoardPresenceClient } from '@boardsesh/board-presence-react';
import type {
  BoardConnectionHolder,
  BoardPresenceClimb,
  BoardPresenceEvent,
  BoardPresenceStats,
  ClimbQueueItemInput,
  ResolveBoardResult,
  ResolvedBoard,
} from '@boardsesh/shared-schema';

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
};

/**
 * The mobile board-presence client extends the shared `BoardPresenceClient`
 * with serial disambiguation (the shared interface stays minimal so web can
 * keep using the legacy single-board resolver).
 */
export type MobileBoardPresenceClient = BoardPresenceClient & {
  // Always implemented here (unlike the optional shared method), so callers and
  // tests can invoke it directly without optional chaining.
  fetchHistory: NonNullable<BoardPresenceClient['fetchHistory']>;
  resolveBoardCandidatesForSerial(args: SerialResolveArgs): Promise<ResolveBoardResult>;
  chooseBoardForSerial(args: { boardId: number; serial: string }): Promise<ResolvedBoard>;
};

/**
 * Build a `MobileBoardPresenceClient` over a mobile graphql-ws client. Pass a
 * getter (not the client itself) so the live client — which graphql-ws may
 * dispose and recreate — is read at call time, matching
 * `getClient: () => getWsClient()` in the queue provider.
 */
export function createMobileBoardPresenceClient(getClient: () => Client): MobileBoardPresenceClient {
  return {
    subscribeNowPlaying(boardId, onEvent, onError, onComplete) {
      return subscribe<BoardNowPlayingData>(
        getClient(),
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
      // graphql-ws fires `connected` on the first connect AND on every
      // reconnect. Skip the first (the initial backfill already covers it) and
      // fire on each reconnect so the hook can re-read the durable history for
      // anything the Redis pub/sub feed dropped during the gap. Same mechanism
      // the queue provider uses (queue-provider.tsx on('connected')). `on`
      // returns its own unsubscribe.
      let connectedOnce = false;
      return getClient().on('connected', () => {
        if (connectedOnce) {
          callback();
        }
        connectedOnce = true;
      });
    },

    async fetchRecentClimbs(boardId) {
      const data = await execute<BoardRecentClimbsData>(getClient(), {
        query: BOARD_RECENT_CLIMBS,
        variables: { boardId },
      });
      return data.boardRecentClimbs ?? [];
    },

    async fetchHistory(boardId, opts) {
      const data = await execute<BoardHistoryData>(getClient(), {
        query: BOARD_HISTORY,
        variables: { boardId, limit: opts?.limit ?? null, before: opts?.before ?? null },
      });
      return data.boardHistory ?? [];
    },

    async fetchStats(boardId) {
      const data = await execute<BoardPresenceStatsData>(getClient(), {
        query: BOARD_PRESENCE_STATS,
        variables: { boardId },
      });
      return data.boardPresenceStats;
    },

    async reportClimb(boardId, climb: ClimbQueueItemInput, angle) {
      const data = await execute<ReportBoardClimbData>(getClient(), {
        query: REPORT_BOARD_CLIMB,
        variables: { boardId, climb, angle },
      });
      return data.reportBoardClimb === true;
    },

    async fetchConnection(boardId) {
      const data = await execute<BoardConnectionData>(getClient(), {
        query: BOARD_CONNECTION,
        variables: { boardId },
      });
      return data.boardConnection ?? null;
    },

    async reportDisconnect(boardId) {
      const data = await execute<ReportBoardDisconnectData>(getClient(), {
        query: REPORT_BOARD_DISCONNECT,
        variables: { boardId },
      });
      return data.reportBoardDisconnect === true;
    },

    async resolveBoardForSerial(args) {
      const data = await execute<ResolveBoardForSerialData>(getClient(), {
        query: RESOLVE_BOARD_FOR_SERIAL,
        variables: args,
      });
      return data.resolveBoardForSerial;
    },

    async resolveBoardForUuid(args) {
      const data = await execute<ResolveBoardForUuidData>(getClient(), {
        query: RESOLVE_BOARD_FOR_UUID,
        variables: args,
      });
      return data.resolveBoardForUuid;
    },

    async resolveBoardForConfig(args) {
      const data = await execute<ResolveBoardForConfigData>(getClient(), {
        query: RESOLVE_BOARD_FOR_CONFIG,
        variables: args,
      });
      return data.resolveBoardForConfig;
    },

    async resolveBoardCandidatesForSerial(args) {
      const data = await execute<ResolveBoardCandidatesData>(getClient(), {
        query: RESOLVE_BOARD_CANDIDATES_FOR_SERIAL,
        variables: args,
      });
      return data.resolveBoardCandidatesForSerial;
    },

    async chooseBoardForSerial(args) {
      const data = await execute<ChooseBoardForSerialData>(getClient(), {
        query: CHOOSE_BOARD_FOR_SERIAL,
        variables: args,
      });
      return data.chooseBoardForSerial;
    },
  };
}
