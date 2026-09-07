import {
  pgTable,
  text,
  integer,
  bigint,
  bigserial,
  doublePrecision,
  timestamp,
  primaryKey,
  index,
  jsonb,
} from 'drizzle-orm/pg-core';

/**
 * Boardsesh grade: the data-science-backed grade per climb+angle, produced by
 * the nightly `refresh-climb-grades` job (empirical-Bayes shrinkage of the
 * upstream community mean toward an angle/setter-informed prior, plus a
 * cross-board offset anchored on Tension benchmarks).
 *
 * Model spec + rationale: docs/boardsesh-grade.md. Coefficients live in
 * `board_grade_coefficients`; every row records the model/coefficient versions
 * that produced it so a surfaced grade is reproducible.
 *
 * `universalGrade` is NULL when we refuse to make a cross-board claim (Moon has
 * no crowd mean in our feed; small boards have no anchor) — `localGrade` still
 * carries the within-board estimate where one exists. The published values only
 * move when the recomputed grade shifts ≥ the hysteresis threshold or the
 * confidence tier changes, so UI grades don't jitter night to night.
 */
export const boardClimbGrades = pgTable(
  'board_climb_grades',
  {
    boardType: text('board_type').notNull(),
    climbUuid: text('climb_uuid').notNull(),
    angle: integer('angle').notNull(),
    /** Within-board shrunk grade on the shared difficulty scale (10 = 4a/V0). */
    localGrade: doublePrecision('local_grade'),
    /** Cross-board standardized grade (Tension-anchored); NULL when unanchorable. */
    universalGrade: doublePrecision('universal_grade'),
    /** 95% band on whichever grade is surfaced (universal when present, else local). */
    gradeLow: doublePrecision('grade_low'),
    gradeHigh: doublePrecision('grade_high'),
    /** confirmed | provisional | setter_only (drives what the UI renders). */
    confidence: text('confidence').notNull(),
    /** Snapshot of the input ascent count that produced this row. */
    ascensionistCount: bigint('ascensionist_count', { mode: 'number' }).notNull().default(0),
    /** Reserved for the Stage-3 hold-feature content prior; NULL in v1. */
    contentPrior: doublePrecision('content_prior'),
    modelVersion: text('model_version').notNull(),
    coeffVersion: text('coeff_version').notNull(),
    computedAt: timestamp('computed_at', { mode: 'string' }).defaultNow().notNull(),
    // Monotonic per-row sequence for the offline sync cursor tiebreaker, mirroring
    // board_climb_stats.sync_seq. The nightly refresh stamps computed_at, so the
    // (computed_at, sync_seq) cursor pages every recompute without skips even when
    // a batch stamps many rows at the same computed_at.
    syncSeq: bigserial('sync_seq', { mode: 'number' }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.boardType, table.climbUuid, table.angle] }),
    confidenceIdx: index('board_climb_grades_confidence_idx').on(table.boardType, table.confidence),
    // Leading board_type: syncClimbGrades filters on it before walking the
    // (computed_at, sync_seq) cursor, so a per-board pull is one range scan.
    syncCursorIdx: index('board_climb_grades_sync_cursor_idx').on(table.boardType, table.computedAt, table.syncSeq),
  }),
);

/**
 * Versioned coefficient sets for the Boardsesh grade model. One row per
 * (version, kind, key); the payload shape depends on `kind`:
 *
 *  - `echo_fraction`      key = board_type     → { lambda }
 *  - `sigma_within`       key = board_type     → { [gradeBand]: sigma }
 *  - `tau_squared`        key = board_type     → { [gradeBand]: tau2 }
 *  - `angle_offset`       key = board_type     → { [gradeBand|'all']: { [angle]: offset } }
 *  - `board_offset`       key = board_type     → { offset, sd, users, looMaxDelta }
 *  - `rater_model`        key = board_type     → per-user/location biases + coverage summary
 *  - `behavior_model`     key = board_type     → outcome offsets + coverage summary
 *  - `bridge_readiness`   key = board_type     → MoonBoard bridge diagnostics
 *  - `gate_results`       key = run identifier → per-gate pass/fail + metrics
 *
 * Coefficients are refit weekly (not nightly) and frozen in between, so the
 * nightly re-blend can't wander because a hyperparameter twitched. Plain table,
 * pg_dump-portable; no Railway-specific machinery.
 */
export const boardGradeCoefficients = pgTable(
  'board_grade_coefficients',
  {
    coeffVersion: text('coeff_version').notNull(),
    kind: text('kind').notNull(),
    key: text('key').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { mode: 'string' }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.coeffVersion, table.kind, table.key] }),
  }),
);

export type BoardClimbGrade = typeof boardClimbGrades.$inferSelect;
export type NewBoardClimbGrade = typeof boardClimbGrades.$inferInsert;
export type BoardGradeCoefficient = typeof boardGradeCoefficients.$inferSelect;
export type NewBoardGradeCoefficient = typeof boardGradeCoefficients.$inferInsert;
