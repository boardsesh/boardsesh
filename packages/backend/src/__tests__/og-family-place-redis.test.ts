/**
 * Against a real Redis, because the bug this guards only exists with one: the
 * anonymous `searchClimbs` page is held in Redis for a day with no invalidation,
 * so a climb read through it stays lit long after the community hides it.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { eq } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import type { LoadedOgFamilyCard } from '../services/og-family/card-model';

const { renderFamily } = vi.hoisted(() => ({ renderFamily: vi.fn() }));
vi.mock('../services/board-render', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/board-render')>()),
  ensureBoardRendererAvailable: vi.fn(async () => true),
  renderOgFamilyArt: renderFamily,
}));
vi.mock('../utils/redis-rate-limiter', () => ({ checkRateLimitRedis: vi.fn(async () => {}) }));

import Redis from 'ioredis';
import { db } from '../db/client';
import { redisClientManager, type RedisClients } from '../redis/client';
import { handleOgPlace } from '../handlers/og-family';
import { resetOgFamilyLoadCaches } from '../services/og-family/load-cards';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6380';
const SEARCH_CACHE_KEYS = 'boardsesh:climb-search:*';
const OWNER = 'og-place-redis-owner';
const GYM_SLUG = 'og-redis-gym';
const LIT_FIRST = 'p1140r12';
const LIT_AFTER_HIDE = 'p1155r15';

async function requestGym() {
  const res = {
    statusCode: 0,
    body: undefined as string | Buffer | undefined,
    headers: {} as Record<string, unknown>,
    writeHead(status: number, headers?: Record<string, unknown>) {
      this.statusCode = status;
      if (headers) Object.assign(this.headers, headers);
    },
    end(body?: string | Buffer) {
      if (body !== undefined) this.body = body;
    },
    setHeader(name: string, value: unknown) {
      this.headers[name] = value;
    },
  };
  await handleOgPlace(
    { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } } as unknown as IncomingMessage,
    res as unknown as ServerResponse,
    new URL(`http://localhost/og/place?kind=gym&slug=${GYM_SLUG}`),
  );
  return res;
}

function litFrames(): string | undefined {
  return (renderFamily.mock.calls.at(-1)?.[0] as LoadedOgFamilyCard).art?.frames;
}

async function createClimb(uuid: string, frames: string, ascents: number) {
  await db.insert(dbSchema.boardClimbs).values({
    uuid,
    boardType: 'kilter',
    layoutId: 1,
    name: uuid,
    isListed: true,
    isDraft: false,
    frames,
    framesCount: 1,
    compatibleSizeIds: [10],
    requiredSetIds: [1],
  });
  await db
    .insert(dbSchema.boardClimbStats)
    .values({ boardType: 'kilter', climbUuid: uuid, angle: 40, ascensionistCount: ascents, displayDifficulty: 20 });
}

let redis: Redis;

async function clearSearchCache() {
  const keys = await redis.keys(SEARCH_CACHE_KEYS);
  if (keys.length > 0) await redis.del(...keys);
}

beforeAll(async () => {
  // The singleton reads REDIS_URL at import, before a test can set it, so the real
  // connection goes in through its accessors. Everything behind them is real.
  redis = new Redis(REDIS_URL);
  vi.spyOn(redisClientManager, 'isRedisConnected').mockReturnValue(true);
  vi.spyOn(redisClientManager, 'getClients').mockReturnValue({ publisher: redis } as unknown as RedisClients);
  await db
    .insert(dbSchema.users)
    .values([{ id: OWNER, email: 'og-place-redis@test.com', name: 'Redis Owner' }])
    .onConflictDoNothing();
});

afterAll(async () => {
  await clearSearchCache();
  vi.restoreAllMocks();
  await redis.quit();
});

beforeEach(async () => {
  await clearSearchCache();
  resetOgFamilyLoadCaches();
  renderFamily.mockReset();
  renderFamily.mockResolvedValue({
    buffer: Buffer.from([0xff, 0xd8]),
    contentType: 'image/jpeg',
    cache: 'miss',
    timings: { wasmMs: 0, planeMs: 0, composeMs: 0 },
  });
  await db.delete(dbSchema.boardClimbStats);
  await db.delete(dbSchema.boardClimbs);
  await db.delete(dbSchema.resourcePrivacy);
  await db.delete(dbSchema.userBoards);
  await db.delete(dbSchema.gyms);
});

describe('a place card with Redis connected', () => {
  it('stops lighting a climb the community hid once its 60 s hold is up', async () => {
    expect(await redis.ping()).toBe('PONG');
    const [gym] = await db
      .insert(dbSchema.gyms)
      .values({ uuid: 'og-redis-gym-uuid', slug: GYM_SLUG, ownerId: OWNER, name: 'Redis Gym', isPublic: true })
      .returning({ id: dbSchema.gyms.id });
    await db.insert(dbSchema.userBoards).values({
      uuid: 'og-redis-board',
      slug: 'og-redis-board',
      ownerId: OWNER,
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,20',
      name: 'Redis Board',
      isPublic: true,
      angle: 40,
      gymId: gym.id,
    });
    await createClimb('og-redis-hidden', LIT_FIRST, 5000);
    await createClimb('og-redis-next', LIT_AFTER_HIDE, 3);

    await requestGym();
    expect(litFrames()).toBe(LIT_FIRST);
    // Proof this run could have been served stale: on the old path the page sat here.

    await db
      .update(dbSchema.boardClimbs)
      .set({ isHidden: true })
      .where(eq(dbSchema.boardClimbs.uuid, 'og-redis-hidden'));
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);
    await requestGym();
    clock.mockRestore();

    expect(litFrames()).toBe(LIT_AFTER_HIDE);
  });
});
