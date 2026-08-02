import { describe, it, expect, beforeEach } from 'vite-plus/test';
import { v4 as uuidv4 } from 'uuid';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { socialGymQueries, socialGymMutations } from '../graphql/resolvers/social/gyms';
import { socialBoardQueries } from '../graphql/resolvers/social/boards';

/**
 * Real-DB coverage for PR D's gym-branding + gymBoards + UserBoard.boardId
 * surface:
 *   - updateGym persists the four branding columns (round-trip + null-clears),
 *     and rejects a malformed hex colour.
 *   - gymBoards is viewer-scoped: editors see every linked board; anon /
 *     non-editors see only public boards; a private gym is masked as NOT_FOUND
 *     to non-editors.
 *   - UserBoard.boardId is populated only when the board is public or the viewer
 *     can edit it, else null.
 *
 * Seeds via raw SQL and calls the resolvers directly against the per-worker test
 * DB, mirroring gym-write-access-and-claims.test.ts.
 */

const OWNER = 'gb-owner';
const EDITOR = 'gb-editor';
const RANDOM = 'gb-random';
const ALL_USERS = [OWNER, EDITOR, RANDOM];

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
}): Promise<{
  id: number;
  uuid: string;
}> => {
  const { ownerId, name, isPublic = true } = opts;
  const uuid = uuidv4();
  const result = await db.execute(sql`
    INSERT INTO gyms (uuid, name, slug, owner_id, is_public, created_at, updated_at)
    VALUES (${uuid}, ${name}, ${uuid}, ${ownerId}, ${isPublic}, now(), now())
    RETURNING id
  `);
  return { id: Number(Array.from(result as Iterable<{ id: number }>)[0].id), uuid };
};

// Each board gets a distinct size_id so a single owner's several boards in this
// suite stay distinguishable. These rows are inserted directly rather than via
// createBoard, and the DB unique index was dropped in #4166, so nothing enforces
// config uniqueness on them any more — the distinct size_id is now just a
// readable-fixture convention.
let boardConfigCounter = 0;
const insertBoard = async (opts: {
  gymId: number;
  ownerId: string;
  name: string;
  isPublic: boolean;
  isUnlisted?: boolean;
}): Promise<{ id: number; uuid: string }> => {
  const { gymId, ownerId, name, isPublic, isUnlisted = false } = opts;
  const uuid = uuidv4();
  const sizeId = 10 + boardConfigCounter++;
  const result = await db.execute(sql`
    INSERT INTO user_boards
      (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, gym_id, is_public, is_unlisted, created_at, updated_at)
    VALUES (${uuid}, ${uuid}, ${ownerId}, 'kilter', 1, ${sizeId}, '1,2', ${name}, ${gymId}, ${isPublic}, ${isUnlisted}, now(), now())
    RETURNING id
  `);
  return { id: Number(Array.from(result as Iterable<{ id: number }>)[0].id), uuid };
};

const insertGymMember = (gymId: number, userId: string, role: string) =>
  db.execute(sql`
    INSERT INTO gym_members (gym_id, user_id, role, created_at)
    VALUES (${gymId}, ${userId}, ${role}, now())
  `);

// Public gym owned by OWNER, EDITOR is an editor member. Three boards: one
// public, one private, one public-but-unlisted. Plus a private gym (owned by
// OWNER) with a single public board.
let publicGymUuid: string;
let privateGymUuid: string;
let pubBoard: { id: number; uuid: string };
let privBoard: { id: number; uuid: string };
let unlistedBoard: { id: number; uuid: string };

beforeEach(async () => {
  await db.execute(sql`
    TRUNCATE TABLE
      "community_roles", "gym_members", "gym_follows", "gym_claims",
      "board_follows", "boardsesh_ticks", "user_boards", "gyms"
    RESTART IDENTITY CASCADE
  `);

  await Promise.all(ALL_USERS.map(insertUser));

  const publicGym = await insertGym({ ownerId: OWNER, name: 'Public Gym' });
  publicGymUuid = publicGym.uuid;
  await insertGymMember(publicGym.id, EDITOR, 'editor');
  pubBoard = await insertBoard({ gymId: publicGym.id, ownerId: OWNER, name: 'A Public Wall', isPublic: true });
  privBoard = await insertBoard({ gymId: publicGym.id, ownerId: OWNER, name: 'B Private Wall', isPublic: false });
  unlistedBoard = await insertBoard({
    gymId: publicGym.id,
    ownerId: OWNER,
    name: 'C Unlisted Wall',
    isPublic: true,
    isUnlisted: true,
  });

  const privateGym = await insertGym({ ownerId: OWNER, name: 'Private Gym', isPublic: false });
  privateGymUuid = privateGym.uuid;
  await insertBoard({ gymId: privateGym.id, ownerId: OWNER, name: 'Hidden Wall', isPublic: true });
});

