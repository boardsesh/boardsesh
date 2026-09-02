import { pgTable, bigint, integer, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { gyms } from './gyms';

/**
 * gym_activity_stats — "how many Boardsesh climbers actually use this gym",
 * materialised nightly.
 *
 * A CACHE, NOT A SOURCE OF TRUTH. Truncating it costs nothing permanent: every
 * column is derived from `board_climb_events` joined through `user_boards`, and
 * the next refresh rebuilds it. Same discipline as the sitemap store
 * (`sitemap_shard_refreshes`) — see docs/sitemap.md.
 *
 * Why materialise at all: the live scan groups ~270k dwell-gated climb events by
 * gym across ~750 gyms, which is too slow to sit behind an admin page or a
 * public ranking, and PostHog cannot answer the question at all for any period
 * before the `gym_uuid` super property shipped. This table is the only place the
 * pre-instrumentation history exists.
 *
 * `board_climb_events` is the substrate rather than `boardsesh_ticks` on
 * purpose. It records every climb pushed to a board's LEDs whether or not
 * anyone logged it, its writes are dwell-gated at ~60s of sustained presence
 * (so app-swiping noise never lands), and every row is board-linked by
 * construction. Tick board-attribution, by contrast, was under 1% before
 * 2026-04 and ~85% by 2026-08, so a tick-based ranking silently under-reports
 * its own early months.
 */
export const gymActivityStats = pgTable(
  'gym_activity_stats',
  {
    gymId: bigint('gym_id', { mode: 'number' })
      .primaryKey()
      .references(() => gyms.id, { onDelete: 'cascade' }),

    // Distinct climbers who pushed a climb to one of this gym's walls. THE
    // ranking metric: push volume measures how hard a few regulars train, not
    // how many people the venue reaches (one prod gym shows 4,314 pushes from 9
    // climbers, another 5,827 from 44).
    distinctUsersAllTime: integer('distinct_users_all_time').notNull().default(0),
    distinctUsers30d: integer('distinct_users_30d').notNull().default(0),
    distinctUsers7d: integer('distinct_users_7d').notNull().default(0),

    pushesAllTime: integer('pushes_all_time').notNull().default(0),
    pushes30d: integer('pushes_30d').notNull().default(0),

    // Walls counted toward the numbers above — i.e. after the enumeration
    // predicate, not every row with this gym_id.
    boardCount: integer('board_count').notNull().default(0),

    firstActiveAt: timestamp('first_active_at'),
    lastActiveAt: timestamp('last_active_at'),

    // Raw classification SIGNALS, deliberately not a derived `is_commercial`
    // boolean. Nothing separates a real gym from a personal home wall reliably:
    // a climber's board can be claimed, addressed and busy (one home wall in
    // prod has 14 distinct climbers and ranks top-20), while several genuine
    // commercial gyms are user-created with no website. A guessed boolean would
    // be silently wrong on exactly the rows a BD list cares about, so the
    // reader — an admin page, a human — decides, and these are what it decides
    // from.
    isClaimed: boolean('is_claimed').notNull().default(false),
    hasAddress: boolean('has_address').notNull().default(false),
    hasCoords: boolean('has_coords').notNull().default(false),
    hasWebsite: boolean('has_website').notNull().default(false),
    hasContactEmail: boolean('has_contact_email').notNull().default(false),

    computedAt: timestamp('computed_at').defaultNow().notNull(),
  },
  (table) => ({
    // The leaderboard read: "busiest gyms right now", ordered, limited.
    recentUsersIdx: index('gym_activity_stats_recent_users_idx').on(table.distinctUsers30d),
    allTimeUsersIdx: index('gym_activity_stats_all_time_users_idx').on(table.distinctUsersAllTime),
  }),
);

export type GymActivityStatsRow = typeof gymActivityStats.$inferSelect;
export type NewGymActivityStatsRow = typeof gymActivityStats.$inferInsert;
