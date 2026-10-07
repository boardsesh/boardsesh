import { useEffect } from 'react';
import type { UserBoardConnection } from '@boardsesh/shared-schema';
import { rememberOfflineBoards, pruneOfflineBoards, useSetting, offlineBoardKeyForBoard } from '../settings';
import { useIsOffline } from '../hooks/use-is-offline';

/**
 * Keep the offline picker's board snapshots in step with the live `myBoards` list.
 *
 * `useBoardDownloads` snapshots a board at the moment offline is enabled, which
 * covers every new download. This hook covers the three gaps that leaves:
 *
 * - a board renamed or reconfigured on another device would otherwise show its old
 *   name offline forever;
 * - a board downloaded on a build that predates this feature has no snapshot at all,
 *   and is backfilled the next time this screen is open online;
 * - a board deleted or unfollowed on ANOTHER device would keep its card forever —
 *   nothing local ever fires for it — so a complete server list also prunes.
 *
 * Only boards whose scope is in `syncEnabledBoards` are remembered. Deliberately not
 * "or already downloaded": a plain "Available offline" toggle-off leaves the rows and
 * checkpoint on disk so re-enabling resumes instantly, so the scope stays downloaded
 * and this hook would re-remember the board the toggle just forgot. Enabled is also
 * sufficient for the pre-fix backfill — enabling is the only way to download.
 *
 * Not gated on the offline-downloads flag: this reads one setting, and a flag flipped
 * off must not strand a device that has downloads.
 */
/**
 * `archivedWallUuids` are the climber's archived spray walls. `myBoards` leaves
 * them out, so without them a complete list would prune an archived wall's card
 * and the wall could no longer be opened offline. Left out (unknown: a caller
 * without the list, or the list failed), no spray card is pruned at all.
 */
export function useRememberDownloadedBoards(
  connection: UserBoardConnection | undefined,
  archivedWallUuids?: readonly string[],
): void {
  const isOffline = useIsOffline();
  const [enabledBoards] = useSetting('syncEnabledBoards');
  const boards = connection?.boards;
  // Absent connection → assume incomplete, so the prune below can never run on a
  // list we have no reason to trust.
  const hasMore = connection?.hasMore ?? true;

  useEffect(() => {
    // Offline, `boards` is either stale or absent — refreshing from it would either
    // no-op or overwrite good snapshots with older ones.
    if (isOffline || !boards) return;
    const enabledScopes = new Set(enabledBoards);
    const downloadedBoards = boards.filter((board) => enabledScopes.has(offlineBoardKeyForBoard(board)));
    // `rememberOfflineBoards` skips the write when nothing changed, which is what
    // keeps this effect from churning every `useSetting` consumer on each refetch.
    rememberOfflineBoards(downloadedBoards);
    // Only a COMPLETE list can say a board is gone. `myBoards` pages at 20, so a
    // truncated first page would otherwise delete every card past it.
    if (!hasMore) {
      const known = [...boards.map((board) => board.uuid), ...(archivedWallUuids ?? [])];
      pruneOfflineBoards(known, archivedWallUuids ? undefined : { keepBoardType: 'spray' });
    }
  }, [isOffline, boards, hasMore, enabledBoards, archivedWallUuids]);
}
