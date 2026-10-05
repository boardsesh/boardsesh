import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';

/**
 * "This tick was logged on the holds the climb has now" (#6023).
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
 * imported tick and every tick older than the column, and all of those were
 * logged on a climb nobody had edited yet, because revisions did not exist
 * before the column did. A missing `board_climbs` row has epoch 1 for the same
 * reason (see {@link holdsEpochOrFirstSql}).
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
  return sql`COALESCE(${tickClimbRevision}, 1) >= ${holdsEpoch}`;
}

/**
 * The `boardsesh_ticks` aliases raw SQL callers use. A literal union, so
 * `sql.raw` below can never be handed a runtime string (the same fence as
 * `StatsTableAlias` in real-catalog-data.ts). Adding an alias is a one-line edit
 * here.
 */
export type TickTableAlias = 'bt' | 'bt_u' | 'bt2' | 't' | 'sent' | 'rating_below' | 'rating_newer';

/** {@link tickOnCurrentHoldsSql} for a raw-SQL query that names its tick table by alias. */
export function tickAliasOnCurrentHoldsSql(tickAlias: TickTableAlias, holdsEpoch: SQLWrapper): SQL {
  return tickOnCurrentHoldsSql(sql.raw(`${tickAlias}.climb_revision`), holdsEpoch);
}

/**
 * The holds epoch of a climb that may have no `board_climbs` row: the result of
 * a LEFT JOIN or a scalar subquery on the primary key. No row means epoch 1.
 * A tick can carry any string as its climb uuid, so the row is not guaranteed.
 */
export function holdsEpochOrFirstSql(holdsRevisionNumber: SQLWrapper): SQL {
  return sql`COALESCE(${holdsRevisionNumber}, 1)`;
}
