import { sql } from 'drizzle-orm';
import type { RequestDbInstance } from '../../client';
import { getBoardTables, type BoardName } from '../util/table-select';

interface MatchedClimb {
  uuid: string;
  name: string;
}

/**
 * Find a climb by exact frames string match.
 * Returns the most popular climb (by ascensionist count) if multiple matches exist.
 *
 * @param db - Request-scoped neon-http drizzle client
 * @param boardName - The board type (kilter, tension, moonboard)
 * @param layoutId - The layout ID to search within
 * @param frames - The frames string to match
 * @param angle - Optional angle for stats lookup (affects popularity sorting)
 * @returns The matched climb or null if not found
 */
export async function matchClimbByFrames(
  db: RequestDbInstance,
  boardName: BoardName,
  layoutId: number,
  frames: string,
  angle?: number
): Promise<MatchedClimb | null> {
  const tables = getBoardTables(boardName);

  try {
    // Query for exact frames match, prioritizing by popularity (ascensionist count)
    const result = await db
      .select({
        uuid: tables.climbs.uuid,
        name: tables.climbs.name,
      })
      .from(tables.climbs)
      .leftJoin(
        tables.climbStats,
        sql`${tables.climbStats.climbUuid} = ${tables.climbs.uuid}
          AND ${tables.climbStats.boardType} = ${boardName}
          ${angle !== undefined ? sql`AND ${tables.climbStats.angle} = ${angle}` : sql``}`
      )
      .where(
        sql`${tables.climbs.boardType} = ${boardName}
          AND ${tables.climbs.layoutId} = ${layoutId}
          AND ${tables.climbs.frames} = ${frames}
          AND ${tables.climbs.framesCount} = 1
          AND ${tables.climbs.isListed} = true
          AND ${tables.climbs.isDraft} = false`
      )
      .orderBy(sql`${tables.climbStats.ascensionistCount} DESC NULLS LAST`)
      .limit(1);

    if (result.length === 0) {
      return null;
    }

    return {
      uuid: result[0].uuid,
      name: result[0].name || '',
    };
  } catch (error) {
    console.error('[matchClimbByFrames] Error:', error);
    throw error;
  }
}
