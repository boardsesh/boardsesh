import { and, eq } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type { BoardName } from '@boardsesh/board-constants';
import * as dbSchema from '@boardsesh/db/schema';
import { usesAuroraNoMatchDescription } from '@boardsesh/shared-schema';
import { isSprayBoard } from './spray-authoring';

/**
 * The concurrency guard for `updateClimb`, and the refusal codes it answers with.
 *
 * Inside its transaction `updateClimb` calls {@link lockClimbForEdit} before its
 * UPDATE: it locks the climb row and returns the climb as it stands. If that row
 * no longer matches the one the resolver loaded before the transaction opened,
 * {@link climbEditDecisionsAreStale} says so and the edit is refused.
 *
 * This file used to also write climb revision history (#5955). That was retired:
 * edits are made in place and `board_climb_revisions` is no longer written
 * (docs/spray-walls.md, "Editing a climb").
 */

type DrizzleExecutor = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** The editable state of a climb at one moment, read under the row lock. */
export type ClimbEditState = {
  userId: string | null;
  isDraft: boolean;
  publishedAt: string | null;
  name: string | null;
  description: string | null;
  frames: string | null;
  framesCount: number | null;
  framesPace: number | null;
  angle: number | null;
  characteristics: string[] | null;
  /** The setter grade. Spray only; null on every other board. */
  difficultyId: number | null;
  /** `board_climbs.revision_number`, as stored. Edits no longer move it. */
  revisionNumber: number;
  /** `board_climbs.holds_revision_number`, as stored. Edits no longer move it either. */
  holdsRevisionNumber: number;
};

/**
 * Lock the climb row for this transaction and return it as it stands.
 *
 * `SELECT … FOR NO KEY UPDATE`, so a second `updateClimb` on the same climb waits
 * here until the first commits and then reads the first one's result.
 *
 * `NO KEY UPDATE` rather than `UPDATE`: it is the lock the caller's own UPDATE
 * takes a moment later (it never touches the uuid), it queues two editors just
 * the same, and unlike `FOR UPDATE` it does not block an insert into a table that
 * references this climb for as long as the edit runs. A draft delete still
 * waits for it.
 *
 * Call it AFTER the spray wall lock. Every writer that takes both takes the wall
 * first (a publish holds the wall lock while it rewrites `missing_hold_count` on
 * the wall's climbs), so row-then-wall here would be a deadlock waiting for one.
 *
 * Null when the row is gone, which a draft deleted mid-edit can do.
 */
export async function lockClimbForEdit(
  executor: DrizzleExecutor,
  boardType: BoardName,
  climbUuid: string,
): Promise<ClimbEditState | null> {
  const [row] = await executor
    .select({
      userId: dbSchema.boardClimbs.userId,
      isDraft: dbSchema.boardClimbs.isDraft,
      publishedAt: dbSchema.boardClimbs.publishedAt,
      name: dbSchema.boardClimbs.name,
      description: dbSchema.boardClimbs.description,
      frames: dbSchema.boardClimbs.frames,
      framesCount: dbSchema.boardClimbs.framesCount,
      framesPace: dbSchema.boardClimbs.framesPace,
      angle: dbSchema.boardClimbs.angle,
      characteristics: dbSchema.boardClimbs.characteristics,
      revisionNumber: dbSchema.boardClimbs.revisionNumber,
      holdsRevisionNumber: dbSchema.boardClimbs.holdsRevisionNumber,
    })
    .from(dbSchema.boardClimbs)
    .where(and(eq(dbSchema.boardClimbs.uuid, climbUuid), eq(dbSchema.boardClimbs.boardType, boardType)))
    .limit(1)
    .for('no key update');
  if (!row) return null;

  // The setter grade lives on the stats row at the climb's angle, not on the
  // climb. Only spray, where `updateClimb` writes it: the replayed-publish check
  // compares it.
  let difficultyId: number | null = null;
  if (isSprayBoard(boardType) && row.angle != null) {
    const [stats] = await executor
      .select({ displayDifficulty: dbSchema.boardClimbStats.displayDifficulty })
      .from(dbSchema.boardClimbStats)
      .where(
        and(
          eq(dbSchema.boardClimbStats.boardType, boardType),
          eq(dbSchema.boardClimbStats.climbUuid, climbUuid),
          eq(dbSchema.boardClimbStats.angle, row.angle),
        ),
      )
      .limit(1);
    difficultyId = stats?.displayDifficulty == null ? null : Math.round(stats.displayDifficulty);
  }

  return { ...row, isDraft: row.isDraft === true, difficultyId };
}

