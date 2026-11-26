import {
  and,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  like,
  not,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from 'drizzle-orm';
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
import { blendedQualityAverageSql, quantumCatalogClimbCondition } from '@boardsesh/db/queries';
import type { EwallsBootstrap, EwallsDelta, EwallsRecord } from '@boardsesh/quantum-sync';
import { db, type Database } from '../db/client';
import { QUANTUM_BOARD_TYPE, type PreparedQuantumCatalog } from './quantum-catalog-mapping';
import { QUANTUM_HARDWARE_FINGERPRINT, QUANTUM_MODELS } from '@boardsesh/board-constants/quantum';
import { quantumCanonicalClimbUuid } from './quantum-catalog-mapping';
import {
  EWALLS_CATALOG_STATE_PREFIX,
  ewallsCatalogStateKey,
  loadEwallsCatalogState,
  makeEwallsCatalogState,
  readEwallsCatalogState,
} from './ewalls-catalog-state';
import {
  normalizeEwallsRouteId,
  normalizeEwallsTimestamp,
  type EwallsVisibilityWithdrawal,
} from './ewalls-catalog-mapping';
import { releasedEwallsModel, RELEASED_EWALLS_BOARD_TYPES } from './ewalls-catalog-scope';

const QUANTUM_IMPORT_BATCH_SIZE = 500;
const QUANTUM_IMPORT_LOCK_NAMESPACE = 0x5155_414e; // ASCII "QUAN"
const QUANTUM_IMPORT_LOCK_KEY = 1;

export type QuantumCatalogTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type QuantumCatalogBatchRunner = <Result>(
  run: (transaction: QuantumCatalogTransaction) => Promise<Result>,
) => Promise<Result>;

export type QuantumCatalogImportResult = Readonly<{
  outcome: 'applied' | 'unchanged';
  hardwareFingerprint: string;
  modelsUpserted: number;
  diodesUpserted: number;
  climbsUpserted: number;
  holdsUpserted: number;
  statsUpserted: number;
}>;

export class QuantumHardwareFingerprintDriftError extends Error {
  readonly code = 'QUANTUM_HARDWARE_FINGERPRINT_DRIFT';

  constructor(expectedFingerprint: string, receivedFingerprint: string) {
    super(
      `Quantum hardware fingerprint changed (expected ${expectedFingerprint}, received ${receivedFingerprint}); ` +
        'catalog mutation was refused.',
    );
    this.name = 'QuantumHardwareFingerprintDriftError';
  }
}

export class QuantumRouteGeometryDriftError extends Error {
  readonly code = 'QUANTUM_ROUTE_GEOMETRY_DRIFT';

  constructor(readonly climbUuid: string) {
    super(
      `Quantum source route ${climbUuid} changed its layout, controller UUID, or canonical holds; ` +
        'catalog mutation was refused. Publish a new route identity for changed geometry.',
    );
    this.name = 'QuantumRouteGeometryDriftError';
  }
}

export class EwallsCheckpointChangedError extends Error {
  constructor() {
    super(
      'eWalls catalogue checkpoint changed during acquisition; discard this batch and retry from the current checkpoint.',
    );
    this.name = 'EwallsCheckpointChangedError';
  }
}

export class EwallsCatalogAuthorityChangedError extends Error {
  constructor() {
    super(
      'The eWalls shared-catalogue account or board binding changed; an explicit complete catalogue rebind is required.',
    );
    this.name = 'EwallsCatalogAuthorityChangedError';
  }
}

/** Apply one complete, authenticated catalogue scope. Personal collections are
 * intentionally absent from the projection and from shared checkpoints. */
export async function importPreparedEwallsCatalog(
  input: {
    batch: EwallsBootstrap | EwallsDelta;
    catalog: PreparedQuantumCatalog;
    diodes: readonly EwallsRecord[];
    withdrawals?: readonly EwallsVisibilityWithdrawal[];
    upstreamAccountId: string;
    expectedCheckpoint: string | null;
  },
  options: {
    database?: Database;
    transaction?: QuantumCatalogBatchRunner;
    signal?: AbortSignal;
    now?: () => Date;
  } = {},
): Promise<QuantumCatalogImportResult> {
  const { batch, catalog: incomingCatalog, upstreamAccountId } = input;
  const modelKey = releasedEwallsModel(batch.scope.forcedType);
  const layoutId = QUANTUM_MODELS[modelKey].layoutId;
  if (incomingCatalog.hardwareFingerprint !== QUANTUM_HARDWARE_FINGERPRINT) {
    throw new QuantumHardwareFingerprintDriftError(QUANTUM_HARDWARE_FINGERPRINT, incomingCatalog.hardwareFingerprint);
  }
  if (batch.kind === 'delta' && batch.baseCheckpoint !== input.expectedCheckpoint)
    throw new EwallsCheckpointChangedError();
  if (incomingCatalog.climbs.some((climb) => climb.layoutId !== layoutId))
    throw new Error('eWalls catalogue crosses physical families');
  const database = options.database ?? db;
  const transactionRunner =
    options.transaction ??
    (<Result>(run: (transaction: QuantumCatalogTransaction) => Promise<Result>) => database.transaction(run));
  const stateKey = ewallsCatalogStateKey(batch.scope, upstreamAccountId);
  const upserts = batch.routes.upsert.map((route) => normalizeEwallsRouteId(route.id));
  const deletions = batch.routes.deleted.map(normalizeEwallsRouteId);
  const upsertIds = new Set(upserts);
  if (
    upsertIds.size !== upserts.length ||
    new Set(deletions).size !== deletions.length ||
    deletions.some((routeId) => upsertIds.has(routeId))
  ) {
    throw new Error('Ambiguous normalized eWalls route identities');
  }
  return transactionRunner(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(${QUANTUM_IMPORT_LOCK_NAMESPACE}, ${QUANTUM_IMPORT_LOCK_KEY})`,
    );
    throwIfAborted(options.signal);
    const importedAt = (options.now ?? (() => new Date()))();
    const prior = await loadEwallsCatalogState(transaction, batch.scope, upstreamAccountId);
    if ((prior?.checkpoint ?? null) !== input.expectedCheckpoint) throw new EwallsCheckpointChangedError();
    const scopeRows = await transaction
      .select({ tableName: boardSharedSyncs.tableName, metadata: boardSharedSyncs.metadata })
      .from(boardSharedSyncs)
      .where(
        and(
          eq(boardSharedSyncs.boardType, QUANTUM_BOARD_TYPE),
          like(boardSharedSyncs.tableName, `${EWALLS_CATALOG_STATE_PREFIX}%`),
        ),
      );
    const otherScopes = [];
    for (const row of scopeRows) {
      if (row.tableName === stateKey) continue;
      const other = readEwallsCatalogState(row.metadata);
      if (other.upstreamAccountId !== upstreamAccountId || other.scope.board !== batch.scope.board) {
        throw new EwallsCatalogAuthorityChangedError();
      }
      if (!RELEASED_EWALLS_BOARD_TYPES.includes(other.scope.forcedType)) continue;
      const otherModelKey = releasedEwallsModel(other.scope.forcedType);
      if (QUANTUM_MODELS[otherModelKey].layoutId !== layoutId) continue;
      otherScopes.push({ tableName: row.tableName, state: other });
    }
    const withdrawalRecords = { ...prior?.visibilityWithdrawals };
    const withdrawalFences = new Map<string, string>();
    for (const scope of [prior, ...otherScopes.map(({ state }) => state)]) {
      for (const [routeId, withdrawnAt] of Object.entries(scope?.visibilityWithdrawals ?? {})) {
        advanceRouteFence(withdrawalFences, routeId, withdrawnAt);
      }
    }
    const storedRoutes = await loadEwallsRouteVersions(transaction, layoutId, upserts, options.signal);
    for (const [routeId, stored] of storedRoutes) {
      if (stored.legacyWithdrawal) {
        const priorWithdrawal = withdrawalFences.get(routeId);
        if (priorWithdrawal === undefined || stored.legacyWithdrawal > priorWithdrawal) {
          advanceRouteFence(withdrawalFences, routeId, stored.legacyWithdrawal);
          withdrawalRecords[routeId] = stored.legacyWithdrawal;
        }
      }
    }
    const routeIds = new Set(batch.kind === 'bootstrap' ? [] : (prior?.routeIds ?? []));
    const priorRouteIds = new Set(prior?.routeIds ?? []);
    const visibilityWithdrawals = new Set<string>();
    const observedAt = importedAt.toISOString();
    for (const { routeId, updatedAt } of input.withdrawals ?? []) {
      const stored = storedRoutes.get(routeId);
      const latestPublicVersion = stored?.publicVersion;
      if (updatedAt && latestPublicVersion && updatedAt < latestPublicVersion) {
        if (stored?.isListed && priorRouteIds.has(routeId)) routeIds.add(routeId);
        continue;
      }
      const withdrawnAt =
        updatedAt ?? (latestPublicVersion && latestPublicVersion > observedAt ? latestPublicVersion : observedAt);
      advanceRouteFence(withdrawalFences, routeId, withdrawnAt);
      withdrawalRecords[routeId] = withdrawalFences.get(routeId)!;
      visibilityWithdrawals.add(routeId);
      routeIds.delete(routeId);
    }
    const catalog = filterEwallsPublicRevisions(
      incomingCatalog,
      storedRoutes,
      withdrawalFences,
      priorRouteIds,
      routeIds,
    );
    for (const routeId of deletions) routeIds.delete(routeId);

    const retainedElsewhere = new Set<string>();
    for (const { tableName, state: other } of otherScopes) {
      const retainedIds = other.routeIds.filter((routeId) => !visibilityWithdrawals.has(routeId));
      for (const routeId of retainedIds) retainedElsewhere.add(routeId);
      if (retainedIds.length !== other.routeIds.length) {
        await transaction
          .update(boardSharedSyncs)
          .set({ metadata: { ...other, routeIds: retainedIds } })
          .where(and(eq(boardSharedSyncs.boardType, QUANTUM_BOARD_TYPE), eq(boardSharedSyncs.tableName, tableName)));
      }
    }
    const removed = [
      ...new Set([
        ...(prior?.routeIds ?? []).filter((routeId) => !routeIds.has(routeId) && !retainedElsewhere.has(routeId)),
        ...visibilityWithdrawals,
      ]),
    ].map((routeId) => quantumCanonicalClimbUuid(layoutId, routeId));
    await assertNoForeignClimbUuidCollisions(transaction, catalog, options.signal);
    const existing = await assertExistingQuantumRouteGeometry(transaction, catalog, options.signal);
    if (!prior) await upsertQuantumReferenceCatalog(transaction, catalog, options.signal);
    await reconcileQuantumClimbs(transaction, catalog, existing, importedAt, removed, options.signal);
    throwIfAborted(options.signal);
    const metadata = makeEwallsCatalogState({
      upstreamAccountId,
      scope: batch.scope,
      checkpoint: batch.checkpoint,
      routeIds: [...routeIds],
      visibilityWithdrawals: withdrawalRecords,
      diodes: input.diodes,
      hardwareFingerprint: catalog.hardwareFingerprint,
      importedAt,
    });
    await transaction
      .insert(boardSharedSyncs)
      .values({
        boardType: QUANTUM_BOARD_TYPE,
        tableName: stateKey,
        lastSynchronizedAt: importedAt.toISOString(),
        metadata,
      })
      .onConflictDoUpdate({
        target: [boardSharedSyncs.boardType, boardSharedSyncs.tableName],
        set: { lastSynchronizedAt: importedAt.toISOString(), metadata },
      });
    return Object.freeze({
      outcome: 'applied',
      hardwareFingerprint: catalog.hardwareFingerprint,
      modelsUpserted: catalog.layouts.length,
      diodesUpserted: catalog.placements.length,
      climbsUpserted: catalog.climbs.length,
      holdsUpserted: catalog.holds.length,
      statsUpserted: catalog.stats.length,
    });
  });
}

function advanceRouteFence(fences: Map<string, string>, routeId: string, timestamp: string): void {
  const previous = fences.get(routeId);
  if (previous === undefined || timestamp > previous) fences.set(routeId, timestamp);
}

type StoredEwallsRouteVersion = {
  isListed: boolean | null;
  publicVersion: string | null;
  legacyWithdrawal: string | null;
};

async function loadEwallsRouteVersions(
  transaction: QuantumCatalogTransaction,
  layoutId: number,
  routeIds: readonly string[],
  signal?: AbortSignal,
): Promise<Map<string, StoredEwallsRouteVersion>> {
  const versions = new Map<string, StoredEwallsRouteVersion>();
  await processBatches(routeIds, async (batch) => {
    throwIfAborted(signal);
    const storedRoutes = await transaction
      .select({
        uuid: boardClimbs.uuid,
        routeId: boardClimbs.controllerRouteUuid,
        isListed: boardClimbs.isListed,
        publicVersion: sql<string | null>`${boardClimbs.sourceMetadata}->>'updatedAt'`,
        legacyWithdrawal: sql<string | null>`${boardClimbs.sourceMetadata}->>'visibilityWithdrawnAt'`,
      })
      .from(boardClimbs)
      .where(
        and(
          quantumCatalogClimbCondition(),
          inArray(
            boardClimbs.uuid,
            batch.map((routeId) => quantumCanonicalClimbUuid(layoutId, routeId)),
          ),
        ),
      );
    for (const row of storedRoutes) {
      if (!row.routeId || row.uuid !== quantumCanonicalClimbUuid(layoutId, row.routeId)) continue;
      versions.set(row.routeId, {
        isListed: row.isListed,
        publicVersion: normalizeEwallsTimestamp(row.publicVersion),
        legacyWithdrawal: normalizeEwallsTimestamp(row.legacyWithdrawal),
      });
    }
  });
  return versions;
}

/** A model feed can attest membership without replacing newer public content.
 * A revision preceding a withdrawal cannot establish any new membership. */
function filterEwallsPublicRevisions(
  catalog: PreparedQuantumCatalog,
  storedRoutes: ReadonlyMap<string, StoredEwallsRouteVersion>,
  withdrawalFences: ReadonlyMap<string, string>,
  priorRouteIds: ReadonlySet<string>,
  routeIds: Set<string>,
): PreparedQuantumCatalog {
  const excluded = new Set<string>();
  for (const climb of catalog.climbs) {
    const routeId = climb.controllerRouteUuid;
    const stored = storedRoutes.get(routeId);
    const revision = normalizeEwallsTimestamp(climb.sourceMetadata.updatedAt);
    const withdrawnAt = withdrawalFences.get(routeId);
    const predatesWithdrawal = withdrawnAt !== undefined && (revision === null || revision <= withdrawnAt);
    const latestPublicVersion = stored?.publicVersion;
    const olderThanPublic = latestPublicVersion != null && (revision === null || revision < latestPublicVersion);
    const sameAlreadyPublic = stored?.isListed && latestPublicVersion != null && revision === latestPublicVersion;
    if (predatesWithdrawal || olderThanPublic || sameAlreadyPublic) {
      excluded.add(climb.uuid);
      if (stored?.isListed && (priorRouteIds.has(routeId) || (!predatesWithdrawal && revision !== null))) {
        routeIds.add(routeId);
      }
    } else {
      routeIds.add(routeId);
    }
  }
  if (excluded.size === 0) return catalog;
  return {
    ...catalog,
    climbs: catalog.climbs.filter((climb) => !excluded.has(climb.uuid)),
    holds: catalog.holds.filter((hold) => !excluded.has(hold.climbUuid)),
    stats: catalog.stats.filter((stat) => !excluded.has(stat.climbUuid)),
    aliases: catalog.aliases.filter((alias) => !excluded.has(alias.canonicalUuid)),
  };
}

async function assertNoForeignClimbUuidCollisions(
  transaction: QuantumCatalogTransaction,
  prepared: PreparedQuantumCatalog,
  signal?: AbortSignal,
): Promise<void> {
  const appUuids = [
    ...new Set([...prepared.climbs.map((climb) => climb.uuid), ...prepared.aliases.map((alias) => alias.aliasUuid)]),
  ];
  await processBatches(appUuids, async (uuidBatch) => {
    throwIfAborted(signal);
    const [foreignClimb] = await transaction
      .select({ uuid: boardClimbs.uuid })
      .from(boardClimbs)
      .where(and(inArray(boardClimbs.uuid, uuidBatch), not(quantumCatalogClimbCondition())))
      .limit(1);
    if (foreignClimb) {
      throw new Error(`Quantum source app UUID collides with non-source climb ${foreignClimb.uuid}.`);
    }
  });
  const canonicalByAlias = new Map(prepared.aliases.map((alias) => [alias.aliasUuid, alias.canonicalUuid]));
  await processBatches(prepared.aliases, async (aliasBatch) => {
    const existingAliases = await transaction
      .select({
        aliasUuid: boardClimbAliases.aliasUuid,
        canonicalUuid: boardClimbAliases.canonicalUuid,
        source: boardClimbAliases.source,
      })
      .from(boardClimbAliases)
      .where(
        and(
          eq(boardClimbAliases.boardType, QUANTUM_BOARD_TYPE),
          inArray(
            boardClimbAliases.aliasUuid,
            aliasBatch.map((alias) => alias.aliasUuid),
          ),
        ),
      )
      .for('update');
    for (const alias of existingAliases) {
      if (alias.source !== 'quantum') throw new Error('Quantum source app UUID collides with an existing climb alias.');
      if (canonicalByAlias.get(alias.aliasUuid) !== alias.canonicalUuid)
        throw new QuantumRouteGeometryDriftError(alias.canonicalUuid);
    }
  });
}

/** Retained source rows bind physical geometry even while absent from a snapshot. */
async function assertExistingQuantumRouteGeometry(
  transaction: QuantumCatalogTransaction,
  prepared: PreparedQuantumCatalog,
  signal?: AbortSignal,
): Promise<ReadonlySet<string>> {
  const existingClimbUuids = new Set<string>();
  await processBatches(prepared.climbs, async (climbBatch) => {
    throwIfAborted(signal);
    const expectedByUuid = new Map(climbBatch.map((climb) => [climb.uuid, climb]));
    const existingClimbs = await transaction
      .select({
        uuid: boardClimbs.uuid,
        layoutId: boardClimbs.layoutId,
        controllerRouteUuid: boardClimbs.controllerRouteUuid,
        frames: boardClimbs.frames,
      })
      .from(boardClimbs)
      .where(and(inArray(boardClimbs.uuid, [...expectedByUuid.keys()]), quantumCatalogClimbCondition()));
    for (const existing of existingClimbs) {
      existingClimbUuids.add(existing.uuid);
      const expected = expectedByUuid.get(existing.uuid)!;
      if (
        existing.layoutId !== expected.layoutId ||
        existing.controllerRouteUuid !== expected.controllerRouteUuid ||
        existing.frames !== expected.frames
      ) {
        throw new QuantumRouteGeometryDriftError(existing.uuid);
      }
    }
  });
  return existingClimbUuids;
}

async function upsertQuantumReferenceCatalog(
  transaction: QuantumCatalogTransaction,
  prepared: PreparedQuantumCatalog,
  signal?: AbortSignal,
): Promise<void> {
  await transaction
    .insert(boardDifficultyGrades)
    .values([...prepared.grades])
    .onConflictDoUpdate({
      target: [boardDifficultyGrades.boardType, boardDifficultyGrades.difficulty],
      ...guardedSourceUpdate(getTableColumns(boardDifficultyGrades), {
        boulderName: sql`excluded.boulder_name`,
        routeName: sql`excluded.route_name`,
        isListed: sql`excluded.is_listed`,
      }),
    });
  await transaction
    .insert(boardProducts)
    .values([...prepared.products])
    .onConflictDoUpdate({
      target: [boardProducts.boardType, boardProducts.id],
      ...guardedSourceUpdate(getTableColumns(boardProducts), {
        name: sql`excluded.name`,
        isListed: sql`excluded.is_listed`,
        password: sql`excluded.password`,
        minCountInFrame: sql`excluded.min_count_in_frame`,
        maxCountInFrame: sql`excluded.max_count_in_frame`,
      }),
    });
  await transaction
    .insert(boardSets)
    .values([...prepared.sets])
    .onConflictDoUpdate({
      target: [boardSets.boardType, boardSets.id],
      ...guardedSourceUpdate(getTableColumns(boardSets), { name: sql`excluded.name`, hsm: sql`excluded.hsm` }),
    });
  await transaction
    .insert(boardPlacementRoles)
    .values([...prepared.roles])
    .onConflictDoUpdate({
      target: [boardPlacementRoles.boardType, boardPlacementRoles.id],
      ...guardedSourceUpdate(getTableColumns(boardPlacementRoles), {
        productId: sql`excluded.product_id`,
        position: sql`excluded.position`,
        name: sql`excluded.name`,
        fullName: sql`excluded.full_name`,
        ledColor: sql`excluded.led_color`,
        screenColor: sql`excluded.screen_color`,
      }),
    });
  await transaction
    .insert(boardLayouts)
    .values([...prepared.layouts])
    .onConflictDoUpdate({
      target: [boardLayouts.boardType, boardLayouts.id],
      ...guardedSourceUpdate(getTableColumns(boardLayouts), {
        productId: sql`excluded.product_id`,
        name: sql`excluded.name`,
        instagramCaption: sql`excluded.instagram_caption`,
        isMirrored: sql`excluded.is_mirrored`,
        isListed: sql`excluded.is_listed`,
        password: sql`excluded.password`,
        createdAt: sql`excluded.created_at`,
      }),
    });
  await transaction
    .insert(boardProductSizes)
    .values([...prepared.productSizes])
    .onConflictDoUpdate({
      target: [boardProductSizes.boardType, boardProductSizes.id],
      ...guardedSourceUpdate(getTableColumns(boardProductSizes), {
        productId: sql`excluded.product_id`,
        edgeLeft: sql`excluded.edge_left`,
        edgeRight: sql`excluded.edge_right`,
        edgeBottom: sql`excluded.edge_bottom`,
        edgeTop: sql`excluded.edge_top`,
        name: sql`excluded.name`,
        description: sql`excluded.description`,
        imageFilename: sql`excluded.image_filename`,
        position: sql`excluded.position`,
        isListed: sql`excluded.is_listed`,
      }),
    });

  await upsertHardwareRows(transaction, prepared, signal);
  await transaction
    .insert(boardProductSizesLayoutsSets)
    .values([...prepared.productSizeLayoutSets])
    .onConflictDoUpdate({
      target: [boardProductSizesLayoutsSets.boardType, boardProductSizesLayoutsSets.id],
      ...guardedSourceUpdate(getTableColumns(boardProductSizesLayoutsSets), {
        productSizeId: sql`excluded.product_size_id`,
        layoutId: sql`excluded.layout_id`,
        setId: sql`excluded.set_id`,
        imageFilename: sql`excluded.image_filename`,
        isListed: sql`excluded.is_listed`,
      }),
    });
}

async function upsertHardwareRows(
  transaction: QuantumCatalogTransaction,
  prepared: PreparedQuantumCatalog,
  signal?: AbortSignal,
): Promise<void> {
  await processBatches(prepared.holes, async (holeBatch) => {
    throwIfAborted(signal);
    await transaction
      .insert(boardHoles)
      .values([...holeBatch])
      .onConflictDoUpdate({
        target: [boardHoles.boardType, boardHoles.id],
        ...guardedSourceUpdate(getTableColumns(boardHoles), {
          productId: sql`excluded.product_id`,
          name: sql`excluded.name`,
          x: sql`excluded.x`,
          y: sql`excluded.y`,
          mirroredHoleId: sql`excluded.mirrored_hole_id`,
          mirrorGroup: sql`excluded.mirror_group`,
        }),
      });
  });
  await processBatches(prepared.placements, async (placementBatch) => {
    throwIfAborted(signal);
    await transaction
      .insert(boardPlacements)
      .values([...placementBatch])
      .onConflictDoUpdate({
        target: [boardPlacements.boardType, boardPlacements.id],
        ...guardedSourceUpdate(getTableColumns(boardPlacements), {
          layoutId: sql`excluded.layout_id`,
          holeId: sql`excluded.hole_id`,
          setId: sql`excluded.set_id`,
          defaultPlacementRoleId: sql`excluded.default_placement_role_id`,
        }),
      });
  });
  await processBatches(prepared.leds, async (ledBatch) => {
    throwIfAborted(signal);
    await transaction
      .insert(boardLeds)
      .values([...ledBatch])
      .onConflictDoUpdate({
        target: [boardLeds.boardType, boardLeds.id],
        ...guardedSourceUpdate(getTableColumns(boardLeds), {
          productSizeId: sql`excluded.product_size_id`,
          holeId: sql`excluded.hole_id`,
          position: sql`excluded.position`,
        }),
      });
  });
}

async function reconcileQuantumClimbs(
  transaction: QuantumCatalogTransaction,
  prepared: PreparedQuantumCatalog,
  existingClimbUuids: ReadonlySet<string>,
  importedAt: Date,
  removedCanonicalUuids: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  // Only routes absent from every scope in this physical family are delisted.
  await transaction
    .update(boardClimbs)
    .set({ isListed: false, updatedAt: importedAt })
    .where(
      and(
        quantumCatalogClimbCondition(),
        eq(boardClimbs.isListed, true),
        inArray(boardClimbs.uuid, [...removedCanonicalUuids]),
      ),
    );

  const climbSourceChanges = {
    boardType: sql`excluded.board_type`,
    layoutId: sql`excluded.layout_id`,
    setterId: sql`excluded.setter_id`,
    setterUsername: sql`excluded.setter_username`,
    name: sql`excluded.name`,
    description: sql`excluded.description`,
    hsm: sql`excluded.hsm`,
    edgeLeft: sql`excluded.edge_left`,
    edgeRight: sql`excluded.edge_right`,
    edgeBottom: sql`excluded.edge_bottom`,
    edgeTop: sql`excluded.edge_top`,
    angle: sql`excluded.angle`,
    framesCount: sql`excluded.frames_count`,
    framesPace: sql`excluded.frames_pace`,
    frames: sql`excluded.frames`,
    controllerRouteUuid: sql`excluded.controller_route_uuid`,
    isDraft: sql`excluded.is_draft`,
    isListed: sql`excluded.is_listed`,
    createdAt: sql`excluded.created_at`,
    publishedAt: sql`excluded.published_at`,
    synced: sql`excluded.synced`,
    syncError: sql`excluded.sync_error`,
    requiredSetIds: sql`excluded.required_set_ids`,
    compatibleSizeIds: sql`excluded.compatible_size_ids`,
    holdFingerprint: sql`excluded.hold_fingerprint`,
    characteristics: sql`excluded.characteristics`,
    sourceMetadata: sql`excluded.source_metadata`,
  };
  await processBatches(prepared.climbs, async (climbBatch) => {
    throwIfAborted(signal);
    const importedClimbs = await transaction
      .insert(boardClimbs)
      .values(
        climbBatch.map((climb) => ({
          ...climb,
          requiredSetIds: [...climb.requiredSetIds],
          compatibleSizeIds: [...climb.compatibleSizeIds],
          characteristics: climb.characteristics ? [...climb.characteristics] : null,
          updatedAt: importedAt,
        })),
      )
      .onConflictDoUpdate({
        target: boardClimbs.uuid,
        setWhere: and(
          quantumCatalogClimbCondition(),
          eq(boardClimbs.layoutId, sql`excluded.layout_id`),
          eq(boardClimbs.controllerRouteUuid, sql`excluded.controller_route_uuid`),
          eq(boardClimbs.frames, sql`excluded.frames`),
          changedColumns(getTableColumns(boardClimbs), climbSourceChanges),
        ),
        set: { ...climbSourceChanges, updatedAt: importedAt },
      })
      .returning({ uuid: boardClimbs.uuid });
    if (importedClimbs.length !== climbBatch.length) {
      // A row may have committed after preflight. Recheck under the upsert's
      // row locks. An unchanged row also returns no ID, so scope this check to
      // the unwritten batch instead of scanning the entire catalog each time.
      const writtenUuids = new Set(importedClimbs.map((climb) => climb.uuid));
      const unwrittenCatalog = {
        ...prepared,
        climbs: climbBatch.filter((climb) => !writtenUuids.has(climb.uuid)),
        aliases: [],
      };
      await assertNoForeignClimbUuidCollisions(transaction, unwrittenCatalog, signal);
      await assertExistingQuantumRouteGeometry(transaction, unwrittenCatalog, signal);
    }
  });

  // Alias writes are ownership-fenced too: a concurrent import cannot retarget
  // a source app UUID after its preflight SELECT.
  await processBatches(prepared.aliases, async (aliasBatch) => {
    throwIfAborted(signal);
    const written = await transaction
      .insert(boardClimbAliases)
      .values(
        aliasBatch.map((alias) => ({
          ...alias,
          boardType: QUANTUM_BOARD_TYPE,
          source: 'quantum',
          lastSeenAt: importedAt,
        })),
      )
      .onConflictDoUpdate({
        target: [boardClimbAliases.boardType, boardClimbAliases.aliasUuid],
        set: { lastSeenAt: importedAt },
        setWhere: and(
          eq(boardClimbAliases.source, 'quantum'),
          eq(boardClimbAliases.canonicalUuid, sql`excluded.canonical_uuid`),
        ),
      })
      .returning({ aliasUuid: boardClimbAliases.aliasUuid });
    if (written.length !== aliasBatch.length) {
      await assertNoForeignClimbUuidCollisions(transaction, prepared, signal);
      throw new Error('Quantum source app UUID collides with an existing climb alias during import.');
    }
  });
  // A concurrent authored insert under a source alias must not become a public
  // alias to the imported route. Canonical rows have their separate upsert guard.
  await assertNoForeignClimbUuidCollisions(transaction, prepared, signal);

  // Existing source identities have immutable frames, validated above. Their
  // hold rows therefore never need deleting and re-inserting.
  const climbUuids = prepared.climbs.filter((climb) => !existingClimbUuids.has(climb.uuid)).map((climb) => climb.uuid);
  await processBatches(climbUuids, async (uuidBatch) => {
    throwIfAborted(signal);
    await transaction
      .delete(boardClimbHolds)
      .where(and(eq(boardClimbHolds.boardType, QUANTUM_BOARD_TYPE), inArray(boardClimbHolds.climbUuid, uuidBatch)));
  });
  const newClimbUuids = new Set(climbUuids);
  await processBatches(
    prepared.holds.filter((hold) => newClimbUuids.has(hold.climbUuid)),
    async (holdBatch) => {
      throwIfAborted(signal);
      await transaction.insert(boardClimbHolds).values([...holdBatch]);
    },
  );
  // eWalls supplies route-level aggregates at the current route angle. Retire
  // earlier upstream contributions without disturbing local ticks or their grades.
  const affectedClimbUuids = [...prepared.climbs.map((climb) => climb.uuid), ...removedCanonicalUuids];
  await processBatches(affectedClimbUuids, async (climbUuids) => {
    throwIfAborted(signal);
    await transaction
      .update(boardClimbStats)
      .set({
        upstreamAscensionistCount: null,
        upstreamQualityAverage: null,
        upstreamSyncedAt: null,
        ascensionistCount: sql`${boardClimbStats.boardseshAscensionistCount}`,
        qualityAverage: blendedQualityAverageSql({
          upstreamQualityAverage: sql`NULL::double precision`,
          upstreamAscensionistCount: sql`NULL::bigint`,
          boardseshQualitySum: sql`${boardClimbStats.boardseshQualitySum}`,
          boardseshQualityCount: sql`${boardClimbStats.boardseshQualityCount}`,
        }),
        displayDifficulty: sql`CASE WHEN ${boardClimbStats.tickGradedAt} IS NOT NULL THEN ${boardClimbStats.displayDifficulty} END`,
        difficultyAverage: sql`CASE WHEN ${boardClimbStats.tickGradedAt} IS NOT NULL THEN ${boardClimbStats.difficultyAverage} END`,
        updatedAt: importedAt,
      })
      .from(boardClimbs)
      .where(
        and(
          eq(boardClimbStats.boardType, QUANTUM_BOARD_TYPE),
          eq(boardClimbStats.climbUuid, boardClimbs.uuid),
          inArray(boardClimbs.uuid, climbUuids),
          quantumCatalogClimbCondition(),
          isNotNull(boardClimbStats.upstreamSyncedAt),
          sql`(${boardClimbs.isListed} IS NOT TRUE OR ${boardClimbStats.angle} IS DISTINCT FROM ${boardClimbs.angle})`,
        ),
      );
  });
  const resolvedUpstreamAscensionistCount = sql`excluded.upstream_ascensionist_count`;
  const resolvedUpstreamQuality = sql`excluded.upstream_quality_average`;
  const blendedQuality = blendedQualityAverageSql({
    upstreamQualityAverage: resolvedUpstreamQuality,
    upstreamAscensionistCount: resolvedUpstreamAscensionistCount,
    boardseshQualitySum: sql`${boardClimbStats.boardseshQualitySum}`,
    boardseshQualityCount: sql`${boardClimbStats.boardseshQualityCount}`,
  });
  const statSourceChanges = {
    upstreamAscensionistCount: resolvedUpstreamAscensionistCount,
    ascensionistCount: sql`CASE WHEN ${resolvedUpstreamAscensionistCount} IS NULL THEN ${boardClimbStats.boardseshAscensionistCount}
      ELSE ${resolvedUpstreamAscensionistCount} + COALESCE(${boardClimbStats.boardseshAscensionistCount}, 0) END`,
    displayDifficulty: sql`CASE WHEN ${boardClimbStats.tickGradedAt} IS NOT NULL THEN ${boardClimbStats.displayDifficulty} ELSE excluded.display_difficulty END`,
    difficultyAverage: sql`CASE WHEN ${boardClimbStats.tickGradedAt} IS NOT NULL THEN ${boardClimbStats.difficultyAverage} ELSE excluded.difficulty_average END`,
    upstreamQualityAverage: resolvedUpstreamQuality,
    qualityAverage: blendedQuality,
    qualityNormalized: sql`true`,
  };
  await processBatches(prepared.stats, async (statsBatch) => {
    throwIfAborted(signal);
    await transaction
      .insert(boardClimbStats)
      .values(statsBatch.map((stat) => ({ ...stat, updatedAt: importedAt })))
      .onConflictDoUpdate({
        target: [boardClimbStats.boardType, boardClimbStats.climbUuid, boardClimbStats.angle],
        set: {
          ...statSourceChanges,
          upstreamSyncedAt: sql`excluded.upstream_synced_at`,
          updatedAt: importedAt,
        },
        setWhere: changedColumns(getTableColumns(boardClimbStats), statSourceChanges),
      });
  });
}

async function processBatches<Row>(rows: readonly Row[], processBatch: (batch: Row[]) => Promise<void>): Promise<void> {
  for (let index = 0; index < rows.length; index += QUANTUM_IMPORT_BATCH_SIZE) {
    await processBatch(rows.slice(index, index + QUANTUM_IMPORT_BATCH_SIZE));
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error('Quantum catalog import aborted.');
  error.name = 'AbortError';
  throw error;
}

/** Null-safe guards keep unchanged source rows out of the incremental feed. */
function changedColumns(columns: Record<string, SQLWrapper>, incoming: Record<string, SQL>): SQL | undefined {
  return or(
    ...Object.entries(incoming).map(
      ([columnName, incomingColumn]) => sql`${columns[columnName]} IS DISTINCT FROM ${incomingColumn}`,
    ),
  );
}

function guardedSourceUpdate(columns: Record<string, SQLWrapper>, incoming: Record<string, SQL>) {
  return { set: incoming, setWhere: changedColumns(columns, incoming) };
}
