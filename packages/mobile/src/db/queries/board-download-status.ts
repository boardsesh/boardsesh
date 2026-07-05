import type { SQLiteDatabase } from 'expo-sqlite';
import { offlineBoardKey, type OfflineBoardScope } from '../../settings/offline-board-key';

/**
 * Whether a board's exact (type, layout, size) scope is available to browse
 * offline: the user opted it in (its scope key is in syncEnabledBoards) AND its
 * layout's climbs have actually landed in board_climbs. The scope must be exact —
 * a board downloaded at one size is not a valid local source for a different size
 * of the same layout, since the download is size-scoped.
 *
 * `getSetting` (react-native-mmkv) is imported lazily so this module — pulled into
 * the search-hooks barrel via offline-search — doesn't drag react-native-mmkv (and
 * thus react-native's Flow entry) into the test collection-time module scan. The
 * pure `offlineBoardKey` stays a static import.
 */
export async function isBoardDownloadedLocally(db: SQLiteDatabase, scope: OfflineBoardScope): Promise<boolean> {
  const { getSetting } = await import('../../settings/hooks');
  if (!getSetting('syncEnabledBoards').includes(offlineBoardKey(scope))) return false;
  const row = await db.getFirstAsync<{ has_rows: number }>(
    'SELECT EXISTS(SELECT 1 FROM board_climbs WHERE board_type = ? AND layout_id = ? LIMIT 1) AS has_rows',
    [scope.boardType, scope.layoutId],
  );
  return (row?.has_rows ?? 0) === 1;
}
