/**
 * Real-DB coverage for who set a private account's published climb on the
 * new-climb surfaces. A published, listed climb is public whoever set it, and
 * so is who set it (#6418): the account behind it is named (display name,
 * avatar, account id) to everyone, signed in or not, the way the board sync
 * already carries its `user_id`. What a private account keeps private is its
 * activity, so anyone ELSE acting on its climb keeps their own account privacy.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { and, eq, inArray, sql } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import type { ConnectionContext, SocialEvent } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { pubsub } from '../pubsub/index';
import type { EventBroker } from '../events/event-broker';
import { NotificationWorker } from '../events/notification-worker';
import { publishSocialEvent } from '../events/index';
import { newClimbSubscriptionResolvers } from '../graphql/resolvers/social/new-climb-subscriptions';
import { crewFeedQueries } from '../graphql/resolvers/social/crew-feed';
import { socialNotificationQueries } from '../graphql/resolvers/social/notifications';
import { activityFeedQueries } from '../graphql/resolvers/social/activity-feed';

// The notification rows are under test here, so the worker's feed fan-out is
// stubbed; the activity-feed block below runs the real one on purpose.
vi.mock('../events/feed-fanout', () => ({
  fanoutFeedItems: vi.fn(async () => {}),
  fanoutNewClimbFeedItems: vi.fn(async () => {}),
  fanoutCommentFeedItems: vi.fn(async () => {}),
  fanoutProposalApprovedFeedItems: vi.fn(async () => {}),
}));

const describeWithDatabase = process.env.SKIP_TEST_INFRA === '1' ? describe.skip : describe;

const BOARD = 'kilter';
const LAYOUT_ID = 99_791;

const PRIVATE_AUTHOR = 'identity-private-author';
const PUBLIC_AUTHOR = 'identity-public-author';
const FOLLOWER = 'identity-follower';
const STRANGER = 'identity-stranger';
/** Another private account, which never set the climbs below. */
const OTHER_PRIVATE = 'identity-other-private';
const USERS = [PRIVATE_AUTHOR, PUBLIC_AUTHOR, FOLLOWER, STRANGER, OTHER_PRIVATE];

/** The private account's linked board handle: its climbs list under this name. */
const PRIVATE_SETTER_NAME = 'identity-private-handle';
const PUBLIC_SETTER_NAME = 'identity-public-handle';
const PRIVATE_DISPLAY = 'Private display';
const PRIVATE_AVATAR = 'https://example.test/identity-private.png';
const PUBLIC_DISPLAY = 'Public display';
const PUBLIC_AVATAR = 'https://example.test/identity-public.png';

const PRIVATE_CLIMB = 'identity-private-climb';
const PUBLIC_CLIMB = 'identity-public-climb';
const PRIVATE_CLIMB_INLINE = 'identity-private-climb-inline';
const PRIVATE_CLIMB_FEED = 'identity-private-climb-feed';

const ctxFor = (userId: string): ConnectionContext =>
  ({ userId, isAuthenticated: true, connectionId: `identity-${userId}` }) as ConnectionContext;
const anonymous = { isAuthenticated: false, userId: undefined, connectionId: 'identity-anon' } as ConnectionContext;

/** The private account, as every surface below now names it. */
const PRIVATE_IDENTITY = { displayName: PRIVATE_DISPLAY, avatarUrl: PRIVATE_AVATAR };

async function removeFixtures(): Promise<void> {
  await db.execute(sql`DELETE FROM feed_items WHERE entity_id LIKE 'identity-%'`);
  await db.execute(sql`DELETE FROM notifications WHERE entity_id LIKE 'identity-%'`);
  await db.execute(sql`DELETE FROM board_climbs WHERE uuid LIKE 'identity-%'`);
  await db.execute(sql`DELETE FROM users WHERE id IN (${sql.join(USERS, sql`, `)})`);
}

