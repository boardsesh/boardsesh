import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { SQLiteDatabase } from 'expo-sqlite';
import { enqueue } from '../mutation-queue';
import { drainMutationQueue } from '../mutation-queue';
import type { GraphQLFetch } from '../mutation-queue/handlers';

function generateUUID(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

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
      const tickUuid = generateUUID();
      const now = new Date().toISOString();

      await db.runAsync(
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

      await enqueue(db, 'boardsesh_ticks', 'create', tickData, tickUuid);

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
      const favoriteId = generateUUID();
      const now = new Date().toISOString();

      await db.runAsync(
        `INSERT OR IGNORE INTO user_favorites (id, board_name, climb_uuid, angle, user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, '', ?, ?)`,
        [favoriteId, input.boardName, input.climbUuid, input.angle, now, now],
      );

      await enqueue(db, 'user_favorites', 'create', input, favoriteId);

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
      const idempotencyKey = generateUUID();

      await db.runAsync(
        `DELETE FROM user_favorites WHERE board_name = ? AND climb_uuid = ? AND angle = ?`,
        [input.boardName, input.climbUuid, input.angle],
      );

      await enqueue(db, 'user_favorites', 'delete', input, idempotencyKey);

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
      const followId = generateUUID();
      const now = new Date().toISOString();

      await db.runAsync(
        `INSERT OR IGNORE INTO user_follows (id, follower_id, following_id, created_at, updated_at)
         VALUES (?, '', ?, ?, ?)`,
        [followId, followingId, now, now],
      );

      await enqueue(db, 'user_follows', 'create', { followingId }, followId);

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
      const idempotencyKey = generateUUID();

      await db.runAsync(`DELETE FROM user_follows WHERE following_id = ?`, [followingId]);

      await enqueue(db, 'user_follows', 'delete', { followingId }, idempotencyKey);

      queryClient.invalidateQueries({ queryKey: ['followers'] });
      queryClient.invalidateQueries({ queryKey: ['following'] });

      drainMutationQueue(db, queryClient, graphqlFetch);
    },
    [db, queryClient, graphqlFetch],
  );
}
