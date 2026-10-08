import { sql, type SQL } from 'drizzle-orm';

/** The board alias is `ub` at every spray read. Explicit resource settings
 * replace legacy gym access, and revocation applies even to existing viewers. */
function sprayResourceVisibility(viewer: string | null, wallUuid?: string | null): SQL {
  const capability = wallUuid == null ? sql`false` : sql`ub.uuid = ${wallUuid}::text`;
  return sql`(
    ub.owner_id = ${viewer}::text OR (
      NOT EXISTS (SELECT 1 FROM resource_grants revoked
        WHERE revoked.kind = 'board' AND revoked.resource_id = ub.uuid
          AND revoked.user_id = ${viewer}::text AND revoked.status = 'revoked')
      AND (
        EXISTS (SELECT 1 FROM resource_privacy privacy
          WHERE privacy.kind = 'board' AND privacy.resource_id = ub.uuid AND (
            privacy.audience = 'public'
            OR (privacy.audience = 'unlisted' AND ${capability})
            OR (privacy.audience <> 'only_me' AND (
              EXISTS (SELECT 1 FROM resource_grants granted
                WHERE granted.kind = 'board' AND granted.resource_id = ub.uuid
                  AND granted.user_id = ${viewer}::text AND granted.status = 'approved')
              OR ((privacy.audience = 'followers' OR privacy.inherit_followers)
                AND EXISTS (SELECT 1 FROM user_follows followed
                  WHERE followed.follower_id = ${viewer}::text AND followed.following_id = ub.owner_id))
            ))
          ))
        OR (NOT EXISTS (SELECT 1 FROM resource_privacy privacy
              WHERE privacy.kind = 'board' AND privacy.resource_id = ub.uuid)
          AND ((ub.is_public AND NOT ub.is_unlisted)
            OR (ub.is_unlisted AND ${capability})
            OR EXISTS (SELECT 1 FROM gym_members gm
              WHERE gm.gym_id = ub.gym_id AND gm.user_id = ${viewer}::text)))
      )
    )
  )`;
}

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
 * On top of that, a wall an admin has HIDDEN (`spray_walls.hidden_at`, SW-17)
 * reads exactly like a private one to everybody but its owner: the owner keeps
 * seeing their wall and its climbs, and every other reader — gym member and
 * anonymous alike — gets the same empty answer a never-public wall gives. Folded
 * in here rather than at the ~15 call sites for the same reason the rest of the
 * rule is: they do not share a query builder.
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
 * may see by layout id. An optional wall UUID grants the existing unlisted
 * capability; callers without that capability retain the by-layout rule.
 *
 * Pass `userId` as null for an anonymous reader — then only public walls pass
 * unless the caller explicitly supplies an unlisted wall capability.
 * Anything the caller can reach without signing in has to pass null, not a
 * hopeful value.
 */
export function sprayClimbVisibilityCondition(
  columns: SprayVisibilityColumns,
  userId: string | null | undefined,
  wallUuid?: string | null,
): SQL {
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
        AND (sw.hidden_at IS NULL OR (${viewer}::text IS NOT NULL AND ub.owner_id = ${viewer}::text))
        AND ${sprayResourceVisibility(viewer, wallUuid)}
    )
  )`;
}

/**
 * The same rule for a query that reaches a climb only through a REFERENCE to it —
 * a tick, a favourite — and never joins `board_climbs` at all.
 *
 * The smart-playlist reference queries select from `boardsesh_ticks` /
 * `user_favorites` and paginate there, so the climb is one join away and the
 * column form cannot be used. Phrased as "there is no INVISIBLE spray climb behind
 * this reference" rather than "there is a visible climb", so a reference whose
 * climb row is missing survives — the same NULL-safety the column form needs, for
 * the same reason.
 */
export function sprayReferenceVisibilityCondition(
  columns: { boardType: SQL | unknown; climbUuid: SQL | unknown },
  userId: string | null | undefined,
): SQL {
  const viewer = userId ?? null;
  return sql`NOT EXISTS (
    SELECT 1
    FROM board_climbs ref_climb
    WHERE ref_climb.uuid = ${columns.climbUuid}
      AND ref_climb.board_type = ${columns.boardType}
      AND ref_climb.board_type = 'spray'
      AND NOT EXISTS (
        SELECT 1
        FROM spray_walls sw
        JOIN user_boards ub ON ub.uuid = sw.board_uuid
        WHERE sw.layout_id = ref_climb.layout_id
          AND sw.deleted_at IS NULL
          AND ub.deleted_at IS NULL
          AND (sw.hidden_at IS NULL OR (${viewer}::text IS NOT NULL AND ub.owner_id = ${viewer}::text))
          AND ${sprayResourceVisibility(viewer)}
      )
  )`;
}

/**
 * The fail-closed half the reference form leaves open: `true` for every
 * non-spray reference, and for a spray reference whose `board_climbs` row still
 * exists.
 *
 * {@link sprayReferenceVisibilityCondition} passes a reference whose climb row
 * is missing, for every viewer. That is right for an Aurora tick, which can
 * arrive before its climb. It is wrong for spray: a wall delete is soft and
 * keeps its climbs, but `deleteDraftClimb` and account deletion hard-delete a
 * climb row and leave the ticks and proposals that named it. With the climb
 * gone there is no layout id, so no wall to check, and the reference would
 * reach everybody. AND this next to the reference form; it does not replace it.
 *
 * Needs a board type ON the referencing row (a tick, a proposal). A comment has
 * none, so `globalCommentFeed` carries its own rule.
 *
 * `authorExemption` keeps the row for the person who wrote it: their own log on
 * a climb they deleted is theirs to see, and a profile total that dropped it
 * would disagree with their own logbook. Pass the referencing row's author
 * column and the viewer (null for an anonymous caller, never a hopeful id).
 * Leave it out for a reader that lists OTHER people's rows, like the per-climb
 * logs, where nobody is exempt.
 */
export function sprayReferenceClimbExistsCondition(
  columns: { boardType: SQL | unknown; climbUuid: SQL | unknown },
  authorExemption?: { authorId: SQL | unknown; viewerUserId: string | null | undefined },
): SQL {
  const viewer = authorExemption?.viewerUserId ?? null;
  const ownRow = authorExemption
    ? sql`OR (${viewer}::text IS NOT NULL AND ${authorExemption.authorId} = ${viewer}::text)`
    : sql``;
  return sql`(
    ${columns.boardType} IS DISTINCT FROM 'spray'
    OR EXISTS (
      SELECT 1
      FROM board_climbs existing_climb
      WHERE existing_climb.uuid = ${columns.climbUuid}
        AND existing_climb.board_type = 'spray'
    )
    ${ownRow}
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
      AND (sw.hidden_at IS NULL OR (${viewer}::text IS NOT NULL AND ub.owner_id = ${viewer}::text))
      AND ${sprayResourceVisibility(viewer)}
  ) AS visible`;
}
