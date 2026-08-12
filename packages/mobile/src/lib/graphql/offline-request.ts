import { onlineManager } from '@tanstack/react-query';
import type { Variables } from 'graphql-request';
import type { SQLiteDatabase } from 'expo-sqlite';
import { getDatabaseHandle } from '../../db';
import { isOfflineEngineEnabled } from '../offline-engine';
import { searchClimbsLocal, countClimbsLocal, isOfflineSearchSupported } from '../../db/queries/search-climbs-local';
import { getClimbLocal } from '../../db/queries/get-climb-local';
import { getBoardseshGradeLocal, getBoardseshGradesForAnglesLocal } from '../../db/queries/get-boardsesh-grade-local';
import { isBoardDownloadedLocally, isBoardTypeDownloadedLocally } from '../../db/queries/board-download-status';
import { getHttpClient } from './client';
import type { OfflineReadSurface, OfflineUnavailableReason } from '@boardsesh/offline-sync';
import { recordOfflineRead, recordOfflineReadUnavailable } from '../../offline/offline-usage-signal';
import {
  BOARDSESH_GRADE,
  BOARDSESH_GRADES_FOR_ANGLES,
  type BoardseshGradeVariables,
  type BoardseshGradeResponse,
  type BoardseshGradesForAnglesVariables,
  type BoardseshGradesForAnglesResponse,
} from '@boardsesh/graphql/operations';
import {
  SEARCH_CLIMBS,
  SEARCH_CLIMBS_COUNT,
  GET_CLIMB,
  type SearchClimbsQueryVariables,
  type SearchClimbsQueryResponse,
  type SearchClimbsCountQueryResponse,
  type GetClimbQueryResponse,
  type GetClimbQueryVariables,
} from './operations';

/**
 * Source selection for climb reads — **local-first**. Whenever the active board's
 * exact (type, layout, size) scope is downloaded and the filters are expressible
 * on-device, read local SQLite even while online: a local query is far faster than
 * a network round-trip, and the background sync (foreground + reconnect) keeps the
 * rows fresh — a completed board pull invalidates ['searchClimbs']/['climb'] so the
 * next local read reflects it. The network is used only when there's no usable local
 * data: the board isn't downloaded, or the filter needs a table we don't sync
 * (hold-state, zone, tall/wide, beta, drafts). Offline with no local data → an
 * empty/null result rather than a doomed request.
 *
 * A plain async function (not a hook) so the React Query queryFns and imperative
 * callers share one client-level interceptor. Source is decided live per call; the
 * query key is just the input (no connectivity flag), since a downloaded board reads
 * local regardless of connectivity and the caches self-heal on the post-sync
 * invalidation.
 */

function scopeOf(input: { boardName: string; layoutId: number; sizeId: number }) {
  return { boardType: input.boardName, layoutId: input.layoutId, sizeId: input.sizeId };
}

type OfflineOperation<TVariables, TResponse> = {
  document: string;
  // Offline-usage rollup (#4317): which read this is, and which board it is
  // scoped to. The gate keys on (day, lane, board) and carries `surface` as a
  // descriptive prop of the read that crossed a rung.
  surface: OfflineReadSurface;
  boardNameOf: (variables: TVariables) => string;
  // Why an offline read came back empty, when the answer isn't simply "the
  // board isn't downloaded". Only computed when the rollup gate has already
  // decided to emit, so it costs nothing on the suppressed path.
  unavailableReason?: (variables: TVariables) => OfflineUnavailableReason;
  canServeLocal: (db: SQLiteDatabase, variables: TVariables) => Promise<boolean>;
  // Returns the RAW GraphQL response shape (as if the server had answered).
  resolveLocal: (db: SQLiteDatabase, variables: TVariables) => Promise<TResponse>;
  offlineFallback: () => TResponse;
  // A local result that should be retried over the network while online: a
  // known-key read that missed because the row hasn't synced yet (e.g. a live
  // presence event referencing a climb newer than the board download). An
  // empty search result is a real answer, not a miss — search ops omit this.
  isLocalMiss?: (response: TResponse) => boolean;
};

