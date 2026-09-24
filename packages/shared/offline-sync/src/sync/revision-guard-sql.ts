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
 * `>=`, not `>`: the incoming row usually carries the SAME revision the stream
 * did, and it still has to land, because it is what fills the columns the
 * stream deliberately never writes (`updated_at` — the pull cursor — plus
 * `benchmark_difficulty` and the `fa_*` pair).
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

  const primaryKeyColumns = config.primaryKeyColumns;
  if (!primaryKeyColumns.every((column) => options.columns.includes(column))) return null;
  if (!options.columns.includes(revisionColumn)) return null;

  const updatedColumns = options.columns.filter((column) => !primaryKeyColumns.includes(column));
  if (updatedColumns.length === 0) return null;

  const assignments = updatedColumns.map((column) => `${column} = excluded.${column}`).join(', ');
  return (
    `ON CONFLICT(${primaryKeyColumns.join(', ')}) DO UPDATE SET ${assignments} ` +
    `WHERE excluded.${revisionColumn} >= COALESCE(${options.conflictReference}.${revisionColumn}, -1)`
  );
}
