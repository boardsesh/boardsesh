import { TABLE_CONFIGS } from './table-config';

/**
 * The upsert tail that stops a slower writer from walking a newer local row
 * backwards, derived from `TABLE_CONFIGS` rather than spelled out at each call
 * site.
 *
 * Only `board_climb_stats` has a `revisionColumn` today, because it is the only
 * synced table with a second local writer (the live `climbStatsUpdated`
 * write-through, #5227). Both of the writers that can lose that race — the pull
 * page insert and the snapshot import — build their tail here, so the primary
 * key, the revision column and the `>=` can only be changed in one place.
 *
 * The cursor timestamp and revision form the same keyset pair the pull uses to
 * order rows. `>=`, not `>`: the incoming row usually carries the SAME revision
 * the stream did, and it still has to land, because it fills columns the stream
 * deliberately never writes (`updated_at`, `benchmark_difficulty`, and `fa_*`).
 *
 * Returns null when the table is unguarded, when the statement does not carry
 * the revision column (nothing to compare), when it does not carry the whole
 * primary key (no conflict target), or when it carries nothing else (nothing to
 * update). Callers then emit their existing unconditional form, so the guard
 * can never turn a working statement into invalid SQL.
 */
export function buildRevisionGuardTail(options: {
  /** The `TABLE_CONFIGS` key the guard is read from. */
  tableName: string;
  /**
   * How the table is named INSIDE the statement's WHERE clause. The pull writes
   * to a bare `board_climb_stats`; the snapshot import writes to
   * `main.board_climb_stats` but must still reference it unqualified here,
   * because SQLite resolves the upsert's target by its bare name.
   */
  conflictReference: string;
  /** The columns this statement actually inserts. */
  columns: readonly string[];
}): string | null {
  const config = TABLE_CONFIGS[options.tableName];
  const revisionColumn = config?.revisionColumn;
  if (!config || !revisionColumn) return null;
  const cursorColumn = config.cursorColumn;

  const primaryKeyColumns = config.primaryKeyColumns;
  if (!primaryKeyColumns.every((column) => options.columns.includes(column))) return null;
  if (!options.columns.includes(cursorColumn) || !options.columns.includes(revisionColumn)) return null;

  const updatedColumns = options.columns.filter((column) => !primaryKeyColumns.includes(column));
  if (updatedColumns.length === 0) return null;

  const assignments = updatedColumns.map((column) => `${column} = excluded.${column}`).join(', ');
  // ISO timestamps can differ in fractional-width when PostgreSQL omits trailing
  // zeros. Normalize before comparing so lexical order matches timestamp order.
  const timestampKey = (column: string) =>
    `(substr(${column}, 1, 19) || '.' || CASE WHEN substr(${column}, 20, 1) = '.'
      THEN substr(substr(${column}, 21, length(${column}) - 21) || '000000', 1, 6)
      ELSE '000000' END)`;
  return (
    `ON CONFLICT(${primaryKeyColumns.join(', ')}) DO UPDATE SET ${assignments} ` +
    `WHERE ${options.conflictReference}.${cursorColumn} IS NULL ` +
    `OR (${timestampKey(`excluded.${cursorColumn}`)}, excluded.${revisionColumn}) ` +
    `>= (${timestampKey(`${options.conflictReference}.${cursorColumn}`)}, ` +
    `COALESCE(${options.conflictReference}.${revisionColumn}, -1))`
  );
}
