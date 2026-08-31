import { eq, asc, and } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import type { QueryResolvers } from '@boardsesh/shared-schema/generated';
import type { ConnectionContext, QuantumGeometry } from '@boardsesh/shared-schema';
import { ANGLES } from '@boardsesh/board-config';
import { QUANTUM_MODELS } from '@boardsesh/board-constants';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { applyRateLimit, validateInput } from '../shared/helpers';
import { BoardNameSchema } from '../../../validation/schemas';

const QUANTUM_CATALOG_SOURCE = 'ewalls-authorized-snapshot';

export const boardQueries: Pick<QueryResolvers, 'grades' | 'angles' | 'quantumGeometry' | 'quantumGeometries'> = {
  grades: async (_, { boardName }) => {
    validateInput(BoardNameSchema, boardName, 'boardName');

    const grades = await db
      .select({
        difficultyId: dbSchema.boardDifficultyGrades.difficulty,
        name: dbSchema.boardDifficultyGrades.boulderName,
      })
      .from(dbSchema.boardDifficultyGrades)
      .where(
        and(eq(dbSchema.boardDifficultyGrades.boardType, boardName), eq(dbSchema.boardDifficultyGrades.isListed, true)),
      )
      .orderBy(asc(dbSchema.boardDifficultyGrades.difficulty));

    return grades.map((g) => ({
      difficultyId: g.difficultyId,
      name: g.name || '',
    }));
  },

  angles: async (_, { boardName, layoutId }) => {
    const validatedBoardName = validateInput(BoardNameSchema, boardName, 'boardName');

    // Quantum's supported angles are catalogue data rather than a fixed
    // manufacturer-wide table. Return only angles present in the last signed,
    // successfully imported snapshot; an empty catalogue truthfully yields [].
    if (validatedBoardName === 'quantum') {
      return getQuantumCatalogAngles(layoutId);
    }

    // Aurora doesn't sync a per-layout angle table (deliberately excluded —
    // see packages/aurora-sync/src/sync/shared-sync.ts). Every layout for a
    // given board type supports the same fixed angle range, hardcoded in
    // ANGLES (packages/shared/board-config/src/board-data.ts). The `layoutId`
    // argument is kept for API compatibility but doesn't affect the result.
    return ANGLES[validatedBoardName].map((angle) => ({ angle }));
  },

  quantumGeometry: async (_, { layoutId, sizeId }, ctx: ConnectionContext): Promise<QuantumGeometry | null> => {
    await applyRateLimit(ctx, 60, 'quantumGeometry');
    const model = Object.values(QUANTUM_MODELS).find(
      (candidate) => candidate.layoutId === layoutId && candidate.sizeId === sizeId,
    );
    if (!model) {
      throw new GraphQLError('Unknown QuantumBoard model', { extensions: { code: 'BAD_USER_INPUT' } });
    }
    return loadQuantumGeometry(layoutId, sizeId);
  },

  quantumGeometries: async (_, _args, ctx: ConnectionContext): Promise<QuantumGeometry[]> => {
    // Mobile needs all five models before exposing the picker. Batch that cold
    // hydration behind one rate-limit charge instead of five calls per launch.
    await applyRateLimit(ctx, 60, 'quantumGeometries');
    const geometries = await Promise.all(
      Object.values(QUANTUM_MODELS).map(({ layoutId, sizeId }) => loadQuantumGeometry(layoutId, sizeId)),
    );
    return geometries.filter((geometry): geometry is QuantumGeometry => geometry !== null);
  },
};

