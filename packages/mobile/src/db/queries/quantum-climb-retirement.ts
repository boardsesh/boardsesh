import type { OfflineDatabase } from '@boardsesh/offline-sync';

/** A withdrawn upstream route's sync marker. Historical ticks still reference its UUID. */
export const QUANTUM_CLIMB_RETIREMENT_SQL = `
  c.board_type = 'quantum'
  AND c.is_listed = 0
  AND c.is_hidden = 1
  AND c.is_boardsesh_authored = 0
  AND c.user_id IS NULL
  AND c.controller_route_uuid IS NULL
  AND c.frames IS NULL
`;

export async function isQuantumClimbRetired(climbUuid: string, database?: OfflineDatabase): Promise<boolean> {
  const db = database ?? (await import('../index')).getDatabaseHandle();
  if (!db) return false;
  const marker = await db.getFirstAsync<{ retired: number }>(
    `SELECT 1 AS retired FROM board_climbs c WHERE c.uuid = ? AND ${QUANTUM_CLIMB_RETIREMENT_SQL}`,
    [climbUuid],
  );
  return marker !== null;
}
