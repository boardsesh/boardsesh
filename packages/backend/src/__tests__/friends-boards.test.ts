import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { and, eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import * as schema from '@boardsesh/db/schema';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { friendsBoardsQueries, readFriendsBoards } from '../graphql/resolvers/social/friends-boards';
import { socialBoardMutations, socialBoardQueries } from '../graphql/resolvers/social/boards';
import { privacyMutations, privacyQueries } from '../graphql/resolvers/privacy';
import { boardShareLinkMutations, boardShareLinkQueries } from '../graphql/resolvers/privacy/board-share-links';

// Friends' boards (docs/product/privacy.md): a board is listed only when its
// owner and the viewer follow each other, what a row shows, and how joining a
// board puts it in Your boards. Real Postgres: the gating is SQL.

const owner = 'friends-owner';
// The owner and they follow each other.
const friend = 'friends-friend';
// The owner follows them; they do not follow the owner.
const followed = 'friends-followed';
// They follow the owner; the owner does not follow them.
const fan = 'friends-fan';
const stranger = 'friends-stranger';
// Mutual follow; an approved grant on every board.
const member = 'friends-member';
// Mutual follow; a pending request on every board.
const requester = 'friends-requester';
// Mutual follow; removed from every board.
const removed = 'friends-removed';
// They follow the owner and hold an approved grant on every board, but the
// owner does not follow them.
const fanMember = 'friends-fan-member';
// The owner follows them and they hold an approved grant on every board, but
// they do not follow the owner.
const followedMember = 'friends-followed-member';
const otherOwner = 'friends-other-owner';
// Mutual follow with otherOwner.
const neighbour = 'friends-neighbour';
// Mutual follow with the owner; asks for one board.
const asker = 'friends-asker';
const joiner = 'friends-joiner';
const orderer = 'friends-orderer';
const quietOwner = 'friends-quiet-owner';
const busyOwner = 'friends-busy-owner';
const saver = 'friends-saver';

type Audience = 'public' | 'unlisted' | 'followers' | 'invite_only' | 'only_me';
const AUDIENCES: Audience[] = ['public', 'unlisted', 'followers', 'invite_only', 'only_me'];

const context = (userId: string) =>
  ({ isAuthenticated: true, userId, connectionId: `friends-${userId}-${Math.random()}` }) as ConnectionContext;

let boardSerial = 0;
async function seedBoard(
  ownerId: string,
  audience: Audience,
  options: {
    listed?: boolean;
    boardType?: string;
    gymId?: number;
    deleted?: boolean;
    name?: string;
    locationAudience?: 'public' | 'followers' | 'members' | 'only_me';
  } = {},
): Promise<{ uuid: string; slug: string; id: number }> {
  boardSerial += 1;
  const uuid = uuidv4();
  const slug = `friends-${audience.replace(/_/g, '-')}-${boardSerial}`;
  const [row] = await db
    .insert(schema.userBoards)
    .values({
      uuid,
      slug,
      ownerId,
      name: options.name ?? `Garage ${audience} ${options.listed ? 'listed' : 'quiet'} ${boardSerial}`,
      boardType: options.boardType ?? 'kilter',
      layoutId: 1,
      sizeId: 100 + boardSerial,
      setIds: '1',
      isPublic: audience === 'public',
      isUnlisted: audience === 'unlisted',
      hideLocation: false,
      locationName: 'Secret garage, 12 Example Street',
      latitude: 51.5,
      longitude: -0.12,
      serialNumber: `SERIAL-${boardSerial}`,
      gymId: options.gymId ?? null,
      deletedAt: options.deleted ? new Date() : null,
    })
    .returning({ id: schema.userBoards.id });
  await db.insert(schema.resourcePrivacy).values({
    kind: 'board',
    resourceId: uuid,
    ownerId,
    audience,
    // Location open to everyone with board access by default, so a slim card
    // leaking it would show up in the assertions below.
    locationAudience: options.locationAudience ?? 'public',
    listedToFollowers: options.listed ?? false,
  });
  return { uuid, slug, id: Number(row.id) };
}

async function setGrant(boardUuid: string, userId: string, status: 'pending' | 'approved' | 'revoked') {
  await db
    .insert(schema.resourceGrants)
    .values({ kind: 'board', resourceId: boardUuid, userId, status, invitedBy: owner })
    .onConflictDoUpdate({
      target: [schema.resourceGrants.kind, schema.resourceGrants.resourceId, schema.resourceGrants.userId],
      set: { status },
    });
}

/** `followerId` follows `followingId` (an accepted follow). */
async function follow(followerId: string, followingId: string) {
  await db.insert(schema.userFollows).values({ followerId, followingId }).onConflictDoNothing();
}

async function follows(userId: string, boardUuid: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.boardFollows.id })
    .from(schema.boardFollows)
    .where(and(eq(schema.boardFollows.userId, userId), eq(schema.boardFollows.boardUuid, boardUuid)));
  return rows.length > 0;
}

