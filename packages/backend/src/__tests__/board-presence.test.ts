import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vite-plus/test';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { inArray, sql } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import { MOONBOARD_LAYOUTS, MOONBOARD_SETS, MOONBOARD_SIZE } from '@boardsesh/board-config';
import type {
  ConnectionContext,
  BoardPresenceEvent,
  BoardClimbSet,
  BoardConnectionChanged,
  BoardStatsUpdated,
  BoardPresenceClimb,
  BoardPresenceStats,
  ClimbQueueItemInput,
} from '@boardsesh/shared-schema';
import { db } from '../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { pubsub } from '../pubsub';
import { BoardPresenceStore } from '../pubsub/board-presence-store';
import { redisClientManager } from '../redis/client';
import { roomManager } from '../services/room-manager';
import {
  boardPresenceMutations,
  reserveAndPersistBoardClimbEvent,
} from '../graphql/resolvers/board-presence/mutations';
import { boardPresenceQueries } from '../graphql/resolvers/board-presence/queries';
import { boardPresenceSubscriptions } from '../graphql/resolvers/board-presence/subscription';
import { socialBoardQueries } from '../graphql/resolvers/social/boards';
import { allocateBoardPresenceSeq, getBoardSeqFloor } from '../graphql/resolvers/board-presence/shared';
import { setCachedBoardPresenceStats } from '../graphql/resolvers/board-presence/stats';
import { buildTickBoardLockQuery, tickMutations } from '../graphql/resolvers/ticks/mutations';
import { seedAuroraCatalogFixtures } from './helpers/board-catalog-fixture';
import { logger } from '../utils/logger';
import { createBarrier, createValueBarrier, handleLater } from './helpers/concurrency';

// Board presence is always-on (the BOARD_PRESENCE_ENABLED env gate and the
// PostHog flag were removed when the feature went GA), so the suite needs no
// flag setup.

const TEST_USER_ID = 'board-presence-test-user';
const SECOND_USER_ID = 'board-presence-second-user';
const SENDER_DISPLAY_NAME = 'Crusher Carla';
const SENDER_AVATAR_URL = 'https://example.com/carla.jpg';
const TEST_CLIMB_UUID = 'board-presence-test-climb-uuid';
const OTHER_TEST_CLIMB_UUID = 'board-presence-other-climb-uuid';
const BOARD_MEMBERSHIP_TTL_MS = 43_200_000;
const ALIAS_TEST_CLIMB_UUID = 'board-presence-alias-climb-uuid';
const MOONBOARD_2010_LAYOUT = MOONBOARD_LAYOUTS['moonboard-2010'];
const MOONBOARD_2016_LAYOUT = MOONBOARD_LAYOUTS['moonboard-2016'];

let cleanupBoardPresenceCatalogFixtures: () => Promise<void> = async () => {};

beforeAll(async () => {
  cleanupBoardPresenceCatalogFixtures = await seedAuroraCatalogFixtures([
    {
      boardType: 'kilter',
      productId: 2_100_412_900,
      layoutId: 1,
      sizeId: 10,
      setIds: [1, 2, 7, 8],
      associationIdBase: 2_100_413_000,
    },
    {
      boardType: 'kilter',
      productId: 2_100_412_900,
      layoutId: 2,
      sizeId: 20,
      setIds: [5, 6],
      associationIdBase: 2_100_413_010,
    },
    {
      boardType: 'kilter',
      productId: 2_100_412_900,
      layoutId: 3,
      sizeId: 30,
      setIds: [7, 8],
      associationIdBase: 2_100_413_020,
    },
    {
      boardType: 'tension',
      productId: 2_100_412_900,
      layoutId: 1,
      sizeId: 10,
      setIds: [1, 2],
      associationIdBase: 2_100_413_030,
    },
  ]);
});

afterAll(async () => {
  await cleanupBoardPresenceCatalogFixtures();
});

async function waitForSessionBlockedBy(blockingPid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [blockedSession] = await db.execute(sql`
      SELECT activity.pid
        FROM pg_stat_activity activity
       WHERE ${blockingPid} = ANY(pg_blocking_pids(activity.pid))
       LIMIT 1
    `);
    if (blockedSession) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for a PostgreSQL session blocked by pid ${blockingPid}`);
}

const RECENT_SENDER_TEST_USER_IDS = Array.from(
  { length: 6 },
  (_, index) => `board-presence-recent-sender-${index + 1}`,
);

function authCtx(overrides: Partial<ConnectionContext> = {}): ConnectionContext {
  return {
    connectionId: `conn-${Math.random().toString(36).slice(2)}`,
    isAuthenticated: true,
    userId: TEST_USER_ID,
    ...overrides,
  } as ConnectionContext;
}

function makeQueueItemInput(overrides: Partial<ClimbQueueItemInput['climb']> = {}): ClimbQueueItemInput {
  return {
    uuid: 'queue-item-uuid-1',
    climb: {
      uuid: TEST_CLIMB_UUID,
      setter_username: 'setter-bob',
      name: 'Real Catalog Climb',
      frames: 'p1145r12',
      angle: 40,
      ascensionist_count: 5,
      difficulty: 'V5',
      quality_average: '4.0',
      stars: 4,
      difficulty_error: '0',
      ...overrides,
    },
  };
}

async function seedUser(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, email, name, image, created_at, updated_at)
    VALUES (${TEST_USER_ID}, 'carla@board-presence.test', 'Carla Fallback', null, now(), now())
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
  `);
  await db.execute(sql`
    INSERT INTO users (id, email, name, image, created_at, updated_at)
    VALUES (${SECOND_USER_ID}, 'second@board-presence.test', 'Second Sender', null, now(), now())
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
  `);
  await db.execute(sql`
    INSERT INTO user_profiles (user_id, display_name, avatar_url)
    VALUES (${TEST_USER_ID}, ${SENDER_DISPLAY_NAME}, ${SENDER_AVATAR_URL})
    ON CONFLICT (user_id) DO UPDATE SET display_name = EXCLUDED.display_name, avatar_url = EXCLUDED.avatar_url
  `);
}

async function seedCatalogClimb(): Promise<void> {
  await db.execute(sql`
    INSERT INTO board_climbs (uuid, board_type, layout_id, name, frames, angle, is_listed, is_draft)
    VALUES (${TEST_CLIMB_UUID}, 'kilter', 1, 'Real Catalog Climb', 'p1145r12', 40, true, false)
    ON CONFLICT (uuid) DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO board_climbs (uuid, board_type, layout_id, name, frames, angle, is_listed, is_draft)
    VALUES (${OTHER_TEST_CLIMB_UUID}, 'kilter', 1, 'Other Catalog Climb', 'p9999r12', 40, true, false)
    ON CONFLICT (uuid) DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO board_difficulty_grades (board_type, difficulty, boulder_name, is_listed)
    VALUES ('kilter', 17, 'V5', true), ('kilter', 18, 'V6', true)
    ON CONFLICT (board_type, difficulty) DO UPDATE SET boulder_name = EXCLUDED.boulder_name
  `);
  await db.execute(sql`
    INSERT INTO board_climb_stats (board_type, climb_uuid, angle, display_difficulty, ascensionist_count, difficulty_average, quality_average)
    VALUES
      ('kilter', ${TEST_CLIMB_UUID}, 40, 17, 10, 17, 4),
      ('kilter', ${TEST_CLIMB_UUID}, 45, 18, 10, 18, 4),
      ('kilter', ${OTHER_TEST_CLIMB_UUID}, 40, 18, 5, 18, 3)
    ON CONFLICT (board_type, climb_uuid, angle) DO UPDATE SET display_difficulty = EXCLUDED.display_difficulty
  `);
  await db.execute(sql`
    INSERT INTO board_climb_aliases (board_type, alias_uuid, canonical_uuid, source)
    VALUES ('kilter', ${ALIAS_TEST_CLIMB_UUID}, ${TEST_CLIMB_UUID}, 'board-presence-test')
    ON CONFLICT (board_type, alias_uuid) DO UPDATE
      SET canonical_uuid = EXCLUDED.canonical_uuid,
          source = EXCLUDED.source,
          last_seen_at = now()
  `);
}

async function cleanup(): Promise<void> {
  await db.execute(sql`DELETE FROM boardsesh_ticks WHERE user_id IN (${TEST_USER_ID}, ${SECOND_USER_ID})`);
  await db.execute(sql`
    DELETE FROM user_boards
    WHERE owner_id IN (${TEST_USER_ID}, ${SECOND_USER_ID})
       OR (owner_id = '00000000-0000-0000-0000-000000000000' AND slug LIKE 'presence-%')
  `);
  await db.execute(
    sql`DELETE FROM board_climb_stats WHERE climb_uuid IN (${TEST_CLIMB_UUID}, ${OTHER_TEST_CLIMB_UUID})`,
  );
  await db.execute(sql`
    DELETE FROM board_climb_aliases
    WHERE alias_uuid IN (${TEST_CLIMB_UUID}, ${OTHER_TEST_CLIMB_UUID}, ${ALIAS_TEST_CLIMB_UUID})
       OR canonical_uuid IN (${TEST_CLIMB_UUID}, ${OTHER_TEST_CLIMB_UUID}, ${ALIAS_TEST_CLIMB_UUID})
  `);
  await db.execute(sql`DELETE FROM board_climbs WHERE uuid IN (${TEST_CLIMB_UUID}, ${OTHER_TEST_CLIMB_UUID})`);
  await db.execute(sql`DELETE FROM user_profiles WHERE user_id = ${TEST_USER_ID}`);
  await db
    .delete(dbSchema.users)
    .where(inArray(dbSchema.users.id, [TEST_USER_ID, SECOND_USER_ID, ...RECENT_SENDER_TEST_USER_IDS]));
}

// ============================================================
// Pubsub-level unit behaviour (no DB)
// ============================================================
describe('board-presence pubsub', () => {
  it('publish dispatches to local subscriber, unsubscribe stops delivery', async () => {
    const boardId = 'pubsub-board-1';
    const received: BoardPresenceEvent[] = [];
    const unsubscribe = await pubsub.subscribeBoardPresence(boardId, (event) => {
      received.push(event);
    });

    const climb: BoardPresenceClimb = {
      climbUuid: 'c1',
      sentAt: new Date().toISOString(),
      seq: 1,
    };
    pubsub.publishBoardPresenceEvent(boardId, { __typename: 'BoardClimbSet', climb });

    expect(received).toHaveLength(1);
    expect((received[0] as BoardClimbSet).climb.climbUuid).toBe('c1');

    unsubscribe();
    pubsub.publishBoardPresenceEvent(boardId, { __typename: 'BoardClimbCleared', clearedAt: 'x', seq: 2 });
    expect(received).toHaveLength(1);
  });

  it('nextBoardSeq is monotonic per board and independent across boards', async () => {
    const a = await pubsub.nextBoardSeq('seq-board-a');
    const b = await pubsub.nextBoardSeq('seq-board-a');
    const c = await pubsub.nextBoardSeq('seq-board-a');
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);

    // A different board has its own counter, unaffected by the first.
    const other = await pubsub.nextBoardSeq('seq-board-b');
    const otherNext = await pubsub.nextBoardSeq('seq-board-b');
    expect(otherNext).toBeGreaterThan(other);
  });

  it('uses the durable allocator as authority when the local candidate is stale', async () => {
    const candidates: number[] = [];
    const store = new BoardPresenceStore({
      isRedisAvailable: () => false,
      isRedisRequired: () => false,
      logger: { error: vi.fn(), warn: vi.fn() },
    });
    store.setBoardSeqAllocator(async (_boardId, candidate) => {
      candidates.push(candidate);
      return Math.max(candidate, 500);
    });

    expect(await store.nextBoardSeq('123')).toBe(500);
    expect(await store.nextBoardSeq('123')).toBe(501);
    expect(candidates).toEqual([1, 501]);
  });

  it('fails closed instead of publishing an unreserved local sequence', async () => {
    const store = new BoardPresenceStore({
      isRedisAvailable: () => false,
      isRedisRequired: () => false,
      logger: { error: vi.fn(), warn: vi.fn() },
    });
    store.setBoardSeqAllocator(async () => {
      throw new Error('database unavailable');
    });

    await expect(store.nextBoardSeq('123')).rejects.toThrow('database unavailable');
  });

  it('evicts expired local proof-of-presence stamps without a membership read', async () => {
    const boardId = `local-membership-${Math.random().toString(36).slice(2)}`;
    const userId = `user-${Math.random().toString(36).slice(2)}`;
    const localKey = `${boardId}:${userId}`;

    pubsub.resetLocalBoardMembershipForTest();
    vi.useFakeTimers();

    try {
      await pubsub.stampBoardMembership(boardId, userId);
      expect(pubsub.hasLocalBoardMembershipForTest(localKey)).toBe(true);

      await vi.advanceTimersByTimeAsync(BOARD_MEMBERSHIP_TTL_MS + 1);

      expect(pubsub.hasLocalBoardMembershipForTest(localKey)).toBe(false);
    } finally {
      pubsub.resetLocalBoardMembershipForTest();
      vi.useRealTimers();
    }
  });

  it('reschedules local proof-of-presence cleanup when an earlier expiry is added', async () => {
    const laterLocalKey = `local-membership-later-${Math.random().toString(36).slice(2)}`;
    const earlierLocalKey = `local-membership-earlier-${Math.random().toString(36).slice(2)}`;

    pubsub.resetLocalBoardMembershipForTest();
    vi.useFakeTimers();

    try {
      const currentTime = Date.now();
      pubsub.setLocalBoardMembershipForTest(laterLocalKey, currentTime + 1000);
      pubsub.setLocalBoardMembershipForTest(earlierLocalKey, currentTime + 100);

      await vi.advanceTimersByTimeAsync(101);

      expect(pubsub.hasLocalBoardMembershipForTest(earlierLocalKey)).toBe(false);
      expect(pubsub.hasLocalBoardMembershipForTest(laterLocalKey)).toBe(true);

      await vi.advanceTimersByTimeAsync(900);

      expect(pubsub.hasLocalBoardMembershipForTest(laterLocalKey)).toBe(false);
    } finally {
      pubsub.resetLocalBoardMembershipForTest();
      vi.useRealTimers();
    }
  });
});

// ============================================================
// FIFO history store/getRecent — exercised against a real Redis
// (the docker test harness runs redis on 6380). Skips gracefully if
// unreachable so the rest of the suite still runs.
// ============================================================
describe('board-presence FIFO history (Redis)', () => {
  const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6380';
  let redis: Redis | null = null;
  let redisReachable = false;

  beforeAll(async () => {
    redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
    try {
      await redis.connect();
      await redis.ping();
      redisReachable = true;
    } catch {
      redisReachable = false;
    }
  });

  afterAll(async () => {
    if (redis) {
      await redis.quit().catch(() => {});
    }
  });

  it('lpush + ltrim + sort-by-seq-desc backfill works (direct Redis FIFO contract)', async () => {
    if (!redisReachable || !redis) {
      console.warn('[board-presence] Redis unreachable — skipping FIFO history test');
      return;
    }
    const key = `board:fifo-test-${Date.now()}:history`;
    const climbs: BoardPresenceClimb[] = [];
    for (let seq = 1; seq <= 60; seq++) {
      const climb: BoardPresenceClimb = { climbUuid: `c${seq}`, sentAt: new Date().toISOString(), seq };
      climbs.push(climb);
      await redis.lpush(key, JSON.stringify(climb));
      await redis.ltrim(key, 0, 49);
    }

    const raw = await redis.lrange(key, 0, -1);
    expect(raw.length).toBe(50); // capped at 50

    const parsed = raw.map((j) => JSON.parse(j) as BoardPresenceClimb).sort((a, b) => b.seq - a.seq);
    // Newest seq first, oldest retained seq is 11 (1..10 trimmed away).
    expect(parsed[0].seq).toBe(60);
    expect(parsed[parsed.length - 1].seq).toBe(11);

    await redis.del(key);
  });
});

