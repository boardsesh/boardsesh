import { sql, eq, and, isNull, type SQL } from 'drizzle-orm';
import { aliasedTable } from 'drizzle-orm/alias';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../../../db/client';

/**
 * Aliased board_difficulty_grades table for consensus grade lookups.
 * Resolves the community-voted grade from boardClimbStats.displayDifficulty
 * without a correlated subquery.
 *
 * ## Required joins (in order)
 *
 * Queries that use any of the expressions below must include these joins:
 *
 * 1. `boardClimbStats` — joined on (climbUuid, boardType, angle)
 * 2. `boardDifficultyGrades` — joined on (tick.difficulty, boardType) — user's logged grade
 * 3. `consensusGradeTable` — joined via `consensusGradeJoinCondition` — consensus grade
 *
 * Example:
 * ```ts
 * db.select({ difficultyName: difficultyNameWithFallbackExpr })
 *   .from(boardseshTicks)
 *   .leftJoin(boardClimbStats, ...)
 *   .leftJoin(boardDifficultyGrades, ...)
 *   .leftJoin(consensusGradeTable, consensusGradeJoinCondition)
 * ```
 *
 * If a required join is missing the query will produce nulls (not an error)
 * because these are LEFT JOINs with nullable column references.
 */
export const consensusGradeTable = aliasedTable(dbSchema.boardDifficultyGrades, 'consensus_grade');

/**
 * JOIN condition for consensusGradeTable.
 * Requires boardClimbStats to already be joined in the query.
 */
export const consensusGradeJoinCondition = and(
  eq(consensusGradeTable.difficulty, sql`ROUND(${dbSchema.boardClimbStats.displayDifficulty})`),
  eq(consensusGradeTable.boardType, dbSchema.boardClimbStats.boardType),
);

/**
 * Consensus difficulty name from the joined consensus grade table.
 * Requires `consensusGradeTable` LEFT JOIN (see {@link consensusGradeTable}).
 */
export const consensusDifficultyNameExpr = sql<string | null>`${consensusGradeTable.boulderName}`;

/**
 * COALESCE user-logged grade with consensus grade.
 * Falls back to consensus when the user didn't log a grade.
 * Requires both `boardDifficultyGrades` and `consensusGradeTable` LEFT JOINs
 * (see {@link consensusGradeTable}).
 */
export const difficultyNameWithFallbackExpr = sql<string | null>`COALESCE(
  ${dbSchema.boardDifficultyGrades.boulderName},
  ${consensusGradeTable.boulderName}
)`;

/**
 * Rounded consensus difficulty ID.
 * Requires `boardClimbStats` to be joined in the query.
 */
export const consensusDifficultyExpr = sql<number | null>`ROUND(${dbSchema.boardClimbStats.displayDifficulty})`;

/**
 * SINGLE SOURCE OF TRUTH for the Boardsesh grade↔tick JOIN condition on the
 * `board_climb_grades` table, keyed on the tick's OWN angle + board type + the
 * alias-resolved canonical climb UUID. Mirrors the `board_climb_stats` join the
 * tick queries already do (`COALESCE(aliases.canonical_uuid, ticks.climb_uuid)`),
 * so a tick pointing at a deduped-away alias UUID still resolves its grade.
 *
 * The three tables are named by the CALLER, so both worlds share one join shape:
 *  - the Drizzle tick queries pass the real (unaliased) table names
 *    (`boardsesh_ticks`, `board_climb_grades`, `board_climb_aliases`) — Drizzle
 *    renders those tables unaliased, so bare table-name qualification resolves;
 *  - the raw-SQL session-feed queries pass their short aliases (`t`, `bcg`, `bca`).
 *
 * Emits identifiers only, no bound params (the three alias strings are internal
 * constants, never user input), so it composes safely into both a Drizzle
 * `.leftJoin(table, <this>)` and a raw `sql\`... ON ${<this>}\`` fragment.
 *
 * ## Required joins (prerequisite — enforced by the call signature)
 *
 * A query using this condition must already have joined:
 *  1. `board_climb_aliases` — on (alias_uuid = ticks.climb_uuid, same board_type)
 *     so the COALESCE below falls back to the tick's own climb UUID for
 *     non-aliased ticks. The caller must name it via `aliases`.
 *  2. `board_climb_grades` via this condition, as a LEFT JOIN — a climb with no
 *     grade row (MoonBoard, too few ascents) returns NULL grade fields, which is
 *     the safe-degradation path everywhere (the UI keeps the Aurora grade).
 *
 * Example (Drizzle):
 * ```ts
 * db.select({ boardseshDifficulty: boardseshDifficultyExpr, boardseshConfidence: boardseshConfidenceExpr })
 *   .from(boardseshTicks)
 *   .leftJoin(boardClimbAliases, ...)
 *   .leftJoin(dbSchema.boardClimbGrades, boardseshGradeTickJoin({
 *     ticks: 'boardsesh_ticks', grades: 'board_climb_grades', aliases: 'board_climb_aliases',
 *   }))
 * ```
 *
 * @param ticks   table name/alias for `boardsesh_ticks` ('boardsesh_ticks' or 't')
 * @param grades  table name/alias for `board_climb_grades` ('board_climb_grades' or 'bcg')
 * @param aliases table name/alias for `board_climb_aliases` ('board_climb_aliases' or 'bca')
 */
