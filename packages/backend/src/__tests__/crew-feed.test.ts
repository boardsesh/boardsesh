import { beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { boardClimbs, boardseshTicks, setterFollows, userFollows, users } from '@boardsesh/db/schema';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { crewFeedQueries } from '../graphql/resolvers/social/crew-feed';
import {
  decodeCrewCursor,
  encodeCrewCursor,
  selectCrewCandidates,
} from '../graphql/resolvers/social/crew-feed-pagination';

const viewerId = 'crew-feed-viewer';
const creatorId = 'crew-feed-creator';
const ctx = { userId: viewerId, isAuthenticated: true, connectionId: 'crew-test' } as ConnectionContext;
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

describe('Crew feed', () => {
  beforeAll(async () => {
    await db.insert(users).values([viewerId, creatorId].map((id) => ({ id, email: `${id}@test.com`, name: id })));
    await db.insert(setterFollows).values({ followerId: viewerId, setterUsername: 'crew-accountless' });
    await db.insert(userFollows).values({ followerId: viewerId, followingId: creatorId });
    await db.insert(boardClimbs).values(
      [
        { uuid: 'crew-imported', setterUsername: 'crew-accountless', createdAt: daysAgo(1) },
        {
          uuid: 'crew-native',
          userId: creatorId,
          setterUsername: 'crew-native-setter',
          createdAt: daysAgo(3),
          publishedAt: daysAgo(3),
        },
        {
          uuid: 'crew-published-draft',
          setterUsername: 'crew-accountless',
          createdAt: daysAgo(100),
          publishedAt: daysAgo(4),
        },
        { uuid: 'crew-old', setterUsername: 'crew-accountless', createdAt: daysAgo(31) },
        { uuid: 'crew-draft', setterUsername: 'crew-accountless', createdAt: daysAgo(1), isDraft: true },
        { uuid: 'crew-hidden', setterUsername: 'crew-accountless', createdAt: daysAgo(1), isHidden: true },
        { uuid: 'crew-unlisted', setterUsername: 'crew-accountless', createdAt: daysAgo(1), isListed: false },
        { uuid: 'crew-unfollowed', setterUsername: 'crew-stranger', createdAt: daysAgo(1) },
        { uuid: 'crew-invalid-date', setterUsername: 'crew-accountless', createdAt: 'not a timestamp' },
        {
          uuid: 'crew-spray-inaccessible',
          setterUsername: 'crew-accountless',
          createdAt: daysAgo(1),
          boardType: 'spray',
        },
      ].map((climb) => ({
        boardType: 'kilter',
        layoutId: 99772,
        isListed: true,
        isDraft: false,
        isHidden: false,
        frames: 'p1r1',
        name: climb.uuid,
        ...climb,
      })),
    );
    await db.insert(boardseshTicks).values({
      uuid: 'crew-tick',
      userId: creatorId,
      boardType: 'kilter',
      climbUuid: 'crew-native',
      angle: 40,
      status: 'send',
      climbedAt: daysAgo(2),
      attemptCount: 1,
    });
  });

  it('mixes sessions and published climbs, including accountless imports and recent draft publication', async () => {
    const first = await crewFeedQueries.crewFeed(null, { input: { limit: 2 } }, ctx);
    expect(first.items.map((item) => item.__typename)).toEqual(['CrewClimbItem', 'CrewSessionItem']);
    expect(first.items[0].id).toBe('climb:crew-imported');
    expect(first.hasMore).toBe(true);
    const second = await crewFeedQueries.crewFeed(null, { input: { limit: 2, cursor: first.cursor } }, ctx);
    expect(second.items.map((item) => item.id)).toEqual(['climb:crew-native', 'climb:crew-published-draft']);
    expect(second.hasMore).toBe(false);
    expect(second.cursor).toBeNull();
    expect(first.items[0]).toMatchObject({ climb: { actorId: null, actorDisplayName: 'crew-accountless' } });
  });

  it('reevaluates visibility and follow membership on refresh', async () => {
    await db.update(boardClimbs).set({ isHidden: true }).where(eq(boardClimbs.uuid, 'crew-imported'));
    const hidden = await crewFeedQueries.crewFeed(null, {}, ctx);
    expect(hidden.items.map((item) => item.id)).not.toContain('climb:crew-imported');
    await db.update(boardClimbs).set({ isHidden: false }).where(eq(boardClimbs.uuid, 'crew-imported'));
    await db.delete(setterFollows).where(eq(setterFollows.followerId, viewerId));
    const unfollowed = await crewFeedQueries.crewFeed(null, {}, ctx);
    expect(unfollowed.items.filter((item) => item.__typename === 'CrewClimbItem').map((item) => item.id)).toEqual([
      'climb:crew-native',
    ]);
    await db.insert(setterFollows).values({ followerId: viewerId, setterUsername: 'crew-accountless' });
  });

  it('rejects anonymous requests and invalid or cross-account cursors', async () => {
    await expect(crewFeedQueries.crewFeed(null, {}, { ...ctx, isAuthenticated: false })).rejects.toThrow();
    await expect(crewFeedQueries.crewFeed(null, { input: { cursor: 'broken' } }, ctx)).rejects.toThrow('Invalid Crew');
    const first = await crewFeedQueries.crewFeed(null, { input: { limit: 1 } }, ctx);
    await expect(
      crewFeedQueries.crewFeed(null, { input: { cursor: first.cursor } }, { ...ctx, userId: creatorId }),
    ).rejects.toThrow('Invalid Crew');
  });

  it('preserves microsecond cursor precision and deterministic ties', () => {
    const occurredAt = daysAgo(1).replace(/\.[0-9]{3}Z$/, '.123456Z');
    const cursor = { version: 1 as const, viewerId, snapshotAt: daysAgo(0), occurredAt, id: 'session:xyz' };
    expect(decodeCrewCursor(encodeCrewCursor(cursor), viewerId)).toEqual(cursor);
    const selected = selectCrewCandidates(
      [
        { id: 'climb:abc', kind: 'climb', sourceId: 'abc', occurredAt },
        { id: 'session:xyz', kind: 'session', sourceId: 'xyz', occurredAt },
      ],
      1,
    );
    expect(selected.selected[0].id).toBe('session:xyz');
    expect(selected.hasMore).toBe(true);
  });

  it('can explain the author-filtered catalogue lookup', async () => {
    const plan = await db.execute(
      sql`EXPLAIN SELECT uuid FROM board_climbs WHERE user_id = ${creatorId} AND is_draft = false`,
    );
    expect(plan.length).toBeGreaterThan(0);
  });
});