async function friendsBoards(viewerId: string, input: { query?: string; limit?: number; offset?: number } = {}) {
  return friendsBoardsQueries.friendsBoards(null, { input }, context(viewerId));
}

const mutual = [friend, member, requester, removed, asker, joiner];
const matrix = new Map<string, { uuid: string; audience: Audience; listed: boolean }>();
const keyOf = (audience: Audience, listed: boolean) => `${audience}:${listed ? 'listed' : 'quiet'}`;

beforeAll(async () => {
  vi.stubEnv('BOARDSESH_PRIVACY_ENABLED', '1');
  await db.insert(schema.users).values(
    [
      owner,
      friend,
      followed,
      fan,
      stranger,
      member,
      requester,
      removed,
      fanMember,
      followedMember,
      otherOwner,
      neighbour,
      asker,
      joiner,
      orderer,
      quietOwner,
      busyOwner,
      saver,
    ].map((id) => ({
      id,
      name: id,
      email: `${id}@test.invalid`,
    })),
  );
  await db.insert(schema.userProfiles).values({ userId: owner, displayName: 'Sam Setter' });
  await db.insert(schema.userFollows).values([
    ...[...mutual, followed, followedMember].map((viewer) => ({ followerId: owner, followingId: viewer })),
    ...[...mutual, fan, fanMember].map((viewer) => ({ followerId: viewer, followingId: owner })),
    ...[otherOwner, neighbour].map((followerId) => ({
      followerId,
      followingId: followerId === otherOwner ? neighbour : otherOwner,
    })),
  ]);
  for (const audience of AUDIENCES) {
    for (const listed of [false, true]) {
      const board = await seedBoard(owner, audience, { listed });
      matrix.set(keyOf(audience, listed), { uuid: board.uuid, audience, listed });
      await setGrant(board.uuid, member, 'approved');
      await setGrant(board.uuid, fanMember, 'approved');
      await setGrant(board.uuid, followedMember, 'approved');
      await setGrant(board.uuid, requester, 'pending');
      await setGrant(board.uuid, removed, 'revoked');
    }
  }
});

afterAll(() => vi.unstubAllEnvs());

/** What each viewer should see, keyed by audience:listed. Missing = not listed. */
function expectedFor(viewer: string, options: { controlsOn?: boolean } = {}): Map<string, string> {
  const controlsOn = options.controlsOn ?? true;
  const expected = new Map<string, string>();
  for (const [key, { audience, listed }] of matrix) {
    // Only friends (both follows); a one-way follow lists nothing either way.
    if (!mutual.includes(viewer) || viewer === removed || audience === 'only_me') continue;
    const hasGrant = viewer === member;
    const switchOn = listed && controlsOn;
    // The viewer follows the owner, so Public and Followers always open.
    if (audience === 'public' || audience === 'followers') expected.set(key, 'CAN_CLIMB');
    else if (hasGrant) expected.set(key, 'CAN_CLIMB');
    else if (!switchOn) continue;
    else if (audience === 'unlisted') expected.set(key, 'CAN_CLIMB');
    // Invite-only, switch on, no grant: the only ask card.
    else expected.set(key, viewer === requester ? 'REQUESTED' : 'CAN_REQUEST');
  }
  return expected;
}

