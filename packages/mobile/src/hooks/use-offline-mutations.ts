import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  beginImmediateWrite,
  enqueue,
  getLocalUserId,
  runLocalWriteWithRetry,
  OFFLINE_DB_FOREGROUND_WRITE_TIMEOUT_MS,
  OFFLINE_DB_RETRY_BUSY_TIMEOUT_MS,
  OFFLINE_DB_FALLBACK_BUSY_TIMEOUT_MS,
  type EnqueueResult,
  type GraphQLFetch,
  type OfflineDatabase,
  type SqlExecutor,
} from '@boardsesh/offline-sync';
import { drainMutationQueue } from '../offline/offline-sync-adapter';
import { reportEnqueueSuppressed } from '../offline/outbox-telemetry';
import { notifyOutboxChanged } from '../offline/outbox-store';
import { localWriteRetryOptions } from '../offline/local-write-telemetry';
import { takeInjectedWriteFault } from '../offline/dev/write-fault-injection';
import type { SaveTickMutationVariables } from '../lib/graphql/operations';

export type SaveTickInput = SaveTickMutationVariables['input'];

export type FavoriteInput = {
  boardName: string;
  climbUuid: string;
  angle: number;
};

function scheduleDrain(
  db: OfflineDatabase,
  queryClient: ReturnType<typeof useQueryClient>,
  graphqlFetch: GraphQLFetch,
) {
  void drainMutationQueue(db, queryClient, graphqlFetch).catch((error: unknown) => {
    if (__DEV__) {
      console.warn('[MutationQueue] drain failed after local write:', error);
    }
  });
}

/**
 * Run one local write through the shared retry ladder (issue #4315).
 *
 * Every write in this file is a single `withExclusiveTransactionAsync` task, so
 * losing the single-writer lock rolls back both the data row and the outbox row
 * it would have queued — the whole write vanishes and, for a tick, the send is
 * gone.
 *
 * The task opens IMMEDIATE rather than just arming `busy_timeout` (#4332). These
 * tasks read before they write — `getLocalUserId` for the owner stamp — and a
 * deferred transaction that reads first never reaches SQLite's busy handler when
 * it upgrades to a write, so the timeout was set and then ignored and a contended
 * tick died in about a millisecond. `beginImmediateWrite` takes the write lock up
 * front, which is the only way the wait below is real. Keep using it even in a
 * task that happens to write first today: the next person to add a read above the
 * INSERT would silently bring the bug back.
 *
 * Every statement inside `task` MUST be safe to re-run: a `SQLITE_BUSY` can
 * surface at COMMIT, so a retry can follow an attempt that actually landed.
 */
function runLocalWrite(
  db: OfflineDatabase,
  tableName: string,
  operation: 'create' | 'delete',
  task: (txn: SqlExecutor) => Promise<void>,
  budgetMs?: number,
): Promise<void> {
  return runLocalWriteWithRetry(
    async (attempt) => {
      if (__DEV__) {
        const injectedFault = takeInjectedWriteFault('before-task');
        if (injectedFault) throw injectedFault;
      }
      await db.withExclusiveTransactionAsync(async (txn) => {
        // Own connection, busy_timeout defaults to 0, and expo's `BEGIN` is
        // DEFERRED — arm the timeout and take the write lock in one step, or a
        // held lock fails this offline write instantly (BOARDSESH-AB/AX, #4332).
        await beginImmediateWrite(
          txn,
          attempt === 1 ? OFFLINE_DB_FOREGROUND_WRITE_TIMEOUT_MS : OFFLINE_DB_RETRY_BUSY_TIMEOUT_MS,
        );
        await task(txn);
      });
      if (__DEV__) {
        const injectedFault = takeInjectedWriteFault('after-commit');
        if (injectedFault) throw injectedFault;
      }
    },
    {
      ...localWriteRetryOptions(tableName, operation),
      ...(budgetMs === undefined ? {} : { budgetMs }),
    },
  );
}

