import { pgTable, text, integer, real, timestamp, bigint, primaryKey, index, foreignKey } from 'drizzle-orm/pg-core';
import { boardClimbs } from '../boards/unified';

/**
 * Materialised hold-overlap neighbours: for every listed, published,
 * single-frame climb, its top-K (K = 25) climbs on the same layout (and, on
 * Woods, the same physical wall) by position-only Jaccard over distinct hold ids.
 * The same score the live `findSimilarClimbs` CTE computes, precomputed so the
 * `similarClimbs` resolver answers non-admin callers with one indexed read
 * instead of two scans of `board_climb_holds`.
 *
 * Written by `packages/db/scripts/refresh-climb-neighbors.ts` (nightly,
 * watermark-driven, see `board_climb_neighbor_runs`). `updateClimb` deletes a
 * climb's own list when its holds change; the next nightly run removes it from
 * other climbs' lists and rewrites them. See docs/similar-climbs.md.
 */
export const boardClimbNeighbors = pgTable(
  'board_climb_neighbors',
  {
    boardType: text('board_type').notNull(),
    climbUuid: text('climb_uuid').notNull(),
    neighborUuid: text('neighbor_uuid').notNull(),
    sharedHoldCount: integer('shared_hold_count').notNull(),
    targetHoldCount: integer('target_hold_count').notNull(),
    candidateHoldCount: integer('candidate_hold_count').notNull(),
    /** shared / (target + candidate - shared), in (0, 1]. */
    jaccard: real('jaccard').notNull(),
    /** 1..K within this climb's neighbour list, best first. */
    rank: integer('rank').notNull(),
    /**
     * How many rows this climb's list had when it was written. A list whose row
     * count has since dropped below it lost a row outside the job (a deleted
     * climb's FK cascade) and is refilled by the weekly gap scan.
     */
    listSize: integer('list_size').notNull(),
    computedAt: timestamp('computed_at').defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.boardType, table.climbUuid, table.neighborUuid] }),
    // Read path: one climb's list is the PK prefix (board_type, climb_uuid); the
    // read orders by similarity, not rank, and sorts at most 25 rows in memory.
    // A (board_type, climb_uuid, rank) index cost 256 MB and was dropped (C7).
    // Edit invalidation / job splice: "every list this climb appears in".
    neighborIdx: index('board_climb_neighbors_neighbor_idx').on(table.boardType, table.neighborUuid),
    climbFk: foreignKey({
      columns: [table.climbUuid],
      foreignColumns: [boardClimbs.uuid],
      name: 'board_climb_neighbors_climb_fk',
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    neighborFk: foreignKey({
      columns: [table.neighborUuid],
      foreignColumns: [boardClimbs.uuid],
      name: 'board_climb_neighbors_neighbor_fk',
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
  }),
);

/**
 * One row per board type: the highest `board_climbs.sync_seq` the neighbour job
 * has folded in. The next run's work set is every eligible climb above it.
 *
 * While a full build is in progress (the board's first run, or `--full`),
 * `full_build_started_at` and `full_build_sync_seq` pin it: a cancelled run
 * resumes the same build instead of starting over, and the watermark moves to
 * `full_build_sync_seq` only when the whole board is done.
 */
export const boardClimbNeighborRuns = pgTable('board_climb_neighbor_runs', {
  boardType: text('board_type').primaryKey().notNull(),
  lastSyncSeq: bigint('last_sync_seq', { mode: 'number' }).notNull().default(0),
  computedAt: timestamp('computed_at').defaultNow().notNull(),
  fullBuildStartedAt: timestamp('full_build_started_at'),
  fullBuildSyncSeq: bigint('full_build_sync_seq', { mode: 'number' }),
});

/**
 * Comparison groups (a layout; a layout + wall on Woods) a full build has
 * finished. A group whose `completed_at` is at or after the board's
 * `full_build_started_at` is done for the build in progress and is skipped when
 * a cancelled run resumes. `size_id` is 0 on boards that do not group by wall.
 */
export const boardClimbNeighborGroupRuns = pgTable(
  'board_climb_neighbor_group_runs',
  {
    boardType: text('board_type').notNull(),
    layoutId: integer('layout_id').notNull(),
    sizeId: integer('size_id').notNull().default(0),
    completedAt: timestamp('completed_at').notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.boardType, table.layoutId, table.sizeId] }),
  }),
);

export type BoardClimbNeighbor = typeof boardClimbNeighbors.$inferSelect;
export type NewBoardClimbNeighbor = typeof boardClimbNeighbors.$inferInsert;
export type BoardClimbNeighborRun = typeof boardClimbNeighborRuns.$inferSelect;