export function boardseshGradeTickJoin({
  ticks,
  grades,
  aliases,
}: {
  ticks: string;
  grades: string;
  aliases: string;
}): SQL {
  return sql.raw(
    `COALESCE(${aliases}.canonical_uuid, ${ticks}.climb_uuid) = ${grades}.climb_uuid` +
      ` AND ${ticks}.board_type = ${grades}.board_type` +
      ` AND ${ticks}.angle = ${grades}.angle`,
  );
}

/**
 * Boardsesh grade for the joined `board_climb_grades` row, flattened to a single
 * value on the shared difficulty scale: the cross-board universal grade when
 * present, else the within-board local grade. NULL when no grade row is joined.
 * Requires the `boardClimbGrades` LEFT JOIN (see {@link boardseshGradeTickJoin}).
 */
export const boardseshDifficultyExpr = sql<number | null>`COALESCE(
  ${dbSchema.boardClimbGrades.universalGrade},
  ${dbSchema.boardClimbGrades.localGrade}
)`;

/**
 * Boardsesh grade confidence tier ('confirmed' | 'provisional' | 'setter_only')
 * from the joined `board_climb_grades` row; NULL when no grade row is joined.
 * The UI keeps the Aurora grade when this is NULL or 'setter_only'.
 * Requires the `boardClimbGrades` LEFT JOIN (see {@link boardseshGradeTickJoin}).
 *
 * Plain column reference, not a `sql<...>` wrapper: `confidence` is `.notNull()`
 * on `board_climb_grades` itself, so Drizzle's inferred TS type here is `string`,
 * not `string | null` — but a LEFT JOIN miss still returns `null` at runtime.
 * Every call site runs this through `toConfidenceTier` (@boardsesh/db/queries)
 * before emitting it, which both narrows the value to the {@link ConfidenceTier}
 * union and folds a LEFT JOIN miss (or an unknown/future tier) to `null`, so the
 * narrower compile-time type here doesn't hide a real bug.
 */
export const boardseshConfidenceExpr = dbSchema.boardClimbGrades.confidence;

