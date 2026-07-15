// The SQL primitives that express "which board_climbs rows belong to a board
// scope". Shared by the snapshot bootstrap (which imports a scope's rows) and the
// scope teardown (which removes rows no scope wants any more).
//
// These live in one module on purpose. Both callers must mirror the sync
// resolvers' scope filter (packages/backend/.../sync/queries.ts) exactly, and two
// drifting copies of that mirror is precisely how a teardown deletes rows a
// still-enabled board needs.

import type { OfflineBoardScope } from '../offline-board-key';

// A scope filter's binds are only ever board types, layout ids, and size ids — never
// null — so this stays narrower than SqlValue. It's assignable to SqlValue[] at every
// runAsync call site, and it keeps callers that need `(string | number)[]` (the
// bootstrap's watermark helpers) working without a cast.
type ScopeBind = string | number;

/**
 * Mirror of `@boardsesh/board-config`'s `isSizeScopedBoard`, inlined so this
 * zero-runtime-dependency package stays free of the board-config → board-constants
 * → shared-schema chain. MoonBoard has one fixed size, so its climbs are never
 * size-filtered; every other board scopes by `compatible_size_ids`. This one fact
 * must track the resolver's `isSizeScopedBoard` guard
 * (queries.ts:boardClimbsLayoutSizeConditions) exactly.
 */
export function isSizeScopedBoard(boardType: string): boolean {
  return boardType !== 'moonboard';
}

/**
 * `compatible_size_ids` containment against a SET of sizes. SQLite has no `@>`, so
 * containment is `json_each` membership; a NULL `compatible_size_ids` is excluded
 * exactly as Postgres `NULL @> ARRAY[x]` is (queries.ts:173-175).
 *
 * Returns null for an empty set: `value IN ()` is not valid SQLite, so callers MUST
 * branch on null rather than template an empty placeholder list. The two callers
 * want opposite things from that case (bootstrap can't reach it; teardown treats it
 * as "nothing is retained, take the whole layout"), which is exactly why this
 * returns null instead of picking a default for them.
 */
export function sizeMembershipClause(
  qualifier: string,
  sizeIds: readonly number[],
): { sql: string; params: ScopeBind[] } | null {
  if (sizeIds.length === 0) return null;
  const placeholders = sizeIds.map(() => '?').join(', ');
  return {
    sql:
      `${qualifier}compatible_size_ids IS NOT NULL AND EXISTS (` +
      `SELECT 1 FROM json_each(${qualifier}compatible_size_ids) WHERE value IN (${placeholders}))`,
    params: [...sizeIds],
  };
}

/**
 * The board_climbs filter for ONE scope, mirroring `syncClimbs`' `boardClimbsScope`
 * (queries.ts:183-188): `board_type = ? AND layout_id = ?`, plus — only for
 * size-scoped boards — a `compatible_size_ids` containment check. Unqualified column
 * names resolve against the single FROM table. Params returned alongside.
 */
export function climbsScopeFilter(scope: OfflineBoardScope, qualifier = ''): { sql: string; params: ScopeBind[] } {
  const params: ScopeBind[] = [scope.boardType, scope.layoutId];
  let sql = `${qualifier}board_type = ? AND ${qualifier}layout_id = ?`;
  if (isSizeScopedBoard(scope.boardType)) {
    const membership = sizeMembershipClause(qualifier, [scope.sizeId]);
    if (membership) {
      sql += ` AND ${membership.sql}`;
      params.push(...membership.params);
    }
  }
  return { sql, params };
}
