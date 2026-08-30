import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { and, eq, ne, sql } from 'drizzle-orm';
import {
  boardSharedSyncs,
  boardClimbHolds,
  boardClimbAliases,
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
} from '@boardsesh/db/schema';
import { db, type Database } from '../db/client';
import { populateDenormalizedColumns } from '@boardsesh/db/queries';
import {
  importValidatedQuantumSnapshot as importSnapshot,
  QuantumHardwareFingerprintDriftError,
  QuantumSnapshotRollbackError,
  QuantumRouteGeometryDriftError,
} from './quantum-catalog-import';
import { getQuantumCatalogAngles } from '../graphql/resolvers/board/queries';
import { quantumCanonicalClimbUuid, computeQuantumHardwareFingerprint } from './quantum-catalog-mapping';
import {
  quantumCatalogFixture,
  quantumFixtureDiodes,
  quantumSharedRouteFixture,
  type QuantumFixtureOptions,
} from './__tests__/quantum-catalog-fixture';

import { QUANTUM_CATALOG_CHECKPOINT } from './quantum-catalog-checkpoint';

async function catalogSyncStates() {
  const rows = await db
    .select({ metadata: boardSharedSyncs.metadata })
    .from(boardSharedSyncs)
    .where(and(eq(boardSharedSyncs.boardType, 'quantum'), eq(boardSharedSyncs.tableName, QUANTUM_CATALOG_CHECKPOINT)));
  return rows.map((row) => row.metadata);
}
function importValidatedQuantumSnapshot(...args: Parameters<typeof importSnapshot>) {
  const [snapshot, signal, options] = args;
  return importSnapshot(snapshot, signal, {
    ...options,
    expectedHardwareFingerprint: computeQuantumHardwareFingerprint(
      quantumCatalogFixture().rows.models,
      quantumCatalogFixture().rows.diodes,
    ),
  });
}

const CATALOG_UUID = quantumCanonicalClimbUuid(9101, '11111111-1111-4111-8111-111111111111');
const REPLACEMENT_UUID = quantumCanonicalClimbUuid(9101, '22222222-2222-4222-8222-222222222222');
const IMPORTED_AT = new Date('2026-08-30T12:00:00.000Z');

/** Pause after the actual delist query, so a second connection can commit an app climb. */
function afterQuery<Builder extends object>(builder: Builder, after: () => Promise<void>): Builder {
  return new Proxy(builder, {
    get(target, property, receiver) {
      const member: unknown = Reflect.get(target, property, receiver);
      if (typeof member !== 'function') return member;
      if (property === 'then') {
        return (resolve: (result: unknown) => unknown, reject: (reason: unknown) => unknown) => {
          const completed = Reflect.apply(member, target, []) as Promise<unknown>;
          return completed
            .then(async (result) => {
              await after();
              return result;
            })
            .then(resolve, reject);
        };
      }
      return (...args: unknown[]) => {
        const result: unknown = Reflect.apply(member, target, args);
        return typeof result === 'object' && result !== null ? afterQuery(result, after) : result;
      };
    },
  });
}

function databaseWithConcurrentClimb(insertConcurrentClimb: () => Promise<void>): Database {
  type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
  let inserted = false;
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property !== 'transaction') return Reflect.get(target, property, receiver);
      return (run: (transaction: Transaction) => Promise<unknown>) =>
        target.transaction((transaction) =>
          run(
            new Proxy(transaction, {
              get(executor, method, executorReceiver) {
                const member: unknown = Reflect.get(executor, method, executorReceiver);
                if (method !== 'update' || typeof member !== 'function')
                  return typeof member === 'function' ? member.bind(executor) : member;
                return (...args: unknown[]) => {
                  const query = Reflect.apply(member, executor, args) as object;
                  return args[0] === boardClimbs
                    ? afterQuery(query, async () => {
                        if (inserted) return;
                        inserted = true;
                        await insertConcurrentClimb();
                      })
                    : query;
                };
              },
            }),
          ),
        );
    },
  });
}

