import { and, asc, eq, gt, inArray, isNull, max } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { MAX_REVISIONS_PER_CLIMB } from '@boardsesh/board-config';
import type { BoardName } from '@boardsesh/board-constants';
import * as dbSchema from '@boardsesh/db/schema';
import type { ClimbRevisionChange } from '@boardsesh/db/schema';
import { usesAuroraNoMatchDescription, withNoMatch } from '@boardsesh/shared-schema';
import { lockWallForWrite } from '../board/spray-walls';
import { buildStoredRuleSignature, parseFramesToHoldEntries } from './climb-similarity';
import { isSprayBoard, type SprayClimbTarget } from './spray-authoring';

/**
 * The write half of climb revision history (#5955). The table and what a row
 * means are described on `boardClimbRevisions` in `@boardsesh/db`.
 *
 * `updateClimb` calls two functions, both inside its transaction:
 *
 *  1. {@link lockClimbForRevision} before its UPDATE. Locks the climb row and
 *     returns the climb as it stands.
 *  2. {@link recordClimbRevision} after its last write. Re-reads the row, works
 *     out what changed, and writes the revision row(s).
 *
 * Both sides of the comparison are read from the database under the row lock,
 * never taken from the request or from the row `updateClimb` loaded before its
 * transaction opened. A spray climb has more than one possible editor (the setter
 * and anyone who can edit the wall), so two edits can be in flight at once, and
 * the second one's pre-transaction read is of a climb the first has since changed.
 */

type DrizzleExecutor = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** The editable state of a climb at one moment, plus what decides whether it records. */
export type ClimbRevisionState = {
  /** The setter. Never the caller: a wall editor's edit leaves this alone. */
  userId: string | null;
  isDraft: boolean;
  publishedAt: string | null;
  createdAt: string | null;
  name: string | null;
  description: string | null;
  frames: string | null;
  framesCount: number | null;
  framesPace: number | null;
  angle: number | null;
  characteristics: string[] | null;
  /** The setter grade. Spray only; null on every other board. */
  difficultyId: number | null;
};

