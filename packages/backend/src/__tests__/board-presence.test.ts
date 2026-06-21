import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vite-plus/test';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { sql } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import type {
  ConnectionContext,
  BoardPresenceEvent,
  BoardClimbSet,
  BoardConnectionChanged,
  BoardStatsUpdated,
  BoardPresenceClimb,
  ClimbQueueItemInput,
} from '@boardsesh/shared-schema';
import { db } from '../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { pubsub } from '../pubsub';
import { redisClientManager } from '../redis/client';
import { roomManager } from '../services/room-manager';
import { boardPresenceMutations } from '../graphql/resolvers/board-presence/mutations';
import { boardPresenceQueries } from '../graphql/resolvers/board-presence/queries';
import { boardPresenceSubscriptions } from '../graphql/resolvers/board-presence/subscription';
import { tickMutations } from '../graphql/resolvers/ticks/mutations';

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
  await db.execute(sql`DELETE FROM users WHERE id IN (${TEST_USER_ID}, ${SECOND_USER_ID})`);
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
      const first = await boardPresenceMutations.resolveBoardForConfig(
        undefined,
        { boardType: 'moonboard', layoutId: 99, sizeId: 1, setIds: '1' },
        authCtx(),
      );
      const second = await boardPresenceMutations.resolveBoardForConfig(
        undefined,
        { boardType: 'moonboard', layoutId: 99, sizeId: 1, setIds: '1' },
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
      const layoutId = 9000 + Math.floor(Math.random() * 10_000);
      const [first, second] = await Promise.all([
        boardPresenceMutations.resolveBoardForConfig(
          undefined,
          { boardType: 'moonboard', layoutId, sizeId: 1, setIds: '3,1' },
          authCtx(),
        ),
        boardPresenceMutations.resolveBoardForConfig(
          undefined,
          { boardType: 'moonboard', layoutId, sizeId: 1, setIds: '1,3' },
          authCtx({ userId: SECOND_USER_ID }),
        ),
      ]);

      expect(second.boardId).toBe(first.boardId);
      expect(first.setIds).toBe('1,3');
      expect(second.setIds).toBe('1,3');

      const [row] = await db.execute(sql`
        SELECT count(*)::int AS count, min(set_ids) AS set_ids
        FROM user_boards
        WHERE owner_id = '00000000-0000-0000-0000-000000000000'
          AND board_type = 'moonboard'
          AND layout_id = ${layoutId}
          AND size_id = 1
          AND deleted_at IS NULL
      `);
      expect(Number((row as { count: number }).count)).toBe(1);
      expect((row as { set_ids: string }).set_ids).toBe('1,3');
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

    it('rejects a board uuid that does not exist', async () => {
      await expect(
        boardPresenceMutations.resolveBoardForUuid(undefined, { boardUuid: uuidv4() }, authCtx()),
      ).rejects.toThrow('Board not found');
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
    vi.spyOn(pubsub, 'getBoardMembershipFirstSeen').mockResolvedValue(Date.now());
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
    vi.spyOn(pubsub, 'getBoardMembershipFirstSeen').mockResolvedValue(null);
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
    vi.spyOn(pubsub, 'getBoardMembershipFirstSeen').mockResolvedValue(Date.now() - 120_000);

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

  // The holder lives in Redis (setBoardWriter / clearBoardWriterIf are Redis-only).
  // pubsub connects only when REDIS_URL is configured (CI sets it); skip cleanly
  // otherwise, mirroring the FIFO-history test above.
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