async function listedFor(viewer: string): Promise<Map<string, string>> {
  const page = await friendsBoards(viewer, { limit: 50 });
  const byUuid = new Map([...matrix].map(([key, board]) => [board.uuid, key]));
  const listed = new Map<string, string>();
  for (const item of page.items) {
    const key = byUuid.get(item.preview.uuid);
    if (key) listed.set(key, item.viewerAccess);
  }
  expect(page.totalCount).toBe(page.items.length);
  return listed;
}

describe('friendsBoards visibility', () => {
  for (const viewer of [friend, followed, fan, stranger, member, requester, removed, fanMember, followedMember]) {
    it(`lists exactly the expected boards for ${viewer}`, async () => {
      expect(Object.fromEntries(await listedFor(viewer))).toEqual(Object.fromEntries(expectedFor(viewer)));
    });
  }

  it('lists nothing on a one-way follow, in either direction', async () => {
    // They follow the owner; the owner does not follow back.
    expect(await friendsBoards(fan, { limit: 50 })).toEqual({ items: [], totalCount: 0, hasMore: false });
    // The owner follows them; they do not follow back.
    expect(await friendsBoards(followed, { limit: 50 })).toEqual({ items: [], totalCount: 0, hasMore: false });
    // Not even a board they hold an approved grant on.
    expect((await friendsBoards(fanMember, { limit: 50 })).totalCount).toBe(0);
    expect((await friendsBoards(followedMember, { limit: 50 })).totalCount).toBe(0);
  });

  it('lists both people’s boards to each other only once they follow each other', async () => {
    const sam = 'friends-direction-sam';
    const alex = 'friends-direction-alex';
    await db.insert(schema.users).values([sam, alex].map((id) => ({ id, name: id, email: `${id}@test.invalid` })));
    const samBoard = await seedBoard(sam, 'public');
    const alexBoard = await seedBoard(alex, 'followers');
    await follow(sam, alex);
    expect((await readFriendsBoards(alex, { limit: 50 })).totalCount).toBe(0);
    expect((await readFriendsBoards(sam, { limit: 50 })).totalCount).toBe(0);
    await follow(alex, sam);
    expect((await readFriendsBoards(alex, { limit: 50 })).items.map((item) => item.preview.uuid)).toEqual([
      samBoard.uuid,
    ]);
    // A Followers board always opens for a friend: they follow its owner.
    const samSees = await readFriendsBoards(sam, { limit: 50 });
    expect(samSees.items.map((item) => [item.preview.uuid, item.viewerAccess])).toEqual([
      [alexBoard.uuid, 'CAN_CLIMB'],
    ]);
  });

  it('lists a private account’s boards only once it approves the follow', async () => {
    const privateOwner = 'friends-private-owner';
    const climber = 'friends-private-climber';
    await db
      .insert(schema.users)
      .values([privateOwner, climber].map((id) => ({ id, name: id, email: `${id}@test.invalid` })));
    await db.insert(schema.userProfiles).values({ userId: privateOwner, displayName: 'Pat Private', isPrivate: true });
    const board = await seedBoard(privateOwner, 'followers');
    await follow(privateOwner, climber);
    // A pending request is not a follow.
    await db.insert(schema.userFollowRequests).values({ requesterId: climber, recipientId: privateOwner });
    expect((await readFriendsBoards(climber, { limit: 50 })).totalCount).toBe(0);

    // Approved: the request becomes a follow.
    await db
      .delete(schema.userFollowRequests)
      .where(
        and(
          eq(schema.userFollowRequests.requesterId, climber),
          eq(schema.userFollowRequests.recipientId, privateOwner),
        ),
      );
    await follow(climber, privateOwner);
    const page = await readFriendsBoards(climber, { limit: 50 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0].viewerAccess).toBe('CAN_CLIMB');
    // Both owner fields name the private owner: the climber is now a follower.
    expect(page.items[0].owner).toMatchObject({ userId: privateOwner, displayName: 'Pat Private' });
    expect(page.items[0].board?.ownerId).toBe(privateOwner);
    expect(page.items[0].board?.ownerDisplayName).toBe('Pat Private');
    expect(board.uuid).toBe(page.items[0].preview.uuid);
  });

  it('shows no place on a listed Unlisted board whose location is hidden', async () => {
    const hiddenOwner = 'friends-hidden-owner';
    const climber = 'friends-hidden-climber';
    await db
      .insert(schema.users)
      .values([hiddenOwner, climber].map((id) => ({ id, name: id, email: `${id}@test.invalid` })));
    const board = await seedBoard(hiddenOwner, 'unlisted', { listed: true, locationAudience: 'only_me' });
    await follow(hiddenOwner, climber);
    await follow(climber, hiddenOwner);
    const page = await readFriendsBoards(climber, { limit: 50 });
    expect(page.items.map((item) => [item.preview.uuid, item.viewerAccess])).toEqual([[board.uuid, 'CAN_CLIMB']]);
    expect(page.items[0].board?.slug).toBeTruthy();
    expect(JSON.stringify(page.items[0])).not.toMatch(/Secret garage|51\.5|-0\.12/);
  });

  it('shows a full board only to someone who can climb on it', async () => {
    const page = await friendsBoards(friend, { limit: 50 });
    for (const item of page.items) {
      expect(item.owner).toEqual({ userId: owner, displayName: 'Sam Setter', avatarUrl: null });
      if (item.viewerAccess === 'CAN_CLIMB') {
        expect(item.board?.uuid).toBe(item.preview.uuid);
        expect(item.board?.slug).toBeTruthy();
        // The full card goes through enrichBoards: the location audience decides the place.
        expect(item.board?.locationName).toBe('Secret garage, 12 Example Street');
      } else {
        expect(item.board).toBeNull();
      }
    }
  });

  it('keeps the slug, serial, location and counts off a request card', async () => {
    const page = await friendsBoards(friend, { limit: 50 });
    const requestCards = page.items.filter((item) => item.viewerAccess !== 'CAN_CLIMB');
    // Only the opted-in Invite-only board: a friend opens every Followers board.
    expect(requestCards).toHaveLength(1);
    for (const card of requestCards) {
      expect(card.board).toBeNull();
      expect(Object.keys(card.preview).sort()).toEqual(
        ['angle', 'boardType', 'layoutId', 'name', 'setIds', 'sizeId', 'uuid'].sort(),
      );
      const serialized = JSON.stringify(card);
      expect(serialized).not.toMatch(/friends-invite-only|friends-followers|SERIAL-|Secret garage|51\.5|-0\.12/);
    }
  });

  it('lists only boards the viewer can open while the privacy controls are off', async () => {
    vi.stubEnv('BOARDSESH_PRIVACY_ENABLED', '0');
    try {
      // Every switch reads as off, and nobody can answer a request, so there is
      // no ask card: the opted-in Invite-only board drops out.
      for (const viewer of [friend, requester, member]) {
        expect(Object.fromEntries(await listedFor(viewer))).toEqual(
          Object.fromEntries(expectedFor(viewer, { controlsOn: false })),
        );
      }
      expect(Object.fromEntries(await listedFor(requester))).toEqual({
        'public:quiet': 'CAN_CLIMB',
        'public:listed': 'CAN_CLIMB',
        'followers:quiet': 'CAN_CLIMB',
        'followers:listed': 'CAN_CLIMB',
      });
    } finally {
      vi.stubEnv('BOARDSESH_PRIVACY_ENABLED', '1');
    }
  });

  it('filters on the board name and the owner name', async () => {
    const byOwner = await friendsBoards(friend, { query: 'sam set', limit: 50 });
    expect(byOwner.totalCount).toBe(expectedFor(friend).size);
    const byBoard = await friendsBoards(friend, { query: 'garage invite_only listed', limit: 50 });
    expect(byBoard.items.map((item) => item.preview.uuid)).toEqual([matrix.get(keyOf('invite_only', true))!.uuid]);
    // LIKE wildcards are matched literally.
    expect((await friendsBoards(friend, { query: '%' })).totalCount).toBe(0);
  });

  it('pages with a count that matches the rows', async () => {
    const first = await friendsBoards(friend, { limit: 2 });
    const rest = await friendsBoards(friend, { limit: 50, offset: 2 });
    expect(first.hasMore).toBe(true);
    expect(rest.hasMore).toBe(false);
    const uuids = [...first.items, ...rest.items].map((item) => item.preview.uuid);
    expect(new Set(uuids).size).toBe(first.totalCount);
  });

  it('requires a signed-in viewer', async () => {
    await expect(
      friendsBoardsQueries.friendsBoards(null, { input: {} }, {
        isAuthenticated: false,
        connectionId: 'anon',
      } as ConnectionContext),
    ).rejects.toThrow();
  });
});

