import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { alias, boolean, integer, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { SPRAY_DETECTION_QUEUE, type SprayWallImportProgress } from '@boardsesh/shared-schema';
import type { DbInstance } from '../../client';
import { sprayWallDetections, sprayWalls, sprayWallVersions } from '../../schema/app/spray-walls';

// Read-only pg-boss 12.33 projection; never exported as application schema.
const detectionQueueJobs = pgSchema('pgboss').table('job', {
  id: uuid('id').notNull(),
  name: text('name').notNull(),
  state: text('state').notNull(),
  priority: integer('priority').notNull(),
  blocked: boolean('blocked').notNull(),
  createdOn: timestamp('created_on', { withTimezone: true }).notNull(),
  startAfter: timestamp('start_after', { withTimezone: true }).notNull(),
});

export interface SprayQueueSnapshotJob {
  id: string;
  state: string;
  priority: number;
  blocked: boolean;
  createdOn: Date;
  startAfter: Date;
}
export interface SprayQueuePosition {
  queuePosition: number | null;
  retryAt: string | null;
}

/** Match pg-boss's priority/FIFO fetch, but do not invent an order for ties. */
export function rankSprayDetectionQueue(jobs: SprayQueueSnapshotJob[], now: Date): Map<string, SprayQueuePosition> {
  const activeCount = jobs.reduce((count, job) => count + Number(job.state === 'active'), 0);
  const waiting = jobs
    .filter((job) => !job.blocked && (job.state === 'created' || job.state === 'retry') && job.startAfter <= now)
    .sort((left, right) => right.priority - left.priority || left.createdOn.getTime() - right.createdOn.getTime());
  const positions = new Map<string, SprayQueuePosition>();
  jobs.forEach((job) => {
    positions.set(job.id, {
      queuePosition: null,
      retryAt:
        !job.blocked && (job.state === 'created' || job.state === 'retry') && job.startAfter > now
          ? job.startAfter.toISOString()
          : null,
    });
  });
  waiting.forEach((job, index) => {
    const isTied = [waiting[index - 1], waiting[index + 1]].some(
      (neighbor) =>
        neighbor && neighbor.priority === job.priority && neighbor.createdOn.getTime() === job.createdOn.getTime(),
    );
    if (!isTied) positions.set(job.id, { queuePosition: activeCount + index + 1, retryAt: null });
  });
  return positions;
}

/** One statement provides all live queue rows and PostgreSQL's snapshot time. */
export async function readSprayDetectionQueuePositions(database: DbInstance): Promise<Map<string, SprayQueuePosition>> {
  const jobs = await database
    .select({
      id: detectionQueueJobs.id,
      state: detectionQueueJobs.state,
      priority: detectionQueueJobs.priority,
      blocked: detectionQueueJobs.blocked,
      createdOn: detectionQueueJobs.createdOn,
      startAfter: detectionQueueJobs.startAfter,
      snapshotAt: sql<Date>`pgboss.job_now()`.mapWith(detectionQueueJobs.createdOn),
    })
    .from(detectionQueueJobs)
    .where(
      and(
        eq(detectionQueueJobs.name, SPRAY_DETECTION_QUEUE),
        or(
          eq(detectionQueueJobs.state, 'active'),
          eq(detectionQueueJobs.state, 'created'),
          eq(detectionQueueJobs.state, 'retry'),
        ),
      ),
    );
  return rankSprayDetectionQueue(jobs, jobs[0]?.snapshotAt ?? new Date());
}

/**
 * Caller must pass only wall UUIDs the viewer may edit. Only a wall with nothing
 * published yet is an import: a reset makes a new unpublished clone
 * (`reset_from_wall_id`), so a draft left on a published wall is never shown.
 */
export async function readSprayWallImportProgress(
  database: DbInstance,
  wallUuids: string[],
): Promise<SprayWallImportProgress[]> {
  if (wallUuids.length === 0) return [];
  const resetSource = alias(sprayWalls, 'reset_source_spray_wall');
  const walls = await database
    .select({ wallId: sprayWalls.id, wallUuid: sprayWalls.boardUuid, resetOfWallUuid: resetSource.boardUuid })
    .from(sprayWalls)
    .leftJoin(resetSource, and(eq(resetSource.id, sprayWalls.resetFromWallId), isNull(resetSource.deletedAt)))
    .where(
      and(inArray(sprayWalls.boardUuid, wallUuids), isNull(sprayWalls.deletedAt), isNull(sprayWalls.currentVersionId)),
    );
  if (walls.length === 0) return [];
  const drafts = await database
    .selectDistinctOn([sprayWallVersions.wallId])
    .from(sprayWallVersions)
    .where(
      and(
        inArray(
          sprayWallVersions.wallId,
          walls.map((wall) => wall.wallId),
        ),
        eq(sprayWallVersions.status, 'draft'),
      ),
    )
    .orderBy(sprayWallVersions.wallId, desc(sprayWallVersions.versionNumber));
  const detections =
    drafts.length > 0
      ? await database
          .selectDistinctOn([sprayWallDetections.versionId], { detection: sprayWallDetections })
          .from(sprayWallDetections)
          .innerJoin(sprayWallVersions, eq(sprayWallVersions.id, sprayWallDetections.versionId))
          .where(
            and(
              inArray(
                sprayWallDetections.versionId,
                drafts.map((draft) => draft.id),
              ),
              eq(sprayWallDetections.photoKey, sprayWallVersions.photoKey),
            ),
          )
          .orderBy(sprayWallDetections.versionId, desc(sprayWallDetections.createdAt), desc(sprayWallDetections.id))
      : [];
  const draftByWall = new Map(drafts.map((draft) => [draft.wallId, draft]));
  const detectionByVersion = new Map(detections.map(({ detection }) => [detection.versionId, detection]));
  const queuePositions = detections.some(
    ({ detection }) => detection.status === 'pending' || detection.status === 'running',
  )
    ? await readSprayDetectionQueuePositions(database)
    : new Map<string, SprayQueuePosition>();
  return walls.flatMap((wall): SprayWallImportProgress[] => {
    const draft = draftByWall.get(wall.wallId);
    const detection = draft ? detectionByVersion.get(draft.id) : undefined;
    const stage =
      !detection || detection.status === 'cancelled'
        ? 'draft'
        : detection.status === 'done'
          ? 'ready'
          : detection.status === 'failed'
            ? 'failed'
            : detection.status === 'running'
              ? 'running'
              : 'queued';
    const queue = detection && stage === 'queued' ? queuePositions.get(detection.jobId) : undefined;
    return [
      {
        wallUuid: wall.wallUuid,
        versionId: draft ? String(draft.id) : null,
        detectionId: detection?.id ?? null,
        stage,
        queuePosition: queue?.queuePosition ?? null,
        retryAt: queue?.retryAt ?? null,
        resetOfWallUuid: wall.resetOfWallUuid ?? null,
      },
    ];
  });
}
