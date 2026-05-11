import { and, desc, eq, sql, isNotNull } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { boardseshTicks, userClimbQualities, userClimbGrades } from '../schema/index';

/**
 * Database executor accepted by the projection helpers — either the top-level
 * Drizzle handle or a transaction. Typed against the broad `PgDatabase` so the
 * helpers work for both the backend `db` (full schema) and the aurora-sync
 * client (no schema baked in), without dragging in a specific schema generic.
 */
// oxlint-disable-next-line typescript/no-explicit-any -- Drizzle's PgDatabase requires a schema generic; the helpers don't depend on schema, so we accept any instantiation.
type Executor = PgDatabase<PgQueryResultHKT, any, any>;

/**
 * Upsert the user's "current opinion" for a climb's quality. Writes only when
 * the incoming `recordedAt` is at least as new as the existing row's
 * `updated_at` — guards against an older tick (e.g. an Aurora replay or a
 * historical edit) overwriting a newer opinion.
 *
 * Quality is angle-independent — one row per (user, board, climb).
 */
export async function upsertUserClimbQuality(
  exec: Executor,
  args: {
    userId: string;
    boardType: string;
    climbUuid: string;
    quality: number;
    recordedAt: string; // ISO timestamp
  },
): Promise<void> {
  await exec
    .insert(userClimbQualities)
    .values({
      userId: args.userId,
      boardType: args.boardType,
      climbUuid: args.climbUuid,
      quality: args.quality,
      updatedAt: args.recordedAt,
    })
    .onConflictDoUpdate({
      target: [userClimbQualities.userId, userClimbQualities.boardType, userClimbQualities.climbUuid],
      set: {
        quality: args.quality,
        updatedAt: args.recordedAt,
      },
      setWhere: sql`${userClimbQualities.updatedAt} <= ${args.recordedAt}`,
    });
}

/**
 * Upsert the user's "current opinion" for a climb's grade at a given angle.
 * Same staleness guard as the quality upsert. Grades are per-angle.
 */
export async function upsertUserClimbGrade(
  exec: Executor,
  args: {
    userId: string;
    boardType: string;
    climbUuid: string;
    angle: number;
    difficulty: number;
    recordedAt: string;
  },
): Promise<void> {
  await exec
    .insert(userClimbGrades)
    .values({
      userId: args.userId,
      boardType: args.boardType,
      climbUuid: args.climbUuid,
      angle: args.angle,
      difficulty: args.difficulty,
      updatedAt: args.recordedAt,
    })
    .onConflictDoUpdate({
      target: [userClimbGrades.userId, userClimbGrades.boardType, userClimbGrades.climbUuid, userClimbGrades.angle],
      set: {
        difficulty: args.difficulty,
        updatedAt: args.recordedAt,
      },
      setWhere: sql`${userClimbGrades.updatedAt} <= ${args.recordedAt}`,
    });
}

/**
 * Recompute the user_climb_qualities row for a (user, climb) pair from the
 * remaining ticks. Picks the next most-recent tick (any angle) that still has
 * a non-null quality; if none exists, removes the projection row entirely.
 */
export async function recomputeUserClimbQualityProjection(
  exec: Executor,
  args: {
    userId: string;
    boardType: string;
    climbUuid: string;
  },
): Promise<void> {
  const [latestQualityTick] = await exec
    .select({ quality: boardseshTicks.quality, climbedAt: boardseshTicks.climbedAt })
    .from(boardseshTicks)
    .where(
      and(
        eq(boardseshTicks.userId, args.userId),
        eq(boardseshTicks.boardType, args.boardType),
        eq(boardseshTicks.climbUuid, args.climbUuid),
        isNotNull(boardseshTicks.quality),
      ),
    )
    .orderBy(desc(boardseshTicks.climbedAt), desc(boardseshTicks.id))
    .limit(1);

  if (latestQualityTick) {
    // Force the projection to reflect this remaining tick, even if the
    // existing row is "newer" — the previously-newer tick was just removed.
    await exec
      .insert(userClimbQualities)
      .values({
        userId: args.userId,
        boardType: args.boardType,
        climbUuid: args.climbUuid,
        quality: latestQualityTick.quality!,
        updatedAt: latestQualityTick.climbedAt,
      })
      .onConflictDoUpdate({
        target: [userClimbQualities.userId, userClimbQualities.boardType, userClimbQualities.climbUuid],
        set: {
          quality: latestQualityTick.quality!,
          updatedAt: latestQualityTick.climbedAt,
        },
      });
  } else {
    await exec
      .delete(userClimbQualities)
      .where(
        and(
          eq(userClimbQualities.userId, args.userId),
          eq(userClimbQualities.boardType, args.boardType),
          eq(userClimbQualities.climbUuid, args.climbUuid),
        ),
      );
  }
}

/**
 * Recompute the user_climb_grades row for a (user, climb, angle) triple from
 * the remaining ticks at the same angle. Other angles are unaffected.
 */
