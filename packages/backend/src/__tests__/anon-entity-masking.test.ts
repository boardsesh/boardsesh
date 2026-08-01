import { describe, it, expect, beforeEach } from 'vite-plus/test';
import { v4 as uuidv4 } from 'uuid';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { socialGymQueries } from '../graphql/resolvers/social/gyms';
import { socialBoardQueries } from '../graphql/resolvers/social/boards';
import { socialGymKioskQueries } from '../graphql/resolvers/social/gym-kiosks';
import { SYSTEM_BOARD_OWNER_ID } from '../graphql/resolvers/board-presence/shared';

/**
 * Real-DB coverage for #3648: the gym/board ENTITY reads mask private entities
 * the same way the gym-kiosk epic's reads already did, so holding a uuid or slug
 * can't confirm a private gym/board exists or disclose its name.
 *
 * The two masking rules are deliberately DIFFERENT, and this suite pins both:
 *  - gym / gymBySlug mask for anyone without gym EDIT access (authenticated
 *    non-editors included), matching gymBoards + gymKiosk.
 *  - board(boardUuid) masks for ANONYMOUS callers only, matching
 *    requireAnonReadableBoard and the board-presence family — a signed-in
 *    climber still resolves a gym's private board by uuid (BLE connect flow,
 *    boardsBySerialNumbers).
 *  - boardBySlug uses the same anonymous-only mask. The server-rendered web
 *    lookup forwards a signed-in user's token and keeps that response out of
 *    the shared cache, so private direct links still work without leaking.
 *
 * Masking is expressed as `null` rather than a thrown NOT_FOUND because these
 * SDL fields are nullable — `null` already means "no such entity", so it is the
 * genuinely indistinguishable answer. gymBoards throws only because its
 * `[UserBoard!]!` type leaves it no choice.
 *
 * Seeds via raw SQL and calls the resolvers directly against the per-worker test
 * DB, mirroring gym-branding-and-boards.test.ts.
 */

const OWNER = 'anonmask-owner';
const EDITOR = 'anonmask-editor';
const STRANGER = 'anonmask-stranger';
const ALL_USERS = [OWNER, EDITOR, STRANGER, SYSTEM_BOARD_OWNER_ID];

let connectionCounter = 0;
const authCtx = (userId: string): ConnectionContext =>
  ({ connectionId: `conn-${userId}-${connectionCounter++}`, isAuthenticated: true, userId }) as ConnectionContext;
const anonCtx = (): ConnectionContext =>
  ({ connectionId: `conn-anon-${connectionCounter++}`, isAuthenticated: false }) as ConnectionContext;

const insertUser = (id: string) =>
  db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${id}, ${id + '@test.com'}, ${'User ' + id}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);

const insertGym = async (opts: {
  ownerId: string;
  name: string;
  isPublic?: boolean;
  deleted?: boolean;
  mergedIntoGymId?: number | null;
}): Promise<{ id: number; uuid: string; slug: string }> => {
  const { ownerId, name, isPublic = true, deleted = false, mergedIntoGymId = null } = opts;
  const uuid = uuidv4();
  const result = await db.execute(sql`
    INSERT INTO gyms (uuid, name, slug, owner_id, is_public, merged_into_gym_id, deleted_at, created_at, updated_at)
    VALUES (
      ${uuid}, ${name}, ${uuid}, ${ownerId}, ${isPublic},
      ${mergedIntoGymId}, ${deleted ? sql`now()` : sql`NULL`}, now(), now()
    )
    RETURNING id
  `);
  return { id: Number(Array.from(result as Iterable<{ id: number }>)[0].id), uuid, slug: uuid };
};

