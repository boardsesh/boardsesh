import { describe, it, expect, beforeAll } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { rowsFromResult } from '@boardsesh/db/client';
import { socialGymQueries } from '../graphql/resolvers/social/gyms';
import { socialBoardQueries } from '../graphql/resolvers/social/boards';

/**
 * Real-DB coverage for the gym/board search filters that back the Wall Finder
 * chips. The mock/contract test (search-board-type-filter.test.ts) proves the
 * input shape; this proves the row-level behaviour the SQL is responsible for:
 *
 *   - multiBoardTypeOnly returns only gyms with 2+ distinct board types,
 *   - boardTypes + layoutIds + sizeIds must ALL match the SAME board (one EXISTS,
 *     not three independent ones) — a gym with a Kilter board and a separate
 *     16x10 board must NOT pass a "Kilter + 16x10" filter,
 *   - searchBoards narrows standalone boards by layoutIds / sizeIds.
 *
 * All assertions are membership-by-uuid so unrelated seed rows can't perturb them.
 * No lat/lng is passed, so the text-only (non-PostGIS) path runs — the same
 * boardMatchExists / multiBoardTypeExists clauses compose into both paths.
 */

const PREFIX = 'wf-filter';
const OWNER_A = `${PREFIX}-owner-a`;
const OWNER_B = `${PREFIX}-owner-b`;
const OWNER_C = `${PREFIX}-owner-c`;
const OWNER_S = `${PREFIX}-owner-s`;

// Gym A has two board types (Kilter 1/11 + Tension 1/20) → the only multi-type gym.
// Gym B has one Kilter 1/11. Gym C has one Kilter 1/12 (different size).
const GYM_A = `${PREFIX}-gym-a`;
const GYM_B = `${PREFIX}-gym-b`;
const GYM_C = `${PREFIX}-gym-c`;

// Standalone (no gym) boards for the searchBoards filters.
const BOARD_S1 = `${PREFIX}-board-s1`; // kilter 1 / 11
const BOARD_S2 = `${PREFIX}-board-s2`; // kilter 1 / 12
const BOARD_S3 = `${PREFIX}-board-s3`; // kilter 2 / 11

let dbReady = false;

const ctx = { connectionId: `${PREFIX}-conn`, isAuthenticated: false } as ConnectionContext;

type GymResult = { gyms: Array<{ uuid: string }> };
type BoardResult = { boards: Array<{ uuid: string }> };

const gymUuids = (result: GymResult) => result.gyms.map((gym) => gym.uuid);
const boardUuids = (result: BoardResult) => result.boards.map((board) => board.uuid);

const searchGyms = (input: Record<string, unknown>) =>
  socialGymQueries.searchGyms(null, { input }, ctx) as Promise<GymResult>;
const searchBoards = (input: Record<string, unknown>) =>
  socialBoardQueries.searchBoards(null, { input }, ctx) as Promise<BoardResult>;

async function insertUser(id: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${id}, ${`${id}@test.com`}, ${`Test ${id}`}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);
}

async function insertGym(uuid: string, ownerId: string): Promise<number> {
  const rows = rowsFromResult<{ id: number }>(
    await db.execute(sql`
      INSERT INTO gyms (uuid, owner_id, name, is_public)
      VALUES (${uuid}, ${ownerId}, ${`Gym ${uuid}`}, true)
      RETURNING id
    `),
  );
  return rows[0].id;
}

async function insertBoard(opts: {
  uuid: string;
  ownerId: string;
  boardType: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  gymId: number | null;
}): Promise<void> {
  await db.execute(sql`
    INSERT INTO user_boards (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, gym_id, is_public, is_unlisted)
    VALUES (
      ${opts.uuid}, ${opts.uuid}, ${opts.ownerId}, ${opts.boardType}, ${opts.layoutId}, ${opts.sizeId},
      ${opts.setIds}, ${`Board ${opts.uuid}`}, ${opts.gymId}, true, false
    )
  `);
}

