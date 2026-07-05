import { onlineManager } from '@tanstack/react-query';
import type { Variables } from 'graphql-request';
import type { SQLiteDatabase } from 'expo-sqlite';
import { getDatabaseHandle } from '../../db';
import { searchClimbsLocal, countClimbsLocal, isOfflineSearchSupported } from '../../db/queries/search-climbs-local';
import { getClimbLocal } from '../../db/queries/get-climb-local';
import { isBoardDownloadedLocally } from '../../db/queries/board-download-status';
import { getHttpClient } from './client';
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
  canServeLocal: (db: SQLiteDatabase, variables: TVariables) => Promise<boolean>;
  // Returns the RAW GraphQL response shape (as if the server had answered).
  resolveLocal: (db: SQLiteDatabase, variables: TVariables) => Promise<TResponse>;
  offlineFallback: () => TResponse;
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

registerOfflineOperation<SearchClimbsQueryVariables, SearchClimbsQueryResponse>({
  document: SEARCH_CLIMBS,
  canServeLocal: canServeSearchLocal,
  resolveLocal: async (db, { input }) => ({ searchClimbs: await searchClimbsLocal(db, input) }),
  offlineFallback: () => ({ searchClimbs: { climbs: [], hasMore: false } }),
});

registerOfflineOperation<SearchClimbsQueryVariables, SearchClimbsCountQueryResponse>({
  document: SEARCH_CLIMBS_COUNT,
  canServeLocal: canServeSearchLocal,
  resolveLocal: async (db, { input }) => ({ searchClimbs: { totalCount: await countClimbsLocal(db, input) } }),
  offlineFallback: () => ({ searchClimbs: { totalCount: 0 } }),
});

registerOfflineOperation<GetClimbQueryVariables, GetClimbQueryResponse>({
  document: GET_CLIMB,
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
});

/**
 * Client-level interceptor: run the request local-first when the document is
 * registered and the active board can serve it, otherwise hit the network. Falls
 * through to plain HTTP for any unregistered document, so it's a safe drop-in for
 * `getHttpClient().request`.
 */
export async function offlineAwareRequest<TResponse>(document: string, variables?: Variables): Promise<TResponse> {
  const operation = OFFLINE_OPERATIONS.get(document);
  if (operation) {
    const db = getDatabaseHandle();
    // The `variables !== undefined` guard makes a registered document called
    // without variables degrade to HTTP rather than throw in a destructure;
    // the offline fallback below still applies either way.
    if (db && variables !== undefined && (await operation.canServeLocal(db, variables as never))) {
      return (await operation.resolveLocal(db, variables as never)) as TResponse;
    }
    if (!onlineManager.isOnline()) return operation.offlineFallback() as TResponse;
  }
  return getHttpClient().request<TResponse>(document, variables);
}