export async function recomputeUserClimbGradeProjection(
  exec: Executor,
  args: {
    userId: string;
    boardType: string;
    climbUuid: string;
    angle: number;
  },
): Promise<void> {
  const [latestGradeTick] = await exec
    .select({ difficulty: boardseshTicks.difficulty, climbedAt: boardseshTicks.climbedAt })
    .from(boardseshTicks)
    .where(
      and(
        eq(boardseshTicks.userId, args.userId),
        eq(boardseshTicks.boardType, args.boardType),
        eq(boardseshTicks.climbUuid, args.climbUuid),
        eq(boardseshTicks.angle, args.angle),
        isNotNull(boardseshTicks.difficulty),
      ),
    )
    .orderBy(desc(boardseshTicks.climbedAt), desc(boardseshTicks.id))
    .limit(1);

  if (latestGradeTick) {
    await exec
      .insert(userClimbGrades)
      .values({
        userId: args.userId,
        boardType: args.boardType,
        climbUuid: args.climbUuid,
        angle: args.angle,
        difficulty: latestGradeTick.difficulty!,
        updatedAt: latestGradeTick.climbedAt,
      })
      .onConflictDoUpdate({
        target: [userClimbGrades.userId, userClimbGrades.boardType, userClimbGrades.climbUuid, userClimbGrades.angle],
        set: {
          difficulty: latestGradeTick.difficulty!,
          updatedAt: latestGradeTick.climbedAt,
        },
      });
  } else {
    await exec
      .delete(userClimbGrades)
      .where(
        and(
          eq(userClimbGrades.userId, args.userId),
          eq(userClimbGrades.boardType, args.boardType),
          eq(userClimbGrades.climbUuid, args.climbUuid),
          eq(userClimbGrades.angle, args.angle),
        ),
      );
  }
}

/**
 * Backfill `user_climb_qualities` and `user_climb_grades` from every existing
 * tick in `boardsesh_ticks` (most-recent-tick rule). Idempotent — the staleness
 * guard means re-running this never overwrites a newer projection row with an
 * older tick.
 *
 * Used by:
 *   - migration `0090_backfill_user_climb_ratings.sql` (the canonical seed
 *     across the row of historical data)
 *   - `packages/db/scripts/seed-social.ts` (so dev databases get a populated
 *     projection without re-running migrations).
 *
 * The migration file itself is a frozen artifact and isn't allowed to import
 * TS, so the SQL is duplicated there. If the projection rules ever change,
 * write a NEW migration (don't patch 0090) and update this function.
 */
export async function backfillUserClimbProjectionsFromTicks(exec: Executor): Promise<void> {
  // `>=` matches the staleness guard used by upsertUserClimbQuality and the
  // Aurora bulk-upsert path — equal timestamps tie-break in favour of the
  // incoming row, which keeps repeat seeds idempotent in the no-op case.
  await exec.execute(sql`
    INSERT INTO user_climb_qualities (user_id, board_type, climb_uuid, quality, updated_at)
    SELECT DISTINCT ON (user_id, board_type, climb_uuid)
      user_id, board_type, climb_uuid, quality, climbed_at
    FROM boardsesh_ticks
    WHERE quality IS NOT NULL
    ORDER BY user_id, board_type, climb_uuid, climbed_at DESC, id DESC
    ON CONFLICT (user_id, board_type, climb_uuid) DO UPDATE
      SET quality = EXCLUDED.quality, updated_at = EXCLUDED.updated_at
      WHERE EXCLUDED.updated_at >= user_climb_qualities.updated_at
  `);
  // `angle > 0` guards against bogus Aurora payloads — `Number(null)` or
  // `Number("")` coerces to 0, and 0 isn't a valid Kilter/Tension angle.
  // Mirrors the live-write guard in aurora-sync/user-sync.ts.
  await exec.execute(sql`
    INSERT INTO user_climb_grades (user_id, board_type, climb_uuid, angle, difficulty, updated_at)
    SELECT DISTINCT ON (user_id, board_type, climb_uuid, angle)
      user_id, board_type, climb_uuid, angle, difficulty, climbed_at
    FROM boardsesh_ticks
    WHERE difficulty IS NOT NULL
      AND angle > 0
    ORDER BY user_id, board_type, climb_uuid, angle, climbed_at DESC, id DESC
    ON CONFLICT (user_id, board_type, climb_uuid, angle) DO UPDATE
      SET difficulty = EXCLUDED.difficulty, updated_at = EXCLUDED.updated_at
      WHERE EXCLUDED.updated_at >= user_climb_grades.updated_at
  `);
}

/**
 * Recompute both projection rows for a (user, climb, angle) triple — the
 * tick-deleted use case, where we don't know which value(s) the deleted tick
 * contributed to the current opinion.
 */
export async function recomputeUserClimbProjectionsAfterTickDelete(
  exec: Executor,
  args: {
    userId: string;
    boardType: string;
    climbUuid: string;
    angle: number;
  },
): Promise<void> {
  await recomputeUserClimbQualityProjection(exec, {
    userId: args.userId,
    boardType: args.boardType,
    climbUuid: args.climbUuid,
  });
  await recomputeUserClimbGradeProjection(exec, args);
}
