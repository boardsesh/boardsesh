import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { and, eq, sql } from 'drizzle-orm';
import * as schema from '@boardsesh/db/schema';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { climbQueries } from '../graphql/resolvers/climbs/queries';
import { setterFollowQueries } from '../graphql/resolvers/social/setter-follows';
import {
  canReadSocialEntity,
  canSeeEntityActor,
  notificationPrivacyCondition,
  tickPrivacyCondition,
} from '../graphql/resolvers/shared/activity-privacy';
import { userMutations } from '../graphql/resolvers/users/mutations';
import { socialFeedQueries } from '../graphql/resolvers/social/feed';
import { climbLogsQueries } from '../graphql/resolvers/social/climb-logs';
import { socialProposalQueries } from '../graphql/resolvers/social/proposals';
import { batchEnrichProposals } from '../graphql/resolvers/social/proposals/enrichment';
import { socialCommentQueries } from '../graphql/resolvers/social/comments';
import { resetAllRateLimits } from '../utils/rate-limiter';

// ---------------------------------------------------------------------------
// A published climb is public everywhere (real Postgres).
//
// Published and listed, a climb is public to everyone, signed in or not, whoever
// set it: a private account, a followers-only tick on it, or an author who has
// since deleted their account changes nothing. A draft is its owner's alone,
// by uuid too. An unlisted climb is out of the lists but still opens by uuid.
// The first-ascent name is a tick rule: the earliest send this viewer may read.
// What a private account keeps is the link from its setter name to its identity.
// ---------------------------------------------------------------------------

const describeWithDatabase = process.env.SKIP_TEST_INFRA === '1' ? describe.skip : describe;

const BOARD = 'kilter';
const LAYOUT_ID = 99_783;
const ANGLE = 40;
const SETTER_NAME = 'matrix-private-setter';

const PRIVATE_AUTHOR = 'matrix-private-author';
const FOLLOWER = 'matrix-follower';
const STRANGER = 'matrix-stranger';
const PRIVATE_SENDER = 'matrix-private-sender';
const PUBLIC_SENDER = 'matrix-public-sender';
const DELETED_AUTHOR = 'matrix-deleted-author';
const USERS = [PRIVATE_AUTHOR, FOLLOWER, STRANGER, PRIVATE_SENDER, PUBLIC_SENDER, DELETED_AUTHOR];

const PRIVATE_PUBLISHED = 'matrix-private-published';
const TICKED_PUBLISHED = 'matrix-ticked-published';
const LINKED_ONLY = 'matrix-linked-only';
const DELETED_PUBLISHED = 'matrix-deleted-published';
const DRAFT = 'matrix-draft';
const UNLISTED = 'matrix-unlisted';
/** The deleted author's draft: ownerless once the account is gone, so nobody's. */
const DELETED_DRAFT = 'matrix-deleted-draft';
const ALL_CLIMBS = [PRIVATE_PUBLISHED, TICKED_PUBLISHED, LINKED_ONLY, DELETED_PUBLISHED, DRAFT, UNLISTED];

const ctxFor = (userId: string): ConnectionContext =>
  ({ userId, isAuthenticated: true, connectionId: `matrix-${userId}` }) as ConnectionContext;
const anonymous = { isAuthenticated: false, userId: undefined, connectionId: 'matrix-anon' } as ConnectionContext;
const boardInput = { boardName: BOARD, layoutId: LAYOUT_ID, sizeId: 1, setIds: '1', angle: ANGLE };

async function removeFixtures(): Promise<void> {
  await db.execute(sql`DELETE FROM comments WHERE uuid LIKE 'matrix-%'`);
  await db.execute(sql`DELETE FROM climb_proposals WHERE uuid LIKE 'matrix-%'`);
  await db.execute(sql`DELETE FROM notifications WHERE uuid LIKE 'matrix-%'`);
  await db.execute(sql`DELETE FROM content_privacy WHERE entity_id LIKE 'matrix-%'`);
  await db.execute(sql`DELETE FROM boardsesh_ticks WHERE climb_uuid LIKE 'matrix-%'`);
  await db.execute(sql`DELETE FROM board_climb_stats WHERE climb_uuid LIKE 'matrix-%'`);
  await db.execute(sql`DELETE FROM board_climbs WHERE uuid LIKE 'matrix-%'`);
  await db.execute(sql`DELETE FROM users WHERE id IN (${sql.join(USERS, sql`, `)})`);
}

