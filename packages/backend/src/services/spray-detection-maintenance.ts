import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import {
  SPRAY_DETECTION_QUEUE,
  SPRAY_DETECTION_DEAD_QUEUE,
  SPRAY_DETECTION_RECONCILE_QUEUE,
  SPRAY_DETECTION_PENDING_MS,
  type SprayDetectionJob,
} from '@boardsesh/shared-schema';
import { sprayWallDetections } from '@boardsesh/db/schema';
import { readSprayDetection, sprayDetectionSourceIsCurrent } from '@boardsesh/db/queries';
import { db } from '../db/client';
import { MAINTENANCE_POLLING_INTERVAL_SECONDS } from './job-queue-client';

let reconcileCursor: string | undefined;

export async function reconcileSprayDetections(boss: PgBoss): Promise<void> {
  // A bounded page per tick. Advance past live jobs so they cannot starve later failures.
  const pending = await db
    .select()
    .from(sprayWallDetections)
    .where(
      and(
        inArray(sprayWallDetections.status, ['pending', 'running']),
        reconcileCursor ? gt(sprayWallDetections.id, reconcileCursor) : undefined,
      ),
    )
    .orderBy(asc(sprayWallDetections.id))
    .limit(100);
  reconcileCursor = pending.length === 100 ? pending[pending.length - 1].id : undefined;
  for (const detection of pending) {
    const source = await readSprayDetection(db, detection.id);
    const expired = Date.now() - detection.createdAt.getTime() >= SPRAY_DETECTION_PENDING_MS;
    const invalid = !source || !sprayDetectionSourceIsCurrent(source);
    const job = await boss.getJobById(SPRAY_DETECTION_QUEUE, detection.jobId);
    const failed = !job || job.state === 'failed' || job.state === 'cancelled' || job.state === 'completed';
    if (!expired && !invalid && !failed) continue;
    await db
      .update(sprayWallDetections)
      .set({
        status: invalid ? 'cancelled' : 'failed',
        error: invalid ? 'SOURCE_EXPIRED' : expired ? 'QUEUE_EXPIRED' : 'DETECTION_FAILED',
        finishedAt: new Date(),
        attemptToken: null,
      })
      .where(
        and(eq(sprayWallDetections.id, detection.id), inArray(sprayWallDetections.status, ['pending', 'running'])),
      );
    if (job && (expired || invalid)) await boss.cancel(SPRAY_DETECTION_QUEUE, detection.jobId);
  }
}

export async function startSprayDetectionMaintenance(boss: PgBoss): Promise<void> {
  await boss.work<SprayDetectionJob>(
    SPRAY_DETECTION_DEAD_QUEUE,
    { pollingIntervalSeconds: MAINTENANCE_POLLING_INTERVAL_SECONDS },
    async (jobs) => {
      for (const job of jobs) {
        await db
          .update(sprayWallDetections)
          .set({ status: 'failed', error: 'DETECTION_FAILED', finishedAt: new Date(), attemptToken: null })
          .where(
            and(
              eq(sprayWallDetections.id, job.data.detectionId),
              inArray(sprayWallDetections.status, ['pending', 'running']),
            ),
          );
      }
    },
  );
  await boss.schedule(SPRAY_DETECTION_RECONCILE_QUEUE, '* * * * *');
  await boss.work(
    SPRAY_DETECTION_RECONCILE_QUEUE,
    { pollingIntervalSeconds: MAINTENANCE_POLLING_INTERVAL_SECONDS },
    async () => {
      await reconcileSprayDetections(boss);
    },
  );
}
