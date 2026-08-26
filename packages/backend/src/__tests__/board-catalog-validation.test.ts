import { createHash } from 'node:crypto';
import { count, eq, inArray } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import {
  MOONBOARD_LAYOUTS,
  MOONBOARD_SETS,
  MOONBOARD_SIZE,
  WOODS_LAYOUTS,
  WOODS_SETS,
  WOODS_SIZES,
  normaliseSetIds,
} from '@boardsesh/board-config';
import { db } from '../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { assertKnownBoardConfig } from '../graphql/resolvers/board-presence/board-catalog';
import { boardPresenceMutations } from '../graphql/resolvers/board-presence/mutations';
import { SYSTEM_BOARD_OWNER_ID } from '../graphql/resolvers/board-presence/shared';
import { socialBoardMutations } from '../graphql/resolvers/social/boards';
import { BoardPresenceConfigInputSchema, CreateBoardInputSchema, UpdateBoardInputSchema } from '../validation/schemas';
import { seedAuroraCatalogFixtures } from './helpers/board-catalog-fixture';

const PRODUCT_ID = 2_100_412_930;
const LAYOUT_ID = 2_100_412_931;
const SIZE_ID = 2_100_412_932;
const SET_A_ID = 2_100_412_933;
const SET_B_ID = 2_100_412_934;
const SET_C_ID = 2_100_412_939;
const OTHER_LAYOUT_ID = 2_100_412_935;
const OTHER_SIZE_ID = 2_100_412_936;
const UNKNOWN_LAYOUT_ID = 2_100_412_940;
const UNKNOWN_SIZE_ID = 2_100_412_941;
const UNKNOWN_SET_ID = 2_100_412_942;

const AUTO_GYM_USER_ID = 'board-catalog-auto-gym-user';
const PLAIN_CREATE_USER_ID = 'board-catalog-plain-create-user';
const SERIAL_USER_ID = 'board-catalog-serial-user';
const UPDATE_USER_ID = 'board-catalog-update-user';
const TEST_USER_IDS = [AUTO_GYM_USER_ID, PLAIN_CREATE_USER_ID, SERIAL_USER_ID, UPDATE_USER_ID];

let cleanupCatalogFixtures: () => Promise<void> = async () => {};
let systemOwnerExistedBeforeSuite = false;
const insertedSystemBoardIds = new Set<number>();

function authCtx(userId: string): ConnectionContext {
  return {
    connectionId: `catalog-${userId}-${Math.random().toString(36).slice(2)}`,
    isAuthenticated: true,
    userId,
  } as ConnectionContext;
}

function anonCtx(): ConnectionContext {
  return {
    connectionId: `catalog-anon-${Math.random().toString(36).slice(2)}`,
    isAuthenticated: false,
  } as ConnectionContext;
}

function presenceSlug(boardType: string, layoutId: number, sizeId: number, setIds: string): string {
  const normalizedSetIds = normaliseSetIds(setIds);
  const digest = createHash('sha256')
    .update(`${boardType}:${layoutId}:${sizeId}:${normalizedSetIds}`)
    .digest('hex')
    .slice(0, 20);
  return `presence-${boardType}-${layoutId}-${sizeId}-${digest}`;
}

async function insertTestBoard({
  ownerId,
  layoutId,
  sizeId,
  setIds,
  name = 'Catalog validation board',
  serialNumber = null,
  boardType = 'kilter',
}: {
  ownerId: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  name?: string;
  serialNumber?: string | null;
  boardType?: string;
}): Promise<typeof dbSchema.userBoards.$inferSelect> {
  const uuid = uuidv4();
  const [board] = await db
    .insert(dbSchema.userBoards)
    .values({
      uuid,
      slug: uuid,
      ownerId,
      boardType,
      layoutId,
      sizeId,
      setIds,
      name,
      serialNumber,
    })
    .returning();
  return board;
}

async function sideEffectCounts(userId: string): Promise<{
  boards: number;
  gyms: number;
  systemBoards: number;
  systemOwners: number;
}> {
  const [[boardCount], [gymCount], [systemBoardCount], [systemOwnerCount]] = await Promise.all([
    db.select({ total: count() }).from(dbSchema.userBoards).where(eq(dbSchema.userBoards.ownerId, userId)),
    db.select({ total: count() }).from(dbSchema.gyms).where(eq(dbSchema.gyms.ownerId, userId)),
    db
      .select({ total: count() })
      .from(dbSchema.userBoards)
      .where(eq(dbSchema.userBoards.ownerId, SYSTEM_BOARD_OWNER_ID)),
    db.select({ total: count() }).from(dbSchema.users).where(eq(dbSchema.users.id, SYSTEM_BOARD_OWNER_ID)),
  ]);
  return {
    boards: Number(boardCount?.total ?? 0),
    gyms: Number(gymCount?.total ?? 0),
    systemBoards: Number(systemBoardCount?.total ?? 0),
    systemOwners: Number(systemOwnerCount?.total ?? 0),
  };
}

