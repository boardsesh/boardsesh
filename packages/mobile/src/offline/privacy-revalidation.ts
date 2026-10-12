import {
  captureCatalogCredential,
  stampCatalogViewer,
  holdCatalogViewer,
  isCatalogHeldFor,
  CATALOG_VIEWER_KEY,
  CATALOG_HELD_KEY,
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

// Another Boardsesh account's catalogue rows, which a new credential has not yet
// had re-authorized. NULL author ids are manufacturer catalogue data, except on
// spray walls.
const WITHDRAWN = `((user_id IS NOT NULL AND user_id <> ?) OR (board_type = 'spray' AND user_id IS NULL))`;
// Withdrawn rows that stay anyway. `is_draft` also arrives from server
// downloads, so only a draft without a positive server sequence may be unsynced
// work from an older account. A write still waiting to send keeps the climb it
// names. A dead letter does not: it only sends again if someone revives it, its
// replay carries its own payload, and the bin can hold it indefinitely, which
// would keep every downloaded board closed for as long.
const KEPT = `((COALESCE(is_draft, 0) = 1 AND COALESCE(sync_seq, 0) <= 0) OR EXISTS (
      SELECT 1 FROM pending_mutations mutation WHERE mutation.status <> 'dead_letter' AND json_valid(mutation.payload) AND (
        json_extract(mutation.payload, '$.climbUuid') = board_climbs.uuid OR
        json_extract(mutation.payload, '$.uuid') = board_climbs.uuid
      )
    ))`;
const REPLACEABLE = `${WITHDRAWN} AND NOT ${KEPT}`;
const HELD = `${WITHDRAWN} AND ${KEPT}`;

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
      () => db.runAsync('DELETE FROM sync_meta WHERE key IN (?, ?)', [CATALOG_VIEWER_KEY, CATALOG_HELD_KEY]),
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
          // The write lock is held, so what these find is exactly what the deletes
          // below remove. A pass that removes nothing has nothing to fetch again:
          // it keeps every checkpoint, completion marker and the holds index.
          const climbsToRemove = await transaction.getFirstAsync<{ found: number }>(
            `SELECT EXISTS (SELECT 1 FROM board_climbs WHERE ${REPLACEABLE}) AS found`,
            [viewerId],
          );
          const sprayWallsToRemove = await transaction.getFirstAsync<{ found: number }>(
            'SELECT EXISTS (SELECT 1 FROM spray_walls) AS found',
          );
          const removesRows = Boolean(climbsToRemove?.found) || Boolean(sprayWallsToRemove?.found);
          if (removesRows) {
            // Cleared before the climbs go: the index finds a layout's hold sets
            // through their climb rows.
            const layouts = await transaction.getAllAsync<{ board_type: string; layout_id: number }>(
              'SELECT DISTINCT board_type, layout_id FROM board_climbs WHERE layout_id IS NOT NULL',
            );
            for (const layout of layouts) {
              await clearLayoutHoldIndex(transaction, layout.board_type, layout.layout_id);
            }
          }
          // Stats/grades are keyed by climb rather than user, so remove them before
          // their author row. The viewer's own rows never match WITHDRAWN.
          for (const table of ['board_climb_stats', 'board_climb_grades']) {
            await transaction.runAsync(
              `DELETE FROM ${table} WHERE climb_uuid IN (SELECT uuid FROM board_climbs WHERE ${REPLACEABLE})`,
              [viewerId],
            );
          }
          await transaction.runAsync(`DELETE FROM board_climbs WHERE ${REPLACEABLE}`, [viewerId]);
          await transaction.runAsync('DELETE FROM spray_walls');
          await transaction.runAsync(
            'UPDATE board_climb_stats SET fa_username = NULL, fa_at = NULL WHERE fa_username IS NOT NULL OR fa_at IS NOT NULL',
          );
          await transaction.runAsync('DELETE FROM followed_author_snapshots');
          if (removesRows) {
            // A retained high-water mark would skip the removed rows forever. Keep
            // the artifact marker: an authenticated replay must not reinstall an old file.
            for (const table of BOARD_DATA_TABLES) {
              await transaction.runAsync('DELETE FROM sync_meta WHERE key LIKE ?', [`checkpoint:${table}:%`]);
            }
            await transaction.runAsync('DELETE FROM sync_meta WHERE key LIKE ?', ['scope-complete:%']);
            await transaction.runAsync(
              'DELETE FROM holds_index_climbs WHERE uuid NOT IN (SELECT uuid FROM board_climbs)',
            );
          }
          const held = await transaction.getFirstAsync<{ count: number }>(
            `SELECT count(*) AS count FROM board_climbs WHERE ${HELD}`,
            [viewerId],
          );
          assertCurrent();
          // Rows that had to stay keep reads closed. The held record lets a later
          // check reopen them once those rows are gone, without withdrawing again.
          if (held?.count) await holdCatalogViewer(transaction, viewerId, credential);
          else await stampCatalogViewer(transaction, viewerId, credential);
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

/**
 * Reopen a catalogue that a revalidation for this viewer and credential left
 * closed only for the rows it had to keep. Withdraws nothing, aborts nothing and
 * makes no request: it counts those rows again and stamps the marker once none
 * are left. Resolves true when it stamped.
 */
export async function reopenHeldCatalog(
  db: OfflineDatabase,
  viewerId: string,
  isCurrent: () => boolean = () => true,
): Promise<boolean> {
  const generation = revalidationGeneration;
  const isStillCurrent = () => generation === revalidationGeneration && isCurrent();
  await pendingRevalidation?.catch(() => {});
  if (!isStillCurrent()) return false;
  const credential = await captureCatalogCredential();
  if (!credential || !isStillCurrent()) return false;
  let stamped = false;
  await runLocalWriteWithRetry(
    () =>
      db.withExclusiveTransactionAsync(async (transaction) => {
        stamped = false;
        await beginImmediateWrite(transaction, OFFLINE_DB_BUSY_TIMEOUT_MS);
        // A revalidation requested since this began owns the catalogue now.
        if (!isStillCurrent() || !(await isCatalogHeldFor(transaction, viewerId, credential))) return;
        const held = await transaction.getFirstAsync<{ count: number }>(
          `SELECT count(*) AS count FROM board_climbs WHERE ${HELD}`,
          [viewerId],
        );
        if (held?.count || !isStillCurrent()) return;
        await stampCatalogViewer(transaction, viewerId, credential);
        stamped = true;
      }),
    backgroundWriteRetry,
  );
  return stamped && isStillCurrent();
}
