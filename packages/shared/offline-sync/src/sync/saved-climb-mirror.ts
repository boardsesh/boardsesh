import type { OfflineDatabase } from '../database';
import type { OfflineBoardScope } from '../offline-board-key';
import { offlineBoardKey } from '../offline-board-key';
import { isScopeDownloadComplete } from './checkpoints';
import { getLocalUserId } from './local-user-owner';
import { runPullWrite } from './pull-write';
import { writePullDocuments } from './document-writer';
import { TABLE_CONFIGS } from './table-config';

class StaleMirrorError extends Error {}
function documentRow(document: unknown): Record<string, unknown> {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('Invalid canonical climb document');
  }
  return document as Record<string, unknown>;
}

/** Apply both canonical tables atomically, leaving every pull checkpoint untouched. */
export async function mirrorSavedClimb(
  db: OfflineDatabase,
  scope: OfflineBoardScope,
  climbUuid: string,
  result: { viewerId: string; climb: unknown; stats: unknown[] },
  canWrite: () => boolean,
): Promise<boolean> {
  const climb = documentRow(result.climb);
  const stats = result.stats.map(documentRow);
  if (
    climb.uuid !== climbUuid ||
    climb.board_type !== scope.boardType ||
    climb.layout_id !== scope.layoutId ||
    typeof result.viewerId !== 'string' ||
    result.viewerId.length === 0 ||
    stats.some((row) => row.board_type !== scope.boardType || row.climb_uuid !== climbUuid)
  ) {
    throw new Error('Canonical climb documents do not match the requested scope');
  }
  for (const document of [climb, ...stats]) {
    if (
      typeof document.updated_at !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T/.test(document.updated_at) ||
      !/^\d+$/.test(String(document.sync_seq))
    ) {
      throw new Error('Canonical climb documents are missing server versions');
    }
  }
  let committed = false;
  try {
    await runPullWrite(db, async (transaction) => {
      committed = false;
      if (!canWrite()) return;
      if (!(await isScopeDownloadComplete(transaction, offlineBoardKey(scope)))) return;
      if ((await getLocalUserId(transaction)) !== result.viewerId) return;
      if (!canWrite()) return;
      for (const [tableName, documents] of [
        ['board_climbs', [climb]],
        ['board_climb_stats', stats],
      ] as const) {
        const config = TABLE_CONFIGS[tableName];
        await writePullDocuments(
          transaction,
          tableName,
          documents,
          config.localColumns,
          config.transientColumns ?? [],
          true,
        );
        // A credential transition during a native bridge await must roll back
        // the earlier table too, rather than grafting a prior account's wall.
        if (!canWrite()) throw new StaleMirrorError();
      }
      committed = true;
    });
  } catch (error) {
    if (!(error instanceof StaleMirrorError)) throw error;
  }
  return committed;
}
