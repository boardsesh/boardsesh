import { pgTable, text, integer, doublePrecision, boolean, timestamp, primaryKey, index } from 'drizzle-orm/pg-core';

/**
 * Generated per-hold feature layer — the substrate for the Climb2Vec content
 * model (grade content_prior), climb similarity, and style recommendations.
 *
 * This is the ALGORITHMIC replacement for the dormant, crowd-sourced
 * `user_hold_classifications` table (which never took off: 24 rows). Instead of
 * asking users to rate holds, the nightly `refresh-hold-features` job GENERATES a
 * feature per placement from three sources we fully own:
 *
 *   1. GEOMETRY — `board_holes` x,y: normalized board position, distance to the
 *      board edge, nearest-neighbour spacing, and a geometry-derived pull
 *      direction. All angle-independent.
 *   2. BEHAVIOR — a de-confounded per-hold difficulty, ridge-regressed over the
 *      hold-incidence matrix of graded climbs (`board_climb_stats`), split by the
 *      role the hold plays (hand vs foot). "Hard holds" that recur in hard climbs
 *      surface without the co-occurrence contamination a raw per-hold mean carries.
 *   3. SET MEMBERSHIP — `board_sets.name` gives a coarse type (Foot Set / Screw
 *      Ons → foot chip). There is NO physical hold shape/size data anywhere in the
 *      DB, so true jug/crimp/sloper is left NULL — a documented ceiling, not a gap.
 *
 * Keyed by PLACEMENT id, which is globally unique within a `board_type`.
 * Aurora-family frames store that id directly. MoonBoard frames store a shared
 * grid-cell id, so they resolve to a layout-specific placement through
 * `(layout_id, board_placements.hole_id)` instead. NOTE this is a
 * different key convention than the dormant `user_hold_classifications.hold_id`
 * (documented there as `board_holes.id`); the shadow-write into that table
 * translates placement → hole via `board_placements`.
 *
 * Populated by `packages/db/scripts/refresh-hold-features.ts`. Pure derived data,
 * safe to be stale, `pg_dump`-portable (no extensions, no checks).
 */
export const boardHoldFeatures = pgTable(
  'board_hold_features',
  {
    boardType: text('board_type').notNull(),
    /** The frames placement id (`board_placements.id`); join key to climbs. */
    placementId: integer('placement_id').notNull(),
    /** Attribute: `board_placements.layout_id` (a placement belongs to one layout). */
    layoutId: integer('layout_id'),
    /** `board_placements.hole_id` — the physical hole this placement sits on. */
    holeId: integer('hole_id'),
    /** `board_placements.set_id` — hold set membership (coarse type source). */
    setId: integer('set_id'),

    // Geometry (from board_holes; angle-independent).
    /** Raw hole grid coordinate. */
    x: integer('x'),
    y: integer('y'),
    /** Position normalized to [0,1] within the board's hole bounding box. */
    normX: doublePrecision('norm_x'),
    normY: doublePrecision('norm_y'),
    /** Min distance to the bounding-box edge, normalized by box size. */
    edgeDist: doublePrecision('edge_dist'),
    /** Nearest-neighbour spacing among hand-usable holds, normalized by box size. */
    neighborDist: doublePrecision('neighbor_dist'),
    /** Kickboard hole (KB-named / kickboard set) — footwork region. */
    isKickboard: boolean('is_kickboard').notNull().default(false),

    // Behavioral difficulty (de-confounded ridge over the hold-incidence matrix),
    // on the shared Boardsesh difficulty scale (10 = V0/4a). Split by role because
    // a hold is a different problem for hands vs feet. NULL until enough samples.
    handDifficulty: doublePrecision('hand_difficulty'),
    footDifficulty: doublePrecision('foot_difficulty'),
    /** Count of graded climbs contributing to each role's estimate. */
    handSampleCount: integer('hand_sample_count').notNull().default(0),
    footSampleCount: integer('foot_sample_count').notNull().default(0),

    /** Geometry-derived pull direction, 0-360 (0=up, 90=right). NULL if indeterminate. */
    pullDirection: integer('pull_direction'),
    /** Coarse hold type from set membership: 'foot' or NULL (no shape data exists). */
    coarseType: text('coarse_type'),

    /** Feature-schema version so a stale row is identifiable across recomputes. */
    featureVersion: text('feature_version').notNull(),
    updatedAt: timestamp('updated_at', { mode: 'string' }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.boardType, table.placementId] }),
    // Per-board / per-layout scans by the feature builder and the training extractor.
    boardLayoutIdx: index('board_hold_features_board_layout_idx').on(table.boardType, table.layoutId),
  }),
);

export type BoardHoldFeature = typeof boardHoldFeatures.$inferSelect;
export type NewBoardHoldFeature = typeof boardHoldFeatures.$inferInsert;
