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
  resetPrivacyScopedProtectedSyncState,
  resetProtectedSyncState,
  runLocalWriteWithRetry,
  CATALOGUE_PREPARED_FOR_KEY,
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
 *  - the pull of rows whose visibility depends on privacy, which is a spray
 *    wall's (`isProtectedSyncAllowed` in the sync adapter reads
 *    `needsPrivacyRevalidation`), until the purge below has committed;
 *  - any such page, or a saved-climb mirror, already on its way: the engine's
 *    protected-withdrawal fence drops it.
 *
 * Nothing of a catalogue board is fenced or stopped (issue #6306). This used to
 * bump the engine's GLOBAL purge epoch and purge every enabled scope, which
 * aborted artifact transfers, imports and the paged download of the public
 * catalogue. A privacy event arrives on every launch and reconnect, so a large
 * board's download restarted from nothing each time.
 */
export function requirePrivacyRevalidation(): void {
  revalidationGeneration += 1;
  beginProtectedWithdrawal();
  beginCatalogInvalidation();
  revalidationFailed = true;
}
let revalidationFailed = false;
let catalogOutboxRepairViewer: string | null = null;

/** A queued write still protects a foreign row that must go before local reads reopen. */
export function needsCatalogOutboxRepair(viewerId: string): boolean {
  return catalogOutboxRepairViewer === viewerId;
}
const backgroundWriteRetry = {
  maxAttempts: OFFLINE_BACKGROUND_WRITE_MAX_ATTEMPTS,
  retryDelayMs: OFFLINE_BACKGROUND_WRITE_RETRY_DELAY_MS,
  budgetMs: OFFLINE_BACKGROUND_WRITE_BUDGET_MS,
};

/** Persist an already withdrawn marker while identity/capability is still loading. */
export function persistCatalogWithdrawal(db: OfflineDatabase, isCurrent: () => boolean = () => true): Promise<void> {
  const generation = revalidationGeneration;
  const previous = pendingRevalidation;
  const current = () => generation === revalidationGeneration && isCurrent();
  const task = (async () => {
    if (previous) await previous.catch(() => {});
    if (!current()) return;
    await runLocalWriteWithRetry(async () => {
      if (current()) await db.runAsync('DELETE FROM sync_meta WHERE key = ?', [CATALOG_VIEWER_KEY]);
    }, backgroundWriteRetry);
  })();
  const completion = task.finally(() => {
    if (pendingRevalidation === completion) pendingRevalidation = null;
  });
  // Full authorization waits for this write too. A delayed withdrawal must not
  // delete the marker that a newer repair has already authorized.
  pendingRevalidation = completion;
  return completion;
}

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

function inBatches<Item>(items: readonly Item[]): Item[][] {
  const batches: Item[][] = [];
  for (let start = 0; start < items.length; start += UUIDS_PER_STATEMENT) {
    batches.push(items.slice(start, start + UUIDS_PER_STATEMENT));
  }
  return batches;
}

type RemovableClimb = { uuid: string; board_type: string | null; layout_id: number | null };

// A copy is replaceable cache when the server has a version of it and no queued
// write still refers to it. `is_draft` also arrives from server downloads, so a
// positive `sync_seq` is what proves the server has it; a row with none may be
// work that has not synced, and it is kept.
const IS_REPLACEABLE = `(COALESCE(sync_seq, 0) > 0 AND NOT EXISTS (
    SELECT 1 FROM pending_mutations mutation WHERE json_valid(mutation.payload) AND (
      json_extract(mutation.payload, '$.climbUuid') = board_climbs.uuid OR
      json_extract(mutation.payload, '$.uuid') = board_climbs.uuid
    )
  ))`;

/**
 * Delete these climbs with everything that hangs off them: stats, grades, and
 * their place in the derived holds index. Keyed by uuid throughout.
 */
async function deleteClimbsWithDependents(transaction: SqlExecutor, climbs: readonly RemovableClimb[]): Promise<void> {
  // Stats and grades are keyed by climb, and go before it. Grouped by board
  // type so each delete seeks the (board_type, climb_uuid, angle) primary key;
  // without the board type it would scan the table per batch.
  const uuidsByBoardType = new Map<string | null, string[]>();
  for (const climb of climbs) {
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

  // The holds index holds each climb's holds under its uuid, so those rows go
  // with the climb. An indexed climb's local id would stay behind in its
  // layout's postings, so a layout that lost one loses its postings and
  // watermarks too and rebuilds. A layout that lost nothing the index held
  // (drafts and unlisted climbs are never indexed) keeps its index.
  const uuids = climbs.map((climb) => climb.uuid);
  const indexedUuids = new Set(await dropHoldIndexRowsForClimbs(transaction, uuids));
  for (const batch of inBatches(uuids)) {
    await transaction.runAsync(`DELETE FROM board_climbs WHERE uuid IN (${batch.map(() => '?').join(', ')})`, batch);
  }
  const layoutsThatLostIndexedClimbs = new Map<string, { boardType: string; layoutId: number }>();
  for (const climb of climbs) {
    if (!indexedUuids.has(climb.uuid) || climb.board_type === null || climb.layout_id === null) continue;
    layoutsThatLostIndexedClimbs.set(`${climb.board_type}:${climb.layout_id}`, {
      boardType: climb.board_type,
      layoutId: climb.layout_id,
    });
  }
  for (const { boardType, layoutId } of layoutsThatLostIndexedClimbs.values()) {
    await invalidateLayoutHoldIndex(transaction, boardType, layoutId, { dropPostings: true });
  }
}

/**
 * What a privacy event withdraws: the rows whose visibility depends on privacy,
 * which is spray walls and nothing else. One transaction, so a cursor can never
 * outlive the rows it covered.
 *
 * A published climb on a catalogue board is public whoever set it, and that
 * board's protected rows are the climber's own, so nothing of a catalogue board
 * is deleted, no cursor of one is reset, and `board_climbs` is not scanned: the
 * one read below seeks the wall rows through the `board_type` index. This runs
 * on every launch.
 *
 * Returns how many withdrawn wall climbs had to be kept (unsynced work, or a
 * row a queued write refers to).
 */
async function withdrawWallRows(transaction: SqlExecutor, viewerId: string): Promise<number> {
  const wallClimbs = await transaction.getAllAsync<RemovableClimb & { is_replaceable: number }>(
    `SELECT uuid, board_type, layout_id, ${IS_REPLACEABLE} AS is_replaceable
     FROM board_climbs WHERE board_type = 'spray' AND (user_id IS NULL OR user_id <> ?)`,
    [viewerId],
  );
  const replaceable = wallClimbs.filter((climb) => climb.is_replaceable === 1);
  await deleteClimbsWithDependents(transaction, replaceable);

  // A wall has no local access predicate at all, so every one goes and the
  // server is asked again; the spray photo files are cleared by the caller.
  await transaction.runAsync('DELETE FROM spray_walls');
  await transaction.runAsync('DELETE FROM followed_author_snapshots');

  // A wall's protected cursor would skip the removed rows forever. Every other
  // cursor, the `scope-complete:` markers and the artifact markers stay: nothing
  // they describe was deleted.
  await resetPrivacyScopedProtectedSyncState(transaction);

  return wallClimbs.length - replaceable.length;
}

/** Marks a preparation done by this version of the rule, for one account. */
// Re-run preparation after the prior mutable-outbox scan could skip a row.
const PREPARED_RULE_VERSION = '3';
/** Climbs deleted per transaction while preparing, so no single hold is long. */
const PREPARE_BATCH_CLIMBS = 2000;
/** Stats rows examined per transaction by the first-ascent scrub. */
const SCRUB_BATCH_ROWIDS = 50_000;

type PreparedFlag = { viewerId: string; keptForeignRows: number };

function parsePreparedFlag(raw: string | undefined): PreparedFlag | null {
  if (!raw) return null;
  const [ruleVersion, keptForeignRows, ...viewerParts] = raw.split(':');
  const kept = Number(keptForeignRows);
  if (ruleVersion !== PREPARED_RULE_VERSION || !Number.isInteger(kept) || viewerParts.length === 0) return null;
  return { viewerId: viewerParts.join(':'), keptForeignRows: kept };
}

/**
 * Make the downloaded catalogue fit the account that is signed in. Runs ONCE
 * per account on a device, and again only when that changes: another account
 * signs in, or a bundle from before the two-stream sync has run in between
 * (see CATALOGUE_PREPARED_FOR_KEY). A privacy event does not come here.
 *
 *  1. Forget every protected cursor. On a catalogue board that stream is one
 *     climber's own drafts and unlisted climbs, so the previous account's
 *     cursor would skip this account's rows below it. A sign-out resets them
 *     too, but one performed by an earlier bundle did not know they existed.
 *  2. Delete the climbs only their owner is sent, where the owner is not this
 *     climber: a draft or an unlisted climb the server has a version of. That
 *     is what an earlier bundle downloaded for everyone, and what the previous
 *     account left behind. The usual protections hold: a row with no server
 *     sequence stays, a row a queued write refers to stays, the climber's own
 *     rows stay.
 *  3. Blank every first-ascent name and date an earlier bundle stored. The
 *     device no longer stores the pair at all (`STATS_FIRST_ASCENT_COLUMNS`):
 *     no reader selects it, and where it came from a Boardsesh tick it named
 *     a climber whose privacy can change. Nothing writes the columns from here
 *     on, so one pass is all there is to do. It goes away with the migration
 *     that drops the two columns.
 *
 * Batched in short transactions: step 2 is tens of thousands of rows on a
 * board downloaded by an earlier bundle. Returns how many foreign rows step 2
 * had to keep; while that is not zero the catalogue stays closed, and the next
 * revalidation looks again.
 */
async function prepareCatalogueForViewer(
  db: OfflineDatabase,
  viewerId: string,
  assertCurrent: () => void,
): Promise<number> {
  const stored = parsePreparedFlag(
    (
      await db.getFirstAsync<{ value: string }>('SELECT value FROM sync_meta WHERE key = ?', [
        CATALOGUE_PREPARED_FOR_KEY,
      ])
    )?.value,
  );
  if (stored?.viewerId === viewerId && stored.keptForeignRows === 0) return 0;

  const inWriteTransaction = (body: (transaction: SqlExecutor) => Promise<void>): Promise<void> =>
    runLocalWriteWithRetry(
      () =>
        db.withExclusiveTransactionAsync(async (transaction) => {
          assertCurrent();
          await beginImmediateWrite(transaction, OFFLINE_DB_BUSY_TIMEOUT_MS);
          assertCurrent();
          await body(transaction);
        }),
      backgroundWriteRetry,
    );

  if (stored?.viewerId !== viewerId) await inWriteTransaction(resetProtectedSyncState);

  // Only its owner is sent a draft or an unlisted climb. NULL reads as the
  // server reads it: not a draft, and not listed. `rowid` keyset, so the table
  // is walked once however many batches that takes. Candidate selection never
  // depends on queued writes: delivery can make an already-passed row removable.
  const notThisClimbers = `(COALESCE(is_draft, 0) = 1 OR COALESCE(is_listed, 0) = 0) AND (user_id IS NULL OR user_id <> ?)`;
  let afterRowid = 0;
  for (;;) {
    const batch = await db.getAllAsync<RemovableClimb & { rowid: number }>(
      `SELECT rowid, uuid, board_type, layout_id FROM board_climbs
       WHERE rowid > ? AND ${notThisClimbers}
       ORDER BY rowid LIMIT ?`,
      [afterRowid, viewerId, PREPARE_BATCH_CLIMBS],
    );
    if (batch.length === 0) break;
    afterRowid = batch[batch.length - 1].rowid;
    await inWriteTransaction(async (transaction) => {
      // Still not this climber's and still replaceable, under this lock.
      const stillRemovable = await transaction.getAllAsync<RemovableClimb>(
        `SELECT uuid, board_type, layout_id FROM board_climbs
         WHERE rowid IN (${batch.map(() => '?').join(', ')}) AND ${notThisClimbers} AND ${IS_REPLACEABLE}`,
        [...batch.map((climb) => climb.rowid), viewerId],
      );
      await deleteClimbsWithDependents(transaction, stillRemovable);
    });
  }

  const lastStatsRow = await db.getFirstAsync<{ max_rowid: number | null }>(
    'SELECT MAX(rowid) AS max_rowid FROM board_climb_stats',
  );
  for (let fromRowid = 0; fromRowid < (lastStatsRow?.max_rowid ?? 0); fromRowid += SCRUB_BATCH_ROWIDS) {
    await inWriteTransaction(async (transaction) => {
      await transaction.runAsync(
        `UPDATE board_climb_stats SET fa_username = NULL, fa_at = NULL
         WHERE rowid > ? AND rowid <= ? AND (fa_username IS NOT NULL OR fa_at IS NOT NULL)`,
        [fromRowid, fromRowid + SCRUB_BATCH_ROWIDS],
      );
    });
  }

  // A passed row may become replaceable between batches. Count every foreign
  // remainder so reads stay closed and the next attempt scans it from rowid 0.
  const kept = await db.getFirstAsync<{ kept: number }>(
    `SELECT COUNT(*) AS kept FROM board_climbs WHERE ${notThisClimbers}`,
    [viewerId],
  );
  const keptForeignRows = kept?.kept ?? 0;
  await inWriteTransaction(async (transaction) => {
    await transaction.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
      CATALOGUE_PREPARED_FOR_KEY,
      `${PREPARED_RULE_VERSION}:${keptForeignRows}:${viewerId}`,
    ]);
  });
  return keptForeignRows;
}

/**
 * Bring the downloaded catalogue back in line after a privacy event: authorize
 * the viewer, prepare the catalogue for them if that has not been done, and
 * withdraw the wall rows the event may have taken away.
 */
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
  let preservedForeignRows = false;
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
    // Once per account, and before the catalogue is opened to it. A failure
    // here fails the revalidation, so the catalogue stays closed and the bridge
    // retries.
    const keptForeignRows = await prepareCatalogueForViewer(db, viewerId, assertCurrent);
    assertCurrent();
    if (!isCatalogCredentialCurrent(credential)) throw new Error('Account changed during catalogue revalidation');
    // Retry a rolled-back transaction on a fresh connection/snapshot. Acquire
    // the writer lock before the first read so busy_timeout can be honored.
    await runLocalWriteWithRetry(
      () =>
        db.withExclusiveTransactionAsync(async (transaction) => {
          assertCurrent();
          await beginImmediateWrite(transaction, OFFLINE_DB_BUSY_TIMEOUT_MS);
          assertCurrent();
          const preservedCount = keptForeignRows + (await withdrawWallRows(transaction, viewerId));
          preservedForeignRows = preservedCount > 0;
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
      catalogOutboxRepairViewer = preservedForeignRows ? viewerId : null;
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
