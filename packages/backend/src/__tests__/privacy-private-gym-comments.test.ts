/**
 * Real-DB coverage for #6407: a gym's comment thread reads exactly when the gym
 * does. `gym(gymUuid)` hides a private gym from everyone but its owner, its
 * admin and editor members, and community admins or leaders covering one of its
 * board types (`userCanEditGym`). The comment thread, the global comment feed,
 * the activity feed, `addComment` and votes on a private gym's comments follow
 * that same rule; a public gym's comments read for everyone, as before.
 *
 * The staff list (`gymMembers`) follows the same rule.
 *
 * One viewer table drives every check, so `gym()`, `userCanEditGym` and the SQL
 * twin behind the comment reads (`gymVisibleCondition`) cannot drift apart. A
 * plan check keeps that SQL uncorrelated: it sits inside every inbox and feed
 * read, and a per-gym version pushed the inbox past `jit_above_cost`.
 */
import { beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { and, eq, sql } from 'drizzle-orm';
import { rowsFromResult } from '@boardsesh/db/client';
import * as dbSchema from '@boardsesh/db/schema';
import type { ConnectionContext } from '@boardsesh/shared-schema';

// Comment and vote writes fan out asynchronously; nothing here reads the fan-out.
vi.mock('../events', () => ({ publishSocialEvent: vi.fn(async () => undefined) }));

import { db } from '../db/client';
import { socialCommentMutations, socialCommentQueries } from '../graphql/resolvers/social/comments';
import { activityFeedQueries } from '../graphql/resolvers/social/activity-feed';
import { socialGymQueries, userCanEditGym } from '../graphql/resolvers/social/gyms';
import { socialVoteMutations, socialVoteQueries } from '../graphql/resolvers/social/votes';
import { canReadSocialEntity, socialEntityPrivacyCondition } from '../graphql/resolvers/shared/activity-privacy';

const COMMENTER = 'private-gym-comments-commenter';
const OWNER = 'private-gym-comments-owner';
const GYM_ADMIN = 'private-gym-comments-gym-admin';
const GYM_EDITOR = 'private-gym-comments-gym-editor';
const PLAIN_MEMBER = 'private-gym-comments-plain-member';
const KILTER_LEADER = 'private-gym-comments-kilter-leader';
const GLOBAL_ADMIN = 'private-gym-comments-global-admin';
const TENSION_LEADER = 'private-gym-comments-tension-leader';
const MOON_ADMIN = 'private-gym-comments-moon-admin';
const GLOBAL_TESTER = 'private-gym-comments-global-tester';
const STRANGER = 'private-gym-comments-stranger';

const PRIVATE_GYM = '0b6c3f7e-6407-4c2a-9d1e-000000000001';
const PUBLIC_GYM = '0b6c3f7e-6407-4c2a-9d1e-000000000002';
const DELETED_GYM = '0b6c3f7e-6407-4c2a-9d1e-000000000003';
const UNKNOWN_GYM = '0b6c3f7e-6407-4c2a-9d1e-000000000004';

const PRIVATE_COMMENT = '0b6c3f7e-6407-4c2a-9d1e-0000000000c1';
const PUBLIC_COMMENT = '0b6c3f7e-6407-4c2a-9d1e-0000000000c2';
const DELETED_GYM_COMMENT = '0b6c3f7e-6407-4c2a-9d1e-0000000000c3';

type Viewer = { label: string; userId: string | null; seesPrivateGym: boolean };

/** Who `gym()` shows the private gym to, and so who reads its comments. */
const VIEWERS: Viewer[] = [
  { label: 'gym owner', userId: OWNER, seesPrivateGym: true },
  { label: 'gym admin member', userId: GYM_ADMIN, seesPrivateGym: true },
  { label: 'gym editor member', userId: GYM_EDITOR, seesPrivateGym: true },
  { label: 'community leader for a board type at the gym', userId: KILTER_LEADER, seesPrivateGym: true },
  { label: 'global community admin', userId: GLOBAL_ADMIN, seesPrivateGym: true },
  { label: 'plain gym member', userId: PLAIN_MEMBER, seesPrivateGym: false },
  { label: 'community leader whose board at the gym was deleted', userId: TENSION_LEADER, seesPrivateGym: false },
  { label: 'community admin for a board type not at the gym', userId: MOON_ADMIN, seesPrivateGym: false },
  { label: 'global tester', userId: GLOBAL_TESTER, seesPrivateGym: false },
  { label: 'signed-in stranger', userId: STRANGER, seesPrivateGym: false },
  { label: 'anonymous', userId: null, seesPrivateGym: false },
];
const SIGNED_IN = VIEWERS.filter((viewer): viewer is Viewer & { userId: string } => viewer.userId !== null);

const GYMS = [
  { name: 'private', uuid: PRIVATE_GYM, commentUuid: PRIVATE_COMMENT, isPublic: false },
  { name: 'public', uuid: PUBLIC_GYM, commentUuid: PUBLIC_COMMENT, isPublic: true },
] as const;

const seesGym = (viewer: Viewer, gym: (typeof GYMS)[number]): boolean => gym.isPublic || viewer.seesPrivateGym;

const context = (userId: string | null): ConnectionContext =>
  ({
    connectionId: `private-gym-comments-${userId ?? 'anon'}`,
    isAuthenticated: !!userId,
    userId,
  }) as ConnectionContext;

async function threadCommentIds(gymUuid: string, userId: string | null): Promise<string[]> {
  const thread = await socialCommentQueries.comments(
    null,
    { input: { entityType: 'gym', entityId: gymUuid } },
    context(userId),
  );
  return thread.comments.map((comment) => comment.uuid);
}

async function globalFeedCommentIds(userId: string | null): Promise<string[]> {
  const feed = await socialCommentQueries.globalCommentFeed(null, { input: { limit: 50 } }, context(userId));
  return feed.comments.map((comment) => comment.uuid);
}

async function activityFeedCommentIds(userId: string): Promise<string[]> {
  const feed = await activityFeedQueries.activityFeed(null, { input: { limit: 50 } }, context(userId));
  return feed.items.filter((item) => item.entityType === 'comment').map((item) => item.entityId);
}

async function errorMessageOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

beforeAll(async () => {
  const everyone = [COMMENTER, ...SIGNED_IN.map((viewer) => viewer.userId)];
  await db.insert(dbSchema.users).values(everyone.map((id) => ({ id, email: `${id}@test.com`, name: id })));

  const [privateGym, publicGym] = await db
    .insert(dbSchema.gyms)
    .values([
      { uuid: PRIVATE_GYM, slug: 'private-gym-comments-private', name: 'Garage wall', ownerId: OWNER, isPublic: false },
      { uuid: PUBLIC_GYM, slug: 'private-gym-comments-public', name: 'Open gym', ownerId: OWNER, isPublic: true },
      {
        uuid: DELETED_GYM,
        slug: 'private-gym-comments-deleted',
        name: 'Closed gym',
        ownerId: OWNER,
        isPublic: true,
        deletedAt: new Date(),
      },
    ])
    .returning({ id: dbSchema.gyms.id });

  await db.insert(dbSchema.gymMembers).values([
    { gymId: privateGym.id, userId: GYM_ADMIN, role: 'admin' },
    { gymId: privateGym.id, userId: GYM_EDITOR, role: 'editor' },
    { gymId: privateGym.id, userId: PLAIN_MEMBER, role: 'member' },
    { gymId: privateGym.id, userId: COMMENTER, role: 'editor' },
    { gymId: publicGym.id, userId: PLAIN_MEMBER, role: 'member' },
  ]);

  // The private gym has a live Kilter board and a deleted Tension board, and no
  // MoonBoard: a board-scoped role covers it only through a live board.
  await db.insert(dbSchema.userBoards).values(
    [
      { uuid: 'private-gym-comments-kilter-board', boardType: 'kilter', sizeId: 10, deletedAt: null },
      { uuid: 'private-gym-comments-tension-board', boardType: 'tension', sizeId: 11, deletedAt: new Date() },
    ].map((board) => ({
      ...board,
      slug: board.uuid,
      ownerId: OWNER,
      layoutId: 1,
      setIds: '1',
      name: board.uuid,
      gymId: privateGym.id,
    })),
  );
  await db.insert(dbSchema.communityRoles).values([
    { userId: KILTER_LEADER, role: 'community_leader', boardType: 'kilter' },
    { userId: GLOBAL_ADMIN, role: 'admin', boardType: null },
    { userId: TENSION_LEADER, role: 'community_leader', boardType: 'tension' },
    { userId: MOON_ADMIN, role: 'admin', boardType: 'moonboard' },
    { userId: GLOBAL_TESTER, role: 'tester', boardType: null },
  ]);

  await db.insert(dbSchema.comments).values([
    { uuid: PRIVATE_COMMENT, userId: COMMENTER, entityType: 'gym', entityId: PRIVATE_GYM, body: 'Garage beta' },
    { uuid: PUBLIC_COMMENT, userId: COMMENTER, entityType: 'gym', entityId: PUBLIC_GYM, body: 'Open beta' },
    { uuid: DELETED_GYM_COMMENT, userId: COMMENTER, entityType: 'gym', entityId: DELETED_GYM, body: 'Closed beta' },
  ]);

  // Every signed-in viewer follows the commenter, so each comment fans out to all of them.
  await db
    .insert(dbSchema.userFollows)
    .values(SIGNED_IN.map((viewer) => ({ followerId: viewer.userId, followingId: COMMENTER })));
  await db.insert(dbSchema.feedItems).values(
    SIGNED_IN.flatMap((viewer) =>
      [PRIVATE_COMMENT, PUBLIC_COMMENT, DELETED_GYM_COMMENT].map((entityId) => ({
        recipientId: viewer.userId,
        actorId: COMMENTER,
        type: 'comment' as const,
        entityType: 'comment' as const,
        entityId,
        metadata: {},
      })),
    ),
  );
});

describe('comments on a private gym follow the gym’s own visibility', () => {
  it('gym(), userCanEditGym and the comment rule agree for every viewer', async () => {
    const actual: Record<string, Record<string, boolean>> = {};
    const expected: Record<string, Record<string, boolean>> = {};
    for (const gym of GYMS) {
      const [gymRow] = await db.select().from(dbSchema.gyms).where(eq(dbSchema.gyms.uuid, gym.uuid));
      for (const viewer of VIEWERS) {
        const key = `${gym.name} gym / ${viewer.label}`;
        const sees = seesGym(viewer, gym);
        const shown = (await socialGymQueries.gym(null, { gymUuid: gym.uuid }, context(viewer.userId))) !== null;
        const editRule = gym.isPublic || (viewer.userId !== null && (await userCanEditGym(gymRow, viewer.userId)));
        actual[key] = {
          gym: shown,
          userCanEditGym: editRule,
          canReadGym: await canReadSocialEntity('gym', gym.uuid, viewer.userId),
          canReadComment: await canReadSocialEntity('comment', gym.commentUuid, viewer.userId),
        };
        expected[key] = { gym: sees, userCanEditGym: sees, canReadGym: sees, canReadComment: sees };
      }
    }
    expect(actual).toEqual(expected);
  });

  it('opens the thread by gym UUID only for viewers who see the gym', async () => {
    const actual: Record<string, string[]> = {};
    const expected: Record<string, string[]> = {};
    for (const gym of GYMS) {
      for (const viewer of VIEWERS) {
        const key = `${gym.name} gym / ${viewer.label}`;
        actual[key] = await threadCommentIds(gym.uuid, viewer.userId);
        expected[key] = seesGym(viewer, gym) ? [gym.commentUuid] : [];
      }
    }
    expect(actual).toEqual(expected);
  });

  it('keeps a private gym’s comment out of the global comment feed for everyone else', async () => {
    const actual: Record<string, { private: boolean; public: boolean }> = {};
    const expected: Record<string, { private: boolean; public: boolean }> = {};
    for (const viewer of VIEWERS) {
      const ids = await globalFeedCommentIds(viewer.userId);
      actual[viewer.label] = { private: ids.includes(PRIVATE_COMMENT), public: ids.includes(PUBLIC_COMMENT) };
      expected[viewer.label] = { private: viewer.seesPrivateGym, public: true };
    }
    expect(actual).toEqual(expected);
  });

  it('keeps it out of a follower’s activity feed unless they see the gym', async () => {
    const actual: Record<string, { private: boolean; public: boolean }> = {};
    const expected: Record<string, { private: boolean; public: boolean }> = {};
    for (const viewer of SIGNED_IN) {
      const ids = await activityFeedCommentIds(viewer.userId);
      actual[viewer.label] = { private: ids.includes(PRIVATE_COMMENT), public: ids.includes(PUBLIC_COMMENT) };
      expected[viewer.label] = { private: viewer.seesPrivateGym, public: true };
    }
    expect(actual).toEqual(expected);
  });

  it('lets only viewers who see the gym comment on it, with the same error as a gym that does not exist', async () => {
    const missingGymError = await errorMessageOf(
      socialCommentMutations.addComment(
        null,
        { input: { entityType: 'gym', entityId: UNKNOWN_GYM, body: 'Anyone here?' } },
        context(STRANGER),
      ),
    );
    expect(missingGymError).toBe('Content not available');

    const actual: Record<string, string | null> = {};
    const expected: Record<string, string | null> = {};
    for (const gym of GYMS) {
      for (const viewer of SIGNED_IN) {
        const key = `${gym.name} gym / ${viewer.label}`;
        actual[key] = await errorMessageOf(
          socialCommentMutations.addComment(
            null,
            { input: { entityType: 'gym', entityId: gym.uuid, body: `From ${viewer.label}` } },
            context(viewer.userId),
          ),
        );
        expected[key] = seesGym(viewer, gym) ? null : missingGymError;
      }
    }
    expect(actual).toEqual(expected);
    await expect(
      socialCommentMutations.addComment(
        null,
        { input: { entityType: 'gym', entityId: PRIVATE_GYM, body: 'Signed out' } },
        context(null),
      ),
    ).rejects.toThrow();
  });

  it('takes a like on a private gym’s comment only from viewers who see the gym, and shows its tally only to them', async () => {
    const voteErrors: Record<string, string | null> = {};
    const expectedVoteErrors: Record<string, string | null> = {};
    for (const gym of GYMS) {
      for (const viewer of SIGNED_IN) {
        const key = `${gym.name} gym / ${viewer.label}`;
        voteErrors[key] = await errorMessageOf(
          socialVoteMutations.vote(
            null,
            { input: { entityType: 'comment', entityId: gym.commentUuid, value: 1 } },
            context(viewer.userId),
          ),
        );
        expectedVoteErrors[key] = seesGym(viewer, gym) ? null : 'Content not available';
      }
    }
    expect(voteErrors).toEqual(expectedVoteErrors);

    const likers = async (commentUuid: string): Promise<string[]> =>
      (
        await db
          .select({ userId: dbSchema.votes.userId })
          .from(dbSchema.votes)
          .where(and(eq(dbSchema.votes.entityType, 'comment'), eq(dbSchema.votes.entityId, commentUuid)))
      )
        .map((vote) => vote.userId)
        .sort();
    const userIds = (viewers: Array<Viewer & { userId: string }>): string[] =>
      viewers.map((viewer) => viewer.userId).sort();
    expect(await likers(PRIVATE_COMMENT)).toEqual(userIds(SIGNED_IN.filter((viewer) => viewer.seesPrivateGym)));
    expect(await likers(PUBLIC_COMMENT)).toEqual(userIds(SIGNED_IN));

    // The test schema has no vote_counts trigger: write the tally it would keep.
    const tally = 7;
    await db
      .insert(dbSchema.voteCounts)
      .values(
        GYMS.map((gym) => ({
          entityType: 'comment' as const,
          entityId: gym.commentUuid,
          upvotes: tally,
          score: tally,
          createdAt: new Date(),
        })),
      )
      .onConflictDoUpdate({
        target: [dbSchema.voteCounts.entityType, dbSchema.voteCounts.entityId],
        set: { upvotes: tally, downvotes: 0, score: tally },
      });
    const tallies: Record<string, number> = {};
    const expectedTallies: Record<string, number> = {};
    for (const gym of GYMS) {
      for (const viewer of VIEWERS) {
        const key = `${gym.name} gym / ${viewer.label}`;
        const summary = await socialVoteQueries.voteSummary(
          null,
          { entityType: 'comment', entityId: gym.commentUuid },
          context(viewer.userId),
        );
        tallies[key] = summary.upvotes;
        expectedTallies[key] = seesGym(viewer, gym) ? tally : 0;
      }
    }
    expect(tallies).toEqual(expectedTallies);
  });

  it('keeps a soft-deleted gym’s thread closed, to its owner too', async () => {
    for (const viewer of [OWNER, STRANGER, null]) {
      expect(await canReadSocialEntity('gym', DELETED_GYM, viewer)).toBe(false);
      expect(await threadCommentIds(DELETED_GYM, viewer)).toEqual([]);
      expect(await globalFeedCommentIds(viewer)).not.toContain(DELETED_GYM_COMMENT);
    }
    expect(await activityFeedCommentIds(OWNER)).not.toContain(DELETED_GYM_COMMENT);
  });
});

describe('the staff list follows the gym’s visibility', () => {
  async function staffOrError(gymUuid: string, userId: string | null): Promise<string[] | string> {
    try {
      const page = await socialGymQueries.gymMembers(null, { input: { gymUuid } }, context(userId));
      return page.members.map((member) => member.userId).sort();
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  it('lists a private gym’s staff only to viewers who see it; everyone else gets the missing-gym answer', async () => {
    const missingGym = await staffOrError(UNKNOWN_GYM, null);
    expect(missingGym).toBe('Gym not found');
    const staff: Record<string, string[]> = {
      private: [COMMENTER, GYM_ADMIN, GYM_EDITOR, PLAIN_MEMBER].sort(),
      public: [PLAIN_MEMBER],
    };
    const actual: Record<string, string[] | string> = {};
    const expected: Record<string, string[] | string> = {};
    for (const gym of GYMS) {
      for (const viewer of VIEWERS) {
        const key = `${gym.name} gym / ${viewer.label}`;
        actual[key] = await staffOrError(gym.uuid, viewer.userId);
        expected[key] = seesGym(viewer, gym) ? staff[gym.name] : missingGym;
      }
    }
    expect(actual).toEqual(expected);
    expect(await staffOrError(DELETED_GYM, OWNER)).toBe(missingGym);
  });
});

describe('the gym arm’s query plan', () => {
  type PlanNode = {
    'Node Type': string;
    'Relation Name'?: string;
    Alias?: string;
    Plans?: PlanNode[];
    [field: string]: unknown;
  };

  it('checks who sees a private gym without reading the gym row, so each subquery runs once per statement', async () => {
    const explained = await db.execute(
      sql`EXPLAIN (FORMAT JSON) SELECT outer_gym.id FROM gyms outer_gym
        WHERE ${socialEntityPrivacyCondition(sql`'gym'`, sql`outer_gym.uuid`, GYM_EDITOR)}`,
    );
    const root = rowsFromResult<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(explained)[0]['QUERY PLAN'][0].Plan;
    const flatten = (plan: PlanNode): PlanNode[] => [plan, ...(plan.Plans ?? []).flatMap(flatten)];
    const plans = flatten(root);
    const gymAliases = plans.flatMap((plan) => (plan['Relation Name'] === 'gyms' && plan.Alias ? [plan.Alias] : []));
    const roleTables = ['gym_members', 'community_roles', 'user_boards'];
    const roleScans = plans.filter((plan) => roleTables.includes(plan['Relation Name'] ?? ''));
    // Not vacuous: the gym arm's staff and community-role lookups are in this plan.
    expect(gymAliases).toContain('privacy_entity_gym');
    expect(roleScans.map((plan) => plan['Relation Name'])).toEqual(
      expect.arrayContaining(['gym_members', 'community_roles']),
    );
    // A condition naming a gyms row would make the lookup run once per gym.
    const correlated = roleScans.flatMap((plan) => {
      const text = JSON.stringify({ ...plan, Plans: undefined });
      return gymAliases
        .filter((alias) => new RegExp(`\\b${alias}\\.`).test(text))
        .map((alias) => `${plan.Alias} -> ${alias}`);
    });
    expect(correlated).toEqual([]);
  });
});