// Distinct size_id per board so the (owner, type, layout, size, set_ids) unique
// partial index never trips across the several boards one owner has here.
let boardConfigCounter = 0;
const insertBoard = async (opts: {
  gymId: number | null;
  ownerId: string;
  name: string;
  isPublic: boolean;
  isUnlisted?: boolean;
}): Promise<{ id: number; uuid: string; slug: string }> => {
  const { gymId, ownerId, name, isPublic, isUnlisted = false } = opts;
  const uuid = uuidv4();
  const sizeId = 10 + boardConfigCounter++;
  const result = await db.execute(sql`
    INSERT INTO user_boards
      (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, gym_id, is_public, is_unlisted, created_at, updated_at)
    VALUES (${uuid}, ${uuid}, ${ownerId}, 'kilter', 1, ${sizeId}, '1,2', ${name}, ${gymId}, ${isPublic}, ${isUnlisted}, now(), now())
    RETURNING id
  `);
  return { id: Number(Array.from(result as Iterable<{ id: number }>)[0].id), uuid, slug: uuid };
};

const insertGymMember = (gymId: number, userId: string, role: string) =>
  db.execute(sql`
    INSERT INTO gym_members (gym_id, user_id, role, created_at)
    VALUES (${gymId}, ${userId}, ${role}, now())
  `);

const insertKiosk = async (gymId: number, slug: string): Promise<{ uuid: string }> => {
  const uuid = uuidv4();
  await db.execute(sql`
    INSERT INTO gym_kiosks (uuid, gym_id, slug, name, layout, created_at, updated_at)
    VALUES (${uuid}, ${gymId}, ${slug}, ${'Front Desk'}, ${'{"version":1,"boards":[],"leaderboard":null}'}::jsonb, now(), now())
  `);
  return { uuid };
};

let publicGym: { id: number; uuid: string; slug: string };
let privateGym: { id: number; uuid: string; slug: string };
let publicBoard: { id: number; uuid: string; slug: string };
let privateBoard: { id: number; uuid: string; slug: string };
let unlistedBoard: { id: number; uuid: string; slug: string };
let systemPrivateBoard: { id: number; uuid: string; slug: string };

beforeEach(async () => {
  await db.execute(sql`
    TRUNCATE TABLE
      "community_roles", "gym_kiosks", "gym_members", "gym_follows", "gym_claims",
      "board_follows", "boardsesh_ticks", "user_boards", "gyms"
    RESTART IDENTITY CASCADE
  `);

  await Promise.all(ALL_USERS.map(insertUser));

  publicGym = await insertGym({ ownerId: OWNER, name: 'Public Gym' });
  privateGym = await insertGym({ ownerId: OWNER, name: 'Private Gym', isPublic: false });
  // EDITOR holds gym-edit access on the PRIVATE gym — the "can edit, isn't the
  // owner" row of the matrix.
  await insertGymMember(privateGym.id, EDITOR, 'editor');

  publicBoard = await insertBoard({ gymId: publicGym.id, ownerId: OWNER, name: 'Public Wall', isPublic: true });
  privateBoard = await insertBoard({ gymId: publicGym.id, ownerId: OWNER, name: 'Private Wall', isPublic: false });
  unlistedBoard = await insertBoard({
    gymId: publicGym.id,
    ownerId: OWNER,
    name: 'Unlisted Wall',
    isPublic: true,
    isUnlisted: true,
  });
  // A non-public board owned by the system user: the shared per-config feeds
  // anonymous viewers are first-class for. isRowAnonReadable keeps it readable.
  systemPrivateBoard = await insertBoard({
    gymId: null,
    ownerId: SYSTEM_BOARD_OWNER_ID,
    name: 'Shared MoonBoard Config',
    isPublic: false,
  });
});

// ============================================================================
// gym(gymUuid) / gymBySlug — masked for anyone without gym edit access
// ============================================================================

