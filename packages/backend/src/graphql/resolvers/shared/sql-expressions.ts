import { sql, eq, and } from 'drizzle-orm';
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
 * The "effective" grade id for a tick: the user's logged override when present,
 * otherwise the climb's consensus grade. NULL difficulty in `boardseshTicks`
 * means "use consensus" — see docs/ascents-and-attempts.md.
 *
 * ## Required tables / joins
 *
 * - `boardseshTicks` must be in the FROM clause (the override side of the
 *   COALESCE).
 * - `boardClimbStats` must be LEFT JOINed on (climbUuid, boardType, angle) —
 *   otherwise `consensusDifficultyExpr` resolves to NULL and the COALESCE
 *   silently degrades to the user-override-only behaviour, hiding ungraded
 *   ticks from grade-range filters and per-grade aggregates.
 *
 * Drizzle's SQL-template type can't encode the join requirement, so this
 * comment is the contract — keep `boardClimbStats` joined wherever this
 * expression is used.
 */
export const effectiveDifficultyExpr = sql<
  number | null
>`COALESCE(${dbSchema.boardseshTicks.difficulty}, ${consensusDifficultyExpr})`;

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
