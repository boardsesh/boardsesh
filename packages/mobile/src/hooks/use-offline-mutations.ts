import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { SQLiteDatabase } from 'expo-sqlite';
import { randomUUID } from 'expo-crypto';
import { enqueue } from '../mutation-queue';
import { drainMutationQueue } from '../mutation-queue';
import type { GraphQLFetch } from '../mutation-queue/handlers';

export type SaveTickInput = {
  boardType: string;
  climbUuid: string;
  angle: number;
  status: string;
  attemptCount: number;
  quality: number | null;
  difficulty: number | null;
  comment: string;
  isMirror: boolean;
  isBenchmark: boolean;
};

export type FavoriteInput = {
  boardName: string;
  climbUuid: string;
  angle: number;
};

export function useOfflineSaveTick(db: SQLiteDatabase, graphqlFetch: GraphQLFetch) {
  const queryClient = useQueryClient();

  return useCallback(
    async (tickData: SaveTickInput) => {
      // The tick uuid IS the row identity and the idempotency key, so a fresh
      // random uuid per call is correct — each tick is a distinct record.
      const tickUuid = randomUUID();
      const now = new Date().toISOString();

      // Local write + queue entry must commit together: a partial failure that
      // leaves a local row without its queue entry (or vice-versa) would never
      // reach the server / would orphan the row.
      await db.withExclusiveTransactionAsync(async (txn) => {
        await txn.runAsync(
          `INSERT INTO boardsesh_ticks (uuid, board_type, climb_uuid, angle, status,
           attempt_count, quality, difficulty, comment, climbed_at, is_mirror, is_benchmark,
           created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            tickUuid,
            tickData.boardType,
            tickData.climbUuid,
            tickData.angle,
            tickData.status,
            tickData.attemptCount,
            tickData.quality,
            tickData.difficulty,
            tickData.comment,
            now,
            tickData.isMirror ? 1 : 0,
            tickData.isBenchmark ? 1 : 0,
            now,
            now,
          ],
        );

        await enqueue(txn, 'boardsesh_ticks', 'create', tickData, tickUuid);
      });

      queryClient.invalidateQueries({ queryKey: ['ticks'] });
      queryClient.invalidateQueries({ queryKey: ['logbook'] });

      drainMutationQueue(db, queryClient, graphqlFetch);

      return tickUuid;
    },
    [db, queryClient, graphqlFetch],
  );
}

export function useOfflineAddFavorite(db: SQLiteDatabase, graphqlFetch: GraphQLFetch) {
  const queryClient = useQueryClient();

  return useCallback(
    async (input: FavoriteInput) => {
      const now = new Date().toISOString();
      // Favorites are natural-keyed locally (PK omits the server id), so the
      // idempotency key is derived from the target. A double-tap "add" dedupes to
      // a single queue row via enqueue's INSERT OR IGNORE on idempotency_key.
      const idempotencyKey = `add:user_favorites:${input.boardName}:${input.climbUuid}:${input.angle}`;

      await db.withExclusiveTransactionAsync(async (txn) => {
        await txn.runAsync(
          `INSERT OR IGNORE INTO user_favorites (board_name, climb_uuid, angle, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
          [input.boardName, input.climbUuid, input.angle, now, now],
        );

        await enqueue(txn, 'user_favorites', 'create', input, idempotencyKey);
      });

      queryClient.invalidateQueries({ queryKey: ['favorites'] });
      queryClient.invalidateQueries({ queryKey: ['searchClimbs'] });

      drainMutationQueue(db, queryClient, graphqlFetch);
    },
    [db, queryClient, graphqlFetch],
  );
}

export function useOfflineRemoveFavorite(db: SQLiteDatabase, graphqlFetch: GraphQLFetch) {
  const queryClient = useQueryClient();

  return useCallback(
    async (input: FavoriteInput) => {
      // Deterministic key so repeated taps don't pile up duplicate delete rows.
      const idempotencyKey = `del:user_favorites:${input.boardName}:${input.climbUuid}:${input.angle}`;

      await db.withExclusiveTransactionAsync(async (txn) => {
        await txn.runAsync(`DELETE FROM user_favorites WHERE board_name = ? AND climb_uuid = ? AND angle = ?`, [
          input.boardName,
          input.climbUuid,
          input.angle,
        ]);

        await enqueue(txn, 'user_favorites', 'delete', input, idempotencyKey);
      });

      queryClient.invalidateQueries({ queryKey: ['favorites'] });
      queryClient.invalidateQueries({ queryKey: ['searchClimbs'] });

      drainMutationQueue(db, queryClient, graphqlFetch);
    },
    [db, queryClient, graphqlFetch],
  );
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