async function insertClimb(
  uuid: string,
  userId: string | null,
  options: { isDraft?: boolean; isListed?: boolean; setterUsername?: string },
) {
  await db.insert(schema.boardClimbs).values({
    uuid,
    boardType: BOARD,
    layoutId: LAYOUT_ID,
    userId,
    name: `Name of ${uuid}`,
    setterUsername: options.setterUsername ?? SETTER_NAME,
    frames: 'p1r12p2r13',
    framesCount: 1,
    isDraft: options.isDraft ?? false,
    isListed: options.isListed ?? true,
    compatibleSizeIds: [1],
    requiredSetIds: [1],
  });
  await db.insert(schema.boardClimbStats).values({
    boardType: BOARD,
    climbUuid: uuid,
    angle: ANGLE,
    displayDifficulty: 20,
    ascensionistCount: 2,
    faUsername: 'Stored first ascensionist',
  });
}

describeWithDatabase('a published climb is public everywhere (real DB)', () => {
  beforeAll(async () => {
    await removeFixtures();
    await db.insert(schema.users).values(USERS.map((id) => ({ id, name: `Name ${id}`, email: `${id}@example.test` })));
    await db.insert(schema.userProfiles).values([
      { userId: PRIVATE_AUTHOR, isPrivate: true },
      { userId: PRIVATE_SENDER, isPrivate: true },
      { userId: DELETED_AUTHOR, isPrivate: true },
      { userId: PUBLIC_SENDER, isPrivate: false, displayName: 'Public sender' },
    ]);
    await db.insert(schema.userFollows).values([
      { followerId: FOLLOWER, followingId: PRIVATE_AUTHOR },
      { followerId: FOLLOWER, followingId: PRIVATE_SENDER },
    ]);
    // The private author's linked board account sets under the same name.
    await db
      .insert(schema.userBoardMappings)
      .values({ userId: PRIVATE_AUTHOR, boardType: BOARD, boardUsername: SETTER_NAME });

    await insertClimb(PRIVATE_PUBLISHED, PRIVATE_AUTHOR, {});
    await insertClimb(TICKED_PUBLISHED, PRIVATE_AUTHOR, {});
    await insertClimb(LINKED_ONLY, null, {});
    await insertClimb(DELETED_PUBLISHED, DELETED_AUTHOR, { setterUsername: 'matrix-deleted-setter' });
    await insertClimb(DRAFT, PRIVATE_AUTHOR, { isDraft: true, isListed: false });
    await insertClimb(UNLISTED, PRIVATE_AUTHOR, { isListed: false });
    await insertClimb(DELETED_DRAFT, DELETED_AUTHOR, {
      isDraft: true,
      isListed: false,
      setterUsername: 'matrix-deleted-setter',
    });

    // The first send is a private account's, explicitly followers-only; the
    // second is a public account's.
    await db.insert(schema.boardseshTicks).values([
      {
        uuid: 'matrix-followers-only-tick',
        userId: PRIVATE_SENDER,
        boardType: BOARD,
        climbUuid: TICKED_PUBLISHED,
        angle: ANGLE,
        status: 'flash',
        climbedAt: '2026-01-01T10:00:00Z',
      },
      {
        uuid: 'matrix-public-tick',
        userId: PUBLIC_SENDER,
        boardType: BOARD,
        climbUuid: TICKED_PUBLISHED,
        angle: ANGLE,
        status: 'send',
        climbedAt: '2026-01-02T10:00:00Z',
      },
    ]);
    await db.insert(schema.contentPrivacy).values({
      entityType: 'tick',
      entityId: 'matrix-followers-only-tick',
      ownerId: PRIVATE_SENDER,
      audience: 'followers',
    });

    // Notifications the deleted author caused, written while the account existed.
    await db.insert(schema.notifications).values(
      [DELETED_PUBLISHED, DELETED_DRAFT].map((climbUuid) => ({
        uuid: `matrix-n-${climbUuid}`,
        recipientId: STRANGER,
        actorId: DELETED_AUTHOR,
        type: 'new_climb' as const,
        entityType: 'climb' as const,
        entityId: climbUuid,
      })),
    );

    await userMutations.deleteAccount(null, { input: { removeSetterName: false } }, ctxFor(DELETED_AUTHOR));
  });
  afterAll(removeFixtures);
  beforeEach(() => resetAllRateLimits());

  it('kept the deleted author’s published climb, with no author', async () => {
    const [climb] = await db
      .select({ userId: schema.boardClimbs.userId, marked: schema.boardClimbs.isBoardseshAuthored })
      .from(schema.boardClimbs)
      .where(eq(schema.boardClimbs.uuid, DELETED_PUBLISHED));
    expect(climb).toEqual({ userId: null, marked: true });
  });

  describe.each([
    ['a stranger', ctxFor(STRANGER)],
    ['an anonymous caller', anonymous],
    ['an approved follower', ctxFor(FOLLOWER)],
  ])('for %s', (_label, ctx) => {
    it('opens every published climb by uuid, unlisted included, and never the draft', async () => {
      for (const climbUuid of ALL_CLIMBS) {
        const climb = await climbQueries.climb({}, { ...boardInput, climbUuid }, ctx);
        expect(climb?.uuid ?? null, climbUuid).toBe(climbUuid === DRAFT ? null : climbUuid);
      }
    });

    it('reads the stats of every published climb, and none of the draft', async () => {
      for (const climbUuid of ALL_CLIMBS) {
        const rows = await climbQueries.climbStatsForAngles(undefined, { boardName: BOARD, climbUuid }, ctx);
        expect(rows.length, climbUuid).toBe(climbUuid === DRAFT ? 0 : 1);
      }
    });

    it("counts the private account's published, listed climbs on its setter page", async () => {
      const profile = await setterFollowQueries.setterProfile(undefined, { input: { username: SETTER_NAME } }, ctx);
      // Its own two, and the one its linked board account set; the draft and
      // the unlisted climb are out.
      expect(profile?.climbCount).toBe(3);
      const deleted = await setterFollowQueries.setterProfile(
        undefined,
        { input: { username: 'matrix-deleted-setter' } },
        ctx,
      );
      expect(deleted?.climbCount).toBe(1);
    });
  });

  it('withholds the link from the setter name to a private identity, from strangers only', async () => {
    for (const ctx of [ctxFor(STRANGER), anonymous]) {
      const profile = await setterFollowQueries.setterProfile(undefined, { input: { username: SETTER_NAME } }, ctx);
      expect(profile?.linkedUserId ?? null).toBeNull();
    }
    const followerView = await setterFollowQueries.setterProfile(
      undefined,
      { input: { username: SETTER_NAME } },
      ctxFor(FOLLOWER),
    );
    expect(followerView?.linkedUserId).toBe(PRIVATE_AUTHOR);
  });

  it("lists a private account's own published climbs to a stranger, but not its linked or unlisted ones", async () => {
    const forStranger = await setterFollowQueries.userClimbs(
      undefined,
      { input: { userId: PRIVATE_AUTHOR } },
      ctxFor(STRANGER),
    );
    expect(forStranger.climbs.map((climb) => climb.uuid).sort()).toEqual([PRIVATE_PUBLISHED, TICKED_PUBLISHED].sort());
    expect(forStranger.totalCount).toBe(2);

    const forFollower = await setterFollowQueries.userClimbs(
      undefined,
      { input: { userId: PRIVATE_AUTHOR } },
      ctxFor(FOLLOWER),
    );
    expect(forFollower.climbs.map((climb) => climb.uuid).sort()).toEqual(
      [PRIVATE_PUBLISHED, TICKED_PUBLISHED, LINKED_ONLY].sort(),
    );

    const forOwner = await setterFollowQueries.userClimbs(
      undefined,
      { input: { userId: PRIVATE_AUTHOR } },
      ctxFor(PRIVATE_AUTHOR),
    );
    expect(forOwner.climbs.map((climb) => climb.uuid).sort()).toEqual(
      [PRIVATE_PUBLISHED, TICKED_PUBLISHED, LINKED_ONLY, UNLISTED].sort(),
    );
  });

  it('opens the draft to its owner alone', async () => {
    const climb = await climbQueries.climb({}, { ...boardInput, climbUuid: DRAFT }, ctxFor(PRIVATE_AUTHOR));
    expect(climb?.uuid).toBe(DRAFT);
  });

  it('never hides a tick because of who set its climb', async () => {
    for (const viewer of [STRANGER, null]) {
      const ticks = await db
        .select({ uuid: schema.boardseshTicks.uuid })
        .from(schema.boardseshTicks)
        .where(and(eq(schema.boardseshTicks.climbUuid, TICKED_PUBLISHED), tickPrivacyCondition(viewer)));
      // The private sender's followers-only tick stays theirs; the public one shows.
      expect(ticks.map((tick) => tick.uuid)).toEqual(['matrix-public-tick']);
    }
  });

  it('credits the first ascent to the earliest send the viewer may read', async () => {
    const firstAscent = async (ctx: ConnectionContext) =>
      (await climbQueries.climbStatsForAngles(undefined, { boardName: BOARD, climbUuid: TICKED_PUBLISHED }, ctx))[0]
        ?.faUsername;
    // The first send is hidden from a stranger, so the credit falls to the next visible one.
    expect(await firstAscent(ctxFor(STRANGER))).toBe('Public sender');
    expect(await firstAscent(anonymous)).toBe('Public sender');
    // A follower of the first sender sees them credited.
    expect(await firstAscent(ctxFor(FOLLOWER))).toBe(`Name ${PRIVATE_SENDER}`);
  });

  it('names a climb’s author on a notification about it, and keeps any other private actor hidden', async () => {
    await db.insert(schema.notifications).values([
      // The private author published it: their authorship is public with the climb.
      {
        uuid: 'matrix-n-author',
        recipientId: STRANGER,
        actorId: PRIVATE_AUTHOR,
        type: 'new_climb',
        entityType: 'climb',
        entityId: PRIVATE_PUBLISHED,
      },
      // A different private account acting on the same climb keeps its privacy.
      {
        uuid: 'matrix-n-other',
        recipientId: STRANGER,
        actorId: PRIVATE_SENDER,
        type: 'proposal_created',
        entityType: 'climb',
        entityId: PRIVATE_PUBLISHED,
      },
    ]);
    // One row at a time by its unique uuid, as the inbox reads it: the policy
    // sits in the select list, so the planner never runs it across the table.
    const visibleTo = async (viewerId: string) => {
      const visible: string[] = [];
      for (const uuid of ['matrix-n-author', 'matrix-n-other']) {
        const [row] = await db
          .select({ allowed: notificationPrivacyCondition(viewerId) })
          .from(schema.notifications)
          .where(eq(schema.notifications.uuid, uuid));
        if (row?.allowed === true) visible.push(uuid);
      }
      return visible;
    };
    expect(await visibleTo(STRANGER)).toEqual(['matrix-n-author']);
    // An approved follower of the other actor sees both.
    expect(await visibleTo(FOLLOWER)).toEqual(['matrix-n-author', 'matrix-n-other']);

    // The worker's check before it writes a notification agrees.
    expect(await canSeeEntityActor('climb', PRIVATE_PUBLISHED, PRIVATE_AUTHOR, STRANGER)).toBe(true);
    expect(await canSeeEntityActor('climb', PRIVATE_PUBLISHED, PRIVATE_SENDER, STRANGER)).toBe(false);
    expect(await canSeeEntityActor('climb', PRIVATE_PUBLISHED, PRIVATE_SENDER, FOLLOWER)).toBe(true);
  });

  it("still delivers a deleted author's published climb in a notification, never their draft", async () => {
    const allowed = async (uuid: string, viewerId: string) => {
      const [row] = await db
        .select({ actorId: schema.notifications.actorId, allowed: notificationPrivacyCondition(viewerId) })
        .from(schema.notifications)
        .where(eq(schema.notifications.uuid, uuid));
      return row;
    };
    for (const viewerId of [STRANGER, FOLLOWER]) {
      // The account is gone, so the actor is cleared; the published climb stays public.
      expect(await allowed(`matrix-n-${DELETED_PUBLISHED}`, viewerId)).toEqual({ actorId: null, allowed: true });
      // The draft has no owner left, so it goes to no one.
      expect(await allowed(`matrix-n-${DELETED_DRAFT}`, viewerId)).toEqual({ actorId: null, allowed: false });
    }
    const draft = await climbQueries.climb({}, { ...boardInput, climbUuid: DELETED_DRAFT }, ctxFor(STRANGER));
    expect(draft).toBeNull();
  });

  it("keeps an unlisted climb's logs out of both ascent feeds, and on its own page", async () => {
    await db.insert(schema.userFollows).values({ followerId: FOLLOWER, followingId: PUBLIC_SENDER });
    // Newest of everything, so a leak would sit at the top of either feed.
    const now = new Date().toISOString();
    await db.insert(schema.boardseshTicks).values([
      {
        uuid: 'matrix-unlisted-tick',
        userId: PUBLIC_SENDER,
        boardType: BOARD,
        climbUuid: UNLISTED,
        angle: ANGLE,
        status: 'send',
        climbedAt: now,
      },
      {
        uuid: 'matrix-listed-tick',
        userId: PUBLIC_SENDER,
        boardType: BOARD,
        climbUuid: PRIVATE_PUBLISHED,
        angle: ANGLE,
        status: 'send',
        climbedAt: now,
      },
    ]);
    const feedClimbs = async (items: Promise<unknown>) =>
      ((await items) as { items: Array<{ climbUuid?: string }> }).items.map((item) => item.climbUuid);

    for (const ctx of [ctxFor(STRANGER), anonymous]) {
      const global = await feedClimbs(
        socialFeedQueries.globalAscentsFeed({}, { input: { limit: 50, offset: 0 } }, ctx),
      );
      expect(global).toContain(PRIVATE_PUBLISHED);
      expect(global).not.toContain(UNLISTED);
    }
    const following = await feedClimbs(
      socialFeedQueries.followingAscentsFeed({}, { input: { limit: 50, offset: 0 } }, ctxFor(FOLLOWER)),
    );
    expect(following).toContain(PRIVATE_PUBLISHED);
    expect(following).not.toContain(UNLISTED);

    // The climb's own page opens by its link, and so do its logs.
    for (const ctx of [ctxFor(STRANGER), anonymous]) {
      const logs = await climbLogsQueries.climbLogs(
        undefined,
        { input: { boardType: BOARD, climbUuid: UNLISTED } },
        ctx,
      );
      expect(logs.items.map((item) => item.uuid)).toContain('matrix-unlisted-tick');
    }
  });

  describe('an unlisted climb in proposals, comment feeds and inboxes', () => {
    const LISTED_PROPOSAL = 'matrix-proposal-listed';
    const UNLISTED_PROPOSAL = 'matrix-proposal-unlisted';
    const UNLISTED_COMMENT = 'matrix-comment-unlisted';

    beforeAll(async () => {
      // Written by a public account before the climb was unlisted: nothing but
      // the listed rule keeps them from a stranger.
      await db.insert(schema.climbProposals).values(
        [
          [LISTED_PROPOSAL, PRIVATE_PUBLISHED],
          [UNLISTED_PROPOSAL, UNLISTED],
        ].map(([uuid, climbUuid]) => ({
          uuid,
          climbUuid,
          boardType: BOARD,
          angle: null,
          proposerId: PUBLIC_SENDER,
          type: 'hide' as const,
          proposedValue: 'true',
          currentValue: 'false',
          reason: `Reason on ${climbUuid}`,
        })),
      );
      await db.insert(schema.comments).values({
        uuid: UNLISTED_COMMENT,
        userId: PUBLIC_SENDER,
        entityType: 'climb',
        entityId: UNLISTED,
        body: 'Beta on the unlisted climb',
      });
      // About the unlisted climb, from its author, to an approved follower of
      // that author: account privacy lets it through, the listed rule does not.
      await db.insert(schema.notifications).values({
        uuid: 'matrix-n-unlisted',
        recipientId: FOLLOWER,
        actorId: PRIVATE_AUTHOR,
        type: 'new_climb',
        entityType: 'climb',
        entityId: UNLISTED,
      });
    });

    const browsed = async (ctx: ConnectionContext) =>
      (await socialProposalQueries.browseProposals({}, { input: { boardType: BOARD, limit: 50 } }, ctx)).proposals.map(
        (proposal) => proposal.uuid,
      );

    it("keeps an unlisted climb's proposals out of the moderation feed, except for its owner", async () => {
      for (const ctx of [ctxFor(STRANGER), anonymous, ctxFor(FOLLOWER)]) {
        const uuids = await browsed(ctx);
        expect(uuids).toContain(LISTED_PROPOSAL);
        expect(uuids).not.toContain(UNLISTED_PROPOSAL);
      }
      expect(await browsed(ctxFor(PRIVATE_AUTHOR))).toEqual(
        expect.arrayContaining([LISTED_PROPOSAL, UNLISTED_PROPOSAL]),
      );
    });

    it("lists an unlisted climb's proposals to its owner alone, even by the climb's uuid", async () => {
      const onClimb = async (ctx: ConnectionContext) =>
        socialProposalQueries.climbProposals({}, { input: { climbUuid: UNLISTED, boardType: BOARD } }, ctx);
      for (const ctx of [ctxFor(STRANGER), anonymous, ctxFor(FOLLOWER)]) {
        expect((await onClimb(ctx)).totalCount).toBe(0);
      }
      const forOwner = await onClimb(ctxFor(PRIVATE_AUTHOR));
      expect(forOwner.proposals.map((proposal) => proposal.uuid)).toEqual([UNLISTED_PROPOSAL]);
    });

    it('names an unlisted climb on a proposal to its owner alone', async () => {
      const [row] = await db
        .select()
        .from(schema.climbProposals)
        .where(eq(schema.climbProposals.uuid, UNLISTED_PROPOSAL));
      for (const viewerId of [STRANGER, FOLLOWER, PUBLIC_SENDER, null]) {
        const [enriched] = await batchEnrichProposals([row], viewerId);
        expect(enriched.climbName, String(viewerId)).toBeUndefined();
        expect(enriched.frames, String(viewerId)).toBeUndefined();
      }
      const [forOwner] = await batchEnrichProposals([row], PRIVATE_AUTHOR);
      expect(forOwner.climbName).toBe(`Name of ${UNLISTED}`);
    });

    it("withholds an unlisted climb's proposal thread and notifications from everyone but the owner", async () => {
      for (const viewerId of [STRANGER, FOLLOWER, null]) {
        expect(await canReadSocialEntity('proposal', UNLISTED_PROPOSAL, viewerId), String(viewerId)).toBe(false);
        expect(await canReadSocialEntity('proposal', LISTED_PROPOSAL, viewerId), String(viewerId)).toBe(true);
      }
      expect(await canReadSocialEntity('proposal', UNLISTED_PROPOSAL, PRIVATE_AUTHOR)).toBe(true);
    });

    it("keeps an unlisted climb's comments out of the global comment feed, and on its own thread", async () => {
      for (const ctx of [ctxFor(STRANGER), anonymous]) {
        const feed = await socialCommentQueries.globalCommentFeed({}, { input: { limit: 50 } }, ctx);
        expect(feed.comments.map((comment) => comment.uuid)).not.toContain(UNLISTED_COMMENT);
        const thread = await socialCommentQueries.comments(
          {},
          { input: { entityType: 'climb', entityId: UNLISTED } },
          ctx,
        );
        expect(thread.comments.map((comment) => comment.uuid)).toEqual([UNLISTED_COMMENT]);
      }
      const ownerFeed = await socialCommentQueries.globalCommentFeed(
        {},
        { input: { limit: 50 } },
        ctxFor(PRIVATE_AUTHOR),
      );
      expect(ownerFeed.comments.map((comment) => comment.uuid)).toContain(UNLISTED_COMMENT);
    });

    it("keeps a notification about an unlisted climb out of a follower's inbox", async () => {
      const [row] = await db
        .select({ allowed: notificationPrivacyCondition(FOLLOWER) })
        .from(schema.notifications)
        .where(eq(schema.notifications.uuid, 'matrix-n-unlisted'));
      expect(row?.allowed).toBe(false);
      // The climb itself still opens for them by its link.
      expect(await canReadSocialEntity('climb', UNLISTED, FOLLOWER)).toBe(true);
      expect(await canReadSocialEntity('climb', UNLISTED, FOLLOWER, 'listed')).toBe(false);
    });
  });
});
