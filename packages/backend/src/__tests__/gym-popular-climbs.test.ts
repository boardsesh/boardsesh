import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { v4 as uuidv4 } from 'uuid';
import { eq, inArray } from 'drizzle-orm';
import {
  boardClimbAliases,
  boardClimbs,
  boardseshTicks,
  contentPrivacy,
  gyms,
  resourcePrivacy,
  userBoards,
  userProfiles,
  users,
} from '@boardsesh/db/schema';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { pubsub } from '../pubsub';
import { boardDiscoveryQueries, loadPopularGymClimbs } from '../graphql/resolvers/social/board-discovery';

const OWNER = 'gym-popular-owner';
const PRIVATE_CLIMBER = 'gym-popular-private';
const context = { connectionId: 'gym-popular-test', isAuthenticated: false } as ConnectionContext;

async function seedGym(overrides: Partial<typeof gyms.$inferInsert> = {}) {
  const uuid = uuidv4();
  const [gym] = await db
    .insert(gyms)
    .values({ uuid, slug: uuid, name: 'Gym preview', ownerId: OWNER, ...overrides })
    .returning();
  return gym;
}

async function seedBoard(gymId: number, overrides: Partial<typeof userBoards.$inferInsert> = {}) {
  const uuid = uuidv4();
  const [board] = await db
    .insert(userBoards)
    .values({
      uuid,
      slug: uuid,
      ownerId: OWNER,
      gymId,
      name: 'Physical wall',
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,2',
      ...overrides,
    })
    .returning();
  return { ...board, boardId: board.id };
}

async function seedClimb(overrides: Partial<typeof boardClimbs.$inferInsert> = {}) {
  const [climb] = await db
    .insert(boardClimbs)
    .values({
      uuid: uuidv4(),
      name: 'Public climb',
      boardType: 'kilter',
      layoutId: 1,
      isDraft: false,
      isListed: true,
      frames: 'p123r12p124r13',
      requiredSetIds: [1],
      compatibleSizeIds: [10],
      ...overrides,
    })
    .returning();
  return climb;
}

async function seedTick(
  boardId: number,
  climbUuid: string,
  overrides: Partial<typeof boardseshTicks.$inferInsert> = {},
) {
  const [tick] = await db
    .insert(boardseshTicks)
    .values({
      uuid: uuidv4(),
      userId: OWNER,
      boardId,
      climbUuid,
      boardType: 'kilter',
      angle: 40,
      status: 'send',
      climbedAt: '2026-11-18T12:00:00Z',
      ...overrides,
    })
    .returning();
  return tick;
}

beforeEach(async () => {
  await db.delete(users).where(inArray(users.id, [OWNER, PRIVATE_CLIMBER]));
  await db.insert(users).values([OWNER, PRIVATE_CLIMBER].map((id) => ({ id, name: id, email: `${id}@example.test` })));
  vi.spyOn(pubsub, 'getBoardDiscoveryClimb').mockResolvedValue(null);
});
afterEach(() => vi.restoreAllMocks());