/**
 * `extensions.code` on the refusal `updateClimb` gives when the climb changed
 * between the resolver loading it and the transaction locking it. Clients match
 * on this, never on the message. The right response is to reload the climb and
 * let the climber redo the edit.
 */
export const CLIMB_EDIT_CONFLICT_ERROR_CODE = 'CLIMB_EDIT_CONFLICT';

/**
 * `extensions.code` on the three refusals `updateClimb` gives before it touches
 * the row. Clients match on these, never on the message, and translate them; the
 * messages are kept as they were for older clients.
 *
 *  - `notAllowed`: the caller is not the climb's setter. One code for every such
 *    caller, so on a spray wall it does not say whether the wall exists.
 *  - `windowExpired`: a published climb, on any board, past 24 hours.
 *  - `notEditable`: a published climb with no publish date on record.
 */
export const CLIMB_EDIT_REFUSAL_CODES = {
  notAllowed: 'CLIMB_EDIT_NOT_ALLOWED',
  windowExpired: 'CLIMB_EDIT_WINDOW_EXPIRED',
  notEditable: 'CLIMB_NOT_EDITABLE',
} as const;

/** The columns of the pre-transaction row that `updateClimb`'s decisions are computed from. */
export type ClimbEditDecisionInputs = {
  isDraft: boolean | null | undefined;
  frames: string | null | undefined;
  framesCount: number | null | undefined;
  angle: number | null | undefined;
  characteristics: readonly string[] | null | undefined;
  description: string | null | undefined;
};

/**
 * Whether the row `updateClimb` loaded BEFORE its transaction still describes
 * the climb, in every column its decisions were computed from.
 *
 * `updateClimb` decides a lot before it opens its transaction, off that first
 * read: whether the holds changed (and so whether to rewrite `board_climb_holds`,
 * the fingerprint and the lost-hold count), the next rule set, and whether and on
 * what signature to run the duplicate gate. Another edit by the same setter (a
 * second device, a retry) can commit in between, and every one of those
 * decisions is then about a climb that no longer exists. The worst case writes the old frames
 * back while skipping the hold rewrite, leaving `frames` and `board_climb_holds`
 * describing two different climbs.
 *
 * Refusing is the fix, rather than recomputing from the locked row, because of
 * the lock order. The duplicate-gate lock is keyed on the hold and rule signature
 * and has to be taken BEFORE the wall lock and the row lock. Recomputing after
 * the row lock would mean taking a second gate lock while holding the row, which
 * is the reverse order and a deadlock between two edits. A refusal needs no new
 * lock and cannot write anything wrong.
 *
 * Only decision inputs are compared. The name and the frames pace are written
 * straight from the request and feed no decision, so a concurrent rename does not
 * refuse an edit. The description is compared only on the Aurora boards, the one
 * place it can carry a rule (the "No match" prefix); elsewhere it is prose.
 */
export function climbEditDecisionsAreStale(
  boardType: BoardName,
  loaded: ClimbEditDecisionInputs,
  locked: ClimbEditState,
): boolean {
  const sameRules = (left: readonly string[] | null | undefined, right: readonly string[] | null | undefined) => {
    if (left == null || right == null) return left == null && right == null;
    return left.length === right.length && left.every((token, index) => token === right[index]);
  };
  return (
    (loaded.isDraft === true) !== locked.isDraft ||
    (loaded.frames ?? null) !== (locked.frames ?? null) ||
    (loaded.framesCount ?? 1) !== (locked.framesCount ?? 1) ||
    (loaded.angle ?? null) !== (locked.angle ?? null) ||
    !sameRules(loaded.characteristics, locked.characteristics) ||
    (usesAuroraNoMatchDescription(boardType) && (loaded.description ?? '') !== (locked.description ?? ''))
  );
}