describe('friendsBoards leaves out boards that are not a friend’s home board to save', () => {
  it('skips deleted boards, gym boards, spray walls and boards already saved', async () => {
    const [gym] = await db
      .insert(schema.gyms)
      .values({ uuid: `friends-gym-${uuidv4()}`, name: 'Friends Gym', ownerId: otherOwner, isPublic: true })
      .returning({ id: schema.gyms.id });
    const visible = await seedBoard(otherOwner, 'public', { name: 'Other visible' });
    await seedBoard(otherOwner, 'public', { deleted: true });
    await seedBoard(otherOwner, 'public', { gymId: Number(gym.id) });
    await seedBoard(otherOwner, 'public', { boardType: 'spray' });
    const saved = await seedBoard(otherOwner, 'public', { name: 'Other saved' });
    await db.insert(schema.boardFollows).values({ userId: neighbour, boardUuid: saved.uuid });

    const page = await readFriendsBoards(neighbour, { limit: 50 });
    const otherOwnerUuids = page.items.filter((item) => item.owner.userId === otherOwner).map((i) => i.preview.uuid);
    expect(otherOwnerUuids).toEqual([visible.uuid]);
  });

  it('lists a home wall at a gym its owner runs privately, but not at someone else’s gym', async () => {
    const mintGym = async (gymOwner: string, values: { isPublic: boolean; isListed?: boolean; deleted?: boolean }) => {
      const [gym] = await db
        .insert(schema.gyms)
        .values({
          uuid: `friends-gym-${uuidv4()}`,
          name: 'Home gym',
          ownerId: gymOwner,
          isPublic: values.isPublic,
          isListed: values.isListed ?? true,
          deletedAt: values.deleted ? new Date() : null,
        })
        .returning({ id: schema.gyms.id });
      return Number(gym.id);
    };
    const privateHome = await seedBoard(otherOwner, 'public', {
      gymId: await mintGym(otherOwner, { isPublic: false }),
    });
    const unlistedHome = await seedBoard(otherOwner, 'public', {
      gymId: await mintGym(otherOwner, { isPublic: true, isListed: false }),
    });
    const deletedGym = await seedBoard(otherOwner, 'public', {
      gymId: await mintGym(stranger, { isPublic: true, deleted: true }),
    });
    const ownPublicGym = await seedBoard(otherOwner, 'public', {
      gymId: await mintGym(otherOwner, { isPublic: true }),
    });
    const someoneElsesPrivateGym = await seedBoard(otherOwner, 'public', {
      gymId: await mintGym(stranger, { isPublic: false }),
    });

    const listed = (await readFriendsBoards(neighbour, { limit: 50 })).items.map((item) => item.preview.uuid);
    expect(listed).toEqual(expect.arrayContaining([privateHome.uuid, unlistedHome.uuid, deletedGym.uuid]));
    expect(listed).not.toContain(ownPublicGym.uuid);
    expect(listed).not.toContain(someoneElsesPrivateGym.uuid);
  });

  it('keeps listing a saved board the climber can no longer open, so they can ask for it', async () => {
    // Friends: saver can open (and so save) the Followers board, and
    // otherOwner's boards are listed to them.
    await follow(saver, otherOwner);
    await follow(otherOwner, saver);
    const wasPublic = await seedBoard(otherOwner, 'public', { name: 'Was public' });
    const wasFollowers = await seedBoard(otherOwner, 'followers', { name: 'Was followers' });
    for (const board of [wasPublic, wasFollowers]) {
      await socialBoardMutations.followBoard(null, { input: { boardUuid: board.uuid } }, context(saver));
    }
    const listedUuids = async () =>
      (await readFriendsBoards(saver, { limit: 50 })).items.map((item) => [item.preview.uuid, item.viewerAccess]);
    // Saved and readable: in Your boards, so not here.
    expect(Object.fromEntries(await listedUuids())).not.toHaveProperty(wasPublic.uuid);
    expect(Object.fromEntries(await listedUuids())).not.toHaveProperty(wasFollowers.uuid);

    // The owner makes both Invite-only and shows them to friends.
    for (const board of [wasPublic, wasFollowers]) {
      await privacyMutations.updateResourcePrivacy(
        null,
        { input: { kind: 'board', resourceId: board.uuid, audience: 'invite_only', listedToFollowers: true } },
        context(otherOwner),
      );
    }
    const mine = await socialBoardQueries.myBoards(null, { input: { limit: 50 } }, context(saver));
    expect(mine.boards.map((saved) => saved.uuid)).not.toContain(wasPublic.uuid);
    expect(mine.boards.map((saved) => saved.uuid)).not.toContain(wasFollowers.uuid);
    const listed = Object.fromEntries(await listedUuids());
    expect(listed[wasPublic.uuid]).toBe('CAN_REQUEST');
    expect(listed[wasFollowers.uuid]).toBe('CAN_REQUEST');
    // The save row is untouched, so an approval brings it back to Your boards.
    expect(await follows(saver, wasPublic.uuid)).toBe(true);
  });

  it('orders by the owner’s latest log the viewer may read, ignoring Only me logs', async () => {
    await db.insert(schema.userProfiles).values([
      { userId: busyOwner, displayName: 'Aaron Busy' },
      { userId: quietOwner, displayName: 'Bea Quiet' },
    ]);
    for (const friendOwner of [busyOwner, quietOwner]) {
      await follow(friendOwner, orderer);
      await follow(orderer, friendOwner);
    }
    const busyBoard = await seedBoard(busyOwner, 'public');
    const quietBoard = await seedBoard(quietOwner, 'public');
    const hiddenTick = `friends-tick-hidden-${uuidv4()}`;
    await db.insert(schema.boardseshTicks).values([
      {
        uuid: hiddenTick,
        userId: busyOwner,
        climbUuid: 'catalog-climb',
        boardType: 'kilter',
        angle: 40,
        status: 'send',
        climbedAt: '2026-03-01T10:00:00Z',
        boardId: busyBoard.id,
      },
      {
        uuid: `friends-tick-visible-${uuidv4()}`,
        userId: quietOwner,
        climbUuid: 'catalog-climb',
        boardType: 'kilter',
        angle: 40,
        status: 'send',
        climbedAt: '2026-02-01T10:00:00Z',
        boardId: quietBoard.id,
      },
    ]);
    await db
      .insert(schema.contentPrivacy)
      .values({ entityType: 'tick', entityId: hiddenTick, ownerId: busyOwner, audience: 'only_me' });

    const page = await readFriendsBoards(orderer, { limit: 50 });
    // Aaron's Only me log does not count, so Bea's older public log leads, even
    // though Aaron would win on name.
    expect(page.items.map((item) => item.preview.uuid)).toEqual([quietBoard.uuid, busyBoard.uuid]);
  });

  it('puts the boards the viewer has logged on first, newest log first', async () => {
    const older = matrix.get(keyOf('followers', false))!;
    const newer = matrix.get(keyOf('public', true))!;
    const boardIds = await db
      .select({ uuid: schema.userBoards.uuid, id: schema.userBoards.id })
      .from(schema.userBoards)
      .where(eq(schema.userBoards.ownerId, owner));
    const idOf = (uuid: string) => Number(boardIds.find((row) => row.uuid === uuid)!.id);
    await db.insert(schema.boardseshTicks).values([
      {
        uuid: `friends-tick-old-${uuidv4()}`,
        userId: friend,
        climbUuid: 'catalog-climb',
        boardType: 'kilter',
        angle: 40,
        status: 'send',
        climbedAt: '2026-01-01T10:00:00Z',
        boardId: idOf(older.uuid),
      },
      {
        uuid: `friends-tick-new-${uuidv4()}`,
        userId: friend,
        climbUuid: 'catalog-climb',
        boardType: 'kilter',
        angle: 40,
        status: 'send',
        climbedAt: '2026-02-01T10:00:00Z',
        boardId: idOf(newer.uuid),
      },
    ]);
    const page = await readFriendsBoards(friend, { limit: 2 });
    expect(page.items.map((item) => item.preview.uuid)).toEqual([newer.uuid, older.uuid]);
  });
});