describe('gym / gymBySlug anonymous + non-editor masking', () => {
  it('returns a PUBLIC gym to an anonymous caller, by uuid and by slug', async () => {
    const byUuid = await socialGymQueries.gym(null, { gymUuid: publicGym.uuid }, anonCtx());
    const bySlug = await socialGymQueries.gymBySlug(null, { slug: publicGym.slug }, anonCtx());

    expect(byUuid?.name).toBe('Public Gym');
    expect(bySlug?.name).toBe('Public Gym');
  });

  it('masks a PRIVATE gym from an anonymous caller, by uuid and by slug', async () => {
    expect(await socialGymQueries.gym(null, { gymUuid: privateGym.uuid }, anonCtx())).toBeNull();
    expect(await socialGymQueries.gymBySlug(null, { slug: privateGym.slug }, anonCtx())).toBeNull();
  });

  it('masks a PRIVATE gym from an authenticated caller with no edit access', async () => {
    expect(await socialGymQueries.gym(null, { gymUuid: privateGym.uuid }, authCtx(STRANGER))).toBeNull();
    expect(await socialGymQueries.gymBySlug(null, { slug: privateGym.slug }, authCtx(STRANGER))).toBeNull();
  });

  it('returns a PRIVATE gym to its owner', async () => {
    const byUuid = await socialGymQueries.gym(null, { gymUuid: privateGym.uuid }, authCtx(OWNER));
    const bySlug = await socialGymQueries.gymBySlug(null, { slug: privateGym.slug }, authCtx(OWNER));

    expect(byUuid?.name).toBe('Private Gym');
    expect(byUuid?.canEdit).toBe(true);
    expect(bySlug?.name).toBe('Private Gym');
  });

  it('returns a PRIVATE gym to a gym editor who is not the owner', async () => {
    const byUuid = await socialGymQueries.gym(null, { gymUuid: privateGym.uuid }, authCtx(EDITOR));
    const bySlug = await socialGymQueries.gymBySlug(null, { slug: privateGym.slug }, authCtx(EDITOR));

    expect(byUuid?.name).toBe('Private Gym');
    expect(byUuid?.canEdit).toBe(true);
    expect(bySlug?.name).toBe('Private Gym');
  });

  it('masks a private gym identically to a gym that does not exist', async () => {
    const missing = await socialGymQueries.gym(null, { gymUuid: uuidv4() }, anonCtx());
    const priv = await socialGymQueries.gym(null, { gymUuid: privateGym.uuid }, anonCtx());

    expect(priv).toEqual(missing);
    expect(priv).toBeNull();
  });

  it('still masks a private gym reached through a merged twin uuid/slug', async () => {
    // A deduped twin resolves to the canonical survivor; when the SURVIVOR is
    // private, the masking must apply after the merge hop, not before it.
    const twin = await insertGym({
      ownerId: OWNER,
      name: 'Merged Twin',
      deleted: true,
      mergedIntoGymId: privateGym.id,
    });

    expect(await socialGymQueries.gym(null, { gymUuid: twin.uuid }, anonCtx())).toBeNull();
    expect(await socialGymQueries.gymBySlug(null, { slug: twin.slug }, anonCtx())).toBeNull();

    const forOwner = await socialGymQueries.gymBySlug(null, { slug: twin.slug }, authCtx(OWNER));
    expect(forOwner?.uuid).toBe(privateGym.uuid);
  });
});

// ============================================================================
// board(boardUuid) — masked for ANONYMOUS callers only
// ============================================================================

describe('board(boardUuid) anonymous masking', () => {
  it('returns a PUBLIC board to an anonymous caller', async () => {
    const board = await socialBoardQueries.board(null, { boardUuid: publicBoard.uuid }, anonCtx());
    expect(board?.name).toBe('Public Wall');
  });

  it('masks a PRIVATE board from an anonymous caller', async () => {
    expect(await socialBoardQueries.board(null, { boardUuid: privateBoard.uuid }, anonCtx())).toBeNull();
  });

  it('masks a private board identically to a board that does not exist', async () => {
    const missing = await socialBoardQueries.board(null, { boardUuid: uuidv4() }, anonCtx());
    const priv = await socialBoardQueries.board(null, { boardUuid: privateBoard.uuid }, anonCtx());

    expect(priv).toEqual(missing);
    expect(priv).toBeNull();
  });

  it('returns a PRIVATE board to its owner', async () => {
    const board = await socialBoardQueries.board(null, { boardUuid: privateBoard.uuid }, authCtx(OWNER));
    expect(board?.name).toBe('Private Wall');
    expect(board?.canEdit).toBe(true);
    expect(board?.boardId).toBe(privateBoard.id);
  });

  it('ASYMMETRY PIN: still returns a PRIVATE board to an authenticated non-owner', async () => {
    // Deliberately NOT masked for signed-in callers — matches
    // requireAnonReadableBoard and keeps the BLE connect flow
    // (bluetooth-provider resolves a gym's private board by uuid) and
    // boardsBySerialNumbers working. Changing this breaks those flows.
    const board = await socialBoardQueries.board(null, { boardUuid: privateBoard.uuid }, authCtx(STRANGER));
    expect(board?.name).toBe('Private Wall');
    // The presence-channel id stays gated even so.
    expect(board?.boardId).toBeNull();
  });

  it('keeps an UNLISTED but public board readable anonymously by uuid', async () => {
    // Unlisted means "link-only, never enumerated" — direct uuid reads still
    // resolve it. Only enumerating reads (searchBoards, gymBoards) filter it.
    const board = await socialBoardQueries.board(null, { boardUuid: unlistedBoard.uuid }, anonCtx());
    expect(board?.name).toBe('Unlisted Wall');
  });

  it('keeps a non-public SYSTEM-owned board readable anonymously', async () => {
    const board = await socialBoardQueries.board(null, { boardUuid: systemPrivateBoard.uuid }, anonCtx());
    expect(board?.name).toBe('Shared MoonBoard Config');
  });
});