async function expectUnknownBoardConfig(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    extensions: { code: 'UNKNOWN_BOARD_CONFIG' },
  });
}

beforeAll(async () => {
  const [existingSystemOwner] = await db
    .select({ id: dbSchema.users.id })
    .from(dbSchema.users)
    .where(eq(dbSchema.users.id, SYSTEM_BOARD_OWNER_ID))
    .limit(1);
  systemOwnerExistedBeforeSuite = existingSystemOwner !== undefined;

  cleanupCatalogFixtures = await seedAuroraCatalogFixtures([
    {
      boardType: 'kilter',
      productId: PRODUCT_ID,
      layoutId: LAYOUT_ID,
      sizeId: SIZE_ID,
      setIds: [SET_A_ID, SET_B_ID, SET_C_ID],
      placementSetIds: [SET_A_ID, SET_B_ID],
      associationIdBase: 2_100_412_950,
      isListed: false,
    },
    {
      boardType: 'kilter',
      productId: PRODUCT_ID,
      layoutId: OTHER_LAYOUT_ID,
      sizeId: SIZE_ID,
      setIds: [SET_A_ID],
      associationIdBase: 2_100_412_960,
      isListed: false,
    },
    {
      boardType: 'kilter',
      productId: PRODUCT_ID,
      layoutId: LAYOUT_ID,
      sizeId: OTHER_SIZE_ID,
      setIds: [SET_A_ID],
      associationIdBase: 2_100_412_970,
      isListed: false,
    },
  ]);
});

beforeEach(async () => {
  await db
    .insert(dbSchema.users)
    .values(
      TEST_USER_IDS.map((userId) => ({
        id: userId,
        email: `${userId}@test.boardsesh.com`,
        name: userId,
      })),
    )
    .onConflictDoNothing();
});

afterEach(async () => {
  if (insertedSystemBoardIds.size > 0) {
    await db.delete(dbSchema.userBoards).where(inArray(dbSchema.userBoards.id, [...insertedSystemBoardIds]));
    insertedSystemBoardIds.clear();
  }
  await db.delete(dbSchema.userBoards).where(inArray(dbSchema.userBoards.ownerId, TEST_USER_IDS));
  await db.delete(dbSchema.gyms).where(inArray(dbSchema.gyms.ownerId, TEST_USER_IDS));
  await db.delete(dbSchema.users).where(inArray(dbSchema.users.id, TEST_USER_IDS));
  vi.restoreAllMocks();
});

afterAll(async () => {
  await cleanupCatalogFixtures();
  if (!systemOwnerExistedBeforeSuite) {
    await db.delete(dbSchema.users).where(eq(dbSchema.users.id, SYSTEM_BOARD_OWNER_ID));
  }
});

describe('numeric board set CSV schemas', () => {
  it('share the strict grammar without transforming the submitted representation', () => {
    const submittedSetIds = '002,1,002';

    expect(
      BoardPresenceConfigInputSchema.parse({
        boardType: 'kilter',
        layoutId: 1,
        sizeId: 1,
        setIds: submittedSetIds,
      }).setIds,
    ).toBe(submittedSetIds);
    expect(
      CreateBoardInputSchema.parse({
        boardType: 'kilter',
        layoutId: 1,
        sizeId: 1,
        setIds: submittedSetIds,
        name: 'Schema test board',
      }).setIds,
    ).toBe(submittedSetIds);
    expect(
      UpdateBoardInputSchema.parse({
        boardUuid: '11111111-1111-4111-8111-111111111111',
        setIds: submittedSetIds,
      }).setIds,
    ).toBe(submittedSetIds);
  });

  it('rejects empty, spaced, trailing-comma, nondigit, and overlong values in every config schema', () => {
    const malformedSetIds = ['', '1, 2', '1,2,', '1,two', '1'.repeat(257)];

    for (const setIds of malformedSetIds) {
      expect(
        BoardPresenceConfigInputSchema.safeParse({ boardType: 'kilter', layoutId: 1, sizeId: 1, setIds }).success,
      ).toBe(false);
      expect(
        CreateBoardInputSchema.safeParse({
          boardType: 'kilter',
          layoutId: 1,
          sizeId: 1,
          setIds,
          name: 'Schema test board',
        }).success,
      ).toBe(false);
      expect(
        UpdateBoardInputSchema.safeParse({
          boardUuid: '11111111-1111-4111-8111-111111111111',
          setIds,
        }).success,
      ).toBe(false);
    }
  });
});