describe('Quantum catalog database import', () => {
  beforeEach(async () => {
    await db.delete(boardClimbAliases).where(eq(boardClimbAliases.boardType, 'quantum'));
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
    await db.delete(boardSharedSyncs).where(eq(boardSharedSyncs.boardType, 'quantum'));
  });

  it('rejects first-bootstrap hardware drift before any catalog or checkpoint write', async () => {
    const drifted = quantumCatalogFixture({
      diodes: quantumFixtureDiodes().map((diode, index) => (index === 0 ? { ...diode, z: diode.z + 1 } : diode)),
    });
    await expect(importValidatedQuantumSnapshot(drifted, undefined, { database: db })).rejects.toBeInstanceOf(
      QuantumHardwareFingerprintDriftError,
    );
    expect(await catalogSyncStates()).toEqual([]);
    expect(await db.select().from(boardClimbs).where(eq(boardClimbs.boardType, 'quantum'))).toEqual([]);
    expect(await db.select().from(boardProducts).where(eq(boardProducts.boardType, 'quantum'))).toEqual([]);
  });

  it('changes only the edited route and stats without rewriting immutable holds', async () => {
    const firstRoute = quantumCatalogFixture();
    const secondRoute = quantumCatalogFixture({
      routeUuid: '22222222-2222-4222-8222-222222222222',
      appUuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    });
    const snapshot = {
      ...firstRoute,
      rows: {
        ...firstRoute.rows,
        routes: [...firstRoute.rows.routes, ...secondRoute.rows.routes],
        routeModels: [...firstRoute.rows.routeModels, ...secondRoute.rows.routeModels],
        routeLights: [...firstRoute.rows.routeLights, ...secondRoute.rows.routeLights],
      },
    };
    async function rowVersions() {
      return {
        climbs: await db
          .select({ uuid: boardClimbs.uuid, revision: sql<string>`xmin::text`, updatedAt: boardClimbs.updatedAt })
          .from(boardClimbs)
          .where(eq(boardClimbs.boardType, 'quantum'))
          .orderBy(boardClimbs.uuid),
        holds: await db
          .select({
            climbUuid: boardClimbHolds.climbUuid,
            holdId: boardClimbHolds.holdId,
            revision: sql<string>`xmin::text`,
          })
          .from(boardClimbHolds)
          .where(eq(boardClimbHolds.boardType, 'quantum'))
          .orderBy(boardClimbHolds.climbUuid, boardClimbHolds.holdId),
        stats: await db
          .select({
            climbUuid: boardClimbStats.climbUuid,
            revision: sql<string>`xmin::text`,
            upstreamSyncedAt: boardClimbStats.upstreamSyncedAt,
          })
          .from(boardClimbStats)
          .where(eq(boardClimbStats.boardType, 'quantum'))
          .orderBy(boardClimbStats.climbUuid),
      };
    }
    await importValidatedQuantumSnapshot(snapshot, undefined, { now: () => IMPORTED_AT });
    const initial = await rowVersions();
    const identical = { ...snapshot, eventId: 'e'.repeat(64), manifestCreatedAt: snapshot.manifestCreatedAt + 1 };
    await importValidatedQuantumSnapshot(identical, undefined, { now: () => new Date(IMPORTED_AT.getTime() + 60_000) });
    expect(await rowVersions()).toEqual(initial);

    const edited = {
      ...identical,
      eventId: 'd'.repeat(64),
      manifestCreatedAt: identical.manifestCreatedAt + 1,
      rows: {
        ...identical.rows,
        routes: identical.rows.routes.map((route, index) =>
          index === 0 ? { ...route, name: 'Edited route', ascents: route.ascents + 1 } : route,
        ),
      },
    };
    await importValidatedQuantumSnapshot(edited, undefined, { now: () => new Date(IMPORTED_AT.getTime() + 120_000) });
    const changed = await rowVersions();
    expect(changed.holds).toEqual(initial.holds);
    expect(changed.climbs.find((climb) => climb.uuid === REPLACEMENT_UUID)).toEqual(
      initial.climbs.find((climb) => climb.uuid === REPLACEMENT_UUID),
    );
    expect(changed.stats.find((stats) => stats.climbUuid === REPLACEMENT_UUID)).toEqual(
      initial.stats.find((stats) => stats.climbUuid === REPLACEMENT_UUID),
    );
    expect(changed.climbs.find((climb) => climb.uuid === CATALOG_UUID)?.revision).not.toBe(
      initial.climbs.find((climb) => climb.uuid === CATALOG_UUID)?.revision,
    );
    expect(changed.stats.find((stats) => stats.climbUuid === CATALOG_UUID)?.revision).not.toBe(
      initial.stats.find((stats) => stats.climbUuid === CATALOG_UUID)?.revision,
    );
  });

  it('stores one shared-family climb and preserves canonical identity when size membership changes', async () => {
    await importValidatedQuantumSnapshot(quantumSharedRouteFixture(), undefined, { database: db });
    expect(await db.select().from(boardClimbs).where(eq(boardClimbs.boardType, 'quantum'))).toMatchObject([
      { uuid: CATALOG_UUID, compatibleSizeIds: [9201, 9202, 9203] },
    ]);
    expect(await db.select().from(boardClimbStats).where(eq(boardClimbStats.boardType, 'quantum'))).toHaveLength(1);
    expect(await db.select().from(boardClimbAliases).where(eq(boardClimbAliases.boardType, 'quantum'))).toHaveLength(4);
    const next = quantumSharedRouteFixture({ eventId: 'e'.repeat(64), manifestCreatedAt: 1_800_000_001 });
    const onlyMedium = {
      ...next,
      rows: { ...next.rows, routeModels: next.rows.routeModels.filter((row) => row.model === 'm') },
    };
    await importValidatedQuantumSnapshot(onlyMedium, undefined, { database: db });
    expect(await db.select().from(boardClimbs).where(eq(boardClimbs.boardType, 'quantum'))).toMatchObject([
      { uuid: CATALOG_UUID, compatibleSizeIds: [9203] },
    ]);
    await populateDenormalizedColumns(db, 'quantum', [CATALOG_UUID]);
    expect(await db.select().from(boardClimbs).where(eq(boardClimbs.uuid, CATALOG_UUID))).toMatchObject([
      { compatibleSizeIds: [9203] },
    ]);
  });

  it('rolls back a concurrent foreign alias without retargeting it', async () => {
    await importValidatedQuantumSnapshot(quantumCatalogFixture(), undefined, { database: db });
    const foreignClimbUuid = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const sourceAliasUuid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const concurrentDatabase = databaseWithConcurrentClimb(async () => {
      await db.insert(boardClimbs).values({
        uuid: foreignClimbUuid,
        boardType: 'quantum',
        layoutId: 9101,
        userId: 'user-123',
        isBoardseshAuthored: true,
      });
      await db.insert(boardClimbAliases).values({
        boardType: 'quantum',
        aliasUuid: sourceAliasUuid,
        canonicalUuid: foreignClimbUuid,
        source: 'foreign',
      });
    });
    await expect(
      importValidatedQuantumSnapshot(
        quantumCatalogFixture({
          appUuid: sourceAliasUuid,
          routeUuid: '22222222-2222-4222-8222-222222222222',
          eventId: 'e'.repeat(64),
          manifestCreatedAt: 1_800_000_001,
        }),
        undefined,
        { database: concurrentDatabase },
      ),
    ).rejects.toThrow(/existing climb alias/);
    expect(
      await db
        .select()
        .from(boardClimbAliases)
        .where(and(eq(boardClimbAliases.boardType, 'quantum'), eq(boardClimbAliases.aliasUuid, sourceAliasUuid))),
    ).toMatchObject([{ canonicalUuid: foreignClimbUuid, source: 'foreign' }]);
    expect(await db.select().from(boardClimbs).where(eq(boardClimbs.uuid, REPLACEMENT_UUID))).toEqual([]);
    expect(await catalogSyncStates()).toMatchObject([{ revisionId: 'f'.repeat(64) }]);
  });

  it('transactionally upserts the canonical reference, geometry, climbs, metadata, and stats', async () => {
    const result = await importValidatedQuantumSnapshot(quantumCatalogFixture(), undefined, {
      database: db,
      now: () => IMPORTED_AT,
    });

    expect(result).toMatchObject({
      outcome: 'applied',
      modelsUpserted: 3,
      diodesUpserted: 6,
      climbsUpserted: 1,
      holdsUpserted: 4,
      statsUpserted: 1,
    });
    await expect(db.select().from(boardProducts).where(eq(boardProducts.boardType, 'quantum'))).resolves.toMatchObject([
      { id: 91, name: 'Quantum Board', maxCountInFrame: 92 },
      { id: 94, name: 'Quantum S Fitness', maxCountInFrame: 92 },
      { id: 95, name: 'Quantum Belay Board', maxCountInFrame: 92 },
    ]);
    expect(
      await db.select().from(boardDifficultyGrades).where(eq(boardDifficultyGrades.boardType, 'quantum')),
    ).toHaveLength(24);
    expect(await db.select().from(boardLayouts).where(eq(boardLayouts.boardType, 'quantum'))).toHaveLength(3);
    expect(await db.select().from(boardHoles).where(eq(boardHoles.boardType, 'quantum'))).toHaveLength(6);
    expect(await db.select().from(boardPlacements).where(eq(boardPlacements.boardType, 'quantum'))).toHaveLength(6);
    expect(await db.select().from(boardLeds).where(eq(boardLeds.boardType, 'quantum'))).toHaveLength(8);

    const climbs = await db.select().from(boardClimbs).where(eq(boardClimbs.boardType, 'quantum'));
    expect(climbs).toMatchObject([
      {
        uuid: CATALOG_UUID,
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
    expect(climbs[0]?.sourceMetadata).toEqual({
      grade: '[12,13]',
      tags: ['pinch', 'technical'],
      plays: 20,
      updatedAt: 1_700_000_100,
    });
    expect(climbs[0]?.characteristics).toEqual([
      'quantum_standard',
      'quantum_campusing',
      'quantum_edge',
      'quantum_kickplate',
      'quantum_matching',
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
    await expect(catalogSyncStates()).resolves.toMatchObject([
      {
        revisionId: 'f'.repeat(64),
        revisionTimestamp: 1_800_000_000,
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
        { uuid: CATALOG_UUID, isListed: false },
        { uuid: REPLACEMENT_UUID, isListed: true },
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

  it('preserves retained app climbs after account deletion and rejects their source UUID collisions', async () => {
    await importValidatedQuantumSnapshot(quantumCatalogFixture(), undefined, { database: db });
    const retainedUuid = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    await db.insert(boardClimbs).values({
      uuid: retainedUuid,
      boardType: 'quantum',
      layoutId: 9101,
      name: 'Retained app climb',
      userId: null,
      isBoardseshAuthored: true,
      isDraft: false,
      isListed: true,
      controllerRouteUuid: '44444444-4444-4444-8444-444444444444',
    });
    await db.insert(boardClimbStats).values({ boardType: 'quantum', climbUuid: retainedUuid, angle: 55 });
    await importValidatedQuantumSnapshot(
      quantumCatalogFixture({ manifestCreatedAt: 1_800_000_001, eventId: 'e'.repeat(64) }),
      undefined,
      { database: db },
    );
    await expect(db.select().from(boardClimbs).where(eq(boardClimbs.uuid, retainedUuid))).resolves.toMatchObject([
      { name: 'Retained app climb', isListed: true, isBoardseshAuthored: true },
    ]);
    await expect(getQuantumCatalogAngles(9101)).resolves.toEqual([{ angle: 40 }]);
    await expect(
      importValidatedQuantumSnapshot(
        quantumCatalogFixture({
          appUuid: retainedUuid,
          manifestCreatedAt: 1_800_000_002,
          eventId: 'd'.repeat(64),
        }),
        undefined,
        { database: db },
      ),
    ).rejects.toThrow(/non-source climb/);
    await expect(db.select().from(boardClimbs).where(eq(boardClimbs.uuid, retainedUuid))).resolves.toMatchObject([
      { name: 'Retained app climb', isListed: true, isBoardseshAuthored: true },
    ]);
  });

  it('rolls back when an app climb commits after ownership validation but before the upsert', async () => {
    await importValidatedQuantumSnapshot(quantumCatalogFixture(), undefined, { database: db });
    const concurrentUuid = REPLACEMENT_UUID;
    const concurrentDatabase = databaseWithConcurrentClimb(async () => {
      await db.insert(boardClimbs).values({
        uuid: concurrentUuid,
        boardType: 'quantum',
        layoutId: 9101,
        name: 'Concurrent app climb',
        isBoardseshAuthored: true,
        controllerRouteUuid: '44444444-4444-4444-8444-444444444444',
        isDraft: false,
        isListed: true,
      });
      await db.insert(boardClimbHolds).values({
        boardType: 'quantum',
        climbUuid: concurrentUuid,
        holdId: 1000007,
        holdState: 'STARTING',
        frameNumber: 0,
      });
    });
    await expect(
      importValidatedQuantumSnapshot(
        quantumCatalogFixture({
          appUuid: concurrentUuid,
          manifestCreatedAt: 1_800_000_001,
          eventId: 'e'.repeat(64),
          routeUuid: '22222222-2222-4222-8222-222222222222',
        }),
        undefined,
        { database: concurrentDatabase },
      ),
    ).rejects.toThrow(/non-source climb/);
    await expect(db.select().from(boardClimbs).where(eq(boardClimbs.uuid, concurrentUuid))).resolves.toMatchObject([
      { name: 'Concurrent app climb', isBoardseshAuthored: true, isListed: true },
    ]);
    await expect(
      db.select().from(boardClimbHolds).where(eq(boardClimbHolds.climbUuid, concurrentUuid)),
    ).resolves.toHaveLength(1);
    await expect(db.select().from(boardClimbs).where(eq(boardClimbs.uuid, CATALOG_UUID))).resolves.toMatchObject([
      { isListed: true },
    ]);
    await expect(catalogSyncStates()).resolves.toMatchObject([{ revisionId: 'f'.repeat(64) }]);
  });

  it('backfills the exact Quantum model despite overlapping bounds and edge holds', async () => {
    await importValidatedQuantumSnapshot(quantumCatalogFixture(), undefined, { database: db });
    await db
      .update(boardProductSizes)
      .set({ edgeLeft: -10000, edgeRight: 10000, edgeBottom: -10000, edgeTop: 10000 })
      .where(and(eq(boardProductSizes.boardType, 'quantum'), ne(boardProductSizes.id, 9201)));
    const authoredUuid = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    await db.insert(boardClimbs).values({
      uuid: authoredUuid,
      boardType: 'quantum',
      layoutId: 9101,
      name: 'Edge holds',
      frames: 'p1000007r12p1000009r14',
      compatibleSizeIds: [9202],
      holdFingerprint: 'retained-fingerprint',
    });
    await populateDenormalizedColumns(db, 'quantum', [authoredUuid]);
    await expect(db.select().from(boardClimbs).where(eq(boardClimbs.uuid, authoredUuid))).resolves.toMatchObject([
      {
        compatibleSizeIds: [9201],
        requiredSetIds: [1],
        edgeLeft: 1234,
        edgeBottom: -2345,
        edgeTop: 7000,
        holdFingerprint: 'retained-fingerprint',
      },
    ]);
    // An ownerless, app-authored route still derives physical membership,
    // even when it has its own controller UUID for BLE activation.
    await db
      .update(boardClimbs)
      .set({
        frames: 'p1000007r12',
        isBoardseshAuthored: true,
        controllerRouteUuid: authoredUuid,
      })
      .where(eq(boardClimbs.uuid, authoredUuid));
    await populateDenormalizedColumns(db, 'quantum', [authoredUuid]);
    await expect(db.select().from(boardClimbs).where(eq(boardClimbs.uuid, authoredUuid))).resolves.toMatchObject([
      { compatibleSizeIds: [9201, 9202, 9203] },
    ]);
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
      { uuid: CATALOG_UUID, isListed: true },
    ]);
    await expect(catalogSyncStates()).resolves.toMatchObject([{ lastError: null }]);
  });

  it.each([
    { label: 'holds', changes: { steps: [1, 3] } },
    { label: 'controller UUID', changes: { routeUuid: '33333333-3333-4333-8333-333333333333' } },
    { label: 'layout', changes: { model: 'l', steps: [1] } },
  ] satisfies { label: string; changes: QuantumFixtureOptions }[])(
    'rejects changed source $label under an existing app UUID',
    async ({ changes }) => {
      await importValidatedQuantumSnapshot(quantumCatalogFixture(), undefined, { database: db });
      await expect(
        importValidatedQuantumSnapshot(
          quantumCatalogFixture({
            ...changes,
            manifestCreatedAt: 1_800_000_001,
            eventId: 'e'.repeat(64),
          }),
          undefined,
          { database: db },
        ),
      ).rejects.toBeInstanceOf(QuantumRouteGeometryDriftError);
      await expect(db.select().from(boardClimbs).where(eq(boardClimbs.boardType, 'quantum'))).resolves.toMatchObject([
        {
          uuid: CATALOG_UUID,
          layoutId: 9101,
          controllerRouteUuid: '11111111-1111-4111-8111-111111111111',
          frames: 'p1000007r12p1000008r13p1000009r14p1000010r13',
          isListed: true,
        },
      ]);
      await expect(catalogSyncStates()).resolves.toMatchObject([
        { revisionId: 'f'.repeat(64), lastError: expect.stringContaining('canonical holds') },
      ]);
    },
  );

  it('keeps a delisted route bound to its original geometry when reintroduced', async () => {
    await importValidatedQuantumSnapshot(quantumCatalogFixture(), undefined, { database: db });
    await importValidatedQuantumSnapshot(
      quantumCatalogFixture({
        appUuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        routeUuid: '22222222-2222-4222-8222-222222222222',
        manifestCreatedAt: 1_800_000_001,
        eventId: 'e'.repeat(64),
      }),
      undefined,
      { database: db },
    );
    await expect(
      importValidatedQuantumSnapshot(
        quantumCatalogFixture({
          steps: [1, 3],
          manifestCreatedAt: 1_800_000_002,
          eventId: 'd'.repeat(64),
        }),
        undefined,
        { database: db },
      ),
    ).rejects.toBeInstanceOf(QuantumRouteGeometryDriftError);
    await expect(db.select().from(boardClimbs).where(eq(boardClimbs.uuid, CATALOG_UUID))).resolves.toMatchObject([
      { isListed: false, frames: 'p1000007r12p1000008r13p1000009r14p1000010r13' },
    ]);
    await expect(db.select().from(boardClimbs).where(eq(boardClimbs.uuid, REPLACEMENT_UUID))).resolves.toMatchObject([
      { isListed: true },
    ]);
    await expect(catalogSyncStates()).resolves.toMatchObject([{ revisionId: 'e'.repeat(64) }]);

    await importValidatedQuantumSnapshot(
      quantumCatalogFixture({
        routeName: 'Updated source name',
        grade: '[13,14]',
        manifestCreatedAt: 1_800_000_003,
        eventId: 'c'.repeat(64),
      }),
      undefined,
      { database: db },
    );
    await expect(db.select().from(boardClimbs).where(eq(boardClimbs.uuid, CATALOG_UUID))).resolves.toMatchObject([
      { isListed: true, name: 'Updated source name', frames: 'p1000007r12p1000008r13p1000009r14p1000010r13' },
    ]);
  });

  it('rejects a source geometry race at the guarded upsert and preserves the checkpoint', async () => {
    await importValidatedQuantumSnapshot(quantumCatalogFixture(), undefined, { database: db });
    const concurrentUuid = REPLACEMENT_UUID;
    const concurrentDatabase = databaseWithConcurrentClimb(async () => {
      await db.insert(boardClimbs).values({
        uuid: concurrentUuid,
        boardType: 'quantum',
        layoutId: 9101,
        name: 'Already bound source route',
        userId: null,
        isBoardseshAuthored: false,
        isDraft: false,
        isListed: true,
        controllerRouteUuid: '33333333-3333-4333-8333-333333333333',
        frames: 'p1000007r12',
      });
    });
    await expect(
      importValidatedQuantumSnapshot(
        quantumCatalogFixture({
          appUuid: concurrentUuid,
          routeUuid: '22222222-2222-4222-8222-222222222222',
          manifestCreatedAt: 1_800_000_001,
          eventId: 'e'.repeat(64),
        }),
        undefined,
        { database: concurrentDatabase },
      ),
    ).rejects.toBeInstanceOf(QuantumRouteGeometryDriftError);
    await expect(db.select().from(boardClimbs).where(eq(boardClimbs.uuid, concurrentUuid))).resolves.toMatchObject([
      {
        name: 'Already bound source route',
        controllerRouteUuid: '33333333-3333-4333-8333-333333333333',
        frames: 'p1000007r12',
      },
    ]);
    await expect(catalogSyncStates()).resolves.toMatchObject([{ revisionId: 'f'.repeat(64) }]);
  });

  it('rejects a signed LED address remap before changing canonical geometry', async () => {
    await importValidatedQuantumSnapshot(quantumCatalogFixture(), undefined, { database: db });
    const remapped = quantumFixtureDiodes().map((diode, index) =>
      index === 0 ? { ...diode, autocadId: 1001 } : diode,
    );
    await expect(
      importValidatedQuantumSnapshot(
        quantumCatalogFixture({
          diodes: remapped,
          manifestCreatedAt: 1_800_000_001,
          eventId: 'e'.repeat(64),
        }),
        undefined,
        { database: db },
      ),
    ).rejects.toBeInstanceOf(QuantumHardwareFingerprintDriftError);
    await expect(
      db
        .select()
        .from(boardLeds)
        .where(and(eq(boardLeds.boardType, 'quantum'), eq(boardLeds.id, 1000007))),
    ).resolves.toMatchObject([{ position: 1 }]);
    await expect(catalogSyncStates()).resolves.toMatchObject([{ revisionId: 'f'.repeat(64) }]);
  });

  it('rejects an app UUID owned by another board instead of overwriting it', async () => {
    const collidingUuid = CATALOG_UUID;
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

  it('ignores local off-angle tick stats and follows the next signed route angle', async () => {
    await importValidatedQuantumSnapshot(quantumCatalogFixture(), undefined, { database: db });
    // A local tick at another angle creates a stats row for the same source
    // climb; it does not extend the manufacturer's supported-angle catalog.
    await db.insert(boardClimbStats).values({
      boardType: 'quantum',
      climbUuid: CATALOG_UUID,
      angle: 55,
      boardseshAscensionistCount: 1,
      ascensionistCount: 1,
    });
    await expect(getQuantumCatalogAngles(9101)).resolves.toEqual([{ angle: 40 }]);

    await importValidatedQuantumSnapshot(
      quantumCatalogFixture({
        angle: 45,
        eventId: 'e'.repeat(64),
        manifestCreatedAt: 1_800_000_001,
      }),
      undefined,
      { database: db },
    );
    await expect(getQuantumCatalogAngles(9101)).resolves.toEqual([{ angle: 45 }]);
    // Keep existing per-angle observations intact; neither old upstream stats
    // nor local tick history defines the current signed route's angle.
    await expect(
      db
        .select()
        .from(boardClimbStats)
        .where(and(eq(boardClimbStats.boardType, 'quantum'), eq(boardClimbStats.climbUuid, CATALOG_UUID))),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ angle: 40 }),
        expect.objectContaining({ angle: 45 }),
        expect.objectContaining({ angle: 55, boardseshAscensionistCount: 1 }),
      ]),
    );
  });

  it('excludes delisted signed-catalog routes from Quantum angles', async () => {
    await importValidatedQuantumSnapshot(quantumCatalogFixture(), undefined, { database: db });
    await db.update(boardClimbs).set({ isListed: false }).where(eq(boardClimbs.uuid, CATALOG_UUID));

    await expect(getQuantumCatalogAngles(9101)).resolves.toEqual([]);
  });
});
