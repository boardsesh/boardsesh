import { isSizeScopedBoard } from '@boardsesh/board-config';
import {
  offlineBoardKey,
  parseOfflineBoardKey,
  isScopeDownloadComplete,
  type OfflineBoardScope,
  type OfflineDatabase,
} from '@boardsesh/offline-sync';

/**
 * Whether a board's exact (type, layout, size) scope is available to browse
 * offline: the user opted it in (its scope key is in syncEnabledBoards), its
 * INITIAL download finished (both reference tables pulled to the tail — a
 * first-page checkpoint must not serve a sliver of a 40k-climb catalog as if
 * it were everything), AND its climbs for that exact scope are present in
 * board_climbs. The scope must be exact — a board downloaded at one size is
 * NOT a valid local source for a different size of the same layout, since the
 * download is size-scoped. The row probe therefore mirrors the search-side
 * size filter: `compatible_size_ids` must contain the sizeId (skipped for
 * moonboard, which isn't size-scoped).
 *
 * `getSetting` (react-native-mmkv) is imported lazily so this module — pulled into
 * the search-hooks barrel via offline-request — doesn't drag react-native-mmkv (and
 * thus react-native's Flow entry) into the test collection-time module scan. The
 * pure `offlineBoardKey` stays a static import.
 */
export async function isBoardDownloadedLocally(db: OfflineDatabase, scope: OfflineBoardScope): Promise<boolean> {
  const { getSetting } = await import('../../settings/hooks');
  const scopeKey = offlineBoardKey(scope);
  if (!getSetting('syncEnabledBoards').includes(scopeKey)) return false;
  if (!(await isScopeDownloadComplete(db, scopeKey))) return false;

  const sizeScoped = isSizeScopedBoard(scope.boardType);
  const sizeClause = sizeScoped
    ? 'AND compatible_size_ids IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(compatible_size_ids) WHERE value = ?)'
    : '';
  const params = sizeScoped ? [scope.boardType, scope.layoutId, scope.sizeId] : [scope.boardType, scope.layoutId];

  const row = await db.getFirstAsync<{ has_rows: number }>(
    `SELECT EXISTS(SELECT 1 FROM board_climbs WHERE board_type = ? AND layout_id = ? ${sizeClause} LIMIT 1) AS has_rows`,
    params,
  );
  return (row?.has_rows ?? 0) === 1;
}

/**
 * Whether ANY (layout, size) scope of a board TYPE has a completed download.
 * The Boardsesh-grade queries (`boardseshGrade` / `boardseshGradesForAngles`)
 * carry only `boardName` + `climbUuid` (+ angle) — no layout/size — so they gate
 * on the board type, then read `board_climb_grades` by the exact (board_type,
 * climb_uuid, angle) key. A viewed climb from a non-downloaded scope of the same
 * board type simply misses (null row), and the single-row miss retries over the
 * network while online (see offline-request's isLocalMiss).
 *
 * `getSetting` (react-native-mmkv) is imported lazily for the same reason as
 * `isBoardDownloadedLocally` above — keep the MMKV/Flow entry out of the test
 * collection-time module scan.
 */
export async function isBoardTypeDownloadedLocally(db: OfflineDatabase, boardType: string): Promise<boolean> {
  const { getSetting } = await import('../../settings/hooks');
  for (const scopeKey of getSetting('syncEnabledBoards')) {
    if (parseOfflineBoardKey(scopeKey)?.boardType !== boardType) continue;
    if (await isScopeDownloadComplete(db, scopeKey)) return true;
  }
  return false;
}

/**
 * Whether the device holds any downloaded board catalog at all — one O(1) EXISTS
 * probe over board_climbs.
 *
 * The sign-out confirmation uses this rather than the `syncEnabledBoards` toggle
 * list or the `scope-complete:` markers, because the question it has to answer is
 * "will signing out delete a catalog?", and only the rows themselves answer that
 * honestly. The toggle list is intent, not disk state — a feature-flag rollback
 * clears it while the rows stay — and a `scope-complete:` marker is absent for a
 * partial mid-download that nonetheless has rows to lose. board_climbs holding any
 * row is exactly what `purgeLocalDataForSignOut` deletes.
 */
export async function hasDownloadedBoardData(db: OfflineDatabase): Promise<boolean> {
  const row = await db.getFirstAsync<{ has_rows: number }>(
    'SELECT EXISTS(SELECT 1 FROM board_climbs LIMIT 1) AS has_rows',
  );
  return (row?.has_rows ?? 0) === 1;
}

/**
 * Whether the layout a climb belongs to has a completed download, at any size.
 *
 * For reads keyed only by (board type, climb uuid) whose empty answer is a real
 * answer — the per-angle stats list comes back empty for a climb nobody has sent
 * yet — so "is anything of this board type downloaded" is not enough: a climb
 * from a layout that never synced would read as unsent instead of falling back
 * to the network. Stats sync with their layout's climbs, so a completed download
 * of the climb's own layout means its stats rows are all here.
 *
 * Short-circuits on the in-memory setting before touching SQLite, so a device
 * with nothing downloaded for this board type pays no probe. `getSetting` is
 * imported lazily for the same reason as `isBoardDownloadedLocally` above.
 */
export async function isClimbLayoutDownloadedLocally(
  db: OfflineDatabase,
  boardType: string,
  climbUuid: string,
): Promise<boolean> {
  const { getSetting } = await import('../../settings/hooks');
  const scopeKeysForType = getSetting('syncEnabledBoards').filter(
    (scopeKey) => parseOfflineBoardKey(scopeKey)?.boardType === boardType,
  );
  if (scopeKeysForType.length === 0) return false;

  const climb = await db.getFirstAsync<{ layout_id: number | null }>(
    'SELECT layout_id FROM board_climbs WHERE uuid = ? AND board_type = ? LIMIT 1',
    [climbUuid, boardType],
  );
  if (climb?.layout_id == null) return false;

  for (const scopeKey of scopeKeysForType) {
    if (parseOfflineBoardKey(scopeKey)?.layoutId !== climb.layout_id) continue;
    if (await isScopeDownloadComplete(db, scopeKey)) return true;
  }
  return false;
}
