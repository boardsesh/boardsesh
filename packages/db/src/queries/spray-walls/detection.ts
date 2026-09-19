import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import {
  SPRAY_DETECTION_PENDING_MS,
  SPRAY_WALL_WRITE_LOCK_NAMESPACE,
  isSprayDetectionPending,
  type SprayDetectionResult,
} from '@boardsesh/shared-schema';
import type { DbInstance } from '../../client';
import { sprayWallDetections, sprayWallVersions, sprayWalls, userBoards } from '../../schema';

type Executor = DbInstance | Parameters<Parameters<DbInstance['transaction']>[0]>[0];

export async function readSprayDetection(executor: Executor, id: string) {
  const [source] = await executor
    .select({
      detection: sprayWallDetections,
      version: sprayWallVersions,
      wall: sprayWalls,
      boardDeletedAt: userBoards.deletedAt,
    })
    .from(sprayWallDetections)
    .innerJoin(sprayWallVersions, eq(sprayWallVersions.id, sprayWallDetections.versionId))
    .innerJoin(sprayWalls, eq(sprayWalls.id, sprayWallDetections.wallId))
    .innerJoin(userBoards, eq(userBoards.uuid, sprayWalls.boardUuid))
    .where(eq(sprayWallDetections.id, id))
    .limit(1);
  return source;
}

export function sprayDetectionSourceIsCurrent(
  source: NonNullable<Awaited<ReturnType<typeof readSprayDetection>>>,
): boolean {
  return (
    !source.wall.deletedAt &&
    !source.boardDeletedAt &&
    source.version.status === 'draft' &&
    source.version.wallId === source.wall.id &&
    source.version.photoKey === source.detection.photoKey &&
    source.version.photoWidth === source.detection.photoWidth &&
    source.version.photoHeight === source.detection.photoHeight
  );
}

export async function claimSprayDetection(database: DbInstance, id: string, jobId: string) {
  const initial = await readSprayDetection(database, id);
  if (!initial) return null;
  return database.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(${SPRAY_WALL_WRITE_LOCK_NAMESPACE}, ${initial.wall.id})`,
    );
    const source = await readSprayDetection(transaction, id);
    if (!source || source.detection.jobId !== jobId || !isSprayDetectionPending(source.detection.status)) return null;
    if (
      !sprayDetectionSourceIsCurrent(source) ||
      Date.now() - source.detection.createdAt.getTime() >= SPRAY_DETECTION_PENDING_MS
    ) {
      await transaction
        .update(sprayWallDetections)
        .set({ status: 'cancelled', error: 'SOURCE_EXPIRED', finishedAt: new Date(), attemptToken: null })
        .where(eq(sprayWallDetections.id, id));
      return null;
    }
    const attemptToken = randomUUID();
    await transaction
      .update(sprayWallDetections)
      .set({ status: 'running', attemptToken, startedAt: new Date(), error: null })
      .where(eq(sprayWallDetections.id, id));
    return { ...source.detection, attemptToken };
  });
}

export async function finishSprayDetection(
  database: DbInstance,
  id: string,
  attemptToken: string,
  result: SprayDetectionResult,
): Promise<boolean> {
  const initial = await readSprayDetection(database, id);
  if (!initial) return false;
  return database.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(${SPRAY_WALL_WRITE_LOCK_NAMESPACE}, ${initial.wall.id})`,
    );
    const source = await readSprayDetection(transaction, id);
    if (!source || source.detection.status !== 'running' || source.detection.attemptToken !== attemptToken)
      return false;
    const valid =
      sprayDetectionSourceIsCurrent(source) &&
      Date.now() - source.detection.createdAt.getTime() < SPRAY_DETECTION_PENDING_MS;
    await transaction
      .update(sprayWallDetections)
      .set({
        status: valid ? 'done' : 'cancelled',
        result: valid ? result : null,
        error: valid ? null : 'SOURCE_EXPIRED',
        finishedAt: new Date(),
        attemptToken: null,
      })
      .where(and(eq(sprayWallDetections.id, id), eq(sprayWallDetections.attemptToken, attemptToken)));
    return valid;
  });
}

export async function retrySprayDetectionAttempt(
  database: DbInstance,
  id: string,
  attemptToken: string,
): Promise<void> {
  await database
    .update(sprayWallDetections)
    .set({ status: 'pending', error: 'RETRYING', attemptToken: null })
    .where(
      and(
        eq(sprayWallDetections.id, id),
        eq(sprayWallDetections.status, 'running'),
        eq(sprayWallDetections.attemptToken, attemptToken),
      ),
    );
}
