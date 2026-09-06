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
 * Real-DB coverage for the `boardUuid` rung of saveTick's board resolution
 * (#4219).
 *
 * A named-board route (`/b/<slug>/...`) sends the board's uuid, and the rung
 * deliberately isn't ownership-gated — ticking a gym's seeded wall you don't own
 * is the whole point. It used to accept the uuid on its own, so any
 * authenticated caller who knew (or guessed) a uuid could stamp ticks onto that
 * board's stats and leaderboards. The rung now requires the same FULL config
 * match (type + layout + size + set) as the presence and session rungs; a
 * mismatch records the tick unassociated, matching the rung's existing
 * stale-uuid behaviour, and never falls through to the climber's own board.
 */

const USER_ID = 'uuid-gate-user';
const OTHER_USER_ID = 'uuid-gate-gym-owner';
const PREFIX = 'UUID-GATE-';
const CLIMB_UUID = `${PREFIX}CLIMB`;

const CONFIG = { boardType: 'kilter', layoutId: 8, sizeId: 25, setIds: '1,2' };

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
  boardType?: string;
  setIds?: string;
  layoutId?: number;
  sizeId?: number;
  name: string;
}): Promise<{ id: number; uuid: string }> {
  const uuid = uuidv4();
  const result = await db.execute(sql`
    INSERT INTO user_boards
      (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, is_public, created_at, updated_at)
    VALUES (${uuid}, ${uuid}, ${opts.ownerId ?? USER_ID}, ${opts.boardType ?? CONFIG.boardType}, ${opts.layoutId ?? CONFIG.layoutId},
            ${opts.sizeId ?? CONFIG.sizeId}, ${opts.setIds ?? CONFIG.setIds}, ${opts.name}, true, now(), now())
    RETURNING id
  `);
  return { id: Number(Array.from(result as Iterable<{ id: number }>)[0].id), uuid };
}

/** The board_id the tick actually landed on. */
async function tickBoardId(tickUuid: string): Promise<number | null> {
  const result = await db.execute(sql`SELECT board_id FROM boardsesh_ticks WHERE uuid = ${tickUuid}`);
  const row = Array.from(result as Iterable<{ board_id: number | null }>)[0];
  return row.board_id == null ? null : Number(row.board_id);
}

async function saveTick(overrides: Record<string, unknown> = {}, userId = USER_ID) {
  const uuid = uuidv4();
  await tickMutations.saveTick(undefined, { input: { uuid, ...tickInput(overrides) } }, authCtx(userId));
  return tickBoardId(uuid);
}

