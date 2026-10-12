import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { eq, sql } from 'drizzle-orm';
import * as schema from '@boardsesh/db/schema';
import type { ConnectionContext, NewClimbCreatedEvent } from '@boardsesh/shared-schema';

// The channel is stubbed so the test can push events; the climb rows behind
// them are real, because the property under test is the per-event read.
const { channel } = vi.hoisted(() => ({
  channel: {
    push: null as ((event: NewClimbCreatedEvent) => void) | null,
    unsubscribe: vi.fn(),
  },
}));

vi.mock('../pubsub/index', () => ({
  pubsub: {
    subscribeNewClimbs: vi.fn(async (_channelKey: string, push: (event: NewClimbCreatedEvent) => void) => {
      channel.push = push;
      return channel.unsubscribe;
    }),
  },
}));

import { db } from '../db/client';
import { newClimbFeedSubscription } from '../graphql/resolvers/social/new-climb-feed-subscription';

// ---------------------------------------------------------------------------
// The live "new climb" push (real Postgres).
//
// A published, listed climb is public whoever set it, so every subscriber is
// sent it. Moderation `hide` is a separate rule and still applies: a climb the
// community hid never announces itself, including one hidden after the
// publisher announced it. Withdrawn climbs (draft, unlisted) stay out too.
// The account behind the climb keeps its identity: a subscriber who may not
// see a private account's activity gets the climb under its setter name, with
// no avatar.
// ---------------------------------------------------------------------------

const describeWithDatabase = process.env.SKIP_TEST_INFRA === '1' ? describe.skip : describe;

const BOARD = 'kilter';
const LAYOUT_ID = 99_784;
const PRIVATE_AUTHOR = 'new-climb-push-private-author';
const STRANGER = 'new-climb-push-stranger';
const FOLLOWER = 'new-climb-push-follower';
const USERS = [PRIVATE_AUTHOR, STRANGER, FOLLOWER];
const SETTER_NAME = 'new-climb-push-setter';
const PRIVATE_DISPLAY = 'A private setter';
const PRIVATE_AVATAR = 'https://example.test/new-climb-push-private.png';

const PUBLISHED = 'new-climb-push-published';
const LATER_HIDDEN = 'new-climb-push-later-hidden';
const HIDDEN = 'new-climb-push-hidden';
const UNLISTED = 'new-climb-push-unlisted';
const DRAFT = 'new-climb-push-draft';

const ctxFor = (userId: string): ConnectionContext =>
  ({ userId, isAuthenticated: true, connectionId: `new-climb-push-${userId}` }) as ConnectionContext;
const anonymous = {
  isAuthenticated: false,
  userId: undefined,
  connectionId: 'new-climb-push-anon',
} as ConnectionContext;

function eventFor(uuid: string): NewClimbCreatedEvent {
  return {
    climb: {
      uuid,
      name: `Name of ${uuid}`,
      boardType: BOARD,
      layoutId: LAYOUT_ID,
      setterDisplayName: PRIVATE_DISPLAY,
      setterAvatarUrl: PRIVATE_AVATAR,
      angle: 40,
      frames: 'p1r12',
      difficultyName: null,
      isNoMatch: false,
      createdAt: '2026-10-11T00:00:00.000Z',
    },
  };
}

async function removeFixtures(): Promise<void> {
  await db.execute(sql`DELETE FROM board_climbs WHERE uuid LIKE 'new-climb-push-%'`);
  await db.execute(sql`DELETE FROM users WHERE id IN (${sql.join(USERS, sql`, `)})`);
}

async function insertClimb(uuid: string, options: { isDraft?: boolean; isListed?: boolean; isHidden?: boolean }) {
  await db.insert(schema.boardClimbs).values({
    uuid,
    boardType: BOARD,
    layoutId: LAYOUT_ID,
    userId: PRIVATE_AUTHOR,
    name: `Name of ${uuid}`,
    setterUsername: SETTER_NAME,
    frames: 'p1r12',
    framesCount: 1,
    isDraft: options.isDraft ?? false,
    isListed: options.isListed ?? true,
    isHidden: options.isHidden ?? false,
    compatibleSizeIds: [1],
    requiredSetIds: [1],
  });
}

