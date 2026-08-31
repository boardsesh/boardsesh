import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
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
import { blendedQualityAverageSql } from '@boardsesh/db/queries';
import type { ValidatedQuantumSnapshot } from '@boardsesh/quantum-sync';
import { db, type Database } from '../db/client';
import { prepareQuantumCatalog, QUANTUM_BOARD_TYPE, type PreparedQuantumCatalog } from './quantum-catalog-mapping';

const QUANTUM_IMPORT_BATCH_SIZE = 500;
const QUANTUM_IMPORT_LOCK_NAMESPACE = 0x5155_414e; // ASCII "QUAN"
const QUANTUM_IMPORT_LOCK_KEY = 1;
const MAX_STORED_ERROR_LENGTH = 4_000;

type QuantumCatalogTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

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

export async function recordQuantumCatalogSyncAttempt(
  database: Database,
  source: string,
  attemptedAt: Date = new Date(),
): Promise<void> {
  await database
    .insert(boardCatalogSyncState)
    .values({ boardType: QUANTUM_BOARD_TYPE, source, lastAttemptAt: attemptedAt })
    .onConflictDoUpdate({
      target: [boardCatalogSyncState.boardType, boardCatalogSyncState.source],
      set: { lastAttemptAt: attemptedAt },
    });
}

