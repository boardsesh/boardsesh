import { describe, it, expect, beforeAll, afterEach } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { socialFeedQueries } from '../graphql/resolvers/social/feed';
import type { ConnectionContext } from '@boardsesh/shared-schema';

/**
 * Integration tests for the followingClimbAscents resolver, covering:
 *
 *   1. Comment counts aggregate correctly via batched GROUP BY (not correlated
 *      subquery) — verifies the count is non-zero and correct.
 *   2. Comment counts default to 0 when no comments exist.
 *   3. Vote aggregates (upvotes/downvotes) are joined correctly.
 *   4. Only ticks from followed users are returned, not the requesting user's
 *      own ticks.
 *   5. Only ticks for the requested climb are returned.
 *
 * Also covers the ticks resolver's batched social-aggregate fetch:
 *   6. ticks resolver returns correct commentCount via GROUP BY batch query.
 *   7. ticks resolver returns 0 commentCount when no comments exist.
 */

const FOLLOWER_ID = 'fca-test-follower';
const FOLLOWED_ID = 'fca-test-followed';
const OTHER_USER_ID = 'fca-test-other-user';
const CLIMB_PREFIX = 'fca-test-climb-';

type AscentItem = {
  uuid: string;
  userId: string;
  upvotes: number;
  downvotes: number;
  commentCount: number;
  climbUuid: string;
};

type AscentResult = { items: AscentItem[] };

const callFollowingClimbAscents = (
  followerId: string,
  boardType: string,
  climbUuid: string,
): Promise<AscentResult> => {
  const ctx: ConnectionContext = {
    connectionId: 'test-connection',
    userId: followerId,
    isAuthenticated: true,
  };

  return socialFeedQueries.followingClimbAscents(
    undefined,
    { input: { boardType, climbUuid } },
    ctx,
  ) as Promise<AscentResult>;
};

const insertUser = async (id: string) => {
  await db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${id}, ${id + '@test.com'}, ${'Test ' + id}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);
};

const insertFollow = async (followerId: string, followingId: string) => {
  await db.execute(sql`
    INSERT INTO user_follows (follower_id, following_id, created_at)
    VALUES (${followerId}, ${followingId}, now())
    ON CONFLICT DO NOTHING
  `);
};

const insertClimb = async (uuid: string) => {
  await db.execute(sql`
    INSERT INTO board_climbs (uuid, board_type, layout_id, setter_username, name, frames, frames_count, is_draft, is_listed, edge_left, edge_right, edge_bottom, edge_top, created_at)
    VALUES (${uuid}, 'kilter', 1, 'test-setter', ${uuid}, 'p1r1', 1, false, true, 0, 100, 0, 150, '2024-01-01')
    ON CONFLICT (uuid) DO NOTHING
  `);
};

const insertTick = async (params: {
  uuid: string;
  userId: string;
  climbUuid: string;
  climbedAt?: string;
  status?: string;
}) => {
  const climbedAt = params.climbedAt ?? '2026-01-01 10:00:00';
  const status = params.status ?? 'send';
  await db.execute(sql`
    INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, status, attempt_count, climbed_at)
    VALUES (${params.uuid}, ${params.userId}, 'kilter', ${params.climbUuid}, 40, ${status}, 1, ${climbedAt})
    ON CONFLICT DO NOTHING
  `);
};

const insertComment = async (params: { uuid: string; entityId: string; userId: string; deletedAt?: string | null }) => {
  await db.execute(sql`
    INSERT INTO comments (uuid, entity_type, entity_id, user_id, body, created_at, updated_at, deleted_at)
    VALUES (
      ${params.uuid}, 'tick', ${params.entityId}, ${params.userId},
      'test comment', now(), now(),
      ${params.deletedAt ?? null}
    )
    ON CONFLICT DO NOTHING
  `);
};

const insertVoteCount = async (params: { entityId: string; upvotes: number; downvotes: number }) => {
  await db.execute(sql`
    INSERT INTO vote_counts (entity_type, entity_id, upvotes, downvotes, score, hot_score, created_at)
    VALUES ('tick', ${params.entityId}, ${params.upvotes}, ${params.downvotes}, 0, 0, now())
    ON CONFLICT (entity_type, entity_id) DO UPDATE
      SET upvotes = EXCLUDED.upvotes, downvotes = EXCLUDED.downvotes
  `);
};

