import { randomUUID } from 'node:crypto';
import { and, count, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import { z } from 'zod';
import {
  SPRAY_DETECTION_QUEUE,
  SPRAY_DETECTION_MODEL_VERSION,
  SPRAY_DETECTION_WEIGHTS_SHA256,
  isSprayDetectionPending,
  type ConnectionContext,
  type SprayDetectionView,
} from '@boardsesh/shared-schema';
import { sprayWallDetections, sprayWallVersions, sprayWalls, userBoards } from '@boardsesh/db/schema';
import { db } from '../../../db/client';
import {
  readSprayDetectionQueuePositions,
  readSprayWallImportProgress,
  type SprayQueuePosition,
} from '@boardsesh/db/queries';
import { enqueueOn, requireJobQueue } from '../../../services/job-queue';
import { applyRateLimit, requireAuthenticated, validateInput } from '../shared/helpers';
import { loadEditableWall, lockWallForWrite } from './spray-walls';
import { filterEditableBoards } from '../social/boards';

const requestSchema = z.object({
  wallUuid: z.string().uuid(),
  versionId: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
type DetectionRow = typeof sprayWallDetections.$inferSelect;

function toView(row: DetectionRow, wallUuid: string, queue?: SprayQueuePosition): SprayDetectionView {
  return {
    id: row.id,
    wallUuid,
    versionId: String(row.versionId),
    status: row.status,
    modelVersion: row.modelVersion,
    result: row.result,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    queuePosition: row.status === 'pending' ? (queue?.queuePosition ?? null) : null,
    retryAt: row.status === 'pending' ? (queue?.retryAt ?? null) : null,
  };
}

async function findEditableDetection(ctx: ConnectionContext, id: string) {
  requireAuthenticated(ctx);
  const checkedId = validateInput(z.string().uuid(), id, 'id');
  const [record] = await db
    .select({ detection: sprayWallDetections, wallUuid: sprayWalls.boardUuid })
    .from(sprayWallDetections)
    .innerJoin(sprayWalls, eq(sprayWalls.id, sprayWallDetections.wallId))
    .where(eq(sprayWallDetections.id, checkedId))
    .limit(1);
  if (!record) return null;
  await loadEditableWall(ctx, record.wallUuid);
  return record;
}

async function requestDetection(ctx: ConnectionContext, input: unknown, retryId?: string): Promise<SprayDetectionView> {
  requireAuthenticated(ctx);
  const { wallUuid, versionId } = validateInput(requestSchema, input, 'input');
  const { wall } = await loadEditableWall(ctx, wallUuid);
  const userId = ctx.userId;
  if (!userId) throw new GraphQLError('Authentication required');
  const boss = requireJobQueue();
  return db.transaction(async (transaction) => {
    // Serialize this user's hourly budget across different walls and replicas.
    await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 5451))`);
    await lockWallForWrite(transaction, wall.id);
    const [source] = await transaction
      .select({ version: sprayWallVersions })
      .from(sprayWallVersions)
      .innerJoin(sprayWalls, eq(sprayWalls.id, sprayWallVersions.wallId))
      .where(
        and(
          eq(sprayWallVersions.id, versionId),
          eq(sprayWallVersions.wallId, wall.id),
          eq(sprayWallVersions.status, 'draft'),
          isNull(sprayWalls.deletedAt),
        ),
      )
      .limit(1);
    const version = source?.version;
    if (!version?.photoKey || !version.photoWidth || !version.photoHeight) {
      throw new GraphQLError('A draft with an uploaded photo is required', {
        extensions: { code: 'SPRAY_DETECTION_INVALID_DRAFT' },
      });
    }
    const [previous] = await transaction
      .select()
      .from(sprayWallDetections)
      .where(and(eq(sprayWallDetections.versionId, versionId), eq(sprayWallDetections.photoKey, version.photoKey)))
      .orderBy(desc(sprayWallDetections.createdAt), desc(sprayWallDetections.id))
      .limit(1);
    if (
      previous &&
      (!retryId || previous.id !== retryId || isSprayDetectionPending(previous.status) || previous.status === 'done')
    ) {
      return toView(previous, wallUuid);
    }
    const [budget] = await transaction
      .select({ requests: count() })
      .from(sprayWallDetections)
      .where(
        and(
          eq(sprayWallDetections.requestedBy, userId),
          gt(sprayWallDetections.createdAt, new Date(Date.now() - 3_600_000)),
        ),
      );
    if ((budget?.requests ?? 0) >= 10) {
      throw new GraphQLError('Recognition request limit reached', {
        extensions: { code: 'SPRAY_DETECTION_RATE_LIMITED' },
      });
    }
    const id = randomUUID();
    const jobId = await boss.send(SPRAY_DETECTION_QUEUE, { detectionId: id }, { db: enqueueOn(transaction) });
    if (!jobId) throw new Error('Recognition job could not be queued');
    const [created] = await transaction
      .insert(sprayWallDetections)
      .values({
        id,
        wallId: wall.id,
        versionId,
        requestedBy: userId,
        photoKey: version.photoKey,
        photoWidth: version.photoWidth,
        photoHeight: version.photoHeight,
        jobId,
        modelVersion: SPRAY_DETECTION_MODEL_VERSION,
        weightsSha256: SPRAY_DETECTION_WEIGHTS_SHA256,
      })
      .returning();
    return toView(created, wallUuid);
  });
}

export const sprayDetectionQueries = {
  sprayWallImportProgress: async (_: unknown, { wallUuids }: { wallUuids: string[] }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 90, 'sprayWallImportProgress');
    const checkedUuids = validateInput(z.array(z.string().uuid()).max(50), wallUuids, 'wallUuids');
    if (checkedUuids.length === 0) return [];
    const wallBoards = await db
      .select({ board: userBoards })
      .from(userBoards)
      .innerJoin(sprayWalls, eq(sprayWalls.boardUuid, userBoards.uuid))
      .where(and(inArray(userBoards.uuid, checkedUuids), isNull(userBoards.deletedAt), isNull(sprayWalls.deletedAt)));
    const editableBoards = await filterEditableBoards(
      wallBoards.map(({ board }) => board),
      ctx.userId!,
    );
    return readSprayWallImportProgress(
      db,
      editableBoards.map((board) => board.uuid),
    );
  },
  sprayWallDetection: async (_: unknown, { id }: { id: string }, ctx: ConnectionContext) => {
    await applyRateLimit(ctx, 90, 'sprayWallDetection');
    const record = await findEditableDetection(ctx, id);
    if (!record) return null;
    const queue = record.detection.status === 'pending' ? await readSprayDetectionQueuePositions(db) : undefined;
    return toView(record.detection, record.wallUuid, queue?.get(record.detection.jobId));
  },
  sprayWallDetectionForVersion: async (
    _: unknown,
    input: { wallUuid: string; versionId: string },
    ctx: ConnectionContext,
  ) => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 90, 'sprayWallDetection');
    const { wallUuid, versionId } = validateInput(requestSchema, input, 'input');
    const { wall } = await loadEditableWall(ctx, wallUuid);
    const [record] = await db
      .select()
      .from(sprayWallDetections)
      .where(and(eq(sprayWallDetections.wallId, wall.id), eq(sprayWallDetections.versionId, versionId)))
      .orderBy(desc(sprayWallDetections.createdAt), desc(sprayWallDetections.id))
      .limit(1);
    if (!record) return null;
    const queue = record.status === 'pending' ? await readSprayDetectionQueuePositions(db) : undefined;
    return toView(record, wallUuid, queue?.get(record.jobId));
  },
};
export const sprayDetectionMutations = {
  requestSprayWallDetection: (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) =>
    requestDetection(ctx, input),
  retrySprayWallDetection: async (_: unknown, { id }: { id: string }, ctx: ConnectionContext) => {
    const record = await findEditableDetection(ctx, id);
    if (!record) throw new GraphQLError('Recognition request not found');
    return requestDetection(ctx, { wallUuid: record.wallUuid, versionId: record.detection.versionId }, id);
  },
};
