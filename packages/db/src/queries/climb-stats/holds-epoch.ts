import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';

/**
 * "This tick was logged on the holds the climb has now" (#6023).
 *
 * Read-only since climb revision history was retired: `updateClimb` no longer
 * moves `holds_revision_number`, so the epoch is frozen. It is still read here
 * because it stays correct for the few climbs edited before the retirement, and
 * is a no-op (epoch 1) for every other climb.
 *
 * A published climb can be edited. `board_climbs.holds_revision_number` is the
 * climb's holds epoch: the revision at which its frames or frame count last
 * changed. `boardsesh_ticks.climb_revision` is the revision a tick was logged
 * on. A tick is on the current holds when its revision is at or above the epoch.
 *
 * What follows the rule: a climb's ascensionist count, first ascent and stars
 * (`recompute.ts`), and every per-climb "has this climber sent / tried / rated
 * it" check (search filters, recommendations, the Projects playlist, a wall's
 * recent senders). What does not: the tick-derived grade, and anything that
 * counts what a CLIMBER has done (profile totals, leaderboards, session
 * summaries, logbook lists). A send of an older version is still a send by that
 * climber.
 *
 * The NULL rule: a tick with no revision counts as revision 1. NULL is every
 * imported tick and every tick older than the column. For the old ticks that is
 * exact: revisions did not exist before the column did. For an import it is a
 * choice. An Aurora or Kilter logbook entry that arrives after the holds of a
 * Boardsesh-owned catalogue climb moved may have been climbed on the new holds,
 * and it still reads as revision 1, so that climber's "sent" mark and first
 * ascent on the climb stay off until they log it in Boardsesh. That is accepted:
 * an import never adds to the Boardsesh ascensionist count anyway, the window is
 * the setter's 24 hours after publishing, and spray walls, where edits have no
 * limit, have no imports at all. A missing `board_climbs` row has epoch 1 (see
 * {@link holdsEpochOrFirstSql}).
 *
 * On a climb whose holds never moved the epoch is 1, so the predicate is true
 * for every tick and nothing changes. That is every catalogue climb outside its
 * setter's 24 hour edit window, and every existing row.
 *
 * This file is the only place the comparison is spelled out. Callers pass the
 * epoch as a column of a `board_climbs` row they have already joined or
 * correlated on its primary key, never as a lookup in `board_climb_revisions`:
 * these run once per tick, inside per-search-row subqueries.
 *
 * `tickClimbRevision` is the tick's `climb_revision` column, on whichever table
 * or alias the caller scans.
 */
export function tickOnCurrentHoldsSql(tickClimbRevision: SQLWrapper, holdsEpoch: SQLWrapper): SQL {
  return sql`${tickRevisionOrFirstSql(tickClimbRevision)} >= ${holdsEpoch}`;
}

/**
 * A tick's revision with the NULL rule applied. For a caller that aggregates
 * before it compares: `MAX(...)` of this over a climber's ticks on one climb,
 * then {@link latestTickOnCurrentHoldsSql} against the epoch. That costs one
 * `board_climbs` lookup per climb instead of one per tick.
 */
export function tickRevisionOrFirstSql(tickClimbRevision: SQLWrapper): SQL {
  return sql`COALESCE(${tickClimbRevision}, 1)`;
}

/** {@link tickRevisionOrFirstSql} for a raw-SQL query that names its tick table by alias. */
export function tickAliasRevisionOrFirstSql(tickAlias: TickTableAlias): SQL {
  return tickRevisionOrFirstSql(sql.raw(`${tickAlias}.climb_revision`));
}

/**
 * "At least one of these ticks is on the current holds", given the highest
 * {@link tickRevisionOrFirstSql} among them. Equivalent to
 * {@link tickOnCurrentHoldsSql} holding for some tick of the group. NULL, no
 * tick in the group at all, is false.
 */
export function latestTickOnCurrentHoldsSql(latestTickRevision: SQLWrapper, holdsEpoch: SQLWrapper): SQL {
  return sql`COALESCE(${latestTickRevision}, 0) >= ${holdsEpoch}`;
}

/**
 * The `boardsesh_ticks` aliases raw SQL callers use. A literal union, so
 * `sql.raw` below can never be handed a runtime string (the same fence as
 * `StatsTableAlias` in real-catalog-data.ts). Adding an alias is a one-line edit
 * here.
 */
export type TickTableAlias = 'bt' | 'bt_u' | 'bt2' | 't' | 'rating_below';

/** {@link tickOnCurrentHoldsSql} for a raw-SQL query that names its tick table by alias. */
export function tickAliasOnCurrentHoldsSql(tickAlias: TickTableAlias, holdsEpoch: SQLWrapper): SQL {
  return sql`${tickAliasRevisionOrFirstSql(tickAlias)} >= ${holdsEpoch}`;
}

/**
 * "An edit has moved this climb's holds at least once": the predicate of the
 * partial index `board_climbs_holds_moved_idx` (migration 0253), which holds
 * `(board_type, uuid, holds_revision_number)` for exactly these climbs.
 *
 * For a read that needs the epoch of every climb in a climber's logbook. Almost
 * all of those climbs are at epoch 1, where every tick counts, so the read joins
 * the logbook against this small set instead of probing `board_climbs` once per
 * climb: a query that repeats this predicate on its `board_climbs` reference can
 * be answered from the index alone. A climb that is not in the set gets epoch 1
 * from {@link holdsEpochOrFirstSql}, which is the same answer its row would give.
 *
 * Not for a query that already has the climb's row (search, the recompute):
 * there the epoch is a column it has read anyway.
 */
export function climbHoldsEverMovedSql(holdsRevisionNumber: SQLWrapper): SQL {
  return sql`${holdsRevisionNumber} > 1`;
}

/**
 * The holds epoch of a climb that may have no `board_climbs` row, or whose row
 * was left out by {@link climbHoldsEverMovedSql}: the result of
 * a LEFT JOIN or a scalar subquery on the primary key. No row means epoch 1.
 * A tick can carry any string as its climb uuid, so the row is not guaranteed.
 */
export function holdsEpochOrFirstSql(holdsRevisionNumber: SQLWrapper): SQL {
  return sql`COALESCE(${holdsRevisionNumber}, 1)`;
}
