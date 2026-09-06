import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { setupWorkerDatabase } from './worker-db';

// Side effects saveTick fires after the insert. None of them are under test and
// they'd otherwise pull in Redis / the social event bus.
vi.mock('../events', () => ({ publishSocialEvent: vi.fn(async () => undefined) }));
vi.mock('../graphql/resolvers/ticks/debounced-climb-stats-publisher', () => ({
  queueClimbStatsRecompute: vi.fn(),
  recomputeClimbStatsNow: vi.fn(async () => {}),
}));
vi.mock('../graphql/resolvers/sessions/debounced-stats-publisher', () => ({
  publishDebouncedSessionStats: vi.fn(),
}));
vi.mock('../graphql/resolvers/board-presence/stats', () => ({ queueBoardStatsPublish: vi.fn() }));
vi.mock('../services/analytics/posthog', () => ({ captureBackendEvent: vi.fn(() => true) }));

import { db } from '../db/client';
import { tickMutations } from '../graphql/resolvers/ticks/mutations';

/**
 * Real-DB coverage for how a legacy `/[board_name]/[layout_id]/...` tick finds
 * its board.
 *
 * #4174 let one owner hold several boards of the same configuration, which broke
 * the config lookup two ways: it compared set ids as a raw string (so a board
 * stored '2,1' never matched a tick sending '1,2' — the tick was recorded with
 * no board at all), and it took `.limit(1)` with no ORDER BY, so a climber with
 * two same-config walls had their ticks split arbitrarily between them.
 *
 * The lookup now normalises set ids and picks the lowest id, and saveTick
 * prefers the board the tick's session is being held on — the one signal that
 * actually knows which of the two walls the climber is standing at.
 *
 * Where a case is about the ORDER of the pick, the boards carry explicit ids and
 * the HIGHER id is inserted first, so an unordered scan returns the wrong board
 * and the case fails on the old code. Seeding ascending — the obvious way to
 * write it — passes either way and proves nothing.
 */

const USER_ID = 'legacy-attr-user';
const OTHER_USER_ID = 'legacy-attr-other';
const PREFIX = 'LEGACY-ATTR-';
const CLIMB_UUID = `${PREFIX}CLIMB`;

const CONFIG = { boardType: 'kilter', layoutId: 8, sizeId: 25, setIds: '1,2' };

// Explicit ids for the ordering case, well clear of the `user_boards_id_seq`
// range so pinning them can't collide with a serial-assigned row (this suite
// shares the worker DB and deletes only its own rows, never truncating).
const LOWER_BOARD_ID = 900_000_100;
const HIGHER_BOARD_ID = 900_000_200;

function authCtx(userId = USER_ID): ConnectionContext {
  return {
    connectionId: `conn-${Math.random().toString(36).slice(2)}`,
    isAuthenticated: true,
    userId,
  } as ConnectionContext;
}

function tickInput(overrides: Record<string, unknown> = {}) {
  return {
    boardType: CONFIG.boardType,
    climbUuid: CLIMB_UUID,
    angle: 40,
    isMirror: false,
    status: 'send',
    attemptCount: 1,
    quality: null,
    difficulty: 17,
    isBenchmark: false,
    comment: '',
    climbedAt: new Date().toISOString(),
    layoutId: CONFIG.layoutId,
    sizeId: CONFIG.sizeId,
    setIds: CONFIG.setIds,
    ...overrides,
  };
}

async function insertBoard(opts: {
  ownerId?: string;
  setIds?: string;
  layoutId?: number;
  name: string;
  id?: number;
}): Promise<number> {
  const uuid = uuidv4();
  // `id` is pinned only where the test is about the pick's ORDER; everywhere
  // else the serial assigns it.
  const idColumn = opts.id == null ? sql`` : sql`id, `;
  const idValue = opts.id == null ? sql`` : sql`${opts.id}, `;
  const result = await db.execute(sql`
    INSERT INTO user_boards
      (${idColumn}uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, is_public, created_at, updated_at)
    VALUES (${idValue}${uuid}, ${uuid}, ${opts.ownerId ?? USER_ID}, ${CONFIG.boardType}, ${opts.layoutId ?? CONFIG.layoutId},
            ${CONFIG.sizeId}, ${opts.setIds ?? CONFIG.setIds}, ${opts.name}, true, now(), now())
    RETURNING id
  `);
  return Number(Array.from(result as Iterable<{ id: number }>)[0].id);
}

async function insertSession(opts: { boardId: number | null }): Promise<string> {
  const id = `sess-${uuidv4()}`;
  await db.execute(sql`
    INSERT INTO board_sessions (id, board_path, board_id, created_by_user_id, status, created_at, last_activity)
    VALUES (${id}, ${'/kilter/8/25/1,2/40'}, ${opts.boardId}, ${USER_ID}, 'active', now(), now())
  `);
  return id;
}

/** The board_id and session_id the tick actually landed on. */
async function tickAttribution(tickUuid: string): Promise<{ boardId: number | null; sessionId: string | null }> {
  const result = await db.execute(sql`
    SELECT board_id, session_id FROM boardsesh_ticks WHERE uuid = ${tickUuid}
  `);
  const row = Array.from(result as Iterable<{ board_id: number | null; session_id: string | null }>)[0];
  return { boardId: row.board_id == null ? null : Number(row.board_id), sessionId: row.session_id };
}

