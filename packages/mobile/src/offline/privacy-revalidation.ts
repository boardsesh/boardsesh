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
  beginImmediateWrite,
  runLocalWriteWithRetry,
  OFFLINE_DB_BUSY_TIMEOUT_MS,
  OFFLINE_BACKGROUND_WRITE_MAX_ATTEMPTS,
  OFFLINE_BACKGROUND_WRITE_RETRY_DELAY_MS,
  OFFLINE_BACKGROUND_WRITE_BUDGET_MS,
  parseOfflineBoardKey,
  purgeNamespaceKey,
  BOARD_DATA_TABLES,
  type OfflineDatabase,
} from '@boardsesh/offline-sync';
import { reportHandledError } from '../lib/error-reporting';

export class PrivacyRevalidationDeferredError extends Error {
  constructor() {
    super('Catalogue authorization is waiting for a foreground connection');
  }
}

let pendingRevalidation: Promise<void> | null = null;
let revalidationGeneration = 0;
const revalidationListeners = new Set<() => void>();

export function subscribePrivacyRevalidation(listener: () => void): () => void {
  revalidationListeners.add(listener);
  return () => {
    revalidationListeners.delete(listener);
  };
}

/** Withdraw synchronously, including when the schema is not ready yet. */
export function requirePrivacyRevalidation(): void {
  revalidationGeneration += 1;
  beginGlobalPurge();
  beginCatalogInvalidation();
  revalidationFailed = true;
}
let revalidationFailed = false;
const backgroundWriteRetry = {
  maxAttempts: OFFLINE_BACKGROUND_WRITE_MAX_ATTEMPTS,
  retryDelayMs: OFFLINE_BACKGROUND_WRITE_RETRY_DELAY_MS,
  budgetMs: OFFLINE_BACKGROUND_WRITE_BUDGET_MS,
};

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
  isCurrent: () => boolean = () => true,
  canAuthorize: () => boolean = () => true,
): Promise<void> {
  requirePrivacyRevalidation();
  const generation = revalidationGeneration;
  const previous = pendingRevalidation;
  const assertCurrent = () => {
    if (generation !== revalidationGeneration || !isCurrent()) {
      throw new Error('Catalogue revalidation was superseded');
    }
  };
  const releases = enabledScopeKeys.flatMap((scopeKey) => {
    const scope = parseOfflineBoardKey(scopeKey);
    return scope ? [beginScopePurge(purgeNamespaceKey(scope))] : [];
  });
  const task = (async () => {
    if (previous) await previous.catch(() => {});
    assertCurrent();
    // Persist withdrawal before contacting the server: an offline/crashed
    // revalidation cannot reopen the previous marker on the next launch.
    await runLocalWriteWithRetry(
      () => db.runAsync('DELETE FROM sync_meta WHERE key = ?', [CATALOG_VIEWER_KEY]),
      backgroundWriteRetry,
    );
    assertCurrent();
    if (!canAuthorize()) throw new PrivacyRevalidationDeferredError();
    let credential = await captureCatalogCredential();
    assertCurrent();
    const [{ getHttpClient }, { GET_PROFILE }] = await Promise.all([
      import('../lib/graphql/client'),
      import('../lib/graphql/operations'),
    ]);
    // The HTTP client may rotate an expiring token. Require a profile response
    // across a stable credential; a rotation gets one fresh authorization read.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await getHttpClient().request<{ profile: { id: string } | null }>(GET_PROFILE);
      assertCurrent();
      if (response.profile?.id !== viewerId || !isCatalogCredentialCurrent(credential)) {
        throw new Error('Account changed during catalogue authorization');
      }
      const afterResponse = await captureCatalogCredential();
      assertCurrent();
      if (!afterResponse || afterResponse.generation !== credential?.generation) {
        throw new Error('Account changed during catalogue authorization');
      }
      if (afterResponse.digest === credential.digest) break;
      if (attempt === 1) throw new Error('Credential kept changing during catalogue authorization');
      credential = afterResponse;
    }
    // Retry a rolled-back transaction on a fresh connection/snapshot. Acquire
    // the writer lock before the layout SELECT so busy_timeout can be honored.
    await runLocalWriteWithRetry(
      () =>
        db.withExclusiveTransactionAsync(async (transaction) => {
          assertCurrent();
          await beginImmediateWrite(transaction, OFFLINE_DB_BUSY_TIMEOUT_MS);
          assertCurrent();
          const layouts = await transaction.getAllAsync<{ board_type: string; layout_id: number }>(
            'SELECT DISTINCT board_type, layout_id FROM board_climbs WHERE layout_id IS NOT NULL',
          );
          for (const layout of layouts) {
            await clearLayoutHoldIndex(transaction, layout.board_type, layout.layout_id);
          }
          // Stats/grades are keyed by climb rather than user, so remove them before
          // their author row. NULL author ids remain valid manufacturer catalogue data.
          const withdrawn = `((user_id IS NOT NULL AND user_id <> ?) OR (board_type = 'spray' AND user_id IS NULL))`;
          // is_draft also arrives from server downloads. A positive sync_seq proves
          // that copy is replaceable cache, unless a queued write still references
          // it. Keep drafts without a server version as possible unsynced work from
          // an older account, and keep access closed while those protected rows remain.
          // The viewer's own rows are already excluded by `withdrawn` above.
          const replaceable = `${withdrawn} AND (COALESCE(is_draft, 0) <> 1 OR COALESCE(sync_seq, 0) > 0) AND NOT EXISTS (
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
          await transaction.runAsync(
            'DELETE FROM holds_index_climbs WHERE uuid NOT IN (SELECT uuid FROM board_climbs)',
          );
          const preserved = await transaction.getFirstAsync<{ count: number }>(
            `SELECT count(*) AS count FROM board_climbs WHERE ${withdrawn}`,
            [viewerId],
          );
          if (preserved?.count) {
            await transaction.runAsync('DELETE FROM sync_meta WHERE key = ?', [CATALOG_VIEWER_KEY]);
          } else {
            assertCurrent();
            await stampCatalogViewer(transaction, viewerId, credential);
          }
          assertCurrent();
          if (!isCatalogCredentialCurrent(credential)) throw new Error('Account changed during catalogue revalidation');
        }),
      backgroundWriteRetry,
    );
    assertCurrent();
    const completedCredential = await captureCatalogCredential();
    assertCurrent();
    if (!isCatalogCredentialCurrent(credential) || completedCredential?.digest !== credential?.digest) {
      throw new Error('Account changed during catalogue revalidation');
    }
  })();
  const completion = task
    .then(() => {
      assertCurrent();
      revalidationFailed = false;
      finishCatalogInvalidation();
    })
    .finally(() => {
      releases.forEach((release) => release());
      if (pendingRevalidation === completion) pendingRevalidation = null;
    })
    .then(() => {
      assertCurrent();
      for (const listener of revalidationListeners) {
        try {
          listener();
        } catch (error) {
          reportHandledError(error, { tags: { source: 'privacy-revalidation-listener' } });
        }
      }
    });
  pendingRevalidation = completion;
  return completion;
}