// Generics erased at storage; `never` params keep the assignment legal
// (contravariance) — no `any`.
const OFFLINE_OPERATIONS = new Map<string, OfflineOperation<never, unknown>>();

function registerOfflineOperation<TVariables, TResponse>(operation: OfflineOperation<TVariables, TResponse>): void {
  OFFLINE_OPERATIONS.set(operation.document, operation as OfflineOperation<never, unknown>);
}

// Shared by the search + count registrations so the climbs list and its
// "Show N" count always gate to the same source. `isOfflineSearchSupported`
// MUST stay first: the sync short-circuit avoids the async mmkv lazy-import
// inside `isBoardDownloadedLocally` when the filter isn't expressible on-device.
async function canServeSearchLocal(db: SQLiteDatabase, { input }: SearchClimbsQueryVariables): Promise<boolean> {
  return isOfflineSearchSupported(input) && (await isBoardDownloadedLocally(db, scopeOf(input)));
}

// A search can come back empty offline for two very different reasons, and the
// difference decides who can be converted: a missing download is #4318's
// audience, an unsupported filter is #4002's.
function searchUnavailableReason({ input }: SearchClimbsQueryVariables): OfflineUnavailableReason {
  return isOfflineSearchSupported(input) ? 'board_not_downloaded' : 'filter_unsupported';
}

const searchBoardName = ({ input }: SearchClimbsQueryVariables) => input.boardName;

registerOfflineOperation<SearchClimbsQueryVariables, SearchClimbsQueryResponse>({
  document: SEARCH_CLIMBS,
  surface: 'search',
  boardNameOf: searchBoardName,
  unavailableReason: searchUnavailableReason,
  canServeLocal: canServeSearchLocal,
  resolveLocal: async (db, { input }) => ({ searchClimbs: await searchClimbsLocal(db, input) }),
  offlineFallback: () => ({ searchClimbs: { climbs: [], hasMore: false } }),
});

registerOfflineOperation<SearchClimbsQueryVariables, SearchClimbsCountQueryResponse>({
  document: SEARCH_CLIMBS_COUNT,
  surface: 'search',
  boardNameOf: searchBoardName,
  unavailableReason: searchUnavailableReason,
  canServeLocal: canServeSearchLocal,
  resolveLocal: async (db, { input }) => ({ searchClimbs: { totalCount: await countClimbsLocal(db, input) } }),
  offlineFallback: () => ({ searchClimbs: { totalCount: 0 } }),
});

registerOfflineOperation<GetClimbQueryVariables, GetClimbQueryResponse>({
  document: GET_CLIMB,
  surface: 'climb_detail',
  boardNameOf: (variables) => variables.boardName,
  // Detail has no filters — local whenever the exact scope is downloaded.
  canServeLocal: (db, variables) => isBoardDownloadedLocally(db, scopeOf(variables)),
  resolveLocal: async (db, variables) => ({
    climb: await getClimbLocal(db, {
      boardName: variables.boardName,
      layoutId: variables.layoutId,
      angle: variables.angle,
      climbUuid: variables.climbUuid,
    }),
  }),
  offlineFallback: () => ({ climb: null }),
  isLocalMiss: (response) => response.climb === null,
});