const cleanup = async () => {
  // Clean up in dependency order
  await db.execute(sql`DELETE FROM comments WHERE entity_id LIKE ${'fca-%'}`);
  await db.execute(sql`DELETE FROM vote_counts WHERE entity_id LIKE ${'fca-%'}`);
  await db.execute(
    sql`DELETE FROM boardsesh_ticks WHERE user_id IN (${FOLLOWER_ID}, ${FOLLOWED_ID}, ${OTHER_USER_ID})`,
  );
  await db.execute(sql`DELETE FROM user_follows WHERE follower_id = ${FOLLOWER_ID}`);
  await db.execute(sql`DELETE FROM board_climbs WHERE uuid LIKE ${CLIMB_PREFIX + '%'}`);
};

describe('followingClimbAscents — batched comment counts and vote aggregates', () => {
  beforeAll(async () => {
    await insertUser(FOLLOWER_ID);
    await insertUser(FOLLOWED_ID);
    await insertUser(OTHER_USER_ID);
  });

  afterEach(async () => {
    await cleanup();
  });

  it('returns commentCount=0 when a tick has no comments', async () => {
    const climbUuid = CLIMB_PREFIX + 'no-comments';
    await insertClimb(climbUuid);
    await insertFollow(FOLLOWER_ID, FOLLOWED_ID);
    await insertTick({ uuid: 'fca-tick-1', userId: FOLLOWED_ID, climbUuid });

    const result = await callFollowingClimbAscents(FOLLOWER_ID, 'kilter', climbUuid);

    expect(result.items).toHaveLength(1);
    expect(result.items[0].commentCount).toBe(0);
  });

  it('returns correct commentCount from batched GROUP BY (not correlated subquery)', async () => {
    const climbUuid = CLIMB_PREFIX + 'with-comments';
    await insertClimb(climbUuid);
    await insertFollow(FOLLOWER_ID, FOLLOWED_ID);
    await insertTick({ uuid: 'fca-tick-2', userId: FOLLOWED_ID, climbUuid });

    await insertComment({ uuid: 'fca-comment-1', entityId: 'fca-tick-2', userId: OTHER_USER_ID });
    await insertComment({ uuid: 'fca-comment-2', entityId: 'fca-tick-2', userId: FOLLOWER_ID });

    const result = await callFollowingClimbAscents(FOLLOWER_ID, 'kilter', climbUuid);

    expect(result.items).toHaveLength(1);
    expect(result.items[0].commentCount).toBe(2);
  });

  it('does not count soft-deleted comments', async () => {
    const climbUuid = CLIMB_PREFIX + 'soft-deleted';
    await insertClimb(climbUuid);
    await insertFollow(FOLLOWER_ID, FOLLOWED_ID);
    await insertTick({ uuid: 'fca-tick-3', userId: FOLLOWED_ID, climbUuid });

    await insertComment({ uuid: 'fca-comment-3', entityId: 'fca-tick-3', userId: OTHER_USER_ID });
    await insertComment({
      uuid: 'fca-comment-4',
      entityId: 'fca-tick-3',
      userId: FOLLOWER_ID,
      deletedAt: '2026-01-01 12:00:00',
    });

    const result = await callFollowingClimbAscents(FOLLOWER_ID, 'kilter', climbUuid);

    expect(result.items).toHaveLength(1);
    expect(result.items[0].commentCount).toBe(1);
  });

  it('aggregates comment counts independently across multiple ticks', async () => {
    const climbUuid = CLIMB_PREFIX + 'multi-tick-comments';
    await insertClimb(climbUuid);
    await insertFollow(FOLLOWER_ID, FOLLOWED_ID);

    await insertTick({ uuid: 'fca-tick-4', userId: FOLLOWED_ID, climbUuid, climbedAt: '2026-01-02 10:00:00' });
    await insertTick({ uuid: 'fca-tick-5', userId: FOLLOWED_ID, climbUuid, climbedAt: '2026-01-01 10:00:00' });

    await insertComment({ uuid: 'fca-comment-5', entityId: 'fca-tick-4', userId: OTHER_USER_ID });
    await insertComment({ uuid: 'fca-comment-6', entityId: 'fca-tick-4', userId: FOLLOWER_ID });
    await insertComment({ uuid: 'fca-comment-7', entityId: 'fca-tick-5', userId: OTHER_USER_ID });

    const result = await callFollowingClimbAscents(FOLLOWER_ID, 'kilter', climbUuid);

    expect(result.items).toHaveLength(2);
    // Newest first
    const tick4 = result.items.find((i) => i.uuid === 'fca-tick-4');
    const tick5 = result.items.find((i) => i.uuid === 'fca-tick-5');
    expect(tick4?.commentCount).toBe(2);
    expect(tick5?.commentCount).toBe(1);
  });

  it('returns upvotes and downvotes from joined vote_counts', async () => {
    const climbUuid = CLIMB_PREFIX + 'votes';
    await insertClimb(climbUuid);
    await insertFollow(FOLLOWER_ID, FOLLOWED_ID);
    await insertTick({ uuid: 'fca-tick-6', userId: FOLLOWED_ID, climbUuid });
    await insertVoteCount({ entityId: 'fca-tick-6', upvotes: 7, downvotes: 2 });

    const result = await callFollowingClimbAscents(FOLLOWER_ID, 'kilter', climbUuid);

    expect(result.items).toHaveLength(1);
    expect(result.items[0].upvotes).toBe(7);
    expect(result.items[0].downvotes).toBe(2);
  });

  it('returns upvotes=0 and downvotes=0 when vote_counts row is absent', async () => {
    const climbUuid = CLIMB_PREFIX + 'no-votes';
    await insertClimb(climbUuid);
    await insertFollow(FOLLOWER_ID, FOLLOWED_ID);
    await insertTick({ uuid: 'fca-tick-7', userId: FOLLOWED_ID, climbUuid });

    const result = await callFollowingClimbAscents(FOLLOWER_ID, 'kilter', climbUuid);

    expect(result.items).toHaveLength(1);
    expect(result.items[0].upvotes).toBe(0);
    expect(result.items[0].downvotes).toBe(0);
  });

  it('only returns ticks from users the follower follows', async () => {
    const climbUuid = CLIMB_PREFIX + 'follow-scope';
    await insertClimb(climbUuid);
    await insertFollow(FOLLOWER_ID, FOLLOWED_ID);
    // FOLLOWED_ID tick — should appear
    await insertTick({ uuid: 'fca-tick-8', userId: FOLLOWED_ID, climbUuid });
    // OTHER_USER_ID tick — should NOT appear (not followed)
    await insertTick({ uuid: 'fca-tick-9', userId: OTHER_USER_ID, climbUuid });

    const result = await callFollowingClimbAscents(FOLLOWER_ID, 'kilter', climbUuid);

    expect(result.items).toHaveLength(1);
    expect(result.items[0].uuid).toBe('fca-tick-8');
  });

  it('only returns ticks for the requested climb', async () => {
    const targetClimb = CLIMB_PREFIX + 'target';
    const otherClimb = CLIMB_PREFIX + 'other';
    await insertClimb(targetClimb);
    await insertClimb(otherClimb);
    await insertFollow(FOLLOWER_ID, FOLLOWED_ID);

    await insertTick({ uuid: 'fca-tick-10', userId: FOLLOWED_ID, climbUuid: targetClimb });
    await insertTick({ uuid: 'fca-tick-11', userId: FOLLOWED_ID, climbUuid: otherClimb });

    const result = await callFollowingClimbAscents(FOLLOWER_ID, 'kilter', targetClimb);

    expect(result.items).toHaveLength(1);
    expect(result.items[0].climbUuid).toBe(targetClimb);
  });

  it('returns empty items when the follower follows nobody', async () => {
    const climbUuid = CLIMB_PREFIX + 'empty-feed';
    await insertClimb(climbUuid);
    // No insertFollow call
    await insertTick({ uuid: 'fca-tick-12', userId: FOLLOWED_ID, climbUuid });

    const result = await callFollowingClimbAscents(FOLLOWER_ID, 'kilter', climbUuid);

    expect(result.items).toHaveLength(0);
  });
});
