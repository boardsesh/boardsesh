/**
 * Real-DB coverage for the identity a private account keeps on the new-climb
 * surfaces. A published, listed climb is public whoever set it, so it shows up
 * everywhere; the account behind it is named (display name, avatar, account id)
 * only to viewers who may see that account's activity: the account itself and
 * its approved followers. Everyone else sees the climb under its setter name.
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

// Feed fan-out is not under test here; the notification rows are.
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
const USERS = [PRIVATE_AUTHOR, PUBLIC_AUTHOR, FOLLOWER, STRANGER];

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

const ctxFor = (userId: string): ConnectionContext =>
  ({ userId, isAuthenticated: true, connectionId: `identity-${userId}` }) as ConnectionContext;
const anonymous = { isAuthenticated: false, userId: undefined, connectionId: 'identity-anon' } as ConnectionContext;

async function removeFixtures(): Promise<void> {
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

describeWithDatabase("a private account's identity on the new-climb surfaces (real DB)", () => {
  beforeAll(async () => {
    await removeFixtures();
    await db
      .insert(dbSchema.users)
      .values(USERS.map((id) => ({ id, name: `Name ${id}`, email: `${id}@example.test` })));
    await db.insert(dbSchema.userProfiles).values([
      { userId: PRIVATE_AUTHOR, isPrivate: true, displayName: PRIVATE_DISPLAY, avatarUrl: PRIVATE_AVATAR },
      { userId: PUBLIC_AUTHOR, isPrivate: false, displayName: PUBLIC_DISPLAY, avatarUrl: PUBLIC_AVATAR },
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
    ])("lists a private account's climb to %s under its setter name, with no avatar", async (_label, ctx) => {
      const items = await feedFor(ctx);
      expect(items.get(PRIVATE_CLIMB)).toMatchObject({ setterDisplayName: PRIVATE_SETTER_NAME, setterAvatarUrl: null });
      // A public account is named to everyone.
      expect(items.get(PUBLIC_CLIMB)).toMatchObject({
        setterDisplayName: PUBLIC_DISPLAY,
        setterAvatarUrl: PUBLIC_AVATAR,
      });
    });

    it.each([
      ['an approved follower', ctxFor(FOLLOWER)],
      ['the account itself', ctxFor(PRIVATE_AUTHOR)],
    ])('names the private account to %s', async (_label, ctx) => {
      const items = await feedFor(ctx);
      expect(items.get(PRIVATE_CLIMB)).toMatchObject({
        setterDisplayName: PRIVATE_DISPLAY,
        setterAvatarUrl: PRIVATE_AVATAR,
      });
    });
  });

  describe('crew feed', () => {
    const cardFor = async (viewerId: string, climbUuid: string) => {
      const feed = await crewFeedQueries.crewFeed(null, { input: { limit: 50 } }, ctxFor(viewerId));
      const card = feed.items.find((item) => item.id === `climb:${climbUuid}`);
      return card && 'climb' in card ? card.climb : undefined;
    };

    it("shows a followed setter name's climb to a stranger without the private account behind it", async () => {
      expect(await cardFor(STRANGER, PRIVATE_CLIMB)).toMatchObject({
        actorId: null,
        actorDisplayName: PRIVATE_SETTER_NAME,
        actorAvatarUrl: null,
        setterUsername: PRIVATE_SETTER_NAME,
      });
      expect(await cardFor(STRANGER, PUBLIC_CLIMB)).toMatchObject({
        actorId: PUBLIC_AUTHOR,
        actorDisplayName: PUBLIC_DISPLAY,
        actorAvatarUrl: PUBLIC_AVATAR,
      });
    });

    it('names the private account to its approved follower', async () => {
      expect(await cardFor(FOLLOWER, PRIVATE_CLIMB)).toMatchObject({
        actorId: PRIVATE_AUTHOR,
        actorDisplayName: PRIVATE_DISPLAY,
        actorAvatarUrl: PRIVATE_AVATAR,
      });
    });
  });

  describe('new-climb notifications', () => {
    // Who set a published climb is public by its setter name, so a stranger
    // watching the layout still hears about it: with no account id or avatar,
    // the way the board's new-climb feed shows it. The follower is told who.
    const expected = {
      [FOLLOWER]: { type: 'new_climb', actorId: PRIVATE_AUTHOR },
      [STRANGER]: { type: 'new_climb_global', actorId: null },
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

    /** The live push names the account to its follower and only the setter name to the stranger. */
    const expectPushes = (pushed: Map<string, Record<string, unknown>>) => {
      expect(pushed.get(FOLLOWER)).toMatchObject({
        actorId: PRIVATE_AUTHOR,
        actorDisplayName: PRIVATE_DISPLAY,
        actorAvatarUrl: PRIVATE_AVATAR,
      });
      const toStranger = pushed.get(STRANGER);
      expect(toStranger).toMatchObject({
        type: 'new_climb_global',
        actorId: null,
        actorDisplayName: PRIVATE_SETTER_NAME,
      });
      expect(toStranger?.actorAvatarUrl ?? null).toBeNull();
    };

    it('reach the stranger watching the layout under the setter name (notification worker)', async () => {
      const pushed = capturePushes();
      await captureWorkerHandler()(climbCreated(PRIVATE_CLIMB));
      expect(await notifiedAbout(PRIVATE_CLIMB)).toEqual(expected);
      expectPushes(pushed);
      expect(await strangerInboxGroup(PRIVATE_CLIMB)).toMatchObject({
        type: 'new_climb_global',
        actorCount: 0,
        actors: [],
        setterUsername: PRIVATE_SETTER_NAME,
      });
    });

    it('reach the stranger watching the layout under the setter name (inline, no Redis)', async () => {
      const pushed = capturePushes();
      await publishSocialEvent(climbCreated(PRIVATE_CLIMB_INLINE));
      expect(await notifiedAbout(PRIVATE_CLIMB_INLINE)).toEqual(expected);
      expectPushes(pushed);
      expect(await strangerInboxGroup(PRIVATE_CLIMB_INLINE)).toMatchObject({
        actors: [],
        setterUsername: PRIVATE_SETTER_NAME,
      });
    });
  });
});