async function insertClimb(uuid: string, userId: string, setterUsername: string): Promise<void> {
  const now = new Date().toISOString();
  await db.insert(dbSchema.boardClimbs).values({
    uuid,
    boardType: BOARD,
    layoutId: LAYOUT_ID,
    userId,
    name: `Name of ${uuid}`,
    setterUsername,
    frames: 'p1r12p2r13',
    framesCount: 1,
    isDraft: false,
    isListed: true,
    isHidden: false,
    createdAt: now,
    publishedAt: now,
    compatibleSizeIds: [1],
    requiredSetIds: [1],
  });
}

/** Drive the worker the way production does: `start()` hands its handler to the broker. */
function captureWorkerHandler(): (event: SocialEvent) => Promise<void> {
  let handler: ((event: SocialEvent) => Promise<void>) | undefined;
  const stubBroker = {
    startConsumer: (consume: (event: SocialEvent) => Promise<void>) => {
      handler = consume;
    },
  } as unknown as EventBroker;
  new NotificationWorker(stubBroker).start();
  if (!handler) throw new Error('NotificationWorker did not register a consumer');
  return handler;
}

function climbCreated(climbUuid: string): SocialEvent {
  return {
    type: 'climb.created',
    actorId: PRIVATE_AUTHOR,
    entityType: 'climb',
    entityId: climbUuid,
    timestamp: Date.now(),
    metadata: {
      boardType: BOARD,
      layoutId: String(LAYOUT_ID),
      climbName: `Name of ${climbUuid}`,
      setterDisplayName: PRIVATE_DISPLAY,
      setterAvatarUrl: PRIVATE_AVATAR,
    },
  };
}

/** Who got a notification about this climb: its type, and the account it names. */
async function notifiedAbout(climbUuid: string): Promise<Record<string, { type: string; actorId: string | null }>> {
  const rows = await db
    .select({
      recipientId: dbSchema.notifications.recipientId,
      type: dbSchema.notifications.type,
      actorId: dbSchema.notifications.actorId,
    })
    .from(dbSchema.notifications)
    .where(and(eq(dbSchema.notifications.entityId, climbUuid), inArray(dbSchema.notifications.recipientId, USERS)));
  return Object.fromEntries(rows.map(({ recipientId, type, actorId }) => [recipientId, { type, actorId }]));
}

/** The stranger's inbox row for this climb, as the app reads it. */
async function strangerInboxGroup(climbUuid: string) {
  const page = await socialNotificationQueries.groupedNotifications(null, { limit: 50 }, ctxFor(STRANGER));
  return page.groups.find((group) => group.entityId === climbUuid);
}