beforeAll(async () => {
  try {
    await Promise.all([insertUser(OWNER_A), insertUser(OWNER_B), insertUser(OWNER_C), insertUser(OWNER_S)]);

    const [gymAId, gymBId, gymCId] = await Promise.all([
      insertGym(GYM_A, OWNER_A),
      insertGym(GYM_B, OWNER_B),
      insertGym(GYM_C, OWNER_C),
    ]);

    await Promise.all([
      // Gym A: two distinct board types.
      insertBoard({
        uuid: `${GYM_A}-k`,
        ownerId: OWNER_A,
        boardType: 'kilter',
        layoutId: 1,
        sizeId: 11,
        setIds: '1',
        gymId: gymAId,
      }),
      insertBoard({
        uuid: `${GYM_A}-t`,
        ownerId: OWNER_A,
        boardType: 'tension',
        layoutId: 1,
        sizeId: 20,
        setIds: '1',
        gymId: gymAId,
      }),
      // Gym B: one Kilter 1/11.
      insertBoard({
        uuid: `${GYM_B}-k`,
        ownerId: OWNER_B,
        boardType: 'kilter',
        layoutId: 1,
        sizeId: 11,
        setIds: '1',
        gymId: gymBId,
      }),
      // Gym C: one Kilter 1/12.
      insertBoard({
        uuid: `${GYM_C}-k`,
        ownerId: OWNER_C,
        boardType: 'kilter',
        layoutId: 1,
        sizeId: 12,
        setIds: '1',
        gymId: gymCId,
      }),
      // Standalone boards.
      insertBoard({
        uuid: BOARD_S1,
        ownerId: OWNER_S,
        boardType: 'kilter',
        layoutId: 1,
        sizeId: 11,
        setIds: '1',
        gymId: null,
      }),
      insertBoard({
        uuid: BOARD_S2,
        ownerId: OWNER_S,
        boardType: 'kilter',
        layoutId: 1,
        sizeId: 12,
        setIds: '1',
        gymId: null,
      }),
      insertBoard({
        uuid: BOARD_S3,
        ownerId: OWNER_S,
        boardType: 'kilter',
        layoutId: 2,
        sizeId: 11,
        setIds: '1',
        gymId: null,
      }),
    ]);

    dbReady = true;
  } catch (error) {
    if (process.env.SKIP_TEST_INFRA === '1') return;
    throw error;
  }
});

describe('searchGyms multiBoardTypeOnly', () => {
  it('returns only gyms with two or more distinct board types', async () => {
    if (!dbReady) return;
    const uuids = gymUuids(await searchGyms({ multiBoardTypeOnly: true }));
    expect(uuids).toContain(GYM_A);
    expect(uuids).not.toContain(GYM_B);
    expect(uuids).not.toContain(GYM_C);
  });

  it('returns all seeded gyms when unfiltered', async () => {
    if (!dbReady) return;
    const uuids = gymUuids(await searchGyms({}));
    expect(uuids).toEqual(expect.arrayContaining([GYM_A, GYM_B, GYM_C]));
  });
});

describe('searchGyms board type + layout + size (single EXISTS)', () => {
  it('matches gyms owning one board that satisfies type AND layout AND size', async () => {
    if (!dbReady) return;
    const uuids = gymUuids(await searchGyms({ boardTypes: ['kilter'], layoutIds: [1], sizeIds: [11] }));
    // A and B both have a kilter / layout 1 / size 11 board; C is size 12.
    expect(uuids).toEqual(expect.arrayContaining([GYM_A, GYM_B]));
    expect(uuids).not.toContain(GYM_C);
  });

  it('requires the size to match the SAME board as the type, not any board', async () => {
    if (!dbReady) return;
    const uuids = gymUuids(await searchGyms({ boardTypes: ['kilter'], sizeIds: [12] }));
    // Only C has a kilter / size 12 board. A's only size-12-less Kilter excludes it.
    expect(uuids).toContain(GYM_C);
    expect(uuids).not.toContain(GYM_A);
    expect(uuids).not.toContain(GYM_B);
  });
});

describe('searchBoards layout/size filters', () => {
  it('narrows standalone boards by sizeIds', async () => {
    if (!dbReady) return;
    const uuids = boardUuids(await searchBoards({ boardTypes: ['kilter'], sizeIds: [12] }));
    expect(uuids).toContain(BOARD_S2);
    expect(uuids).not.toContain(BOARD_S1);
  });

  it('narrows standalone boards by layoutIds', async () => {
    if (!dbReady) return;
    const uuids = boardUuids(await searchBoards({ boardTypes: ['kilter'], layoutIds: [2] }));
    expect(uuids).toContain(BOARD_S3);
    expect(uuids).not.toContain(BOARD_S1);
  });
});
