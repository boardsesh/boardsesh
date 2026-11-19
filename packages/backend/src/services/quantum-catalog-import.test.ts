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
  QuantumRouteGeometryDriftError,
  importPreparedEwallsCatalog,
  EwallsCheckpointChangedError,
  EwallsCatalogAuthorityChangedError,
} from './quantum-catalog-import';
import type { EwallsBootstrap, EwallsDelta } from '@boardsesh/quantum-sync';
import { QUANTUM_HARDWARE_FINGERPRINT } from '@boardsesh/board-constants/quantum';
import { prepareQuantumCatalog, type PreparedQuantumCatalog } from './quantum-catalog-mapping';
import { loadEwallsCatalogState } from './ewalls-catalog-state';
import { getQuantumCatalogAngles } from '../graphql/resolvers/board/queries';
import { quantumCanonicalClimbUuid } from './quantum-catalog-mapping';
import {
  quantumCatalogFixture,
  importFixture,
  quantumSharedRouteFixture,
  type QuantumFixtureOptions,
} from './__tests__/quantum-catalog-fixture';

const FIXTURE_SCOPE = { board: '', forcedType: 'big' };
async function catalogSyncStates() {
  const state = await loadEwallsCatalogState(db, FIXTURE_SCOPE, 'catalogue-service');
  return state ? [state] : [];
}

const CATALOG_UUID = quantumCanonicalClimbUuid(9101, '11111111-1111-4111-8111-111111111111');
const REPLACEMENT_UUID = quantumCanonicalClimbUuid(9101, '22222222-2222-4222-8222-222222222222');
const IMPORTED_AT = new Date('2026-08-30T12:00:00.000Z');
const SOURCE_ROUTE_ID = '11111111-1111-4111-8111-111111111111';

function apiBatch(
  forcedType: string,
  checkpoint: string,
  baseCheckpoint: string | null = null,
  routes: { upsert: readonly { id: string }[]; deleted: readonly string[] } = {
    upsert: [{ id: SOURCE_ROUTE_ID }],
    deleted: [],
  },
): EwallsBootstrap | EwallsDelta {
  const collections = {
    routes,
    scope: { board: '', forcedType },
    checkpoint,
    diodes: null,
    account: {
      ascents: { upsert: [], deleted: [] },
      favorites: { upsert: [], deleted: [] },
      projects: { upsert: [], deleted: [] },
    },
  };
  return baseCheckpoint === null
    ? { ...collections, kind: 'bootstrap', baseCheckpoint: null }
    : { ...collections, kind: 'delta', baseCheckpoint };
}

function apiCatalog(empty = false, routeUuid = SOURCE_ROUTE_ID): PreparedQuantumCatalog {
  const prepared = prepareQuantumCatalog(quantumSharedRouteFixture({ routeUuid }));
  // Import transaction tests use the small canonical fixture; immutable-map
  // conformance is exercised independently at the direct API mapping boundary.
  return {
    ...prepared,
    hardwareFingerprint: QUANTUM_HARDWARE_FINGERPRINT,
    climbs: empty ? [] : prepared.climbs,
    holds: empty ? [] : prepared.holds,
    stats: empty ? [] : prepared.stats,
    aliases: empty
      ? []
      : [...prepared.aliases, { aliasUuid: routeUuid, canonicalUuid: quantumCanonicalClimbUuid(9101, routeUuid) }],
  };
}

