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
import { BOARD_CONFIG_PRESENCE_SLUG_PREFIX, SYSTEM_BOARD_OWNER_ID } from '../graphql/resolvers/board-presence/shared';

/**
 * Real-DB coverage for how saveTick ranks a per-config SHARED FEED board
 * against the climber's own wall (#5121).
 *
 * A wall with no BLE serial — every MoonBoard, and any serial-less
 * Kilter/Tension controller — binds board presence through
 * `resolveBoardForConfig`, which hands back one system-owned row per
 * (type, layout, size, sets), shared by every climber on that configuration
 * worldwide. The client then sends that row's id as the tick's `boardId`.
 *
 * It used to win outright, so a climber with their own board of that exact
 * config had every tick filed under the global feed: 10,879 rows across 655
 * climbers on production, and their own board read as empty everywhere it is
 * scoped by `board_id` — including the Home tab's "Recent sessions", which is
 * what #5121 reported.
 *
 * A shared feed is now the LAST rung, below the session's wall and below the
 * owner's config lookup, and it still claims the tick when nothing better
 * exists. The demotion keys on owner + slug namespace, never the display name:
 * the ~520 seeded catalog boards are system-owned too and must keep winning.
 */

const USER_ID = 'shared-feed-attr-user';
const GYM_OWNER_ID = 'shared-feed-attr-gym-owner';
const PREFIX = 'SHARED-FEED-ATTR-';
const CLIMB_UUID = `${PREFIX}CLIMB`;

// The reported configuration: a MoonBoard home wall, which has no serial and so
// always resolves presence through the shared per-config feed.
const CONFIG = { boardType: 'moonboard', layoutId: 6, sizeId: 1, setIds: '24,25,26,27' };

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

// Every board this suite creates, so cleanup can delete exactly those. The
// system owner also owns the seeded catalog in a shared worker DB — deleting by
// `owner_id` would take a sibling suite's boards with it.
const createdBoardIds: number[] = [];

async function insertBoard(opts: {
  ownerId?: string;
  setIds?: string;
  slug?: string;
  name: string;
}): Promise<{ id: number; uuid: string }> {
  const uuid = uuidv4();
  const result = await db.execute(sql`
    INSERT INTO user_boards
      (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, is_public, created_at, updated_at)
    VALUES (${uuid}, ${opts.slug ?? uuid}, ${opts.ownerId ?? USER_ID}, ${CONFIG.boardType}, ${CONFIG.layoutId},
            ${CONFIG.sizeId}, ${opts.setIds ?? CONFIG.setIds}, ${opts.name}, true, now(), now())
    RETURNING id
  `);
  const id = Number(Array.from(result as Iterable<{ id: number }>)[0].id);
  createdBoardIds.push(id);
  return { id, uuid };
}

/** The system-owned row `resolveSharedBoardForConfig` mints for a config. */
function insertSharedFeedBoard() {
  return insertBoard({
    ownerId: SYSTEM_BOARD_OWNER_ID,
    slug: `${BOARD_CONFIG_PRESENCE_SLUG_PREFIX}${CONFIG.boardType}-${CONFIG.layoutId}-${CONFIG.sizeId}-${uuidv4().replace(/-/g, '').slice(0, 20)}`,
    name: 'MoonBoard Board Shared Feed',
  });
}

async function insertSession(opts: { boardId: number | null }): Promise<string> {
  const id = `sess-${uuidv4()}`;
  await db.execute(sql`
    INSERT INTO board_sessions (id, board_path, board_id, created_by_user_id, status, created_at, last_activity)
    VALUES (${id}, ${'moonboard/6/1/24,25,26,27/40'}, ${opts.boardId}, ${USER_ID}, 'active', now(), now())
  `);
  return id;
}

/** The board_id the tick actually landed on. */
async function tickBoardId(tickUuid: string): Promise<number | null> {
  const result = await db.execute(sql`SELECT board_id FROM boardsesh_ticks WHERE uuid = ${tickUuid}`);
  const row = Array.from(result as Iterable<{ board_id: number | null }>)[0];
  return row.board_id == null ? null : Number(row.board_id);
}

async function saveTick(overrides: Record<string, unknown> = {}) {
  const uuid = uuidv4();
  await tickMutations.saveTick(undefined, { input: { uuid, ...tickInput(overrides) } }, authCtx());
  return tickBoardId(uuid);
}

