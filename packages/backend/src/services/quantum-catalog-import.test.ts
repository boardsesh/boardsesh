import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { and, eq } from 'drizzle-orm';
import {
  boardCatalogSyncState,
  boardClimbHolds,
  boardClimbs,
  boardClimbStats,
  boardDifficultyGrades,
  boardHoles,
  boardLayouts,
  boardLeds,
  boardPlacementRoles,
  boardPlacements,
  boardProducts,
  boardProductSizes,
  boardProductSizesLayoutsSets,
  boardSets,
  quantumClimbMetadata,
} from '@boardsesh/db/schema';
import { db } from '../db/client';
import {
  importValidatedQuantumSnapshot,
  QuantumHardwareFingerprintDriftError,
  QuantumSnapshotRollbackError,
} from './quantum-catalog-import';
import { getQuantumCatalogAngles } from '../graphql/resolvers/board/queries';
import { quantumCatalogFixture, quantumFixtureDiodes } from './__tests__/quantum-catalog-fixture';

const SOURCE = 'ewalls-authorized-snapshot';
const IMPORTED_AT = new Date('2026-08-30T12:00:00.000Z');

describe('Quantum catalog database import', () => {
  beforeEach(async () => {
    await db.delete(quantumClimbMetadata);
    await db.delete(boardClimbHolds).where(eq(boardClimbHolds.boardType, 'quantum'));
    await db.delete(boardClimbStats).where(eq(boardClimbStats.boardType, 'quantum'));
    await db.delete(boardClimbs).where(eq(boardClimbs.boardType, 'quantum'));
    await db.delete(boardLeds).where(eq(boardLeds.boardType, 'quantum'));
    await db.delete(boardPlacements).where(eq(boardPlacements.boardType, 'quantum'));
    await db.delete(boardHoles).where(eq(boardHoles.boardType, 'quantum'));
    await db.delete(boardProductSizesLayoutsSets).where(eq(boardProductSizesLayoutsSets.boardType, 'quantum'));
    await db.delete(boardProductSizes).where(eq(boardProductSizes.boardType, 'quantum'));
    await db.delete(boardLayouts).where(eq(boardLayouts.boardType, 'quantum'));
    await db.delete(boardPlacementRoles).where(eq(boardPlacementRoles.boardType, 'quantum'));
    await db.delete(boardSets).where(eq(boardSets.boardType, 'quantum'));
    await db.delete(boardProducts).where(eq(boardProducts.boardType, 'quantum'));
    await db.delete(boardDifficultyGrades).where(eq(boardDifficultyGrades.boardType, 'quantum'));
    await db.delete(boardCatalogSyncState).where(eq(boardCatalogSyncState.boardType, 'quantum'));
  });

  it('transactionally upserts the canonical reference, geometry, climbs, metadata, and stats', async () => {
    const result = await importValidatedQuantumSnapshot(quantumCatalogFixture(), undefined, {
      database: db,
      now: () => IMPORTED_AT,
    });

    expect(result).toMatchObject({
      outcome: 'applied',
      modelsUpserted: 5,
      diodesUpserted: 8,
      climbsUpserted: 1,
      holdsUpserted: 4,
      statsUpserted: 1,
    });
    await expect(db.select().from(boardProducts).where(eq(boardProducts.boardType, 'quantum'))).resolves.toMatchObject([
      { id: 91, name: 'Quantum Board', maxCountInFrame: 92 },
    ]);
    expect(
      await db.select().from(boardDifficultyGrades).where(eq(boardDifficultyGrades.boardType, 'quantum')),
    ).toHaveLength(24);
    expect(await db.select().from(boardLayouts).where(eq(boardLayouts.boardType, 'quantum'))).toHaveLength(5);
    expect(await db.select().from(boardHoles).where(eq(boardHoles.boardType, 'quantum'))).toHaveLength(8);
    expect(await db.select().from(boardPlacements).where(eq(boardPlacements.boardType, 'quantum'))).toHaveLength(8);
    expect(await db.select().from(boardLeds).where(eq(boardLeds.boardType, 'quantum'))).toHaveLength(8);

    const climbs = await db.select().from(boardClimbs).where(eq(boardClimbs.boardType, 'quantum'));
    expect(climbs).toMatchObject([
      {
        uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        controllerRouteUuid: '11111111-1111-4111-8111-111111111111',
        layoutId: 9101,
        isListed: true,
        frames: 'p1000007r12p1000008r13p1000009r14p1000010r13',
        requiredSetIds: [1],
        compatibleSizeIds: [9201],
      },
    ]);
    expect(await db.select().from(boardClimbHolds).where(eq(boardClimbHolds.boardType, 'quantum'))).toMatchObject([
      { holdId: 1_000_007, holdState: 'STARTING', frameNumber: 0 },
      { holdId: 1_000_008, holdState: 'HAND', frameNumber: 0 },
      { holdId: 1_000_009, holdState: 'FINISH', frameNumber: 0 },
      { holdId: 1_000_010, holdState: 'HAND', frameNumber: 0 },
    ]);
    await expect(db.select().from(quantumClimbMetadata)).resolves.toMatchObject([
      {
        isStandard: true,
        isCampusing: true,
        isEdge: true,
        usesKickplate: true,
        allowsMatching: true,
        tags: ['pinch', 'technical'],
      },
    ]);
    await expect(
      db.select().from(boardClimbStats).where(eq(boardClimbStats.boardType, 'quantum')),
    ).resolves.toMatchObject([
      {
        angle: 40,
        displayDifficulty: 15,
        upstreamAscensionistCount: 12,
        ascensionistCount: 12,
        upstreamQualityAverage: 4.5,
        qualityAverage: 4.5,
      },
    ]);
    await expect(
      db
        .select()
        .from(boardCatalogSyncState)
        .where(and(eq(boardCatalogSyncState.boardType, 'quantum'), eq(boardCatalogSyncState.source, SOURCE))),
    ).resolves.toMatchObject([
      {
        manifestEventId: 'f'.repeat(64),
        manifestCreatedAt: 1_800_000_000,
        lastError: null,
      },
    ]);
  });

  it('delists missing source routes without deleting them', async () => {
    await importValidatedQuantumSnapshot(quantumCatalogFixture(), undefined, { database: db });
    const replacement = quantumCatalogFixture({
      manifestCreatedAt: 1_800_000_001,
      eventId: 'e'.repeat(64),
      appUuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      routeUuid: '22222222-2222-4222-8222-222222222222',
      routeName: 'Replacement route',
    });
    await importValidatedQuantumSnapshot(replacement, undefined, { database: db });

    const climbs = await db
      .select({ uuid: boardClimbs.uuid, isListed: boardClimbs.isListed })
      .from(boardClimbs)
      .where(eq(boardClimbs.boardType, 'quantum'));
    expect(climbs).toEqual(
      expect.arrayContaining([
        { uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', isListed: false },
        { uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', isListed: true },
      ]),
    );
  });

  it('returns an unchanged no-op for an already applied event and rejects rollback', async () => {
    const current = quantumCatalogFixture({ manifestCreatedAt: 1_800_000_010, eventId: 'd'.repeat(64) });
    await importValidatedQuantumSnapshot(current, undefined, { database: db });
    await expect(importValidatedQuantumSnapshot(current, undefined, { database: db })).resolves.toMatchObject({
      outcome: 'unchanged',
      climbsUpserted: 0,
    });

    const stale = quantumCatalogFixture({
      manifestCreatedAt: 1_800_000_009,
      eventId: 'f'.repeat(64),
      appUuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      routeUuid: '33333333-3333-4333-8333-333333333333',
    });
    await expect(importValidatedQuantumSnapshot(stale, undefined, { database: db })).rejects.toBeInstanceOf(
      QuantumSnapshotRollbackError,
    );
    expect(
      await db.select().from(boardClimbs).where(eq(boardClimbs.uuid, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc')),
    ).toHaveLength(0);
  });

  it('fails closed on hardware fingerprint drift and leaves the catalog intact', async () => {
    await importValidatedQuantumSnapshot(quantumCatalogFixture(), undefined, { database: db });
    const changedDiodes = quantumFixtureDiodes().map((diode, index) =>
      index === 0 ? { ...diode, x: diode.x + 0.5 } : diode,
    );
    const drifted = quantumCatalogFixture({
      manifestCreatedAt: 1_800_000_001,
      eventId: 'e'.repeat(64),
      diodes: changedDiodes,
    });
    await expect(importValidatedQuantumSnapshot(drifted, undefined, { database: db })).rejects.toBeInstanceOf(
      QuantumHardwareFingerprintDriftError,
    );
    await expect(db.select().from(boardClimbs).where(eq(boardClimbs.boardType, 'quantum'))).resolves.toMatchObject([
      { uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', isListed: true },
    ]);
    await expect(
      db.select().from(boardCatalogSyncState).where(eq(boardCatalogSyncState.boardType, 'quantum')),
    ).resolves.toMatchObject([{ lastError: expect.stringContaining('hardware fingerprint changed') }]);
  });

  it('rejects an app UUID owned by another board instead of overwriting it', async () => {
    const collidingUuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await db.insert(boardClimbs).values({
      uuid: collidingUuid,
      boardType: 'kilter',
      layoutId: 1,
      name: 'Existing Kilter climb',
    });

    try {
      await expect(
        importValidatedQuantumSnapshot(quantumCatalogFixture(), undefined, { database: db }),
      ).rejects.toThrow(/non-source climb/);
      await expect(db.select().from(boardClimbs).where(eq(boardClimbs.uuid, collidingUuid))).resolves.toMatchObject([
        { boardType: 'kilter', name: 'Existing Kilter climb' },
      ]);
    } finally {
      await db.delete(boardClimbs).where(eq(boardClimbs.uuid, collidingUuid));
    }
  });

  it('derives Quantum angles only from signed-catalog rows', async () => {
    await importValidatedQuantumSnapshot(quantumCatalogFixture(), undefined, { database: db });
    const userClimbUuid = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    await db.insert(boardClimbs).values({
      uuid: userClimbUuid,
      boardType: 'quantum',
      layoutId: 9101,
      name: 'Boardsesh-authored route',
      angle: 55,
      synced: false,
    });
    await db.insert(boardClimbStats).values({
      boardType: 'quantum',
      climbUuid: userClimbUuid,
      angle: 55,
      ascensionistCount: 0,
    });

    await expect(getQuantumCatalogAngles(9101)).resolves.toEqual([{ angle: 40 }]);
  });
});
