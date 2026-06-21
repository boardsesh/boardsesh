// Web transport for the board-presence ("now on the wall") feature.
//
// `@boardsesh/board-presence-react` is renderer-agnostic: it never imports a
// GraphQL client. This factory adapts the web graphql-ws `Client` (the same
// one the persistent-session provider uses) to the injected
// `BoardPresenceClient` interface, running the board-presence operations over
// the wire: the live subscription (BOARD_NOW_PLAYING), the late-joiner backfill
// + stats queries, REPORT_BOARD_CLIMB, REPORT_BOARD_DISCONNECT (holder release
// on BLE drop, matching mobile), and the serial/config/uuid resolvers. It still
// omits the optional `fetchConnection` holder backfill — web degrades to "no
// seeded holder on cold join", which the optional interface method models.
//
// Mirrors the mobile `createMobileBoardPresenceClient` (and how the
// persistent-session provider runs its subscriptions / mutations), reusing the
// shared `execute`/`subscribe` helpers re-exported from the web graphql-queue
// client.

import { type Client, execute, subscribe } from '../graphql-queue/graphql-client';
import {
  BOARD_NOW_PLAYING,
  BOARD_PRESENCE_STATS,
  BOARD_RECENT_CLIMBS,
  REPORT_BOARD_CLIMB,
  REPORT_BOARD_DISCONNECT,
  RESOLVE_BOARD_FOR_CONFIG,
  RESOLVE_BOARD_FOR_SERIAL,
} from '@boardsesh/graphql/operations/board-presence';
import type { BoardPresenceClient } from '@boardsesh/board-presence-react';
import type {
  BoardPresenceClimb,
  BoardPresenceEvent,
  BoardPresenceStats,
  ClimbQueueItemInput,
  ResolvedBoard,
} from '@boardsesh/shared-schema';

type BoardNowPlayingData = { boardNowPlaying: BoardPresenceEvent };
type BoardRecentClimbsData = { boardRecentClimbs: BoardPresenceClimb[] };
type BoardPresenceStatsData = { boardPresenceStats: BoardPresenceStats };
type ReportBoardClimbData = { reportBoardClimb: boolean };
type ReportBoardDisconnectData = { reportBoardDisconnect: boolean };
type ResolveBoardForSerialData = { resolveBoardForSerial: ResolvedBoard };
type ResolveBoardForConfigData = { resolveBoardForConfig: ResolvedBoard };

export type BoardConfigResolveArgs = {
  boardType: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
};

export type WebBoardPresenceClient = BoardPresenceClient & {
  resolveBoardForConfig(args: BoardConfigResolveArgs): Promise<ResolvedBoard>;
};

/**
 * Build a `BoardPresenceClient` over a web graphql-ws client. Pass a getter
 * (not the client itself) so the live client — which graphql-ws may dispose and
 * recreate, and which the provider builds lazily on first use — is read at call
 * time, matching how the queue provider passes `getClient: () => getWsClient()`.
 */
export function createWebBoardPresenceClient(getClient: () => Client): WebBoardPresenceClient {
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

    async fetchRecentClimbs(boardId) {
      const data = await execute<BoardRecentClimbsData>(getClient(), {
        query: BOARD_RECENT_CLIMBS,
        variables: { boardId },
      });
      return data.boardRecentClimbs ?? [];
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

    async resolveBoardForConfig(args) {
      const data = await execute<ResolveBoardForConfigData>(getClient(), {
        query: RESOLVE_BOARD_FOR_CONFIG,
        variables: args,
      });
      return data.resolveBoardForConfig;
    },
  };
}