describe('public popular climbs at a physical gym board', () => {
  it('totals a climb across angles before choosing its most-logged angle, counting repeat sends', async () => {
    const gym = await seedGym();
    const board = await seedBoard(gym.id);
    const acrossAngles = await seedClimb();
    const singleAngle = await seedClimb();
    for (const angle of [20, 20, 40, 40]) await seedTick(board.id, acrossAngles.uuid, { angle });
    for (let index = 0; index < 3; index++) await seedTick(board.id, singleAngle.uuid);
    const result = await loadPopularGymClimbs(gym.uuid, [board]);
    expect(result.get(board.id)).toEqual({
      uuid: acrossAngles.uuid,
      name: acrossAngles.name,
      frames: acrossAngles.frames,
      angle: 20,
    });
  });

  it('keeps installations separate even when every configuration field is identical', async () => {
    const gym = await seedGym();
    const first = await seedBoard(gym.id);
    const second = await seedBoard(gym.id);
    const firstClimb = await seedClimb();
    const secondClimb = await seedClimb();
    await seedTick(first.id, firstClimb.uuid);
    for (let index = 0; index < 4; index++) await seedTick(second.id, secondClimb.uuid);
    const query = vi.spyOn(db, 'selectDistinctOn');
    const result = await loadPopularGymClimbs(gym.uuid, [first, second]);
    expect(result.get(first.id)?.uuid).toBe(firstClimb.uuid);
    expect(result.get(second.id)?.uuid).toBe(secondClimb.uuid);
    expect(query).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([...result.values()])).not.toContain(OWNER);
  });

  it('canonicalizes aliases before counting, without crossing board types', async () => {
    const gym = await seedGym();
    const board = await seedBoard(gym.id);
    const canonical = await seedClimb();
    const competitor = await seedClimb();
    const aliasUuid = uuidv4();
    await db
      .insert(boardClimbAliases)
      .values({ boardType: 'kilter', aliasUuid, canonicalUuid: canonical.uuid, source: 'backfill' });
    await seedTick(board.id, canonical.uuid);
    await seedTick(board.id, aliasUuid);
    await seedTick(board.id, aliasUuid, { status: 'flash' });
    await seedTick(board.id, competitor.uuid);
    await seedTick(board.id, competitor.uuid);
    expect((await loadPopularGymClimbs(gym.uuid, [board])).get(board.id)?.uuid).toBe(canonical.uuid);
  });

  it('does not count attempts, detached ticks, private accounts or only-me ticks', async () => {
    const gym = await seedGym();
    const board = await seedBoard(gym.id);
    const visible = await seedClimb();
    const excluded = await seedClimb();
    await seedTick(board.id, visible.uuid);
    await db.insert(userProfiles).values({ userId: PRIVATE_CLIMBER, isPrivate: true });
    await seedTick(board.id, excluded.uuid, { status: 'attempt' });
    await seedTick(board.id, excluded.uuid, { kilterDetachedAt: '2026-11-18T12:01:00Z' });
    await seedTick(board.id, excluded.uuid, { userId: PRIVATE_CLIMBER });
    const privateTick = await seedTick(board.id, excluded.uuid);
    await db
      .insert(contentPrivacy)
      .values({ entityType: 'tick', entityId: privateTick.uuid, ownerId: OWNER, audience: 'only_me' });
    expect((await loadPopularGymClimbs(gym.uuid, [board])).get(board.id)?.uuid).toBe(visible.uuid);
  });

  it('rechecks public-consent revision on each read instead of caching a formerly public winner', async () => {
    const gym = await seedGym();
    const board = await seedBoard(gym.id);
    const fallback = await seedClimb();
    const consented = await seedClimb();
    await seedTick(board.id, fallback.uuid);
    await db.insert(userProfiles).values({ userId: PRIVATE_CLIMBER, isPrivate: true, privacyRevision: 2 });
    for (let index = 0; index < 2; index++) {
      const tick = await seedTick(board.id, consented.uuid, { userId: PRIVATE_CLIMBER });
      await db.insert(contentPrivacy).values({
        entityType: 'tick',
        entityId: tick.uuid,
        ownerId: PRIVATE_CLIMBER,
        audience: 'public',
        publicConsentRevision: 2,
      });
    }
    expect((await loadPopularGymClimbs(gym.uuid, [board])).get(board.id)?.uuid).toBe(consented.uuid);
    await db.update(userProfiles).set({ privacyRevision: 3 }).where(eq(userProfiles.userId, PRIVATE_CLIMBER));
    expect((await loadPopularGymClimbs(gym.uuid, [board])).get(board.id)?.uuid).toBe(fallback.uuid);
  });

  it.each<[string, Partial<typeof boardClimbs.$inferInsert>]>([
    ['draft', { isDraft: true }],
    ['unlisted', { isListed: false }],
    ['hidden', { isHidden: true }],
    ['without frames', { frames: null }],
    ['missing holds', { missingHoldCount: 1 }],
    ['without set provenance', { requiredSetIds: null }],
    ['on another layout', { layoutId: 2 }],
    ['too large', { compatibleSizeIds: [20] }],
    ['using uninstalled sets', { requiredSetIds: [3] }],
    ['on another board type', { boardType: 'tension' }],
  ])('removes %s candidates before ranking, so the next eligible climb wins', async (_label, overrides) => {
    const gym = await seedGym();
    const board = await seedBoard(gym.id);
    const visible = await seedClimb();
    const excluded = await seedClimb(overrides);
    await seedTick(board.id, visible.uuid);
    await seedTick(board.id, excluded.uuid, { boardType: excluded.boardType });
    await seedTick(board.id, excluded.uuid, { boardType: excluded.boardType });
    expect((await loadPopularGymClimbs(gym.uuid, [board])).get(board.id)?.uuid).toBe(visible.uuid);
  });

  it('supports MoonBoard fixed-size climbs with null set and compatible-size metadata', async () => {
    const gym = await seedGym();
    const board = await seedBoard(gym.id, { boardType: 'moonboard', layoutId: 2016, sizeId: 1, setIds: '1' });
    const climb = await seedClimb({
      boardType: 'moonboard',
      layoutId: 2016,
      compatibleSizeIds: null,
      requiredSetIds: null,
    });
    await seedTick(board.id, climb.uuid, { boardType: 'moonboard' });
    expect((await loadPopularGymClimbs(gym.uuid, [board])).get(board.id)?.uuid).toBe(climb.uuid);
  });

  it('uses canonical UUID then angle as deterministic tie-breaks', async () => {
    const gym = await seedGym();
    const board = await seedBoard(gym.id);
    const first = await seedClimb({ uuid: 'gym-popular-tie-a' });
    const second = await seedClimb({ uuid: 'gym-popular-tie-b' });
    for (const climb of [second, first]) {
      await seedTick(board.id, climb.uuid, { angle: 40 });
      await seedTick(board.id, climb.uuid, { angle: 20 });
    }
    expect((await loadPopularGymClimbs(gym.uuid, [board])).get(board.id)).toMatchObject({
      uuid: first.uuid,
      angle: 20,
    });
  });

  it('rechecks gym and board discovery visibility on each read', async () => {
    const gym = await seedGym();
    const board = await seedBoard(gym.id);
    const climb = await seedClimb();
    await seedTick(board.id, climb.uuid);
    expect((await loadPopularGymClimbs(gym.uuid, [board])).size).toBe(1);
    await db.update(userBoards).set({ isUnlisted: true }).where(eq(userBoards.id, board.id));
    expect((await loadPopularGymClimbs(gym.uuid, [board])).size).toBe(0);
    await db.update(userBoards).set({ isUnlisted: false }).where(eq(userBoards.id, board.id));
    await db.update(gyms).set({ isPublic: false }).where(eq(gyms.id, gym.id));
    expect((await loadPopularGymClimbs(gym.uuid, [board])).size).toBe(0);
  });

  it.each([
    ['unlisted', 'unlisted', 'public'],
    ['only me', 'only_me', 'public'],
    ['private location', 'public', 'only_me'],
  ] as const)(
    'applies the effective %s override immediately to warm rankings and direct previews',
    async (_label, audience, locationAudience) => {
      const gym = await seedGym();
      const board = await seedBoard(gym.id);
      const climb = await seedClimb();
      await seedTick(board.id, climb.uuid);
      const read = () =>
        boardDiscoveryQueries.boardDiscovery(null, { input: { gymUuid: gym.uuid, limit: 1 } }, context);
      expect((await read())[0]).toMatchObject({ uuid: board.uuid, popularClimb: { uuid: climb.uuid } });
      await db
        .insert(resourcePrivacy)
        .values({ kind: 'board', resourceId: board.uuid, ownerId: OWNER, audience, locationAudience });
      expect(await read()).toEqual([]);
      expect((await loadPopularGymClimbs(gym.uuid, [board])).size).toBe(0);
    },
  );

  it('does not enrich global discovery or execute an unbounded board request', async () => {
    const gym = await seedGym();
    const board = await seedBoard(gym.id);
    const aggregate = vi.spyOn(db, 'selectDistinctOn');
    await boardDiscoveryQueries.boardDiscovery(null, { input: { limit: 1 } }, context);
    expect(aggregate).not.toHaveBeenCalled();
    expect(
      (
        await loadPopularGymClimbs(
          gym.uuid,
          Array.from({ length: 13 }, () => board),
        )
      ).size,
    ).toBe(0);
    expect(aggregate).not.toHaveBeenCalled();
  });

  it('keeps board links and current presence when optional popularity is unavailable', async () => {
    const gym = await seedGym();
    const board = await seedBoard(gym.id);
    const current = { uuid: 'live-only', name: 'Current climb', frames: 'p1r12', angle: 40 };
    vi.mocked(pubsub.getBoardDiscoveryClimb).mockResolvedValue(current);
    vi.spyOn(db, 'selectDistinctOn').mockImplementationOnce(() => {
      throw new Error('Optional aggregate unavailable');
    });
    const [result] = await boardDiscoveryQueries.boardDiscovery(
      null,
      { input: { gymUuid: gym.uuid, limit: 1 } },
      context,
    );
    expect(result).toMatchObject({ uuid: board.uuid, slug: board.slug, currentClimb: current, popularClimb: null });
  });
});
