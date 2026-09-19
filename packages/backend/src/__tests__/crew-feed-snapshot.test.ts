import { describe, expect, it } from 'vitest';
import { boardSessions, boardseshTicks, boardBetaLinks, userFollows, users } from '@boardsesh/db/schema';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { getSessionFeed } from '../graphql/resolvers/social/session-feed';

describe('Crew session snapshot enrichment', () => {
  it('keeps party and daily cards internally consistent after newer ticks arrive', async () => {
    const viewer = 'crew-snapshot-viewer';
    const owner = 'crew-snapshot-owner';
    const dailyOwner = 'crew-snapshot-daily';
    const lateParticipant = 'crew-snapshot-late';
    const sessionId = 'crew-snapshot-party';
    const snapshotAt = '2026-09-01T12:00:00Z';
    await db
      .insert(users)
      .values([viewer, owner, dailyOwner, lateParticipant].map((id) => ({ id, email: `${id}@test.com`, name: id })));
    await db
      .insert(userFollows)
      .values([owner, dailyOwner].map((followingId) => ({ followerId: viewer, followingId })));
    await db
      .insert(boardSessions)
      .values({ id: sessionId, boardPath: 'kilter/1/1/1/40', createdByUserId: owner, isPublic: true });
    const insertTicks = async (later: boolean) => {
      const prefix = later ? 'crew-snapshot-new' : 'crew-snapshot-old';
      const tickRows = [
        { uuid: `${prefix}-party`, userId: later ? lateParticipant : owner, sessionId },
        { uuid: `${prefix}-daily`, userId: dailyOwner, sessionId: null },
      ].map((tick) => ({
        ...tick,
        climbUuid: tick.uuid,
        boardType: later ? 'tension' : 'kilter',
        status: 'send' as const,
        angle: 40,
        attemptCount: 1,
        difficulty: later ? 25 : 16,
        climbedAt: later ? '2026-09-01T13:00:00Z' : '2026-09-01T10:00:00Z',
      }));
      await db.insert(boardseshTicks).values(tickRows);
      await db.insert(boardBetaLinks).values(
        tickRows.map((tick) => ({
          boardType: tick.boardType,
          climbUuid: tick.climbUuid,
          tickUuid: tick.uuid,
          link: `https://example.com/${tick.uuid}`,
          createdByUserId: tick.userId,
          isListed: true,
        })),
      );
    };
    await insertTicks(false);
    const ctx = { userId: viewer, isAuthenticated: true, connectionId: 'snapshot-test' } as ConnectionContext;
    const input = { followingOnly: true, includeDailyHighlights: true, limit: 20 };
    const page = () => getSessionFeed(input, ctx, { snapshotAt, selectRows: (rows) => rows.slice(0, 20) });
    const before = await page();
    expect(before.sessions).toHaveLength(2);
    for (const session of before.sessions) {
      expect(session.tickCount).toBe(1);
      expect(session.hardestSend?.uuid).toContain('crew-snapshot-old');
      expect(session.featuredBeta?.tick.uuid).toContain('crew-snapshot-old');
    }

    await insertTicks(true);
    expect(await page()).toEqual(before);

    // The legacy, non-snapshotted endpoint must still include newly arrived ticks.
    const live = await getSessionFeed(input, ctx);
    for (const session of live.sessions) {
      expect(session.tickCount).toBe(2);
      expect(session.boardTypes).toContain('tension');
      expect(session.hardestSend?.uuid).toContain('crew-snapshot-new');
      expect(session.featuredBeta?.tick.uuid).toContain('crew-snapshot-new');
    }
    expect(
      live.sessions
        .find((session) => session.sessionId === sessionId)
        ?.participants.map((participant) => participant.userId),
    ).toContain(lateParticipant);
  });
});