// A tick pulled from Kilter carries no per-tick quality, but the climber's own
// star rating for that (climb, angle) may already live in board_climb_ratings
// (kilter-sync writes it there, keyed by board_type/climb_uuid/angle/user_id).
// Join on the tick's OWN user + raw climb_uuid so a public viewer sees the
// tick owner's synced rating, and expose it as `effectiveQuality`
// (COALESCE(quality, rating)) — the same raw-vs-effective split as
// `difficulty`/`effectiveDifficulty`, so the per-tick `quality` stays the raw
// user value for edit/optimistic flows. Ratings are already 1–5 native (DB
// check constraint), so there's nothing to rescale. The unique index
// `board_climb_ratings_user_climb_angle_idx` on exactly
// (board_type, climb_uuid, angle, user_id) — declared in
// packages/db/src/schema/boards/unified.ts — makes this a 1:1 left join that
// never multiplies rows and is fully index-backed.
//
// Detached ratings are excluded. When Kilter sends a REMOVE for a rating,
// kilter-sync soft-detaches the row (kilter_id NULL + kilter_detached_at
// stamped) instead of deleting it, so the climber's own edits survive a
// PowerSync snapshot re-delivery. But a rating the climber deleted upstream
// must stop feeding effectiveQuality: unlike a tick, every field on this row
// comes from the Kilter payload, and Kilter never sends another PUT for a
// rating it has deleted — so without this predicate the stale star would show
// on the ascent forever. A REMOVE-then-PUT redelivery re-adopts the row and
// clears the marker, so a live rating is unaffected.
//
// The marker is Kilter-specific but this predicate is not: a marked row is
// hidden whatever its rating's origin. That is correct today because
// kilter-sync is the only writer of this table. The day an Aurora writer
// lands, revisit it — an Aurora-origin row that adopted a kilter_id and then
// took a Kilter REMOVE would be hidden even though its Aurora rating is live.
export const boardClimbRatingsJoinCondition = and(
  eq(dbSchema.boardseshTicks.boardType, dbSchema.boardClimbRatings.boardType),
  eq(dbSchema.boardseshTicks.climbUuid, dbSchema.boardClimbRatings.climbUuid),
  eq(dbSchema.boardseshTicks.angle, dbSchema.boardClimbRatings.angle),
  eq(dbSchema.boardseshTicks.userId, dbSchema.boardClimbRatings.userId),
  isNull(dbSchema.boardClimbRatings.kilterDetachedAt),
);

export const effectiveQualityExpr = sql<
  number | null
>`COALESCE(${dbSchema.boardseshTicks.quality}, ${dbSchema.boardClimbRatings.rating})`;

/**
 * Number of non-deleted comments targeting each tick, as a correlated
 * subquery.
 *
 * PRECONDITION: the outer query's FROM clause MUST include `boardseshTicks`.
 * The subquery's WHERE references `boardseshTicks.uuid` from the outer row;
 * using this expression from a query that does not join `boardseshTicks`
 * produces a Postgres error at runtime (there is no compile-time guard —
 * Drizzle's SQL template type cannot encode table-scope requirements).
 *
 * Correctness is also size-sensitive: this subquery runs once per returned
 * row. Only use it in queries with a bounded LIMIT (e.g. followingClimbAscents
 * caps at 100, and ticks is scoped by user + optional climbUuids). For larger
 * result sets, prefer a single LEFT JOIN on a grouped COUNT(*) CTE instead.
 */
export const tickCommentCountExpr = sql<number>`(
  SELECT COUNT(*)::int
  FROM ${dbSchema.comments}
  WHERE ${dbSchema.comments.entityType} = 'tick'
    AND ${dbSchema.comments.entityId} = ${dbSchema.boardseshTicks.uuid}
    AND ${dbSchema.comments.deletedAt} IS NULL
)`;

/**
 * Imperative query: look up consensus grade name for a specific climb+angle.
 * Used in contexts where an inline SQL expression isn't possible (e.g. event publishing).
 */
export async function getConsensusDifficultyName(
  climbUuid: string,
  boardType: string,
  angle: number,
): Promise<string | undefined> {
  const [result] = await db
    .select({ boulderName: dbSchema.boardDifficultyGrades.boulderName })
    .from(dbSchema.boardClimbStats)
    .innerJoin(
      dbSchema.boardDifficultyGrades,
      and(
        eq(dbSchema.boardDifficultyGrades.difficulty, sql`ROUND(${dbSchema.boardClimbStats.displayDifficulty})`),
        eq(dbSchema.boardDifficultyGrades.boardType, dbSchema.boardClimbStats.boardType),
      ),
    )
    .where(
      and(
        eq(dbSchema.boardClimbStats.climbUuid, climbUuid),
        eq(dbSchema.boardClimbStats.boardType, boardType),
        eq(dbSchema.boardClimbStats.angle, angle),
      ),
    )
    .limit(1);
  return result?.boulderName ?? undefined;
}
