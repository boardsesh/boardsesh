import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { SQLiteDatabase } from 'expo-sqlite';
import { enqueue } from '../mutation-queue';
import { drainMutationQueue } from '../mutation-queue';
import type { GraphQLFetch } from '../mutation-queue/handlers';
import type { SaveTickMutationVariables } from '../lib/graphql/operations';

// The full SaveTickInput the UI builds (QuickTickBar / LogAscentSheet). Carries
// climbedAt + the optional sessionId/board-path fields, so the payload we enqueue
// is exactly what the backend's `input SaveTickInput` requires — no narrowing.
export type SaveTickInput = SaveTickMutationVariables['input'];

export type FavoriteInput = {
  boardName: string;
  climbUuid: string;
  angle: number;
};

/**
 * Local write + queue entry for a tick, committed in ONE exclusive transaction.
 * A partial failure that leaves a local row without its queue entry (or vice
 * versa) would never reach the server / would orphan the row, so both land
 * together or neither does.
 *
 * `tickUuid` is the row identity AND the idempotency key — a fresh random uuid
 * per call is correct because each tick is a distinct record. The full `input`
 * (including climbedAt, sessionId, and the board-path fields the backend needs)
 * is enqueued verbatim; the drainer folds `tickUuid` in as `input.uuid` for the
 * `ON CONFLICT (uuid) DO NOTHING` replay guard.
 *
 * Local columns are a subset of the payload (boardsesh_ticks has no
 * layout/size/set columns); the extra fields ride along only in the queued
 * payload, which is what reaches the backend.
 */
export async function writeTickLocal(db: SQLiteDatabase, input: SaveTickInput, tickUuid: string): Promise<void> {
  const now = new Date().toISOString();
  // climbedAt is required on the input; fall back to now only defensively.
  const climbedAt = input.climbedAt ?? now;
  const sessionId = input.sessionId ?? null;

  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.runAsync(
      `INSERT INTO boardsesh_ticks (uuid, board_type, climb_uuid, angle, status,
       attempt_count, quality, difficulty, comment, climbed_at, session_id, is_mirror, is_benchmark,
       created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tickUuid,
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

    await enqueue(txn, 'boardsesh_ticks', 'create', input, tickUuid);
  });
}

/**
 * Deterministic idempotency keys for favorites: the row is natural-keyed locally
 * (the PK omits the server id), so the key is derived from the target. Repeated
 * "add"/"remove" taps dedupe to a single queue row via enqueue's
 * INSERT OR IGNORE on idempotency_key.
 */
export function favoriteAddKey(input: FavoriteInput): string {
  return `add:user_favorites:${input.boardName}:${input.climbUuid}:${input.angle}`;
}

export function favoriteRemoveKey(input: FavoriteInput): string {
  return `del:user_favorites:${input.boardName}:${input.climbUuid}:${input.angle}`;
}

/** Local INSERT OR IGNORE + enqueue('create') for a favorite, in one transaction. */
export async function addFavoriteLocal(db: SQLiteDatabase, input: FavoriteInput): Promise<void> {
  const now = new Date().toISOString();

  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.runAsync(
      `INSERT OR IGNORE INTO user_favorites (board_name, climb_uuid, angle, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [input.boardName, input.climbUuid, input.angle, now, now],
    );

    await enqueue(txn, 'user_favorites', 'create', input, favoriteAddKey(input));
  });
}

/** Local DELETE + enqueue('delete') for a favorite, in one transaction. */
export async function removeFavoriteLocal(db: SQLiteDatabase, input: FavoriteInput): Promise<void> {
  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.runAsync(`DELETE FROM user_favorites WHERE board_name = ? AND climb_uuid = ? AND angle = ?`, [
      input.boardName,
      input.climbUuid,
      input.angle,
    ]);

    await enqueue(txn, 'user_favorites', 'delete', input, favoriteRemoveKey(input));
  });
}

// ── Follow hooks ──────────────────────────────────────────────────────────────
// Kept as standalone dual-write hooks: there is no mobile follow UI yet, so these
// stay un-wired (covered by tests, not call sites). When a follow UI lands they
// can be consumed directly, mirroring the tick/favorite consolidation in hooks.ts.

export function useOfflineFollowUser(db: SQLiteDatabase, graphqlFetch: GraphQLFetch) {
  const queryClient = useQueryClient();

  return useCallback(
    async (followingId: string) => {
      const now = new Date().toISOString();
      const idempotencyKey = `add:user_follows:${followingId}`;

      await db.withExclusiveTransactionAsync(async (txn) => {
        await txn.runAsync(
          `INSERT OR IGNORE INTO user_follows (following_id, created_at, updated_at)
           VALUES (?, ?, ?)`,
          [followingId, now, now],
        );

        await enqueue(txn, 'user_follows', 'create', { followingId }, idempotencyKey);
      });

      queryClient.invalidateQueries({ queryKey: ['followers'] });
      queryClient.invalidateQueries({ queryKey: ['following'] });

      drainMutationQueue(db, queryClient, graphqlFetch);
    },
    [db, queryClient, graphqlFetch],
  );
}

export function useOfflineUnfollowUser(db: SQLiteDatabase, graphqlFetch: GraphQLFetch) {
  const queryClient = useQueryClient();

  return useCallback(
    async (followingId: string) => {
      const idempotencyKey = `del:user_follows:${followingId}`;

      await db.withExclusiveTransactionAsync(async (txn) => {
        await txn.runAsync(`DELETE FROM user_follows WHERE following_id = ?`, [followingId]);

        await enqueue(txn, 'user_follows', 'delete', { followingId }, idempotencyKey);
      });

      queryClient.invalidateQueries({ queryKey: ['followers'] });
      queryClient.invalidateQueries({ queryKey: ['following'] });

      drainMutationQueue(db, queryClient, graphqlFetch);
    },
    [db, queryClient, graphqlFetch],
  );
}