// Boardsesh grade reads. These carry only boardName (+ climbUuid + angle), no
// layout/size, so they gate on the board TYPE being downloaded and then read
// board_climb_grades by the exact key. A single-row null is a local miss (the
// row may just not have synced, or the climb is from a non-downloaded scope of
// the same board type) → retried over the network while online. The by-angle
// list treats an empty result as a real answer (a MoonBoard / no-grade climb),
// exactly like an empty search — no needless network retry.
registerOfflineOperation<BoardseshGradeVariables, BoardseshGradeResponse>({
  document: BOARDSESH_GRADE,
  surface: 'grade',
  boardNameOf: ({ boardName }) => boardName,
  canServeLocal: (db, { boardName }) => isBoardTypeDownloadedLocally(db, boardName),
  resolveLocal: async (db, { boardName, climbUuid, angle }) => ({
    boardseshGrade: await getBoardseshGradeLocal(db, { boardName, climbUuid, angle }),
  }),
  offlineFallback: () => ({ boardseshGrade: null }),
  isLocalMiss: (response) => response.boardseshGrade === null,
});

// Deliberately NO `isLocalMiss` here, unlike the BOARDSESH_GRADE op above — this is
// a collapsed-vs-expanded divergence, not an oversight. The single-angle op treats a
// null row as a miss and retries over the network (see its isLocalMiss above); this
// by-angle op treats an empty list as a real answer and never retries. Two reasons:
//   1. An empty by-angle list is frequently CORRECT (MoonBoard / too-few-ascents
//      climbs are never graded), so retrying it would be a needless network round
//      trip on every chart open for those climbs — the same reasoning search results
//      use (see the class doc above `OfflineOperation.isLocalMiss`).
//   2. Neither grade op carries layout/size, only boardName — so there's no way to
//      tell "genuinely ungraded" apart from "this exact climb scope never synced to
//      this device" (e.g. viewed cross-scope via party queue / deep link / similar
//      climbs). Adding isLocalMiss here would retry on every miss including the
//      common ungraded case, which is the exact overhead skipping it is meant to
//      avoid.
// Net effect: for a climb whose grades never synced to THIS device, the collapsed
// single-grade view (BOARDSESH_GRADE) falls back to the network and shows a grade,
// while the expanded by-angle chart (this op) shows empty until the board's next
// background sync catches the row up. This is accepted, not a bug — see
// offline-request.test.ts's "does not retry an empty local list" case.
registerOfflineOperation<BoardseshGradesForAnglesVariables, BoardseshGradesForAnglesResponse>({
  document: BOARDSESH_GRADES_FOR_ANGLES,
  surface: 'grade',
  boardNameOf: ({ boardName }) => boardName,
  canServeLocal: (db, { boardName }) => isBoardTypeDownloadedLocally(db, boardName),
  resolveLocal: async (db, { boardName, climbUuid }) => ({
    boardseshGradesForAngles: await getBoardseshGradesForAnglesLocal(db, { boardName, climbUuid }),
  }),
  offlineFallback: () => ({ boardseshGradesForAngles: [] }),
});

/**
 * Client-level interceptor: run the request local-first when the document is
 * registered and the active board can serve it, otherwise hit the network. Falls
 * through to plain HTTP for any unregistered document, so it's a safe drop-in for
 * `getHttpClient().request`.
 *
 * Reading data that's ALREADY on disk is never gated by the
 * `offline-board-downloads` flag — the same rule the mutation drainer follows
 * (offline-sync-bridge.tsx: the flag gates NEW offline work, never the draining
 * of existing work). So whenever the network is down we serve a downloaded board
 * from local SQLite — or the per-op empty fallback when nothing is downloaded —
 * regardless of the flag. The flag only decides whether we ALSO short-circuit to
 * local while ONLINE (a latency optimization); with it off, an online request is
 * a straight network passthrough that never even probes local, so a killed
 * device keeps exactly the pre-offline behavior and its cost. Since #4312 that
 * is the minority — an unresolved flag reads as ON, so the online local-first
 * probe is now the default. It stays cheap for a user with nothing downloaded:
 * `canServeLocal` short-circuits on the in-memory enabled-boards setting before
 * it ever touches SQLite (see db/queries/board-download-status.ts).
 *
 * Belt-and-braces for a lying connection: `onlineManager` can read "online" when
 * the network can't actually serve the request — its NetInfo seed is async and
 * defaults true (a cold start can lose that race), and it tracks `isConnected`,
 * not `isInternetReachable`, so gym wifi with a dead upstream / a captive portal /
 * no cellular data all look online. So when a request that reached the network
 * throws, we make the SAME downloaded-board local fallback one more time before
 * giving up; a real online error with no local data still propagates untouched.
 */