async function readClimbRevisionState(
  executor: DrizzleExecutor,
  boardType: BoardName,
  climbUuid: string,
  lock: boolean,
): Promise<ClimbRevisionState | null> {
  const query = executor
    .select({
      userId: dbSchema.boardClimbs.userId,
      isDraft: dbSchema.boardClimbs.isDraft,
      publishedAt: dbSchema.boardClimbs.publishedAt,
      createdAt: dbSchema.boardClimbs.createdAt,
      name: dbSchema.boardClimbs.name,
      description: dbSchema.boardClimbs.description,
      frames: dbSchema.boardClimbs.frames,
      framesCount: dbSchema.boardClimbs.framesCount,
      framesPace: dbSchema.boardClimbs.framesPace,
      angle: dbSchema.boardClimbs.angle,
      characteristics: dbSchema.boardClimbs.characteristics,
    })
    .from(dbSchema.boardClimbs)
    .where(and(eq(dbSchema.boardClimbs.uuid, climbUuid), eq(dbSchema.boardClimbs.boardType, boardType)))
    .limit(1);
  const [row] = await (lock ? query.for('no key update') : query);
  if (!row) return null;

  // The setter grade lives on the stats row at the climb's angle, not on the
  // climb. Only spray: everywhere else the grade is not the editor's to change.
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
 * Lock the climb row for this transaction and return it as it stands.
 *
 * `SELECT … FOR NO KEY UPDATE`, so a second `updateClimb` on the same climb waits
 * here until the first commits and then reads the first one's result. That is
 * what makes `max(revision_number) + 1` in {@link recordClimbRevision} safe, and
 * what makes the "before" side of the diff the true predecessor.
 *
 * `NO KEY UPDATE` rather than `UPDATE`: it is the lock the caller's own UPDATE
 * takes a moment later (it never touches the uuid), it queues two editors just
 * the same, and unlike `FOR UPDATE` it does not block an insert into a table that
 * references this climb for as long as the edit runs. A draft delete still
 * waits for it.
 *
 * Call it AFTER the spray wall lock. Every writer that takes both takes the wall
 * first (a reset holds the wall lock while it rewrites `missing_hold_count` on
 * the wall's climbs), so row-then-wall here would be a deadlock waiting for one.
 *
 * Null when the row is gone, which a draft deleted mid-edit can do.
 */
export async function lockClimbForRevision(
  executor: DrizzleExecutor,
  boardType: BoardName,
  climbUuid: string,
): Promise<ClimbRevisionState | null> {
  return readClimbRevisionState(executor, boardType, climbUuid, true);
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
 *  - `notAllowed`: the caller is neither the setter nor, on a spray wall, someone
 *    who can edit the wall. One code for every such caller, for the same reason
 *    there is one message: it must not say whether a wall exists.
 *  - `windowExpired`: a published catalogue climb, past 24 hours.
 *  - `notEditable`: a published catalogue climb with no publish date on record.
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
 * what signature to run the duplicate gate. With two possible editors on a spray
 * wall, another edit can commit in between, and every one of those decisions is
 * then about a climb that no longer exists. The worst case writes the old frames
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
  locked: ClimbRevisionState,
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

/**
 * What changed between two states of one climb.
 *
 * Compared on what a climber would call different, not on bytes:
 *
 *  - a null and an empty description are the same description;
 *  - on the Aurora boards the "No match" description prefix is a rule, not prose,
 *    so it is stripped before descriptions are compared and counted under `rules`
 *    instead. Without that, the first edit to move the legacy prefix into the
 *    `characteristics` array would report a description change nobody made.
 */
export function diffClimbRevisionStates(
  boardType: BoardName,
  before: ClimbRevisionState,
  after: ClimbRevisionState,
): ClimbRevisionChange[] {
  const prose = (description: string | null): string =>
    usesAuroraNoMatchDescription(boardType) ? withNoMatch(description, false) : (description ?? '');

  const changes: ClimbRevisionChange[] = [];
  if ((before.name ?? '') !== (after.name ?? '')) changes.push('name');
  if (prose(before.description) !== prose(after.description)) changes.push('description');
  if (
    (before.frames ?? '') !== (after.frames ?? '') ||
    (before.framesCount ?? 1) !== (after.framesCount ?? 1) ||
    (before.framesPace ?? 0) !== (after.framesPace ?? 0)
  ) {
    changes.push('holds');
  }
  if (before.difficultyId !== after.difficultyId) changes.push('grade');
  if (before.angle !== after.angle) changes.push('angle');
  if (
    buildStoredRuleSignature(boardType, before.characteristics, before.description) !==
    buildStoredRuleSignature(boardType, after.characteristics, after.description)
  ) {
    changes.push('rules');
  }
  return changes;
}

/**
 * Whether the holds themselves differ between two states: the frames, or how
 * many frames there are.
 *
 * Narrower than the `holds` entry {@link diffClimbRevisionStates} reports, which
 * also covers `framesPace`. The pace is how fast a multi-frame route plays, not
 * where the holds are, so a pace-only edit is a revision but the climb is still
 * the same climb to anyone who sent it. This is what moves
 * `board_climbs.holds_revision_number` (#6023).
 */
export function holdsMoved(
  before: Pick<ClimbRevisionState, 'frames' | 'framesCount'>,
  after: Pick<ClimbRevisionState, 'frames' | 'framesCount'>,
): boolean {
  return (before.frames ?? '') !== (after.frames ?? '') || (before.framesCount ?? 1) !== (after.framesCount ?? 1);
}

/** The wall's published version id, read under the wall lock. */
async function currentWallVersionId(executor: DrizzleExecutor, wallId: number): Promise<number | null> {
  // Re-entrant within the transaction, so this costs nothing when the caller
  // already holds it, and it keeps the read correct for a caller that does not.
  await lockWallForWrite(executor, wallId);
  const [wall] = await executor
    .select({ currentVersionId: dbSchema.sprayWalls.currentVersionId })
    .from(dbSchema.sprayWalls)
    .where(and(eq(dbSchema.sprayWalls.id, wallId), isNull(dbSchema.sprayWalls.deletedAt)))
    .limit(1);
  return wall?.currentVersionId ?? null;
}

/**
 * The wall version a climb was FIRST PUBLISHED on, worked out after the fact.
 *
 * Nothing recorded it at the time: revisions are written lazily, so revision 1 is
 * created by the climb's first edit, which can be several resets later. Two facts
 * narrow it down:
 *
 *  - every hold in the climb was on the wall in that version, because `saveClimb`
 *    refuses a hold that is not. That gives a set of candidate versions;
 *  - the version was already published when the climb was. Among the candidates,
 *    the newest one published at or before the climb's `published_at` is it.
 *
 * When no candidate is that old (clock skew, or a climb whose timestamp does not
 * parse) the OLDEST candidate is used: the climb cannot have been set before its
 * holds were on the wall. With no candidate at all the answer is null and the
 * client shows the revision without a board, which is better than drawing it on
 * a photograph it was never set against.
 *
 * Only versions that landed (published or superseded) are candidates, and a
 * draft's installs and removals are ignored, matching `aliveHolds`.
 */
async function originalWallVersionId(
  executor: DrizzleExecutor,
  wallId: number,
  published: Pick<ClimbRevisionState, 'frames' | 'publishedAt'>,
): Promise<number | null> {
  const versions = await executor
    .select({
      id: dbSchema.sprayWallVersions.id,
      versionNumber: dbSchema.sprayWallVersions.versionNumber,
      status: dbSchema.sprayWallVersions.status,
      publishedAt: dbSchema.sprayWallVersions.publishedAt,
    })
    .from(dbSchema.sprayWallVersions)
    .where(eq(dbSchema.sprayWallVersions.wallId, wallId))
    .orderBy(asc(dbSchema.sprayWallVersions.versionNumber));
  const versionById = new Map(versions.map((version) => [version.id, version]));
  const landedVersions = versions.filter((version) => version.status !== 'draft');
  if (landedVersions.length === 0) return null;

  const holdIds = [...new Set(parseFramesToHoldEntries('spray', published.frames ?? '').map((entry) => entry.holdId))];
  const holds =
    holdIds.length === 0
      ? []
      : await executor
          .select({
            holdId: dbSchema.sprayWallHolds.holdId,
            installedVersionId: dbSchema.sprayWallHolds.installedVersionId,
            removedVersionId: dbSchema.sprayWallHolds.removedVersionId,
          })
          .from(dbSchema.sprayWallHolds)
          .where(and(eq(dbSchema.sprayWallHolds.wallId, wallId), inArray(dbSchema.sprayWallHolds.holdId, holdIds)));
  // A hold id this wall has never had: there is no version the climb fits.
  if (holds.length !== holdIds.length) return null;

  const candidates = landedVersions.filter((version) =>
    holds.every((hold) => {
      const installed = versionById.get(hold.installedVersionId);
      if (!installed || installed.status === 'draft' || installed.versionNumber > version.versionNumber) return false;
      if (hold.removedVersionId == null) return true;
      const removed = versionById.get(hold.removedVersionId);
      return !removed || removed.status === 'draft' || removed.versionNumber > version.versionNumber;
    }),
  );
  if (candidates.length === 0) return null;

  const publishedMs = published.publishedAt ? Date.parse(published.publishedAt) : Number.NaN;
  const oldEnough = Number.isFinite(publishedMs)
    ? candidates.filter((version) => version.publishedAt != null && version.publishedAt.getTime() <= publishedMs)
    : [];
  return (oldEnough.at(-1) ?? candidates[0]).id;
}

function snapshotColumns(state: ClimbRevisionState) {
  return {
    name: state.name,
    description: state.description,
    frames: state.frames,
    framesCount: state.framesCount,
    framesPace: state.framesPace,
    angle: state.angle,
    characteristics: state.characteristics,
    difficultyId: state.difficultyId,
  };
}

/** When the climb was published, as a Date; its creation time, then now, when that does not parse. */
function publishedDate(state: ClimbRevisionState): Date {
  for (const candidate of [state.publishedAt, state.createdAt]) {
    const parsed = candidate ? Date.parse(candidate) : Number.NaN;
    if (Number.isFinite(parsed)) return new Date(parsed);
  }
  return new Date();
}

/**
 * Record the edit `updateClimb` just made, if it was one worth recording.
 *
 * `before` is what {@link lockClimbForRevision} returned earlier in this same
 * transaction. The "after" side is read here, off the row the caller has just
 * written, so the snapshot is what is stored and not what was asked for.
 *
 * Records nothing when:
 *
 *  - the climb was a draft before this edit. That covers every edit to a draft
 *    AND the save that publishes it: history starts at publication;
 *  - nothing changed. A save that rewrites the same values is not an edit.
 *
 * The first recorded edit writes two rows: revision 1 from `before` (dated to
 * the climb's `published_at`, credited to its setter) and revision 2 from the new
 * state. Every later edit writes one.
 *
 * Past `MAX_REVISIONS_PER_CLIMB` the oldest rows other than revision 1 are
 * deleted. An edit is never refused for being one too many.
 *
 * A recorded edit also moves `board_climbs.revision_number` to the new number,
 * and `holds_revision_number` with it when {@link holdsMoved}.
 */
export async function recordClimbRevision(
  executor: DrizzleExecutor,
  params: {
    boardType: BoardName;
    climbUuid: string;
    before: ClimbRevisionState;
    /** The caller. On a spray wall this may be a wall editor rather than the setter. */
    editorId: string;
    sprayTarget: Pick<SprayClimbTarget, 'wallId'> | null;
  },
): Promise<void> {
  const { boardType, climbUuid, before, editorId, sprayTarget } = params;
  if (before.isDraft) return;

  const after = await readClimbRevisionState(executor, boardType, climbUuid, false);
  if (!after || after.isDraft) return;

  const changes = diffClimbRevisionStates(boardType, before, after);
  if (changes.length === 0) return;

  const revisionKey = and(
    eq(dbSchema.boardClimbRevisions.climbUuid, climbUuid),
    eq(dbSchema.boardClimbRevisions.boardType, boardType),
  );
  const [latest] = await executor
    .select({ revisionNumber: max(dbSchema.boardClimbRevisions.revisionNumber) })
    .from(dbSchema.boardClimbRevisions)
    .where(revisionKey);

  let nextRevisionNumber = (latest?.revisionNumber ?? 0) + 1;
  if (latest?.revisionNumber == null) {
    await executor.insert(dbSchema.boardClimbRevisions).values({
      boardType,
      climbUuid,
      revisionNumber: 1,
      ...snapshotColumns(before),
      sprayWallVersionId: sprayTarget ? await originalWallVersionId(executor, sprayTarget.wallId, before) : null,
      changes: [],
      editedBy: before.userId,
      createdAt: publishedDate(before),
    });
    nextRevisionNumber = 2;
  }

  await executor.insert(dbSchema.boardClimbRevisions).values({
    boardType,
    climbUuid,
    revisionNumber: nextRevisionNumber,
    ...snapshotColumns(after),
    sprayWallVersionId: sprayTarget ? await currentWallVersionId(executor, sprayTarget.wallId) : null,
    changes,
    editedBy: editorId,
  });

  // Keep the climb's own copy of its revision in step with the row just written
  // (#6023), so `saveTick` can stamp a tick with one primary-key read. A second
  // UPDATE rather than columns on the caller's: the number is only known here,
  // after the stats row is read back and the diff says this save was an edit at
  // all. It fires `trg_board_climbs_set_sync_fields` once more, which is wanted
  // when the caller's UPDATE changed nothing on the row (a spray regrade lives
  // on the stats row), because `syncClimbs` has to re-deliver the new number.
  await executor
    .update(dbSchema.boardClimbs)
    .set({
      revisionNumber: nextRevisionNumber,
      ...(holdsMoved(before, after) ? { holdsRevisionNumber: nextRevisionNumber } : {}),
    })
    .where(and(eq(dbSchema.boardClimbs.uuid, climbUuid), eq(dbSchema.boardClimbs.boardType, boardType)));

  // Prune. Revision 1 is never a candidate, so the climb as first published is
  // always there to compare the latest against.
  const prunable = await executor
    .select({ revisionNumber: dbSchema.boardClimbRevisions.revisionNumber })
    .from(dbSchema.boardClimbRevisions)
    .where(and(revisionKey, gt(dbSchema.boardClimbRevisions.revisionNumber, 1)))
    .orderBy(asc(dbSchema.boardClimbRevisions.revisionNumber));
  const excess = prunable.length + 1 - MAX_REVISIONS_PER_CLIMB;
  if (excess > 0) {
    await executor.delete(dbSchema.boardClimbRevisions).where(
      and(
        revisionKey,
        inArray(
          dbSchema.boardClimbRevisions.revisionNumber,
          prunable.slice(0, excess).map((row) => row.revisionNumber),
        ),
      ),
    );
  }
}
