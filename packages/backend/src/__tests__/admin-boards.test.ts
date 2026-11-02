import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { eq, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../db/client';
import { adminBoardMutations, adminBoardQueries } from '../graphql/resolvers/social/admin-boards';
import { socialBoardMutations, socialBoardQueries } from '../graphql/resolvers/social/boards';

const ADMIN = 'admin-boards-global';
const SCOPED_ADMIN = 'admin-boards-scoped';
const LEADER = 'admin-boards-leader';
const OWNER = 'admin-boards-owner';
const SYSTEM_OWNER = '00000000-0000-0000-0000-000000000000';

const context = (userId?: string): ConnectionContext =>
  ({ connectionId: `admin-boards-${userId ?? 'anon'}`, isAuthenticated: !!userId, userId }) as ConnectionContext;

async function insertBoard(overrides: Partial<typeof dbSchema.userBoards.$inferInsert> = {}) {
  const uuid = uuidv4();
  const [board] = await db
    .insert(dbSchema.userBoards)
    .values({
      uuid,
      slug: uuid,
      ownerId: OWNER,
      name: 'MoonBoard',
      boardType: 'moonboard',
      layoutId: 2,
      sizeId: 1,
      setIds: '2,3,4',
      isPublic: false,
      locationName: 'Private board location',
      latitude: 51.5,
      longitude: -0.1,
      hideLocation: true,
      serialNumber: 'PRIVATE-SERIAL',
      timerName: 'PRIVATE-TIMER',
      ...overrides,
    })
    .returning();
  return board;
}

beforeEach(async () => {
  await db.execute(sql`TRUNCATE TABLE community_roles, user_boards, gyms, resource_privacy RESTART IDENTITY CASCADE`);
  await db
    .insert(dbSchema.users)
    .values([ADMIN, SCOPED_ADMIN, LEADER, OWNER, SYSTEM_OWNER].map((id) => ({ id, email: `${id}@test.com`, name: id })))
    .onConflictDoNothing();
  await db.insert(dbSchema.communityRoles).values([
    { userId: ADMIN, role: 'admin', boardType: null },
    { userId: SCOPED_ADMIN, role: 'admin', boardType: 'moonboard' },
    { userId: LEADER, role: 'community_leader', boardType: null },
  ]);
});

describe('admin board operations authorization', () => {
  it('denies anonymous, ordinary, leader, and board-scoped admin callers', async () => {
    const board = await insertBoard();
    for (const caller of [context(), context(OWNER), context(LEADER), context(SCOPED_ADMIN)]) {
      await expect(adminBoardQueries.adminBoards(null, { input: {} }, caller)).rejects.toThrow();
      await expect(adminBoardQueries.adminBoard(null, { boardUuid: board.uuid }, caller)).rejects.toThrow();
      await expect(
        adminBoardMutations.adminUpdateBoard(null, { input: { boardUuid: board.uuid, name: 'Changed' } }, caller),
      ).rejects.toThrow();
    }
  });

  it('returns raw private metadata only through the dedicated admin projection', async () => {
    const board = await insertBoard();
    expect(await socialBoardQueries.board(null, { boardUuid: board.uuid }, context(ADMIN))).toBeNull();
    await expect(
      socialBoardMutations.updateBoard(null, { input: { boardUuid: board.uuid, name: 'Changed' } }, context(ADMIN)),
    ).rejects.toThrow();
    const detail = await adminBoardQueries.adminBoard(null, { boardUuid: board.uuid }, context(ADMIN));
    expect(detail).toMatchObject({
      uuid: board.uuid,
      locationName: 'Private board location',
      latitude: 51.5,
      longitude: -0.1,
      serialNumber: null,
      timerName: null,
      canEdit: true,
    });
    expect(detail).not.toHaveProperty('totalAscents');
  });
});

describe('admin board registry', () => {
  it('includes private, unlisted, system-owned and unlinked boards, excluding deleted and merged rows', async () => {
    const privateBoard = await insertBoard();
    const unlisted = await insertBoard({ isUnlisted: true, serialNumber: null });
    const system = await insertBoard({ ownerId: SYSTEM_OWNER, serialNumber: null });
    await insertBoard({ deletedAt: new Date(), serialNumber: null });
    await insertBoard({ mergedIntoBoardUuid: privateBoard.uuid, serialNumber: null });
    const result = await adminBoardQueries.adminBoards(null, { input: {} }, context(ADMIN));
    expect(result.totalCount).toBe(3);
    expect(result.boards.map((board) => board.uuid)).toEqual([system.uuid, unlisted.uuid, privateBoard.uuid]);
    expect(result.hasMore).toBe(false);
  });

  it('searches gym name/slug and board name/slug/UUID, with stable pagination and type filtering', async () => {
    const [gym] = await db
      .insert(dbSchema.gyms)
      .values({
        uuid: uuidv4(),
        slug: 'bowlo',
        name: 'Bowlo Climbing',
        ownerId: OWNER,
        isPublic: false,
        isListed: false,
      })
      .returning();
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    const first = await insertBoard({ gymId: gym.id, name: 'Back room', slug: 'back-room', createdAt });
    const second = await insertBoard({ serialNumber: null, gymId: gym.id, name: 'Front room', createdAt });
    for (const query of ['BOWLO', 'Climbing', 'Back room', 'back-room', first.uuid]) {
      const result = await adminBoardQueries.adminBoards(null, { input: { query } }, context(ADMIN));
      expect(result.boards.map((board) => board.uuid)).toContain(first.uuid);
    }
    const page = await adminBoardQueries.adminBoards(null, { input: { query: 'bowlo', limit: 1 } }, context(ADMIN));
    expect(page).toMatchObject({ totalCount: 2, hasMore: true });
    expect(page.boards[0].uuid).toBe(second.uuid);
    const next = await adminBoardQueries.adminBoards(
      null,
      { input: { query: 'bowlo', limit: 1, offset: 1 } },
      context(ADMIN),
    );
    expect(next.boards[0].uuid).toBe(first.uuid);
    expect(next.hasMore).toBe(false);
    expect(
      (await adminBoardQueries.adminBoards(null, { input: { boardType: 'kilter' } }, context(ADMIN))).totalCount,
    ).toBe(0);
  });

  it('validates search bounds and returns null for unavailable board details', async () => {
    for (const input of [{ limit: 51 }, { offset: -1 }, { query: 'a'.repeat(201) }, { boardType: 'invalid' }]) {
      await expect(adminBoardQueries.adminBoards(null, { input }, context(ADMIN))).rejects.toThrow();
    }
    const deleted = await insertBoard({ deletedAt: new Date() });
    expect(await adminBoardQueries.adminBoard(null, { boardUuid: deleted.uuid }, context(ADMIN))).toBeNull();
    expect(await adminBoardQueries.adminBoard(null, { boardUuid: uuidv4() }, context(ADMIN))).toBeNull();
  });
});

describe('admin board updates', () => {
  it('rejects a catalogue board deleted after lookup but before its row lock', async () => {
    const board = await insertBoard();
    const originalTransaction = db.transaction.bind(db);
    const transaction = vi.spyOn(db, 'transaction').mockImplementationOnce(async (callback, configuration) => {
      await db.update(dbSchema.userBoards).set({ deletedAt: new Date() }).where(eq(dbSchema.userBoards.id, board.id));
      return originalTransaction(callback, configuration);
    });
    try {
      await expect(
        adminBoardMutations.adminUpdateBoard(
          null,
          {
            input: { boardUuid: board.uuid, name: 'Should not land' },
          },
          context(ADMIN),
        ),
      ).rejects.toThrow('Board not found');
      const [stored] = await db.select().from(dbSchema.userBoards).where(eq(dbSchema.userBoards.id, board.id));
      expect(stored.name).toBe('MoonBoard');
      expect(stored.deletedAt).not.toBeNull();
    } finally {
      transaction.mockRestore();
    }
  });

  it('rechecks ownership before changing owner-only credentials', async () => {
    const board = await insertBoard({ ownerId: ADMIN });
    const originalTransaction = db.transaction.bind(db);
    const transaction = vi.spyOn(db, 'transaction').mockImplementationOnce(async (callback, configuration) => {
      await db.update(dbSchema.userBoards).set({ ownerId: OWNER }).where(eq(dbSchema.userBoards.id, board.id));
      return originalTransaction(callback, configuration);
    });
    try {
      await expect(
        adminBoardMutations.adminUpdateBoard(
          null,
          {
            input: { boardUuid: board.uuid, serialNumber: null },
          },
          context(ADMIN),
        ),
      ).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
      const [stored] = await db.select().from(dbSchema.userBoards).where(eq(dbSchema.userBoards.id, board.id));
      expect(stored.serialNumber).toBe('PRIVATE-SERIAL');
    } finally {
      transaction.mockRestore();
    }
  });

  it('validates partial config changes against the locked configuration', async () => {
    const board = await insertBoard({ setIds: '2' });
    const originalTransaction = db.transaction.bind(db);
    const transaction = vi.spyOn(db, 'transaction').mockImplementationOnce(async (callback, configuration) => {
      await db
        .update(dbSchema.userBoards)
        .set({ layoutId: 3, setIds: '5' })
        .where(eq(dbSchema.userBoards.id, board.id));
      return originalTransaction(callback, configuration);
    });
    try {
      await expect(
        adminBoardMutations.adminUpdateBoard(
          null,
          {
            input: { boardUuid: board.uuid, setIds: '3' },
          },
          context(ADMIN),
        ),
      ).rejects.toMatchObject({ extensions: { code: 'UNKNOWN_BOARD_CONFIG' } });
      const [stored] = await db.select().from(dbSchema.userBoards).where(eq(dbSchema.userBoards.id, board.id));
      expect(stored).toMatchObject({ layoutId: 3, setIds: '5' });
    } finally {
      transaction.mockRestore();
    }
  });

  it.each([
    { access: 'standard', initialLocation: 'Away', lockedLocation: 'Home', blocked: true },
    { access: 'admin', initialLocation: 'Away', lockedLocation: 'Home', blocked: true },
    { access: 'admin', initialLocation: 'Home', lockedLocation: 'Away', blocked: false },
  ] as const)(
    'checks a $access config edit at the locked location ($initialLocation → $lockedLocation)',
    async ({ access, initialLocation, lockedLocation, blocked }) => {
      const targetSets = '5,6,7,8,9,10';
      await insertBoard({
        layoutId: 3,
        setIds: targetSets,
        locationName: 'Home',
        latitude: null,
        longitude: null,
        serialNumber: null,
      });
      const board = await insertBoard({
        layoutId: 3,
        setIds: '5,6,7',
        locationName: initialLocation,
        latitude: null,
        longitude: null,
        serialNumber: null,
      });
      const originalTransaction = db.transaction.bind(db);
      // Commit the other editor's location after lookup, before the writer
      // acquires its row lock, so the save must derive the current location.
      const transaction = vi.spyOn(db, 'transaction').mockImplementationOnce(async (callback, configuration) => {
        await db
          .update(dbSchema.userBoards)
          .set({ locationName: lockedLocation })
          .where(eq(dbSchema.userBoards.id, board.id));
        return originalTransaction(callback, configuration);
      });
      try {
        const save = access === 'admin' ? adminBoardMutations.adminUpdateBoard : socialBoardMutations.updateBoard;
        const update = save(
          null,
          { input: { boardUuid: board.uuid, setIds: targetSets } },
          context(access === 'admin' ? ADMIN : OWNER),
        );
        if (blocked) {
          await expect(update).rejects.toMatchObject({ extensions: { code: 'BOARD_DUPLICATE_CONFIG' } });
        } else {
          await expect(update).resolves.toMatchObject({ setIds: targetSets });
        }
        const [stored] = await db.select().from(dbSchema.userBoards).where(eq(dbSchema.userBoards.id, board.id));
        expect(stored).toMatchObject({ locationName: lockedLocation, setIds: blocked ? '5,6,7' : targetSets });
      } finally {
        transaction.mockRestore();
      }
    },
  );

  it('uses the locked owner for duplicate detection and keeps their sibling identity private', async () => {
    const targetSets = '5,6,7,8,9,10';
    await insertBoard({ layoutId: 3, setIds: targetSets, serialNumber: null });
    const board = await insertBoard({ ownerId: ADMIN, layoutId: 3, setIds: '5,6,7', serialNumber: null });
    const originalTransaction = db.transaction.bind(db);
    const transaction = vi.spyOn(db, 'transaction').mockImplementationOnce(async (callback, configuration) => {
      await db.update(dbSchema.userBoards).set({ ownerId: OWNER }).where(eq(dbSchema.userBoards.id, board.id));
      return originalTransaction(callback, configuration);
    });
    try {
      await expect(
        adminBoardMutations.adminUpdateBoard(
          null,
          { input: { boardUuid: board.uuid, setIds: targetSets } },
          context(ADMIN),
        ),
      ).rejects.toHaveProperty('extensions', { code: 'BOARD_DUPLICATE_CONFIG' });
      const [stored] = await db.select().from(dbSchema.userBoards).where(eq(dbSchema.userBoards.id, board.id));
      expect(stored).toMatchObject({ ownerId: OWNER, setIds: '5,6,7' });
    } finally {
      transaction.mockRestore();
    }
  });

  it('renames a private gym board without changing its slug, credentials, location, ticks or gym', async () => {
    const [gym] = await db.insert(dbSchema.gyms).values({ uuid: uuidv4(), name: 'Bowlo', ownerId: OWNER }).returning();
    const board = await insertBoard({ gymId: gym.id });
    const [tick] = await db
      .insert(dbSchema.boardseshTicks)
      .values({
        uuid: uuidv4(),
        userId: OWNER,
        boardType: 'moonboard',
        boardId: board.id,
        climbUuid: 'admin-boards-climb',
        angle: 40,
        status: 'send',
        climbedAt: new Date().toISOString(),
      })
      .returning();
    const updated = await adminBoardMutations.adminUpdateBoard(
      null,
      {
        input: { boardUuid: board.uuid, name: 'Bowlo MoonBoard' },
      },
      context(ADMIN),
    );
    expect(updated).toMatchObject({ name: 'Bowlo MoonBoard', slug: board.slug, gymUuid: gym.uuid, serialNumber: null });
    const [stored] = await db.select().from(dbSchema.userBoards).where(eq(dbSchema.userBoards.id, board.id));
    expect(stored).toMatchObject({
      serialNumber: 'PRIVATE-SERIAL',
      timerName: 'PRIVATE-TIMER',
      latitude: 51.5,
      longitude: -0.1,
      gymId: gym.id,
      isPublic: false,
    });
    expect(stored.syncFrozenAt).not.toBeNull();
    expect(await db.select().from(dbSchema.boardseshTicks).where(eq(dbSchema.boardseshTicks.id, tick.id))).toEqual([
      tick,
    ]);
  });

  it.each(['isPublic', 'isUnlisted', 'hideLocation', 'serialNumber', 'timerName'] as const)(
    'rejects supplied nonowner %s even if unchanged',
    async (field) => {
      const board = await insertBoard();
      await expect(
        adminBoardMutations.adminUpdateBoard(
          null,
          {
            input: { boardUuid: board.uuid, [field]: board[field] },
          },
          context(ADMIN),
        ),
      ).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    },
  );

  it('allows owner credentials and privacy, and clears nullable metadata', async () => {
    const board = await insertBoard({ ownerId: ADMIN });
    expect(await adminBoardQueries.adminBoard(null, { boardUuid: board.uuid }, context(ADMIN))).toMatchObject({
      serialNumber: 'PRIVATE-SERIAL',
      timerName: 'PRIVATE-TIMER',
    });
    const updated = await adminBoardMutations.adminUpdateBoard(
      null,
      {
        input: {
          boardUuid: board.uuid,
          description: null,
          locationName: null,
          latitude: null,
          longitude: null,
          serialNumber: null,
          timerName: null,
          isPublic: true,
        },
      },
      context(ADMIN),
    );
    expect(updated).toMatchObject({
      description: null,
      locationName: null,
      latitude: null,
      longitude: null,
      serialNumber: null,
      timerName: null,
      isPublic: true,
    });
  });

  it('preserves deleted boards and enforces catalogue and slug validation', async () => {
    const deleted = await insertBoard({ ownerId: ADMIN, deletedAt: new Date() });
    await expect(
      adminBoardMutations.adminUpdateBoard(
        null,
        { input: { boardUuid: deleted.uuid, name: 'Restored' } },
        context(ADMIN),
      ),
    ).rejects.toThrow('Board not found');
    const board = await insertBoard({ serialNumber: null });
    await expect(
      adminBoardMutations.adminUpdateBoard(null, { input: { boardUuid: board.uuid, layoutId: 999 } }, context(ADMIN)),
    ).rejects.toMatchObject({ extensions: { code: 'UNKNOWN_BOARD_CONFIG' } });
    await expect(
      adminBoardMutations.adminUpdateBoard(
        null,
        { input: { boardUuid: board.uuid, slug: deleted.slug } },
        context(ADMIN),
      ),
    ).resolves.toMatchObject({ slug: deleted.slug });
    const sibling = await insertBoard({ serialNumber: null });
    await expect(
      adminBoardMutations.adminUpdateBoard(
        null,
        { input: { boardUuid: sibling.uuid, slug: deleted.slug } },
        context(ADMIN),
      ),
    ).rejects.toThrow('Slug is already taken');
  });

  it.each([{ layoutId: 2 }, { angle: 45 }, { hasLeds: false }, { isAngleAdjustable: false }, { hideLocation: true }])(
    'keeps spray wall setup in its dedicated workflow (%j)',
    async (input) => {
      const board = await insertBoard({ ownerId: ADMIN, boardType: 'spray', serialNumber: null });
      await expect(
        adminBoardMutations.adminUpdateBoard(null, { input: { boardUuid: board.uuid, ...input } }, context(ADMIN)),
      ).rejects.toMatchObject({ extensions: { code: 'SPRAY_WALL_SETTINGS_ELSEWHERE' } });
    },
  );
});
