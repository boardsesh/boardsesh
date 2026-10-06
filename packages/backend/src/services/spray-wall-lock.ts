import { sql, type SQL } from 'drizzle-orm';
import { SPRAY_WALL_WRITE_LOCK_NAMESPACE } from '@boardsesh/shared-schema';

/** Leaf seam so photo cleanup can coordinate without importing its resolver. */
export async function lockWallForWrite(
  tx: { execute: (query: SQL) => Promise<unknown> },
  wallId: number,
): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${SPRAY_WALL_WRITE_LOCK_NAMESPACE}, ${wallId})`);
}