describe('assertKnownBoardConfig', () => {
  it('accepts an exact unlisted Aurora association in any order with duplicate set IDs', async () => {
    const selectSpy = vi.spyOn(db, 'select');

    await expect(
      assertKnownBoardConfig('kilter', LAYOUT_ID, SIZE_ID, `${SET_B_ID},${SET_A_ID},${SET_B_ID}`),
    ).resolves.toBeUndefined();

    expect(selectSpy).toHaveBeenCalledTimes(2);
  });

  it('rejects a listed set with no placement, including a partial valid and orphaned set selection', async () => {
    await expectUnknownBoardConfig(assertKnownBoardConfig('kilter', LAYOUT_ID, SIZE_ID, String(SET_C_ID)));
    await expectUnknownBoardConfig(assertKnownBoardConfig('kilter', LAYOUT_ID, SIZE_ID, `${SET_A_ID},${SET_C_ID}`));
  });

  it('rejects a set associated only with another layout, another size, or no association', async () => {
    await expectUnknownBoardConfig(assertKnownBoardConfig('kilter', OTHER_LAYOUT_ID, SIZE_ID, String(SET_B_ID)));
    await expectUnknownBoardConfig(assertKnownBoardConfig('kilter', LAYOUT_ID, OTHER_SIZE_ID, String(SET_B_ID)));
    await expectUnknownBoardConfig(assertKnownBoardConfig('kilter', LAYOUT_ID, SIZE_ID, String(UNKNOWN_SET_ID)));
    await expectUnknownBoardConfig(assertKnownBoardConfig('kilter', UNKNOWN_LAYOUT_ID, SIZE_ID, String(SET_A_ID)));
    await expectUnknownBoardConfig(assertKnownBoardConfig('kilter', LAYOUT_ID, UNKNOWN_SIZE_ID, String(SET_A_ID)));
  });

  it('rejects malformed and out-of-range IDs before issuing a catalog query', async () => {
    const selectSpy = vi.spyOn(db, 'select');

    await expectUnknownBoardConfig(assertKnownBoardConfig('kilter', LAYOUT_ID, SIZE_ID, `${SET_A_ID}, 2`));
    await expectUnknownBoardConfig(assertKnownBoardConfig('kilter', 2_147_483_648, SIZE_ID, String(SET_A_ID)));
    await expectUnknownBoardConfig(assertKnownBoardConfig('kilter', LAYOUT_ID, SIZE_ID, '2147483648'));

    expect(selectSpy).not.toHaveBeenCalled();
  });

  it('does not mask a database failure', async () => {
    const databaseError = new Error('catalog database unavailable');
    vi.spyOn(db, 'select').mockImplementationOnce(() => {
      throw databaseError;
    });

    await expect(assertKnownBoardConfig('kilter', LAYOUT_ID, SIZE_ID, String(SET_A_ID))).rejects.toBe(databaseError);
  });

  it('validates MoonBoard against its exact static size, layout, and layout-specific sets', async () => {
    const selectSpy = vi.spyOn(db, 'select');
    const moonboardLayout = MOONBOARD_LAYOUTS['moonboard-2016'];
    const [firstSet, secondSet] = MOONBOARD_SETS['moonboard-2016'];

    await expect(
      assertKnownBoardConfig(
        'moonboard',
        moonboardLayout.id,
        MOONBOARD_SIZE.id,
        `${secondSet.id},${firstSet.id},${secondSet.id}`,
      ),
    ).resolves.toBeUndefined();
    await expectUnknownBoardConfig(
      assertKnownBoardConfig('moonboard', moonboardLayout.id, MOONBOARD_SIZE.id + 1, String(firstSet.id)),
    );
    await expectUnknownBoardConfig(assertKnownBoardConfig('moonboard', 99_999, MOONBOARD_SIZE.id, String(firstSet.id)));
    await expectUnknownBoardConfig(
      assertKnownBoardConfig(
        'moonboard',
        moonboardLayout.id,
        MOONBOARD_SIZE.id,
        String(MOONBOARD_SETS['moonboard-2010'][0].id),
      ),
    );
    expect(selectSpy).not.toHaveBeenCalled();
  });

  it('validates Woods against its single layout, its two sizes and its one synthetic set', async () => {
    const selectSpy = vi.spyOn(db, 'select');
    const woodsLayoutId = WOODS_LAYOUTS.woods.id;
    const woodsSetIds = WOODS_SETS.map((woodsSet) => woodsSet.id).join(',');
    const smallSizeId = WOODS_SIZES['8x10'].id;
    const largeSizeId = WOODS_SIZES['12x12'].id;

    await expect(assertKnownBoardConfig('woods', woodsLayoutId, smallSizeId, woodsSetIds)).resolves.toBeUndefined();
    await expect(assertKnownBoardConfig('woods', woodsLayoutId, largeSizeId, woodsSetIds)).resolves.toBeUndefined();

    // A layout, a size and a set the board doesn't have. The empty set string is
    // rejected one layer earlier by the CSV grammar, which this asserts too:
    // an empty set list mis-parses the board path and breaks the board builder.
    await expectUnknownBoardConfig(assertKnownBoardConfig('woods', woodsLayoutId + 1, largeSizeId, woodsSetIds));
    await expectUnknownBoardConfig(assertKnownBoardConfig('woods', woodsLayoutId, largeSizeId + 1, woodsSetIds));
    await expectUnknownBoardConfig(assertKnownBoardConfig('woods', woodsLayoutId, largeSizeId, '2'));
    await expectUnknownBoardConfig(assertKnownBoardConfig('woods', woodsLayoutId, largeSizeId, '1,2'));
    await expectUnknownBoardConfig(assertKnownBoardConfig('woods', woodsLayoutId, largeSizeId, ''));

    // Static catalog: not one of those seven answers came from the database.
    expect(selectSpy).not.toHaveBeenCalled();
  });
});