describe('membership puts a board in Your boards', () => {
  let board: { uuid: string };

  beforeEach(async () => {
    board = await seedBoard(owner, 'invite_only', { listed: true });
  });

  it('lets a member save a private board, and nobody else', async () => {
    const followersBoard = await seedBoard(owner, 'followers');
    await expect(
      socialBoardMutations.followBoard(null, { input: { boardUuid: followersBoard.uuid } }, context(friend)),
    ).resolves.toBe(true);
    // The owner follows `followed`, but they do not follow the owner back:
    // not theirs to save.
    await expect(
      socialBoardMutations.followBoard(null, { input: { boardUuid: followersBoard.uuid } }, context(followed)),
    ).rejects.toThrow('Cannot follow a private board');
    await expect(
      socialBoardMutations.followBoard(null, { input: { boardUuid: followersBoard.uuid } }, context(stranger)),
    ).rejects.toThrow('Cannot follow a private board');

    await expect(
      socialBoardMutations.followBoard(null, { input: { boardUuid: board.uuid } }, context(friend)),
    ).rejects.toThrow('Cannot follow a private board');
    await setGrant(board.uuid, member, 'approved');
    await expect(
      socialBoardMutations.followBoard(null, { input: { boardUuid: board.uuid } }, context(member)),
    ).resolves.toBe(true);
    await setGrant(board.uuid, removed, 'revoked');
    await expect(
      socialBoardMutations.followBoard(null, { input: { boardUuid: board.uuid } }, context(removed)),
    ).rejects.toThrow('Cannot follow a private board');
    expect(await follows(removed, board.uuid)).toBe(false);
  });

  it('saves the board for a climber who joins through the share link', async () => {
    const link = await boardShareLinkQueries.boardShareLink(null, { boardUuid: board.uuid }, context(owner));
    await boardShareLinkMutations.redeemBoardShareLink(null, { token: link!.token }, context(joiner));
    expect(await follows(joiner, board.uuid)).toBe(true);
    const mine = await socialBoardQueries.myBoards(null, { input: { limit: 50 } }, context(joiner));
    expect(mine.boards.map((saved) => saved.uuid)).toContain(board.uuid);
    // Saved, so it leaves Friends' boards.
    const friends = await readFriendsBoards(joiner, { limit: 50 });
    expect(friends.items.map((item) => item.preview.uuid)).not.toContain(board.uuid);
  });

  it('does not save a spray wall when the owner approves a request on it', async () => {
    const wall = await seedBoard(owner, 'invite_only', { boardType: 'spray' });
    await setGrant(wall.uuid, followed, 'pending');
    await privacyMutations.approveResourceAccess(
      null,
      { kind: 'board', resourceId: wall.uuid, userId: followed },
      context(owner),
    );
    const [grant] = await db
      .select({ status: schema.resourceGrants.status })
      .from(schema.resourceGrants)
      .where(and(eq(schema.resourceGrants.resourceId, wall.uuid), eq(schema.resourceGrants.userId, followed)));
    expect(grant.status).toBe('approved');
    expect(await follows(followed, wall.uuid)).toBe(false);
  });

  it('saves the board when the owner approves a request, but not on a name invite', async () => {
    const accessOf = async () =>
      (await readFriendsBoards(asker, { limit: 50 })).items.find((item) => item.preview.uuid === board.uuid)
        ?.viewerAccess;
    expect(await accessOf()).toBe('CAN_REQUEST');
    await privacyMutations.requestResourceAccess(null, { kind: 'board', resourceId: board.uuid }, context(asker));
    expect(await accessOf()).toBe('REQUESTED');
    expect(await follows(asker, board.uuid)).toBe(false);

    await privacyMutations.approveResourceAccess(
      null,
      { kind: 'board', resourceId: board.uuid, userId: asker },
      context(owner),
    );
    expect(await follows(asker, board.uuid)).toBe(true);
    // Saved, so it leaves Friends' boards for Your boards.
    expect(await accessOf()).toBeUndefined();

    await privacyMutations.inviteResourceMember(
      null,
      { kind: 'board', resourceId: board.uuid, userId: stranger },
      context(owner),
    );
    expect(await follows(stranger, board.uuid)).toBe(false);
  });

  it('drops a board from Your boards when the owner removes the climber, and brings it back on a re-invite', async () => {
    const link = await boardShareLinkQueries.boardShareLink(null, { boardUuid: board.uuid }, context(owner));
    await boardShareLinkMutations.redeemBoardShareLink(null, { token: link!.token }, context(joiner));
    const before = await socialBoardQueries.myBoards(null, { input: { limit: 50 } }, context(joiner));

    await privacyMutations.revokeResourceAccess(
      null,
      { kind: 'board', resourceId: board.uuid, userId: joiner },
      context(owner),
    );
    const after = await socialBoardQueries.myBoards(null, { input: { limit: 50 } }, context(joiner));
    expect(after.boards.map((saved) => saved.uuid)).not.toContain(board.uuid);
    expect(after.totalCount).toBe(before.totalCount - 1);
    expect(after.totalCount).toBe(after.boards.length);
    // The follow row is kept, so a re-invite restores the board.
    expect(await follows(joiner, board.uuid)).toBe(true);
    // A removed climber is not shown the board in Friends' boards either.
    const friends = await readFriendsBoards(joiner, { limit: 50 });
    expect(friends.items.map((item) => item.preview.uuid)).not.toContain(board.uuid);

    await privacyMutations.inviteResourceMember(
      null,
      { kind: 'board', resourceId: board.uuid, userId: joiner },
      context(owner),
    );
    const reinvited = await socialBoardQueries.myBoards(null, { input: { limit: 50 } }, context(joiner));
    expect(reinvited.boards.map((saved) => saved.uuid)).toContain(board.uuid);
  });
});