describe('shared config feed tick attribution', () => {
  beforeAll(async () => {
    await setupWorkerDatabase();
  });

  // Re-seeded per test, not once in beforeAll: sibling suites TRUNCATE these
  // same shared tables in their own beforeEach, and this file's tests can
  // interleave with theirs within a worker's shared DB.
  beforeEach(async () => {
    for (const id of [USER_ID, GYM_OWNER_ID]) {
      await db.execute(sql`
        INSERT INTO users (id, email, name, created_at, updated_at)
        VALUES (${id}, ${`${id}@test.com`}, ${`User ${id}`}, now(), now())
        ON CONFLICT (id) DO NOTHING
      `);
    }
    // The owner `resolveSharedBoardForConfig` mints shared feeds under, seeded
    // the way `ensureSystemBoardOwner` does. Unqualified DO NOTHING because a
    // sibling suite may already hold this id or this email.
    await db.execute(sql`
      INSERT INTO users (id, email, name, created_at, updated_at)
      VALUES (${SYSTEM_BOARD_OWNER_ID}, 'system@boardsesh.com', 'System', now(), now())
      ON CONFLICT DO NOTHING
    `);
    await db.execute(sql`
      INSERT INTO board_climbs (uuid, board_type, layout_id, setter_username, name, description, frames, is_listed)
      VALUES (${CLIMB_UUID}, ${CONFIG.boardType}, ${CONFIG.layoutId}, 'setter', 'Test Climb', '', 'p1r1', true)
      ON CONFLICT (uuid) DO NOTHING
    `);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM board_climbs WHERE uuid = ${CLIMB_UUID}`);
    await db.execute(sql`DELETE FROM users WHERE id IN (${USER_ID}, ${GYM_OWNER_ID})`);
  });

  afterEach(async () => {
    await db.execute(sql`DELETE FROM boardsesh_ticks WHERE user_id = ${USER_ID}`);
    await db.execute(sql`DELETE FROM board_sessions WHERE created_by_user_id = ${USER_ID}`);
    if (createdBoardIds.length > 0) {
      const ids = sql.join(
        createdBoardIds.map((id) => sql`${id}`),
        sql`, `,
      );
      await db.execute(sql`DELETE FROM user_boards WHERE id IN (${ids})`);
      createdBoardIds.length = 0;
    }
  });

  it("files the tick on the climber's own wall, not the shared feed bound to their phone", async () => {
    // #5121 exactly: a MoonBoard home wall the climber named, and the global
    // per-config feed their serial-less controller binds presence to.
    const sharedFeed = await insertSharedFeedBoard();
    const homeWall = await insertBoard({ name: 'Tranquility' });

    expect(await saveTick({ boardId: sharedFeed.id })).toBe(homeWall.id);
  });

  it('still files on the shared feed when the climber owns no wall of this config', async () => {
    // The feed is the last rung, not a removed one: without it these ticks would
    // lose their board entirely and empty the wall's live stats.
    const sharedFeed = await insertSharedFeedBoard();

    expect(await saveTick({ boardId: sharedFeed.id })).toBe(sharedFeed.id);
  });

  it("prefers the session's wall over the shared feed", async () => {
    const sharedFeed = await insertSharedFeedBoard();
    const gymWall = await insertBoard({ ownerId: GYM_OWNER_ID, name: 'Gym MoonBoard' });
    const sessionId = await insertSession({ boardId: gymWall.id });

    expect(await saveTick({ boardId: sharedFeed.id, sessionId })).toBe(gymWall.id);
  });

  it('prefers the board the climber selected when its uuid is sent', async () => {
    const sharedFeed = await insertSharedFeedBoard();
    // Owned by the gym, not the climber, so only the uuid rung can reach it —
    // this is the case the config lookup cannot serve.
    const gymWall = await insertBoard({ ownerId: GYM_OWNER_ID, name: 'Gym MoonBoard' });

    expect(await saveTick({ boardId: sharedFeed.id, boardUuid: gymWall.uuid })).toBe(gymWall.id);
  });

  it('keeps a seeded catalog board winning at the presence rung', async () => {
    // Seeded gym boards are system-owned too (~520 of them, 15,565 ticks) but
    // carry ordinary slugs and name real walls. Demoting on owner alone — or on
    // the display name — would have moved their ticks onto whatever same-config
    // board the climber happens to own.
    const seededGymWall = await insertBoard({
      ownerId: SYSTEM_BOARD_OWNER_ID,
      slug: 'seeded-gym-moonboard',
      name: 'MoonBoard Board Shared Feed',
    });
    await insertBoard({ name: 'Tranquility' });

    expect(await saveTick({ boardId: seededGymWall.id })).toBe(seededGymWall.id);
  });

  it('leaves the tick on the shared feed when its config disagrees with the wall', async () => {
    // Unchanged gate: a boardId whose config doesn't match the tick is dropped
    // before the shared-feed question is even asked, and the owner's own board
    // of the tick's config takes it.
    const otherConfigFeed = await insertBoard({
      ownerId: SYSTEM_BOARD_OWNER_ID,
      setIds: '5,6,7,8,9,10',
      slug: `${BOARD_CONFIG_PRESENCE_SLUG_PREFIX}moonboard-3-1-otherconfig`,
      name: 'MoonBoard Board Shared Feed',
    });
    const homeWall = await insertBoard({ name: 'Tranquility' });

    expect(await saveTick({ boardId: otherConfigFeed.id })).toBe(homeWall.id);
  });
});