function importApi(
  batch: EwallsBootstrap | EwallsDelta,
  expectedCheckpoint: string | null,
  empty = false,
  routeUuid = SOURCE_ROUTE_ID,
) {
  return importPreparedEwallsCatalog(
    {
      batch,
      expectedCheckpoint,
      catalog: apiCatalog(empty, routeUuid),
      upstreamAccountId: 'catalogue-service',
      diodes: [{ id: 'fixture-diode', autocadId: 1 }],
    },
    { database: db },
  );
}

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

  it.each(['account', 'board'] as const)('refuses a silent shared-catalogue %s rebind', async (changedBinding) => {
    await importApi(apiBatch('big', 'original authority'), null);
    const next = apiBatch('big', 'replacement authority', null, { upsert: [], deleted: [] });
    const batch =
      changedBinding === 'board' ? { ...next, scope: { ...next.scope, board: 'QB_different_board' } } : next;
    const upstreamAccountId = changedBinding === 'account' ? 'another-account' : 'catalogue-service';
    await expect(
      importPreparedEwallsCatalog(
        { batch, catalog: apiCatalog(true), diodes: [], upstreamAccountId, expectedCheckpoint: null },
        { database: db },
      ),
    ).rejects.toBeInstanceOf(EwallsCatalogAuthorityChangedError);
    expect((await loadEwallsCatalogState(db, { board: '', forcedType: 'big' }, 'catalogue-service'))?.checkpoint).toBe(
      'original authority',
    );
    expect(await loadEwallsCatalogState(db, batch.scope, upstreamAccountId)).toBeNull();
    await expect(db.select().from(boardClimbs).where(eq(boardClimbs.uuid, CATALOG_UUID))).resolves.toMatchObject([
      { isListed: true },
    ]);
  });

  it('applies API scope membership and tombstones without delisting another model', async () => {
    await importApi(apiBatch('big', 'XL opaque / one'), null);
    await importApi(apiBatch('medium', 'L opaque / one'), null);
    await importApi(apiBatch('big', 'XL opaque / two', null, { upsert: [], deleted: [] }), 'XL opaque / one', true);
    await expect(db.select().from(boardClimbs).where(eq(boardClimbs.uuid, CATALOG_UUID))).resolves.toMatchObject([
      { isListed: true },
    ]);
    await importApi(
      apiBatch('medium', 'L opaque / two', 'L opaque / one', { upsert: [], deleted: [SOURCE_ROUTE_ID] }),
      'L opaque / one',
      true,
    );
    await expect(db.select().from(boardClimbs).where(eq(boardClimbs.uuid, CATALOG_UUID))).resolves.toMatchObject([
      { isListed: false },
    ]);
    expect(
      (await loadEwallsCatalogState(db, { board: '', forcedType: 'medium' }, 'catalogue-service'))?.routeIds,
    ).toEqual([]);
    expect(await db.select().from(boardClimbHolds).where(eq(boardClimbHolds.climbUuid, CATALOG_UUID))).not.toHaveLength(
      0,
    );
  });

  it('rejects an API batch acquired from a superseded opaque checkpoint', async () => {
    await importApi(apiBatch('big', 'opaque : A'), null);
    await importApi(apiBatch('big', 'opaque : B', 'opaque : A'), 'opaque : A');
    await expect(importApi(apiBatch('big', 'opaque : C', 'opaque : A'), 'opaque : A')).rejects.toBeInstanceOf(
      EwallsCheckpointChangedError,
    );
    expect((await loadEwallsCatalogState(db, { board: '', forcedType: 'big' }, 'catalogue-service'))?.checkpoint).toBe(
      'opaque : B',
    );
    await expect(db.select().from(boardClimbs).where(eq(boardClimbs.uuid, CATALOG_UUID))).resolves.toMatchObject([
      { isListed: true },
    ]);
  });

  it('normalizes mixed-format membership and deletions across model scopes', async () => {
    const sourceId = 'abcdefab-1234-4abc-8def-0123456789ab';
    const canonicalId = quantumCanonicalClimbUuid(9101, sourceId);
    await importApi(
      apiBatch('big', 'XL1', null, { upsert: [{ id: sourceId.toUpperCase() }], deleted: [] }),
      null,
      false,
      sourceId,
    );
    await importApi(
      apiBatch('medium', 'L1', null, { upsert: [{ id: sourceId.replaceAll('-', '') }], deleted: [] }),
      null,
      false,
      sourceId,
    );
    await importApi(apiBatch('big', 'XL2', 'XL1', { upsert: [], deleted: [sourceId] }), 'XL1', true, sourceId);
    await expect(db.select().from(boardClimbs).where(eq(boardClimbs.uuid, canonicalId))).resolves.toMatchObject([
      { isListed: true },
    ]);
    await importApi(
      apiBatch('medium', 'L2', 'L1', { upsert: [], deleted: [sourceId.toUpperCase().replaceAll('-', '')] }),
      'L1',
      true,
      sourceId,
    );
    await expect(db.select().from(boardClimbs).where(eq(boardClimbs.uuid, canonicalId))).resolves.toMatchObject([
      { isListed: false },
    ]);
    expect(
      (await loadEwallsCatalogState(db, { board: '', forcedType: 'medium' }, 'catalogue-service'))?.routeIds,
    ).toEqual([]);
  });

  it('rolls back API data and checkpoint together when a source route changes its geometry', async () => {
    await importApi(apiBatch('big', 'before'), null);
    const prepared = apiCatalog();
    const changed = { ...prepared, climbs: prepared.climbs.map((climb) => ({ ...climb, frames: 'p1000007r14' })) };
    await expect(
      importPreparedEwallsCatalog(
        {
          batch: apiBatch('big', 'after', 'before'),
          expectedCheckpoint: 'before',
          catalog: changed,
          upstreamAccountId: 'catalogue-service',
          diodes: [],
        },
        { database: db },
      ),
    ).rejects.toBeInstanceOf(QuantumRouteGeometryDriftError);
    expect((await loadEwallsCatalogState(db, { board: '', forcedType: 'big' }, 'catalogue-service'))?.checkpoint).toBe(
      'before',
    );
  });

  it('keeps missing upstream statistics unknown, retains prior measurements, and accepts explicit zero', async () => {
    async function apply(checkpoint: string, base: string | null, count: number | null, rating: number | null) {
      const catalog = apiCatalog();
      const stats = catalog.stats.map((row) => ({
        ...row,
        upstreamAscensionistCount: count,
        ascensionistCount: count,
        upstreamQualityAverage: rating,
        qualityAverage: rating,
      }));
      await importPreparedEwallsCatalog({
        batch: apiBatch('big', checkpoint, base),
        expectedCheckpoint: base,
        catalog: { ...catalog, stats },
        upstreamAccountId: 'catalogue-service',
        diodes: [{ id: 'fixture-diode' }],
      });
      const [stored] = await db.select().from(boardClimbStats).where(eq(boardClimbStats.climbUuid, CATALOG_UUID));
      return stored;
    }
    expect(await apply('a', null, null, null)).toMatchObject({ ascensionistCount: null, qualityAverage: null });
    expect(await apply('b', 'a', null, null)).toMatchObject({ ascensionistCount: null, qualityAverage: null });
    await apply('c', 'b', 12, 4.5);
    await db
      .update(boardClimbStats)
      .set({ boardseshAscensionistCount: 2, boardseshQualityCount: 2, boardseshQualitySum: 2 })
      .where(eq(boardClimbStats.climbUuid, CATALOG_UUID));
    expect(await apply('d', 'c', null, null)).toMatchObject({
      upstreamAscensionistCount: 12,
      ascensionistCount: 14,
      upstreamQualityAverage: 4.5,
      qualityAverage: 4,
    });
    expect(await apply('e', 'd', 0, null)).toMatchObject({
      upstreamAscensionistCount: 0,
      ascensionistCount: 2,
      upstreamQualityAverage: 4.5,
      qualityAverage: 1,
    });
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
    await importFixture(snapshot, { now: () => IMPORTED_AT });
    const initial = await rowVersions();
    const identical = { ...snapshot, checkpoint: 'second' };
    await importFixture(identical, { now: () => new Date(IMPORTED_AT.getTime() + 60_000) });
    expect(await rowVersions()).toEqual(initial);

    const edited = {
      ...identical,
      checkpoint: 'third',
      rows: {
        ...identical.rows,
        routes: identical.rows.routes.map((route, index) =>
          index === 0 ? { ...route, name: 'Edited route', ascents: route.ascents + 1 } : route,
        ),
      },
    };
    await importFixture(edited, { now: () => new Date(IMPORTED_AT.getTime() + 120_000) });
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
    await importFixture(quantumSharedRouteFixture(), { database: db });
    expect(await db.select().from(boardClimbs).where(eq(boardClimbs.boardType, 'quantum'))).toMatchObject([
      { uuid: CATALOG_UUID, compatibleSizeIds: [9201, 9202, 9203] },
    ]);
    expect(await db.select().from(boardClimbStats).where(eq(boardClimbStats.boardType, 'quantum'))).toHaveLength(1);
    expect(await db.select().from(boardClimbAliases).where(eq(boardClimbAliases.boardType, 'quantum'))).toHaveLength(4);
    const next = quantumSharedRouteFixture({ checkpoint: 'second' });
    const onlyMedium = {
      ...next,
      rows: { ...next.rows, routeModels: next.rows.routeModels.filter((row) => row.model === 'm') },
    };
    await importFixture(onlyMedium, { database: db });
    expect(await db.select().from(boardClimbs).where(eq(boardClimbs.boardType, 'quantum'))).toMatchObject([
      { uuid: CATALOG_UUID, compatibleSizeIds: [9203] },
    ]);
    await populateDenormalizedColumns(db, 'quantum', [CATALOG_UUID]);
    expect(await db.select().from(boardClimbs).where(eq(boardClimbs.uuid, CATALOG_UUID))).toMatchObject([
      { compatibleSizeIds: [9203] },
    ]);
  });

  it('rolls back a concurrent foreign alias without retargeting it', async () => {
    await importFixture(quantumCatalogFixture(), { database: db });
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
      importFixture(
        quantumCatalogFixture({
          appUuid: sourceAliasUuid,
          routeUuid: '22222222-2222-4222-8222-222222222222',
          checkpoint: 'second',
        }),
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
    expect(await catalogSyncStates()).toMatchObject([{ checkpoint: 'first' }]);
  });

  it('transactionally upserts the canonical reference, geometry, climbs, metadata, and stats', async () => {
    const result = await importFixture(quantumCatalogFixture(), {
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
        checkpoint: 'first',
      },
    ]);
  });

  it('delists missing source routes without deleting them', async () => {
    await importFixture(quantumCatalogFixture(), { database: db });
    const replacement = quantumCatalogFixture({
      checkpoint: 'second',
      appUuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      routeUuid: '22222222-2222-4222-8222-222222222222',
      routeName: 'Replacement route',
    });
    await importFixture(replacement, { database: db });

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

  it('preserves retained app climbs after account deletion and rejects their source UUID collisions', async () => {
    await importFixture(quantumCatalogFixture(), { database: db });
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
    await importFixture(quantumCatalogFixture({ checkpoint: 'second' }), { database: db });
    await expect(db.select().from(boardClimbs).where(eq(boardClimbs.uuid, retainedUuid))).resolves.toMatchObject([
      { name: 'Retained app climb', isListed: true, isBoardseshAuthored: true },
    ]);
    await expect(getQuantumCatalogAngles(9101)).resolves.toEqual([{ angle: 40 }]);
    await expect(
      importFixture(
        quantumCatalogFixture({
          appUuid: retainedUuid,
          checkpoint: 'third',
        }),
        { database: db },
      ),
    ).rejects.toThrow(/non-source climb/);
    await expect(db.select().from(boardClimbs).where(eq(boardClimbs.uuid, retainedUuid))).resolves.toMatchObject([
      { name: 'Retained app climb', isListed: true, isBoardseshAuthored: true },
    ]);
  });

  it('rolls back when an app climb commits after ownership validation but before the upsert', async () => {
    await importFixture(quantumCatalogFixture(), { database: db });
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
      importFixture(
        quantumCatalogFixture({
          appUuid: concurrentUuid,
          checkpoint: 'second',
          routeUuid: '22222222-2222-4222-8222-222222222222',
        }),
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
    await expect(catalogSyncStates()).resolves.toMatchObject([{ checkpoint: 'first' }]);
  });

  it('backfills the exact Quantum model despite overlapping bounds and edge holds', async () => {
    await importFixture(quantumCatalogFixture(), { database: db });
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

  it.each([
    { label: 'holds', changes: { steps: [1, 3] } },
    { label: 'controller UUID', changes: { routeUuid: '33333333-3333-4333-8333-333333333333' } },
    { label: 'layout', changes: { model: 'l', steps: [1] } },
  ] satisfies { label: string; changes: QuantumFixtureOptions }[])(
    'rejects changed source $label under an existing app UUID',
    async ({ changes }) => {
      await importFixture(quantumCatalogFixture(), { database: db });
      await expect(
        importFixture(
          quantumCatalogFixture({
            ...changes,
            checkpoint: 'second',
          }),
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
      await expect(catalogSyncStates()).resolves.toMatchObject([{ checkpoint: 'first' }]);
    },
  );

  it('keeps a delisted route bound to its original geometry when reintroduced', async () => {
    await importFixture(quantumCatalogFixture(), { database: db });
    await importFixture(
      quantumCatalogFixture({
        appUuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        routeUuid: '22222222-2222-4222-8222-222222222222',
        checkpoint: 'second',
      }),
      { database: db },
    );
    await expect(
      importFixture(
        quantumCatalogFixture({
          steps: [1, 3],
          checkpoint: 'third',
        }),
        { database: db },
      ),
    ).rejects.toBeInstanceOf(QuantumRouteGeometryDriftError);
    await expect(db.select().from(boardClimbs).where(eq(boardClimbs.uuid, CATALOG_UUID))).resolves.toMatchObject([
      { isListed: false, frames: 'p1000007r12p1000008r13p1000009r14p1000010r13' },
    ]);
    await expect(db.select().from(boardClimbs).where(eq(boardClimbs.uuid, REPLACEMENT_UUID))).resolves.toMatchObject([
      { isListed: true },
    ]);
    await expect(catalogSyncStates()).resolves.toMatchObject([{ checkpoint: 'second' }]);

    await importFixture(
      quantumCatalogFixture({
        routeName: 'Updated source name',
        grade: '[13,14]',
        checkpoint: 'fourth',
      }),
      { database: db },
    );
    await expect(db.select().from(boardClimbs).where(eq(boardClimbs.uuid, CATALOG_UUID))).resolves.toMatchObject([
      { isListed: true, name: 'Updated source name', frames: 'p1000007r12p1000008r13p1000009r14p1000010r13' },
    ]);
  });

  it('rejects a source geometry race at the guarded upsert and preserves the checkpoint', async () => {
    await importFixture(quantumCatalogFixture(), { database: db });
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
      importFixture(
        quantumCatalogFixture({
          appUuid: concurrentUuid,
          routeUuid: '22222222-2222-4222-8222-222222222222',
          checkpoint: 'second',
        }),
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
    await expect(catalogSyncStates()).resolves.toMatchObject([{ checkpoint: 'first' }]);
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
      await expect(importFixture(quantumCatalogFixture(), { database: db })).rejects.toThrow(/non-source climb/);
      await expect(db.select().from(boardClimbs).where(eq(boardClimbs.uuid, collidingUuid))).resolves.toMatchObject([
        { boardType: 'kilter', name: 'Existing Kilter climb' },
      ]);
    } finally {
      await db.delete(boardClimbs).where(eq(boardClimbs.uuid, collidingUuid));
    }
  });

  it('derives Quantum angles only from catalog rows', async () => {
    await importFixture(quantumCatalogFixture(), { database: db });
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

  it('ignores local off-angle tick stats and follows the next catalog route angle', async () => {
    await importFixture(quantumCatalogFixture(), { database: db });
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

    await importFixture(
      quantumCatalogFixture({
        angle: 45,
        checkpoint: 'second',
      }),
      { database: db },
    );
    await expect(getQuantumCatalogAngles(9101)).resolves.toEqual([{ angle: 45 }]);
    // Local history remains queryable after the source aggregate moves.
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

  it('retires obsolete route-level aggregates across known and unknown angles while keeping local history', async () => {
    await importFixture(quantumCatalogFixture({ angle: 30 }));
    const oldAngle = and(eq(boardClimbStats.climbUuid, CATALOG_UUID), eq(boardClimbStats.angle, 30));
    await db
      .update(boardClimbStats)
      .set({ boardseshAscensionistCount: 2, boardseshQualitySum: 7, boardseshQualityCount: 2 })
      .where(oldAngle);
    await importFixture(quantumCatalogFixture({ angle: 40, checkpoint: 'moved' }));
    async function row(angle: number) {
      const [stored] = await db
        .select()
        .from(boardClimbStats)
        .where(and(eq(boardClimbStats.climbUuid, CATALOG_UUID), eq(boardClimbStats.angle, angle)));
      return stored;
    }
    const retired = await row(30);
    expect(retired).toMatchObject({
      upstreamAscensionistCount: null,
      upstreamQualityAverage: null,
      upstreamSyncedAt: null,
      ascensionistCount: 2,
      boardseshQualitySum: 7,
      boardseshQualityCount: 2,
      qualityAverage: 3.5,
      difficultyAverage: null,
      displayDifficulty: null,
    });
    expect(await row(40)).toMatchObject({
      upstreamAscensionistCount: 12,
      upstreamQualityAverage: 4.5,
      displayDifficulty: 15,
    });
    const tickGrade = '2026-09-01T12:00:00';
    await db
      .update(boardClimbStats)
      .set({ tickGradedAt: tickGrade, displayDifficulty: 18, difficultyAverage: 18.5 })
      .where(and(eq(boardClimbStats.climbUuid, CATALOG_UUID), eq(boardClimbStats.angle, 40)));
    const catalog = apiCatalog();
    const batch = apiBatch('big', 'angle unknown', 'moved');
    await importPreparedEwallsCatalog({
      batch,
      expectedCheckpoint: 'moved',
      catalog: {
        ...catalog,
        climbs: prepareQuantumCatalog(quantumCatalogFixture()).climbs.map((climb) => ({ ...climb, angle: null })),
        stats: [],
        holds: [],
      },
      diodes: [],
      upstreamAccountId: 'catalogue-service',
    });
    expect(await row(40)).toMatchObject({
      upstreamAscensionistCount: null,
      upstreamQualityAverage: null,
      upstreamSyncedAt: null,
      ascensionistCount: null,
      qualityAverage: null,
      displayDifficulty: 18,
      difficultyAverage: 18.5,
    });
    expect((await row(40)).tickGradedAt).toBeTruthy();
    expect(await row(30)).toEqual(retired);
  });

  it('excludes delisted catalog routes from Quantum angles', async () => {
    await importFixture(quantumCatalogFixture(), { database: db });
    await db.update(boardClimbs).set({ isListed: false }).where(eq(boardClimbs.uuid, CATALOG_UUID));

    await expect(getQuantumCatalogAngles(9101)).resolves.toEqual([]);
  });
});
