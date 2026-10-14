import { useQuery } from '@tanstack/react-query';
import { measureReclaimableBytes } from '@boardsesh/offline-sync';
import { useOfflineDatabase } from '../../../db/use-offline-database';
import { RECLAIMABLE_VISIBLE_BYTES } from '../../../db/storage-usage';
import { useDownloadedScopeKeys } from '../../../offline/use-downloaded-scope-keys';
import { useOfflineDownloadsEnabled } from '../../../providers/feature-flags-provider';

/**
 * Whether to offer the Storage page: what the offline downloads occupy, and how
 * to get it back.
 *
 * Deliberately NOT gated on the offline flag alone. That flag is a kill switch:
 * a climber who downloaded gigabytes while it was on and then got rolled back
 * would otherwise have no way to reclaim them, which is the very gap the Storage
 * page exists to close. So it also shows when this phone still holds downloaded
 * boards from before (a rollback, or a sign-out, which clears
 * `syncEnabledBoards` but deliberately keeps the rows as the shared cache).
 */
export function useShowStorage(): boolean {
  const offlineEnabled = useOfflineDownloadsEnabled();
  const db = useOfflineDatabase();
  // One cheap indexed read. Shares the ['downloadedScopeKeys'] cache entry with
  // My Boards, so this warms it.
  const { data: downloadedScopeKeys } = useDownloadedScopeKeys();
  // ...AND when a removal deleted its rows but the compaction never landed, so
  // the freelist still holds real space. That state clears the scope-complete
  // markers (so `downloadedScopeKeys` is empty) and can coincide with the flag
  // being off, which would hide the one page that can reclaim it. Two O(1)
  // pragmas.
  const { data: reclaimableBytes = 0 } = useQuery({
    queryKey: ['offlineReclaimableBytes'],
    queryFn: () => measureReclaimableBytes(db),
  });
  return offlineEnabled || (downloadedScopeKeys?.length ?? 0) > 0 || reclaimableBytes >= RECLAIMABLE_VISIBLE_BYTES;
}
