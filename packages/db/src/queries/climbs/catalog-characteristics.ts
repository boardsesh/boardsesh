import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';

/** Refresh only the rule tokens owned by an upstream catalog. */
export function mergeCatalogCharacteristicsSql(
  current: SQLWrapper,
  incoming: SQLWrapper,
  managedTokens: readonly string[],
  keepEmpty = false,
): SQL {
  let retained: SQL = sql`coalesce(${current}, '{}'::text[])`;
  for (const token of managedTokens) retained = sql`array_remove(${retained}, ${token})`;
  const merged = sql`${retained} || coalesce(${incoming}, '{}'::text[])`;
  return keepEmpty ? merged : sql`nullif(${merged}, '{}'::text[])`;
}
