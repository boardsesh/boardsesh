import { sql, type SQL } from 'drizzle-orm';

/**
 * The one predicate that keeps a private spray wall's climbs out of every read.
 *
 * ## Why a SQL fragment rather than a resolver check
 *
 * A spray climb is stored as an ordinary `board_climbs` row —
 * `board_type = 'spray'`, `is_listed = true`, `is_draft = false` — because that is
 * what makes queue, play, ticks, stats, playlists, search and the duplicate gate
 * work on a wall unchanged (`docs/spray-walls.md`). The cost of that decision is
 * that **every existing predicate in the codebase reads a spray climb as public**:
 * `is_listed` was the visibility rule for eight catalogue boards, and it is not the
 * visibility rule for a photograph of somebody's living room.
 *
 * Worse, a wall's `layout_id` comes out of `spray_wall_catalog_id_seq`, so it is 1,
 * 2, 3, … — guessable. Any read that accepts `boardType + layoutId` from a caller
 * is therefore an enumeration of every wall in the database unless it carries this
 * condition. There are around fifteen such reads (search, similar climbs, the new
 * climb feed, setter stats and profiles, user climbs, the ascents feeds, board
 * history, beta links, the comment feed, and the offline `syncClimbs` pull), and
 * they do NOT share a query builder — most hand-roll their own
 * `board_type`/`layout_id` WHERE and merely mirror each other in comments. So the
 * unit of reuse has to be the predicate itself, not a wrapper function.
 *
 * ## The rule
 *
 * It is the **by-layout** visibility rule, mirroring
 * `viewerCanSeeSprayWallByLayout` in
 * `packages/backend/src/graphql/resolvers/board/spray-walls.ts`: the wall's owner,
 * a member of the gym it is attached to, or a PUBLIC wall. `is_unlisted` is
 * deliberately NOT an exemption here — unlisted means "reachable by uuid", and a
 * layout id is not a uuid. Keep the two in step; if that resolver's rule changes,
 * this changes with it.
 *
 * ## Why it is shaped as "not spray, OR visible"
 *
 * ## `IS DISTINCT FROM`, not `<>`
 *
 * Several callers AND this onto a **LEFT-JOINed** `board_climbs`: a tick whose climb
 * row is missing is a case they deliberately support and render as "Unknown Climb".
 * With a plain `<>`, `NULL <> 'spray'` is NULL, the row is dropped, and
 * `sessionDetail` — which returns null when it finds no ticks — loses the whole
 * session. `IS DISTINCT FROM` is NULL-safe and answers true for a missing climb,
 * which is the honest reading: a row that is not a spray climb is not hidden by a
 * spray rule.
 *
 * ## Why it is shaped as "not spray, OR visible"
 *
 * So it can be dropped into a query that does not know, or does not constrain, the
 * board type — `userClimbs` and the ascents feeds span every board a climber has
 * touched. For those the condition is a no-op on the other eight board types and
 * self-scoping on spray, which means callers never need a board-type branch and
 * cannot forget one. The board-type test short-circuits before the subquery on
 * every non-spray row, so the cost on the hot Kilter path is one cheap comparison.
 */
export type SprayVisibilityColumns = {
  /**
   * SQL for the climb row's `board_type` column, qualified for the query it is
   * going into (e.g. `sql`c.board_type`` or drizzle's `boardClimbs.boardType`).
   */
  boardType: SQL | unknown;
  /** SQL for the climb row's `layout_id` column, qualified the same way. */
  layoutId: SQL | unknown;
};

/**
 * `true` for every non-spray climb, and for a spray climb whose wall the viewer
 * may see by layout id.
 *
 * Pass `userId` as null for an anonymous reader — then only public walls pass.
 * Anything the caller can reach without signing in has to pass null, not a
 * hopeful value.
 */
export function sprayClimbVisibilityCondition(columns: SprayVisibilityColumns, userId: string | null | undefined): SQL {
  const viewer = userId ?? null;
  return sql`(
    ${columns.boardType} IS DISTINCT FROM 'spray'
    OR EXISTS (
      SELECT 1
      FROM spray_walls sw
      JOIN user_boards ub ON ub.uuid = sw.board_uuid
      WHERE sw.layout_id = ${columns.layoutId}
        AND sw.deleted_at IS NULL
        AND ub.deleted_at IS NULL
        AND (
          ub.is_public
          OR (
            ${viewer}::text IS NOT NULL
            AND (
              ub.owner_id = ${viewer}::text
              OR EXISTS (
                SELECT 1 FROM gym_members gm
                WHERE gm.gym_id = ub.gym_id AND gm.user_id = ${viewer}::text
              )
            )
          )
        )
    )
  )`;
}

/**
 * The same rule for a query that has already narrowed to one board type and one
 * layout in JavaScript — the `boardType + layoutId` resolvers.
 *
 * Returns null when the board type is not spray, so a caller can spread it into a
 * condition list without a branch. `true`/`false` is decided in one round trip
 * rather than inlined into the main query, because these callers can then skip the
 * expensive query entirely and return an empty page — which is the required
 * behaviour: **not an error, and not a different shape**, so a private wall's
 * existence is not observable.
 */
export function sprayLayoutVisibilitySql(layoutId: number, userId: string | null | undefined): SQL {
  const viewer = userId ?? null;
  return sql`SELECT EXISTS (
    SELECT 1
    FROM spray_walls sw
    JOIN user_boards ub ON ub.uuid = sw.board_uuid
    WHERE sw.layout_id = ${layoutId}
      AND sw.deleted_at IS NULL
      AND ub.deleted_at IS NULL
      AND (
        ub.is_public
        OR (
          ${viewer}::text IS NOT NULL
          AND (
            ub.owner_id = ${viewer}::text
            OR EXISTS (
              SELECT 1 FROM gym_members gm
              WHERE gm.gym_id = ub.gym_id AND gm.user_id = ${viewer}::text
            )
          )
        )
      )
  ) AS visible`;
}
