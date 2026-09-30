import { getTableColumns, getTableName, sql, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';

/** One ON CONFLICT DO UPDATE assignment: the column and the value the SET would give it. */
export type ConflictSetEntry = { column: PgColumn; value: SQL };

/**
 * `(stored, …) IS DISTINCT FROM (incoming, …)` over every assignment, for an
 * `ON CONFLICT … DO UPDATE … WHERE`. True exactly when the UPDATE would change
 * at least one column, so a caller that ANDs nothing else in skips rows whose
 * stored values already match.
 *
 * Build the SET and this guard from the SAME entries, so the guard cannot miss
 * a column the SET writes. Each value is the SET expression itself, so it may
 * read the stored row (COALESCE(excluded.x, stored.x) and the like): the
 * ON CONFLICT WHERE runs on the locked current row, the same row the SET reads.
 * IS DISTINCT FROM is NULL-safe, so NULL → NULL is "unchanged" and
 * value → NULL is a change.
 *
 * A column a caller deliberately rewrites anyway (a sync stamp) belongs outside
 * the entries, in the SET only.
 */
export function conflictSetChangesRowSql(entries: readonly ConflictSetEntry[]): SQL {
  const stored = sql.join(
    entries.map((entry) => sql`${entry.column}`),
    sql`, `,
  );
  const incoming = sql.join(
    entries.map((entry) => entry.value),
    sql`, `,
  );
  return sql`(${stored}) IS DISTINCT FROM (${incoming})`;
}

/**
 * Pair a drizzle `onConflictDoUpdate` `set` object (keyed by schema property)
 * with its columns, for {@link conflictSetChangesRowSql}. Throws on a key the
 * table does not have, so a typo cannot silently drop a column from the guard.
 */
export function conflictSetEntries(table: PgTable, set: Record<string, SQL>): ConflictSetEntry[] {
  const columns: Record<string, PgColumn> = getTableColumns(table);
  return Object.entries(set).map(([key, value]) => {
    const column = columns[key];
    if (!column) throw new Error(`conflictSetEntries: no column "${key}" on ${getTableName(table)}`);
    return { column, value };
  });
}
