/**
 * `db.execute()` returns a plain array of rows on some drivers (postgres-js) and
 * a `{ rows }` wrapper on others (neon-http). Normalise to an array.
 */
export function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}
