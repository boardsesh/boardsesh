import { and, eq, getTableColumns, inArray, not, notInArray, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
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
import type { ValidatedQuantumSnapshot } from '@boardsesh/quantum-sync';
import { db, type Database } from '../db/client';
import { prepareQuantumCatalog, QUANTUM_BOARD_TYPE, type PreparedQuantumCatalog } from './quantum-catalog-mapping';
import { QUANTUM_CATALOG_CHECKPOINT, readQuantumCatalogSyncMetadata } from './quantum-catalog-checkpoint';
import { QUANTUM_HARDWARE_FINGERPRINT } from '@boardsesh/board-constants/quantum';
import { computeQuantumHardwareFingerprint } from './quantum-catalog-mapping';

const QUANTUM_IMPORT_BATCH_SIZE = 500;
const QUANTUM_IMPORT_LOCK_NAMESPACE = 0x5155_414e; // ASCII "QUAN"
const QUANTUM_IMPORT_LOCK_KEY = 1;
const MAX_STORED_ERROR_LENGTH = 4_000;

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

export class QuantumSnapshotRollbackError extends Error {
  readonly code = 'QUANTUM_SNAPSHOT_ROLLBACK';

  constructor() {
    super('Quantum snapshot is older than the last successful signed catalog checkpoint.');
    this.name = 'QuantumSnapshotRollbackError';
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

export async function recordQuantumCatalogSyncAttempt(
  database: Pick<Database, 'insert'>,
  source: string,
  attemptedAt: Date = new Date(),
): Promise<void> {
  await database
    .insert(boardSharedSyncs)
    .values({
      boardType: QUANTUM_BOARD_TYPE,
      tableName: QUANTUM_CATALOG_CHECKPOINT,
      metadata: { source, lastAttemptAt: attemptedAt.toISOString() },
    })
    .onConflictDoUpdate({
      target: [boardSharedSyncs.boardType, boardSharedSyncs.tableName],
      set: { metadata: sql`COALESCE(${boardSharedSyncs.metadata}, '{}'::jsonb) || excluded.metadata` },
    });
}

export async function recordQuantumCatalogSyncFailure(
  database: Pick<Database, 'insert'>,
  source: string,
  error: unknown,
  failedAt: Date = new Date(),
): Promise<void> {
  const errorMessage = error instanceof Error ? error.message : String(error);
  await database
    .insert(boardSharedSyncs)
    .values({
      boardType: QUANTUM_BOARD_TYPE,
      tableName: QUANTUM_CATALOG_CHECKPOINT,
      metadata: {
        source,
        lastAttemptAt: failedAt.toISOString(),
        lastError: errorMessage.slice(0, MAX_STORED_ERROR_LENGTH),
      },
    })
    .onConflictDoUpdate({
      target: [boardSharedSyncs.boardType, boardSharedSyncs.tableName],
      set: { metadata: sql`COALESCE(${boardSharedSyncs.metadata}, '{}'::jsonb) || excluded.metadata` },
    });
}

/**
 * Apply one already-authenticated, fully validated snapshot. The attempt row is
 * written before the transaction so a rollback remains visible; every catalog
 * table and the success checkpoint commit atomically.
 */
export async function importValidatedQuantumSnapshot(
  snapshot: Readonly<ValidatedQuantumSnapshot>,
  signal?: AbortSignal,
  options: {
    database?: Database;
    now?: () => Date;
    transaction?: QuantumCatalogBatchRunner;
    expectedHardwareFingerprint?: string;
  } = {},
): Promise<QuantumCatalogImportResult> {
  // Validate the immutable physical map before even constructing climb frames.
  // Failed first bootstraps must leave no catalog or checkpoint rows behind.
  const receivedHardwareFingerprint = computeQuantumHardwareFingerprint(snapshot.rows.models, snapshot.rows.diodes);
  const expectedHardwareFingerprint = options.expectedHardwareFingerprint ?? QUANTUM_HARDWARE_FINGERPRINT;
  if (receivedHardwareFingerprint !== expectedHardwareFingerprint) {
    throw new QuantumHardwareFingerprintDriftError(expectedHardwareFingerprint, receivedHardwareFingerprint);
  }
  const database = options.database ?? db;
  const importedAt = (options.now ?? (() => new Date()))();
  const transactionRunner: QuantumCatalogBatchRunner = options.transaction ?? ((run) => database.transaction(run));
  await transactionRunner((transaction) => recordQuantumCatalogSyncAttempt(transaction, snapshot.source, importedAt));

  try {
    throwIfAborted(signal);
    const prepared = prepareQuantumCatalog(snapshot, importedAt);
    return await transactionRunner(async (transaction) => {
      // The lease is an operational optimisation, not fencing. This database
      // lock is what serializes overlapping snapshot writers safely.
      await transaction.execute(
        sql`SELECT pg_advisory_xact_lock(${QUANTUM_IMPORT_LOCK_NAMESPACE}, ${QUANTUM_IMPORT_LOCK_KEY})`,
      );
      throwIfAborted(signal);

      const shouldApply = await checkQuantumCatalogCheckpoint(transaction, snapshot, prepared.hardwareFingerprint);
      if (!shouldApply) {
        await markQuantumCatalogSyncSuccess(transaction, snapshot, prepared.hardwareFingerprint, importedAt);
        return Object.freeze({
          outcome: 'unchanged' as const,
          hardwareFingerprint: prepared.hardwareFingerprint,
          modelsUpserted: 0,
          diodesUpserted: 0,
          climbsUpserted: 0,
          holdsUpserted: 0,
          statsUpserted: 0,
        });
      }
      await assertNoForeignClimbUuidCollisions(transaction, prepared, signal);
      const existingClimbUuids = await assertExistingQuantumRouteGeometry(transaction, prepared, signal);
      await upsertQuantumReferenceCatalog(transaction, prepared, signal);
      await reconcileQuantumClimbs(transaction, prepared, existingClimbUuids, importedAt, signal);
      await markQuantumCatalogSyncSuccess(transaction, snapshot, prepared.hardwareFingerprint, importedAt);

      return Object.freeze({
        outcome: 'applied' as const,
        hardwareFingerprint: prepared.hardwareFingerprint,
        modelsUpserted: prepared.layouts.length,
        diodesUpserted: prepared.placements.length,
        climbsUpserted: prepared.climbs.length,
        holdsUpserted: prepared.holds.length,
        statsUpserted: prepared.stats.length,
      });
    });
  } catch (error) {
    try {
      await transactionRunner((transaction) =>
        recordQuantumCatalogSyncFailure(transaction, snapshot.source, error, importedAt),
      );
    } catch {
      // Never replace the catalog/import failure with telemetry-state failure.
    }
    throw error;
  }
}

async function checkQuantumCatalogCheckpoint(
  transaction: QuantumCatalogTransaction,
  snapshot: Readonly<ValidatedQuantumSnapshot>,
  receivedFingerprint: string,
): Promise<boolean> {
  const priorRows = await transaction
    .select({ metadata: boardSharedSyncs.metadata })
    .from(boardSharedSyncs)
    .where(
      and(
        eq(boardSharedSyncs.boardType, QUANTUM_BOARD_TYPE),
        eq(boardSharedSyncs.tableName, QUANTUM_CATALOG_CHECKPOINT),
      ),
    )
    .for('update');
  const priorStates = priorRows.map((row) => readQuantumCatalogSyncMetadata(row.metadata));
  const expectedFingerprint = priorStates.find((state) => state.hardwareFingerprint)?.hardwareFingerprint;
  if (expectedFingerprint && expectedFingerprint !== receivedFingerprint) {
    throw new QuantumHardwareFingerprintDriftError(expectedFingerprint, receivedFingerprint);
  }
  const successfulStates = priorStates.filter(
    (state) => state.lastSuccessAt && state.revisionTimestamp !== undefined && state.revisionId,
  );
  successfulStates.sort((left, right) => {
    const createdAtOrder = (right.revisionTimestamp ?? -1) - (left.revisionTimestamp ?? -1);
    if (createdAtOrder !== 0) return createdAtOrder;
    return (right.revisionId ?? '').localeCompare(left.revisionId ?? '');
  });
  const checkpoint = successfulStates[0];
  if (!checkpoint || checkpoint.revisionTimestamp === undefined || !checkpoint.revisionId) return true;
  if (snapshot.manifestCreatedAt < checkpoint.revisionTimestamp) throw new QuantumSnapshotRollbackError();
  if (snapshot.manifestCreatedAt > checkpoint.revisionTimestamp) return true;
  const eventOrder = snapshot.eventId.localeCompare(checkpoint.revisionId);
  if (eventOrder < 0) throw new QuantumSnapshotRollbackError();
  return eventOrder > 0;
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
  signal?: AbortSignal,
): Promise<void> {
  // The signed snapshot is complete. Only missing, currently listed source rows
  // need a tombstone; unchanged rows retain their incremental-sync timestamps.
  await transaction
    .update(boardClimbs)
    .set({ isListed: false, updatedAt: importedAt })
    .where(
      and(
        quantumCatalogClimbCondition(),
        eq(boardClimbs.isListed, true),
        prepared.climbs.length
          ? notInArray(
              boardClimbs.uuid,
              prepared.climbs.map((climb) => climb.uuid),
            )
          : undefined,
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
  const resolvedUpstreamAscensionistCount = sql`COALESCE(excluded.upstream_ascensionist_count, 0)`;
  const blendedQuality = blendedQualityAverageSql({
    upstreamQualityAverage: sql`excluded.upstream_quality_average`,
    upstreamAscensionistCount: resolvedUpstreamAscensionistCount,
    boardseshQualitySum: sql`${boardClimbStats.boardseshQualitySum}`,
    boardseshQualityCount: sql`${boardClimbStats.boardseshQualityCount}`,
  });
  const statSourceChanges = {
    upstreamAscensionistCount: sql`excluded.upstream_ascensionist_count`,
    ascensionistCount: sql`${resolvedUpstreamAscensionistCount} + COALESCE(${boardClimbStats.boardseshAscensionistCount}, 0)`,
    displayDifficulty: sql`excluded.display_difficulty`,
    difficultyAverage: sql`excluded.difficulty_average`,
    upstreamQualityAverage: sql`excluded.upstream_quality_average`,
    qualityAverage: blendedQuality,
    qualityNormalized: sql`true`,
  };
  await processBatches(prepared.stats, async (statsBatch) => {
    throwIfAborted(signal);
    await transaction
      .insert(boardClimbStats)
      .values([...statsBatch])
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

async function markQuantumCatalogSyncSuccess(
  transaction: QuantumCatalogTransaction,
  snapshot: Readonly<ValidatedQuantumSnapshot>,
  hardwareFingerprint: string,
  importedAt: Date,
): Promise<void> {
  const metadata = {
    source: snapshot.source,
    revisionId: snapshot.eventId,
    revisionTimestamp: snapshot.manifestCreatedAt,
    contentFingerprint: snapshot.chunkSha256,
    hardwareFingerprint,
    lastAttemptAt: importedAt.toISOString(),
    lastSuccessAt: importedAt.toISOString(),
    lastError: null,
  };
  await transaction
    .insert(boardSharedSyncs)
    .values({
      boardType: QUANTUM_BOARD_TYPE,
      tableName: QUANTUM_CATALOG_CHECKPOINT,
      lastSynchronizedAt: importedAt.toISOString(),
      metadata,
    })
    .onConflictDoUpdate({
      target: [boardSharedSyncs.boardType, boardSharedSyncs.tableName],
      set: { lastSynchronizedAt: importedAt.toISOString(), metadata },
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
