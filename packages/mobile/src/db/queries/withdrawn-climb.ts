import type { OfflineDatabase } from '@boardsesh/offline-sync';
import { withdrawnClimbTombstoneSql } from '@boardsesh/offline-sync/withdrawn-climb';

/**
 * Whether this device holds the tombstone the sync sends once a supplier
 * withdraws a catalogue climb on a board that hides withdrawn climbs. The
 * predicate matches only those boards, so any other board's climb reads false.
 * Historical ticks still reference the uuid; nothing else may open or light it.
 */
export async function isClimbWithdrawn(climbUuid: string, database?: OfflineDatabase): Promise<boolean> {
  const db = database ?? (await import('../index')).getDatabaseHandle();
  if (!db) return false;
  const marker = await db.getFirstAsync<{ withdrawn: number }>(
    `SELECT 1 AS withdrawn FROM board_climbs c WHERE c.uuid = ? AND ${withdrawnClimbTombstoneSql('c.')}`,
    [climbUuid],
  );
  return marker !== null;
}
