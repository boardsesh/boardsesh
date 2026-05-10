import { and, desc, eq, sql, isNotNull } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { boardseshTicks, userClimbQualities, userClimbGrades } from '../schema/index';

/**
 * Database executor accepted by the projection helpers — either the top-level
 * Drizzle handle or a transaction. Typed against the broad `PgDatabase` so the
 * helpers work for both the backend `db` (full schema) and the aurora-sync
 * client (no schema baked in), without dragging in a specific schema generic.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle's PgDatabase requires a schema generic; the helpers don't depend on schema, so we accept any instantiation.
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
 * Recompute the projection rows for a (user, climb) pair after a tick is
 * deleted. Picks the next most-recent tick that still has a non-null value;
 * if none exists, removes the projection row entirely.
 *
 * Quality is recomputed angle-independently. Grade is recomputed at the
 * deleted tick's angle (other angles are unaffected).
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
  // Quality: most-recent remaining tick with a non-null quality, any angle.
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

  if (latestQualityTick && latestQualityTick.quality != null) {
    // Force the projection to reflect this remaining tick, even if the
    // current row is "newer" — the previously-newer tick was just deleted.
    await exec
      .insert(userClimbQualities)
      .values({
        userId: args.userId,
        boardType: args.boardType,
        climbUuid: args.climbUuid,
        quality: latestQualityTick.quality,
        updatedAt: latestQualityTick.climbedAt,
      })
      .onConflictDoUpdate({
        target: [userClimbQualities.userId, userClimbQualities.boardType, userClimbQualities.climbUuid],
        set: {
          quality: latestQualityTick.quality,
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

  // Grade: most-recent remaining tick at the same angle with a non-null grade.
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

  if (latestGradeTick && latestGradeTick.difficulty != null) {
    await exec
      .insert(userClimbGrades)
      .values({
        userId: args.userId,
        boardType: args.boardType,
        climbUuid: args.climbUuid,
        angle: args.angle,
        difficulty: latestGradeTick.difficulty,
        updatedAt: latestGradeTick.climbedAt,
      })
      .onConflictDoUpdate({
        target: [userClimbGrades.userId, userClimbGrades.boardType, userClimbGrades.climbUuid, userClimbGrades.angle],
        set: {
          difficulty: latestGradeTick.difficulty,
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