describe('board-presence catalog gates', () => {
  it('keeps an anonymous shared miss as NOT_FOUND without creating a system board', async () => {
    const before = await sideEffectCounts(AUTO_GYM_USER_ID);

    await expect(
      boardPresenceMutations.resolveBoardForConfig(
        undefined,
        {
          boardType: 'kilter',
          layoutId: UNKNOWN_LAYOUT_ID,
          sizeId: UNKNOWN_SIZE_ID,
          setIds: String(UNKNOWN_SET_ID),
        },
        anonCtx(),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });

    expect(await sideEffectCounts(AUTO_GYM_USER_ID)).toEqual(before);
  });

  it('rejects an authenticated shared miss before creating the system owner or board', async () => {
    const before = await sideEffectCounts(AUTO_GYM_USER_ID);

    await expectUnknownBoardConfig(
      boardPresenceMutations.resolveBoardForConfig(
        undefined,
        {
          boardType: 'kilter',
          layoutId: UNKNOWN_LAYOUT_ID,
          sizeId: UNKNOWN_SIZE_ID,
          setIds: String(UNKNOWN_SET_ID),
        },
        authCtx(AUTO_GYM_USER_ID),
      ),
    );

    expect(await sideEffectCounts(AUTO_GYM_USER_ID)).toEqual(before);
  });

  it('rejects an authenticated listed-but-unplaced config before creating the system owner or board', async () => {
    const before = await sideEffectCounts(AUTO_GYM_USER_ID);

    await expectUnknownBoardConfig(
      boardPresenceMutations.resolveBoardForConfig(
        undefined,
        { boardType: 'kilter', layoutId: LAYOUT_ID, sizeId: SIZE_ID, setIds: String(SET_C_ID) },
        authCtx(AUTO_GYM_USER_ID),
      ),
    );

    expect(await sideEffectCounts(AUTO_GYM_USER_ID)).toEqual(before);
  });

  it('creates a normalized hidden system board for an authenticated valid catalog config', async () => {
    const before = await sideEffectCounts(AUTO_GYM_USER_ID);
    const submittedSetIds = `${SET_B_ID},${SET_A_ID},${SET_B_ID}`;

    const resolved = await boardPresenceMutations.resolveBoardForConfig(
      undefined,
      { boardType: 'kilter', layoutId: LAYOUT_ID, sizeId: SIZE_ID, setIds: submittedSetIds },
      authCtx(AUTO_GYM_USER_ID),
    );
    insertedSystemBoardIds.add(resolved.boardId);

    const [created] = await db
      .select({
        id: dbSchema.userBoards.id,
        slug: dbSchema.userBoards.slug,
        ownerId: dbSchema.userBoards.ownerId,
        boardType: dbSchema.userBoards.boardType,
        layoutId: dbSchema.userBoards.layoutId,
        sizeId: dbSchema.userBoards.sizeId,
        setIds: dbSchema.userBoards.setIds,
        name: dbSchema.userBoards.name,
        serialNumber: dbSchema.userBoards.serialNumber,
        isPublic: dbSchema.userBoards.isPublic,
        isUnlisted: dbSchema.userBoards.isUnlisted,
        hideLocation: dbSchema.userBoards.hideLocation,
        isOwned: dbSchema.userBoards.isOwned,
      })
      .from(dbSchema.userBoards)
      .where(eq(dbSchema.userBoards.id, resolved.boardId));
    const normalizedSetIds = `${SET_A_ID},${SET_B_ID}`;

    expect(resolved).toEqual({
      boardId: created.id,
      boardName: 'Kilter Board Shared Feed',
      boardType: 'kilter',
      layoutId: LAYOUT_ID,
      sizeId: SIZE_ID,
      setIds: normalizedSetIds,
    });
    expect(created).toEqual({
      id: resolved.boardId,
      slug: presenceSlug('kilter', LAYOUT_ID, SIZE_ID, submittedSetIds),
      ownerId: SYSTEM_BOARD_OWNER_ID,
      boardType: 'kilter',
      layoutId: LAYOUT_ID,
      sizeId: SIZE_ID,
      setIds: normalizedSetIds,
      name: 'Kilter Board Shared Feed',
      serialNumber: null,
      isPublic: false,
      isUnlisted: true,
      hideLocation: true,
      isOwned: false,
    });
    const after = await sideEffectCounts(AUTO_GYM_USER_ID);
    expect(after).toEqual({
      boards: before.boards,
      gyms: before.gyms,
      systemBoards: before.systemBoards + 1,
      systemOwners: 1,
    });
  });

  it('keeps malformed CSV at the existing presence schema-validation layer', async () => {
    let caughtError: unknown;
    try {
      await boardPresenceMutations.resolveBoardForConfig(
        undefined,
        {
          boardType: 'kilter',
          layoutId: LAYOUT_ID,
          sizeId: SIZE_ID,
          setIds: `${SET_A_ID}, ${SET_B_ID}`,
        },
        authCtx(AUTO_GYM_USER_ID),
      );
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(Error);
    expect(caughtError).not.toBeInstanceOf(GraphQLError);
    expect((caughtError as Error).message).toMatch(/comma-separated list of integers/);
  });

  it('continues to resolve an existing legacy-invalid shared row', async () => {
    await db
      .insert(dbSchema.users)
      .values({ id: SYSTEM_BOARD_OWNER_ID, email: 'system@boardsesh.com', name: 'Boardsesh' })
      .onConflictDoNothing();
    const setIds = String(UNKNOWN_SET_ID);
    const [legacyBoard] = await db
      .insert(dbSchema.userBoards)
      .values({
        uuid: uuidv4(),
        slug: presenceSlug('kilter', UNKNOWN_LAYOUT_ID, UNKNOWN_SIZE_ID, setIds),
        ownerId: SYSTEM_BOARD_OWNER_ID,
        boardType: 'kilter',
        layoutId: UNKNOWN_LAYOUT_ID,
        sizeId: UNKNOWN_SIZE_ID,
        setIds,
        name: 'Legacy shared board',
        isPublic: false,
        isUnlisted: true,
      })
      .returning();
    insertedSystemBoardIds.add(legacyBoard.id);

    const resolved = await boardPresenceMutations.resolveBoardForConfig(
      undefined,
      { boardType: 'kilter', layoutId: UNKNOWN_LAYOUT_ID, sizeId: UNKNOWN_SIZE_ID, setIds },
      authCtx(AUTO_GYM_USER_ID),
    );

    expect(resolved.boardId).toBe(legacyBoard.id);
  });

  it("binds a serial to the caller's existing legacy-invalid board without catalog validation", async () => {
    const legacyBoard = await insertTestBoard({
      ownerId: SERIAL_USER_ID,
      layoutId: UNKNOWN_LAYOUT_ID,
      sizeId: UNKNOWN_SIZE_ID,
      setIds: String(UNKNOWN_SET_ID),
      name: 'Legacy owned board',
    });

    const resolved = await boardPresenceMutations.resolveBoardForSerial(
      undefined,
      {
        serial: 'CATALOG-LEGACY-1',
        boardType: 'kilter',
        layoutId: UNKNOWN_LAYOUT_ID,
        sizeId: UNKNOWN_SIZE_ID,
        setIds: String(UNKNOWN_SET_ID),
      },
      authCtx(SERIAL_USER_ID),
    );

    expect(resolved.boardId).toBe(legacyBoard.id);
    const [updated] = await db
      .select({ serialNumber: dbSchema.userBoards.serialNumber })
      .from(dbSchema.userBoards)
      .where(eq(dbSchema.userBoards.id, legacyBoard.id));
    expect(updated?.serialNumber).toBe('CATALOG-LEGACY-1');
  });

  it('rejects a fresh serial-board insert for an unknown config with no board side effect', async () => {
    const before = await sideEffectCounts(SERIAL_USER_ID);

    await expectUnknownBoardConfig(
      boardPresenceMutations.resolveBoardForSerial(
        undefined,
        {
          serial: 'CATALOG-FRESH-1',
          boardType: 'kilter',
          layoutId: UNKNOWN_LAYOUT_ID,
          sizeId: UNKNOWN_SIZE_ID,
          setIds: String(UNKNOWN_SET_ID),
        },
        authCtx(SERIAL_USER_ID),
      ),
    );

    expect(await sideEffectCounts(SERIAL_USER_ID)).toEqual(before);
  });

  it('rejects a fresh serial-board insert for a listed-but-unplaced config with no board side effect', async () => {
    const before = await sideEffectCounts(SERIAL_USER_ID);

    await expectUnknownBoardConfig(
      boardPresenceMutations.resolveBoardForSerial(
        undefined,
        {
          serial: 'CATALOG-UNPLACED-1',
          boardType: 'kilter',
          layoutId: LAYOUT_ID,
          sizeId: SIZE_ID,
          setIds: String(SET_C_ID),
        },
        authCtx(SERIAL_USER_ID),
      ),
    );

    expect(await sideEffectCounts(SERIAL_USER_ID)).toEqual(before);
  });

  it('creates a fresh serial board for a valid catalog config without creating a gym', async () => {
    const before = await sideEffectCounts(SERIAL_USER_ID);
    const submittedSerial = '  catalog-fresh-valid-1  ';
    const normalizedSerial = 'CATALOG-FRESH-VALID-1';
    const submittedSetIds = `${SET_B_ID},${SET_A_ID},${SET_B_ID}`;

    const resolved = await boardPresenceMutations.resolveBoardForSerial(
      undefined,
      {
        serial: submittedSerial,
        boardType: 'kilter',
        layoutId: LAYOUT_ID,
        sizeId: SIZE_ID,
        setIds: submittedSetIds,
      },
      authCtx(SERIAL_USER_ID),
    );

    const [created] = await db
      .select({
        id: dbSchema.userBoards.id,
        ownerId: dbSchema.userBoards.ownerId,
        boardType: dbSchema.userBoards.boardType,
        layoutId: dbSchema.userBoards.layoutId,
        sizeId: dbSchema.userBoards.sizeId,
        setIds: dbSchema.userBoards.setIds,
        name: dbSchema.userBoards.name,
        serialNumber: dbSchema.userBoards.serialNumber,
        gymId: dbSchema.userBoards.gymId,
      })
      .from(dbSchema.userBoards)
      .where(eq(dbSchema.userBoards.id, resolved.boardId));

    expect(created).toEqual({
      id: resolved.boardId,
      ownerId: SERIAL_USER_ID,
      boardType: 'kilter',
      layoutId: LAYOUT_ID,
      sizeId: SIZE_ID,
      setIds: `${SET_A_ID},${SET_B_ID}`,
      name: 'Kilter Board',
      serialNumber: normalizedSerial,
      gymId: null,
    });
    expect(resolved).toMatchObject({
      boardId: created.id,
      boardName: created.name,
      boardType: created.boardType,
      layoutId: created.layoutId,
      sizeId: created.sizeId,
      setIds: created.setIds,
    });
    expect(await sideEffectCounts(SERIAL_USER_ID)).toEqual({
      boards: before.boards + 1,
      gyms: before.gyms,
      systemBoards: before.systemBoards,
      systemOwners: before.systemOwners,
    });
  });
});

describe('social board create catalog gate', () => {
  function createInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      boardType: 'kilter',
      layoutId: LAYOUT_ID,
      sizeId: SIZE_ID,
      setIds: `${SET_B_ID},${SET_A_ID},${SET_B_ID}`,
      name: 'Catalog validated board',
      ...overrides,
    };
  }

  it('creates the auto-gym transaction path and preserves the submitted setIds representation', async () => {
    const submittedSetIds = `${SET_B_ID},${SET_A_ID},${SET_B_ID}`;
    const created = await socialBoardMutations.createBoard(
      undefined,
      // A location name is what puts this on the mint path now. #4166 changed
      // auto-gym from per-user ("the caller owns no gyms") to per-location, so a
      // board that says nothing about where it is no longer mints a gym — the
      // old rule produced one named after the BOARD with null coordinates, which
      // could never surface in proximity search. The transaction path this test
      // exists to cover is unchanged; it just needs a place to mint for.
      { input: createInput({ setIds: submittedSetIds, locationName: 'Catalog Test Gym' }) },
      authCtx(AUTO_GYM_USER_ID),
    );

    expect(created.setIds).toBe(submittedSetIds);
    expect(created.gymId).not.toBeNull();
    expect(await sideEffectCounts(AUTO_GYM_USER_ID)).toMatchObject({ boards: 1, gyms: 1 });
  });

  it('creates the plain insert path and preserves raw setIds when the owner already has a gym', async () => {
    await db.insert(dbSchema.gyms).values({
      uuid: uuidv4(),
      slug: uuidv4(),
      ownerId: PLAIN_CREATE_USER_ID,
      name: 'Existing gym',
    });
    const submittedSetIds = `${SET_A_ID},${SET_B_ID},${SET_A_ID}`;

    const created = await socialBoardMutations.createBoard(
      undefined,
      { input: createInput({ setIds: submittedSetIds, name: 'Plain catalog board' }) },
      authCtx(PLAIN_CREATE_USER_ID),
    );

    expect(created.setIds).toBe(submittedSetIds);
    expect(await sideEffectCounts(PLAIN_CREATE_USER_ID)).toMatchObject({ boards: 1, gyms: 1 });
  });

  it('rejects an unknown auto-gym-path config before creating a board or gym', async () => {
    const before = await sideEffectCounts(AUTO_GYM_USER_ID);

    await expectUnknownBoardConfig(
      socialBoardMutations.createBoard(
        undefined,
        {
          input: createInput({
            layoutId: UNKNOWN_LAYOUT_ID,
            sizeId: UNKNOWN_SIZE_ID,
            setIds: String(UNKNOWN_SET_ID),
          }),
        },
        authCtx(AUTO_GYM_USER_ID),
      ),
    );

    expect(await sideEffectCounts(AUTO_GYM_USER_ID)).toEqual(before);
  });

  it('rejects a listed-but-unplaced auto-gym-path config before creating a board or gym', async () => {
    const before = await sideEffectCounts(AUTO_GYM_USER_ID);

    await expectUnknownBoardConfig(
      socialBoardMutations.createBoard(
        undefined,
        { input: createInput({ setIds: String(SET_C_ID) }) },
        authCtx(AUTO_GYM_USER_ID),
      ),
    );

    expect(await sideEffectCounts(AUTO_GYM_USER_ID)).toEqual(before);
  });

  it('rejects an unknown plain-insert-path config without touching the existing gym or boards', async () => {
    await db.insert(dbSchema.gyms).values({
      uuid: uuidv4(),
      slug: uuidv4(),
      ownerId: PLAIN_CREATE_USER_ID,
      name: 'Existing gym',
    });
    const before = await sideEffectCounts(PLAIN_CREATE_USER_ID);

    await expectUnknownBoardConfig(
      socialBoardMutations.createBoard(
        undefined,
        {
          input: createInput({
            layoutId: UNKNOWN_LAYOUT_ID,
            sizeId: UNKNOWN_SIZE_ID,
            setIds: String(UNKNOWN_SET_ID),
          }),
        },
        authCtx(PLAIN_CREATE_USER_ID),
      ),
    );

    expect(await sideEffectCounts(PLAIN_CREATE_USER_ID)).toEqual(before);
  });

  it('returns UNKNOWN_BOARD_CONFIG before the legacy duplicate check', async () => {
    await insertTestBoard({
      ownerId: PLAIN_CREATE_USER_ID,
      layoutId: UNKNOWN_LAYOUT_ID,
      sizeId: UNKNOWN_SIZE_ID,
      setIds: String(UNKNOWN_SET_ID),
      name: 'Legacy junk duplicate',
    });

    await expectUnknownBoardConfig(
      socialBoardMutations.createBoard(
        undefined,
        {
          input: createInput({
            layoutId: UNKNOWN_LAYOUT_ID,
            sizeId: UNKNOWN_SIZE_ID,
            setIds: String(UNKNOWN_SET_ID),
          }),
        },
        authCtx(PLAIN_CREATE_USER_ID),
      ),
    );
    expect((await sideEffectCounts(PLAIN_CREATE_USER_ID)).boards).toBe(1);
  });

  it('keeps malformed CSV at the existing schema-validation layer, not UNKNOWN_BOARD_CONFIG', async () => {
    let caughtError: unknown;
    try {
      await socialBoardMutations.createBoard(
        undefined,
        { input: createInput({ setIds: `${SET_A_ID}, ${SET_B_ID}` }) },
        authCtx(AUTO_GYM_USER_ID),
      );
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(Error);
    expect(caughtError).not.toBeInstanceOf(GraphQLError);
    expect((caughtError as Error).message).toMatch(/comma-separated list of integers/);
    expect(await sideEffectCounts(AUTO_GYM_USER_ID)).toMatchObject({ boards: 0, gyms: 0 });
  });
});

