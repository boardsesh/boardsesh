import {
  captureCatalogCredential,
  stampCatalogViewer,
  CATALOG_VIEWER_KEY,
  beginCatalogInvalidation,
  finishCatalogInvalidation,
  isCatalogCredentialCurrent,
} from './catalog-access';
import {
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

/**
 * Close local reads synchronously, including when the schema is not ready yet.
 * Sync and downloads carry on: an event takes nothing from a catalogue board
 * that a page in flight could put back. Spray walls are purged per wall by
 * `revalidatePrivateCatalog`.
 */
export function requirePrivacyRevalidation(): void {
  revalidationGeneration += 1;
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

/**
 * `spray:<layoutId>` for every wall this device holds rows or sync markers for,
 * whether or not its download is still switched on. A first download writes its
 * start stamp before its first page, so a wall with no row yet is found too.
 */
async function listLocalSprayNamespaces(db: OfflineDatabase): Promise<string[]> {
  const walls = await db.getAllAsync<{ layout_id: number }>(
    `SELECT layout_id FROM spray_walls
     UNION SELECT layout_id FROM board_climbs WHERE board_type = 'spray' AND layout_id IS NOT NULL`,
  );
  const markers = await db.getAllAsync<{ key: string }>("SELECT key FROM sync_meta WHERE key LIKE '%:spray:%'");
  const namespaces = new Set(walls.map((wall) => purgeNamespaceKey({ boardType: 'spray', layoutId: wall.layout_id })));
  for (const marker of markers) {
    // Every per-scope key ends in its scope key, `spray:<layoutId>:<sizeId>`.
    const scope = parseOfflineBoardKey(marker.key.slice(marker.key.lastIndexOf(':spray:') + 1));
    if (scope) namespaces.add(purgeNamespaceKey(scope));
  }
  return [...namespaces];
}

/**
 * Re-authorize the downloaded catalogue for this viewer. A catalogue board keeps
 * its published, listed climbs, its cursors and its completion marker; another
 * account's drafts and unlisted climbs are withdrawn from it. Spray walls are
 * withdrawn whole and fetched again, because access to a wall depends on privacy.
 */
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
  // Spray walls only: their rows and cursors are reset below, so a page already
  // on the wire must not land afterwards. A catalogue scope keeps both, and
  // purging it would abort a download for nothing.
  const releases: (() => void)[] = [];
  const purgedSprayNamespaces = new Set<string>();
  const purgeSprayNamespace = (namespace: string) => {
    if (purgedSprayNamespaces.has(namespace)) return;
    purgedSprayNamespaces.add(namespace);
    releases.push(beginScopePurge(namespace));
  };
  for (const scopeKey of enabledScopeKeys) {
    const scope = parseOfflineBoardKey(scopeKey);
    if (scope?.boardType === 'spray') purgeSprayNamespace(purgeNamespaceKey(scope));
  }
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
    // A wall switched off mid-cycle has left the enabled list, but that cycle
    // still pulls it. Fence every wall with state on this device before the
    // server is contacted: a page that beats this lands ahead of the reset below
    // and is withdrawn by it, and nothing lands after.
    for (const namespace of await listLocalSprayNamespaces(db)) purgeSprayNamespace(namespace);
    assertCurrent();
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
          // On a catalogue board a climb that is published and listed stays, whatever
          // its author's privacy settings. A draft or an unlisted climb goes to its
          // owner alone, so another account's is withdrawn; a row that does not say
          // it is listed counts as unlisted. A spray wall gives up everything the
          // viewer did not author, because access to the wall itself depends on
          // privacy. NULL author ids on a catalogue board remain valid manufacturer
          // data.
          const withdrawn = `((user_id IS NOT NULL AND user_id <> ? AND (board_type = 'spray' OR COALESCE(is_draft, 0) = 1 OR COALESCE(is_listed, 0) <> 1))
      OR (board_type = 'spray' AND user_id IS NULL))`;
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
          // The holds index is cleared for every spray wall. A catalogue layout
          // keeps its index: drafts and unlisted climbs are never indexed, so the
          // rows it loses are not in it. The one exception is an index that has not
          // yet caught up with a climb that stopped being listed; clearing that
          // layout rebuilds it without the row.
          const layouts = await transaction.getAllAsync<{ board_type: string; layout_id: number }>(
            `SELECT DISTINCT board_type, layout_id FROM board_climbs
             WHERE layout_id IS NOT NULL AND (board_type = 'spray' OR (${replaceable} AND EXISTS (
               SELECT 1 FROM holds_index_climbs local_id
               JOIN board_climb_hold_sets hold_set ON hold_set.climb_id = local_id.id
               WHERE local_id.uuid = board_climbs.uuid
             )))`,
            [viewerId],
          );
          for (const layout of layouts) {
            await clearLayoutHoldIndex(transaction, layout.board_type, layout.layout_id);
          }
          // Stats/grades are keyed by climb rather than user, so remove them before
          // their author row.
          for (const table of ['board_climb_stats', 'board_climb_grades']) {
            await transaction.runAsync(
              `DELETE FROM ${table} WHERE climb_uuid IN (SELECT uuid FROM board_climbs WHERE ${replaceable})`,
              [viewerId],
            );
          }
          await transaction.runAsync(`DELETE FROM board_climbs WHERE ${replaceable}`, [viewerId]);
          // Only rows that still hold a credit: an unconditional UPDATE rewrote every
          // stats row of every downloaded board on each event (#6306).
          await transaction.runAsync(
            'UPDATE board_climb_stats SET fa_username = NULL, fa_at = NULL WHERE fa_username IS NOT NULL OR fa_at IS NOT NULL',
          );
          await transaction.runAsync('DELETE FROM spray_walls');
          await transaction.runAsync('DELETE FROM followed_author_snapshots');
          // A retained high-water mark would skip the withdrawn spray rows forever,
          // and a retained completion marker would serve a wall with holes in it.
          // A catalogue scope lost only rows this device is not meant to keep, so
          // its cursors and marker stay: deleting them made every event restart a
          // crawl of the whole board (#6306).
          for (const table of BOARD_DATA_TABLES) {
            await transaction.runAsync('DELETE FROM sync_meta WHERE key LIKE ?', [`checkpoint:${table}:spray:%`]);
          }
          await transaction.runAsync('DELETE FROM sync_meta WHERE key LIKE ?', ['scope-complete:spray:%']);
          await transaction.runAsync(
            'DELETE FROM holds_index_climbs WHERE uuid NOT IN (SELECT uuid FROM board_climbs)',
          );
          // What still matches `withdrawn` is a row this viewer must not read that
          // could not be deleted: another account's draft with no server version
          // (possibly its unsynced work), or its draft, unlisted climb or spray row
          // that a queued write still names. Access stays closed while one remains.
          // Published, listed catalogue climbs of other accounts are on every
          // device by design and are not counted.
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
