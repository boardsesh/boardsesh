import type { OfflineDatabase } from '@boardsesh/offline-sync';
import type { SetterStat, SetterStatsInput } from '@boardsesh/shared-schema';
import { isSizeScopedBoard } from '@boardsesh/board-config';
import { parseSetIds, escapeLike } from './search-climbs-local';

/**
 * On-device twin of `getSetterStats` (packages/db/src/queries/climbs/setter-stats.ts):
 * who set on this board configuration, so the setter picker can open without the
 * network. Mirrors that query's predicates exactly, translated to the local dialect
 * the same way `buildJoinAndWhere` in `search-climbs-local.ts` already does for array
 * containment (JSON-in-TEXT columns via `json_each`, since the pull client stores
 * `required_set_ids`/`compatible_size_ids` as JSON text rather than native arrays).
 *
 * Deliberately angle-blind (per #5404/#5406): `input.angle` is accepted but never
 * referenced, because setter-list membership doesn't depend on angle. Not user-scoped
 * either — this is a public aggregate over board reference data, so none of the
 * auth-scoping contract (docs/offline-reads.md) applies.
 */
type Bind = string | number;

type SetterStatRow = { setter_username: string; climb_count: number };

export async function getSetterStatsLocal(db: OfflineDatabase, input: SetterStatsInput): Promise<SetterStat[]> {
  const boardType = input.boardName;
  const isMoonboard = boardType === 'moonboard';
  const setIds = parseSetIds(input.setIds);

  const conditions: string[] = [];
  const binds: Bind[] = [];
  const push = (clause: string, ...clauseBinds: Bind[]) => {
    conditions.push(clause);
    binds.push(...clauseBinds);
  };

  push('c.board_type = ?', boardType);
  push('c.layout_id = ?', input.layoutId);
  push('c.is_listed = 1');
  push('c.is_draft = 0');

  // Community-hidden climbs excluded, mirroring hiddenClimbCondition (server) /
  // search-climbs-local.ts. COALESCE because is_hidden arrived at migration v5;
  // an unknown flag reads as visible.
  push('COALESCE(c.is_hidden, 0) = 0');

  // Size: compatible_size_ids contains sizeId (skipped for boards without size
  // variants — moonboard).
  if (isSizeScopedBoard(boardType)) {
    push(
      'c.compatible_size_ids IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(c.compatible_size_ids) WHERE value = ?)',
      input.sizeId,
    );
  }

  // Set membership (subset): every required set is in the selected sets. NULL
  // required_set_ids is excluded for non-moonboard (matches Postgres NULL <@
  // semantics); moonboard allows NULL (backfill pending) — same rule as the server.
  if (setIds.length > 0) {
    const placeholders = setIds.map(() => '?').join(', ');
    const subsetProbe = `NOT EXISTS (SELECT 1 FROM json_each(c.required_set_ids) WHERE value NOT IN (${placeholders}))`;
    if (isMoonboard) {
      push(`(c.required_set_ids IS NULL OR ${subsetProbe})`, ...setIds);
    } else {
      push(`(c.required_set_ids IS NOT NULL AND ${subsetProbe})`, ...setIds);
    }
  }

  push(`c.setter_username IS NOT NULL AND c.setter_username != ''`);

  // Case-insensitive substring filter (autocomplete), mirroring the server's ilike.
  // SQLite LIKE is ASCII case-insensitive by default — the same accepted limitation
  // documented in search-climbs-local.ts for the name filter.
  const search = input.search?.trim();
  if (search) {
    push(`c.setter_username LIKE ? ESCAPE '\\'`, `%${escapeLike(search)}%`);
  }

  const query = `
    SELECT c.setter_username AS setter_username, COUNT(*) AS climb_count
    FROM board_climbs c
    WHERE ${conditions.join(' AND ')}
    GROUP BY c.setter_username
    ORDER BY climb_count DESC, c.setter_username ASC
    LIMIT 50
  `;

  const rows = await db.getAllAsync<SetterStatRow>(query, binds);
  return rows.map((row) => ({ setterUsername: row.setter_username, climbCount: row.climb_count }));
}
