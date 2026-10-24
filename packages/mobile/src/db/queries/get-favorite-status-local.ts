import { canServeLocalUserData, getLocalUserId, type SqlExecutor } from '@boardsesh/offline-sync';
import type { FavoritesQueryResponse } from '@boardsesh/graphql/operations/favorites';

// Keep the owner bind and the requested UUIDs below older SQLite's 999 limit.
const UUIDS_PER_STATEMENT = 400;

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