describeWithDatabase("who set a private account's published climb, on the new-climb surfaces (real DB)", () => {
  beforeAll(async () => {
    await removeFixtures();
    await db
      .insert(dbSchema.users)
      .values(USERS.map((id) => ({ id, name: `Name ${id}`, email: `${id}@example.test` })));
    await db.insert(dbSchema.userProfiles).values([
      { userId: PRIVATE_AUTHOR, isPrivate: true, displayName: PRIVATE_DISPLAY, avatarUrl: PRIVATE_AVATAR },
      { userId: PUBLIC_AUTHOR, isPrivate: false, displayName: PUBLIC_DISPLAY, avatarUrl: PUBLIC_AVATAR },
      { userId: OTHER_PRIVATE, isPrivate: true, displayName: 'Other private' },
    ]);
    await db.insert(dbSchema.userFollows).values({ followerId: FOLLOWER, followingId: PRIVATE_AUTHOR });
    await db
      .insert(dbSchema.userBoardMappings)
      .values({ userId: PRIVATE_AUTHOR, boardType: BOARD, boardUsername: PRIVATE_SETTER_NAME });
    // The stranger follows both setter names. Following a name needs no
    // approval: the setter page is public, so its climbs are too.
    await db.insert(dbSchema.setterFollows).values([
      { followerId: STRANGER, setterUsername: PRIVATE_SETTER_NAME },
      { followerId: STRANGER, setterUsername: PUBLIC_SETTER_NAME },
    ]);
    // Both the stranger and the follower watch the layout for new climbs.
    await db.insert(dbSchema.newClimbSubscriptions).values([
      { userId: STRANGER, boardType: BOARD, layoutId: LAYOUT_ID },
      { userId: FOLLOWER, boardType: BOARD, layoutId: LAYOUT_ID },
    ]);
    await insertClimb(PRIVATE_CLIMB, PRIVATE_AUTHOR, PRIVATE_SETTER_NAME);
    await insertClimb(PUBLIC_CLIMB, PUBLIC_AUTHOR, PUBLIC_SETTER_NAME);
    await insertClimb(PRIVATE_CLIMB_INLINE, PRIVATE_AUTHOR, PRIVATE_SETTER_NAME);
    await insertClimb(PRIVATE_CLIMB_FEED, PRIVATE_AUTHOR, PRIVATE_SETTER_NAME);
  });
  afterAll(removeFixtures);

  describe('newClimbFeed', () => {
    const feedFor = async (ctx: ConnectionContext) => {
      const page = await newClimbSubscriptionResolvers.Query.newClimbFeed(
        undefined,
        { input: { boardType: BOARD, layoutId: LAYOUT_ID, limit: 50 } },
        ctx,
      );
      return new Map(page.items.map((item) => [item.uuid, item]));
    };

    it.each([
      ['an anonymous caller', anonymous],
      ['a stranger', ctxFor(STRANGER)],
      ['an approved follower', ctxFor(FOLLOWER)],
      ['the account itself', ctxFor(PRIVATE_AUTHOR)],
    ])('names the private account behind its climb to %s', async (_label, ctx) => {
      const items = await feedFor(ctx);
      expect(items.get(PRIVATE_CLIMB)).toMatchObject({
        setterDisplayName: PRIVATE_DISPLAY,
        setterAvatarUrl: PRIVATE_AVATAR,
      });
      expect(items.get(PUBLIC_CLIMB)).toMatchObject({
        setterDisplayName: PUBLIC_DISPLAY,
        setterAvatarUrl: PUBLIC_AVATAR,
      });
    });
  });

  describe('crew feed', () => {
    const cardFor = async (viewerId: string, climbUuid: string) => {
      const feed = await crewFeedQueries.crewFeed(null, { input: { limit: 50 } }, ctxFor(viewerId));
      const card = feed.items.find((item) => item.id === `climb:${climbUuid}`);
      return card && 'climb' in card ? card.climb : undefined;
    };

    it.each([
      ['a stranger following its setter name', STRANGER],
      ['its approved follower', FOLLOWER],
    ])('names the private account behind a climb card to %s', async (_label, viewerId) => {
      expect(await cardFor(viewerId, PRIVATE_CLIMB)).toMatchObject({
        actorId: PRIVATE_AUTHOR,
        actorDisplayName: PRIVATE_DISPLAY,
        actorAvatarUrl: PRIVATE_AVATAR,
        setterUsername: PRIVATE_SETTER_NAME,
      });
    });

    it('names a public account to a stranger, as before', async () => {
      expect(await cardFor(STRANGER, PUBLIC_CLIMB)).toMatchObject({
        actorId: PUBLIC_AUTHOR,
        actorDisplayName: PUBLIC_DISPLAY,
        actorAvatarUrl: PUBLIC_AVATAR,
      });
    });
  });

  describe('new-climb notifications', () => {
    // Every recipient is told which account set the climb: the follower, and
    // the stranger who only watches the layout.
    const expected = {
      [FOLLOWER]: { type: 'new_climb', actorId: PRIVATE_AUTHOR },
      [STRANGER]: { type: 'new_climb_global', actorId: PRIVATE_AUTHOR },
    };

    afterEach(() => vi.restoreAllMocks());

    /** Spy on the live push and return, per recipient, the notification it carried. */
    const capturePushes = () => {
      const pushed = new Map<string, Record<string, unknown>>();
      vi.spyOn(pubsub, 'publishNotificationEvent').mockImplementation((recipientId, event) => {
        pushed.set(recipientId, event.notification as unknown as Record<string, unknown>);
      });
      return pushed;
    };

    /** The live push names the account, with its avatar, to both recipients. */
    const expectPushes = (pushed: Map<string, Record<string, unknown>>) => {
      expect(pushed.get(FOLLOWER)).toMatchObject({
        type: 'new_climb',
        actorId: PRIVATE_AUTHOR,
        actorDisplayName: PRIVATE_DISPLAY,
        actorAvatarUrl: PRIVATE_AVATAR,
      });
      expect(pushed.get(STRANGER)).toMatchObject({
        type: 'new_climb_global',
        actorId: PRIVATE_AUTHOR,
        actorDisplayName: PRIVATE_DISPLAY,
        actorAvatarUrl: PRIVATE_AVATAR,
      });
    };

    it('name the author to the stranger watching the layout (notification worker)', async () => {
      const pushed = capturePushes();
      await captureWorkerHandler()(climbCreated(PRIVATE_CLIMB));
      expect(await notifiedAbout(PRIVATE_CLIMB)).toEqual(expected);
      expectPushes(pushed);
      expect(await strangerInboxGroup(PRIVATE_CLIMB)).toMatchObject({
        type: 'new_climb_global',
        actorCount: 1,
        actors: [{ id: PRIVATE_AUTHOR, ...PRIVATE_IDENTITY }],
      });
    });

    it('name the author to the stranger watching the layout (inline, no Redis)', async () => {
      const pushed = capturePushes();
      await publishSocialEvent(climbCreated(PRIVATE_CLIMB_INLINE));
      expect(await notifiedAbout(PRIVATE_CLIMB_INLINE)).toEqual(expected);
      expectPushes(pushed);
      expect(await strangerInboxGroup(PRIVATE_CLIMB_INLINE)).toMatchObject({
        actorCount: 1,
        actors: [{ id: PRIVATE_AUTHOR, ...PRIVATE_IDENTITY }],
      });
    });
  });

  describe('activity feed', () => {
    const feedRowsFor = async (viewerId: string) => {
      const page = await activityFeedQueries.activityFeed(null, { input: { limit: 50 } }, ctxFor(viewerId));
      return page.items.filter((item) => item.entityId === PRIVATE_CLIMB_FEED);
    };

    beforeAll(async () => {
      // The real fan-out, as the worker runs it after a climb is published:
      // the author's approved follower and the setter name's follower.
      const { fanoutNewClimbFeedItems } =
        await vi.importActual<typeof import('../events/feed-fanout')>('../events/feed-fanout');
      await fanoutNewClimbFeedItems(climbCreated(PRIVATE_CLIMB_FEED));
    });

    it.each([
      ['a stranger following the setter name', STRANGER],
      ['its approved follower', FOLLOWER],
    ])("shows a private account's new climb to %s, naming the account", async (_label, viewerId) => {
      expect(await feedRowsFor(viewerId)).toEqual([
        expect.objectContaining({
          type: 'new_climb',
          actorId: PRIVATE_AUTHOR,
          actorDisplayName: PRIVATE_DISPLAY,
          actorAvatarUrl: PRIVATE_AVATAR,
          setterUsername: PRIVATE_SETTER_NAME,
        }),
      ]);
    });

    it('still hides a row naming another private account on that climb', async () => {
      // Only the climb's own author is public with it. A row about the same
      // climb that names a different private account is that account's activity.
      await db.insert(dbSchema.feedItems).values({
        recipientId: STRANGER,
        actorId: OTHER_PRIVATE,
        type: 'new_climb',
        entityType: 'climb',
        entityId: PRIVATE_CLIMB_FEED,
        metadata: { climbUuid: PRIVATE_CLIMB_FEED, actorDisplayName: 'Other private' },
      });
      const rows = await feedRowsFor(STRANGER);
      expect(rows.map((row) => row.actorId)).toEqual([PRIVATE_AUTHOR]);
    });
  });
});