describe('saveTick boardUuid config gate', () => {
  beforeAll(async () => {
    await setupWorkerDatabase();
  });

  // Re-seeded per test, not once in beforeAll: sibling suites TRUNCATE these
  // same shared tables in their own beforeEach, and this file's tests can
  // interleave with theirs within a worker's shared DB.
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
    // Belt and braces: afterEach already clears these, but a run killed between
    // tests would otherwise strand boards in the shared worker DB.
    await db.execute(sql`DELETE FROM boardsesh_ticks WHERE user_id = ${USER_ID}`);
    await db.execute(sql`DELETE FROM user_boards WHERE owner_id IN (${USER_ID}, ${OTHER_USER_ID})`);
    await db.execute(sql`DELETE FROM board_climbs WHERE uuid = ${CLIMB_UUID}`);
    await db.execute(sql`DELETE FROM users WHERE id IN (${USER_ID}, ${OTHER_USER_ID})`);
  });

  afterEach(async () => {
    await db.execute(sql`DELETE FROM boardsesh_ticks WHERE user_id = ${USER_ID}`);
    await db.execute(sql`DELETE FROM user_boards WHERE owner_id IN (${USER_ID}, ${OTHER_USER_ID})`);
  });

  it("attributes a tick to a gym's board the climber doesn't own when the config matches", async () => {
    // The flow the rung exists for: climbing at a gym on a seeded board owned by
    // someone else, logged from that board's named route.
    const gymBoard = await insertBoard({ ownerId: OTHER_USER_ID, name: 'Gym wall' });

    expect(await saveTick({ boardUuid: gymBoard.uuid })).toBe(gymBoard.id);
  });

  it('records the tick unassociated when the named board runs a different layout', async () => {
    // The pollution vector: a uuid for a board the climber was never on. The
    // tick is still saved, just not counted towards that board — and explicitly
    // NOT re-homed onto the climber's own matching wall either, or a rejected
    // uuid would quietly become a config-lookup tick.
    const otherLayoutBoard = await insertBoard({ ownerId: OTHER_USER_ID, layoutId: 1, name: 'Other layout' });
    const ownBoard = await insertBoard({ name: 'Home wall' });

    const boardId = await saveTick({ boardUuid: otherLayoutBoard.uuid });
    expect(boardId).toBeNull();
    expect(boardId).not.toBe(otherLayoutBoard.id);
    expect(boardId).not.toBe(ownBoard.id);
  });

  it('records the tick unassociated when the named board runs a different size', async () => {
    const otherSizeBoard = await insertBoard({ ownerId: OTHER_USER_ID, sizeId: 27, name: 'Other size' });

    expect(await saveTick({ boardUuid: otherSizeBoard.uuid })).toBeNull();
  });

  it('records the tick unassociated when the named board runs different hold sets', async () => {
    const otherSetsBoard = await insertBoard({ ownerId: OTHER_USER_ID, setIds: '3,4', name: 'Other sets' });

    expect(await saveTick({ boardUuid: otherSetsBoard.uuid })).toBeNull();
  });

  it('records the tick unassociated when the named board is a different board type', async () => {
    // Layout, size and sets all line up — only the board type differs. Layout
    // ids aren't unique across board types, so without this leg a Tension board
    // could collect Kilter ticks.
    const otherTypeBoard = await insertBoard({ ownerId: OTHER_USER_ID, boardType: 'tension', name: 'Tension wall' });

    expect(await saveTick({ boardUuid: otherTypeBoard.uuid })).toBeNull();
  });

  it('attributes when stored and sent hold sets differ only in order', async () => {
    // Same normalisation the presence and session rungs use — '2,1' and '1,2'
    // are one wall, not two.
    const gymBoard = await insertBoard({ ownerId: OTHER_USER_ID, setIds: '2,1', name: 'Gym wall' });

    expect(await saveTick({ boardUuid: gymBoard.uuid, setIds: '1,2' })).toBe(gymBoard.id);
  });

  it('records the tick unassociated instead of falsely matching when the sent hold sets carry a non-numeric token', async () => {
    // SaveTickInputSchema.setIds isn't NumericCsvSchema-restricted (#4217), so a
    // client could in theory send a malformed token here. The set-id comparison
    // (@boardsesh/board-config's normaliseSetIds) keeps non-numeric tokens
    // verbatim rather than silently dropping them, so '1,2,abc' never collapses
    // to '1,2' and can't be coincidentally attributed to a real board that
    // happens to run sets 1 and 2.
    const gymBoard = await insertBoard({ ownerId: OTHER_USER_ID, setIds: '1,2', name: 'Gym wall' });

    expect(await saveTick({ boardUuid: gymBoard.uuid, setIds: '1,2,abc' })).toBeNull();
  });

  it('records the tick unassociated when the input carries a boardUuid but no configuration', async () => {
    // Deliberate strictness: without a layout/size/set there is nothing to check,
    // so omitting the config can't be a way around the gate.
    const gymBoard = await insertBoard({ ownerId: OTHER_USER_ID, name: 'Gym wall' });

    expect(
      await saveTick({ boardUuid: gymBoard.uuid, layoutId: undefined, sizeId: undefined, setIds: undefined }),
    ).toBeNull();
  });

  it('records the tick unassociated when the boardUuid is unknown', async () => {
    // Deleted board or a stale client uuid: the tick is kept, not rejected
    // (#2386's trade-off), and doesn't fall back to config resolution.
    await insertBoard({ name: 'Home wall' });

    expect(await saveTick({ boardUuid: uuidv4() })).toBeNull();
  });
});
