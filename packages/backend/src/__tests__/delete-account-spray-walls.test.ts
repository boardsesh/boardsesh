import { describe, expect, it, vi } from 'vite-plus/test';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import type { Database } from '../db/client';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
const fixture = vi.hoisted(() => ({
  transaction: null as Transaction | null,
  failStorage: false,
  failBeforeCommit: false,
  failRefreshStatement: false,
  beforeTransaction: null as (() => Promise<void>) | null,
  onList: null as (() => Promise<void>) | null,
  onCopy: null as (() => Promise<void>) | null,
  objects: new Map<string, Set<string>>(),
  erased: [] as string[],
}));
vi.mock('../db/client', async (importOriginal) => {
  const original = await importOriginal<typeof import('../db/client')>();
  return {
    ...original,
    db: new Proxy(original.db, {
      get(target, property) {
        const active = fixture.transaction ?? target;
        if (property === 'execute' && fixture.failRefreshStatement) {
          return () => Promise.reject(new Error('synthetic refresh SQL failure'));
        }
        if (property === 'transaction' && fixture.beforeTransaction && fixture.transaction) {
          return async (callback: (tx: Transaction) => Promise<unknown>) => {
            const beforeTransaction = fixture.beforeTransaction!;
            fixture.beforeTransaction = null;
            await beforeTransaction();
            return fixture.transaction!.transaction(callback);
          };
        }
        if (property === 'transaction' && fixture.failBeforeCommit && fixture.transaction) {
          return (callback: (tx: Transaction) => Promise<unknown>) =>
            fixture.transaction!.transaction(async (nested) => {
              await callback(nested);
              throw new Error('synthetic SQL commit failure');
            });
        }
        const member: unknown = Reflect.get(active, property);
        return typeof member === 'function' ? member.bind(active) : member;
      },
    }),
  };
});
vi.mock('../storage/s3', () => ({
  isS3Configured: vi.fn(() => true),
  listS3Objects: vi.fn(async (bucket: string, prefix: string) => {
    if (fixture.failStorage) throw new Error('synthetic storage failure');
    const listed = [...(fixture.objects.get(bucket) ?? [])]
      .filter((key) => key.startsWith(prefix))
      .map((key) => ({ key }));
    const onList = fixture.onList;
    fixture.onList = null;
    if (onList) await onList();
    return listed;
  }),
  deleteFromS3: vi.fn(async (bucket: string, key: string) => {
    fixture.objects.get(bucket)?.delete(key);
    fixture.erased.push(`${bucket}:${key}`);
  }),
  copyObjectBetweenBuckets: vi.fn(
    async (_sourceBucket: string, _sourceKey: string, destinationBucket: string, destinationKey: string) => {
      if (fixture.onCopy) await fixture.onCopy();
      const objects = fixture.objects.get(destinationBucket) ?? new Set<string>();
      objects.add(destinationKey);
      fixture.objects.set(destinationBucket, objects);
      return { key: destinationKey };
    },
  ),
}));

const { db: realDb } = await vi.importActual<typeof import('../db/client')>('../db/client');
const { userMutations } = await import('../graphql/resolvers/users/mutations');
const { purgeDeletedSprayWallPhotos } = await import('../graphql/resolvers/board/spray-wall-moderation');
const { SYSTEM_BOARD_OWNER_ID, isBoardAnonReadable } = await import('../graphql/resolvers/board-presence/shared');
const { sprayClimbVisibilityCondition } = await import('@boardsesh/db/queries');
const { sprayWallMutations, refreshPublicWallPhoto } = await import('../graphql/resolvers/board/spray-walls');
const { socialBoardMutations } = await import('../graphql/resolvers/social/boards');
const { syncLocationGeography } = await import('../graphql/resolvers/social/location-geography');
const { lockSprayWallAccount } = await import('../services/spray-account-lock');