// ============================================================================
// Branding on updateGym
// ============================================================================

describe('updateGym branding', () => {
  it('round-trips all four branding fields', async () => {
    await socialGymMutations.updateGym(
      null,
      {
        input: {
          gymUuid: publicGymUuid,
          logoUrl: 'https://cdn.example.com/logo.png',
          brandPrimaryColor: '#1a2b3c',
          brandAccentColor: '#ABCDEF',
          brandBackgroundColor: '#000000',
        },
      },
      authCtx(OWNER),
    );

    const gym = await socialGymQueries.gym(null, { gymUuid: publicGymUuid }, authCtx(OWNER));
    expect(gym).not.toBeNull();
    expect(gym!.logoUrl).toBe('https://cdn.example.com/logo.png');
    expect(gym!.brandPrimaryColor).toBe('#1a2b3c');
    expect(gym!.brandAccentColor).toBe('#ABCDEF');
    expect(gym!.brandBackgroundColor).toBe('#000000');
  });

  it('accepts a Boardsesh static logo path', async () => {
    await socialGymMutations.updateGym(
      null,
      { input: { gymUuid: publicGymUuid, logoUrl: `/static/gym-logos/${uuidv4()}.png?v=abc` } },
      authCtx(OWNER),
    );
    const gym = await socialGymQueries.gym(null, { gymUuid: publicGymUuid }, authCtx(OWNER));
    expect(gym!.logoUrl).toMatch(/^\/static\/gym-logos\//);
  });

  it('clears branding fields when passed null', async () => {
    await socialGymMutations.updateGym(
      null,
      {
        input: {
          gymUuid: publicGymUuid,
          logoUrl: 'https://cdn.example.com/logo.png',
          brandPrimaryColor: '#112233',
        },
      },
      authCtx(OWNER),
    );

    await socialGymMutations.updateGym(
      null,
      { input: { gymUuid: publicGymUuid, logoUrl: null, brandPrimaryColor: null } },
      authCtx(OWNER),
    );

    const gym = await socialGymQueries.gym(null, { gymUuid: publicGymUuid }, authCtx(OWNER));
    expect(gym!.logoUrl).toBeNull();
    expect(gym!.brandPrimaryColor).toBeNull();
  });

  it('rejects a malformed hex colour', async () => {
    await expect(
      socialGymMutations.updateGym(
        null,
        { input: { gymUuid: publicGymUuid, brandPrimaryColor: 'red' } },
        authCtx(OWNER),
      ),
    ).rejects.toThrow();

    await expect(
      socialGymMutations.updateGym(
        null,
        { input: { gymUuid: publicGymUuid, brandPrimaryColor: '#fff' } },
        authCtx(OWNER),
      ),
    ).rejects.toThrow();
  });

  it('rejects a non-https logo URL', async () => {
    await expect(
      socialGymMutations.updateGym(
        null,
        { input: { gymUuid: publicGymUuid, logoUrl: 'http://cdn.example.com/logo.png' } },
        authCtx(OWNER),
      ),
    ).rejects.toThrow();
  });
});

// ============================================================================
// gymBoards visibility
// ============================================================================

describe('gymBoards visibility', () => {
  it('shows every linked board to a gym editor (incl. private and unlisted)', async () => {
    for (const viewer of [OWNER, EDITOR]) {
      const boards = await socialBoardQueries.gymBoards(null, { gymUuid: publicGymUuid }, authCtx(viewer));
      const uuids = boards.map((b) => b.uuid).sort();
      expect(uuids).toEqual([pubBoard.uuid, privBoard.uuid, unlistedBoard.uuid].sort());
    }
  });

  it('shows only publicly listed boards to an anonymous viewer', async () => {
    const boards = await socialBoardQueries.gymBoards(null, { gymUuid: publicGymUuid }, anonCtx());
    expect(boards.map((b) => b.uuid)).toEqual([pubBoard.uuid]);
  });

  it('excludes a public-but-unlisted board for anonymous viewers (link-only, never enumerated)', async () => {
    const boards = await socialBoardQueries.gymBoards(null, { gymUuid: publicGymUuid }, anonCtx());
    expect(boards.map((b) => b.uuid)).not.toContain(unlistedBoard.uuid);
  });

  it('shows only publicly listed boards to a signed-in non-editor', async () => {
    const boards = await socialBoardQueries.gymBoards(null, { gymUuid: publicGymUuid }, authCtx(RANDOM));
    expect(boards.map((b) => b.uuid)).toEqual([pubBoard.uuid]);
  });

  it('orders boards by name', async () => {
    const boards = await socialBoardQueries.gymBoards(null, { gymUuid: publicGymUuid }, authCtx(OWNER));
    expect(boards.map((b) => b.name)).toEqual(['A Public Wall', 'B Private Wall', 'C Unlisted Wall']);
  });

  it('masks a private gym as NOT_FOUND for anonymous viewers', async () => {
    await expect(socialBoardQueries.gymBoards(null, { gymUuid: privateGymUuid }, anonCtx())).rejects.toMatchObject({
      extensions: { code: 'NOT_FOUND' },
    });
  });

  it('masks a private gym as NOT_FOUND for signed-in non-editors', async () => {
    await expect(
      socialBoardQueries.gymBoards(null, { gymUuid: privateGymUuid }, authCtx(RANDOM)),
    ).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
  });

  it('lets the owner read a private gym boards', async () => {
    const boards = await socialBoardQueries.gymBoards(null, { gymUuid: privateGymUuid }, authCtx(OWNER));
    expect(boards.length).toBe(1);
  });

  it('throws NOT_FOUND for an unknown gym', async () => {
    await expect(socialBoardQueries.gymBoards(null, { gymUuid: uuidv4() }, authCtx(OWNER))).rejects.toMatchObject({
      extensions: { code: 'NOT_FOUND' },
    });
  });
});

// ============================================================================
// UserBoard.boardId nullness
// ============================================================================

describe('UserBoard.boardId', () => {
  it('is the numeric channel id for an anon viewer on a public board', async () => {
    const board = await socialBoardQueries.board(null, { boardUuid: pubBoard.uuid }, anonCtx());
    expect(board!.boardId).toBe(pubBoard.id);
  });

  it('is moot for an anon viewer on a private board — the whole board is masked', async () => {
    // Stronger than the contract this used to pin (board enriched, boardId
    // nulled): since #3648 an anonymous caller cannot see the private board at
    // all, so there is no payload left to leak a presence channel through.
    // boardId nulling still governs the reads that DO return a private board —
    // the gym-editor case below, and gymBoards.
    const board = await socialBoardQueries.board(null, { boardUuid: privBoard.uuid }, anonCtx());
    expect(board).toBeNull();
  });

  it('is the numeric channel id for the owner on their private board', async () => {
    const board = await socialBoardQueries.board(null, { boardUuid: privBoard.uuid }, authCtx(OWNER));
    expect(board!.boardId).toBe(privBoard.id);
  });

  it('exposes boardId on gymBoards for a public board to anon', async () => {
    const anonBoards = await socialBoardQueries.gymBoards(null, { gymUuid: publicGymUuid }, anonCtx());
    const anonPub = anonBoards.find((b) => b.uuid === pubBoard.uuid);
    expect(anonPub!.boardId).toBe(pubBoard.id);
  });

  it('exposes boardId on gymBoards for a private board to the board owner', async () => {
    const ownerBoards = await socialBoardQueries.gymBoards(null, { gymUuid: publicGymUuid }, authCtx(OWNER));
    const ownerPriv = ownerBoards.find((b) => b.uuid === privBoard.uuid);
    expect(ownerPriv!.boardId).toBe(privBoard.id);
  });

  it('withholds boardId from a gym editor on a private board they can only view', async () => {
    // A gym EDITOR can *see* the private board via gymBoards (gym-level access),
    // but boardId follows the stricter board-level edit gate — a gym editor is
    // not a board editor — so the private board's presence channel stays hidden.
    const editorBoards = await socialBoardQueries.gymBoards(null, { gymUuid: publicGymUuid }, authCtx(EDITOR));
    const editorPriv = editorBoards.find((b) => b.uuid === privBoard.uuid);
    expect(editorPriv).toBeDefined();
    expect(editorPriv!.boardId).toBeNull();
  });
});
