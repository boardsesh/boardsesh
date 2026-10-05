import { and, eq, isNotNull, sql } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../db/client';
import { lockWallForWrite } from './spray-wall-lock';

/** Invalidate a purge whose prefix listing preceded a late withdrawn upload/copy. */
export async function markDeletedSprayWallPhotoRetry(wallUuid: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [withdrawn] = await tx
      .select({ id: dbSchema.sprayWalls.id })
      .from(dbSchema.sprayWalls)
      .where(and(eq(dbSchema.sprayWalls.boardUuid, wallUuid), isNotNull(dbSchema.sprayWalls.deletedAt)))
      .limit(1);
    if (!withdrawn) return;
    await lockWallForWrite(tx, withdrawn.id);
    await tx
      .update(dbSchema.sprayWalls)
      .set({ photosPurgedAt: null, updatedAt: sql`clock_timestamp()` })
      .where(eq(dbSchema.sprayWalls.id, withdrawn.id));
  });
}