const ROLLBACK = new Error('rollback synthetic account fixture');
async function rolledBack(run: (tx: Transaction) => Promise<void>) {
  try {
    await realDb.transaction(async (tx) => {
      fixture.transaction = tx;
      fixture.failStorage = false;
      fixture.failBeforeCommit = false;
      fixture.failRefreshStatement = false;
      fixture.beforeTransaction = null;
      fixture.onList = null;
      fixture.onCopy = null;
      fixture.objects.clear();
      fixture.erased.length = 0;
      try {
        await run(tx);
        throw ROLLBACK;
      } finally {
        fixture.transaction = null;
      }
    });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
}

async function seed(tx: Transaction) {
  const owner = randomUUID();
  const climber = randomUUID();
  await tx
    .insert(dbSchema.users)
    .values([
      { id: owner, email: `${owner}@example.invalid` },
      { id: climber, email: `${climber}@example.invalid` },
      { id: SYSTEM_BOARD_OWNER_ID, email: 'synthetic-system@example.invalid' },
    ])
    .onConflictDoNothing();
  const walls = [];
  for (let index = 0; index < 3; index += 1) {
    const boardUuid = randomUUID();
    const layoutId = 900_000_000 + Math.floor(Math.random() * 90_000_000);
    const boardOwner = index === 2 ? climber : owner;
    const [board] = await tx
      .insert(dbSchema.userBoards)
      .values({
        uuid: boardUuid,
        slug: `synthetic-${boardUuid}`,
        ownerId: boardOwner,
        boardType: 'spray',
        layoutId,
        sizeId: layoutId,
        setIds: '1',
        name: 'Private home',
        description: 'Address',
        latitude: 1,
        longitude: 2,
        isPublic: true,
        deletedAt: index === 1 ? new Date() : null,
      })
      .returning();
    const [wall] = await tx
      .insert(dbSchema.sprayWalls)
      .values({
        boardUuid,
        layoutId,
        deletedAt: index === 1 ? new Date() : null,
        publicPhotoKey: `spray-walls/${boardUuid}/public.jpg`,
      })
      .returning();
    const [version] = await tx
      .insert(dbSchema.sprayWallVersions)
      .values({
        wallId: wall.id,
        versionNumber: 1,
        status: 'published',
        photoKey: `spray-walls/${boardUuid}/photo.jpg`,
        notes: 'My home',
        createdBy: boardOwner,
      })
      .returning();
    await tx
      .update(dbSchema.sprayWalls)
      .set({ currentVersionId: version.id })
      .where(eq(dbSchema.sprayWalls.id, wall.id));
    await tx
      .insert(dbSchema.sprayWallHolds)
      .values({ wallId: wall.id, holdId: layoutId, cx: 20, cy: 20, r: 5, installedVersionId: version.id });
    const climbUuid = randomUUID();
    await tx.insert(dbSchema.boardClimbs).values({
      uuid: climbUuid,
      boardType: 'spray',
      layoutId,
      userId: owner,
      name: 'Published climb',
      isDraft: false,
    });
    await tx
      .insert(dbSchema.sprayClimbLineage)
      .values({ childUuid: climbUuid, parentUuid: randomUUID(), wallVersionId: version.id });
    const tickUuid = randomUUID();
    await tx.insert(dbSchema.boardseshTicks).values({
      uuid: tickUuid,
      userId: climber,
      boardType: 'spray',
      climbUuid,
      angle: 40,
      status: 'send',
      climbedAt: new Date().toISOString(),
      boardId: board.id,
    });
    walls.push({ wall, board, version, climbUuid, tickUuid });
    for (const bucket of ['private', 'media']) {
      const objects = fixture.objects.get(bucket) ?? new Set<string>();
      for (const suffix of ['photo.jpg', 'photo.jpg@280.jpg', 'abandoned.jpg'])
        objects.add(`spray-walls/${boardUuid}/${suffix}`);
      fixture.objects.set(bucket, objects);
    }
  }
  return { owner, climber, walls };
}
function ctx(userId: string): ConnectionContext {
  return { connectionId: 'synthetic-delete-account', userId, isAuthenticated: true };
}

describe('deleteAccount spray walls (real resolver, rolled-back database)', () => {
  it('does not query storage or SQL for an explicitly empty account purge', async () => {
    const select = vi.spyOn(realDb, 'select').mockImplementationOnce(() => {
      throw new Error('empty purge queried SQL');
    });
    try {
      expect(await purgeDeletedSprayWallPhotos({ wallIds: [] })).toMatchObject({
        wallsPurged: 0,
        objectsDeleted: 0,
        wallsConsidered: 0,
      });
    } finally {
      select.mockRestore();
    }
  });
  it('serializes account creation and deletion across independent database connections', async () => {
    const accountId = randomUUID();
    let releaseOwner!: () => void;
    let ownerReady!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      ownerReady = resolve;
    });
    const owner = realDb.transaction(async (tx) => {
      await lockSprayWallAccount(tx, accountId);
      ownerReady();
      await released;
    });
    await ready;
    let waitingPid!: number;
    let waiterReady!: () => void;
    const started = new Promise<void>((resolve) => {
      waiterReady = resolve;
    });
    const waiter = realDb.transaction(async (tx) => {
      const rows = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
      waitingPid = Number(Array.from(rows)[0].pid);
      waiterReady();
      await lockSprayWallAccount(tx, accountId);
    });
    await started;
    try {
      let blocked = false;
      for (let attempt = 0; attempt < 100 && !blocked; attempt += 1) {
        const rows = await realDb.execute(sql`SELECT EXISTS (
          SELECT 1 FROM pg_locks WHERE pid = ${waitingPid} AND locktype = 'advisory' AND NOT granted) AS blocked`);
        blocked = Array.from(rows)[0].blocked === true;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(blocked).toBe(true);
    } finally {
      releaseOwner();
      await Promise.all([owner, waiter]);
    }
  });
  it('derives a delayed geography write from current coordinates and keeps deleted coordinates erased', async () => {
    await rolledBack(async (tx) => {
      // Temporary shadow objects exercise the real UPDATE without installing
      // PostGIS or changing the shared test schema. Point stands in for geography.
      await tx.execute(sql`CREATE TEMP TABLE user_boards (
        id integer, latitude double precision, longitude double precision,
        deleted_at timestamptz, location point) ON COMMIT DROP`);
      const geographySchema = sql.identifier(`synthetic_geo_${randomUUID().replaceAll('-', '')}`);
      await tx.execute(sql`CREATE SCHEMA ${geographySchema}`);
      await tx.execute(sql`CREATE DOMAIN ${geographySchema}.geography AS point`);
      await tx.execute(sql`CREATE FUNCTION ${geographySchema}.st_makepoint(double precision, double precision)
        RETURNS point LANGUAGE SQL AS 'SELECT point($1, $2)'`);
      await tx.execute(sql`SET LOCAL search_path = ${geographySchema}, pg_temp, public`);
      await tx.execute(sql`INSERT INTO user_boards VALUES (1, NULL, NULL, now(), NULL), (2, 3, 4, NULL, NULL)`);
      for (const id of [1, 2]) {
        await syncLocationGeography({ table: 'user_boards', id, latitude: 1, longitude: 2, operation: 'stale edit' });
      }
      const rows = await tx.execute(sql`SELECT id, location::text AS location FROM user_boards ORDER BY id`);
      expect(Array.from(rows)).toEqual([
        { id: 1, location: null },
        { id: 2, location: '(4,3)' },
      ]);
    });
  });
  it('rejects a restoration staged before account deletion scrubs and detaches the wall', async () => {
    await rolledBack(async (tx) => {
      const { owner, walls } = await seed(tx);
      const { board } = walls[1];
      fixture.beforeTransaction = async () => {
        await userMutations.deleteAccount({}, { input: { removeSetterName: false } }, ctx(owner));
      };
      await expect(
        socialBoardMutations.updateBoard(
          {},
          { input: { boardUuid: board.uuid, name: 'Restored private home' } },
          ctx(owner),
        ),
      ).rejects.toThrow('Board not found');
      const [retained] = await tx.select().from(dbSchema.userBoards).where(eq(dbSchema.userBoards.id, board.id));
      expect(retained.name).toBe('Deleted wall');
      expect(retained.deletedAt).not.toBeNull();
      expect(await isBoardAnonReadable(retained.id)).toBe(false);
    });
  });

  it('reopens erasure when a late public refresh has an uncertain SQL result', async () => {
    await rolledBack(async (tx) => {
      const { owner, walls } = await seed(tx);
      const { board, wall, version } = walls[0];
      fixture.onCopy = async () => {
        await userMutations.deleteAccount({}, { input: { removeSetterName: false } }, ctx(owner));
        fixture.failRefreshStatement = true;
      };
      await refreshPublicWallPhoto(wall.id, board.uuid, version.photoKey!, version.id);
      fixture.failRefreshStatement = false;
      const [retained] = await tx.select().from(dbSchema.sprayWalls).where(eq(dbSchema.sprayWalls.id, wall.id));
      expect(retained.photosPurgedAt).toBeNull();
      expect([...fixture.objects.get('media')!].some((key) => key.includes(board.uuid))).toBe(true);
      await purgeDeletedSprayWallPhotos({ wallIds: [wall.id] });
      expect([...fixture.objects.get('media')!].some((key) => key.includes(board.uuid))).toBe(false);
    });
  });
  it('deletes an owner with live and deleted walls, erases photos, preserves others’ logs and hides tombstones', async () => {
    await rolledBack(async (tx) => {
      const { owner, walls } = await seed(tx);
      expect(await userMutations.deleteAccount({}, { input: { removeSetterName: false } }, ctx(owner))).toBe(true);
      expect(await tx.select().from(dbSchema.users).where(eq(dbSchema.users.id, owner))).toEqual([]);
      for (const { wall, board, climbUuid, tickUuid } of walls.slice(0, 2)) {
        const [retained] = await tx.select().from(dbSchema.userBoards).where(eq(dbSchema.userBoards.id, board.id));
        expect(retained).toMatchObject({
          ownerId: SYSTEM_BOARD_OWNER_ID,
          isPublic: false,
          isUnlisted: false,
          name: 'Deleted wall',
          description: null,
          latitude: null,
          longitude: null,
        });
        expect(retained.deletedAt).not.toBeNull();
        // The system-owner bypass must still pass the board deletion gate.
        expect(await isBoardAnonReadable(retained.id)).toBe(false);
        const visible = await tx
          .select()
          .from(dbSchema.boardClimbs)
          .where(
            and(
              eq(dbSchema.boardClimbs.uuid, climbUuid),
              sprayClimbVisibilityCondition(
                { boardType: dbSchema.boardClimbs.boardType, layoutId: dbSchema.boardClimbs.layoutId },
                SYSTEM_BOARD_OWNER_ID,
              ),
            ),
          );
        expect(visible).toEqual([]);
        expect(
          await tx.select().from(dbSchema.boardseshTicks).where(eq(dbSchema.boardseshTicks.uuid, tickUuid)),
        ).toHaveLength(1);
        expect(
          await tx.select().from(dbSchema.sprayClimbLineage).where(eq(dbSchema.sprayClimbLineage.childUuid, climbUuid)),
        ).toHaveLength(1);
        expect(
          await tx.select().from(dbSchema.sprayWallHolds).where(eq(dbSchema.sprayWallHolds.wallId, wall.id)),
        ).toHaveLength(1);
        const [retainedWall] = await tx.select().from(dbSchema.sprayWalls).where(eq(dbSchema.sprayWalls.id, wall.id));
        expect(retainedWall.photosPurgedAt).not.toBeNull();
        expect(retainedWall.publicPhotoKey).toBeNull();
        expect(
          [...fixture.objects.values()].flatMap((objects) => [...objects]).some((key) => key.includes(board.uuid)),
        ).toBe(false);
      }
      expect(
        await tx.select().from(dbSchema.sprayWalls).where(eq(dbSchema.sprayWalls.id, walls[2].wall.id)),
      ).toHaveLength(1);
      expect(
        [...fixture.objects.values()]
          .flatMap((objects) => [...objects])
          .filter((key) => key.includes(walls[2].board.uuid)),
      ).toHaveLength(6);
    });
  });

  it('keeps failed erasure eligible immediately while ordinary deleted walls retain their window', async () => {
    await rolledBack(async (tx) => {
      const { owner, walls } = await seed(tx);
      fixture.failStorage = true;
      await userMutations.deleteAccount({}, { input: { removeSetterName: false } }, ctx(owner));
      const ownedIds = walls.slice(0, 2).map(({ wall }) => wall.id);
      const pending = await tx.select().from(dbSchema.sprayWalls).where(inArray(dbSchema.sprayWalls.id, ownedIds));
      expect(pending.every((wall) => wall.photosPurgedAt === null)).toBe(true);
      await tx
        .update(dbSchema.sprayWalls)
        .set({ deletedAt: new Date() })
        .where(eq(dbSchema.sprayWalls.id, walls[2].wall.id));
      fixture.failStorage = false;
      const purge = await purgeDeletedSprayWallPhotos();
      expect(purge.wallsPurged).toBe(2);
      expect(
        [...fixture.objects.values()]
          .flatMap((objects) => [...objects])
          .filter((key) => key.includes(walls[2].board.uuid)),
      ).toHaveLength(6);
    });
  });

  it('rolls back wall detachment with SQL failure and never erases uncommitted photos', async () => {
    await rolledBack(async (tx) => {
      const { owner, walls } = await seed(tx);
      fixture.failBeforeCommit = true;
      await expect(userMutations.deleteAccount({}, { input: { removeSetterName: false } }, ctx(owner))).rejects.toThrow(
        'synthetic SQL commit failure',
      );
      fixture.failBeforeCommit = false;
      expect(fixture.erased).toEqual([]);
      expect(await tx.select().from(dbSchema.users).where(eq(dbSchema.users.id, owner))).toHaveLength(1);
      const [board] = await tx.select().from(dbSchema.userBoards).where(eq(dbSchema.userBoards.id, walls[0].board.id));
      expect(board.ownerId).toBe(owner);
      expect(board.deletedAt).toBeNull();
    });
  });

  it('does not stamp an older prefix listing over a late-upload retry', async () => {
    await rolledBack(async (tx) => {
      const { owner, walls } = await seed(tx);
      fixture.failStorage = true;
      await userMutations.deleteAccount({}, { input: { removeSetterName: false } }, ctx(owner));
      fixture.failStorage = false;
      const wall = walls[0].wall;
      const lateKey = `spray-walls/${wall.boardUuid}/late.jpg`;
      fixture.onList = async () => {
        fixture.objects.get('private')!.add(lateKey);
        await tx
          .update(dbSchema.sprayWalls)
          .set({ photosPurgedAt: null, updatedAt: sql`clock_timestamp()` })
          .where(eq(dbSchema.sprayWalls.id, wall.id));
      };
      expect((await purgeDeletedSprayWallPhotos({ wallIds: [wall.id] })).wallsPurged).toBe(0);
      expect(fixture.objects.get('private')!.has(lateKey)).toBe(true);
      expect((await purgeDeletedSprayWallPhotos({ wallIds: [wall.id] })).wallsPurged).toBe(1);
      expect(fixture.objects.get('private')!.has(lateKey)).toBe(false);
    });
  });

  it('refuses wall creation after account deletion before creating catalogue rows', async () => {
    await rolledBack(async (tx) => {
      const { owner } = await seed(tx);
      await userMutations.deleteAccount({}, { input: { removeSetterName: false } }, ctx(owner));
      await expect(
        sprayWallMutations.createSprayWall({}, { input: { name: 'New wall', angle: 40 } }, ctx(owner)),
      ).rejects.toThrow('Spray wall not found');
    });
  });

  it('rejects a public promotion staged before account deletion and erases the late copy', async () => {
    await rolledBack(async (tx) => {
      const { owner, walls } = await seed(tx);
      const { board, wall } = walls[0];
      await tx.update(dbSchema.userBoards).set({ isPublic: false }).where(eq(dbSchema.userBoards.id, board.id));
      await tx.update(dbSchema.sprayWalls).set({ publicPhotoKey: null }).where(eq(dbSchema.sprayWalls.id, wall.id));
      fixture.onCopy = async () => {
        await userMutations.deleteAccount({}, { input: { removeSetterName: false } }, ctx(owner));
      };
      await expect(
        sprayWallMutations.updateSprayWall({}, { input: { uuid: board.uuid, isPublic: true } }, ctx(owner)),
      ).rejects.toThrow('Spray wall not found');
      expect([...fixture.objects.get('media')!].some((key) => key.includes(board.uuid))).toBe(false);
      const [retained] = await tx.select().from(dbSchema.userBoards).where(eq(dbSchema.userBoards.id, board.id));
      expect(retained).toMatchObject({ ownerId: SYSTEM_BOARD_OWNER_ID, isPublic: false });
      expect(retained.deletedAt).not.toBeNull();
    });
  });
});
