import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { SQLiteDatabase } from 'expo-sqlite';
import { enqueue } from '../mutation-queue';
import { drainMutationQueue } from '../mutation-queue';
import type { GraphQLFetch } from '../mutation-queue/handlers';
import type { SaveTickMutationVariables } from '../lib/graphql/operations';

export type SaveTickInput = SaveTickMutationVariables['input'];

export type FavoriteInput = {
  boardName: string;
  climbUuid: string;
  angle: number;
};

function scheduleDrain(db: SQLiteDatabase, queryClient: ReturnType<typeof useQueryClient>, graphqlFetch: GraphQLFetch) {
  void drainMutationQueue(db, queryClient, graphqlFetch).catch((error: unknown) => {
    if (__DEV__) {
      console.warn('[MutationQueue] drain failed after local write:', error);
    }
  });
}

export async function writeTickLocal(db: SQLiteDatabase, input: SaveTickInput, tickUuid: string): Promise<void> {
  const now = new Date().toISOString();
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

export function favoriteAddKey(input: FavoriteInput): string {
  return `add:user_favorites:${input.boardName}:${input.climbUuid}:${input.angle}`;
}

export function favoriteRemoveKey(input: FavoriteInput): string {
  return `del:user_favorites:${input.boardName}:${input.climbUuid}:${input.angle}`;
}

export async function addFavoriteLocal(db: SQLiteDatabase, input: FavoriteInput): Promise<void> {
  const now = new Date().toISOString();

  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.runAsync(
      `INSERT OR IGNORE INTO user_favorites (board_name, climb_uuid, angle, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [input.boardName, input.climbUuid, input.angle, now, now],
    );

    await txn.runAsync(`DELETE FROM pending_mutations WHERE idempotency_key = ? AND status = 'pending'`, [
      favoriteRemoveKey(input),
    ]);
    await enqueue(txn, 'user_favorites', 'create', input, favoriteAddKey(input));
  });
}

export async function removeFavoriteLocal(db: SQLiteDatabase, input: FavoriteInput): Promise<void> {
  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.runAsync(`DELETE FROM user_favorites WHERE board_name = ? AND climb_uuid = ? AND angle = ?`, [
      input.boardName,
      input.climbUuid,
      input.angle,
    ]);

    const canceledAdd = (await txn.runAsync(
      `DELETE FROM pending_mutations WHERE idempotency_key = ? AND status = 'pending'`,
      [favoriteAddKey(input)],
    )) as { changes?: number };

    if ((canceledAdd.changes ?? 0) === 0) {
      await enqueue(txn, 'user_favorites', 'delete', input, favoriteRemoveKey(input));
    }
  });
}

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

      scheduleDrain(db, queryClient, graphqlFetch);
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

      scheduleDrain(db, queryClient, graphqlFetch);
    },
    [db, queryClient, graphqlFetch],
  );
}
