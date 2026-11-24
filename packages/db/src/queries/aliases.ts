import { and, eq, sql, type SQLWrapper } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { boardClimbAliases } from '../schema/boards/unified';

// Match the type aurora-sync uses for its sync helpers. Any drizzle-orm
// PostgresJsDatabase (script + kilter-sync) and the PgTransaction handle
// (backend resolvers running inside db.transaction) satisfy this — they
// share the full PgDatabase surface, so we get real type checking on the
// query chain instead of the stub-friendly `(...args: unknown[]) => …`
// shape this file used to carry.
type DrizzleDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/**
 * Canonical UUID of an existing row as a public climb link resolves it. A
 * listed row wins even when a legacy alias still points elsewhere.
 */
export function listedClimbDestinationUuidSql(climb: {
  boardType: SQLWrapper;
  uuid: SQLWrapper;
  isListed: SQLWrapper;
}) {
  return sql<string>`CASE WHEN ${climb.isListed} IS TRUE THEN ${climb.uuid}
    ELSE COALESCE(
      (SELECT ${boardClimbAliases.canonicalUuid} FROM ${boardClimbAliases}
        WHERE ${boardClimbAliases.boardType} = ${climb.boardType}
          AND ${boardClimbAliases.aliasUuid} = ${climb.uuid}),
      ${climb.uuid}
    ) END`;
}

// Resolves a (possibly duplicate) climb UUID to its canonical UUID. Hit path
// is a primary-key lookup on (board_type, alias_uuid). Misses return the
// input UUID unchanged so callers can treat unknown climbs as
// self-canonical — kilter-sync inserts a self-alias on every canonical
// insert, so a long-lived miss usually means the climb predates the alias
// backfill or arrived from a non-Kilter source.
//
// Pass the optional `cache` to short-circuit repeated lookups inside a
// single sync cycle (the catalog sync calls this once per incoming row).
//
// Failure mode: a DB error during the underlying SELECT is propagated to
// the caller verbatim. We intentionally do not swallow-and-fallback to the
// input UUID because a silent fallback could mask a real connectivity
// problem and let a wave of tick writes land on duplicate-UUID rows.
export async function resolveCanonicalClimbUuid(
  db: DrizzleDb,
  boardType: string,
  uuid: string,
  cache?: Map<string, string>,
): Promise<string> {
  const cacheKey = `${boardType}:${uuid}`;
  const cached = cache?.get(cacheKey);
  if (cached !== undefined) return cached;

  const rows = await db
    .select({ canonicalUuid: boardClimbAliases.canonicalUuid })
    .from(boardClimbAliases)
    .where(and(eq(boardClimbAliases.boardType, boardType), eq(boardClimbAliases.aliasUuid, uuid)))
    .limit(1);

  const canonical = rows[0]?.canonicalUuid ?? uuid;
  cache?.set(cacheKey, canonical);
  return canonical;
}
