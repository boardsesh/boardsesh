import { beforeEach, afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { v4 as uuidv4 } from 'uuid';
import { eq, inArray } from 'drizzle-orm';
import type { BoardDiscoveryClimb, ConnectionContext } from '@boardsesh/shared-schema';
import { boardseshTicks, gyms, userBoards, users } from '@boardsesh/db/schema';
import { db } from '../db/client';
import { pubsub } from '../pubsub';
import { boardDiscoveryQueries } from '../graphql/resolvers/social/board-discovery';

const OWNER = 'board-discovery-owner';
const CLIMBERS = [OWNER, 'board-discovery-climber-2', 'board-discovery-climber-3'];
const context = { connectionId: 'board-discovery-test', isAuthenticated: false } as ConnectionContext;
const getDiscoveryClimb = vi.fn<(boardId: string) => Promise<BoardDiscoveryClimb | null>>();
const discover = (input: Record<string, unknown> = {}, ctx = context) =>
  boardDiscoveryQueries.boardDiscovery(null, { input }, ctx);

async function seedGym(overrides: Partial<typeof gyms.$inferInsert> = {}) {
  const uuid = uuidv4();
  const [gym] = await db
    .insert(gyms)
    .values({ uuid, slug: uuid, ownerId: OWNER, name: 'Discovery gym', ...overrides })
    .returning();
  return gym;
}

async function seedBoard(gymId: number | null, overrides: Partial<typeof userBoards.$inferInsert> = {}) {
  const uuid = uuidv4();
  const [board] = await db
    .insert(userBoards)
    .values({
      uuid,
      slug: uuid,
      ownerId: OWNER,
      name: 'Named physical board',
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,2',
      gymId,
      ...overrides,
    })
    .returning();
  return board;
}

async function seedTick(
  boardId: number | null,
  userId: string,
  overrides: Partial<typeof boardseshTicks.$inferInsert> = {},
) {
  await db.insert(boardseshTicks).values({
    uuid: uuidv4(),
    boardType: 'kilter',
    climbUuid: uuidv4(),
    angle: 40,
    status: 'send',
    climbedAt: '2026-09-19T00:00:00Z',
    boardId,
    userId,
    ...overrides,
  });
}

beforeEach(async () => {
  await db.delete(users).where(inArray(users.id, CLIMBERS));
  await db.insert(users).values(CLIMBERS.map((id) => ({ id, email: `${id}@example.test`, name: id })));
  getDiscoveryClimb.mockReset().mockResolvedValue(null);
  vi.spyOn(pubsub, 'getBoardDiscoveryClimb').mockImplementation(getDiscoveryClimb);
});

afterEach(() => vi.restoreAllMocks());

describe('physical board discovery', () => {
  it('ranks distinct send/flash climbers on the actual board before limiting', async () => {
    const gym = await seedGym();
    const zero = await seedBoard(gym.id);
    const repeatSender = await seedBoard(gym.id);
    const popular = await seedBoard(gym.id);
    await seedTick(repeatSender.id, OWNER);
    await seedTick(repeatSender.id, OWNER);
    await seedTick(popular.id, OWNER);
    await seedTick(popular.id, CLIMBERS[1], { status: 'flash' });
    await seedTick(zero.id, CLIMBERS[2], { status: 'attempt' });
    await seedTick(zero.id, CLIMBERS[1], { kilterDetachedAt: '2026-09-19T00:01:00Z' });
    await seedTick(null, CLIMBERS[2]);

    const result = await discover({ limit: 1 });
    expect(result.map((board) => [board.uuid, board.uniqueClimbers])).toEqual([[popular.uuid, 2]]);
    expect(await discover({ gymUuid: gym.uuid })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ uuid: zero.uuid, uniqueClimbers: 0 }),
        expect.objectContaining({ uuid: repeatSender.uuid, uniqueClimbers: 1 }),
      ]),
    );
  });

  it('uses stable UUID order for tied zero-activity boards', async () => {
    const gym = await seedGym();
    const boards = await Promise.all([seedBoard(gym.id), seedBoard(gym.id), seedBoard(gym.id)]);
    expect((await discover({ limit: 2 })).map((board) => board.uuid)).toEqual(
      boards
        .map((board) => board.uuid)
        .sort()
        .slice(0, 2),
    );
  });

  it('filters the gym before ranking and limiting, and does not merge identical configurations', async () => {
    const firstGym = await seedGym();
    const secondGym = await seedGym();
    const first = await seedBoard(firstGym.id);
    const second = await seedBoard(secondGym.id);
    await seedTick(second.id, OWNER);
    expect((await discover({ gymUuid: firstGym.uuid, limit: 1 })).map((board) => board.uuid)).toEqual([first.uuid]);
    expect((await discover()).map((board) => board.uuid)).toEqual([second.uuid, first.uuid]);
  });

  it.each([
    ['private', { isPublic: false }],
    ['unlisted', { isUnlisted: true }],
    ['location-hidden', { hideLocation: true }],
    ['deleted', { deletedAt: new Date() }],
    ['merged', { mergedIntoBoardUuid: uuidv4() }],
    ['empty slug', { slug: '' }],
    ['unpublished spray wall', { boardType: 'spray' }],
  ] satisfies Array<[string, Partial<typeof userBoards.$inferInsert>]>)(
    'excludes %s boards even for their owner',
    async (_name, overrides) => {
      const gym = await seedGym();
      await seedBoard(gym.id, overrides);
      expect(await discover({ gymUuid: gym.uuid })).toEqual([]);
      expect(await discover({ gymUuid: gym.uuid }, { ...context, isAuthenticated: true, userId: OWNER })).toEqual([]);
      expect(getDiscoveryClimb).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['private', { isPublic: false }],
    ['deleted', { deletedAt: new Date() }],
    ['missing slug', { slug: null }],
    ['empty slug', { slug: '' }],
  ] satisfies Array<[string, Partial<typeof gyms.$inferInsert>]>)(
    'excludes boards from a %s gym',
    async (_name, overrides) => {
      const gym = await seedGym(overrides);
      await seedBoard(gym.id);
      expect(await discover()).toEqual([]);
    },
  );

  it('excludes merged gyms and standalone configuration rows', async () => {
    const canonical = await seedGym();
    const merged = await seedGym({ mergedIntoGymId: canonical.id });
    await seedBoard(merged.id);
    await seedBoard(null);
    expect(await discover()).toEqual([]);
  });

  it('projects only public board identity and its redacted presence snapshot', async () => {
    const gym = await seedGym();
    const board = await seedBoard(gym.id, { serialNumber: 'private-controller-serial' });
    const currentClimb = { uuid: 'lit-climb', name: 'Last confirmed climb', frames: 'p1r12', angle: 35 };
    getDiscoveryClimb.mockResolvedValue(currentClimb);
    const [result] = await discover();
    expect(result).toEqual({
      uuid: board.uuid,
      slug: board.slug,
      name: board.name,
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,2',
      angle: 40,
      gymUuid: gym.uuid,
      gymName: gym.name,
      gymSlug: gym.slug,
      locationName: null,
      uniqueClimbers: 0,
      currentClimb,
    });
    expect(getDiscoveryClimb).toHaveBeenCalledWith(String(board.id));
    await db.update(userBoards).set({ hideLocation: true }).where(eq(userBoards.id, board.id));
    expect(await discover()).toEqual([]);
  });

  it('defaults to eight, caps at twelve, and rejects invalid input', async () => {
    const gym = await seedGym();
    await Promise.all(Array.from({ length: 13 }, () => seedBoard(gym.id)));
    expect(await discover()).toHaveLength(8);
    expect(await discover({ limit: null, gymUuid: null })).toHaveLength(8);
    expect(await discover({ limit: 12 })).toHaveLength(12);
    for (const input of [{ limit: 13 }, { limit: 0 }, { limit: 1.5 }, { gymUuid: 'not-a-uuid' }]) {
      await expect(discover(input)).rejects.toThrow();
    }
  });
});