async function saveTick(overrides: Record<string, unknown> = {}, userId = USER_ID) {
  const uuid = uuidv4();
  await tickMutations.saveTick(undefined, { input: { uuid, ...tickInput(overrides) } }, authCtx(userId));
  return tickAttribution(uuid);
}

describe('legacy tick board attribution', () => {
  beforeAll(async () => {
    await setupWorkerDatabase();
  });

  // Re-seeded per test, not once in beforeAll: sibling suites TRUNCATE these
  // same shared tables in their own beforeEach, and this file's tests can
  // interleave with theirs within a worker's shared DB. Seeding in beforeAll
  // left a window where a cross-file TRUNCATE could strand this suite mid-run
  // with its users/climb gone and no test left to put them back.
  beforeEach(async () => {
    for (const id of [USER_ID, OTHER_USER_ID]) {
      await db.execute(sql`
        INSERT INTO users (id, email, name, created_at, updated_at)
        VALUES (${id}, ${`${id}@test.com`}, ${`User ${id}`}, now(), now())
        ON CONFLICT (id) DO NOTHING
      `);
    }
    await db.execute(sql`
      INSERT INTO board_climbs (uuid, board_type, layout_id, setter_username, name, description, frames, is_listed)
      VALUES (${CLIMB_UUID}, ${CONFIG.boardType}, ${CONFIG.layoutId}, 'setter', 'Test Climb', '', 'p1r1', true)
      ON CONFLICT (uuid) DO NOTHING
    `);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM board_climbs WHERE uuid = ${CLIMB_UUID}`);
    await db.execute(sql`DELETE FROM users WHERE id IN (${USER_ID}, ${OTHER_USER_ID})`);
  });

  afterEach(async () => {
    await db.execute(sql`DELETE FROM boardsesh_ticks WHERE user_id = ${USER_ID}`);
    await db.execute(sql`DELETE FROM board_sessions WHERE created_by_user_id = ${USER_ID}`);
    await db.execute(sql`DELETE FROM user_boards WHERE owner_id IN (${USER_ID}, ${OTHER_USER_ID})`);
  });

  it('attributes a tick whose hold sets arrive in a different order than they were stored', async () => {
    // Stored '2,1' vs a tick sending '1,2': the same wall, but the old raw-string
    // SQL comparison called them different boards and recorded the tick with no
    // board at all — invisible on the board's leaderboard, forever.
    const boardId = await insertBoard({ setIds: '2,1', name: 'Home wall' });

    expect((await saveTick({ setIds: '1,2' })).boardId).toBe(boardId);
  });

  it('picks the same board every time when the owner has two with this config', async () => {
    // Seeded highest-id-FIRST: an unordered pick takes the row it happens to
    // reach first, which is the gym wall, so this case only passes on a lookup
    // that really orders by id.
    await insertBoard({ id: HIGHER_BOARD_ID, name: 'Gym wall' });
    await insertBoard({ id: LOWER_BOARD_ID, name: 'Home wall' });

    // Lowest id wins, and keeps winning — a climber's history for one wall must
    // not scatter across its twin between two logs of the same climb.
    expect((await saveTick()).boardId).toBe(LOWER_BOARD_ID);
    expect((await saveTick()).boardId).toBe(LOWER_BOARD_ID);
  });

  it("prefers the session's board over the config lookup's pick", async () => {
    await insertBoard({ name: 'Home wall' });
    const gymBoardId = await insertBoard({ name: 'Gym wall' });
    const sessionId = await insertSession({ boardId: gymBoardId });

    // The config lookup alone would have taken the lower-id home wall; the
    // session says the climber is at the gym.
    const attribution = await saveTick({ sessionId });
    expect(attribution.boardId).toBe(gymBoardId);
    expect(attribution.sessionId).toBe(sessionId);
  });

  it("attributes to a session board the climber doesn't own", async () => {
    // Party mode: the session is held on someone else's wall, and that wall is
    // still the physical board this send happened on.
    const hostBoardId = await insertBoard({ ownerId: OTHER_USER_ID, name: "Host's wall" });
    const sessionId = await insertSession({ boardId: hostBoardId });

    expect((await saveTick({ sessionId })).boardId).toBe(hostBoardId);
  });

  it('ignores a session board whose configuration does not match the tick', async () => {
    // A session left open on another wall must not stamp this tick onto it.
    const otherConfigBoardId = await insertBoard({ layoutId: 1, name: 'Other layout' });
    const matchingBoardId = await insertBoard({ name: 'Home wall' });
    const sessionId = await insertSession({ boardId: otherConfigBoardId });

    const attribution = await saveTick({ sessionId });
    expect(attribution.boardId).toBe(matchingBoardId);
    expect(attribution.boardId).not.toBe(otherConfigBoardId);
  });

  it('still attributes by config when the sessionId is stale', async () => {
    // Offline replay of a tick whose session has since gone: the reference is
    // dropped rather than FK-violating the insert (#2386), and the board lookup
    // still runs.
    const boardId = await insertBoard({ name: 'Home wall' });

    const attribution = await saveTick({ sessionId: `sess-${uuidv4()}` });
    expect(attribution.sessionId).toBeNull();
    expect(attribution.boardId).toBe(boardId);
  });
});
