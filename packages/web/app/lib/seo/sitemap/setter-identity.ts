import 'server-only';
import { and, eq, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { sprayClimbVisibilityCondition, userActivityVisibilityCondition } from '@boardsesh/db/queries';
import { boardClimbs } from '@/app/lib/db/schema';

/**
 * The setter page's single visibility predicate over `board_climbs`, for a
 * setter name given as a value or as an SQL expression (the setters shard
 * passes its own column).
 *
 * The page's count, its list, its hero identity and the shard's identity clock
 * all read it, so the count that decides "does this page exist" and the list
 * that decides "what does it show" can never describe different sets of climbs
 * — a divergence that would render a 200 with an empty list, or 404 a setter
 * whose climbs are right there. `server-setter-data.test.ts` byte-compares the
 * two rendered WHERE clauses rather than trusting this comment.
 */
export function visibleSetterClimbsWhere(username: string | SQLWrapper): SQL | undefined {
  // `SQL | undefined` rather than a cast: drizzle types `and()` that way for the
  // zero-argument case, `.where()` accepts it, and asserting it away would only
  // silence the compiler about a shape it is describing correctly.
  return and(eq(boardClimbs.setterUsername, username), ...visibleClimbConditions());
}

/**
 * The setter page's visibility rule for one climb, whatever its setter name.
 *
 * `is_hidden` belongs here because this is an indexable page publishing
 * crawlable links, and a climb the community voted out of browse must not come
 * back through a setter's front door — nor count towards the number that
 * decides the page exists at all. The setter's own "My climbs" list is the
 * surface that deliberately keeps showing it.
 *
 * No account privacy, item audience or follow relation: a published, listed
 * climb is public to everyone, so a private account's published climbs list
 * here too. Whether the hero names the account behind them is
 * `setterIdentityCandidates`'s rule. The spray predicate is the wall's own
 * rule, not the climb's.
 */
function visibleClimbConditions(): SQL[] {
  return [
    eq(boardClimbs.isListed, true),
    sprayClimbVisibilityCondition({ boardType: boardClimbs.boardType, layoutId: boardClimbs.layoutId }, null),
    eq(boardClimbs.isDraft, false),
    eq(boardClimbs.isHidden, false),
  ];
}

/**
 * The accounts the setter page may name for a setter name, one row per
 * candidate (`user_id`, `source_rank`, `climb_count`), for a FROM clause.
 *
 * Rank 0 is the account that set the page's own visible climbs
 * (`board_climbs.user_id`): who set a published, listed climb is public with it,
 * a private account included, and a MoonBoard or other Boardsesh climb has no
 * linked login to find it by. Rank 1 is a Kilter or Tension login linked under
 * the name (`user_board_mappings`) on a board type the page lists climbs for.
 * That login is on no climb, so a private account's stays private: the page has
 * no viewer, so only public accounts pass.
 *
 * The hero (`fetchSetterIdentity`) renders the first candidate in
 * {@link SETTER_IDENTITY_ORDER}. The setters shard dates `<lastmod>` from the
 * same account, picked for every name at once by
 * {@link authoredAccountPerSetterName} and {@link linkedLoginCandidates}, so the
 * clock always describes the identity the page renders.
 * A user linked on several boards appears once per mapping; those rows share
 * the user, so the order can leave them tied without changing the answer.
 */
export function setterIdentityCandidates(username: string | SQLWrapper): SQL {
  return sql`
    SELECT board_climbs.user_id, 0 AS source_rank, count(*) AS climb_count
    FROM board_climbs
    WHERE ${visibleSetterClimbsWhere(username)} AND board_climbs.user_id IS NOT NULL
    GROUP BY board_climbs.user_id
    UNION ALL
    ${linkedLoginCandidates(username)}
  `;
}

/**
 * Rank 1 of {@link setterIdentityCandidates}: a public account's Kilter or
 * Tension login linked under the name, on a board type the page lists climbs
 * for. One row per mapping. Cheap per name: it starts from the mapping's
 * `board_username` index and checks one board type's climbs.
 */
export function linkedLoginCandidates(username: string | SQLWrapper): SQL {
  return sql`
    SELECT ubm.user_id, 1 AS source_rank, 0 AS climb_count
    FROM user_board_mappings ubm
    WHERE ubm.board_username = ${username}
      AND EXISTS (
        SELECT 1 FROM board_climbs
        WHERE ${visibleSetterClimbsWhere(username)} AND board_climbs.board_type = ubm.board_type
      )
      AND ${userActivityVisibilityCondition(sql`ubm.user_id`, null)}
  `;
}

/**
 * Rank 0 of {@link setterIdentityCandidates} for EVERY setter name at once:
 * one row per name (`setter_username`, `user_id`), the account the page would
 * name from its own climbs, picked by the same order (most climbs, then an
 * account with a profile, then id).
 *
 * For the setters shard, which needs it for ~31k names. Asking per name would
 * walk the partial `user_id` index once per name, which grows with the number
 * of Boardsesh-authored climbs; this walks it once. Use it as a MATERIALIZED
 * CTE and join it on the name. No join to `users`: `board_climbs.user_id` is a
 * foreign key to it (`ON DELETE SET NULL`), so every id here has its row.
 */
export function authoredAccountPerSetterName(): SQL {
  return sql`
    SELECT DISTINCT ON (authored.setter_username) authored.setter_username, authored.user_id
    FROM (
      SELECT board_climbs.setter_username, board_climbs.user_id, count(*) AS climb_count
      FROM board_climbs
      WHERE ${and(...visibleClimbConditions())} AND board_climbs.user_id IS NOT NULL
      GROUP BY board_climbs.setter_username, board_climbs.user_id
    ) AS authored
    LEFT JOIN user_profiles authored_profile ON authored_profile.user_id = authored.user_id
    ORDER BY authored.setter_username, authored.climb_count DESC, authored_profile.user_id IS NULL, authored.user_id
  `;
}

/**
 * The order the first candidate is taken in, over `candidate` (from
 * {@link setterIdentityCandidates}) joined to `user_profiles p`. The setter's
 * own climbs first (most climbs, then id), then a linked login (an account with
 * a profile first, then id). The unique index on `user_board_mappings` is
 * `(user_id, board_type)`, so two users can carry one setter name; a bare
 * `LIMIT 1` would render whichever the planner reached.
 */
export const SETTER_IDENTITY_ORDER = sql`candidate.source_rank, candidate.climb_count DESC, p.user_id IS NULL, candidate.user_id`;
