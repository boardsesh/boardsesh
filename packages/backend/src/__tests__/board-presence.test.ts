import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vite-plus/test';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { sql } from 'drizzle-orm';
import type {
  ConnectionContext,
  BoardPresenceEvent,
  BoardClimbSet,
  BoardStatsUpdated,
  BoardPresenceClimb,
  ClimbQueueItemInput,
} from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { pubsub } from '../pubsub';
import { boardPresenceMutations } from '../graphql/resolvers/board-presence/mutations';
import { boardPresenceQueries } from '../graphql/resolvers/board-presence/queries';
import { boardPresenceSubscriptions } from '../graphql/resolvers/board-presence/subscription';
import { tickMutations } from '../graphql/resolvers/ticks/mutations';

// Board presence is env-gated. Every test in this file exercises the enabled
// path, so flip it on for the suite.
const ORIGINAL_FLAG = process.env.BOARD_PRESENCE_ENABLED;
beforeAll(() => {
  process.env.BOARD_PRESENCE_ENABLED = 'true';
});
afterAll(() => {
  if (ORIGINAL_FLAG === undefined) {
    delete process.env.BOARD_PRESENCE_ENABLED;
  } else {
    process.env.BOARD_PRESENCE_ENABLED = ORIGINAL_FLAG;
  }
});

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

  describe('feature gate', () => {
    it('throws when BOARD_PRESENCE_ENABLED is not "true"', async () => {
      process.env.BOARD_PRESENCE_ENABLED = 'false';
      try {
        await expect(boardPresenceQueries.boardPresenceStats(undefined, { boardId: 1 }, authCtx())).rejects.toThrow(
          'Board presence is not enabled',
        );
      } finally {
        process.env.BOARD_PRESENCE_ENABLED = 'true';
      }
    });
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

      expect(received).toHaveLength(1);
      const event = received[0] as BoardClimbSet;
      expect(event.__typename).toBe('BoardClimbSet');
      expect(event.climb.sentByDisplayName).toBe(SENDER_DISPLAY_NAME);
      expect(event.climb.sentByAvatarUrl).toBe(SENDER_AVATAR_URL);
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

    it('requires authentication', async () => {
      await expect(
        boardPresenceMutations.reportBoardClimb(
          undefined,
          { boardId: 1, climb: makeQueueItemInput(), angle: 40 },
          authCtx({ isAuthenticated: false, userId: undefined }),
        ),
      ).rejects.toThrow('Authentication required');
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

    it('stamps a valid explicit boardId over the caller config board', async () => {
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

    it('stamps explicit boardId while board presence is disabled', async () => {
      const sharedBoardId = await createSecondUserSharedBoard();
      const ownBoardId = await createOwnConfigBoard();
      process.env.BOARD_PRESENCE_ENABLED = 'false';
      try {
        await tickMutations.saveTick(undefined, { input: baseTickInput({ boardId: sharedBoardId }) }, authCtx());
      } finally {
        process.env.BOARD_PRESENCE_ENABLED = 'true';
      }

      expect(await latestTickBoardId()).toBe(sharedBoardId);
      expect(await latestTickBoardId()).not.toBe(ownBoardId);
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
