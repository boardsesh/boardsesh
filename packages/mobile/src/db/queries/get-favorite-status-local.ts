import { canServeLocalUserData, getLocalUserId, type SqlExecutor } from '@boardsesh/offline-sync';
import type { FavoritesQueryResponse } from '@boardsesh/graphql/operations/favorites';

// Keep the owner bind and the requested UUIDs below older SQLite's 999 limit.
const UUIDS_PER_STATEMENT = 400;

/** Capture unsynced intent before a server read, including cold-start writes. */
export async function getPendingFavoriteOverridesLocal(
  db: SqlExecutor,
  climbUuids: readonly string[],
  viewerId: string,
): Promise<Map<string, boolean>> {
  const overrides = new Map<string, boolean>();
  if (!viewerId || (await getLocalUserId(db)) !== viewerId) return overrides;
  const uniqueClimbUuids = [...new Set(climbUuids)];
  for (let start = 0; start < uniqueClimbUuids.length; start += UUIDS_PER_STATEMENT) {
    const chunk = uniqueClimbUuids.slice(start, start + UUIDS_PER_STATEMENT);
    const rows = await db.getAllAsync<{ climb_uuid: string; operation: string }>(
      `SELECT json_extract(payload, '$.climbUuid') AS climb_uuid, operation
       FROM pending_mutations
       WHERE table_name = 'user_favorites' AND status IN ('pending', 'dead_letter')
         AND json_extract(payload, '$.climbUuid') IN (${chunk.map(() => '?').join(', ')})
       ORDER BY created_at ASC, id ASC`,
      chunk,
    );
    for (const row of rows) {
      if (row.operation === 'create' || row.operation === 'delete') {
        overrides.set(row.climb_uuid, row.operation === 'create');
      }
    }
  }
  return (await getLocalUserId(db)) === viewerId ? overrides : new Map();
}

/**
 * The current server's favorite identity is (user, climb UUID), across boards
 * and angles. The local table still carries the older composite key, so read
 * distinct UUIDs and keep the same owner/legacy-write predicate as ticks.
 * Null means unavailable user data; a complete, owned empty table returns [].
 */
export async function getFavoriteStatusLocal(
  db: SqlExecutor,
  climbUuids: readonly string[],
  viewerId: string,
): Promise<FavoritesQueryResponse | null> {
  if (!(await canServeLocalUserData(db, viewerId))) return null;
  const ownerUserId = await getLocalUserId(db);
  if (ownerUserId !== viewerId) return null;
  const uniqueClimbUuids = [...new Set(climbUuids)];
  const favoriteUuids = new Set<string>();
  for (let start = 0; start < uniqueClimbUuids.length; start += UUIDS_PER_STATEMENT) {
    const chunk = uniqueClimbUuids.slice(start, start + UUIDS_PER_STATEMENT);
    const rows = await db.getAllAsync<{ climb_uuid: string }>(
      `SELECT DISTINCT climb_uuid FROM user_favorites
       WHERE climb_uuid IN (${chunk.map(() => '?').join(', ')})
         AND (user_id = ? OR user_id IS NULL)`,
      [...chunk, ownerUserId],
    );
    for (const row of rows) favoriteUuids.add(row.climb_uuid);
  }
  if (!(await canServeLocalUserData(db, viewerId))) return null;
  return { favorites: uniqueClimbUuids.filter((climbUuid) => favoriteUuids.has(climbUuid)) };
}
