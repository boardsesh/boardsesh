import { pgTable, text, integer, bigint, doublePrecision, timestamp, primaryKey, index } from 'drizzle-orm/pg-core';

/**
 * Per-setter popularity aggregate for the recommendation engine.
 *
 * Derived from board_climbs × board_climb_stats (pure existing-data, no PostHog):
 * a "this setter's climbs tend to be loved" prior. Refreshed by the nightly
 * recommendations job; safe to be stale. `setterScore` is a shrinkage-adjusted,
 * quality-gated estimate used as the primary ranking factor for the Fresh
 * playlist (new climbs have no ascents yet) and a light multiplier elsewhere.
 */
export const boardSetterStats = pgTable(
  'board_setter_stats',
  {
    boardType: text('board_type').notNull(),
    setterUsername: text('setter_username').notNull(),
    climbCount: integer('climb_count').notNull().default(0),
    totalAscents: bigint('total_ascents', { mode: 'number' }).notNull().default(0),
    avgAscentsPerClimb: doublePrecision('avg_ascents_per_climb').notNull().default(0),
    avgQuality: doublePrecision('avg_quality'),
    // Shrinkage-adjusted, quality-gated popularity prior. ln-normalized in the
    // ranking query; stored raw here so the weighting can be retuned without a
    // recompute.
    setterScore: doublePrecision('setter_score').notNull().default(0),
    updatedAt: timestamp('updated_at', { mode: 'string' }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.boardType, table.setterUsername] }),
    scoreIdx: index('board_setter_stats_score_idx').on(table.boardType, table.setterScore),
  }),
);

/**
 * Per-climb "trending on Boardsesh" aggregate, mined from PostHog
 * `Climb Sent to Board Success` events by the nightly recommendations job.
 *
 * This is a tiny derived aggregate (one row per climb that has been sent), NOT
 * raw per-user send capture — that (and the future "recently sent to board" UI)
 * is intentionally out of scope. `sendBoost` in the ranking query defaults to
 * 1.0 when a climb has no row, so the engine runs before the job ever populates
 * this table.
 */
export const boardClimbSendStats = pgTable(
  'board_climb_send_stats',
  {
    boardType: text('board_type').notNull(),
    climbUuid: text('climb_uuid').notNull(),
    sendCount30d: integer('send_count_30d').notNull().default(0),
    senderCount30d: integer('sender_count_30d').notNull().default(0),
    sendCount90d: integer('send_count_90d').notNull().default(0),
    lastSentAt: timestamp('last_sent_at', { mode: 'string' }),
    updatedAt: timestamp('updated_at', { mode: 'string' }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.boardType, table.climbUuid] }),
    trendingIdx: index('board_climb_send_stats_trending_idx').on(table.boardType, table.sendCount30d),
  }),
);

export type BoardSetterStat = typeof boardSetterStats.$inferSelect;
export type NewBoardSetterStat = typeof boardSetterStats.$inferInsert;
export type BoardClimbSendStat = typeof boardClimbSendStats.$inferSelect;
export type NewBoardClimbSendStat = typeof boardClimbSendStats.$inferInsert;