describe('the "Show to friends" switch', () => {
  it('is saved, read back, and kept when another setting changes', async () => {
    const board = await seedBoard(owner, 'invite_only');
    const saved = await privacyMutations.updateResourcePrivacy(
      null,
      { input: { kind: 'board', resourceId: board.uuid, audience: 'invite_only', listedToFollowers: true } },
      context(owner),
    );
    expect(saved?.listedToFollowers).toBe(true);
    const kept = await privacyMutations.updateResourcePrivacy(
      null,
      { input: { kind: 'board', resourceId: board.uuid, audience: 'unlisted' } },
      context(owner),
    );
    expect(kept?.listedToFollowers).toBe(true);
    const read = await privacyQueries.resourcePrivacy(null, { kind: 'board', resourceId: board.uuid }, context(owner));
    expect(read?.listedToFollowers).toBe(true);
  });

  it('is turned off when the board leaves Unlisted and Invite-only', async () => {
    const board = await seedBoard(owner, 'unlisted');
    const save = (input: {
      audience: 'public' | 'unlisted' | 'invite_only' | 'only_me';
      listedToFollowers?: boolean;
    }) =>
      privacyMutations.updateResourcePrivacy(
        null,
        { input: { kind: 'board', resourceId: board.uuid, ...input } },
        context(owner),
      );
    expect((await save({ audience: 'unlisted', listedToFollowers: true }))?.listedToFollowers).toBe(true);
    const listedUuids = async () =>
      (await readFriendsBoards(friend, { limit: 50 })).items.map((item) => item.preview.uuid);
    expect(await listedUuids()).toContain(board.uuid);
    // Through Public and back: the switch does not come back on its own.
    expect((await save({ audience: 'public' }))?.listedToFollowers).toBe(false);
    expect((await save({ audience: 'unlisted' }))?.listedToFollowers).toBe(false);
    expect(await listedUuids()).not.toContain(board.uuid);

    // Only me clears it too, even when a client sends true alongside.
    await save({ audience: 'invite_only', listedToFollowers: true });
    expect((await save({ audience: 'only_me', listedToFollowers: true }))?.listedToFollowers).toBe(false);
    expect((await save({ audience: 'invite_only' }))?.listedToFollowers).toBe(false);
  });

  it('refuses to turn it on for a spray wall', async () => {
    const wall = await seedBoard(owner, 'invite_only', { boardType: 'spray' });
    await expect(
      privacyMutations.updateResourcePrivacy(
        null,
        { input: { kind: 'board', resourceId: wall.uuid, audience: 'invite_only', listedToFollowers: true } },
        context(owner),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });
});
