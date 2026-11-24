import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vite-plus/test';
import { boardClimbEvents, userBoards } from '@boardsesh/db/schema';
import { db } from '../db/client';
import { redisClientManager } from '../redis/client';
import { communityStatsQueries } from '../graphql/resolvers/social/community-stats';

describe('community display counts', () => {
  it('counts recent Boardsesh activity without counting official-app imports or backfills', async () => {
    const redisState = vi.spyOn(redisClientManager, 'isRedisConnected').mockReturnValue(false);
    try {
      const [board] = await db
        .insert(userBoards)
        .values({
          uuid: randomUUID(),
          slug: randomUUID(),
          name: 'Community test wall',
          ownerId: 'user-123',
          boardType: 'tension',
          layoutId: 10,
          sizeId: 6,
          setIds: '12,13',
        })
        .returning();
      const now = new Date().toISOString();
      const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
      await db.insert(boardClimbEvents).values(
        [
          { source: 'boardsesh', confirmedAt: now, createdAt: now, userId: 'user-123' },
          { source: 'boardsesh', confirmedAt: old, createdAt: old, userId: 'user-123' },
          { source: 'aurora', confirmedAt: now, createdAt: now, userId: null },
          { source: 'aurora', confirmedAt: old, createdAt: now, userId: null },
          { source: 'kilter', confirmedAt: now, createdAt: now, userId: null },
        ].map((event, index) => ({
          ...event,
          boardId: board.id,
          boardType: 'tension',
          climbUuid: randomUUID(),
          angle: 40,
          seq: index + 1,
        })),
      );
      expect(await communityStatsQueries.communityStats()).toMatchObject({ climbersLast30Days: 1, litLast30Days: 1 });
    } finally {
      redisState.mockRestore();
    }
  });
});