// ============================================================================
// boardBySlug — same anonymous-only mask as board(boardUuid)
// ============================================================================

describe('boardBySlug anonymous masking', () => {
  it('masks a PRIVATE board identically to a board that does not exist', async () => {
    const missing = await socialBoardQueries.boardBySlug(null, { slug: uuidv4() }, anonCtx());
    const privateResult = await socialBoardQueries.boardBySlug(null, { slug: privateBoard.slug }, anonCtx());

    expect(privateResult).toEqual(missing);
    expect(privateResult).toBeNull();
  });

  it.each([
    ['PUBLIC', () => publicBoard, 'Public Wall'],
    ['UNLISTED but public', () => unlistedBoard, 'Unlisted Wall'],
    ['non-public SYSTEM-owned', () => systemPrivateBoard, 'Shared MoonBoard Config'],
  ] as const)('keeps a %s board readable anonymously', async (_label, getBoard, expectedName) => {
    const board = getBoard();
    const result = await socialBoardQueries.boardBySlug(null, { slug: board.slug }, anonCtx());
    expect(result?.name).toBe(expectedName);
  });

  it('returns a PRIVATE board to its owner', async () => {
    const board = await socialBoardQueries.boardBySlug(null, { slug: privateBoard.slug }, authCtx(OWNER));
    expect(board?.name).toBe('Private Wall');
    expect(board?.canEdit).toBe(true);
  });

  it('returns a PRIVATE board to an authenticated non-owner', async () => {
    const board = await socialBoardQueries.boardBySlug(null, { slug: privateBoard.slug }, authCtx(STRANGER));
    expect(board?.name).toBe('Private Wall');
    expect(board?.boardId).toBeNull();
  });
});

// ============================================================================
// Regression pins: the epic's reads keep their existing masking
// ============================================================================

describe('gymBoards / gymKiosk keep their existing masking', () => {
  it('gymBoards throws NOT_FOUND for a private gym seen anonymously', async () => {
    await expect(socialBoardQueries.gymBoards(null, { gymUuid: privateGym.uuid }, anonCtx())).rejects.toMatchObject({
      message: 'Gym not found',
      extensions: { code: 'NOT_FOUND' },
    });
  });

  it('gymBoards returns the linked boards to a gym editor', async () => {
    const boards = await socialBoardQueries.gymBoards(null, { gymUuid: privateGym.uuid }, authCtx(EDITOR));
    expect(boards).toEqual([]);
  });

  it('gymKiosk returns null for a private gym seen anonymously', async () => {
    await insertKiosk(privateGym.id, 'front-desk');
    expect(await socialGymKioskQueries.gymKiosk(null, { gymSlug: privateGym.slug }, anonCtx())).toBeNull();
  });

  it('gymKiosk returns the kiosk to a gym editor', async () => {
    await insertKiosk(privateGym.id, 'front-desk');
    const kiosk = await socialGymKioskQueries.gymKiosk(null, { gymSlug: privateGym.slug }, authCtx(EDITOR));
    expect(kiosk?.name).toBe('Front Desk');
  });
});
