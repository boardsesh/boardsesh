import type { QueryClient } from '@tanstack/react-query';
import {
  CLIMB_QUERY_KEY,
  INFINITE_SEARCH_CLIMBS_QUERY_KEY,
  SEARCH_CLIMBS_COUNT_QUERY_KEY,
  SEARCH_CLIMBS_QUERY_KEY,
} from '../graphql/query-keys';
import { reportError } from '../error-reporting';

/** Refresh one downloaded wall before its local-first climb readers refetch. */
async function refreshDownloadedWall(layoutId: number, queryClient: QueryClient): Promise<void> {
  // Keep native SQLite/MMKV imports off the query hook's collection-time path.
  const [{ getDatabaseHandle }, { isSchemaReady }, { isOfflineEngineEnabled }] = await Promise.all([
    import('../../db/connection'),
    import('../../db/schema-ready'),
    import('../offline-engine'),
  ]);
  const database = getDatabaseHandle();
  if (!database || !isSchemaReady() || !isOfflineEngineEnabled()) return;
  const { isBoardDownloadedLocally } = await import('../../db/queries/board-download-status');
  // Spray wall identity uses its layout ID as its sole size ID.
  const scope = { boardType: 'spray', layoutId, sizeId: layoutId };
  if (!(await isBoardDownloadedLocally(database, scope))) return;
  const [{ pullSync }, { getOfflineSyncHttpClient }] = await Promise.all([
    import('../../offline/offline-sync-adapter'),
    import('../graphql/client'),
  ]);
  // One scope and one engine invocation; the engine owns bounded delta paging.
  await pullSync(database, queryClient, (query, variables) => getOfflineSyncHttpClient().request(query, variables), {
    enabledBoards: [`spray:${layoutId}:${layoutId}`],
  });
}

/** The mutation already landed; a refresh failure must never invite re-publication. */
export async function refreshPublishedSprayClimbs(queryClient: QueryClient, layoutId: number): Promise<void> {
  try {
    await refreshDownloadedWall(layoutId, queryClient);
  } catch (error) {
    reportError(error);
  }
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: SEARCH_CLIMBS_QUERY_KEY }),
    queryClient.invalidateQueries({ queryKey: INFINITE_SEARCH_CLIMBS_QUERY_KEY }),
    queryClient.invalidateQueries({ queryKey: SEARCH_CLIMBS_COUNT_QUERY_KEY }),
    queryClient.invalidateQueries({ queryKey: CLIMB_QUERY_KEY }),
  ]);
}
