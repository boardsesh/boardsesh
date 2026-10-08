import type { SQLiteDatabase } from 'expo-sqlite';
import {
  forgetDownloadTrigger,
  forgetOfflineBoard,
  forgetOfflineBoardScope,
  forgetSprayWallArchive,
  forgetOwnedSprayWallPin,
  getSetting,
  offlineBoardKey,
  setOfflineBoardEnabled,
} from '../../settings';
import { reportAbandonedDownloadOnDisable } from '../../offline/abandoned-download-terminals';
import { clearSprayWallPrivateCaches } from './spray-privacy-cleanup';

/**
 * Everything this phone kept about a spray wall the climber just deleted: the
 * offline picker's card, the archive state the offline loader reads, the wall's
 * registration and its private photo caches, and its download.
 *
 * A wall's download scope is its own (`spray:<layoutId>:<layoutId>`, a wall has
 * exactly one size, itself), so turning it off cannot take a sibling board's
 * climbs with it, unlike a catalogue board's.
 */
export async function forgetDeletedSprayWall(
  wall: { uuid: string; layoutId: number },
  db: SQLiteDatabase | null,
): Promise<void> {
  forgetOfflineBoard(wall.uuid);
  forgetSprayWallArchive(wall.uuid);
  forgetOwnedSprayWallPin(wall.uuid);
  clearSprayWallPrivateCaches(wall.layoutId);
  const scope = { boardType: 'spray', layoutId: wall.layoutId, sizeId: wall.layoutId };
  const scopeKey = offlineBoardKey(scope);
  if (!getSetting('syncEnabledBoards').includes(scopeKey)) return;
  setOfflineBoardEnabled(scope, false);
  forgetOfflineBoardScope(scope);
  forgetDownloadTrigger(scopeKey);
  if (db) await reportAbandonedDownloadOnDisable(db, scopeKey);
}
