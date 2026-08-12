import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  applyBusyTimeout,
  enqueue,
  getLocalUserId,
  type EnqueueResult,
  type GraphQLFetch,
  type OfflineDatabase,
} from '@boardsesh/offline-sync';
import { drainMutationQueue } from '../offline/offline-sync-adapter';
import { reportEnqueueSuppressed } from '../offline/outbox-telemetry';
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

export async function writeTickLocal(db: OfflineDatabase, input: SaveTickInput, tickUuid: string): Promise<void> {
  const now = new Date().toISOString();
  const climbedAt = input.climbedAt ?? now;
  const sessionId = input.sessionId ?? null;

  await db.withExclusiveTransactionAsync(async (txn) => {
    // Own connection, busy_timeout defaults to 0 — wait for a held write lock
    // instead of failing this offline write instantly (BOARDSESH-AB/AX).
    await applyBusyTimeout(txn);
    // Stamp the owner so a local reader's `(user_id = ? OR user_id IS NULL)`
    // predicate can tell this tick from a previous account's leftovers. Rows
    // written before this existed stay NULL, which the `IS NULL` arm covers —
    // that arm cannot be dropped until every such row has synced back down.
    const ownerUserId = await getLocalUserId(txn);
    await txn.runAsync(
      `INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, status,
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
  });
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

  await db.withExclusiveTransactionAsync(async (txn) => {
    await applyBusyTimeout(txn);
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
    enqueueOutcome.result = await enqueue(txn, 'user_favorites', 'create', input, favoriteAddKey(input));
  });

  // The cancel DELETE above matches only `status = 'pending'`, so a
  // dead-lettered add keeps owning this UNIQUE key forever and every later add
  // for the same climb/angle is dropped right here — local row written, nothing
  // queued, nothing to drain. Reviving that row is a behaviour change with its
  // own issue; this makes the swallow countable.
  reportSuppressedEnqueue('user_favorites', 'create', enqueueOutcome);
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

  await db.withExclusiveTransactionAsync(async (txn) => {
    await applyBusyTimeout(txn);
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
}

export function useOfflineFollowUser(db: OfflineDatabase, graphqlFetch: GraphQLFetch) {
  const queryClient = useQueryClient();

  return useCallback(
    async (followingId: string) => {
      const now = new Date().toISOString();
      const idempotencyKey = `add:user_follows:${followingId}`;
      const enqueueOutcome = newEnqueueOutcome();

      await db.withExclusiveTransactionAsync(async (txn) => {
        await applyBusyTimeout(txn);
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

      queryClient.invalidateQueries({ queryKey: ['followers'] });
      queryClient.invalidateQueries({ queryKey: ['following'] });

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

      await db.withExclusiveTransactionAsync(async (txn) => {
        await applyBusyTimeout(txn);
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

      queryClient.invalidateQueries({ queryKey: ['followers'] });
      queryClient.invalidateQueries({ queryKey: ['following'] });

      scheduleDrain(db, queryClient, graphqlFetch);
    },
    [db, queryClient, graphqlFetch],
  );
}
