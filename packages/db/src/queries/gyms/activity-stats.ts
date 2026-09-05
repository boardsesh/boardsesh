import { sql, type SQLWrapper } from 'drizzle-orm';

/**
 * Rebuilds `gym_activity_stats` — "how many Boardsesh climbers actually use
 * this gym" — from `board_climb_events`.
 *
 * Wholesale rebuild rather than an upsert: a gym that goes quiet must lose its
 * numbers, and an `ON CONFLICT DO UPDATE` keyed on the rows the scan FOUND
 * leaves the ones it did not find frozen at their last busy value forever. The
 * delete and the insert share one transaction, so a reader never sees a gap.
 *
 * See the table doc in schema/app/gym-activity-stats.ts for why this reads
 * `board_climb_events` rather than `boardsesh_ticks`.
 */

/** The advisory-lock key for the rebuild. Transaction-scoped — see refreshGymActivityStats. */
export const GYM_ACTIVITY_REFRESH_LOCK_KEY = 0x67796d61; // 'gyma'

export type GymActivityRefreshSkipReason = 'locked' | 'empty' | 'shrank';

/**
 * The minimal database surface the rebuild needs: a single `execute` that runs a
 * Drizzle `sql` fragment. Deliberately shaped like `MergeExecuteDb` in
 * merge-gyms.ts — a `PromiseLike<unknown>` return, not a generic row type — so
 * the web client, a script client and a `PgTransaction` handle are all
 * structurally assignable. Typing the return as `T[]` looks tidier and is not
 * assignable from any of them.
 */
export type GymActivityStatsDb = {
  execute(query: SQLWrapper | string): PromiseLike<unknown>;
};

// `execute` is typed as returning `unknown` above so every Drizzle handle
// satisfies it; each caller knows the shape its own statement returns.
async function executeRowsAs<T>(db: GymActivityStatsDb, query: SQLWrapper): Promise<T[]> {
  const result = await db.execute(query);
  return (Array.isArray(result) ? result : []) as T[];
}

/**
 * THE enumeration predicate for a gym's walls.
 *
 * `is_public AND NOT is_unlisted` is the same rule `gymBoards` and
 * `searchBoards` apply to anyone without edit access. It is NOT what the
 * owner-gated `gymStats` resolver uses — that one counts every board linked to
 * the gym, which is safe only because a gym editor is already allowed to see
 * them. These numbers feed an admin BD list and, later, a public ranking, so
 * they must not be built from private or unlisted walls.
 *
 * This matters more than it looks: `user_boards.gym_id` does not mean "this
 * wall belongs to the gym". `requireBoardGymLinkAccess` lets any climber
 * self-link their own board to a public gym within
 * `SELF_LINK_PROXIMITY_METERS`, so a gym's board set can contain climber-owned
 * home walls — some of them private, some `hide_location`.
 */
const ENUMERABLE_GYM_BOARDS = sql`
  SELECT ub.id AS board_id, ub.gym_id
  FROM user_boards ub
  WHERE ub.gym_id IS NOT NULL
    AND ub.deleted_at IS NULL
    AND ub.is_public
    AND NOT ub.is_unlisted
`;

/**
 * Counts the gyms the rebuild would write. The backend runs this in the same
 * locked transaction and snapshot as the rebuild so its shrink guard compares
 * consistent counts.
 */
export async function countGymsWithActivity(db: GymActivityStatsDb): Promise<number> {
  const rows = await executeRowsAs<{ gym_count: number }>(
    db,
    sql`
    WITH gym_boards AS (${ENUMERABLE_GYM_BOARDS})
    SELECT COUNT(DISTINCT gb.gym_id)::int AS gym_count
    FROM board_climb_events e
    JOIN gym_boards gb ON gb.board_id = e.board_id
    JOIN gyms g ON g.id = gb.gym_id AND g.deleted_at IS NULL
  `,
  );
  return Number(rows[0]?.gym_count ?? 0);
}

/**
 * Deletes and re-inserts every row. MUST run inside a transaction that already
 * holds `pg_try_advisory_xact_lock(GYM_ACTIVITY_REFRESH_LOCK_KEY)` — a
 * transaction-scoped lock, never the session-scoped `pg_try_advisory_lock`,
 * which on a pooled connection can outlive the request that took it and wedge
 * every later refresh.
 *
 * Soft-deleted gyms are excluded, so a merged twin stops carrying numbers that
 * the surviving row also reports.
 */
export async function rebuildGymActivityStats(tx: GymActivityStatsDb): Promise<number> {
  await tx.execute(sql`DELETE FROM gym_activity_stats`);

  const inserted = await executeRowsAs<{ gym_id: number }>(
    tx,
    sql`
    WITH gym_boards AS (${ENUMERABLE_GYM_BOARDS}),
    activity AS (
      SELECT
        gb.gym_id,
        COUNT(DISTINCT e.user_id)::int AS distinct_users_all_time,
        COUNT(DISTINCT e.user_id) FILTER (
          WHERE e.confirmed_at > NOW() - INTERVAL '30 days'
        )::int AS distinct_users_30d,
        COUNT(DISTINCT e.user_id) FILTER (
          WHERE e.confirmed_at > NOW() - INTERVAL '7 days'
        )::int AS distinct_users_7d,
        COUNT(*)::int AS pushes_all_time,
        COUNT(*) FILTER (WHERE e.confirmed_at > NOW() - INTERVAL '30 days')::int AS pushes_30d,
        COUNT(DISTINCT gb.board_id)::int AS board_count,
        MIN(e.confirmed_at) AS first_active_at,
        MAX(e.confirmed_at) AS last_active_at
      FROM board_climb_events e
      JOIN gym_boards gb ON gb.board_id = e.board_id
      GROUP BY gb.gym_id
    )
    INSERT INTO gym_activity_stats (
      gym_id,
      distinct_users_all_time, distinct_users_30d, distinct_users_7d,
      pushes_all_time, pushes_30d, board_count,
      first_active_at, last_active_at,
      is_claimed, has_address, has_coords, has_website, has_contact_email,
      computed_at
    )
    SELECT
      a.gym_id,
      a.distinct_users_all_time, a.distinct_users_30d, a.distinct_users_7d,
      a.pushes_all_time, a.pushes_30d, a.board_count,
      a.first_active_at, a.last_active_at,
      -- A gym parked on the system owner came from the location sync and has
      -- never been claimed by the venue.
      g.owner_id <> '00000000-0000-0000-0000-000000000000',
      g.address IS NOT NULL AND g.address <> '',
      g.latitude IS NOT NULL AND g.longitude IS NOT NULL,
      g.website IS NOT NULL AND g.website <> '',
      g.contact_email IS NOT NULL AND g.contact_email <> '',
      NOW()
    FROM activity a
    JOIN gyms g ON g.id = a.gym_id AND g.deleted_at IS NULL
    RETURNING gym_id
  `,
  );

  return inserted.length;
}
