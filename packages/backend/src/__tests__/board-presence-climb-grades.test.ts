import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { eq } from 'drizzle-orm';
import * as schema from '@boardsesh/db/schema';
import { getGradeLabel } from '@boardsesh/db/queries';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { boardPresenceQueries } from '../graphql/resolvers/board-presence/queries';
import { readBoardPresenceClimbGrades } from '../services/board-presence-climb-grades';
import { resetControllerOwnerChecksForTests } from '../graphql/resolvers/climbs/spray-read-access';

let boardId: number;
let boardUuid: string;
let climbUuid: string;
let ownerId: string;
const anonymous = (): ConnectionContext => ({ connectionId: randomUUID(), isAuthenticated: false });
const read = (
  options: Partial<{ boardId: number; boardUuid: string; angle: number; climbUuids: string[] }> = {},
  ctx = anonymous(),
) =>
  boardPresenceQueries.boardPresenceClimbGrades(
    undefined,
    { boardId, angle: 40, climbUuids: [climbUuid], ...options },
    ctx,
  );

beforeEach(async () => {
  ownerId = randomUUID();
  boardUuid = randomUUID();
  climbUuid = randomUUID();
  await db.insert(schema.users).values({ id: ownerId, email: `${ownerId}@presence-grades.test` });
  const [board] = await db
    .insert(schema.userBoards)
    .values({
      uuid: boardUuid,
      slug: boardUuid,
      name: 'Grade fixture',
      ownerId,
      boardType: 'tension',
      layoutId: 10,
      sizeId: 6,
      setIds: '12,13',
      isPublic: true,
    })
    .returning();
  boardId = board.id;
  await db
    .insert(schema.boardClimbs)
    .values({ uuid: climbUuid, boardType: 'tension', layoutId: 10, isListed: true, name: 'Public fixture' });
  await db.insert(schema.boardClimbStats).values([
    { boardType: 'tension', climbUuid, angle: 40, displayDifficulty: 17.6 },
    { boardType: 'tension', climbUuid, angle: 50, displayDifficulty: 20.2 },
  ]);
  await db.insert(schema.boardClimbGrades).values([
    {
      boardType: 'tension',
      climbUuid,
      angle: 40,
      universalGrade: 18.3,
      localGrade: 17.2,
      confidence: 'confirmed',
      modelVersion: 'test',
      coeffVersion: 'test',
    },
    {
      boardType: 'tension',
      climbUuid,
      angle: 50,
      universalGrade: null,
      localGrade: 19.7,
      confidence: 'provisional',
      modelVersion: 'test',
      coeffVersion: 'test',
    },
  ]);
});
afterEach(() => {
  vi.restoreAllMocks();
  resetControllerOwnerChecksForTests();
});