export async function offlineAwareRequest<TResponse>(document: string, variables?: Variables): Promise<TResponse> {
  const operation = OFFLINE_OPERATIONS.get(document);
  // Carry a local source we already resolved on the way to the network so the
  // network-failure catch below can reuse it instead of re-probing. Only set on
  // the online miss-retry path — the one path that reaches the network with a
  // confirmed-serviceable local source.
  let localDb: SQLiteDatabase | null = null;
  let localServiceable = false;
  if (operation) {
    const isOnline = onlineManager.isOnline();
    // Consult local sources when OFFLINE (always) or, while ONLINE, only when the
    // flag enables the local-first optimization.
    if (!isOnline || isOfflineEngineEnabled()) {
      localDb = getDatabaseHandle();
      // The `variables !== undefined` guard makes a registered document called
      // without variables degrade to HTTP rather than throw in a destructure;
      // the offline fallback below still applies either way. `as never` re-narrows
      // the storage-erased generics — see the OFFLINE_OPERATIONS declaration.
      if (localDb && variables !== undefined && (await operation.canServeLocal(localDb, variables as never))) {
        localServiceable = true;
        const localResponse = (await operation.resolveLocal(localDb, variables as never)) as TResponse;
        // A known-key miss falls through to the network while online — the row
        // may simply not have synced yet. Offline, the miss stands (it has the
        // same shape as offlineFallback).
        const retryOverNetwork = operation.isLocalMiss?.(localResponse) === true && isOnline;
        if (!retryOverNetwork) {
          // Recorded on the RETURN path only, so the online miss-retry that
          // continues to the network below is never counted as served (#4317).
          recordOfflineRead({
            lane: isOnline ? 'online_local' : 'offline_local',
            surface: operation.surface,
            boardName: operation.boardNameOf(variables as never),
          });
          return localResponse;
        }
      } else if (!isOnline) {
        // Offline with nothing local to serve — the surface gets an empty
        // result. `variables` can legitimately be undefined here (a registered
        // document called without them degrades to the fallback), and every
        // accessor below destructures it, so skip the signal in that case
        // rather than throw on a read path.
        if (variables !== undefined) {
          recordOfflineReadUnavailable({
            reason: operation.unavailableReason?.(variables as never) ?? 'board_not_downloaded',
            surface: operation.surface,
            boardName: operation.boardNameOf(variables as never),
          });
        }
        return operation.offlineFallback() as TResponse;
      }
    }
  }

  try {
    return await getHttpClient().request<TResponse>(document, variables);
  } catch (networkError) {
    // The request reached the network and failed. If it's a registered op whose
    // board is downloaded, serve local instead — this catches the "connected but
    // unreachable" and cold-start-race cases that `onlineManager` still reports as
    // online (see the doc above). Flag-independent, like every other on-disk read.
    // Nothing local to serve → rethrow the real error unchanged.
    if (operation && variables !== undefined) {
      // Reuse the db + canServeLocal result from the miss-retry path when we have
      // them; otherwise (flag off, or db not resolved above) probe now.
      const db = localDb ?? getDatabaseHandle();
      if (db && (localServiceable || (await operation.canServeLocal(db, variables as never)))) {
        // Real offline value that `onlineManager` called online — counted as its
        // own lane so the north-star doesn't lose captive-portal / dead-upstream
        // sessions (#4317).
        recordOfflineRead({
          lane: 'network_error_local',
          surface: operation.surface,
          boardName: operation.boardNameOf(variables as never),
        });
        return (await operation.resolveLocal(db, variables as never)) as TResponse;
      }
    }
    throw networkError;
  }
}
