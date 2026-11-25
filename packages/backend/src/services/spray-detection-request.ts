import { randomUUID } from 'node:crypto';
import { and, count, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import {
  SPRAY_DETECTION_MODEL_VERSION,
  SPRAY_DETECTION_QUEUE,
  SPRAY_DETECTION_WEIGHTS_SHA256,
  isSprayDetectionPending,
} from '@boardsesh/shared-schema';
import { sprayWallDetections, sprayWallVersions, sprayWalls } from '@boardsesh/db/schema';
import type { DbTransaction } from '../db/after-commit';
import { enqueueOn } from './job-queue';
import { lockWallForWrite } from './spray-wall-lock';

/** Recognition requests one person may make in an hour through the API. */
export const SPRAY_DETECTION_HOURLY_LIMIT = 10;

export type SprayDetectionRow = typeof sprayWallDetections.$inferSelect;

export type SprayDetectionRequest = {
  wallId: number;
  versionId: number;
  /** Who the detection is for. The completion notification goes to this user. */
  requestedBy: string;
  /**
   * The failed detection an explicit retry replaces. Without it, an existing
   * detection for the draft's photo is returned instead of queuing another.
   */
  retryOf?: string;
  /** False only for an operator repair; every API request counts against the hourly limit. */
  enforceHourlyLimit: boolean;
};

export type SprayDetectionRequestOutcome =
  | { kind: 'created'; detection: SprayDetectionRow }
  | { kind: 'existing'; detection: SprayDetectionRow }
  | { kind: 'invalid-draft' }
  | { kind: 'rate-limited' };

/**
 * The two locks every detection request takes, in this order: the requester's
 * hourly budget (serialized across walls and replicas), then the wall.
 * Advisory locks are re-entrant within a transaction, so a caller that takes
 * them early to run its own checks can still call `requestSprayDetection`.
 */
export async function lockSprayDetectionRequest(
  transaction: DbTransaction,
  request: Pick<SprayDetectionRequest, 'requestedBy' | 'wallId'>,
): Promise<void> {
  await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${request.requestedBy}, 5451))`);
  await lockWallForWrite(transaction, request.wallId);
}

/**
 * Queue recognition for a draft's photo inside the caller's transaction: the
 * pg-boss job and the `spray_wall_detections` row commit or roll back together.
 *
 * The caller has already checked that `requestedBy` may edit the wall. Shared by
 * `requestSprayWallDetection` / `retrySprayWallDetection` and the operator
 * script that revives imports a detector outage expired.
 */
export async function requestSprayDetection(
  transaction: DbTransaction,
  boss: Pick<PgBoss, 'send'>,
  request: SprayDetectionRequest,
): Promise<SprayDetectionRequestOutcome> {
  const { wallId, versionId, requestedBy, retryOf } = request;
  await lockSprayDetectionRequest(transaction, request);
  const [source] = await transaction
    .select({ version: sprayWallVersions })
    .from(sprayWallVersions)
    .innerJoin(sprayWalls, eq(sprayWalls.id, sprayWallVersions.wallId))
    .where(
      and(
        eq(sprayWallVersions.id, versionId),
        eq(sprayWallVersions.wallId, wallId),
        eq(sprayWallVersions.status, 'draft'),
        isNull(sprayWalls.deletedAt),
      ),
    )
    .limit(1);
  const version = source?.version;
  if (!version?.photoKey || !version.photoWidth || !version.photoHeight) return { kind: 'invalid-draft' };
  const [previous] = await transaction
    .select()
    .from(sprayWallDetections)
    .where(and(eq(sprayWallDetections.versionId, versionId), eq(sprayWallDetections.photoKey, version.photoKey)))
    .orderBy(desc(sprayWallDetections.createdAt), desc(sprayWallDetections.id))
    .limit(1);
  if (
    previous &&
    (!retryOf || previous.id !== retryOf || isSprayDetectionPending(previous.status) || previous.status === 'done')
  ) {
    return { kind: 'existing', detection: previous };
  }
  if (request.enforceHourlyLimit) {
    const [budget] = await transaction
      .select({ requests: count() })
      .from(sprayWallDetections)
      .where(
        and(
          eq(sprayWallDetections.requestedBy, requestedBy),
          gt(sprayWallDetections.createdAt, new Date(Date.now() - 3_600_000)),
        ),
      );
    if ((budget?.requests ?? 0) >= SPRAY_DETECTION_HOURLY_LIMIT) return { kind: 'rate-limited' };
  }
  const id = randomUUID();
  const jobId = await boss.send(SPRAY_DETECTION_QUEUE, { detectionId: id }, { db: enqueueOn(transaction) });
  if (!jobId) throw new Error('Recognition job could not be queued');
  const [created] = await transaction
    .insert(sprayWallDetections)
    .values({
      id,
      wallId,
      versionId,
      requestedBy,
      photoKey: version.photoKey,
      photoWidth: version.photoWidth,
      photoHeight: version.photoHeight,
      jobId,
      modelVersion: SPRAY_DETECTION_MODEL_VERSION,
      weightsSha256: SPRAY_DETECTION_WEIGHTS_SHA256,
    })
    .returning();
  return { kind: 'created', detection: created };
}
