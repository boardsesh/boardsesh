/**
 * Where a climb came from. Since #6339 that is not the same question as who
 * owns it.
 *
 * `user_id` is the climb's owner for visibility: a draft or an unlisted climb
 * goes to its owner alone (`publicReferenceClimbSql`). Most owned climbs were
 * set in Boardsesh, but a manufacturer climb can have an owner too: the
 * linked-account draft import stamps the account it runs for, and the owner
 * backfill (`climb-owner-backfill.ts`) assigns older drafts and unlisted climbs
 * to the one account that links their setter. Such a climb is still the
 * manufacturer's. Its first ascent, quality and grade come from upstream, and a
 * Boardsesh tick must never replace them.
 *
 * So a check that asks "did Boardsesh set this climb" must not read `user_id`
 * alone. These predicates answer it from the provenance columns:
 *
 *  - `synced`: every manufacturer import writes `true`. Boardsesh writes `false`
 *    on every climb it mints, except on Woods, which has no manufacturer to push
 *    to and writes `true` (`saveClimb`). Nothing flips it afterwards.
 *  - `setter_id`: the manufacturer account that set the climb. Every Boardsesh
 *    mint path writes NULL. The draft import writes the linked manufacturer
 *    account, and the owner backfill only assigns a climb through its
 *    `setter_id`, so both kinds of owned manufacturer climb carry one.
 *  - `is_boardsesh_authored`: stamped when the account that set a Boardsesh
 *    climb is deleted and `user_id` goes NULL.
 *
 * A manufacturer climb is `synced AND setter_id IS NOT NULL`. Either column on
 * its own misreads somebody: `synced` alone calls a Woods climb set in Boardsesh
 * a manufacturer climb, and `setter_id` alone calls a climb Boardsesh saved for
 * a linked account before pushing it upstream (`synced = false` with that
 * account's setter id) one. Every column here is NOT NULL or tested with
 * `IS NOT NULL`, so each predicate is two-valued and its negation is exact.
 *
 * The predicates are raw text, like `publicReferenceClimbSql`, because they go
 * into raw select lists and correlated subqueries. Wrap them in `sql.raw` for a
 * drizzle query. `climbAlias` names the `board_climbs` row; it is checked to be
 * a plain identifier so no caller can interpolate anything else.
 */

const SAFE_CLIMB_ALIAS = /^[a-z_][a-z0-9_]*$/;

function climbAlias(alias: string): string {
  if (!SAFE_CLIMB_ALIAS.test(alias)) {
    throw new Error(`Refusing to build a climb provenance predicate with the alias: ${alias}`);
  }
  return alias;
}

/** The climb came from a manufacturer catalogue, whoever owns it now. */
export function manufacturerClimbSql(alias: string): string {
  const climb = climbAlias(alias);
  return `(${climb}.synced AND ${climb}.setter_id IS NOT NULL)`;
}

/**
 * The climb was set in Boardsesh, by an account that still exists. Its first
 * ascent, quality and grade are Boardsesh's to derive from ticks: there is no
 * manufacturer behind it. A climb whose account was deleted no longer matches
 * (its `user_id` is NULL); see {@link boardseshAuthoredClimbSql}.
 */
export function boardseshSetClimbSql(alias: string): string {
  const climb = climbAlias(alias);
  return `(${climb}.user_id IS NOT NULL AND NOT ${manufacturerClimbSql(climb)})`;
}

/**
 * The climb has, or once had, a Boardsesh author: set in Boardsesh by an
 * account that still exists, or by one that was deleted. Its stored first
 * ascent was derived from a Boardsesh tick, never supplied by a manufacturer.
 */
export function boardseshAuthoredClimbSql(alias: string): string {
  const climb = climbAlias(alias);
  return `(${climb}.is_boardsesh_authored OR ${boardseshSetClimbSql(climb)})`;
}
