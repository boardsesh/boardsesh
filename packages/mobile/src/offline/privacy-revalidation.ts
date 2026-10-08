import {
  captureCatalogCredential,
  stampCatalogViewer,
  CATALOG_VIEWER_KEY,
  beginCatalogInvalidation,
  finishCatalogInvalidation,
  isCatalogCredentialCurrent,
} from './catalog-access';
import {
  beginGlobalPurge,
  beginScopePurge,
  clearLayoutHoldIndex,
  applyBusyTimeout,
  parseOfflineBoardKey,
  purgeNamespaceKey,
  BOARD_DATA_TABLES,
  type OfflineDatabase,
} from '@boardsesh/offline-sync';

let pendingRevalidation: Promise<void> | null = null;
let pendingViewerId: string | null = null;
let revalidationFailed = false;

export function needsPrivacyRevalidation(): boolean {
  return pendingRevalidation !== null || revalidationFailed;
}

/** Local reads wait for the authorized catalogue to replace withdrawn copies. */
export async function waitForPrivacyRevalidation(): Promise<void> {
  await pendingRevalidation;
  if (revalidationFailed) throw new Error('Privacy revalidation is required before reading downloaded content');
}

/** Keep the climber's own writes; all other authored catalogue rows are replaceable cache. */
export function revalidatePrivateCatalog(
  db: OfflineDatabase,
  viewerId: string,
  enabledScopeKeys: readonly string[],
): Promise<void> {
  if (pendingRevalidation) {
    if (pendingViewerId === viewerId) return pendingRevalidation;
    return pendingRevalidation.catch(() => {}).then(() => revalidatePrivateCatalog(db, viewerId, enabledScopeKeys));
  }
  pendingViewerId = viewerId;
  // Abort old responses before taking the write lock, and latch each catalogue
  // namespace until the deletion commits. New pulls cannot write into that gap.
  beginGlobalPurge();
  beginCatalogInvalidation();
  revalidationFailed = true;
  const releases = enabledScopeKeys.flatMap((scopeKey) => {
    const scope = parseOfflineBoardKey(scopeKey);
    return scope ? [beginScopePurge(purgeNamespaceKey(scope))] : [];
  });
  const task = (async () => {
    // Persist withdrawal before contacting the server: an offline/crashed
    // revalidation cannot reopen the previous marker on the next launch.
    await db.runAsync('DELETE FROM sync_meta WHERE key = ?', [CATALOG_VIEWER_KEY]);
    const credential = await captureCatalogCredential();
    const [{ getHttpClient }, { GET_PROFILE }] = await Promise.all([
      import('../lib/graphql/client'),
      import('../lib/graphql/operations'),
    ]);
    const response = await getHttpClient().request<{ profile: { id: string } | null }>(GET_PROFILE);
    if (response.profile?.id !== viewerId || !isCatalogCredentialCurrent(credential)) {
      throw new Error('Account changed during catalogue authorization');
    }
    return db.withExclusiveTransactionAsync(async (transaction) => {
      await applyBusyTimeout(transaction);
      const layouts = await transaction.getAllAsync<{ board_type: string; layout_id: number }>(
        'SELECT DISTINCT board_type, layout_id FROM board_climbs WHERE layout_id IS NOT NULL',
      );
      for (const layout of layouts) {
        await clearLayoutHoldIndex(transaction, layout.board_type, layout.layout_id);
      }
      // Stats/grades are keyed by climb rather than user, so remove them before
      // their author row. NULL author ids remain valid manufacturer catalogue data.
      const withdrawn = `((user_id IS NOT NULL AND user_id <> ?) OR (board_type = 'spray' AND user_id IS NULL))`;
      // Drafts and queued writes may belong to a previous account after a failed
      // handover cleanup. Preserve them, but do not authorize this catalogue for
      // another viewer while those protected rows remain.
      const replaceable = `${withdrawn} AND COALESCE(is_draft, 0) <> 1 AND NOT EXISTS (
      SELECT 1 FROM pending_mutations mutation WHERE json_valid(mutation.payload) AND (
        json_extract(mutation.payload, '$.climbUuid') = board_climbs.uuid OR
        json_extract(mutation.payload, '$.uuid') = board_climbs.uuid
      )
    )`;
      for (const table of ['board_climb_stats', 'board_climb_grades']) {
        await transaction.runAsync(
          `DELETE FROM ${table} WHERE climb_uuid IN (SELECT uuid FROM board_climbs WHERE ${replaceable})`,
          [viewerId],
        );
      }
      await transaction.runAsync(`DELETE FROM board_climbs WHERE ${replaceable}`, [viewerId]);
      await transaction.runAsync('UPDATE board_climb_stats SET fa_username = NULL, fa_at = NULL');
      await transaction.runAsync('DELETE FROM spray_walls');
      await transaction.runAsync('DELETE FROM followed_author_snapshots');
      // A retained high-water mark would skip the removed rows forever. Keep the
      // artifact marker: an authenticated replay must not reinstall an old file.
      for (const table of BOARD_DATA_TABLES) {
        await transaction.runAsync('DELETE FROM sync_meta WHERE key LIKE ?', [`checkpoint:${table}:%`]);
      }
      await transaction.runAsync('DELETE FROM sync_meta WHERE key LIKE ?', ['scope-complete:%']);
      await transaction.runAsync('DELETE FROM holds_index_climbs WHERE uuid NOT IN (SELECT uuid FROM board_climbs)');
      const preserved = await transaction.getFirstAsync<{ count: number }>(
        `SELECT count(*) AS count FROM board_climbs WHERE ${withdrawn}`,
        [viewerId],
      );
      if (preserved?.count) {
        await transaction.runAsync('DELETE FROM sync_meta WHERE key = ?', [CATALOG_VIEWER_KEY]);
      } else {
        await stampCatalogViewer(transaction, viewerId, credential);
      }
    });
  })();
  pendingRevalidation = task
    .then(() => {
      revalidationFailed = false;
      finishCatalogInvalidation();
    })
    .finally(() => {
      releases.forEach((release) => release());
      pendingRevalidation = null;
      pendingViewerId = null;
    });
  return pendingRevalidation;
}