describe('social board update catalog gate', () => {
  it('validates the effective tuple for a partial config edit and preserves raw setIds', async () => {
    const board = await insertTestBoard({
      ownerId: UPDATE_USER_ID,
      layoutId: LAYOUT_ID,
      sizeId: SIZE_ID,
      setIds: String(SET_A_ID),
    });
    const submittedSetIds = `${SET_B_ID},${SET_A_ID},${SET_B_ID}`;

    const updated = await socialBoardMutations.updateBoard(
      undefined,
      { input: { boardUuid: board.uuid, setIds: submittedSetIds } },
      authCtx(UPDATE_USER_ID),
    );

    expect(updated.layoutId).toBe(LAYOUT_ID);
    expect(updated.sizeId).toBe(SIZE_ID);
    expect(updated.setIds).toBe(submittedSetIds);
  });

  it('rejects an invalid partial config edit before the write and preserves the row', async () => {
    const board = await insertTestBoard({
      ownerId: UPDATE_USER_ID,
      layoutId: LAYOUT_ID,
      sizeId: SIZE_ID,
      setIds: String(SET_B_ID),
      name: 'Before rejection',
    });
    const before = await db
      .select()
      .from(dbSchema.userBoards)
      .where(eq(dbSchema.userBoards.id, board.id))
      .then((rows) => rows[0]);

    await expectUnknownBoardConfig(
      socialBoardMutations.updateBoard(
        undefined,
        { input: { boardUuid: board.uuid, layoutId: OTHER_LAYOUT_ID } },
        authCtx(UPDATE_USER_ID),
      ),
    );

    const [after] = await db.select().from(dbSchema.userBoards).where(eq(dbSchema.userBoards.id, board.id));
    expect(after).toEqual(before);
  });

  it('rejects a listed-but-unplaced partial config edit before the write and preserves the row', async () => {
    const board = await insertTestBoard({
      ownerId: UPDATE_USER_ID,
      layoutId: LAYOUT_ID,
      sizeId: SIZE_ID,
      setIds: String(SET_A_ID),
      name: 'Before unplaced rejection',
    });
    const before = await db
      .select()
      .from(dbSchema.userBoards)
      .where(eq(dbSchema.userBoards.id, board.id))
      .then((rows) => rows[0]);

    await expectUnknownBoardConfig(
      socialBoardMutations.updateBoard(
        undefined,
        { input: { boardUuid: board.uuid, setIds: String(SET_C_ID) } },
        authCtx(UPDATE_USER_ID),
      ),
    );

    const [after] = await db.select().from(dbSchema.userBoards).where(eq(dbSchema.userBoards.id, board.id));
    expect(after).toEqual(before);
  });

  it('allows metadata-only edits on a legacy-invalid board', async () => {
    const board = await insertTestBoard({
      ownerId: UPDATE_USER_ID,
      layoutId: UNKNOWN_LAYOUT_ID,
      sizeId: UNKNOWN_SIZE_ID,
      setIds: String(UNKNOWN_SET_ID),
      name: 'Legacy metadata',
    });

    const updated = await socialBoardMutations.updateBoard(
      undefined,
      { input: { boardUuid: board.uuid, name: 'Legacy metadata fixed' } },
      authCtx(UPDATE_USER_ID),
    );

    expect(updated.name).toBe('Legacy metadata fixed');
    expect(updated.layoutId).toBe(UNKNOWN_LAYOUT_ID);
    expect(updated.sizeId).toBe(UNKNOWN_SIZE_ID);
    expect(updated.setIds).toBe(String(UNKNOWN_SET_ID));
  });

  it('rejects -5 for a stored Kilter board and preserves its angle', async () => {
    const board = await insertTestBoard({
      ownerId: UPDATE_USER_ID,
      layoutId: LAYOUT_ID,
      sizeId: SIZE_ID,
      setIds: String(SET_A_ID),
    });

    await expect(
      socialBoardMutations.updateBoard(
        undefined,
        { input: { boardUuid: board.uuid, angle: -5 } },
        authCtx(UPDATE_USER_ID),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });

    const [storedBoard] = await db
      .select({ angle: dbSchema.userBoards.angle })
      .from(dbSchema.userBoards)
      .where(eq(dbSchema.userBoards.id, board.id));
    expect(storedBoard?.angle).toBe(board.angle);
  });

  it('accepts -5 for a stored Grasshopper board', async () => {
    const board = await insertTestBoard({
      ownerId: UPDATE_USER_ID,
      layoutId: UNKNOWN_LAYOUT_ID,
      sizeId: UNKNOWN_SIZE_ID,
      setIds: String(UNKNOWN_SET_ID),
      boardType: 'grasshopper',
    });

    const updated = await socialBoardMutations.updateBoard(
      undefined,
      { input: { boardUuid: board.uuid, angle: -5 } },
      authCtx(UPDATE_USER_ID),
    );

    expect(updated.angle).toBe(-5);
  });
});
