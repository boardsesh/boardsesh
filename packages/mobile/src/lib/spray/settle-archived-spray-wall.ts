import type { QueryClient } from '@tanstack/react-query';
import { reportError } from '../error-reporting';
import { findRegisteredSprayWallByUuid, markSprayWallArchived } from './spray-wall-registry';
import { invalidateSprayWallRenderData, sprayWallRenderDataQueryKey } from './spray-wall-loader';
import { mySprayWallsQueryKey, sprayWallWithVersionsQueryKey } from './use-create-spray-wall';

/**
 * A reset's replacement just published on this device, which archived the wall
 * it replaces. Make every surface here say so without waiting out a cache.
 *
 * - The old wall's registry entry is marked archived at once, so its sheet, its
 *   climb list and the create entry points change in the same frame, then
 *   re-read so the server's own `archivedAt` replaces the local stamp.
 * - `myBoards` drops the old wall and `mySprayWalls` gains it as archived.
 *
 * Fire-and-forget: every call here is a cache invalidation, and under
 * `offlineFirst` a refetch can pause for as long as the app thinks it is offline.
 */
export function settleArchivedSprayWall(
  queryClient: QueryClient,
  archivedWallUuid: string,
  replacementUuid: string,
): void {
  const registered = findRegisteredSprayWallByUuid(archivedWallUuid);
  if (registered) {
    markSprayWallArchived(registered.layoutId, archivedWallUuid, {
      archivedAt: new Date().toISOString(),
      replacedByWallUuid: replacementUuid,
    });
    void invalidateSprayWallRenderData(queryClient, archivedWallUuid, registered.layoutId).catch(reportError);
  } else {
    void queryClient.invalidateQueries({ queryKey: sprayWallRenderDataQueryKey(archivedWallUuid) });
  }
  void queryClient.invalidateQueries({ queryKey: sprayWallWithVersionsQueryKey(archivedWallUuid) });
  void queryClient.invalidateQueries({ queryKey: mySprayWallsQueryKey });
  void queryClient.invalidateQueries({ queryKey: ['myBoards'] });
}