export async function recordQuantumCatalogSyncFailure(
  database: Database,
  source: string,
  error: unknown,
  failedAt: Date = new Date(),
): Promise<void> {
  const errorMessage = error instanceof Error ? error.message : String(error);
  await database
    .insert(boardCatalogSyncState)
    .values({
      boardType: QUANTUM_BOARD_TYPE,
      source,
      lastAttemptAt: failedAt,
      lastError: errorMessage.slice(0, MAX_STORED_ERROR_LENGTH),
    })
    .onConflictDoUpdate({
      target: [boardCatalogSyncState.boardType, boardCatalogSyncState.source],
      set: {
        lastAttemptAt: failedAt,
        lastError: errorMessage.slice(0, MAX_STORED_ERROR_LENGTH),
      },
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
  options: { database?: Database; now?: () => Date } = {},
): Promise<QuantumCatalogImportResult> {
  const database = options.database ?? db;
  const importedAt = (options.now ?? (() => new Date()))();
  await recordQuantumCatalogSyncAttempt(database, snapshot.source, importedAt);

  try {
    throwIfAborted(signal);
    const prepared = prepareQuantumCatalog(snapshot, importedAt);
    return await database.transaction(async (transaction) => {
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
      await upsertQuantumReferenceCatalog(transaction, prepared, signal);
      await reconcileQuantumClimbs(transaction, prepared, importedAt, signal);
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
      await recordQuantumCatalogSyncFailure(database, snapshot.source, error, importedAt);
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
  const priorStates = await transaction
    .select({
      manifestCreatedAt: boardCatalogSyncState.manifestCreatedAt,
      manifestEventId: boardCatalogSyncState.manifestEventId,
      hardwareFingerprint: boardCatalogSyncState.hardwareFingerprint,
      lastSuccessAt: boardCatalogSyncState.lastSuccessAt,
    })
    .from(boardCatalogSyncState)
    .where(eq(boardCatalogSyncState.boardType, QUANTUM_BOARD_TYPE))
    .for('update');
  const expectedFingerprint = priorStates.find((state) => state.hardwareFingerprint)?.hardwareFingerprint;
  if (expectedFingerprint && expectedFingerprint !== receivedFingerprint) {
    throw new QuantumHardwareFingerprintDriftError(expectedFingerprint, receivedFingerprint);
  }
  const successfulStates = priorStates.filter(
    (state) => state.lastSuccessAt && state.manifestCreatedAt !== null && state.manifestEventId,
  );
  successfulStates.sort((left, right) => {
    const createdAtOrder = (right.manifestCreatedAt ?? -1) - (left.manifestCreatedAt ?? -1);
    if (createdAtOrder !== 0) return createdAtOrder;
    return (right.manifestEventId ?? '').localeCompare(left.manifestEventId ?? '');
  });
  const checkpoint = successfulStates[0];
  if (!checkpoint || checkpoint.manifestCreatedAt === null || !checkpoint.manifestEventId) return true;
  if (snapshot.manifestCreatedAt < checkpoint.manifestCreatedAt) throw new QuantumSnapshotRollbackError();
  if (snapshot.manifestCreatedAt > checkpoint.manifestCreatedAt) return true;
  const eventOrder = snapshot.eventId.localeCompare(checkpoint.manifestEventId);
  if (eventOrder < 0) throw new QuantumSnapshotRollbackError();
  return eventOrder > 0;
}

async function assertNoForeignClimbUuidCollisions(
  transaction: QuantumCatalogTransaction,
  prepared: PreparedQuantumCatalog,
  signal?: AbortSignal,
): Promise<void> {
  const appUuids = prepared.climbs.map((climb) => climb.uuid);
  await processBatches(appUuids, async (uuidBatch) => {
    throwIfAborted(signal);
    const conflicts = await transaction
      .select({
        uuid: boardClimbs.uuid,
        boardType: boardClimbs.boardType,
        userId: boardClimbs.userId,
        controllerRouteUuid: boardClimbs.controllerRouteUuid,
      })
      .from(boardClimbs)
      .where(inArray(boardClimbs.uuid, uuidBatch));
    const foreignClimb = conflicts.find(
      (climb) => climb.boardType !== QUANTUM_BOARD_TYPE || climb.userId !== null || climb.controllerRouteUuid === null,
    );
    if (foreignClimb) {
      throw new Error(`Quantum source app UUID collides with non-source climb ${foreignClimb.uuid}.`);
    }
  });
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
      set: {
        boulderName: sql`excluded.boulder_name`,
        routeName: sql`excluded.route_name`,
        isListed: sql`excluded.is_listed`,
      },
    });
  await transaction
    .insert(boardProducts)
    .values([...prepared.products])
    .onConflictDoUpdate({
      target: [boardProducts.boardType, boardProducts.id],
      set: {
        name: sql`excluded.name`,
        isListed: sql`excluded.is_listed`,
        password: sql`excluded.password`,
        minCountInFrame: sql`excluded.min_count_in_frame`,
        maxCountInFrame: sql`excluded.max_count_in_frame`,
      },
    });
  await transaction
    .insert(boardSets)
    .values([...prepared.sets])
    .onConflictDoUpdate({
      target: [boardSets.boardType, boardSets.id],
      set: { name: sql`excluded.name`, hsm: sql`excluded.hsm` },
    });
  await transaction
    .insert(boardPlacementRoles)
    .values([...prepared.roles])
    .onConflictDoUpdate({
      target: [boardPlacementRoles.boardType, boardPlacementRoles.id],
      set: {
        productId: sql`excluded.product_id`,
        position: sql`excluded.position`,
        name: sql`excluded.name`,
        fullName: sql`excluded.full_name`,
        ledColor: sql`excluded.led_color`,
        screenColor: sql`excluded.screen_color`,
      },
    });
  await transaction
    .insert(boardLayouts)
    .values([...prepared.layouts])
    .onConflictDoUpdate({
      target: [boardLayouts.boardType, boardLayouts.id],
      set: {
        productId: sql`excluded.product_id`,
        name: sql`excluded.name`,
        instagramCaption: sql`excluded.instagram_caption`,
        isMirrored: sql`excluded.is_mirrored`,
        isListed: sql`excluded.is_listed`,
        password: sql`excluded.password`,
        createdAt: sql`excluded.created_at`,
      },
    });
  await transaction
    .insert(boardProductSizes)
    .values([...prepared.productSizes])
    .onConflictDoUpdate({
      target: [boardProductSizes.boardType, boardProductSizes.id],
      set: {
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
      },
    });

  await upsertHardwareRows(transaction, prepared, signal);
  await transaction
    .insert(boardProductSizesLayoutsSets)
    .values([...prepared.productSizeLayoutSets])
    .onConflictDoUpdate({
      target: [boardProductSizesLayoutsSets.boardType, boardProductSizesLayoutsSets.id],
      set: {
        productSizeId: sql`excluded.product_size_id`,
        layoutId: sql`excluded.layout_id`,
        setId: sql`excluded.set_id`,
        imageFilename: sql`excluded.image_filename`,
        isListed: sql`excluded.is_listed`,
      },
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
        set: {
          productId: sql`excluded.product_id`,
          name: sql`excluded.name`,
          x: sql`excluded.x`,
          y: sql`excluded.y`,
          mirroredHoleId: sql`excluded.mirrored_hole_id`,
          mirrorGroup: sql`excluded.mirror_group`,
        },
      });
  });
  await processBatches(prepared.placements, async (placementBatch) => {
    throwIfAborted(signal);
    await transaction
      .insert(boardPlacements)
      .values([...placementBatch])
      .onConflictDoUpdate({
        target: [boardPlacements.boardType, boardPlacements.id],
        set: {
          layoutId: sql`excluded.layout_id`,
          holeId: sql`excluded.hole_id`,
          setId: sql`excluded.set_id`,
          defaultPlacementRoleId: sql`excluded.default_placement_role_id`,
        },
      });
  });
  await processBatches(prepared.leds, async (ledBatch) => {
    throwIfAborted(signal);
    await transaction
      .insert(boardLeds)
      .values([...ledBatch])
      .onConflictDoUpdate({
        target: [boardLeds.boardType, boardLeds.id],
        set: {
          productSizeId: sql`excluded.product_size_id`,
          holeId: sql`excluded.hole_id`,
          position: sql`excluded.position`,
        },
      });
  });
}

async function reconcileQuantumClimbs(
  transaction: QuantumCatalogTransaction,
  prepared: PreparedQuantumCatalog,
  importedAt: Date,
  signal?: AbortSignal,
): Promise<void> {
  // The signed snapshot is complete. Hide source-owned rows before re-listing
  // every row present in this snapshot. User-authored climbs are never touched.
  await transaction
    .update(boardClimbs)
    .set({ isListed: false, updatedAt: importedAt })
    .where(
      and(
        eq(boardClimbs.boardType, QUANTUM_BOARD_TYPE),
        isNull(boardClimbs.userId),
        isNotNull(boardClimbs.controllerRouteUuid),
      ),
    );

  await processBatches(prepared.climbs, async (climbBatch) => {
    throwIfAborted(signal);
    await transaction
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
        set: {
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
          updatedAt: importedAt,
        },
      });
  });

  const climbUuids = prepared.climbs.map((climb) => climb.uuid);
  await processBatches(climbUuids, async (uuidBatch) => {
    throwIfAborted(signal);
    await transaction
      .delete(boardClimbHolds)
      .where(and(eq(boardClimbHolds.boardType, QUANTUM_BOARD_TYPE), inArray(boardClimbHolds.climbUuid, uuidBatch)));
  });
  await processBatches(prepared.holds, async (holdBatch) => {
    throwIfAborted(signal);
    await transaction.insert(boardClimbHolds).values([...holdBatch]);
  });
  await processBatches(prepared.metadata, async (metadataBatch) => {
    throwIfAborted(signal);
    await transaction
      .insert(quantumClimbMetadata)
      .values(metadataBatch.map((metadata) => ({ ...metadata, tags: [...metadata.tags] })))
      .onConflictDoUpdate({
        target: quantumClimbMetadata.climbUuid,
        set: {
          sourceGrade: sql`excluded.source_grade`,
          isStandard: sql`excluded.is_standard`,
          isCampusing: sql`excluded.is_campusing`,
          isEdge: sql`excluded.is_edge`,
          usesKickplate: sql`excluded.uses_kickplate`,
          allowsMatching: sql`excluded.allows_matching`,
          tags: sql`excluded.tags`,
        },
      });
  });

  const resolvedUpstreamAscensionistCount = sql`COALESCE(excluded.upstream_ascensionist_count, 0)`;
  const blendedQuality = blendedQualityAverageSql({
    upstreamQualityAverage: sql`excluded.upstream_quality_average`,
    upstreamAscensionistCount: resolvedUpstreamAscensionistCount,
    boardseshQualitySum: sql`${boardClimbStats.boardseshQualitySum}`,
    boardseshQualityCount: sql`${boardClimbStats.boardseshQualityCount}`,
  });
  await processBatches(prepared.stats, async (statsBatch) => {
    throwIfAborted(signal);
    await transaction
      .insert(boardClimbStats)
      .values([...statsBatch])
      .onConflictDoUpdate({
        target: [boardClimbStats.boardType, boardClimbStats.climbUuid, boardClimbStats.angle],
        set: {
          upstreamAscensionistCount: sql`excluded.upstream_ascensionist_count`,
          ascensionistCount: sql`${resolvedUpstreamAscensionistCount} + COALESCE(${boardClimbStats.boardseshAscensionistCount}, 0)`,
          displayDifficulty: sql`excluded.display_difficulty`,
          difficultyAverage: sql`excluded.difficulty_average`,
          upstreamQualityAverage: sql`excluded.upstream_quality_average`,
          qualityAverage: blendedQuality,
          qualityNormalized: true,
          upstreamSyncedAt: sql`excluded.upstream_synced_at`,
          updatedAt: importedAt,
        },
      });
  });
}

async function markQuantumCatalogSyncSuccess(
  transaction: QuantumCatalogTransaction,
  snapshot: Readonly<ValidatedQuantumSnapshot>,
  hardwareFingerprint: string,
  importedAt: Date,
): Promise<void> {
  await transaction
    .insert(boardCatalogSyncState)
    .values({
      boardType: QUANTUM_BOARD_TYPE,
      source: snapshot.source,
      manifestEventId: snapshot.eventId,
      manifestCreatedAt: snapshot.manifestCreatedAt,
      manifestFingerprint: snapshot.chunkSha256,
      hardwareFingerprint,
      lastAttemptAt: importedAt,
      lastSuccessAt: importedAt,
      lastError: null,
    })
    .onConflictDoUpdate({
      target: [boardCatalogSyncState.boardType, boardCatalogSyncState.source],
      set: {
        manifestEventId: snapshot.eventId,
        manifestCreatedAt: snapshot.manifestCreatedAt,
        manifestFingerprint: snapshot.chunkSha256,
        hardwareFingerprint,
        lastAttemptAt: importedAt,
        lastSuccessAt: importedAt,
        lastError: null,
      },
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
