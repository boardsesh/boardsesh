import { GraphQLError } from 'graphql';
import { and, eq } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../../../db/client';
import { notifyClimbRevalidated } from '../../../lib/web-revalidate';
import { lockWallForWrite } from '../../../services/spray-wall-lock';
import { requireAuthenticated, applyRateLimit, validateInput } from '../shared/helpers';
import { sprayWallArchivedError } from '../board/spray-walls';
import { BoardNameSchema, ExternalUUIDSchema } from '../../../validation/schemas';
import { deleteClimbDependentRows, deleteClimbReferenceRows } from './climb-cleanup';
import { isSprayBoard } from './spray-authoring';

/**
 * `deleteClimb` (#5960): a setter deletes their own spray climb, published or
 * not, until somebody has logged it.
 *
 * Clients match on these codes, never on the message.
 *
 *  - `notFound`: no such climb, or not the caller's. One code for both, so a
 *    stranger holding a uuid learns nothing about a climb on a wall they cannot
 *    see. It is the same code `saveTick` answers for a deleted climb.
 *  - `hasTicks`: somebody (the setter included) has a tick on it. A logbook
 *    entry is never orphaned by a setter tidying up.
 *  - `notAllowed`: a climb on any board but spray. Catalogue climbs are shared
 *    reference data and stay.
 *
 * An archived wall refuses with the wall's own `SPRAY_WALL_ARCHIVED`.
 */
export const DELETE_CLIMB_CODES = {
  notFound: 'CLIMB_NOT_FOUND',
  hasTicks: 'CLIMB_HAS_TICKS',
  notAllowed: 'CLIMB_DELETE_NOT_ALLOWED',
} as const;

type DeleteClimbArgs = { uuid: unknown; boardType: unknown };

const notFoundError = () => new GraphQLError('Climb not found', { extensions: { code: DELETE_CLIMB_CODES.notFound } });

export const deleteClimbMutations = {
  /**
   * The race this has to win is a tick landing while the delete runs, including
   * an offline tick drained at that moment. Both sides lock the climb ROW:
   *
   *  - here, `SELECT … FOR UPDATE` before the tick count;
   *  - in `saveTick`, `SELECT … FOR KEY SHARE` inside its insert transaction.
   *
   * The two conflict. If the tick locks first, this waits for it to commit and
   * the count (a fresh READ COMMITTED statement) sees it: `CLIMB_HAS_TICKS`. If
   * this locks first, the tick waits, then finds no row: `CLIMB_NOT_FOUND`, which
   * the offline drainer dead-letters on the first attempt.
   *
   * Lock order is wall first, then row, like every spray writer (a publish holds
   * the wall lock while it rewrites `missing_hold_count` on the wall's climbs).
   *
   * Hard delete. The climb tombstone stays unscoped (`log_deletion_board_climbs`):
   * a published climb was readable by everybody who could open the wall, and gym
   * members or public-wall viewers may have it on their phone. A tombstone scoped
   * to the setter would leave them a climb they can tick and then lose.
   */
  deleteClimb: async (_: unknown, { uuid, boardType }: DeleteClimbArgs, ctx: ConnectionContext): Promise<boolean> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 20, 'deleteClimb');

    const validatedUuid = validateInput(ExternalUUIDSchema, uuid, 'uuid');
    const validatedBoardType = validateInput(BoardNameSchema, boardType, 'boardType');
    const userId = ctx.userId!;

    // Pre-transaction read: only to find the wall to lock. Everything that
    // decides the delete is re-read under the locks below.
    const [loaded] = await db
      .select({ userId: dbSchema.boardClimbs.userId, layoutId: dbSchema.boardClimbs.layoutId })
      .from(dbSchema.boardClimbs)
      .where(and(eq(dbSchema.boardClimbs.uuid, validatedUuid), eq(dbSchema.boardClimbs.boardType, validatedBoardType)))
      .limit(1);
    if (!loaded || loaded.userId !== userId) throw notFoundError();
    if (!isSprayBoard(validatedBoardType)) {
      throw new GraphQLError('Only spray wall climbs can be deleted', {
        extensions: { code: DELETE_CLIMB_CODES.notAllowed },
      });
    }

    await db.transaction(
      async (tx) => {
        // A soft-deleted wall keeps its row; its climbs can still be cleared.
        const [wall] = await tx
          .select({ id: dbSchema.sprayWalls.id })
          .from(dbSchema.sprayWalls)
          .where(eq(dbSchema.sprayWalls.layoutId, loaded.layoutId))
          .limit(1);
        if (wall) {
          await lockWallForWrite(tx, wall.id);
          const [state] = await tx
            .select({ archivedAt: dbSchema.sprayWalls.archivedAt })
            .from(dbSchema.sprayWalls)
            .where(eq(dbSchema.sprayWalls.id, wall.id))
            .limit(1);
          if (state?.archivedAt != null) throw sprayWallArchivedError();
        }

        const [locked] = await tx
          .select({ userId: dbSchema.boardClimbs.userId, layoutId: dbSchema.boardClimbs.layoutId })
          .from(dbSchema.boardClimbs)
          .where(
            and(eq(dbSchema.boardClimbs.uuid, validatedUuid), eq(dbSchema.boardClimbs.boardType, validatedBoardType)),
          )
          .limit(1)
          .for('update');
        if (!locked || locked.userId !== userId || locked.layoutId !== loaded.layoutId) throw notFoundError();

        const [tick] = await tx
          .select({ uuid: dbSchema.boardseshTicks.uuid })
          .from(dbSchema.boardseshTicks)
          .where(
            and(
              eq(dbSchema.boardseshTicks.boardType, validatedBoardType),
              eq(dbSchema.boardseshTicks.climbUuid, validatedUuid),
            ),
          )
          .limit(1);
        if (tick) {
          throw new GraphQLError('Somebody has logged this climb, so it stays', {
            extensions: { code: DELETE_CLIMB_CODES.hasTicks },
          });
        }

        await deleteClimbReferenceRows(tx, validatedBoardType, validatedUuid);
        await deleteClimbDependentRows(tx, validatedBoardType, [validatedUuid]);
        const deleted = await tx
          .delete(dbSchema.boardClimbs)
          .where(
            and(eq(dbSchema.boardClimbs.uuid, validatedUuid), eq(dbSchema.boardClimbs.boardType, validatedBoardType)),
          )
          .returning({ uuid: dbSchema.boardClimbs.uuid });
        if (deleted.length === 0) throw notFoundError();
      },
      { isolationLevel: 'read committed' },
    );

    void notifyClimbRevalidated(validatedUuid);
    return true;
  },
};