describe('public board-presence grade batches', () => {
  it('serves anonymous viewers at exactly their selected angle with universal/local Boardsesh fallback', async () => {
    expect(await read()).toEqual([
      {
        uuid: climbUuid,
        difficulty: getGradeLabel(18, 'tension'),
        boardseshDifficulty: 18.3,
        boardseshConfidence: 'confirmed',
      },
    ]);
    expect(await read({ angle: 50 })).toEqual([
      {
        uuid: climbUuid,
        difficulty: getGradeLabel(20, 'tension'),
        boardseshDifficulty: 19.7,
        boardseshConfidence: 'provisional',
      },
    ]);
    expect(await read({ angle: 0 })).toEqual([
      { uuid: climbUuid, difficulty: null, boardseshDifficulty: null, boardseshConfidence: null },
    ]);
  });
  it('returns grade-only estimates even when the selected angle has no community stats', async () => {
    await db.insert(schema.boardClimbGrades).values({
      boardType: 'tension',
      climbUuid,
      angle: 30,
      universalGrade: null,
      localGrade: 0,
      confidence: 'cross_angle_estimate',
      modelVersion: 'test',
      coeffVersion: 'test',
    });
    expect(await read({ angle: 30 })).toEqual([
      { uuid: climbUuid, difficulty: null, boardseshDifficulty: 0, boardseshConfidence: 'cross_angle_estimate' },
    ]);
  });
  it('keys aliases under each requested UUID and deduplicates repeat requests', async () => {
    const aliasUuid = randomUUID();
    await db
      .insert(schema.boardClimbAliases)
      .values({ boardType: 'tension', aliasUuid, canonicalUuid: climbUuid, source: 'aurora' });
    const grades = await read({ climbUuids: [aliasUuid, climbUuid, aliasUuid] });
    expect(grades.map((grade) => grade.uuid)).toEqual([aliasUuid, climbUuid]);
    expect(grades.every((grade) => grade.boardseshDifficulty === 18.3)).toBe(true);
  });
  it.each([{ isDraft: true }, { isListed: false }, { isListed: null }])(
    'never leaks nonpublic catalog grades or alias grades: %j',
    async (visibility) => {
      const aliasUuid = randomUUID();
      await db
        .insert(schema.boardClimbAliases)
        .values({ boardType: 'tension', aliasUuid, canonicalUuid: climbUuid, source: 'aurora' });
      await db.update(schema.boardClimbs).set(visibility).where(eq(schema.boardClimbs.uuid, climbUuid));
      expect(await read({ climbUuids: [climbUuid, aliasUuid] })).toEqual([]);
      expect(await read({}, { connectionId: randomUUID(), isAuthenticated: true, userId: ownerId })).toEqual([]);
    },
  );
  it('scopes catalog and aliases to the wall product and layout', async () => {
    const otherLayout = randomUUID();
    const otherBoard = randomUUID();
    const foreignAlias = randomUUID();
    await db.insert(schema.boardClimbs).values([
      { uuid: otherLayout, boardType: 'tension', layoutId: 11, isListed: true },
      { uuid: otherBoard, boardType: 'decoy', layoutId: 10, isListed: true },
    ]);
    await db
      .insert(schema.boardClimbAliases)
      .values({ boardType: 'decoy', aliasUuid: foreignAlias, canonicalUuid: otherBoard, source: 'aurora' });
    expect(await read({ climbUuids: [otherLayout, otherBoard, foreignAlias] })).toEqual([]);
  });
  it('performs two set-based catalog reads for both one climb and fifty climbs', async () => {
    const batch = Array.from({ length: 49 }, () => randomUUID());
    await db
      .insert(schema.boardClimbs)
      .values(batch.map((uuid) => ({ uuid, boardType: 'tension', layoutId: 10, isListed: true })));
    const select = vi.spyOn(db, 'select');
    expect(await readBoardPresenceClimbGrades({ boardType: 'tension', layoutId: 10 }, 40, [climbUuid])).toHaveLength(1);
    expect(select).toHaveBeenCalledTimes(2);
    select.mockClear();
    expect(
      await readBoardPresenceClimbGrades({ boardType: 'tension', layoutId: 10 }, 40, [climbUuid, ...batch]),
    ).toHaveLength(50);
    expect(select).toHaveBeenCalledTimes(2);
  });
  it.each([-91, 91, 40.5, -5, Number.NaN])('rejects unsupported angle %s', async (angle) => {
    await expect(read({ angle })).rejects.toMatchObject({ name: 'InputValidationError' });
  });
  it('permits a supported negative Grasshopper angle', async () => {
    await db.update(schema.userBoards).set({ boardType: 'grasshopper' }).where(eq(schema.userBoards.id, boardId));
    expect(await read({ angle: -5 })).toEqual([]);
  });
  it('bounds raw request counts before deduplication and rejects malformed identifiers', async () => {
    await expect(read({ climbUuids: Array.from({ length: 51 }, () => climbUuid) })).rejects.toMatchObject({
      name: 'InputValidationError',
    });
    await expect(read({ climbUuids: [' '.repeat(3)] })).rejects.toMatchObject({
      name: 'InputValidationError',
    });
    expect(await read({ climbUuids: [] })).toEqual([]);
  });
});

describe('board grade visibility and wall-device authorization', () => {
  it('masks private/deleted/missing boards from anonymous viewers', async () => {
    await db.update(schema.userBoards).set({ isPublic: false }).where(eq(schema.userBoards.id, boardId));
    await expect(read()).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
    expect(await read({}, { connectionId: randomUUID(), isAuthenticated: true, userId: ownerId })).toHaveLength(1);
    await db.update(schema.userBoards).set({ deletedAt: new Date() }).where(eq(schema.userBoards.id, boardId));
    await expect(read()).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
    await expect(read({ boardId: 2_000_000_000 })).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
  });
  it('requires the exact UUID capability to read an unlisted board anonymously', async () => {
    await db
      .update(schema.userBoards)
      .set({ isPublic: true, isUnlisted: true })
      .where(eq(schema.userBoards.id, boardId));
    await expect(read()).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
    await expect(read({ boardUuid: randomUUID() })).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
    expect(await read({ boardUuid })).toHaveLength(1);
  });
  it('honors a registered wall key only for its owner’s own board', async () => {
    await db.update(schema.userBoards).set({ isPublic: false }).where(eq(schema.userBoards.id, boardId));
    const apiKey = randomUUID();
    const [controller] = await db
      .insert(schema.esp32Controllers)
      .values({ userId: ownerId, apiKey, boardName: 'tension', layoutId: 10, sizeId: 6, setIds: '12,13' })
      .returning();
    const device: ConnectionContext = {
      connectionId: randomUUID(),
      isAuthenticated: false,
      controllerId: controller.id,
      controllerApiKey: apiKey,
      controllerOwnerUserId: ownerId,
    };
    expect(await read({}, device)).toHaveLength(1);
    await db.update(schema.userBoards).set({ ownerId: 'user-123' }).where(eq(schema.userBoards.id, boardId));
    await expect(read({}, device)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
  });
});
