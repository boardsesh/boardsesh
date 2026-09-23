import type { OfflineDatabase } from '@boardsesh/offline-sync';
import type { SetterStat, SetterStatsInput } from '@boardsesh/shared-schema';
import { isSizeScopedBoard } from '@boardsesh/board-config';
import { isBrowsedAngleRestricted, parseSetIds } from './search-climbs-local';
import { followedAuthorsLocalCondition } from './followed-authors-local';

/**
 * On-device twin of `getSetterStats` (packages/db/src/queries/climbs/setter-stats.ts):
 * who set on this board configuration, so the setter picker can open without the
 * network. Mirrors that query's predicates exactly, translated to the local dialect
 * the same way `buildJoinAndWhere` in `search-climbs-local.ts` already does for array
 * containment (JSON-in-TEXT columns via `json_each`, since the pull client stores
 * `required_set_ids`/`compatible_size_ids` as JSON text rather than native arrays).
 *
 * Angle follows the server's rule, which is the climb list's rule. On every board
 * whose climbs are not angle-bound it is angle-blind (per #5404/#5406): `input.angle`
 * is never referenced and nothing joins `board_climb_stats`, because setter-list
 * membership doesn't depend on angle there. On Woods without `input.crossAngleStats`
 * it counts only the climbs the list shows at `input.angle` (#5642) — set there,
 * with no set angle recorded, or with a stats row there — through the same
 * `isBrowsedAngleRestricted` decision and the same three arms `buildJoinAndWhere`
 * applies to the list, so a downloaded Woods board offers the same setters, with
 * the same counts, as the network does. Not user-scoped either — this is a public
 * aggregate over board reference data, so none of the auth-scoping contract
 * (docs/offline-reads.md) applies.
 */
type Bind = string | number;

type SetterStatRow = { setter_username: string; climb_count: number };

export async function getSetterStatsLocal(db: OfflineDatabase, input: SetterStatsInput): Promise<SetterStat[]> {
  const boardType = input.boardName;
  const isMoonboard = boardType === 'moonboard';
  const setIds = parseSetIds(input.setIds);
  // No `name`: `input.search` narrows setter_username and is never a climb-name
  // search, so it must not trigger the by-name cross-angle exception. Mirrors the
  // server's `resolveBrowsedAngleRestriction(params, { crossAngleStats })`.
  const restrictToBrowsedAngle = isBrowsedAngleRestricted({
    boardName: input.boardName,
    crossAngleStats: input.crossAngleStats,
  });

  const conditions: string[] = [];
  const binds: Bind[] = [];
  const push = (clause: string, ...clauseBinds: Bind[]) => {
    conditions.push(clause);
    binds.push(...clauseBinds);
  };

  push('c.board_type = ?', boardType);
  if (input.onlyFollowedAuthors) {
    const followedCondition = await followedAuthorsLocalCondition(db);
    push(followedCondition.sql, ...followedCondition.binds);
  }
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

  // The browsed-angle restriction, arm for arm the clause `buildJoinAndWhere` in
  // search-climbs-local.ts pushes and `browsedAngleRestrictionSql` renders on the
  // server. `s` is the browsed-angle stats join below; its climb_uuid is part of
  // the stats primary key, so NULL means exactly "no row at this angle".
  if (restrictToBrowsedAngle) {
    push('(c.angle = ? OR c.angle IS NULL OR s.climb_uuid IS NOT NULL)', input.angle);
  }

  // Case-insensitive substring filter (autocomplete), mirroring the server's
  // `ilike(setterUsername, '%term%')` byte for byte — including its unescaped
  // `%`/`_` wildcards. This local branch serves while online too (a downloaded
  // board is local-first), so escaping here the way search-climbs-local.ts
  // escapes its `name` filter would make a search containing `%`/`_` return
  // different setters depending only on whether the board happens to be
  // downloaded. SQLite LIKE is ASCII case-insensitive by default, same as the
  // name-filter caveat in search-climbs-local.ts.
  const search = input.search?.trim();
  if (search) {
    push('c.setter_username LIKE ?', `%${search}%`);
  }

  // Joined only when the restriction probes it, so the unrestricted statement stays
  // the join-free one. (climb_uuid, board_type, angle) is the stats primary key: at
  // most one row per climb joins, so COUNT(*) still counts climbs. Its binds come
  // first because the JOIN precedes the WHERE in the statement.
  const joinSql = restrictToBrowsedAngle
    ? `LEFT JOIN board_climb_stats s
    ON s.climb_uuid = c.uuid AND s.board_type = ? AND s.angle = ?`
    : '';
  const joinBinds: Bind[] = restrictToBrowsedAngle ? [boardType, input.angle] : [];

  const query = `
    SELECT c.setter_username AS setter_username, COUNT(*) AS climb_count
    FROM board_climbs c
    ${joinSql}
    WHERE ${conditions.join(' AND ')}
    GROUP BY c.setter_username
    ORDER BY climb_count DESC, c.setter_username ASC
    LIMIT 50
  `;

  const rows = await db.getAllAsync<SetterStatRow>(query, [...joinBinds, ...binds]);
  return rows.map((row) => ({ setterUsername: row.setter_username, climbCount: row.climb_count }));
}
