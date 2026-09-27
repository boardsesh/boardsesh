import { index, integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * `(board, climb, angle)` keys a background sync wrote ticks for and still owes
 * a `board_climb_stats` recompute. A sync job's page or flush transaction adds
 * its keys here in the same commit as the ticks, then recomputes them in
 * batches of its own and deletes each key in the batch that recomputed it
 * (`DeferredClimbStatsRecompute`). A worker that dies between the two leaves
 * the rows behind, and the hourly `climb-stats-self-heal` job drains anything
 * older than two minutes. The daemons recompute inline and never write here.
 *
 * Unlike the self-heal's tick scan, a row here also covers a key with no stats
 * row yet and a key whose tick was deleted or downgraded.
 */
export const climbStatsRecomputePending = pgTable(
  'climb_stats_recompute_pending',
  {
    boardType: text('board_type').notNull(),
    climbUuid: text('climb_uuid').notNull(),
    angle: integer('angle').notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.boardType, table.climbUuid, table.angle] }),
    index('climb_stats_recompute_pending_requested_at_idx').on(table.requestedAt),
  ],
);
