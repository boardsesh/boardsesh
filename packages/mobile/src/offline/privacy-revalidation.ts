import {
  captureCatalogCredential,
  stampCatalogViewer,
  CATALOG_VIEWER_KEY,
  beginCatalogInvalidation,
  finishCatalogInvalidation,
  isCatalogCredentialCurrent,
} from './catalog-access';
import {
  beginProtectedWithdrawal,
  beginImmediateWrite,
  dropHoldIndexRowsForClimbs,
  invalidateLayoutHoldIndex,
  resetProtectedSyncState,
  runLocalWriteWithRetry,
  LEGACY_FIRST_ASCENT_SCRUB_KEY,
  OFFLINE_DB_BUSY_TIMEOUT_MS,
  OFFLINE_BACKGROUND_WRITE_MAX_ATTEMPTS,
  OFFLINE_BACKGROUND_WRITE_RETRY_DELAY_MS,
  OFFLINE_BACKGROUND_WRITE_BUDGET_MS,
  type OfflineDatabase,
  type SqlExecutor,
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
 * Withdraw synchronously, including when the schema is not ready yet.
 *
 * Three gates close here, before anything is awaited:
 *  - local reads (`needsPrivacyRevalidation`, the catalogue read epoch);
 *  - the pull of protected rows (`isProtectedSyncAllowed` in the sync adapter
 *    reads `needsPrivacyRevalidation`), until the purge below has committed;
 *  - any protected page or saved-climb mirror already on its way: the engine's
 *    protected-withdrawal fence drops it.
 *
 * The fence is deliberately that narrow (issue #6306). This used to bump the
 * engine's GLOBAL purge epoch and purge every enabled scope, which aborted
 * artifact transfers, imports and the paged download of rows that are public
 * for every viewer. A privacy event arrives on every launch and reconnect, so
 * a large board's download restarted from nothing each time.
 */
export function requirePrivacyRevalidation(): void {
  revalidationGeneration += 1;
  beginProtectedWithdrawal();
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

/** SQLite's bound-parameter floor is 999; one statement binds a board type beside the uuids. */
const UUIDS_PER_STATEMENT = 900;

type WithdrawnClimb = {
  uuid: string;
  board_type: string | null;
  layout_id: number | null;
  is_replaceable: number;
};

function inBatches<Item>(items: readonly Item[]): Item[][] {
  const batches: Item[][] = [];
  for (let start = 0; start < items.length; start += UUIDS_PER_STATEMENT) {
    batches.push(items.slice(start, start + UUIDS_PER_STATEMENT));
  }
  return batches;
}

/**
 * The purge itself: delete every copy of another climber's protected row, and
 * reset the protected sync cursors so the server is asked again for the ones
 * this viewer may still see. One transaction, so a cursor can never outlive the
 * rows it covered.
 *
 * Three kinds of climb are withdrawn, each with its stats and grades:
 *  - a climb another climber owns;
 *  - a spray climb with no owner, because a wall is private;
 *  - a draft the viewer does not own. A draft is kept only for its owner, so
 *    one with no owner is kept for nobody.
 *
 * It runs on every privacy event, which is every launch, so it is written to
 * cost what was withdrawn rather than what is downloaded: ONE pass over
 * `board_climbs` finds the rows (there is no index on `user_id`, and adding one
 * is a schema migration), and everything after it is keyed by those uuids. The
 * reference catalogue, its cursors and the `scope-complete:` markers are not
 * touched. Returns how many withdrawn rows had to be kept.
 */
async function purgeWithdrawnRows(transaction: SqlExecutor, viewerId: string): Promise<number> {
  // NULL author ids are manufacturer catalogue data on every board but spray,
  // where a wall is private and a climb with no owner has no local access rule.
  // The exception is a draft: a draft belongs to its owner alone, so a draft
  // with a server version and no owner is withdrawn on every board. (A draft
  // another climber owns is already covered by the first arm.)
  const withdrawn = `((user_id IS NOT NULL AND user_id <> ?)
      OR (board_type = 'spray' AND user_id IS NULL)
      OR (user_id IS NULL AND COALESCE(is_draft, 0) = 1 AND COALESCE(sync_seq, 0) > 0))`;
  // is_draft also arrives from server downloads. A positive sync_seq proves
  // that copy is replaceable cache, unless a queued write still references
  // it. Keep drafts without a server version as possible unsynced work from
  // an older account, and keep access closed while those protected rows remain.
  // The viewer's own rows are already excluded by `withdrawn` above.
  const isReplaceable = `((COALESCE(is_draft, 0) <> 1 OR COALESCE(sync_seq, 0) > 0) AND NOT EXISTS (
      SELECT 1 FROM pending_mutations mutation WHERE json_valid(mutation.payload) AND (
        json_extract(mutation.payload, '$.climbUuid') = board_climbs.uuid OR
        json_extract(mutation.payload, '$.uuid') = board_climbs.uuid
      )
    ))`;
  const withdrawnClimbs = await transaction.getAllAsync<WithdrawnClimb>(
    `SELECT uuid, board_type, layout_id, ${isReplaceable} AS is_replaceable FROM board_climbs WHERE ${withdrawn}`,
    [viewerId],
  );
  const replaceableClimbs = withdrawnClimbs.filter((climb) => climb.is_replaceable === 1);

  // Stats and grades are keyed by climb rather than user, so they go before
  // their author row. Grouped by board type so each delete seeks the
  // (board_type, climb_uuid, angle) primary key; without the board type it
  // would scan a table of several hundred thousand rows per batch.
  const uuidsByBoardType = new Map<string | null, string[]>();
  for (const climb of replaceableClimbs) {
    const uuids = uuidsByBoardType.get(climb.board_type) ?? [];
    uuids.push(climb.uuid);
    uuidsByBoardType.set(climb.board_type, uuids);
  }
  for (const [boardType, uuids] of uuidsByBoardType) {
    for (const batch of inBatches(uuids)) {
      const uuidList = batch.map(() => '?').join(', ');
      for (const table of ['board_climb_stats', 'board_climb_grades']) {
        // A climb row with no board type cannot name the partition its
        // dependants are in, so that one case pays the scan.
        await (boardType === null
          ? transaction.runAsync(`DELETE FROM ${table} WHERE climb_uuid IN (${uuidList})`, batch)
          : transaction.runAsync(`DELETE FROM ${table} WHERE board_type = ? AND climb_uuid IN (${uuidList})`, [
              boardType,
              ...batch,
            ]));
      }
    }
  }

  // The derived holds index holds each climb's holds under its uuid, so those
  // rows go with the climb. An indexed climb's local id would stay behind in
  // its layout's postings, so a layout that lost one loses its postings and
  // watermarks too, and rebuilds once its protected rows are back. A layout
  // that lost nothing the index held (nothing at all, or only drafts, which
  // are never indexed) keeps its index.
  const replaceableUuids = replaceableClimbs.map((climb) => climb.uuid);
  const indexedUuids = new Set(await dropHoldIndexRowsForClimbs(transaction, replaceableUuids));
  for (const batch of inBatches(replaceableUuids)) {
    await transaction.runAsync(`DELETE FROM board_climbs WHERE uuid IN (${batch.map(() => '?').join(', ')})`, batch);
  }
  const layoutsThatLostIndexedClimbs = new Map<string, { boardType: string; layoutId: number }>();
  for (const climb of replaceableClimbs) {
    if (!indexedUuids.has(climb.uuid) || climb.board_type === null || climb.layout_id === null) continue;
    layoutsThatLostIndexedClimbs.set(`${climb.board_type}:${climb.layout_id}`, {
      boardType: climb.board_type,
      layoutId: climb.layout_id,
    });
  }
  for (const { boardType, layoutId } of layoutsThatLostIndexedClimbs.values()) {
    await invalidateLayoutHoldIndex(transaction, boardType, layoutId, { dropPostings: true });
  }

  // ONCE, not on every event. A bundle from before the two-stream sync stored a
  // first-ascent name the server had filled in for whoever was asking, so every
  // stats row may hold one. The protected stream ships none, so after this one
  // pass a row can only gain a name from the reference stream, where it is the
  // manufacturer's public credit. Blanking the whole table each time would
  // erase those for good now that the reference cursor is never reset, and it
  // rewrote several hundred thousand rows per launch. Nothing on the device
  // reads either column. See LEGACY_FIRST_ASCENT_SCRUB_KEY for how an older
  // bundle re-arms it.
  const alreadyScrubbed = await transaction.getFirstAsync<{ value: string }>(
    'SELECT value FROM sync_meta WHERE key = ?',
    [LEGACY_FIRST_ASCENT_SCRUB_KEY],
  );
  if (!alreadyScrubbed) {
    await transaction.runAsync(
      'UPDATE board_climb_stats SET fa_username = NULL, fa_at = NULL WHERE fa_username IS NOT NULL OR fa_at IS NOT NULL',
    );
    await transaction.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
      LEGACY_FIRST_ASCENT_SCRUB_KEY,
      '1',
    ]);
  }

  // A wall has no local access predicate at all, so every one goes and the
  // server is asked again; the spray photo files are cleared by the caller.
  await transaction.runAsync('DELETE FROM spray_walls');
  await transaction.runAsync('DELETE FROM followed_author_snapshots');

  // A retained protected cursor would skip the removed rows forever. The
  // reference cursors, the `scope-complete:` markers and the artifact marker
  // stay: nothing they describe was deleted, and without them a board would
  // read as not downloaded and crawl again from the start.
  await resetProtectedSyncState(transaction);

  return withdrawnClimbs.length - replaceableClimbs.length;
}

/** Keep the climber's own writes; all other authored catalogue rows are replaceable cache. */
export function revalidatePrivateCatalog(
  db: OfflineDatabase,
  viewerId: string,
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
    // the writer lock before the first read so busy_timeout can be honored.
    await runLocalWriteWithRetry(
      () =>
        db.withExclusiveTransactionAsync(async (transaction) => {
          assertCurrent();
          await beginImmediateWrite(transaction, OFFLINE_DB_BUSY_TIMEOUT_MS);
          assertCurrent();
          const preservedCount = await purgeWithdrawnRows(transaction, viewerId);
          if (preservedCount > 0) {
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