async function loadQuantumGeometry(layoutId: number, sizeId: number): Promise<QuantumGeometry | null> {
  const [syncStateRows, sizeRows, associationRows] = await Promise.all([
    db
      .select({
        eventId: dbSchema.boardCatalogSyncState.manifestEventId,
        fingerprint: dbSchema.boardCatalogSyncState.manifestFingerprint,
        hardwareFingerprint: dbSchema.boardCatalogSyncState.hardwareFingerprint,
        lastSuccessAt: dbSchema.boardCatalogSyncState.lastSuccessAt,
      })
      .from(dbSchema.boardCatalogSyncState)
      .where(
        and(
          eq(dbSchema.boardCatalogSyncState.boardType, 'quantum'),
          eq(dbSchema.boardCatalogSyncState.source, QUANTUM_CATALOG_SOURCE),
        ),
      )
      .limit(1),
    db
      .select({
        edgeLeft: dbSchema.boardProductSizes.edgeLeft,
        edgeRight: dbSchema.boardProductSizes.edgeRight,
        edgeBottom: dbSchema.boardProductSizes.edgeBottom,
        edgeTop: dbSchema.boardProductSizes.edgeTop,
      })
      .from(dbSchema.boardProductSizes)
      .where(and(eq(dbSchema.boardProductSizes.boardType, 'quantum'), eq(dbSchema.boardProductSizes.id, sizeId)))
      .limit(1),
    db
      .select({ id: dbSchema.boardProductSizesLayoutsSets.id })
      .from(dbSchema.boardProductSizesLayoutsSets)
      .where(
        and(
          eq(dbSchema.boardProductSizesLayoutsSets.boardType, 'quantum'),
          eq(dbSchema.boardProductSizesLayoutsSets.layoutId, layoutId),
          eq(dbSchema.boardProductSizesLayoutsSets.productSizeId, sizeId),
        ),
      )
      .limit(1),
  ]);
  const syncState = syncStateRows[0];
  const size = sizeRows[0];
  if (!syncState?.lastSuccessAt || !size || associationRows.length === 0) return null;
  if (size.edgeLeft == null || size.edgeRight == null || size.edgeBottom == null || size.edgeTop == null) {
    return null;
  }

  const rows = await db
    .select({
      placementId: dbSchema.boardPlacements.id,
      holeId: dbSchema.boardPlacements.holeId,
      x: dbSchema.boardHoles.x,
      y: dbSchema.boardHoles.y,
      ledPosition: dbSchema.boardLeds.position,
    })
    .from(dbSchema.boardPlacements)
    .innerJoin(
      dbSchema.boardHoles,
      and(
        eq(dbSchema.boardHoles.boardType, dbSchema.boardPlacements.boardType),
        eq(dbSchema.boardHoles.id, dbSchema.boardPlacements.holeId),
      ),
    )
    .innerJoin(
      dbSchema.boardLeds,
      and(
        eq(dbSchema.boardLeds.boardType, dbSchema.boardPlacements.boardType),
        eq(dbSchema.boardLeds.holeId, dbSchema.boardPlacements.holeId),
        eq(dbSchema.boardLeds.productSizeId, sizeId),
      ),
    )
    .where(and(eq(dbSchema.boardPlacements.boardType, 'quantum'), eq(dbSchema.boardPlacements.layoutId, layoutId)))
    .orderBy(asc(dbSchema.boardPlacements.id));
  if (
    rows.length === 0 ||
    rows.some((row) => row.holeId == null || row.x == null || row.y == null || row.ledPosition == null)
  ) {
    return null;
  }

  const revision =
    syncState.eventId ??
    syncState.fingerprint ??
    syncState.hardwareFingerprint ??
    syncState.lastSuccessAt.toISOString();

  return {
    layoutId,
    sizeId,
    revision,
    edgeLeft: size.edgeLeft,
    edgeRight: size.edgeRight,
    edgeBottom: size.edgeBottom,
    edgeTop: size.edgeTop,
    placements: rows.map((row) => {
      // The guard above proves these nullable join columns are complete. Keep
      // the fail-closed check adjacent to this conversion so malformed
      // catalogue rows never reach the mobile geometry registry.
      if (row.holeId == null || row.x == null || row.y == null || row.ledPosition == null) {
        throw new Error('Quantum geometry completeness changed during mapping');
      }
      return {
        placementId: row.placementId,
        holeId: row.holeId,
        x: row.x,
        y: row.y,
        ledPosition: row.ledPosition,
      };
    }),
  };
}

/** Angles represented by signed-catalog routes, excluding Boardsesh-authored rows. */
export async function getQuantumCatalogAngles(layoutId: number): Promise<Array<{ angle: number }>> {
  return db
    .selectDistinct({ angle: dbSchema.boardClimbStats.angle })
    .from(dbSchema.boardClimbStats)
    .innerJoin(dbSchema.boardClimbs, eq(dbSchema.boardClimbs.uuid, dbSchema.boardClimbStats.climbUuid))
    .innerJoin(dbSchema.quantumClimbMetadata, eq(dbSchema.quantumClimbMetadata.climbUuid, dbSchema.boardClimbs.uuid))
    .where(
      and(
        eq(dbSchema.boardClimbStats.boardType, 'quantum'),
        eq(dbSchema.boardClimbs.boardType, 'quantum'),
        eq(dbSchema.boardClimbs.layoutId, layoutId),
        eq(dbSchema.boardClimbs.isListed, true),
      ),
    )
    .orderBy(asc(dbSchema.boardClimbStats.angle));
}