// ============================================================
// Resolver behaviour (DB-backed)
// ============================================================
describe('board-presence resolvers', () => {
  beforeEach(async () => {
    await cleanup();
    await seedUser();
    await seedCatalogClimb();
  });

  afterEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
  });

  describe('resolveBoardForSerial', () => {
    it('find-or-binds: creates a board on first sighting, returns the same board on a second call', async () => {
      const serial = `SER-${Date.now()}`;
      const first = await boardPresenceMutations.resolveBoardForSerial(
        undefined,
        { serial, boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '2,1' },
        authCtx(),
      );
      expect(first.boardId).toBeGreaterThan(0);
      expect(first.boardType).toBe('kilter');
      expect(first.setIds).toBe('1,2');

      // Second call (same serial) returns the already-bound shared board.
      const second = await boardPresenceMutations.resolveBoardForSerial(
        undefined,
        { serial, boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2' },
        authCtx({ connectionId: 'conn-2' }),
      );
      expect(second.boardId).toBe(first.boardId);
    });

    it('converges case/whitespace variants of the same serial onto one board', async () => {
      const base = `case${Date.now().toString(36)}`;
      const first = await boardPresenceMutations.resolveBoardForSerial(
        undefined,
        { serial: base.toLowerCase(), boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2' },
        authCtx(),
      );
      // A second phone whose BLE name differs only in case + surrounding
      // whitespace must NOT mint a duplicate board.
      const second = await boardPresenceMutations.resolveBoardForSerial(
        undefined,
        { serial: `  ${base.toUpperCase()}  `, boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2' },
        authCtx({ connectionId: 'conn-2' }),
      );
      expect(second.boardId).toBe(first.boardId);
    });

    it("binds the serial onto the caller's existing config-matching board", async () => {
      // Pre-create a board for this config with NO serial.
      await db.execute(sql`
        INSERT INTO user_boards (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, serial_number)
        VALUES (${`uuid-${Date.now()}`}, ${`slug-${Date.now()}`}, ${TEST_USER_ID}, 'kilter', 7, 11, '3,4', 'My Garage', null)
      `);

      const serial = `BIND-${Date.now()}`;
      const resolved = await boardPresenceMutations.resolveBoardForSerial(
        undefined,
        { serial, boardType: 'kilter', layoutId: 7, sizeId: 11, setIds: '3,4' },
        authCtx(),
      );
      expect(resolved.boardName).toBe('My Garage');

      const [row] = await db.execute(sql`SELECT serial_number FROM user_boards WHERE id = ${resolved.boardId}`);
      expect((row as { serial_number: string }).serial_number).toBe(serial);
    });

    it('normalizes setIds before binding a serial to an own config board', async () => {
      await db.execute(sql`
        INSERT INTO user_boards (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, serial_number)
        VALUES (${`uuid-normalized-${Date.now()}`}, ${`slug-normalized-${Date.now()}`}, ${TEST_USER_ID}, 'kilter', 17, 21, '3,4', 'My Normalized Garage', null)
      `);

      const serial = `NORM-${Date.now()}`;
      const resolved = await boardPresenceMutations.resolveBoardForSerial(
        undefined,
        { serial, boardType: 'kilter', layoutId: 17, sizeId: 21, setIds: '4,3' },
        authCtx(),
      );
      expect(resolved.boardName).toBe('My Normalized Garage');
      expect(resolved.setIds).toBe('3,4');

      const [row] = await db.execute(sql`
        SELECT serial_number FROM user_boards
        WHERE owner_id = ${TEST_USER_ID} AND layout_id = 17 AND size_id = 21
      `);
      expect((row as { serial_number: string }).serial_number).toBe(serial);
    });

    it('rejects rebinding an own config board that already has a different serial', async () => {
      const existingSerial = `BOUND-${Date.now()}`;
      await db.execute(sql`
        INSERT INTO user_boards (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, serial_number)
        VALUES (${`uuid-bound-${Date.now()}`}, ${`slug-bound-${Date.now()}`}, ${TEST_USER_ID}, 'kilter', 8, 12, '5,6', 'My Garage', ${existingSerial})
      `);

      await expect(
        boardPresenceMutations.resolveBoardForSerial(
          undefined,
          { serial: `NEW-${Date.now()}`, boardType: 'kilter', layoutId: 8, sizeId: 12, setIds: '5,6' },
          authCtx(),
        ),
      ).rejects.toMatchObject({
        extensions: { code: 'BOARD_SERIAL_ALREADY_BOUND' },
      });

      const [row] = await db.execute(sql`
        SELECT serial_number FROM user_boards
        WHERE owner_id = ${TEST_USER_ID} AND layout_id = 8 AND size_id = 12
      `);
      expect((row as { serial_number: string }).serial_number).toBe(existingSerial);
    });

    it('returns the first serial-bound board across callers instead of binding a second user board', async () => {
      const serial = `XCALL-${Date.now()}`;
      const first = await boardPresenceMutations.resolveBoardForSerial(
        undefined,
        { serial, boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2' },
        authCtx(),
      );
      await db.execute(sql`
        INSERT INTO user_boards (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, serial_number)
        VALUES (${`uuid-second-${Date.now()}`}, ${`slug-second-${Date.now()}`}, ${SECOND_USER_ID}, 'kilter', 1, 10, '1,2', 'Own Config', null)
      `);

      const second = await boardPresenceMutations.resolveBoardForSerial(
        undefined,
        { serial, boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2' },
        authCtx({ userId: SECOND_USER_ID }),
      );

      expect(second.boardId).toBe(first.boardId);
      const [secondOwnBoard] = await db.execute(sql`
        SELECT serial_number FROM user_boards
        WHERE owner_id = ${SECOND_USER_ID} AND name = 'Own Config'
      `);
      expect((secondOwnBoard as { serial_number: string | null }).serial_number).toBeNull();
    });

    it('resolves serial-less boards to a stable shared per-config board', async () => {
      const moonboard2010SetIds = MOONBOARD_SETS['moonboard-2010'].map(({ id }) => id);
      expect(moonboard2010SetIds).toHaveLength(1);
      const moonboard2010SetId = moonboard2010SetIds[0];
      if (moonboard2010SetId === undefined) throw new Error('MoonBoard 2010 must define one hold set');

      const first = await boardPresenceMutations.resolveBoardForConfig(
        undefined,
        {
          boardType: 'moonboard',
          layoutId: MOONBOARD_2010_LAYOUT.id,
          sizeId: MOONBOARD_SIZE.id,
          setIds: String(moonboard2010SetId),
        },
        authCtx(),
      );
      const second = await boardPresenceMutations.resolveBoardForConfig(
        undefined,
        {
          boardType: 'moonboard',
          layoutId: MOONBOARD_2010_LAYOUT.id,
          sizeId: MOONBOARD_SIZE.id,
          setIds: String(moonboard2010SetId),
        },
        authCtx({ userId: SECOND_USER_ID }),
      );

      expect(second.boardId).toBe(first.boardId);
      expect(first.boardType).toBe('moonboard');
      const [row] = await db.execute(sql`
        SELECT owner_id, serial_number, is_unlisted
        FROM user_boards
        WHERE id = ${first.boardId}
      `);
      expect((row as { owner_id: string }).owner_id).toBe('00000000-0000-0000-0000-000000000000');
      expect((row as { serial_number: string | null }).serial_number).toBeNull();
      expect((row as { is_unlisted: boolean }).is_unlisted).toBe(true);
    });

    it('converges concurrent serial-less config creates onto one normalized shared board', async () => {
      const moonboard2016SetIds = MOONBOARD_SETS['moonboard-2016'].map(({ id }) => id);
      expect(moonboard2016SetIds.length).toBeGreaterThanOrEqual(2);
      const [firstSetId, secondSetId] = moonboard2016SetIds;
      if (firstSetId === undefined || secondSetId === undefined) {
        throw new Error('MoonBoard 2016 must define at least two hold sets');
      }
      const submittedSetIds = [secondSetId, firstSetId].join(',');
      const normalizedSetIds = [firstSetId, secondSetId].sort((first, second) => first - second).join(',');
      const [first, second] = await Promise.all([
        boardPresenceMutations.resolveBoardForConfig(
          undefined,
          {
            boardType: 'moonboard',
            layoutId: MOONBOARD_2016_LAYOUT.id,
            sizeId: MOONBOARD_SIZE.id,
            setIds: submittedSetIds,
          },
          authCtx(),
        ),
        boardPresenceMutations.resolveBoardForConfig(
          undefined,
          {
            boardType: 'moonboard',
            layoutId: MOONBOARD_2016_LAYOUT.id,
            sizeId: MOONBOARD_SIZE.id,
            setIds: normalizedSetIds,
          },
          authCtx({ userId: SECOND_USER_ID }),
        ),
      ]);

      expect(second.boardId).toBe(first.boardId);
      expect(first.setIds).toBe(normalizedSetIds);
      expect(second.setIds).toBe(normalizedSetIds);

      const [row] = await db.execute(sql`
        SELECT count(*)::int AS count, min(set_ids) AS set_ids
        FROM user_boards
        WHERE owner_id = '00000000-0000-0000-0000-000000000000'
          AND board_type = 'moonboard'
          AND layout_id = ${MOONBOARD_2016_LAYOUT.id}
          AND size_id = ${MOONBOARD_SIZE.id}
          AND deleted_at IS NULL
      `);
      expect(Number((row as { count: number }).count)).toBe(1);
      expect((row as { set_ids: string }).set_ids).toBe(normalizedSetIds);
    });

    it('rejects binding a second serial onto an already-bound board via the unique index', async () => {
      const serialA = `UNIQ-A-${Date.now()}`;
      const resolved = await boardPresenceMutations.resolveBoardForSerial(
        undefined,
        { serial: serialA, boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2' },
        authCtx(),
      );

      // Attempt to UPDATE a *different* board to the same serial — must fail the
      // unique partial index (serial → exactly one active board).
      await db.execute(sql`
        INSERT INTO user_boards (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, serial_number)
        VALUES (${`uuid-other-${Date.now()}`}, ${`slug-other-${Date.now()}`}, ${TEST_USER_ID}, 'kilter', 2, 20, '5,6', 'Other Wall', null)
      `);
      const [other] = await db.execute(
        sql`SELECT id FROM user_boards WHERE owner_id = ${TEST_USER_ID} AND layout_id = 2 LIMIT 1`,
      );
      const otherId = (other as { id: number }).id;

      await expect(
        db.execute(sql`UPDATE user_boards SET serial_number = ${serialA} WHERE id = ${otherId}`),
      ).rejects.toThrow();

      // The original board still owns the serial.
      const [orig] = await db.execute(sql`SELECT serial_number FROM user_boards WHERE id = ${resolved.boardId}`);
      expect((orig as { serial_number: string }).serial_number).toBe(serialA);
    });
  });

  describe('resolveBoardCandidatesForSerial + chooseBoardForSerial (serial disambiguation)', () => {
    async function insertBoard(opts: {
      ownerId: string;
      serial: string | null;
      layoutId: number;
      sizeId: number;
      setIds: string;
      name: string;
      isPublic?: boolean;
      locationName?: string | null;
    }): Promise<{ id: number; uuid: string }> {
      const uuid = `uuid-${Math.random().toString(36).slice(2)}`;
      const slug = `slug-${Math.random().toString(36).slice(2)}`;
      const [row] = await db.execute(sql`
        INSERT INTO user_boards
          (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, serial_number, is_public, location_name)
        VALUES (${uuid}, ${slug}, ${opts.ownerId}, 'kilter', ${opts.layoutId}, ${opts.sizeId}, ${opts.setIds},
                ${opts.name}, ${opts.serial}, ${opts.isPublic ?? true}, ${opts.locationName ?? null})
        RETURNING id, uuid
      `);
      return { id: Number((row as { id: number }).id), uuid: (row as { uuid: string }).uuid };
    }

    it('returns candidates when several boards share a serial, with private boards still listed but location redacted', async () => {
      const serial = `DUP-${Date.now()}`;
      const mine = await insertBoard({
        ownerId: TEST_USER_ID,
        serial,
        layoutId: 1,
        sizeId: 10,
        setIds: '1,2',
        name: 'My Wall',
        isPublic: true,
        locationName: 'My Garage',
      });
      const theirsPrivate = await insertBoard({
        ownerId: SECOND_USER_ID,
        serial,
        layoutId: 1,
        sizeId: 10,
        setIds: '1,2',
        name: 'Their Wall',
        isPublic: false,
        locationName: 'Secret Spot',
      });

      const result = await boardPresenceMutations.resolveBoardCandidatesForSerial(
        undefined,
        { serial, boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2' },
        authCtx(),
      );

      expect(result.board).toBeNull();
      expect(result.candidates).toHaveLength(2);
      const byId = new Map((result.candidates ?? []).map((candidate) => [candidate.boardId, candidate]));
      const mineCandidate = byId.get(mine.id)!;
      const theirsCandidate = byId.get(theirsPrivate.id)!;
      expect(mineCandidate.isOwnedByMe).toBe(true);
      expect(mineCandidate.locationName).toBe('My Garage');
      // A private board owned by someone else is still findable by serial...
      expect(theirsCandidate).toBeDefined();
      expect(theirsCandidate.isOwnedByMe).toBe(false);
      // ...but we don't leak its location.
      expect(theirsCandidate.locationName).toBeNull();
    });

    it('does not auto-pick the caller-owned board when another board shares the serial — it prompts', async () => {
      const serial = `OWN-${Date.now()}`;
      await insertBoard({ ownerId: TEST_USER_ID, serial, layoutId: 3, sizeId: 10, setIds: '1', name: 'Home' });
      await insertBoard({ ownerId: SECOND_USER_ID, serial, layoutId: 3, sizeId: 10, setIds: '1', name: 'Gym' });

      const result = await boardPresenceMutations.resolveBoardCandidatesForSerial(
        undefined,
        { serial, boardType: 'kilter', layoutId: 3, sizeId: 10, setIds: '1' },
        authCtx(),
      );
      expect(result.board).toBeNull();
      expect(result.candidates).toHaveLength(2);
    });

    it('auto-resolves (no prompt) and remembers when exactly one board carries the serial', async () => {
      const serial = `ONE-${Date.now()}`;
      const only = await insertBoard({
        ownerId: SECOND_USER_ID,
        serial,
        layoutId: 4,
        sizeId: 10,
        setIds: '1',
        name: 'Only Wall',
      });

      const result = await boardPresenceMutations.resolveBoardCandidatesForSerial(
        undefined,
        { serial, boardType: 'kilter', layoutId: 4, sizeId: 10, setIds: '1' },
        authCtx(),
      );
      expect(result.candidates).toBeNull();
      expect(result.board?.boardId).toBe(only.id);

      const [row] = await db.execute(
        sql`SELECT board_uuid FROM user_board_serials WHERE user_id = ${TEST_USER_ID} AND serial_number = ${serial}`,
      );
      expect((row as { board_uuid: string }).board_uuid).toBe(only.uuid);
    });

    it('chooseBoardForSerial remembers the pick so a later resolve no longer prompts', async () => {
      const serial = `PICK-${Date.now()}`;
      await insertBoard({ ownerId: TEST_USER_ID, serial, layoutId: 5, sizeId: 10, setIds: '1', name: 'Mine' });
      const theirs = await insertBoard({
        ownerId: SECOND_USER_ID,
        serial,
        layoutId: 5,
        sizeId: 10,
        setIds: '1',
        name: 'Theirs',
      });

      const ambiguous = await boardPresenceMutations.resolveBoardCandidatesForSerial(
        undefined,
        { serial, boardType: 'kilter', layoutId: 5, sizeId: 10, setIds: '1' },
        authCtx(),
      );
      expect(ambiguous.candidates).toHaveLength(2);

      const chosen = await boardPresenceMutations.chooseBoardForSerial(
        undefined,
        { boardId: theirs.id, serial },
        authCtx(),
      );
      expect(chosen.boardId).toBe(theirs.id);

      const after = await boardPresenceMutations.resolveBoardCandidatesForSerial(
        undefined,
        { serial, boardType: 'kilter', layoutId: 5, sizeId: 10, setIds: '1' },
        authCtx(),
      );
      expect(after.candidates).toBeNull();
      expect(after.board?.boardId).toBe(theirs.id);
    });

    it('chooseBoardForSerial rejects a board not linked to the serial', async () => {
      const serial = `BAD-${Date.now()}`;
      await insertBoard({ ownerId: SECOND_USER_ID, serial, layoutId: 6, sizeId: 10, setIds: '1', name: 'Real' });
      const unrelated = await insertBoard({
        ownerId: TEST_USER_ID,
        serial: null,
        layoutId: 6,
        sizeId: 11,
        setIds: '1',
        name: 'Unrelated',
      });

      await expect(
        boardPresenceMutations.chooseBoardForSerial(undefined, { boardId: unrelated.id, serial }, authCtx()),
      ).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
    });

    it('legacy resolveBoardForSerial auto-picks the caller-owned board among duplicates', async () => {
      const serial = `LEGACY-${Date.now()}`;
      const mine = await insertBoard({
        ownerId: TEST_USER_ID,
        serial,
        layoutId: 7,
        sizeId: 10,
        setIds: '1',
        name: 'Mine Legacy',
      });
      await insertBoard({
        ownerId: SECOND_USER_ID,
        serial,
        layoutId: 7,
        sizeId: 10,
        setIds: '1',
        name: 'Theirs Legacy',
      });

      const resolved = await boardPresenceMutations.resolveBoardForSerial(
        undefined,
        { serial, boardType: 'kilter', layoutId: 7, sizeId: 10, setIds: '1' },
        authCtx(),
      );
      expect(resolved.boardId).toBe(mine.id);
    });

    it('allows the same serial across two owners but blocks a second board for one owner', async () => {
      const serial = `CONSTRAINT-${Date.now()}`;
      await insertBoard({ ownerId: TEST_USER_ID, serial, layoutId: 8, sizeId: 10, setIds: '1', name: 'A' });
      // Different owner, same serial — allowed now that serials aren't globally unique.
      await insertBoard({ ownerId: SECOND_USER_ID, serial, layoutId: 8, sizeId: 10, setIds: '1', name: 'B' });
      // Same owner, second board, same serial — still rejected by the per-owner unique index.
      await expect(
        insertBoard({ ownerId: TEST_USER_ID, serial, layoutId: 9, sizeId: 10, setIds: '1', name: 'C' }),
      ).rejects.toThrow();
    });
  });

  describe('resolveBoardForUuid', () => {
    it('resolves the selected named board and stamps proof-of-presence', async () => {
      const boardUuid = uuidv4();
      const slug = `presence-uuid-${Date.now()}`;
      await db.execute(sql`
        INSERT INTO user_boards (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, serial_number, is_public)
        VALUES (${boardUuid}, ${slug}, ${TEST_USER_ID}, 'kilter', 4, 12, '1,2', 'Named Wall', null, false)
      `);

      const resolved = await boardPresenceMutations.resolveBoardForUuid(undefined, { boardUuid }, authCtx());

      expect(resolved.boardName).toBe('Named Wall');
      expect(resolved.boardType).toBe('kilter');
      expect(resolved.layoutId).toBe(4);
      expect(await pubsub.hasBoardMembership(String(resolved.boardId), TEST_USER_ID)).toBe(true);
    });

    it('rejects a private board owned by another user', async () => {
      const boardUuid = uuidv4();
      const slug = `presence-private-${Date.now()}`;
      await db.execute(sql`
        INSERT INTO user_boards (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, serial_number, is_public)
        VALUES (${boardUuid}, ${slug}, ${SECOND_USER_ID}, 'kilter', 4, 12, '1,2', 'Private Wall', null, false)
      `);

      await expect(boardPresenceMutations.resolveBoardForUuid(undefined, { boardUuid }, authCtx())).rejects.toThrow(
        'Board not found',
      );
    });

    it('follows a merged uuid to the active canonical board', async () => {
      const canonicalUuid = uuidv4();
      const loserUuid = uuidv4();
      const suffix = Date.now().toString(36);
      await db.execute(sql`
        INSERT INTO user_boards
          (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, serial_number, is_public)
        VALUES
          (${canonicalUuid}, ${`presence-merged-canonical-${suffix}`}, ${SECOND_USER_ID}, 'kilter', 5, 12, '1,2', 'Canonical Wall', null, true)
      `);
      await db.execute(sql`
        INSERT INTO user_boards
          (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, serial_number,
           is_public, deleted_at, merged_into_board_uuid)
        VALUES
          (${loserUuid}, ${`presence-merged-loser-${suffix}`}, ${TEST_USER_ID}, 'kilter', 5, 12, '1,2', 'Old Wall', null,
           false, now(), ${canonicalUuid})
      `);

      const resolved = await boardPresenceMutations.resolveBoardForUuid(undefined, { boardUuid: loserUuid }, authCtx());

      expect(resolved.boardName).toBe('Canonical Wall');
      const [canonical] = await db.execute(sql`SELECT id FROM user_boards WHERE uuid = ${canonicalUuid}`);
      expect(resolved.boardId).toBe(Number((canonical as { id: number }).id));
      expect(await pubsub.hasBoardMembership(String(resolved.boardId), TEST_USER_ID)).toBe(true);
    });

    it('checks privacy on the canonical board after following a tombstone', async () => {
      const canonicalUuid = uuidv4();
      const loserUuid = uuidv4();
      const suffix = Date.now().toString(36);
      await db.execute(sql`
        INSERT INTO user_boards
          (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, serial_number, is_public)
        VALUES
          (${canonicalUuid}, ${`presence-private-canonical-${suffix}`}, ${SECOND_USER_ID}, 'kilter', 6, 12, '1,2', 'Private Canonical', null, false)
      `);
      await db.execute(sql`
        INSERT INTO user_boards
          (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, serial_number,
           is_public, deleted_at, merged_into_board_uuid)
        VALUES
          (${loserUuid}, ${`presence-private-loser-${suffix}`}, ${TEST_USER_ID}, 'kilter', 6, 12, '1,2', 'Owned Old Wall', null,
           true, now(), ${canonicalUuid})
      `);

      await expect(
        boardPresenceMutations.resolveBoardForUuid(undefined, { boardUuid: loserUuid }, authCtx()),
      ).rejects.toThrow('Board not found');
      await expect(
        boardPresenceMutations.resolveBoardForUuid(
          undefined,
          { boardUuid: loserUuid },
          authCtx({ isAuthenticated: false, userId: undefined }),
        ),
      ).rejects.toThrow('Board not found');

      const resolvedForOwner = await boardPresenceMutations.resolveBoardForUuid(
        undefined,
        { boardUuid: loserUuid },
        authCtx({ userId: SECOND_USER_ID }),
      );
      expect(resolvedForOwner.boardName).toBe('Private Canonical');
    });

    it('rejects a board uuid that does not exist', async () => {
      await expect(
        boardPresenceMutations.resolveBoardForUuid(undefined, { boardUuid: uuidv4() }, authCtx()),
      ).rejects.toThrow('Board not found');
    });
  });

  describe('allocateBoardPresenceSeq', () => {
    it('reserves above both the durable event floor and prior reservations without Redis', async () => {
      const boardUuid = uuidv4();
      const slug = `presence-seq-authority-${Date.now()}`;
      const [inserted] = await db.execute(sql`
        INSERT INTO user_boards
          (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, serial_number,
           is_public, presence_seq)
        VALUES (${boardUuid}, ${slug}, ${TEST_USER_ID}, 'kilter', 7, 12, '1,2', 'Sequence Wall', null, false, 25)
        RETURNING id
      `);
      const boardId = Number((inserted as { id: number }).id);
      await db.execute(sql`
        INSERT INTO board_climb_events (board_id, board_type, climb_uuid, angle, seq, confirmed_at)
        VALUES (${boardId}, 'kilter', ${TEST_CLIMB_UUID}, 40, 40, now())
      `);

      expect(await allocateBoardPresenceSeq(boardId, 3)).toBe(41);
      expect(await allocateBoardPresenceSeq(boardId, 3)).toBe(42);

      const [row] = await db.execute(sql`SELECT presence_seq FROM user_boards WHERE id = ${boardId}`);
      expect(Number((row as { presence_seq: number }).presence_seq)).toBe(42);
    });

    it('fails closed for a merged-away board', async () => {
      const boardUuid = uuidv4();
      const slug = `presence-seq-deleted-${Date.now()}`;
      const [inserted] = await db.execute(sql`
        INSERT INTO user_boards
          (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, serial_number, is_public)
        VALUES (${boardUuid}, ${slug}, ${TEST_USER_ID}, 'kilter', 8, 12, '1,2', 'Merged Sequence Wall', null, false)
        RETURNING id
      `);
      const boardId = Number((inserted as { id: number }).id);
      await db.execute(sql`UPDATE user_boards SET deleted_at = now() WHERE id = ${boardId}`);

      await expect(allocateBoardPresenceSeq(boardId, 1)).rejects.toThrow('Board not found');
    });

    it('does not insert a durable event after a waiting board is tombstoned', async () => {
      const canonicalUuid = uuidv4();
      const loserUuid = uuidv4();
      const suffix = Date.now().toString(36);
      const [canonical] = await db.execute(sql`
        INSERT INTO user_boards
          (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, serial_number, is_public)
        VALUES (${canonicalUuid}, ${`presence-seq-race-canonical-${suffix}`}, ${TEST_USER_ID},
                'kilter', 9, 12, '1,2', 'Sequence Survivor', null, false)
        RETURNING id
      `);
      const [loser] = await db.execute(sql`
        INSERT INTO user_boards
          (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, serial_number, is_public)
        VALUES (${loserUuid}, ${`presence-seq-race-loser-${suffix}`}, ${SECOND_USER_ID},
                'kilter', 9, 12, '1,2', 'Sequence Loser', null, false)
        RETURNING id
      `);
      const canonicalId = Number((canonical as { id: number }).id);
      const loserId = Number((loser as { id: number }).id);

      let confirmRowsLocked = () => {};
      const rowsLocked = new Promise<void>((resolve) => {
        confirmRowsLocked = () => resolve();
      });
      let allowMergeCommit = () => {};
      const mayCommit = new Promise<void>((resolve) => {
        allowMergeCommit = () => resolve();
      });
      const merge = db.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM user_boards WHERE id IN (${canonicalId}, ${loserId}) FOR UPDATE`);
        confirmRowsLocked();
        await mayCommit;
        await tx.execute(sql`
          UPDATE user_boards
             SET deleted_at = now(), merged_into_board_uuid = ${canonicalUuid}
           WHERE id = ${loserId}
        `);
      });

      await rowsLocked;
      const persistenceResult = reserveAndPersistBoardClimbEvent(
        {
          boardId: loserId,
          boardType: 'kilter',
          climbUuid: TEST_CLIMB_UUID,
          angle: 40,
          userId: TEST_USER_ID,
          sessionId: null,
          frames: 'p1145r12',
          name: 'Real Catalog Climb',
          grade: 'V5',
          setter: 'setter-bob',
          confirmedAt: new Date().toISOString(),
        },
        1,
      ).then(
        () => null,
        (error: unknown) => error,
      );
      // Let the allocator reach the row lock, then commit the tombstone. Its
      // UPDATE resumes against the now-deleted row and returns no reservation.
      await Promise.resolve();
      allowMergeCommit();
      await merge;
      const persistenceError = await persistenceResult;
      expect(persistenceError).toBeInstanceOf(GraphQLError);
      expect((persistenceError as Error).message).toBe('Board not found');

      const [eventCount] = await db.execute(
        sql`SELECT count(*)::int AS count FROM board_climb_events WHERE board_id = ${loserId}`,
      );
      expect(Number((eventCount as { count: number }).count)).toBe(0);
    });
  });

  describe('reportBoardClimb', () => {
    let serialCounter = 0;
    async function makeBoard(): Promise<number> {
      // BoardSerialSchema caps at 32 chars and forbids dots, so keep it short
      // and alphanumeric-with-hyphens.
      const serial = `RPT-${Date.now().toString(36)}-${serialCounter++}`;
      const resolved = await boardPresenceMutations.resolveBoardForSerial(
        undefined,
        { serial, boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2' },
        authCtx(),
      );
      return resolved.boardId;
    }

    it('derives display metadata and sender identity server-side without leaking the raw serial', async () => {
      const boardId = await makeBoard();
      const received: BoardPresenceEvent[] = [];
      const unsubscribe = await pubsub.subscribeBoardPresence(String(boardId), (event) => received.push(event));

      // A malicious client can send plausible but fake display fields. The
      // published payload must use catalog fields + server profile instead.
      const spoofedClimb = makeQueueItemInput({
        name: 'Fake Client Name',
        frames: 'fake-client-frames',
        setter_username: 'fake-setter',
        difficulty: 'V900',
      });
      const ok = await boardPresenceMutations.reportBoardClimb(
        undefined,
        { boardId, climb: spoofedClimb, angle: 45 },
        authCtx(),
      );
      expect(ok).toBe(true);

      // The first send also hands off the connection holder, so the feed carries
      // a BoardConnectionChanged alongside the BoardClimbSet — assert on the
      // climb event specifically.
      const climbSets = received.filter((event): event is BoardClimbSet => event.__typename === 'BoardClimbSet');
      expect(climbSets).toHaveLength(1);
      const event = climbSets[0];
      expect(event.__typename).toBe('BoardClimbSet');
      expect(event.climb.sentByDisplayName).toBe(SENDER_DISPLAY_NAME);
      expect(event.climb.sentByAvatarUrl).toBe(SENDER_AVATAR_URL);
      expect(event.climb.sentByUserId).toBe(TEST_USER_ID);
      expect(event.climb.climbUuid).toBe(TEST_CLIMB_UUID);
      expect(event.climb.name).toBe('Real Catalog Climb');
      expect(event.climb.frames).toBe('p1145r12');
      expect(event.climb.setter).toBeNull();
      expect(event.climb.grade).toBe('V6');
      expect(event.climb.angle).toBe(45);
      expect(event.climb.seq).toBeGreaterThan(0);
      expect(JSON.stringify(received)).not.toContain('Fake Client Name');
      unsubscribe();
    });

    it('keeps the raw serial out of resolved-board and board-presence payloads', async () => {
      const serial = `PRIV-${Date.now()}`;
      const resolved = await boardPresenceMutations.resolveBoardForSerial(
        undefined,
        { serial, boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2' },
        authCtx(),
      );
      const received: BoardPresenceEvent[] = [];
      const unsubscribe = await pubsub.subscribeBoardPresence(String(resolved.boardId), (event) =>
        received.push(event),
      );

      await boardPresenceMutations.reportBoardClimb(
        undefined,
        { boardId: resolved.boardId, climb: makeQueueItemInput(), angle: 40 },
        authCtx(),
      );

      expect(JSON.stringify(resolved)).not.toContain(serial);
      expect(JSON.stringify(received)).not.toContain(serial);
      unsubscribe();
    });

    it('rejects an unknown climbUuid (not in the catalog)', async () => {
      const boardId = await makeBoard();
      const bogus = makeQueueItemInput({ uuid: 'does-not-exist-uuid' });
      await expect(
        boardPresenceMutations.reportBoardClimb(undefined, { boardId, climb: bogus, angle: 40 }, authCtx()),
      ).rejects.toThrow('Unknown climb');
    });

    it('accepts a negative board angle (Aurora boards support negative tilt) and publishes it verbatim', async () => {
      // reportBoardClimb fires on EVERY climb-light event from a connected/kiosk
      // board, so a negative-tilt board (e.g. -5°) must not error here. There's
      // no board_climb_stats row at -5° for TEST_CLIMB_UUID, so the grade join
      // simply misses (grade: null) rather than rejecting the report.
      const boardId = await makeBoard();
      const received: BoardPresenceEvent[] = [];
      const unsubscribe = await pubsub.subscribeBoardPresence(String(boardId), (event) => received.push(event));

      const ok = await boardPresenceMutations.reportBoardClimb(
        undefined,
        { boardId, climb: makeQueueItemInput(), angle: -5 },
        authCtx(),
      );
      expect(ok).toBe(true);

      const climbSet = received.find((event): event is BoardClimbSet => event.__typename === 'BoardClimbSet');
      expect(climbSet).toBeDefined();
      expect(climbSet!.climb.angle).toBe(-5);
      expect(climbSet!.climb.grade).toBeNull();
      unsubscribe();
    });

    it('rejects angle -91 (outside the -90..90 board-tilt range) before touching the board', async () => {
      const boardId = await makeBoard();
      await expect(
        boardPresenceMutations.reportBoardClimb(
          undefined,
          { boardId, climb: makeQueueItemInput(), angle: -91 },
          authCtx(),
        ),
      ).rejects.toThrow();
    });

    it('accepts a negative climb.angle (ClimbInputSchema) as the fallback when no top-level angle is sent', async () => {
      // ReportBoardClimbInputSchema.climb extends ClimbInputSchema — this proves
      // ITS angle bound (not just BoardPresenceAngleSchema's) accepts negative
      // tilt: the top-level `angle` arg is omitted, so effectiveAngle falls back
      // to validatedClimb.climb.angle.
      const boardId = await makeBoard();
      const received: BoardPresenceEvent[] = [];
      const unsubscribe = await pubsub.subscribeBoardPresence(String(boardId), (event) => received.push(event));

      const ok = await boardPresenceMutations.reportBoardClimb(
        undefined,
        { boardId, climb: makeQueueItemInput({ angle: -5 }) },
        authCtx(),
      );
      expect(ok).toBe(true);

      const climbSet = received.find((event): event is BoardClimbSet => event.__typename === 'BoardClimbSet');
      expect(climbSet).toBeDefined();
      expect(climbSet!.climb.angle).toBe(-5);
      unsubscribe();
    });

    it('rejects a report from a user who never connected to the board (proof-of-presence)', async () => {
      // makeBoard() resolves as TEST_USER_ID, stamping that user's membership.
      // A different authenticated user who never connected must not be able to
      // inject onto this board's feed even if they guess the boardId.
      const boardId = await makeBoard();
      await expect(
        boardPresenceMutations.reportBoardClimb(
          undefined,
          { boardId, climb: makeQueueItemInput(), angle: 40 },
          authCtx({ userId: SECOND_USER_ID }),
        ),
      ).rejects.toThrow('Not connected to this board');
    });

    it('accepts an anonymous report once the anon emitter is a board member', async () => {
      // Board presence is auth-optional: an anonymous client binds an existing
      // shared board (stamping its conn:-keyed membership) and may then report.
      // Identity is null (no profile to derive from) — clients render a "?".
      const config = { boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2' };
      // A logged-in user creates the shared feed first (anon can't mint boards).
      await boardPresenceMutations.resolveBoardForConfig(undefined, config, authCtx());
      const anonCtx = authCtx({ isAuthenticated: false, userId: undefined });
      const resolved = await boardPresenceMutations.resolveBoardForConfig(undefined, config, anonCtx);
      const received: BoardPresenceEvent[] = [];
      const unsubscribe = await pubsub.subscribeBoardPresence(String(resolved.boardId), (event) =>
        received.push(event),
      );

      const ok = await boardPresenceMutations.reportBoardClimb(
        undefined,
        { boardId: resolved.boardId, climb: makeQueueItemInput(), angle: 40 },
        anonCtx,
      );
      expect(ok).toBe(true);

      const climbSet = received.find((event): event is BoardClimbSet => event.__typename === 'BoardClimbSet');
      expect(climbSet).toBeDefined();
      expect(climbSet!.climb.climbUuid).toBe(TEST_CLIMB_UUID);
      // Anonymous emitter → null attribution (no user profile, no profile link).
      expect(climbSet!.climb.sentByDisplayName).toBeNull();
      expect(climbSet!.climb.sentByAvatarUrl).toBeNull();
      expect(climbSet!.climb.sentByUserId).toBeNull();
      unsubscribe();
    });

    it('rejects an anonymous report when the anon emitter never resolved the board', async () => {
      // A different anon connection (no membership stamp) can't inject onto a
      // board it never resolved, even if it guesses the id.
      const boardId = await makeBoard();
      await expect(
        boardPresenceMutations.reportBoardClimb(
          undefined,
          { boardId, climb: makeQueueItemInput(), angle: 40 },
          authCtx({ isAuthenticated: false, userId: undefined }),
        ),
      ).rejects.toThrow('Not connected to this board');
    });

    it('enriches durable boardHistory rows with the sender profile and a profile-linkable user id', async () => {
      // board_climb_events stores only userId; the resolver joins users +
      // user_profiles so history rows carry the same identity (and the user id the
      // avatar links to) as the live feed, instead of the old null attribution.
      const boardId = await makeBoard();
      const seq = await pubsub.nextBoardSeq(String(boardId));
      await db.insert(dbSchema.boardClimbEvents).values({
        boardId,
        boardType: 'kilter',
        climbUuid: TEST_CLIMB_UUID,
        angle: 40,
        userId: TEST_USER_ID,
        sessionId: null,
        seq,
        frames: 'p1145r12',
        name: 'Real Catalog Climb',
        grade: 'V6',
        setter: null,
        confirmedAt: new Date().toISOString(),
      });

      const history = await boardPresenceQueries.boardHistory(undefined, { boardId }, authCtx());
      const row = history.find((entry) => entry.seq === seq);

      expect(row).toBeDefined();
      expect(row!.sentByUserId).toBe(TEST_USER_ID);
      expect(row!.sentByDisplayName).toBe(SENDER_DISPLAY_NAME);
      expect(row!.sentByAvatarUrl).toBe(SENDER_AVATAR_URL);
    });

    // The connection-holder hand-off broadcast is Redis-only (see the
    // "board-presence connection holder" describe at the end of the file, which
    // initialises pubsub Redis and asserts the BoardConnectionChanged payload).
    // In the local-only mode this describe runs in, holder events don't fire.
  });

  describe('boardClimbRecentSenders', () => {
    let serialCounter = 0;

    async function makeBoard(): Promise<number> {
      const resolved = await boardPresenceMutations.resolveBoardForSerial(
        undefined,
        {
          serial: `SENDERS-${Date.now().toString(36)}-${serialCounter++}`,
          boardType: 'kilter',
          layoutId: 1,
          sizeId: 10,
          setIds: '1,2',
        },
        authCtx(),
      );
      return resolved.boardId;
    }

    function tick({
      uuid,
      userId,
      boardId,
      climbUuid = TEST_CLIMB_UUID,
      angle = 40,
      status = 'send',
      climbedAt,
    }: {
      uuid: string;
      userId: string;
      boardId: number;
      climbUuid?: string;
      angle?: number;
      status?: 'flash' | 'send' | 'attempt';
      climbedAt: string;
    }): typeof dbSchema.boardseshTicks.$inferInsert {
      return {
        uuid,
        userId,
        boardId,
        boardType: 'kilter',
        climbUuid,
        angle,
        status,
        climbedAt,
      };
    }

    it('returns each latest successful sender newest-first across canonical and alias UUIDs', async () => {
      const boardId = await makeBoard();
      const otherBoard = await boardPresenceMutations.resolveBoardForConfig(
        undefined,
        { boardType: 'kilter', layoutId: 2, sizeId: 20, setIds: '5,6' },
        authCtx(),
      );
      const oldest = '2026-07-01T10:00:00.000Z';
      const secondLatest = '2026-07-02T10:00:00.000Z';
      const latest = '2026-07-03T10:00:00.000Z';
      const excludedLatest = '2026-07-04T10:00:00.000Z';

      await db.insert(dbSchema.boardseshTicks).values([
        tick({ uuid: `recent-old-${Date.now()}`, userId: TEST_USER_ID, boardId, climbedAt: oldest }),
        tick({
          uuid: `recent-alias-${Date.now()}`,
          userId: TEST_USER_ID,
          boardId,
          climbUuid: ALIAS_TEST_CLIMB_UUID,
          status: 'flash',
          climbedAt: latest,
        }),
        tick({ uuid: `recent-second-${Date.now()}`, userId: SECOND_USER_ID, boardId, climbedAt: secondLatest }),
        tick({
          uuid: `recent-attempt-${Date.now()}`,
          userId: SECOND_USER_ID,
          boardId,
          status: 'attempt',
          climbedAt: excludedLatest,
        }),
        tick({
          uuid: `recent-other-angle-${Date.now()}`,
          userId: SECOND_USER_ID,
          boardId,
          angle: 45,
          climbedAt: excludedLatest,
        }),
        tick({
          uuid: `recent-other-climb-${Date.now()}`,
          userId: SECOND_USER_ID,
          boardId,
          climbUuid: OTHER_TEST_CLIMB_UUID,
          climbedAt: excludedLatest,
        }),
        tick({
          uuid: `recent-other-board-${Date.now()}`,
          userId: SECOND_USER_ID,
          boardId: otherBoard.boardId,
          climbedAt: excludedLatest,
        }),
      ]);

      const senders = await boardPresenceQueries.boardClimbRecentSenders(
        undefined,
        { boardId, climbUuid: ALIAS_TEST_CLIMB_UUID, angle: 40 },
        authCtx(),
      );

      expect(senders).toEqual([
        {
          userId: TEST_USER_ID,
          displayName: SENDER_DISPLAY_NAME,
          avatarUrl: SENDER_AVATAR_URL,
          lastSentAt: latest,
        },
        {
          userId: SECOND_USER_ID,
          displayName: 'Second Sender',
          avatarUrl: null,
          lastSentAt: secondLatest,
        },
      ]);

      await expect(
        boardPresenceQueries.boardClimbRecentSenders(
          undefined,
          { boardId, climbUuid: TEST_CLIMB_UUID, angle: 40 },
          authCtx(),
        ),
      ).resolves.toEqual(senders);
    });

    it('caps the byline at the five latest distinct senders', async () => {
      const boardId = await makeBoard();
      await db.insert(dbSchema.users).values(
        RECENT_SENDER_TEST_USER_IDS.map((userId, index) => ({
          id: userId,
          email: `${userId}@example.test`,
          name: `Recent sender ${index + 1}`,
        })),
      );
      const ticks = RECENT_SENDER_TEST_USER_IDS.map((userId, index) =>
        tick({
          uuid: `recent-cap-${index}-${Date.now()}`,
          userId,
          boardId,
          climbedAt: new Date(Date.UTC(2026, 6, 1, index)).toISOString(),
        }),
      );
      await db.insert(dbSchema.boardseshTicks).values(ticks);

      const senders = await boardPresenceQueries.boardClimbRecentSenders(
        undefined,
        { boardId, climbUuid: TEST_CLIMB_UUID, angle: 40 },
        authCtx(),
      );

      expect(senders.map((sender) => sender.userId)).toEqual([...RECENT_SENDER_TEST_USER_IDS].reverse().slice(0, 5));
    });

    it('validates climb UUID and angle before querying ticks', async () => {
      const boardId = await makeBoard();
      await expect(
        boardPresenceQueries.boardClimbRecentSenders(
          undefined,
          { boardId, climbUuid: TEST_CLIMB_UUID, angle: 90 },
          authCtx(),
        ),
      ).resolves.toEqual([]);
      await expect(
        boardPresenceQueries.boardClimbRecentSenders(undefined, { boardId, climbUuid: '   ', angle: 40 }, authCtx()),
      ).rejects.toThrow('Climb UUID cannot be empty');
      await expect(
        boardPresenceQueries.boardClimbRecentSenders(
          undefined,
          { boardId, climbUuid: TEST_CLIMB_UUID, angle: 91 },
          authCtx(),
        ),
      ).rejects.toThrow('Invalid recent senders');
    });
  });

  describe('boardNowPlaying subscription', () => {
    it('eager-subscribes (awaits the channel) before the first reported climb is delivered', async () => {
      const boardId = await (async () => {
        const resolved = await boardPresenceMutations.resolveBoardForSerial(
          undefined,
          { serial: `SUB-${Date.now()}`, boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2' },
          authCtx(),
        );
        return resolved.boardId;
      })();

      // subscribe() returns an async generator. Awaiting the first .next()
      // triggers createEagerAsyncIterator, which awaits the (Redis) subscribe
      // before resolving — so a climb reported *after* this await is captured.
      const iterator = boardPresenceSubscriptions.boardNowPlaying.subscribe(undefined, { boardId }, authCtx());

      // Prime the iterator: kick off the first next() (this runs up to the
      // first `yield`, establishing the subscription) then report a climb.
      const nextPromise = iterator.next();
      handleLater(nextPromise);
      // Give the eager subscribe a tick to settle.
      await new Promise((r) => setTimeout(r, 50));

      await boardPresenceMutations.reportBoardClimb(
        undefined,
        { boardId, climb: makeQueueItemInput(), angle: 30 },
        authCtx(),
      );

      const result = await nextPromise;
      expect(result.done).toBe(false);
      const payload = result.value as { boardNowPlaying: BoardClimbSet };
      expect(payload.boardNowPlaying.__typename).toBe('BoardClimbSet');
      expect(payload.boardNowPlaying.climb.climbUuid).toBe(TEST_CLIMB_UUID);
      expect(payload.boardNowPlaying.climb.angle).toBe(30);

      await iterator.return?.(undefined);
    });
  });

  describe('saveTick board stamping', () => {
    function baseTickInput(overrides: Record<string, unknown> = {}) {
      return {
        boardType: 'kilter',
        climbUuid: TEST_CLIMB_UUID,
        angle: 40,
        isMirror: false,
        status: 'send',
        attemptCount: 1,
        quality: null,
        difficulty: 17,
        isBenchmark: false,
        comment: '',
        climbedAt: new Date().toISOString(),
        layoutId: 1,
        sizeId: 10,
        setIds: '1,2',
        ...overrides,
      };
    }

    async function createSecondUserSharedBoard(): Promise<number> {
      const resolved = await boardPresenceMutations.resolveBoardForSerial(
        undefined,
        { serial: `TICK-${Date.now()}`, boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2' },
        authCtx({ userId: SECOND_USER_ID }),
      );
      return resolved.boardId;
    }

    async function createOwnConfigBoard(): Promise<number> {
      const slug = `own-config-${Date.now()}`;
      const [row] = await db.execute(sql`
        INSERT INTO user_boards (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, serial_number)
        VALUES (${`uuid-${slug}`}, ${slug}, ${TEST_USER_ID}, 'kilter', 1, 10, '1,2', 'Own Config', null)
        RETURNING id
      `);
      return Number((row as { id: number }).id);
    }

    async function latestTickBoardId(): Promise<number | null> {
      const [row] = await db.execute(sql`
        SELECT board_id
        FROM boardsesh_ticks
        WHERE user_id = ${TEST_USER_ID}
        ORDER BY created_at DESC
        LIMIT 1
      `);
      return row ? Number((row as { board_id: number | null }).board_id) : null;
    }

    it('stamps a valid explicit presence boardId over the caller config board', async () => {
      const sharedBoardId = await createSecondUserSharedBoard();
      const ownBoardId = await createOwnConfigBoard();

      await tickMutations.saveTick(undefined, { input: baseTickInput({ boardId: sharedBoardId }) }, authCtx());

      expect(await latestTickBoardId()).toBe(sharedBoardId);
      expect(await latestTickBoardId()).not.toBe(ownBoardId);
    });

    it('falls back to config resolution for nonexistent or mismatched explicit boardIds', async () => {
      const ownBoardId = await createOwnConfigBoard();
      const tensionBoard = await boardPresenceMutations.resolveBoardForConfig(
        undefined,
        { boardType: 'tension', layoutId: 1, sizeId: 10, setIds: '1,2' },
        authCtx(),
      );

      await tickMutations.saveTick(undefined, { input: baseTickInput({ boardId: 999_999_999 }) }, authCtx());
      expect(await latestTickBoardId()).toBe(ownBoardId);

      await db.execute(sql`DELETE FROM boardsesh_ticks WHERE user_id = ${TEST_USER_ID}`);
      await tickMutations.saveTick(undefined, { input: baseTickInput({ boardId: tensionBoard.boardId }) }, authCtx());
      expect(await latestTickBoardId()).toBe(ownBoardId);
    });

    it('replays an offline tick with a merged boardUuid onto the surviving board', async () => {
      const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const canonicalUuid = uuidv4();
      const loserUuid = uuidv4();
      const tickUuid = uuidv4();
      const [canonical] = await db.execute(sql`
        INSERT INTO user_boards
          (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, serial_number, is_public)
        VALUES (${canonicalUuid}, ${`tick-uuid-canonical-${suffix}`}, ${TEST_USER_ID},
                'kilter', 1, 10, '1,2', 'Tick UUID survivor', ${`TICK-UUID-${suffix}`}, true)
        RETURNING id
      `);
      await db.execute(sql`
        INSERT INTO user_boards
          (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, serial_number,
           is_public, deleted_at, merged_into_board_uuid)
        VALUES (${loserUuid}, ${`tick-uuid-loser-${suffix}`}, ${SECOND_USER_ID},
                'kilter', 1, 10, '1,2', 'Tick UUID loser', ${`TICK-UUID-${suffix}`},
                false, now(), ${canonicalUuid})
      `);
      const canonicalId = Number((canonical as { id: number }).id);

      const saved = (await tickMutations.saveTick(
        undefined,
        { input: baseTickInput({ uuid: tickUuid, boardUuid: loserUuid }) },
        authCtx(),
      )) as { boardId: number | null };

      expect(saved.boardId).toBe(canonicalId);
      const [persistedTick] = await db.execute(sql`
        SELECT board_id FROM boardsesh_ticks WHERE uuid = ${tickUuid}
      `);
      expect(Number((persistedTick as { board_id: number }).board_id)).toBe(canonicalId);
    });

    it('keeps an ordinary soft-deleted boardUuid unassociated without config fallback or warning', async () => {
      const ownBoardId = await createOwnConfigBoard();
      const staleBoardUuid = uuidv4();
      const tickUuid = uuidv4();
      await db.execute(sql`
        INSERT INTO user_boards
          (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name,
           is_public, deleted_at, merged_into_board_uuid)
        VALUES (${staleBoardUuid}, ${`tick-plain-deleted-${Date.now()}`}, ${SECOND_USER_ID},
                'kilter', 1, 10, '1,2', 'Plain deleted tick board', false, now(), NULL)
      `);
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);

      const saved = (await tickMutations.saveTick(
        undefined,
        { input: baseTickInput({ uuid: tickUuid, boardUuid: staleBoardUuid }) },
        authCtx(),
      )) as { boardId: number | null };

      expect(saved.boardId).toBeNull();
      expect(saved.boardId).not.toBe(ownBoardId);
      const [persistedTick] = await db.execute(sql`
        SELECT board_id FROM boardsesh_ticks WHERE uuid = ${tickUuid}
      `);
      expect((persistedTick as { board_id: number | null }).board_id).toBeNull();
      expect(warnSpy).not.toHaveBeenCalledWith(
        '[saveTick] Board association became unavailable; saving tick without board association',
        expect.anything(),
      );
    });

    it('routes a tick that waited behind serial dedupe onto the surviving board', async () => {
      const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const serial = `TICK-MERGE-${suffix}`.toUpperCase();
      const canonicalUuid = uuidv4();
      const loserUuid = uuidv4();
      const tickUuid = uuidv4();
      const [canonical] = await db.execute(sql`
        INSERT INTO user_boards
          (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, serial_number, is_public)
        VALUES (${canonicalUuid}, ${`tick-merge-canonical-${suffix}`}, ${TEST_USER_ID},
                'kilter', 1, 10, '1,2', 'Tick survivor', ${serial}, true)
        RETURNING id
      `);
      const [loser] = await db.execute(sql`
        INSERT INTO user_boards
          (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, serial_number, is_public)
        VALUES (${loserUuid}, ${`tick-merge-loser-${suffix}`}, ${SECOND_USER_ID},
                'kilter', 1, 10, '1,2', 'Tick loser', ${serial}, true)
        RETURNING id
      `);
      const canonicalId = Number((canonical as { id: number }).id);
      const loserId = Number((loser as { id: number }).id);
      const mergeReady = createValueBarrier<number>();
      const releaseMerge = createBarrier();
      let mergePromise: Promise<void> | undefined;
      let savePromise: ReturnType<typeof tickMutations.saveTick> | undefined;

      try {
        mergePromise = db.transaction(async (transaction) => {
          const [session] = await transaction.execute(sql`SELECT pg_backend_pid() AS pid`);
          await transaction.execute(sql`
            SELECT id
              FROM user_boards
             WHERE id IN (${canonicalId}, ${loserId})
             ORDER BY id
             FOR UPDATE
          `);
          // Match the maintenance ordering: the one-time repoint happens before
          // the loser is tombstoned. A save that only relies on its FK lock can
          // otherwise resume after commit and miss this UPDATE forever.
          await transaction.execute(sql`
            UPDATE boardsesh_ticks SET board_id = ${canonicalId} WHERE board_id = ${loserId}
          `);
          await transaction.execute(sql`
            UPDATE user_boards
               SET deleted_at = now(), merged_into_board_uuid = ${canonicalUuid}
             WHERE id = ${loserId}
          `);
          mergeReady.release(Number((session as { pid: number }).pid));
          await releaseMerge.promise;
        });
        handleLater(mergePromise);
        const mergePid = await mergeReady.promise;

        savePromise = tickMutations.saveTick(
          undefined,
          { input: baseTickInput({ uuid: tickUuid, boardId: loserId }) },
          authCtx(),
        );
        handleLater(savePromise);
        await waitForSessionBlockedBy(mergePid);

        releaseMerge.release();
        await mergePromise;
        const saved = (await savePromise) as { boardId: number | null };
        expect(saved.boardId).toBe(canonicalId);

        const [lateTick] = await db.execute(sql`
          SELECT board_id FROM boardsesh_ticks WHERE uuid = ${tickUuid}
        `);
        expect(Number((lateTick as { board_id: number }).board_id)).toBe(canonicalId);
      } finally {
        releaseMerge.release();
        await Promise.allSettled([mergePromise, savePromise]);
      }
    });

    it('keeps a tick when its explicit board is deleted while canonicalisation waits', async () => {
      const boardId = await createSecondUserSharedBoard();
      const tickUuid = uuidv4();
      const deleteReady = createValueBarrier<number>();
      const releaseDelete = createBarrier();
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
      let deletePromise: Promise<void> | undefined;
      let savePromise: ReturnType<typeof tickMutations.saveTick> | undefined;

      try {
        deletePromise = db.transaction(async (transaction) => {
          const [session] = await transaction.execute(sql`SELECT pg_backend_pid() AS pid`);
          await transaction.execute(sql`SELECT id FROM user_boards WHERE id = ${boardId} FOR UPDATE`);
          deleteReady.release(Number((session as { pid: number }).pid));
          await releaseDelete.promise;
          await transaction.execute(sql`UPDATE user_boards SET deleted_at = now() WHERE id = ${boardId}`);
        });
        handleLater(deletePromise);
        const deletePid = await deleteReady.promise;

        savePromise = tickMutations.saveTick(
          undefined,
          { input: baseTickInput({ uuid: tickUuid, boardId }) },
          authCtx(),
        );
        handleLater(savePromise);
        await waitForSessionBlockedBy(deletePid);

        releaseDelete.release();
        await deletePromise;

        const saved = (await savePromise) as { boardId: number | null };
        expect(saved.boardId).toBeNull();

        const [persistedTick] = await db.execute(sql`
          SELECT board_id FROM boardsesh_ticks WHERE uuid = ${tickUuid}
        `);
        expect((persistedTick as { board_id: number | null }).board_id).toBeNull();
        expect(warnSpy).toHaveBeenCalledWith(
          '[saveTick] Board association became unavailable; saving tick without board association',
          expect.objectContaining({
            tickUuid,
            userId: TEST_USER_ID,
            requestedBoardId: boardId,
            boardAssociationSource: 'explicitBoardId',
          }),
        );
      } finally {
        releaseDelete.release();
        await Promise.allSettled([deletePromise, savePromise]);
        warnSpy.mockRestore();
      }
    });

    it('keeps the serial-cluster lock lookup eligible for the active-row partial indexes', async () => {
      const sharedBoardId = await createSecondUserSharedBoard();
      const planRows = await db.transaction(async (transaction) => {
        // Tiny test tables naturally favor a sequential scan. Disabling it
        // makes this a predicate-eligibility assertion: PostgreSQL can only use
        // a partial index when the production query explicitly preserves that
        // index's conditions.
        await transaction.execute(sql`SET LOCAL enable_seqscan = off`);
        return transaction.execute(sql`EXPLAIN (FORMAT TEXT, COSTS OFF) ${buildTickBoardLockQuery(sharedBoardId)}`);
      });
      const plan = planRows.map((row) => String((row as { 'QUERY PLAN': string })['QUERY PLAN'])).join('\n');

      // Deliberately NOT pinned to one index name. #4166 added
      // user_boards_owner_config_idx, and on tables this small the planner picks
      // between it and user_boards_serial_idx on costs that move with whatever
      // rows the rest of the suite has inserted — naming one made this flaky.
      // Every candidate is partial on `deleted_at IS NULL`, so the cluster join
      // can only reach any of them while the query keeps that condition. Drop it
      // and the scan falls back to the primary key and this goes red.
      //
      // The serial nonblank conditions deliberately have no assertion of their
      // own: the same two strings appear in the plan for the `requested_board`
      // side of the join, so a `toContain` on them passes even with the
      // candidate side's copy removed — it would read like coverage and prove
      // nothing.
      expect(plan).toMatch(/Index (Only )?Scan using user_boards_(serial_idx|owner_config_idx|unique_owner_serial)/);
    });

    it('pushes a BoardStatsUpdated event that excludes attempts, resolves grades, and equals the cold fetch', async () => {
      const sharedBoardId = await createSecondUserSharedBoard();

      // A second climber's ATTEMPT on a different (never-sent) climb, at a
      // HARDER difficulty. It must count toward distinctClimbersCount but must
      // NOT inflate climbsSentCount or hardestGrade — that's the status FILTER.
      await db.execute(sql`
        INSERT INTO boardsesh_ticks
          (uuid, user_id, board_type, climb_uuid, angle, is_mirror, status, attempt_count, difficulty, is_benchmark, comment, climbed_at, created_at, updated_at, board_id)
        VALUES
          (${`presence-attempt-${Date.now()}`}, ${SECOND_USER_ID}, 'kilter', ${OTHER_TEST_CLIMB_UUID}, 40, false, 'attempt', 3, 20, false, '', ${new Date().toISOString()}, now(), now(), ${sharedBoardId})
      `);

      const received: BoardPresenceEvent[] = [];
      const unsubscribe = await pubsub.subscribeBoardPresence(String(sharedBoardId), (event) => received.push(event));
      try {
        // TEST_USER logs a real SEND of TEST_CLIMB (difficulty 17 → V5). This
        // commits the tick and queues the debounced board-stats push.
        await tickMutations.saveTick(undefined, { input: baseTickInput({ boardId: sharedBoardId }) }, authCtx());

        // The push is debounced (~2s) then fire-and-forget — poll for it.
        const deadline = Date.now() + 6000;
        while (!received.some((event) => event.__typename === 'BoardStatsUpdated') && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }

        const statsEvent = received.find((event) => event.__typename === 'BoardStatsUpdated') as
          | BoardStatsUpdated
          | undefined;
        expect(statsEvent).toBeDefined();
        // Only the send counts; the attempt is filtered out.
        expect(statsEvent?.stats.climbsSentCount).toBe(1);
        // The attempting climber still counts toward distinct climbers.
        expect(statsEvent?.stats.distinctClimbersCount).toBe(2);
        // Hardest/top grade come from the SEND (V5), not the harder attempt.
        expect(statsEvent?.stats.hardestGrade).toBe('V5');
        expect(statsEvent?.stats.hardestSend).toMatchObject({
          climbUuid: TEST_CLIMB_UUID,
          name: 'Real Catalog Climb',
          grade: 'V5',
          sentByUserId: TEST_USER_ID,
          sentByDisplayName: SENDER_DISPLAY_NAME,
          sentByAvatarUrl: SENDER_AVATAR_URL,
        });
        expect(statsEvent?.stats.hardestSend?.sentAt).toMatch(/T.*Z$/);
        expect(statsEvent?.stats.topGrade).toBe('V5');
        expect(statsEvent?.stats.lastSentAt).not.toBeNull();
        expect(statsEvent?.seq).toBeGreaterThan(0);

        // The push payload must equal the on-demand query — both go through
        // computeBoardPresenceStats, so a future divergence fails here.
        const coldFetch = await boardPresenceQueries.boardPresenceStats(
          undefined,
          { boardId: sharedBoardId },
          authCtx(),
        );
        expect(statsEvent?.stats).toEqual(coldFetch);
      } finally {
        unsubscribe();
      }
    });

    it('collapses a burst of ticks on one board into a single stats push reflecting all of them', async () => {
      // Pins the debounce: concurrent/rapid ticks must not each fire their own
      // recompute+publish (which could pair a stale snapshot with a higher seq
      // and regress the tiles). One trailing push per board, reflecting all.
      const sharedBoardId = await createSecondUserSharedBoard();
      const received: BoardPresenceEvent[] = [];
      const unsubscribe = await pubsub.subscribeBoardPresence(String(sharedBoardId), (event) => received.push(event));
      try {
        await tickMutations.saveTick(
          undefined,
          { input: baseTickInput({ boardId: sharedBoardId, climbUuid: TEST_CLIMB_UUID }) },
          authCtx(),
        );
        await tickMutations.saveTick(
          undefined,
          { input: baseTickInput({ boardId: sharedBoardId, climbUuid: OTHER_TEST_CLIMB_UUID, difficulty: 18 }) },
          authCtx(),
        );

        const deadline = Date.now() + 6000;
        while (!received.some((event) => event.__typename === 'BoardStatsUpdated') && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        // Give any (wrongly) second push time to arrive before asserting one.
        await new Promise((resolve) => setTimeout(resolve, 400));

        const statsEvents = received.filter((event) => event.__typename === 'BoardStatsUpdated');
        expect(statsEvents).toHaveLength(1);
        // The single push reflects BOTH sends, not just the first.
        expect((statsEvents[0] as BoardStatsUpdated).stats.climbsSentCount).toBe(2);
      } finally {
        unsubscribe();
      }
    });

    it('does NOT push board stats from reportBoardClimb (lit-but-not-logged must not move tick-derived stats)', async () => {
      const sharedBoardId = await createSecondUserSharedBoard();
      const received: BoardPresenceEvent[] = [];
      const unsubscribe = await pubsub.subscribeBoardPresence(String(sharedBoardId), (event) => received.push(event));
      try {
        await boardPresenceMutations.reportBoardClimb(
          undefined,
          { boardId: sharedBoardId, climb: makeQueueItemInput(), angle: 40 },
          authCtx({ userId: SECOND_USER_ID }),
        );

        // Give any (erroneous) debounced stats push time to fire.
        await new Promise((resolve) => setTimeout(resolve, 200));

        expect(received.some((event) => event.__typename === 'BoardClimbSet')).toBe(true);
        expect(received.some((event) => event.__typename === 'BoardStatsUpdated')).toBe(false);
        // No tick was written, so the durable stats stay at zero sends.
        const stats = await boardPresenceQueries.boardPresenceStats(undefined, { boardId: sharedBoardId }, authCtx());
        expect(stats.climbsSentCount).toBe(0);
        expect(stats.hardestSend).toBeNull();
      } finally {
        unsubscribe();
      }
    });
  });

  describe('boardPresenceStats', () => {
    it('counts durable sends and climbers for only the requested board', async () => {
      const boardId = await (async () => {
        const resolved = await boardPresenceMutations.resolveBoardForSerial(
          undefined,
          { serial: `STATS-${Date.now()}`, boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2' },
          authCtx(),
        );
        return resolved.boardId;
      })();
      const otherBoard = await boardPresenceMutations.resolveBoardForConfig(
        undefined,
        { boardType: 'kilter', layoutId: 2, sizeId: 20, setIds: '5,6' },
        authCtx(),
      );

      const oldClimbedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
      const recentClimbedAt = new Date().toISOString();
      await db.execute(sql`
        INSERT INTO boardsesh_ticks
          (uuid, user_id, board_type, climb_uuid, angle, is_mirror, status, attempt_count, difficulty, is_benchmark, comment, climbed_at, created_at, updated_at, board_id)
        VALUES
          (${`tick-old-${Date.now()}`}, ${TEST_USER_ID}, 'kilter', ${TEST_CLIMB_UUID}, 40, false, 'send', 1, 17, false, '', ${oldClimbedAt}, now(), now(), ${boardId}),
          (${`tick-attempt-${Date.now()}`}, ${SECOND_USER_ID}, 'kilter', ${OTHER_TEST_CLIMB_UUID}, 40, false, 'attempt', 2, 18, false, '', ${recentClimbedAt}, now(), now(), ${boardId}),
          (${`tick-other-board-${Date.now()}`}, ${TEST_USER_ID}, 'kilter', ${OTHER_TEST_CLIMB_UUID}, 40, false, 'send', 1, 18, false, '', ${recentClimbedAt}, now(), now(), ${otherBoard.boardId})
      `);

      const stats = await boardPresenceQueries.boardPresenceStats(undefined, { boardId }, authCtx());
      expect(stats.climbsSentCount).toBe(1);
      expect(stats.distinctClimbersCount).toBe(2);
      expect(stats.hardestGrade).toBe('V5');
      expect(stats.hardestSend).toMatchObject({
        climbUuid: TEST_CLIMB_UUID,
        name: 'Real Catalog Climb',
        grade: 'V5',
        sentByUserId: TEST_USER_ID,
        sentByDisplayName: SENDER_DISPLAY_NAME,
        sentByAvatarUrl: SENDER_AVATAR_URL,
        sentAt: new Date(oldClimbedAt).toISOString(),
      });
      expect(stats.topGrade).toBe('V5');
      expect(stats.lastSentAt).not.toBeNull();
      // ISO 8601 normalised.
      expect(stats.lastSentAt).toMatch(/T.*Z$/);
    });

    it('uses the first send when multiple climbers share the hardest grade', async () => {
      const resolved = await boardPresenceMutations.resolveBoardForSerial(
        undefined,
        { serial: `TIE-${Date.now()}`, boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2' },
        authCtx(),
      );

      const firstHardestClimbedAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
      const laterHardestClimbedAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      await db.execute(sql`
        INSERT INTO boardsesh_ticks
          (uuid, user_id, board_type, climb_uuid, angle, is_mirror, status, attempt_count, difficulty, is_benchmark, comment, climbed_at, created_at, updated_at, board_id)
        VALUES
          (${`tick-first-hardest-${Date.now()}`}, ${SECOND_USER_ID}, 'kilter', ${OTHER_TEST_CLIMB_UUID}, 40, false, 'send', 1, 18, false, '', ${firstHardestClimbedAt}, now(), now(), ${resolved.boardId}),
          (${`tick-later-hardest-${Date.now()}`}, ${TEST_USER_ID}, 'kilter', ${TEST_CLIMB_UUID}, 40, false, 'flash', 1, 18, false, '', ${laterHardestClimbedAt}, now(), now(), ${resolved.boardId})
      `);

      const stats = await boardPresenceQueries.boardPresenceStats(undefined, { boardId: resolved.boardId }, authCtx());
      expect(stats.hardestGrade).toBe('V6');
      expect(stats.hardestSend).toMatchObject({
        climbUuid: OTHER_TEST_CLIMB_UUID,
        name: 'Other Catalog Climb',
        grade: 'V6',
        sentByUserId: SECOND_USER_ID,
        sentByDisplayName: 'Second Sender',
        sentByAvatarUrl: null,
        sentAt: new Date(firstHardestClimbedAt).toISOString(),
      });
    });

    it('resolves aliased climb UUIDs before hardest-send name and consensus grade joins', async () => {
      const resolved = await boardPresenceMutations.resolveBoardForSerial(
        undefined,
        { serial: `ALIAS-${Date.now()}`, boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2' },
        authCtx(),
      );

      const climbedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      await db.execute(sql`
        INSERT INTO boardsesh_ticks
          (uuid, user_id, board_type, climb_uuid, angle, is_mirror, status, attempt_count, difficulty, is_benchmark, comment, climbed_at, created_at, updated_at, board_id)
        VALUES
          (${`tick-alias-hardest-${Date.now()}`}, ${TEST_USER_ID}, 'kilter', ${ALIAS_TEST_CLIMB_UUID}, 40, false, 'send', 1, NULL, false, '', ${climbedAt}, now(), now(), ${resolved.boardId})
      `);

      const stats = await boardPresenceQueries.boardPresenceStats(undefined, { boardId: resolved.boardId }, authCtx());
      expect(stats.climbsSentCount).toBe(1);
      expect(stats.hardestGrade).toBe('V5');
      expect(stats.topGrade).toBe('V5');
      expect(stats.hardestSend).toMatchObject({
        climbUuid: TEST_CLIMB_UUID,
        name: 'Real Catalog Climb',
        grade: 'V5',
        sentByUserId: TEST_USER_ID,
        sentByDisplayName: SENDER_DISPLAY_NAME,
        sentByAvatarUrl: SENDER_AVATAR_URL,
        sentAt: new Date(climbedAt).toISOString(),
      });
    });

    it('returns zeroes for a board with no ticks', async () => {
      const resolved = await boardPresenceMutations.resolveBoardForConfig(
        undefined,
        { boardType: 'kilter', layoutId: 3, sizeId: 30, setIds: '7,8' },
        authCtx(),
      );
      const stats = await boardPresenceQueries.boardPresenceStats(undefined, { boardId: resolved.boardId }, authCtx());
      expect(stats.climbsSentCount).toBe(0);
      expect(stats.distinctClimbersCount).toBe(0);
      expect(stats.hardestGrade).toBeNull();
      expect(stats.hardestSend).toBeNull();
      expect(stats.topGrade).toBeNull();
      expect(stats.lastSentAt).toBeNull();
    });

    it('rejects stats for a missing board instead of querying arbitrary ids', async () => {
      await expect(boardPresenceQueries.boardPresenceStats(undefined, { boardId: 999_999 }, authCtx())).rejects.toThrow(
        'Board not found',
      );
    });
  });
});

// ============================================================
// Durable history + 60s dwell gate (Redis + DB)
// ============================================================
describe('board-presence durable history (board_climb_events)', () => {
  beforeEach(async () => {
    await cleanup();
    await seedUser();
    await seedCatalogClimb();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanup();
  });

  async function resolveBoardId(serial: string): Promise<number> {
    const resolved = await boardPresenceMutations.resolveBoardForSerial(
      undefined,
      { serial, boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2' },
      authCtx(),
    );
    return resolved.boardId;
  }

  async function countEvents(boardId: number): Promise<number> {
    const [row] = await db.execute(
      sql`SELECT count(*)::int AS count FROM board_climb_events WHERE board_id = ${boardId}`,
    );
    return Number((row as { count: number }).count);
  }

  it('does not persist a send before the 60s dwell gate, but still accepts the live report', async () => {
    const boardId = await resolveBoardId(`DWELL-A-${Date.now()}`);
    // First-seen = now → < 60s dwell → no durable persist.
    vi.spyOn(pubsub, 'getBoardReportGate').mockResolvedValue({
      isMember: true,
      firstSeenMs: Date.now(),
      lastReport: null,
      currentWriter: null,
    });
    const accepted = await boardPresenceMutations.reportBoardClimb(
      undefined,
      { boardId, climb: makeQueueItemInput(), angle: 40 },
      authCtx(),
    );
    expect(accepted).toBe(true);
    expect(await countEvents(boardId)).toBe(0);
  });

  it('drops a send when first-seen is unknown (fail-closed)', async () => {
    const boardId = await resolveBoardId(`DWELL-C-${Date.now()}`);
    vi.spyOn(pubsub, 'getBoardReportGate').mockResolvedValue({
      isMember: true,
      firstSeenMs: null,
      lastReport: null,
      currentWriter: null,
    });
    await boardPresenceMutations.reportBoardClimb(
      undefined,
      { boardId, climb: makeQueueItemInput(), angle: 40 },
      authCtx(),
    );
    expect(await countEvents(boardId)).toBe(0);
  });

  it('persists once the member has >= 60s of presence, and boardHistory returns it', async () => {
    const boardId = await resolveBoardId(`DWELL-B-${Date.now()}`);
    // Simulate sustained presence: first-seen 2 minutes ago → dwell met.
    vi.spyOn(pubsub, 'getBoardReportGate').mockResolvedValue({
      isMember: true,
      firstSeenMs: Date.now() - 120_000,
      lastReport: null,
      currentWriter: null,
    });

    const accepted = await boardPresenceMutations.reportBoardClimb(
      undefined,
      { boardId, climb: makeQueueItemInput(), angle: 40 },
      authCtx(),
    );
    expect(accepted).toBe(true);
    expect(await countEvents(boardId)).toBe(1);

    const history = await boardPresenceQueries.boardHistory(undefined, { boardId }, authCtx());
    expect(history).toHaveLength(1);
    expect(history[0].climbUuid).toBe(TEST_CLIMB_UUID);
    expect(history[0].name).toBe('Real Catalog Climb');
    expect(history[0].sentAt).toBeTruthy();
  });

  it('keyset-paginates by seq with no repeats or skips when sends share a confirmedAt', async () => {
    const boardId = await resolveBoardId(`PAGE-${Date.now()}`);
    // Five rows at the SAME confirmed_at second with distinct monotonic seq —
    // exactly the case a confirmedAt-only cursor would repeat or skip across
    // pages.
    const sameTs = '2026-01-01 00:00:00';
    for (const seq of [10, 11, 12, 13, 14]) {
      await db.execute(
        sql`INSERT INTO board_climb_events (board_id, board_type, climb_uuid, angle, seq, confirmed_at)
            VALUES (${boardId}, 'kilter', ${TEST_CLIMB_UUID}, 40, ${seq}, ${sameTs})`,
      );
    }

    const page1 = await boardPresenceQueries.boardHistory(undefined, { boardId, limit: 3 }, authCtx());
    expect(page1.map((row) => row.seq)).toEqual([14, 13, 12]);

    const cursor = String(page1[page1.length - 1].seq);
    const page2 = await boardPresenceQueries.boardHistory(undefined, { boardId, limit: 3, before: cursor }, authCtx());
    expect(page2.map((row) => row.seq)).toEqual([11, 10]);

    // Every row appears exactly once across the two pages.
    const seen = [...page1, ...page2].map((row) => row.seq);
    expect(seen).toEqual([14, 13, 12, 11, 10]);
    expect(new Set(seen).size).toBe(5);
  });

  it('rejects a malformed history cursor with a BAD_USER_INPUT GraphQLError, not a leaked DB error', async () => {
    const boardId = await resolveBoardId(`BADCUR-${Date.now()}`);
    // Capture the throw so we can assert the *extension code* — that's what
    // graphql-js serialises into errors[].extensions.code over the wire, so
    // confirming it here confirms BAD_USER_INPUT (not a raw Postgres error)
    // reaches the client.
    const error = await boardPresenceQueries
      .boardHistory(undefined, { boardId, before: 'not-a-cursor' }, authCtx())
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(GraphQLError);
    expect((error as GraphQLError).extensions?.code).toBe('BAD_USER_INPUT');
  });

  it('treats a whitespace-only cursor as no cursor (first page), never a silently empty page', async () => {
    const boardId = await resolveBoardId(`WS-${Date.now()}`);
    for (const seq of [1, 2]) {
      await db.execute(
        sql`INSERT INTO board_climb_events (board_id, board_type, climb_uuid, angle, seq, confirmed_at)
            VALUES (${boardId}, 'kilter', ${TEST_CLIMB_UUID}, 40, ${seq}, '2026-01-01 00:00:00')`,
      );
    }
    // Number(' ') is 0, so without the trim guard this returned an empty page.
    const page = await boardPresenceQueries.boardHistory(undefined, { boardId, before: '   ' }, authCtx());
    expect(page.map((row) => row.seq)).toEqual([2, 1]);
  });
});

// ============================================================
// Connection holder ("who's connected" / "writing to the wall")
// Appended at the END so it never perturbs the timing-sensitive concurrent
// config-create test earlier in the file.
// ============================================================
describe('board-presence connection holder', () => {
  beforeEach(async () => {
    await cleanup();
    await seedUser();
    await seedCatalogClimb();
  });

  afterEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
  });

  let holderSerialCounter = 0;
  async function makeHolderBoard(ctx: ConnectionContext = authCtx()): Promise<number> {
    const serial = `HOLD-${Date.now().toString(36)}-${holderSerialCounter++}`;
    const resolved = await boardPresenceMutations.resolveBoardForSerial(
      undefined,
      { serial, boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2' },
      ctx,
    );
    return resolved.boardId;
  }

  it('reportBoardDisconnect returns false (no throw) for a valid but unheld board', async () => {
    // No holder set → atomic compare-and-delete is a no-op; the mutation must
    // resolve false, not error.
    const result = await boardPresenceMutations.reportBoardDisconnect(undefined, { boardId: 999_999_999 }, authCtx());
    expect(result).toBe(false);
  });

  // Anonymous read-access gate (pure DB reachability check — no Redis needed).
  describe('anonymous read access', () => {
    const anon = () => authCtx({ isAuthenticated: false, userId: undefined });

    async function makePrivateBoard(): Promise<number> {
      const slug = `private-${Date.now().toString(36)}-${holderSerialCounter++}`;
      const [row] = await db
        .insert(dbSchema.userBoards)
        .values({
          uuid: `uuid-${slug}`,
          slug,
          ownerId: TEST_USER_ID,
          boardType: 'kilter',
          layoutId: 1,
          sizeId: 10,
          setIds: '1,2',
          name: 'Private Wall',
          serialNumber: null,
          isPublic: false,
        })
        .returning({ id: dbSchema.userBoards.id });
      return Number(row.id);
    }

    it("hides a private board's live feed from anonymous viewers but not logged-in ones", async () => {
      const boardId = await makePrivateBoard();

      await expect(boardPresenceQueries.boardConnection(undefined, { boardId }, anon())).rejects.toThrow(
        'Board not found',
      );
      await expect(boardPresenceQueries.boardRecentClimbs(undefined, { boardId }, anon())).rejects.toThrow(
        'Board not found',
      );
      const iterator = boardPresenceSubscriptions.boardNowPlaying.subscribe(undefined, { boardId }, anon());
      await expect(iterator.next()).rejects.toThrow('Board not found');
      await iterator.return?.(undefined);

      // A logged-in viewer still reads it (the feed is membership-free for them).
      await expect(boardPresenceQueries.boardConnection(undefined, { boardId }, authCtx())).resolves.toBeNull();
    });

    it('lets anonymous viewers read a shared system per-config board', async () => {
      const config = { boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2' };
      // A logged-in user creates the shared feed; anon may then read it.
      const resolved = await boardPresenceMutations.resolveBoardForConfig(undefined, config, authCtx());
      await expect(
        boardPresenceQueries.boardConnection(undefined, { boardId: resolved.boardId }, anon()),
      ).resolves.toBeNull();
      await expect(
        boardPresenceQueries.boardRecentClimbs(undefined, { boardId: resolved.boardId }, anon()),
      ).resolves.toEqual([]);
    });

    it('refuses to mint a shared board for an anonymous caller (bind-only)', async () => {
      // Anon can't create-on-miss; a brand-new config has no board to bind.
      await expect(
        boardPresenceMutations.resolveBoardForConfig(
          undefined,
          { boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '7,8' },
          anon(),
        ),
      ).rejects.toThrow('Board not found');
    });

    it("lets anonymous viewers read a public board's durable history and stats (kiosk path)", async () => {
      // Serial-resolved boards default to isPublic = true.
      const boardId = await makeHolderBoard();
      await db.execute(
        sql`INSERT INTO board_climb_events (board_id, board_type, climb_uuid, angle, seq, confirmed_at)
            VALUES (${boardId}, 'kilter', ${TEST_CLIMB_UUID}, 40, 1, '2026-01-01 00:00:00')`,
      );

      const history = await boardPresenceQueries.boardHistory(undefined, { boardId }, anon());
      expect(history.map((row) => row.climbUuid)).toEqual([TEST_CLIMB_UUID]);

      const stats = await boardPresenceQueries.boardPresenceStats(undefined, { boardId }, anon());
      expect(stats.climbsSentCount).toBe(0);
      expect(stats.distinctClimbersCount).toBe(0);

      await expect(
        boardPresenceQueries.boardClimbRecentSenders(
          undefined,
          { boardId, climbUuid: TEST_CLIMB_UUID, angle: 40 },
          anon(),
        ),
      ).resolves.toEqual([]);
    });

    it("masks a private board's history and stats as NOT_FOUND for anonymous viewers, identical to a missing board", async () => {
      const boardId = await makePrivateBoard();
      const missingBoardId = 999_999_999;

      for (const query of [
        (id: number) => boardPresenceQueries.boardHistory(undefined, { boardId: id }, anon()),
        (id: number) => boardPresenceQueries.boardPresenceStats(undefined, { boardId: id }, anon()),
        (id: number) =>
          boardPresenceQueries.boardClimbRecentSenders(
            undefined,
            { boardId: id, climbUuid: TEST_CLIMB_UUID, angle: 40 },
            anon(),
          ),
      ]) {
        const privateError = await query(boardId).then(
          () => null,
          (caught: unknown) => caught,
        );
        const missingError = await query(missingBoardId).then(
          () => null,
          (caught: unknown) => caught,
        );

        // A private board (masked) and a genuinely missing board must be
        // indistinguishable on the wire: identical message AND identical
        // extensions.code — otherwise an anonymous caller can use the error
        // shape as an existence oracle.
        expect(privateError).toBeInstanceOf(GraphQLError);
        expect(missingError).toBeInstanceOf(GraphQLError);
        expect((privateError as GraphQLError).message).toBe('Board not found');
        expect((missingError as GraphQLError).message).toBe('Board not found');
        expect((privateError as GraphQLError).extensions?.code).toBe('NOT_FOUND');
        expect((missingError as GraphQLError).extensions?.code).toBe('NOT_FOUND');
      }
    });

    it("keeps authenticated access to the caller's own private board's history and stats", async () => {
      const boardId = await makePrivateBoard();

      await expect(boardPresenceQueries.boardHistory(undefined, { boardId }, authCtx())).resolves.toEqual([]);
      const stats = await boardPresenceQueries.boardPresenceStats(undefined, { boardId }, authCtx());
      expect(stats.climbsSentCount).toBe(0);
      await expect(
        boardPresenceQueries.boardClimbRecentSenders(
          undefined,
          { boardId, climbUuid: TEST_CLIMB_UUID, angle: 40 },
          authCtx(),
        ),
      ).resolves.toEqual([]);
    });
  });

  describe('boardLeaderboard anon gate + day period', () => {
    const anon = () => authCtx({ isAuthenticated: false, userId: undefined });
    let leaderboardSlugCounter = 0;

    async function makeLeaderboardBoard(isPublic: boolean): Promise<{ boardId: number; boardUuid: string }> {
      const boardUuid = uuidv4();
      const slug = `lb-${Date.now().toString(36)}-${leaderboardSlugCounter++}`;
      const [row] = await db
        .insert(dbSchema.userBoards)
        .values({
          uuid: boardUuid,
          slug,
          ownerId: TEST_USER_ID,
          boardType: 'kilter',
          layoutId: 1,
          sizeId: 10,
          setIds: '1,2',
          name: 'Leaderboard Wall',
          serialNumber: null,
          isPublic,
        })
        .returning({ id: dbSchema.userBoards.id });
      return { boardId: Number(row.id), boardUuid };
    }

    it("scopes the 'day' period to the last 24h (labelled Today) and works anonymously on a public board", async () => {
      const { boardId, boardUuid } = await makeLeaderboardBoard(true);
      const recentClimbedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const staleClimbedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
      await db.execute(sql`
        INSERT INTO boardsesh_ticks
          (uuid, user_id, board_type, climb_uuid, angle, is_mirror, status, attempt_count, difficulty, is_benchmark, comment, climbed_at, created_at, updated_at, board_id)
        VALUES
          (${`tick-day-recent-${Date.now()}`}, ${TEST_USER_ID}, 'kilter', ${TEST_CLIMB_UUID}, 40, false, 'send', 1, 17, false, '', ${recentClimbedAt}, now(), now(), ${boardId}),
          (${`tick-day-stale-${Date.now()}`}, ${SECOND_USER_ID}, 'kilter', ${OTHER_TEST_CLIMB_UUID}, 40, false, 'send', 1, 18, false, '', ${staleClimbedAt}, now(), now(), ${boardId})
      `);

      const dayBoard = await socialBoardQueries.boardLeaderboard(
        undefined,
        { input: { boardUuid, period: 'day' } },
        anon(),
      );
      expect(dayBoard.periodLabel).toBe('Today');
      expect(dayBoard.totalCount).toBe(1);
      expect(dayBoard.entries.map((entry) => entry.userId)).toEqual([TEST_USER_ID]);

      // The default all-time window still sees both senders.
      const allTime = await socialBoardQueries.boardLeaderboard(undefined, { input: { boardUuid } }, anon());
      expect(allTime.totalCount).toBe(2);
    });

    it("masks a private board's leaderboard as NOT_FOUND for anonymous callers, identical to a missing board, but still serves its owner", async () => {
      const { boardUuid } = await makeLeaderboardBoard(false);
      const missingBoardUuid = uuidv4();

      const privateError = await socialBoardQueries.boardLeaderboard(undefined, { input: { boardUuid } }, anon()).then(
        () => null,
        (caught: unknown) => caught,
      );
      const missingError = await socialBoardQueries
        .boardLeaderboard(undefined, { input: { boardUuid: missingBoardUuid } }, anon())
        .then(
          () => null,
          (caught: unknown) => caught,
        );

      // A private board (masked) and a genuinely missing board must be
      // indistinguishable on the wire: identical message AND identical
      // extensions.code — otherwise an anonymous caller can use the error
      // shape as an existence oracle.
      expect(privateError).toBeInstanceOf(GraphQLError);
      expect(missingError).toBeInstanceOf(GraphQLError);
      expect((privateError as GraphQLError).message).toBe('Board not found');
      expect((missingError as GraphQLError).message).toBe('Board not found');
      expect((privateError as GraphQLError).extensions?.code).toBe('NOT_FOUND');
      expect((missingError as GraphQLError).extensions?.code).toBe('NOT_FOUND');

      const owned = await socialBoardQueries.boardLeaderboard(undefined, { input: { boardUuid } }, authCtx());
      expect(owned.entries).toEqual([]);
      expect(owned.totalCount).toBe(0);
    });
  });

  // Per-connection backstop bookkeeping is pure in-memory roomManager state, so
  // these run without Redis.
  describe('crash backstop bookkeeping', () => {
    it('records the holding connection and is a safe no-op when nothing was held', async () => {
      const connectionId = `conn-backstop-${Date.now()}`;
      await roomManager.registerClient(connectionId);
      try {
        // A disconnect with no recorded hold must not throw or broadcast.
        await expect(roomManager.clearBoardWriterForConnection(connectionId)).resolves.toBeUndefined();

        roomManager.noteBoardWriter(connectionId, 4242, TEST_USER_ID);
        expect(roomManager.getClient(connectionId)?.boardWriterEmitter).toEqual({
          boardId: 4242,
          emitterId: TEST_USER_ID,
        });
      } finally {
        await roomManager.removeClient(connectionId);
      }
    });
  });

  // The holder lives in Redis (the commitBoardClimb writer take and
  // clearBoardWriterIf are Redis-only). pubsub connects only when REDIS_URL is
  // configured (CI sets it); skip cleanly otherwise, mirroring the
  // FIFO-history test above.
  describe('holder state + hand-off (Redis)', () => {
    let redisOn = false;
    beforeAll(async () => {
      await pubsub.initialize().catch(() => {});
      redisOn = pubsub.isRedisConnected();
      if (!redisOn) {
        console.warn('[board-presence] pubsub Redis unavailable — skipping holder integration tests');
      }
    });

    afterAll(async () => {
      if (redisOn) await redisClientManager.disconnect().catch(() => {});
    });

    it('hands off to a new emitter and dedups same-emitter repeats', async () => {
      if (!redisOn) return;
      const boardId = await makeHolderBoard(authCtx());
      await pubsub.stampBoardMembership(String(boardId), SECOND_USER_ID);

      const changes: BoardConnectionChanged[] = [];
      const unsubscribe = await pubsub.subscribeBoardPresence(String(boardId), (event) => {
        if (event.__typename === 'BoardConnectionChanged') changes.push(event);
      });

      // First send takes the free board → one hand-off.
      await boardPresenceMutations.reportBoardClimb(
        undefined,
        { boardId, climb: makeQueueItemInput(), angle: 40 },
        authCtx(),
      );
      // Same emitter again → no re-broadcast.
      await boardPresenceMutations.reportBoardClimb(
        undefined,
        { boardId, climb: makeQueueItemInput(), angle: 40 },
        authCtx(),
      );
      expect(changes).toHaveLength(1);
      // The broadcast carries the server-derived holder identity.
      expect(changes[0].holder?.userId).toBe(TEST_USER_ID);
      expect(changes[0].holder?.displayName).toBe(SENDER_DISPLAY_NAME);
      expect(changes[0].holder?.lastSentAt).toBeTruthy();
      expect(await pubsub.getBoardWriter(String(boardId))).toBe(TEST_USER_ID);

      // A different emitter takes over (always-take) → second hand-off.
      await boardPresenceMutations.reportBoardClimb(
        undefined,
        { boardId, climb: makeQueueItemInput(), angle: 40 },
        authCtx({ userId: SECOND_USER_ID }),
      );
      expect(changes).toHaveLength(2);
      expect(changes[1].holder?.userId).toBe(SECOND_USER_ID);
      expect(await pubsub.getBoardWriter(String(boardId))).toBe(SECOND_USER_ID);

      unsubscribe();
    });

    it('boardConnection reflects the current holder, null once cleared', async () => {
      if (!redisOn) return;
      const boardId = await makeHolderBoard(authCtx());
      await boardPresenceMutations.reportBoardClimb(
        undefined,
        { boardId, climb: makeQueueItemInput(), angle: 40 },
        authCtx(),
      );

      const holder = await boardPresenceQueries.boardConnection(undefined, { boardId }, authCtx());
      expect(holder?.userId).toBe(TEST_USER_ID);
      // The newest climb was sent by this holder, so their display identity is
      // adopted from it (rather than nulled as it would be for a mismatched sender).
      expect(holder?.displayName).toBe(SENDER_DISPLAY_NAME);

      expect(await boardPresenceMutations.reportBoardDisconnect(undefined, { boardId }, authCtx())).toBe(true);
      expect(await boardPresenceQueries.boardConnection(undefined, { boardId }, authCtx())).toBeNull();
    });

    it('reportBoardDisconnect only clears when the caller still holds the board', async () => {
      if (!redisOn) return;
      const boardId = await makeHolderBoard(authCtx());
      await pubsub.stampBoardMembership(String(boardId), SECOND_USER_ID);
      await boardPresenceMutations.reportBoardClimb(
        undefined,
        { boardId, climb: makeQueueItemInput(), angle: 40 },
        authCtx(),
      );

      // A non-holder's disconnect is a no-op (atomic compare-and-delete).
      expect(
        await boardPresenceMutations.reportBoardDisconnect(undefined, { boardId }, authCtx({ userId: SECOND_USER_ID })),
      ).toBe(false);
      expect(await pubsub.getBoardWriter(String(boardId))).toBe(TEST_USER_ID);

      // The holder's disconnect frees it and broadcasts holder: null.
      const changes: BoardConnectionChanged[] = [];
      const unsubscribe = await pubsub.subscribeBoardPresence(String(boardId), (event) => {
        if (event.__typename === 'BoardConnectionChanged') changes.push(event);
      });
      expect(await boardPresenceMutations.reportBoardDisconnect(undefined, { boardId }, authCtx())).toBe(true);
      expect(await pubsub.getBoardWriter(String(boardId))).toBeNull();
      expect(changes).toHaveLength(1);
      expect(changes[0].holder).toBeNull();
      unsubscribe();
    });

    it('crash backstop frees the wall on the holder connection drop, not another connection', async () => {
      if (!redisOn) return;
      const boardId = await makeHolderBoard(authCtx());
      const holderConnectionId = `conn-holder-${Date.now()}`;
      const otherConnectionId = `conn-other-${Date.now()}`;
      await roomManager.registerClient(holderConnectionId, undefined, TEST_USER_ID);
      await roomManager.registerClient(otherConnectionId, undefined, TEST_USER_ID);
      try {
        // Report from the holder connection so noteBoardWriter records the hold.
        await boardPresenceMutations.reportBoardClimb(
          undefined,
          { boardId, climb: makeQueueItemInput(), angle: 40 },
          authCtx({ connectionId: holderConnectionId }),
        );
        expect(await pubsub.getBoardWriter(String(boardId))).toBe(TEST_USER_ID);

        // A non-holder connection dropping does nothing.
        await roomManager.clearBoardWriterForConnection(otherConnectionId);
        expect(await pubsub.getBoardWriter(String(boardId))).toBe(TEST_USER_ID);

        // The holder connection dropping frees the wall + broadcasts holder: null.
        const changes: BoardConnectionChanged[] = [];
        const unsubscribe = await pubsub.subscribeBoardPresence(String(boardId), (event) => {
          if (event.__typename === 'BoardConnectionChanged') changes.push(event);
        });
        await roomManager.clearBoardWriterForConnection(holderConnectionId);
        expect(await pubsub.getBoardWriter(String(boardId))).toBeNull();
        expect(changes).toHaveLength(1);
        expect(changes[0].holder).toBeNull();
        unsubscribe();
      } finally {
        await roomManager.removeClient(holderConnectionId);
        await roomManager.removeClient(otherConnectionId);
      }
    });
  });
});

// ============================================================
// PR A perf work: pipelined commit (A1), write-side idempotency (A2), seq
// continuity across dormancy (A3), stats cache (A4). Appended at the END —
// never disturb the timing-racy concurrent-config-create test earlier in the
// file (the only permitted mid-file edit was retargeting the three dwell-gate
// spies above from getBoardMembershipFirstSeen to getBoardReportGate).
//
// These describes reconnect `redisClientManager` directly rather than via
// `pubsub.initialize()`: that call is a one-time no-op once the "holder state
// + hand-off" describe above already initialized pubsub, and that describe's
// own afterAll disconnects redisClientManager — so exercising the real Redis
// paths again here needs an explicit reconnect.
// ============================================================

async function ensureRedisConnectedForTest(): Promise<boolean> {
  if (redisClientManager.isRedisConnected()) return true;
  try {
    return await redisClientManager.connect();
  } catch {
    return false;
  }
}

/**
 * Overwrites the NX-guarded first-seen stamp that resolveBoardForSerial /
 * stampBoardMembership already wrote, so the *real* getBoardReportGate
 * pipeline reads a "dwell met" value below — exercising the production read
 * path end-to-end instead of mocking around it.
 */
async function stampSustainedFirstSeen(redis: Redis, boardId: number, userId: string, msAgo = 120_000): Promise<void> {
  await redis.set(`presence:board:${boardId}:user:${userId}`, String(Date.now() - msAgo), 'EX', 43_200);
}

describe('board-presence pipelined commit (Redis)', () => {
  let redisOn = false;
  let testRedis: Redis | null = null;
  const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6380';

  beforeAll(async () => {
    redisOn = await ensureRedisConnectedForTest();
    if (!redisOn) {
      console.warn('[board-presence] Redis unavailable — skipping pipelined-commit tests');
      return;
    }
    testRedis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await testRedis.connect();
  });

  afterAll(async () => {
    if (testRedis) await testRedis.quit().catch(() => {});
  });

  beforeEach(async () => {
    await cleanup();
    await seedUser();
    await seedCatalogClimb();
  });

  afterEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
  });

  let pipelineSerialCounter = 0;
  async function makePipelineBoard(ctx: ConnectionContext = authCtx()): Promise<number> {
    const serial = `PIPE-${Date.now().toString(36)}-${pipelineSerialCounter++}`;
    const resolved = await boardPresenceMutations.resolveBoardForSerial(
      undefined,
      { serial, boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2' },
      ctx,
    );
    return resolved.boardId;
  }

  it('one report populates the history list and the writer key, both with a live TTL', async () => {
    if (!redisOn || !testRedis) return;
    const boardId = await makePipelineBoard();

    await boardPresenceMutations.reportBoardClimb(
      undefined,
      { boardId, climb: makeQueueItemInput(), angle: 40 },
      authCtx(),
    );

    const historyKey = `board:${boardId}:history`;
    const writerKey = `board:${boardId}:writer`;
    const [historyEntries, writerValue, historyTtl, writerTtl] = await Promise.all([
      testRedis.lrange(historyKey, 0, -1),
      testRedis.get(writerKey),
      testRedis.pttl(historyKey),
      testRedis.pttl(writerKey),
    ]);

    expect(historyEntries).toHaveLength(1);
    expect((JSON.parse(historyEntries[0]) as BoardPresenceClimb).climbUuid).toBe(TEST_CLIMB_UUID);
    expect(writerValue).toBe(TEST_USER_ID);
    expect(historyTtl).toBeGreaterThan(0);
    expect(writerTtl).toBeGreaterThan(0);
  });
});

describe('board-presence write-side idempotency (Redis)', () => {
  let redisOn = false;
  let testRedis: Redis | null = null;
  const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6380';

  beforeAll(async () => {
    redisOn = await ensureRedisConnectedForTest();
    if (!redisOn) {
      console.warn('[board-presence] Redis unavailable — skipping write-side idempotency tests');
      return;
    }
    testRedis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await testRedis.connect();
  });

  afterAll(async () => {
    if (testRedis) await testRedis.quit().catch(() => {});
  });

  beforeEach(async () => {
    await cleanup();
    await seedUser();
    await seedCatalogClimb();
  });

  afterEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
  });

  let idemSerialCounter = 0;
  async function makeIdemBoard(ctx: ConnectionContext = authCtx()): Promise<number> {
    const serial = `IDEM-${Date.now().toString(36)}-${idemSerialCounter++}`;
    const resolved = await boardPresenceMutations.resolveBoardForSerial(
      undefined,
      { serial, boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2' },
      ctx,
    );
    return resolved.boardId;
  }

  async function countEvents(boardId: number): Promise<number> {
    const [row] = await db.execute(
      sql`SELECT count(*)::int AS count FROM board_climb_events WHERE board_id = ${boardId}`,
    );
    return Number((row as { count: number }).count);
  }

  // These tests verify through directly-observable state (the Redis FIFO
  // history list, the writer key, and durable Postgres rows) rather than by
  // subscribing to pubsub.subscribeBoardPresence: this file's earlier "holder
  // state + hand-off (Redis)" describe already disconnected redisClientManager
  // in its own afterAll (a describe we may not touch), which leaves pubsub's
  // internal Redis *subscriber* connection permanently closed for the rest of
  // this file — a test-harness artifact of reconnecting the publisher-side
  // client directly, not a production concern (ioredis reconnects live
  // clients automatically; only the test teardown calls `.quit()`). Every
  // write path exercised below (INCR/SET/EVAL/pipelines) goes through the
  // publisher client, which IS healthy after `ensureRedisConnectedForTest`.

  it('collapses an exact retry (same user/climb/angle) into a no-op: one history entry, one durable row, seq consumed once', async () => {
    if (!redisOn || !testRedis) return;
    const boardId = await makeIdemBoard();
    await stampSustainedFirstSeen(testRedis, boardId, TEST_USER_ID);

    const firstAccepted = await boardPresenceMutations.reportBoardClimb(
      undefined,
      { boardId, climb: makeQueueItemInput(), angle: 40 },
      authCtx(),
    );
    const seqAfterFirst = await testRedis.get(`board:${boardId}:seq`);

    const secondAccepted = await boardPresenceMutations.reportBoardClimb(
      undefined,
      { boardId, climb: makeQueueItemInput(), angle: 40 },
      authCtx(),
    );
    const seqAfterSecond = await testRedis.get(`board:${boardId}:seq`);

    expect(firstAccepted).toBe(true);
    expect(secondAccepted).toBe(true);
    const history = await testRedis.lrange(`board:${boardId}:history`, 0, -1);
    expect(history).toHaveLength(1);
    expect(await countEvents(boardId)).toBe(1);
    // The dedup path returns before allocating a seq, so the counter is unchanged.
    expect(seqAfterSecond).toBe(seqAfterFirst);
  });

  it('does not suppress a different climb, angle, or user (and a user change still hands off the writer)', async () => {
    if (!redisOn || !testRedis) return;
    const boardId = await makeIdemBoard();
    await pubsub.stampBoardMembership(String(boardId), SECOND_USER_ID);
    const writerKey = `board:${boardId}:writer`;

    expect(await testRedis.get(writerKey)).toBeNull();

    await boardPresenceMutations.reportBoardClimb(
      undefined,
      { boardId, climb: makeQueueItemInput(), angle: 40 },
      authCtx(),
    );
    expect(await testRedis.get(writerKey)).toBe(TEST_USER_ID);

    // Different climb, same user/angle.
    await boardPresenceMutations.reportBoardClimb(
      undefined,
      { boardId, climb: makeQueueItemInput({ uuid: OTHER_TEST_CLIMB_UUID }), angle: 40 },
      authCtx(),
    );
    // Different angle, back to the first climb.
    await boardPresenceMutations.reportBoardClimb(
      undefined,
      { boardId, climb: makeQueueItemInput(), angle: 45 },
      authCtx(),
    );
    // Different user, same climb/angle as the previous send — a hand-off.
    await boardPresenceMutations.reportBoardClimb(
      undefined,
      { boardId, climb: makeQueueItemInput(), angle: 45 },
      authCtx({ userId: SECOND_USER_ID }),
    );

    // None of the four sends were deduped — one FIFO entry each.
    const history = await testRedis.lrange(`board:${boardId}:history`, 0, -1);
    expect(history).toHaveLength(4);
    expect(await testRedis.get(writerKey)).toBe(SECOND_USER_ID);
  });

  it('re-accepts a retry once the dedup window has expired', async () => {
    if (!redisOn || !testRedis) return;
    const boardId = await makeIdemBoard();

    await boardPresenceMutations.reportBoardClimb(
      undefined,
      { boardId, climb: makeQueueItemInput(), angle: 40 },
      authCtx(),
    );
    // Force the dedup marker to expire immediately instead of waiting out the real 10s window.
    await testRedis.pexpire(`board:${boardId}:lastReport`, 1);
    await new Promise((resolve) => setTimeout(resolve, 25));

    const secondAccepted = await boardPresenceMutations.reportBoardClimb(
      undefined,
      { boardId, climb: makeQueueItemInput(), angle: 40 },
      authCtx(),
    );

    expect(secondAccepted).toBe(true);
    const history = await testRedis.lrange(`board:${boardId}:history`, 0, -1);
    expect(history).toHaveLength(2);
  });

  it('falls through (re-takes the writer) when the wall was freed between the send and its retry', async () => {
    if (!redisOn || !testRedis) return;
    // The canonical A2 retry cause is a socket drop right after the send — and
    // that same drop fires the WS-close backstop, which DELETEs the writer key
    // and broadcasts holder:null while the 10s lastReport marker survives. The
    // retry must NOT short-circuit then: it has to re-take the writer (and so
    // re-broadcast the hand-off), or every watcher shows the wall free while
    // this emitter holds it. The accepted cost is a duplicate history/durable
    // row with a fresh seq — holder correctness over row dedup.
    const boardId = await makeIdemBoard();
    await stampSustainedFirstSeen(testRedis, boardId, TEST_USER_ID);
    const writerKey = `board:${boardId}:writer`;

    await boardPresenceMutations.reportBoardClimb(
      undefined,
      { boardId, climb: makeQueueItemInput(), angle: 40 },
      authCtx(),
    );
    expect(await testRedis.get(writerKey)).toBe(TEST_USER_ID);
    expect(await countEvents(boardId)).toBe(1);

    // Simulate the WS-close backstop: the writer key is cleared, lastReport isn't.
    await testRedis.del(writerKey);
    expect(await testRedis.get(`board:${boardId}:lastReport`)).not.toBeNull();

    // Identical retry, well inside the dedup window.
    const retryAccepted = await boardPresenceMutations.reportBoardClimb(
      undefined,
      { boardId, climb: makeQueueItemInput(), angle: 40 },
      authCtx(),
    );
    expect(retryAccepted).toBe(true);

    // The retry fell through the dedup: writer re-taken, and a second
    // history entry + durable row with a fresh, higher seq landed.
    expect(await testRedis.get(writerKey)).toBe(TEST_USER_ID);
    const history = await testRedis.lrange(`board:${boardId}:history`, 0, -1);
    expect(history).toHaveLength(2);
    expect(await countEvents(boardId)).toBe(2);
    const [durableRow] = await db.execute(
      sql`SELECT count(DISTINCT seq)::int AS distinct_seqs FROM board_climb_events WHERE board_id = ${boardId}`,
    );
    expect(Number((durableRow as { distinct_seqs: number }).distinct_seqs)).toBe(2);
  });
});

describe('board-presence seq continuity across dormancy (Redis)', () => {
  let redisOn = false;
  let testRedis: Redis | null = null;
  const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6380';

  beforeAll(async () => {
    redisOn = await ensureRedisConnectedForTest();
    if (!redisOn) {
      console.warn('[board-presence] Redis unavailable — skipping seq continuity tests');
      return;
    }
    testRedis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await testRedis.connect();
    pubsub.setBoardSeqAllocator(allocateBoardPresenceSeq);
  });

  afterAll(async () => {
    // Restore DB-free defaults so later test files in the same worker never
    // inherit an allocator/floor provider that hits Postgres.
    pubsub.setBoardSeqAllocator(null);
    pubsub.setBoardSeqFloorProvider(async () => 0);
    if (testRedis) await testRedis.quit().catch(() => {});
  });

  beforeEach(async () => {
    await cleanup();
    await seedUser();
    await seedCatalogClimb();
  });

  afterEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
  });

  let seqSerialCounter = 0;
  async function makeSeqBoard(ctx: ConnectionContext = authCtx()): Promise<number> {
    const serial = `SEQCONT-${Date.now().toString(36)}-${seqSerialCounter++}`;
    const resolved = await boardPresenceMutations.resolveBoardForSerial(
      undefined,
      { serial, boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2' },
      ctx,
    );
    return resolved.boardId;
  }

  async function durableSeqs(boardId: number): Promise<number[]> {
    const rows = await db.execute(sql`SELECT seq FROM board_climb_events WHERE board_id = ${boardId} ORDER BY seq ASC`);
    return rows.map((row) => Number((row as { seq: number }).seq));
  }

  it('reseeds past the durable floor after the Redis seq counter is lost, keeping boardHistory newest-first intact', async () => {
    if (!redisOn || !testRedis) return;
    const boardId = await makeSeqBoard();
    await stampSustainedFirstSeen(testRedis, boardId, TEST_USER_ID);

    await boardPresenceMutations.reportBoardClimb(
      undefined,
      { boardId, climb: makeQueueItemInput(), angle: 40 },
      authCtx(),
    );
    const [firstSeq] = await durableSeqs(boardId);
    expect(firstSeq).toBeGreaterThan(0);

    // Simulate dormancy: the Redis seq key expired/was evicted, but the
    // durable Postgres row from the first send is still there.
    await testRedis.del(`board:${boardId}:seq`);

    await boardPresenceMutations.reportBoardClimb(
      undefined,
      { boardId, climb: makeQueueItemInput({ uuid: OTHER_TEST_CLIMB_UUID }), angle: 40 },
      authCtx(),
    );

    const seqs = await durableSeqs(boardId);
    expect(seqs).toHaveLength(2);
    expect(seqs[1]).toBeGreaterThan(firstSeq);

    const history = await boardPresenceQueries.boardHistory(undefined, { boardId }, authCtx());
    expect(history.map((row) => row.seq)).toEqual([seqs[1], seqs[0]]);
  });

  it('starts a brand-new board at seq 1 even right after a DEL with no durable rows', async () => {
    if (!redisOn || !testRedis) return;
    const boardId = await makeSeqBoard();
    await testRedis.del(`board:${boardId}:seq`); // no-op: the board never sent, so this key never existed
    expect(await pubsub.nextBoardSeq(String(boardId))).toBe(1);
  });

  it('allocates distinct seqs above the durable floor under concurrent reports issued right after a reset', async () => {
    if (!redisOn || !testRedis) return;
    const boardId = await makeSeqBoard();
    await stampSustainedFirstSeen(testRedis, boardId, TEST_USER_ID);
    await pubsub.stampBoardMembership(String(boardId), SECOND_USER_ID);
    // Both concurrent senders below need the durable dwell gate satisfied, or
    // the under-dwell one's send is correctly accepted live but skipped
    // durably — which would make the "3 durable rows" assertion below fail
    // for a reason unrelated to seq continuity.
    await stampSustainedFirstSeen(testRedis, boardId, SECOND_USER_ID);

    await boardPresenceMutations.reportBoardClimb(
      undefined,
      { boardId, climb: makeQueueItemInput(), angle: 40 },
      authCtx(),
    );
    const [priorSeq] = await durableSeqs(boardId);

    await testRedis.del(`board:${boardId}:seq`);

    const [firstAccepted, secondAccepted] = await Promise.all([
      boardPresenceMutations.reportBoardClimb(
        undefined,
        { boardId, climb: makeQueueItemInput({ uuid: OTHER_TEST_CLIMB_UUID }), angle: 40 },
        authCtx(),
      ),
      boardPresenceMutations.reportBoardClimb(
        undefined,
        { boardId, climb: makeQueueItemInput(), angle: 45 },
        authCtx({ userId: SECOND_USER_ID }),
      ),
    ]);
    expect(firstAccepted).toBe(true);
    expect(secondAccepted).toBe(true);

    const seqs = await durableSeqs(boardId);
    expect(seqs).toHaveLength(3);
    const [, second, third] = seqs;
    expect(second).toBeGreaterThan(priorSeq);
    expect(third).toBeGreaterThan(priorSeq);
    expect(second).not.toBe(third);
  });

  it('the Lua allocator (allocateBoardSeqAtLeast) advances monotonically above a given floor', async () => {
    if (!redisOn) return;
    const boardId = `lua-floor-test-${Date.now()}`;
    const first = await pubsub.allocateBoardSeqAtLeast(boardId, 500);
    const second = await pubsub.allocateBoardSeqAtLeast(boardId, 500);
    expect(first).toBe(501);
    expect(second).toBe(502);
  });

  it('memoizes the floor check: one provider call while the counter grows, re-consulted after a counter loss', async () => {
    if (!redisOn || !testRedis) return;
    let providerCalls = 0;
    pubsub.setBoardSeqAllocator(null);
    pubsub.setBoardSeqFloorProvider(async () => {
      providerCalls += 1;
      return 0;
    });
    try {
      const syntheticBoardId = `memo-${Date.now().toString(36)}`;
      expect(await pubsub.nextBoardSeq(syntheticBoardId)).toBe(1);
      expect(providerCalls).toBe(1);

      // Early-life growth: each fresh INCR is strictly ahead of the
      // watermark, so the Postgres floor lookup is not repeated.
      await pubsub.nextBoardSeq(syntheticBoardId);
      await pubsub.nextBoardSeq(syntheticBoardId);
      expect(providerCalls).toBe(1);

      // Counter loss while the process is up: INCR restarts at 1, which is
      // NOT ahead of the watermark — the floor must be re-consulted (this is
      // the hole a naive floor-value memo would leave open).
      await testRedis.del(`board:${syntheticBoardId}:seq`);
      await pubsub.nextBoardSeq(syntheticBoardId);
      expect(providerCalls).toBe(2);
    } finally {
      // Restore this describe's real provider for any later Redis-gated test.
      pubsub.setBoardSeqFloorProvider(getBoardSeqFloor);
      pubsub.setBoardSeqAllocator(allocateBoardPresenceSeq);
    }
  });

  it('keeps retrying a failed floor consultation past the reseed threshold, then jumps the floor once it recovers', async () => {
    if (!redisOn || !testRedis) return;
    // The hazard: a fresh counter (post-dormancy) on a board whose durable
    // floor is high, while the floor lookup fails transiently for the whole
    // <= threshold window. Without a sticky retry, the counter would cross
    // the threshold still below the floor and never consult Postgres again —
    // clients holding pre-reset high seqs would treat every later event as
    // stale and the live wall would freeze forever.
    let providerHealthy = false;
    let providerCalls = 0;
    pubsub.setBoardSeqAllocator(null);
    pubsub.setBoardSeqFloorProvider(async () => {
      providerCalls += 1;
      if (!providerHealthy) throw new Error('simulated transient Postgres blip');
      return 500;
    });
    try {
      // Fresh synthetic board = the post-counter-loss state (INCR from 1).
      const syntheticBoardId = `sticky-${Date.now().toString(36)}`;
      const allocatedDuringOutage: number[] = [];
      for (let sendIndex = 0; sendIndex < 55; sendIndex++) {
        allocatedDuringOutage.push(await pubsub.nextBoardSeq(syntheticBoardId));
      }
      // Every allocation degraded to the raw INCR (still below the floor)...
      expect(allocatedDuringOutage[54]).toBe(55);
      // ...and calls 51..55 prove the retry is sticky: without the pending
      // flag the consultation would have stopped at the 50 threshold.
      expect(providerCalls).toBe(55);

      // Postgres recovers: the very next allocation consults the floor and
      // jumps past it.
      providerHealthy = true;
      expect(await pubsub.nextBoardSeq(syntheticBoardId)).toBe(501);

      // The pending flag is cleared by the success: subsequent allocations
      // (now far past the threshold) skip the consultation again.
      const callsAfterRecovery = providerCalls;
      expect(await pubsub.nextBoardSeq(syntheticBoardId)).toBe(502);
      expect(providerCalls).toBe(callsAfterRecovery);
    } finally {
      pubsub.setBoardSeqFloorProvider(getBoardSeqFloor);
      pubsub.setBoardSeqAllocator(allocateBoardPresenceSeq);
    }
  });
});

describe('board-presence stats cache (Redis)', () => {
  let redisOn = false;
  let testRedis: Redis | null = null;
  const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6380';

  beforeAll(async () => {
    redisOn = await ensureRedisConnectedForTest();
    if (!redisOn) {
      console.warn('[board-presence] Redis unavailable — skipping stats cache tests');
      return;
    }
    testRedis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await testRedis.connect();
  });

  afterAll(async () => {
    if (testRedis) await testRedis.quit().catch(() => {});
  });

  beforeEach(async () => {
    await cleanup();
    await seedUser();
    await seedCatalogClimb();
  });

  afterEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
  });

  function statsCacheKey(boardId: number): string {
    return `boardsesh:board-stats:v1:${boardId}`;
  }

  let statsSerialCounter = 0;
  async function makeStatsBoard(): Promise<number> {
    const resolved = await boardPresenceMutations.resolveBoardForSerial(
      undefined,
      {
        serial: `STATSCACHE-${Date.now().toString(36)}-${statsSerialCounter++}`,
        boardType: 'kilter',
        layoutId: 1,
        sizeId: 10,
        setIds: '1,2',
      },
      authCtx(),
    );
    return resolved.boardId;
  }

  async function insertSendTick(boardId: number, climbUuid: string, difficulty: number): Promise<void> {
    await db.execute(sql`
      INSERT INTO boardsesh_ticks
        (uuid, user_id, board_type, climb_uuid, angle, is_mirror, status, attempt_count, difficulty, is_benchmark, comment, climbed_at, created_at, updated_at, board_id)
      VALUES
        (${uuidv4()}, ${TEST_USER_ID}, 'kilter', ${climbUuid}, 40, false, 'send', 1, ${difficulty}, false, '', ${new Date().toISOString()}, now(), now(), ${boardId})
    `);
  }

  // saveTick's explicit-boardId fast path only attaches boardId when the
  // FULL config matches the board (see saveTick's configMatches check in
  // ticks/mutations.ts) — layoutId/sizeId/setIds must mirror makeStatsBoard's
  // config below, or saveTick silently drops boardId (warns "config
  // mismatch") and queueBoardStatsPublish never fires.
  function baseSaveTickInput(boardId: number) {
    return {
      boardType: 'kilter',
      climbUuid: TEST_CLIMB_UUID,
      angle: 40,
      isMirror: false,
      status: 'send',
      attemptCount: 1,
      quality: null,
      difficulty: 17,
      isBenchmark: false,
      comment: '',
      climbedAt: new Date().toISOString(),
      boardId,
      layoutId: 1,
      sizeId: 10,
      setIds: '1,2',
    };
  }

  /**
   * Wait for the read path's fire-and-forget cache SET to land.
   *
   * `boardPresenceStats` returns before its Redis write resolves, so a fixed
   * sleep is a bet on how loaded the machine is — a 50ms one lost that bet on a
   * full-suite CI shard and made the two cases below fail as "the cache missed".
   * Poll for the key instead, so the wait costs a couple of milliseconds when
   * things are quick and still holds up when they are not.
   */
  async function waitForCachedStats(
    testRedisClient: Redis,
    boardId: number,
    timeoutMs = 10_000,
  ): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const cachedRaw = await testRedisClient.get(statsCacheKey(boardId));
      if (cachedRaw !== null) return cachedRaw;
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  it('populates the cache on a miss and serves the same snapshot on a subsequent read', async () => {
    if (!redisOn || !testRedis) return;
    const boardId = await makeStatsBoard();
    await insertSendTick(boardId, TEST_CLIMB_UUID, 17);

    expect(await testRedis.get(statsCacheKey(boardId))).toBeNull();

    const first = await boardPresenceQueries.boardPresenceStats(undefined, { boardId }, authCtx());
    expect(first.climbsSentCount).toBe(1);

    const cachedRaw = await waitForCachedStats(testRedis, boardId);
    expect(cachedRaw).not.toBeNull();
    expect(JSON.parse(cachedRaw!)).toEqual(first);
  });

  it('serves the cached snapshot even after a fresh tick lands directly in Postgres', async () => {
    if (!redisOn || !testRedis) return;
    const boardId = await makeStatsBoard();
    await insertSendTick(boardId, TEST_CLIMB_UUID, 17);

    const first = await boardPresenceQueries.boardPresenceStats(undefined, { boardId }, authCtx());
    expect(first.climbsSentCount).toBe(1);
    // The second read below only exercises the cache once this landed; without
    // the wait it silently becomes a second cold query and asserts nothing.
    expect(await waitForCachedStats(testRedis, boardId)).not.toBeNull();

    // A second send lands straight in Postgres, bypassing saveTick (and so
    // never calling queueBoardStatsPublish) — the query must still serve the
    // cached snapshot rather than recomputing.
    await insertSendTick(boardId, OTHER_TEST_CLIMB_UUID, 18);
    const second = await boardPresenceQueries.boardPresenceStats(undefined, { boardId }, authCtx());
    expect(second).toEqual(first);
    expect(second.climbsSentCount).toBe(1);
  });

  // Polls the Redis cache key directly (never the rate-limited GraphQL
  // query) so a several-second debounce wait can't trip applyRateLimit.
  async function pollCacheUntil(
    testRedisClient: Redis,
    boardId: number,
    predicate: (stats: BoardPresenceStats) => boolean,
    timeoutMs = 6000,
  ): Promise<BoardPresenceStats | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const cachedRaw = await testRedisClient.get(statsCacheKey(boardId));
      if (cachedRaw) {
        const stats = JSON.parse(cachedRaw) as BoardPresenceStats;
        if (predicate(stats)) return stats;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  }

  it('saveTick refreshes the cache after the debounce window, matching a cold query', async () => {
    if (!redisOn || !testRedis) return;
    const boardId = await makeStatsBoard();

    await tickMutations.saveTick(undefined, { input: baseSaveTickInput(boardId) }, authCtx());

    // publishBoardStats sets the cache to the exact snapshot it also pushes
    // as BoardStatsUpdated (see stats.ts), so a matching cache entry proves
    // the debounced publish landed.
    const cached = await pollCacheUntil(testRedis, boardId, (stats) => stats.climbsSentCount === 1);
    expect(cached).not.toBeNull();

    const queried = await boardPresenceQueries.boardPresenceStats(undefined, { boardId }, authCtx());
    expect(queried).toEqual(cached);
  });

  it('deleteTick refreshes the cache after the debounce window', async () => {
    if (!redisOn || !testRedis) return;
    const boardId = await makeStatsBoard();

    const saved = (await tickMutations.saveTick(undefined, { input: baseSaveTickInput(boardId) }, authCtx())) as {
      uuid: string;
    };

    const afterSave = await pollCacheUntil(testRedis, boardId, (stats) => stats.climbsSentCount === 1);
    expect(afterSave).not.toBeNull();

    await tickMutations.deleteTick(undefined, { uuid: saved.uuid }, authCtx());

    const afterDelete = await pollCacheUntil(testRedis, boardId, (stats) => stats.climbsSentCount === 0);
    expect(afterDelete).not.toBeNull();
  });

  it('updateTick refreshes the cache after the debounce window (attempt -> send)', async () => {
    if (!redisOn || !testRedis) return;
    const boardId = await makeStatsBoard();

    // Log an ATTEMPT: counts toward distinct climbers but not sends.
    const saved = (await tickMutations.saveTick(
      undefined,
      { input: { ...baseSaveTickInput(boardId), status: 'attempt', attemptCount: 2 } },
      authCtx(),
    )) as { uuid: string };

    const afterSave = await pollCacheUntil(
      testRedis,
      boardId,
      (stats) => stats.distinctClimbersCount === 1 && stats.climbsSentCount === 0,
    );
    expect(afterSave).not.toBeNull();

    // The motivating edit: flipping attempt -> send must refresh the wall's
    // live tiles + cache (pre-existing staleness this PR fixes).
    await tickMutations.updateTick(undefined, { uuid: saved.uuid, input: { status: 'send' } }, authCtx());

    const afterUpdate = await pollCacheUntil(testRedis, boardId, (stats) => stats.climbsSentCount === 1);
    expect(afterUpdate).not.toBeNull();
  });

  it('a late query-miss cache write (SET NX) never rolls back a fresher publish-path snapshot', async () => {
    if (!redisOn || !testRedis) return;
    const boardId = await makeStatsBoard();
    const emptyStats: BoardPresenceStats = {
      climbsSentCount: 0,
      distinctClimbersCount: 0,
      hardestGrade: null,
      hardestSend: null,
      topGrade: null,
      lastSentAt: null,
    };
    const staleSnapshot: BoardPresenceStats = { ...emptyStats, climbsSentCount: 4 };
    const freshSnapshot: BoardPresenceStats = { ...emptyStats, climbsSentCount: 5 };
    const readCache = async () => JSON.parse((await testRedis!.get(statsCacheKey(boardId)))!) as BoardPresenceStats;
    const flushFireAndForget = () => new Promise((resolve) => setTimeout(resolve, 50));

    // True miss: the query-path NX write populates the key.
    setCachedBoardPresenceStats(boardId, staleSnapshot, { onlyIfAbsent: true });
    await flushFireAndForget();
    expect(await readCache()).toEqual(staleSnapshot);

    // The authoritative publish-path write (plain SET) overwrites it...
    setCachedBoardPresenceStats(boardId, freshSnapshot);
    await flushFireAndForget();
    expect(await readCache()).toEqual(freshSnapshot);

    // ...and a late query-miss write that lost the race (computed before the
    // publish, landing after it) is a no-op instead of a rollback.
    setCachedBoardPresenceStats(boardId, staleSnapshot, { onlyIfAbsent: true });
    await flushFireAndForget();
    expect(await readCache()).toEqual(freshSnapshot);
  });

  it('still computes stats correctly when Redis is unavailable (cache is best-effort)', async () => {
    const boardId = await makeStatsBoard();
    await insertSendTick(boardId, TEST_CLIMB_UUID, 17);

    vi.spyOn(redisClientManager, 'isRedisConnected').mockReturnValue(false);
    const stats = await boardPresenceQueries.boardPresenceStats(undefined, { boardId }, authCtx());
    expect(stats.climbsSentCount).toBe(1);
  });
});

// ============================================================
// commitBoardClimb degraded path: a failed / unavailable writer slot must
// never fabricate a hand-off broadcast (the writerSlotOk gate). Appended at
// the END of the file (see the ordering note above).
// ============================================================
describe('board-presence commit degradation', () => {
  beforeEach(async () => {
    await cleanup();
    await seedUser();
    await seedCatalogClimb();
  });

  afterEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
  });

  it('commitBoardClimb reports writerSlotOk=false (previousWriter is a fabrication) when Redis is unavailable', async () => {
    vi.spyOn(redisClientManager, 'isRedisConnected').mockReturnValue(false);
    const result = await pubsub.commitBoardClimb({
      boardId: '999999',
      emitterId: 'emitter-degraded',
      climb: { climbUuid: 'climb-degraded', sentAt: new Date().toISOString(), seq: 1 },
      climbUuid: 'climb-degraded',
      effectiveAngle: 40,
      sessionId: null,
    });
    expect(result).toEqual({ previousWriter: null, writerSlotOk: false, sessionBindingChanged: false });
  });

  it('reportBoardClimb publishes the climb but no hand-off when the writer slot did not verifiably execute', async () => {
    const resolved = await boardPresenceMutations.resolveBoardForSerial(
      undefined,
      { serial: `DEGR-${Date.now().toString(36)}`, boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2' },
      authCtx(),
    );
    const boardId = resolved.boardId;

    // Simulate the failing-pipeline seam: previousWriter: null is a
    // fabrication and writerSlotOk says so. The resolver must still accept
    // the report and publish BoardClimbSet, but must NOT infer a free->held
    // hand-off from the fabricated null.
    vi.spyOn(pubsub, 'commitBoardClimb').mockResolvedValue({
      previousWriter: null,
      writerSlotOk: false,
      sessionBindingChanged: false,
    });
    const publishSpy = vi.spyOn(pubsub, 'publishBoardPresenceEvent');

    const accepted = await boardPresenceMutations.reportBoardClimb(
      undefined,
      { boardId, climb: makeQueueItemInput(), angle: 40 },
      authCtx(),
    );
    expect(accepted).toBe(true);

    const publishedTypenames = publishSpy.mock.calls.map(([, event]) => event.__typename);
    expect(publishedTypenames).toContain('BoardClimbSet');
    expect(publishedTypenames).not.toContain('BoardConnectionChanged');
  });
});