export async function writeTickLocal(
  db: OfflineDatabase,
  input: SaveTickInput,
  tickUuid: string,
  budgetMs?: number,
): Promise<void> {
  const now = new Date().toISOString();
  const climbedAt = input.climbedAt ?? now;
  const sessionId = input.sessionId ?? null;

  await runLocalWrite(
    db,
    'boardsesh_ticks',
    'create',
    async (txn) => {
      // Stamp the owner so a local reader's `(user_id = ? OR user_id IS NULL)`
      // predicate can tell this tick from a previous account's leftovers. Rows
      // written before this existed stay NULL, which the `IS NULL` arm covers —
      // that arm cannot be dropped until every such row has synced back down.
      const ownerUserId = await getLocalUserId(txn);
      // OR IGNORE so a retried attempt is a no-op against a row the previous
      // attempt already committed: a `SQLITE_BUSY` can surface at COMMIT, which
      // makes "the transaction landed and still threw" a real shape. `uuid` is
      // the PRIMARY KEY, and every other statement here is already idempotent.
      await txn.runAsync(
        `INSERT OR IGNORE INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, status,
       attempt_count, quality, difficulty, comment, climbed_at, session_id, is_mirror, is_benchmark,
       created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          tickUuid,
          ownerUserId,
          input.boardType,
          input.climbUuid,
          input.angle,
          input.status,
          input.attemptCount,
          input.quality ?? null,
          input.difficulty ?? null,
          input.comment,
          climbedAt,
          sessionId,
          input.isMirror ? 1 : 0,
          input.isBenchmark ? 1 : 0,
          now,
          now,
        ],
      );

      // No suppressed-enqueue check here, and that is a property of the key, not
      // an oversight: every tick gets a fresh uuid, so this INSERT OR IGNORE can
      // never collide with an existing row. A future tick key derived from
      // climb+angle would inherit the favorites blind spot below — re-check then.
      await enqueue(txn, 'boardsesh_ticks', 'create', input, tickUuid);
    },
    budgetMs,
  );
  // The outbox is one row longer. Told AFTER the transaction resolves, never
  // inside it: the gauge re-reads the table, and a read issued under the write
  // lock this call is holding would contend with it. A rolled-back write never
  // gets here, so the banner can't count a send that vanished.
  notifyOutboxChanged();
}

/**
 * Last-chance tick write: the outbox row ONLY, no `boardsesh_ticks` row (issue
 * #4315).
 *
 * Called when `writeTickLocal` has already lost the lock. A queued mutation is
 * self-contained — the drainer replays it from the payload alone — so an
 * outbox-only row is enough for the send to reach the server. It is also a
 * strictly smaller target than the full write: one `INSERT OR IGNORE`, no owner
 * read, at a later instant with its own (shorter) `busy_timeout`. It still opens
 * IMMEDIATE — `enqueue` reads the existing row before it decides what to write.
 *
 * No owner stamp is needed: the server derives ownership from the authenticated
 * call. What the user gives up is documented at the call site — no local tick
 * row means no "waiting to sync" badge, and the tick is missing from the local
 * logbook if the app is killed before it drains.
 *
 * The payload and key are byte-identical to what `writeTickLocal` would have
 * queued, so the drain path is unchanged.
 */
export async function enqueueTickOutboxOnly(
  db: OfflineDatabase,
  input: SaveTickInput,
  tickUuid: string,
  budgetMs: number,
): Promise<void> {
  await runLocalWriteWithRetry(
    async () => {
      await db.withExclusiveTransactionAsync(async (txn) => {
        await beginImmediateWrite(txn, OFFLINE_DB_FALLBACK_BUSY_TIMEOUT_MS);
        await enqueue(txn, 'boardsesh_ticks', 'create', input, tickUuid);
      });
    },
    { ...localWriteRetryOptions('boardsesh_ticks', 'create'), maxAttempts: 2, budgetMs },
  );
  notifyOutboxChanged();
}

export function favoriteAddKey(input: FavoriteInput): string {
  return `add:user_favorites:${input.boardName}:${input.climbUuid}:${input.angle}`;
}

export function favoriteRemoveKey(input: FavoriteInput): string {
  return `del:user_favorites:${input.boardName}:${input.climbUuid}:${input.angle}`;
}

export async function addFavoriteLocal(db: OfflineDatabase, input: FavoriteInput): Promise<void> {
  const now = new Date().toISOString();
  // Captured inside the transaction, reported after it commits: the report
  // reaches Sentry/PostHog, and neither belongs on a held write lock. A holder
  // object rather than a `let` because TypeScript doesn't track assignments made
  // inside a callback.
  const enqueueOutcome = newEnqueueOutcome();

  await runLocalWrite(db, 'user_favorites', 'create', async (txn) => {
    // Same owner stamp as writeTickLocal — user_favorites has a user_id column
    // the dual-write never filled.
    const ownerUserId = await getLocalUserId(txn);
    await txn.runAsync(
      `INSERT OR IGNORE INTO user_favorites (board_name, climb_uuid, angle, user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [input.boardName, input.climbUuid, input.angle, ownerUserId, now, now],
    );

    await txn.runAsync(`DELETE FROM pending_mutations WHERE idempotency_key = ? AND status = 'pending'`, [
      favoriteRemoveKey(input),
    ]);
    // A retry re-runs this and reassigns the holder — last attempt wins, which
    // is the outcome that matters. Re-running `enqueue` against a row a previous
    // attempt committed reports `pending`, and reportEnqueueSuppressed only
    // fires on `dead_letter`, so a retry can never fake a suppressed-enqueue.
    enqueueOutcome.result = await enqueue(txn, 'user_favorites', 'create', input, favoriteAddKey(input));
  });

  // The cancel DELETE above matches only `status = 'pending'`, so a
  // dead-lettered add keeps owning this UNIQUE key forever and every later add
  // for the same climb/angle is dropped right here — local row written, nothing
  // queued, nothing to drain. Reviving that row is a behaviour change with its
  // own issue; this makes the swallow countable.
  reportSuppressedEnqueue('user_favorites', 'create', enqueueOutcome);
  // Fires even when the enqueue was suppressed: the transaction also DELETEs a
  // pending remove, so the queued count moved either way.
  notifyOutboxChanged();
}

type EnqueueOutcome = { result: EnqueueResult | null };

function newEnqueueOutcome(): EnqueueOutcome {
  return { result: null };
}

function reportSuppressedEnqueue(tableName: string, operation: 'create' | 'delete', outcome: EnqueueOutcome): void {
  const { result } = outcome;
  if (result === null || result.inserted) return;
  reportEnqueueSuppressed(tableName, operation, result.existingStatus);
}

export async function removeFavoriteLocal(db: OfflineDatabase, input: FavoriteInput): Promise<void> {
  const enqueueOutcome = newEnqueueOutcome();

  await runLocalWrite(db, 'user_favorites', 'delete', async (txn) => {
    await txn.runAsync(`DELETE FROM user_favorites WHERE board_name = ? AND climb_uuid = ? AND angle = ?`, [
      input.boardName,
      input.climbUuid,
      input.angle,
    ]);

    // Cancel a not-yet-drained add so an offline add->remove nets to no server
    // call — but ALWAYS enqueue the remove: the drainer doesn't mark rows
    // in-flight, so a cancel can "succeed" on a row whose mutation was already
    // sent (TOCTOU between peekPending and markCompleted). The server's
    // removeFavorite is an idempotent no-op when nothing exists, so the extra
    // remove is harmless in the truly-canceled case and corrective in the race.
    await txn.runAsync(`DELETE FROM pending_mutations WHERE idempotency_key = ? AND status = 'pending'`, [
      favoriteAddKey(input),
    ]);
    enqueueOutcome.result = await enqueue(txn, 'user_favorites', 'delete', input, favoriteRemoveKey(input));
  });

  reportSuppressedEnqueue('user_favorites', 'delete', enqueueOutcome);
  notifyOutboxChanged();
}

export function useOfflineFollowUser(db: OfflineDatabase, graphqlFetch: GraphQLFetch) {
  const queryClient = useQueryClient();

  return useCallback(
    async (followingId: string) => {
      const now = new Date().toISOString();
      const idempotencyKey = `add:user_follows:${followingId}`;
      const enqueueOutcome = newEnqueueOutcome();

      await runLocalWrite(db, 'user_follows', 'create', async (txn) => {
        await txn.runAsync(
          `INSERT OR IGNORE INTO user_follows (following_id, created_at, updated_at)
           VALUES (?, ?, ?)`,
          [followingId, now, now],
        );

        // Cancel a not-yet-drained unfollow (mirrors the favorites pair):
        // without this, offline follow→unfollow→follow leaves [add, del] in
        // the queue (the second add is INSERT OR IGNOREd away) and drains to
        // UNFOLLOWED — the opposite of the user's last action.
        await txn.runAsync(`DELETE FROM pending_mutations WHERE idempotency_key = ? AND status = 'pending'`, [
          `del:user_follows:${followingId}`,
        ]);
        enqueueOutcome.result = await enqueue(txn, 'user_follows', 'create', { followingId }, idempotencyKey);
      });

      reportSuppressedEnqueue('user_follows', 'create', enqueueOutcome);
      notifyOutboxChanged();

      void queryClient.invalidateQueries({ queryKey: ['followers'] });
      void queryClient.invalidateQueries({ queryKey: ['following'] });

      scheduleDrain(db, queryClient, graphqlFetch);
    },
    [db, queryClient, graphqlFetch],
  );
}

export function useOfflineUnfollowUser(db: OfflineDatabase, graphqlFetch: GraphQLFetch) {
  const queryClient = useQueryClient();

  return useCallback(
    async (followingId: string) => {
      const idempotencyKey = `del:user_follows:${followingId}`;
      const enqueueOutcome = newEnqueueOutcome();

      await runLocalWrite(db, 'user_follows', 'delete', async (txn) => {
        await txn.runAsync(`DELETE FROM user_follows WHERE following_id = ?`, [followingId]);

        // Cancel a not-yet-drained follow, but ALWAYS enqueue the unfollow —
        // same TOCTOU reasoning as removeFavoriteLocal: the canceled add may
        // already be in flight, and the server unfollow is an idempotent no-op.
        await txn.runAsync(`DELETE FROM pending_mutations WHERE idempotency_key = ? AND status = 'pending'`, [
          `add:user_follows:${followingId}`,
        ]);
        enqueueOutcome.result = await enqueue(txn, 'user_follows', 'delete', { followingId }, idempotencyKey);
      });

      reportSuppressedEnqueue('user_follows', 'delete', enqueueOutcome);
      notifyOutboxChanged();

      void queryClient.invalidateQueries({ queryKey: ['followers'] });
      void queryClient.invalidateQueries({ queryKey: ['following'] });

      scheduleDrain(db, queryClient, graphqlFetch);
    },
    [db, queryClient, graphqlFetch],
  );
}
