import { afterAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { eq, inArray } from 'drizzle-orm';
import Redis from 'ioredis';
import { boardBetaLinks, boardClimbs, boardClimbStats, boardDifficultyGrades } from '@boardsesh/db/schema';
import type { PublicClimbRelatedContentInput } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import {
  publicClimbRelatedContentDependencies,
  WRITE_PUBLIC_RELATED_CACHE_SCRIPT,
} from '../graphql/resolvers/climbs/public-climb-related-content';
import {
  PublicClimbRelatedContentService,
  publicRelatedCacheKey,
  type PublicRelatedSnapshot,
} from '../services/public-climb-related-content';
import { getStoredPublicBetaLinks } from '../graphql/resolvers/beta-videos/queries';

vi.mock('../utils/redis-rate-limiter', () => ({ checkRateLimitRedis: vi.fn().mockResolvedValue(undefined) }));

const PREFIX = 'public-related-fixture-';
const INPUT: PublicClimbRelatedContentInput = {
  boardType: 'kilter',
  layoutId: 1,
  sizeId: 10,
  setIds: [1],
  angle: 30,
  climbUuid: `${PREFIX}target`,
};
const CANDIDATE = {
  uuid: `${PREFIX}candidate`,
  similarity: 0.8,
  sharedHoldCount: 8,
  candidateHoldCount: 10,
  targetHoldCount: 8,
};
const SNAPSHOT: PublicRelatedSnapshot = { similar: [CANDIDATE], nearby: [], nearbyGrade: null };
const FIXTURE_UUIDS = [INPUT.climbUuid, CANDIDATE.uuid];
const cache = new Map<string, PublicRelatedSnapshot>();

async function seed(boardType = 'kilter') {
  await db
    .insert(boardDifficultyGrades)
    .values({ boardType, difficulty: 16, boulderName: '6a/V3' })
    .onConflictDoNothing();
  await db.insert(boardClimbs).values(
    FIXTURE_UUIDS.map((uuid) => ({
      uuid,
      boardType,
      layoutId: 1,
      name: uuid,
      angle: 40,
      frames: 'p1r13p2r15',
      framesCount: 1,
      isDraft: false,
      isListed: true,
      isHidden: false,
      compatibleSizeIds: [10],
      requiredSetIds: [1],
    })),
  );
  await db.insert(boardClimbStats).values(
    FIXTURE_UUIDS.map((climbUuid) => ({
      boardType,
      climbUuid,
      angle: 30,
      displayDifficulty: 16,
      ascensionistCount: 5,
      qualityAverage: 3,
    })),
  );
}

async function primed(input = INPUT, snapshot = SNAPSHOT) {
  const target = await publicClimbRelatedContentDependencies.readTarget(input);
  expect(target).not.toBeNull();
  cache.set(publicRelatedCacheKey(input, target!), snapshot);
  const buildSnapshot = vi.fn(publicClimbRelatedContentDependencies.buildSnapshot);
  const service = new PublicClimbRelatedContentService({
    ...publicClimbRelatedContentDependencies,
    readCache: async (key) => cache.get(key) ?? null,
    writeCache: async (key, payload) => {
      cache.set(key, payload);
    },
    readBeta: async () => ({ links: [], hasMore: false }),
    buildSnapshot,
  });
  return { service, buildSnapshot, target: target! };
}

beforeEach(async () => {
  cache.clear();
  await db.delete(boardBetaLinks).where(inArray(boardBetaLinks.climbUuid, FIXTURE_UUIDS));
  await db.delete(boardClimbStats).where(inArray(boardClimbStats.climbUuid, FIXTURE_UUIDS));
  await db.delete(boardClimbs).where(inArray(boardClimbs.uuid, FIXTURE_UUIDS));
});

describe('stored beta on marketing pages', () => {
  it('returns stored links without fetching or enriching missing thumbnails', async () => {
    await seed();
    await db.insert(boardBetaLinks).values({
      boardType: INPUT.boardType,
      climbUuid: INPUT.climbUuid,
      link: 'https://www.youtube.com/watch?v=stored-only',
      foreignUsername: 'filmer',
      thumbnail: null,
      isListed: true,
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const response = await getStoredPublicBetaLinks(INPUT.boardType, INPUT.climbUuid);
      expect(response.links).toHaveLength(1);
      expect(response.links[0]?.thumbnail).toBeNull();
      expect(response.links[0]?.foreignUsername).toBe('filmer');
      expect(response.hasMore).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
      const [stored] = await db.select().from(boardBetaLinks).where(eq(boardBetaLinks.climbUuid, INPUT.climbUuid));
      expect(stored.thumbnail).toBeNull();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('caps stored rows and reports more when excluded links fill part of the first page', async () => {
    await seed();
    await db.insert(boardBetaLinks).values([
      { boardType: INPUT.boardType, climbUuid: INPUT.climbUuid, link: 'https://kayaclimb.com/excluded' },
      ...Array.from({ length: 51 }, (_, indexNumber) => ({
        boardType: INPUT.boardType,
        climbUuid: INPUT.climbUuid,
        link: `https://www.youtube.com/watch?v=stored-${indexNumber}`,
      })),
    ]);
    const response = await getStoredPublicBetaLinks(INPUT.boardType, INPUT.climbUuid);
    expect(response.links).toHaveLength(50);
    expect(response.hasMore).toBe(true);
    expect(response.links.every((link) => !link.link.includes('kayaclimb'))).toBe(true);
    await db.update(boardClimbs).set({ isDraft: true }).where(eq(boardClimbs.uuid, INPUT.climbUuid));
    expect((await getStoredPublicBetaLinks(INPUT.boardType, INPUT.climbUuid)).links).toEqual([]);
  });
});

describe('public related content cached IDs against current catalogue', () => {
  it.each(['hidden', 'unlisted', 'draft', 'deleted'])('removes a cached candidate that becomes %s', async (change) => {
    await seed();
    const { service, buildSnapshot } = await primed();
    expect((await service.read(INPUT)).similarClimbs.map((climb) => climb.uuid)).toEqual([CANDIDATE.uuid]);
    if (change === 'deleted') await db.delete(boardClimbs).where(eq(boardClimbs.uuid, CANDIDATE.uuid));
    else
      await db
        .update(boardClimbs)
        .set(change === 'hidden' ? { isHidden: true } : change === 'unlisted' ? { isListed: false } : { isDraft: true })
        .where(eq(boardClimbs.uuid, CANDIDATE.uuid));
    expect((await service.read(INPUT)).similarClimbs).toEqual([]);
    expect(buildSnapshot).not.toHaveBeenCalled();
  });

  it('never hydrates old cached IDs after the source becomes a draft', async () => {
    await seed();
    const { service, buildSnapshot } = await primed();
    await db.update(boardClimbs).set({ isDraft: true }).where(eq(boardClimbs.uuid, INPUT.climbUuid));
    expect((await service.read(INPUT)).similarClimbs).toEqual([]);
    expect(buildSnapshot).not.toHaveBeenCalled();
  });

  it('keys an edited source on its new sync revision rather than resurrecting its old list', async () => {
    await seed();
    const { target } = await primed();
    await db.update(boardClimbs).set({ frames: 'p1r13p3r15' }).where(eq(boardClimbs.uuid, INPUT.climbUuid));
    const changed = await publicClimbRelatedContentDependencies.readTarget(INPUT);
    expect(changed!.revision).not.toBe(target.revision);
    expect(cache.get(publicRelatedCacheKey(INPUT, changed!))).toBeUndefined();
  });

  it('keeps a nearby candidate link at the requested angle, not the catalogue angle', async () => {
    await seed();
    const nearby = { ...CANDIDATE, similarity: 0 };
    const { service } = await primed(INPUT, { similar: [], nearby: [nearby], nearbyGrade: '6a/V3' });
    const response = await service.read(INPUT);
    expect(response.nearbyClimbs[0]?.angle).toBe(30);
    expect(response.nearbyClimbs[0]?.difficultyName).toBe('6a/V3');
  });

  it('rechecks Woods size compatibility after the recommendation was cached', async () => {
    await seed('woods');
    const input = { ...INPUT, boardType: 'woods' };
    const { service, buildSnapshot } = await primed(input);
    expect((await service.read(input)).similarClimbs).toHaveLength(1);
    await db
      .update(boardClimbs)
      .set({ compatibleSizeIds: [11] })
      .where(eq(boardClimbs.uuid, CANDIDATE.uuid));
    expect((await service.read(input)).similarClimbs).toEqual([]);
    expect(buildSnapshot).not.toHaveBeenCalled();
  });

  it('drops a nearby candidate whose required sets no longer fit the requested board', async () => {
    await seed();
    const { service } = await primed(INPUT, {
      similar: [],
      nearby: [{ ...CANDIDATE, similarity: 0 }],
      nearbyGrade: '6a/V3',
    });
    await db
      .update(boardClimbs)
      .set({ requiredSetIds: [99] })
      .where(eq(boardClimbs.uuid, CANDIDATE.uuid));
    expect((await service.read(INPUT)).nearbyClimbs).toEqual([]);
  });
});

describe('atomic bounded Redis recommendation cache', () => {
  const redis = new Redis({ host: '127.0.0.1', port: 6380, maxRetriesPerRequest: 1, lazyConnect: true });
  const index = `test:{public-related-${process.pid}}:index`;
  const keys = Array.from({ length: 6 }, (_, offset) => `test:{public-related-${process.pid}}:entry-${offset}`);
  afterAll(async () => {
    await redis.del(index, ...keys);
    await redis.quit();
  });

  it('keeps insertion, expiration and eviction atomic across concurrent callers', async () => {
    await redis.connect();
    await Promise.all(
      keys.map((key, indexNumber) =>
        redis.eval(
          WRITE_PUBLIC_RELATED_CACHE_SCRIPT,
          2,
          key,
          index,
          JSON.stringify(SNAPSHOT),
          '604800',
          String(indexNumber),
          '3',
        ),
      ),
    );
    expect(await redis.zcard(index)).toBe(3);
    expect((await redis.mget(...keys)).filter((payload) => payload !== null)).toHaveLength(3);
    const remaining = await redis.zrange(index, 0, -1);
    for (const key of remaining) {
      expect(await redis.ttl(key)).toBeGreaterThan(604790);
      expect(JSON.parse((await redis.get(key))!)).toEqual(SNAPSHOT);
    }
  });
});
