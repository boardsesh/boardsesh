import type { OfflineDatabase } from '../database';
import { removeClimbFromHoldIndex } from '../holds-index/hold-index';
import { runPullWrite } from './pull-write';

/**
 * Drop a climb the server has just hard-deleted from this device, at once,
 * instead of waiting for its tombstone to arrive on the next pull (#5960).
 *
 * Mirrors what the tombstone path does for a `board_climbs` deletion: the climb
 * row, its stats and grades, and its postings in the device-derived holds index.
 * It also drops this account's own favourite and playlist rows for the climb;
 * the server removed them in the same transaction and their user-scoped
 * tombstones will say the same thing on the next pull.
 *
 * Pull checkpoints are left alone, so the ordinary pull still replays the
 * server's tombstones, which then find nothing to delete. Returns whether a
 * climb row was removed. `canWrite` is re-checked inside the write lock, so a
 * sign-out that lands first leaves the database untouched.
 */
export async function removeDeletedClimbLocally(
  db: OfflineDatabase,
  climb: { uuid: string; boardType: string },
  canWrite: () => boolean,
): Promise<boolean> {
  let removed = false;
  await runPullWrite(db, async (transaction) => {
    removed = false;
    if (!canWrite()) return;
    const row = await transaction.getFirstAsync<{ layout_id: number | null }>(
      'SELECT layout_id FROM board_climbs WHERE uuid = ? AND board_type = ?',
      [climb.uuid, climb.boardType],
    );
    await transaction.runAsync('DELETE FROM board_climb_stats WHERE board_type = ? AND climb_uuid = ?', [
      climb.boardType,
      climb.uuid,
    ]);
    await transaction.runAsync('DELETE FROM board_climb_grades WHERE board_type = ? AND climb_uuid = ?', [
      climb.boardType,
      climb.uuid,
    ]);
    // No user filter on the favourite and playlist deletes: the local database
    // holds one account's data at a time (sign-out clears it, and every write is
    // fenced by `canWrite`), so every row here is the signed-in climber's own.
    await transaction.runAsync('DELETE FROM user_favorites WHERE board_name = ? AND climb_uuid = ?', [
      climb.boardType,
      climb.uuid,
    ]);
    // Climb uuids are unique across boards, and the local table carries no board.
    await transaction.runAsync('DELETE FROM playlist_climbs WHERE climb_uuid = ?', [climb.uuid]);
    const deleted = await transaction.runAsync('DELETE FROM board_climbs WHERE uuid = ? AND board_type = ?', [
      climb.uuid,
      climb.boardType,
    ]);
    removed = (deleted?.changes ?? 0) > 0;
    if (removed && row?.layout_id != null) {
      await removeClimbFromHoldIndex(transaction, {
        uuid: climb.uuid,
        boardType: climb.boardType,
        layoutId: row.layout_id,
      });
    }
  });
  return removed;
}