function resetChannel(): void {
  channel.push = null;
}

/** Subscribe, wait for the channel, push `uuids` in order, and return the first climb the viewer is sent. */
async function firstAnnouncedClimb(
  ctx: ConnectionContext,
  uuids: string[],
): Promise<NewClimbCreatedEvent['climb'] | null> {
  resetChannel();
  const iterator = newClimbFeedSubscription.newClimbCreated.subscribe(
    undefined,
    { boardType: BOARD, layoutId: LAYOUT_ID },
    ctx,
  );
  const next = iterator.next();
  await vi.waitFor(() => expect(channel.push).not.toBeNull());
  for (const uuid of uuids) channel.push?.(eventFor(uuid));
  const result = await next;
  await iterator.return(undefined);
  return result.done ? null : result.value.newClimbCreated.climb;
}

async function firstAnnounced(ctx: ConnectionContext, uuids: string[]): Promise<string | null> {
  return (await firstAnnouncedClimb(ctx, uuids))?.uuid ?? null;
}

describeWithDatabase('newClimbCreated push (real DB)', () => {
  beforeAll(async () => {
    await removeFixtures();
    await db.insert(schema.users).values(USERS.map((id) => ({ id, name: `Name ${id}`, email: `${id}@example.test` })));
    await db.insert(schema.userProfiles).values({ userId: PRIVATE_AUTHOR, isPrivate: true });
    await db.insert(schema.userFollows).values({ followerId: FOLLOWER, followingId: PRIVATE_AUTHOR });
    await insertClimb(PUBLISHED, {});
    await insertClimb(LATER_HIDDEN, {});
    await insertClimb(HIDDEN, { isHidden: true });
    await insertClimb(UNLISTED, { isListed: false });
    await insertClimb(DRAFT, { isDraft: true, isListed: false });
  });
  afterAll(removeFixtures);
  beforeEach(() => channel.unsubscribe.mockClear());

  it.each([
    ['a stranger', ctxFor(STRANGER)],
    ['an anonymous caller', anonymous],
  ])(
    "announces a private account's published climb to %s, and skips hidden, unlisted and draft climbs",
    async (_label, ctx) => {
      // The skipped events come first, so a leak would be the first thing sent.
      expect(await firstAnnounced(ctx, [HIDDEN, UNLISTED, DRAFT, PUBLISHED])).toBe(PUBLISHED);
    },
  );

  it.each([
    ['a stranger', ctxFor(STRANGER)],
    ['an anonymous caller', anonymous],
  ])("sends %s a private account's climb under its setter name, with no avatar", async (_label, ctx) => {
    expect(await firstAnnouncedClimb(ctx, [PUBLISHED])).toMatchObject({
      uuid: PUBLISHED,
      setterDisplayName: SETTER_NAME,
      setterAvatarUrl: null,
    });
  });

  it.each([
    ['an approved follower', ctxFor(FOLLOWER)],
    ['the account itself', ctxFor(PRIVATE_AUTHOR)],
  ])('names the private account to %s', async (_label, ctx) => {
    expect(await firstAnnouncedClimb(ctx, [PUBLISHED])).toMatchObject({
      uuid: PUBLISHED,
      setterDisplayName: PRIVATE_DISPLAY,
      setterAvatarUrl: PRIVATE_AVATAR,
    });
  });

  it('skips a climb the community hid after it was announced', async () => {
    await db.update(schema.boardClimbs).set({ isHidden: true }).where(eq(schema.boardClimbs.uuid, LATER_HIDDEN));
    expect(await firstAnnounced(ctxFor(STRANGER), [LATER_HIDDEN, PUBLISHED])).toBe(PUBLISHED);
  });
});
