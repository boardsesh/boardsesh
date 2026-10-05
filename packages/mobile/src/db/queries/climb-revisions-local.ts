import type { SqlExecutor } from '@boardsesh/offline-sync';
import { localRevisionMatchingFrames } from '../../lib/tick-climb-revision';

/**
 * Climb revisions on the device (#6023).
 *
 * Three nullable columns arrive with the sync: `board_climbs.revision_number`
 * and `holds_revision_number` (which version a climb is on, and the version at
 * which its holds last moved) and `boardsesh_ticks.climb_revision` (which
 * version a tick was logged on). NULL means unknown: a row pulled before SQLite
 * migration v11 and not delivered again since.
 *
 * Everything that reads those columns outside a sync write lives here, so the
 * NULL rule is written once.
 */

/** The tick aliases the local readers use. A literal union so no runtime string reaches the SQL. */
export type LocalTickAlias = 't' | 'rating_below' | 'rating_newer';

/**
 * "This tick was logged on the holds the climb has now", the on-device copy of
 * `tickOnCurrentHoldsSql` in `packages/db/src/queries/climb-stats/holds-epoch.ts`.
 *
 * Both sides COALESCE to 1 here. The server column is NOT NULL so it only
 * guards the tick; on the phone the climb's column is NULL until the row is
 * delivered again, and a NULL comparison would drop every tick on that climb.
 * A NULL tick is an import or older than the column, and no climb had been
 * edited then, so 1 is exact for it.
 *
 * `climbAlias` is the `board_climbs` row the caller is already correlated to.
 */
export function tickOnCurrentHoldsLocalSql(tickAlias: LocalTickAlias, climbAlias: 'c' = 'c'): string {
  return `COALESCE(${tickAlias}.climb_revision, 1) >= COALESCE(${climbAlias}.holds_revision_number, 1)`;
}

export type LocalClimbRevisionNumbers = {
  /** `board_climbs.revision_number`; null when the phone has not been told. */
  revisionNumber: number | null;
  /** `board_climbs.holds_revision_number`; null when the phone has not been told. */
  holdsRevisionNumber: number | null;
  /**
   * `board_climbs.frames` of the same row, read in the same statement. The
   * version is only a witness for a climb showing these holds; see
   * `localRevisionMatchingFrames`.
   */
  frames: string | null;
};

// SQLite's default bound-parameter limit is 999 on older builds. Two binds are
// spent on the board type across the readers below, so stay well under it.
const UUIDS_PER_STATEMENT = 400;

function chunkUuids(uuids: readonly string[]): string[][] {
  const unique = [...new Set(uuids)];
  const chunks: string[][] = [];
  for (let start = 0; start < unique.length; start += UUIDS_PER_STATEMENT) {
    chunks.push(unique.slice(start, start + UUIDS_PER_STATEMENT));
  }
  return chunks;
}

function positiveIntegerOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : null;
}

/**
 * The revision numbers the phone holds for a set of climbs, with the frames of
 * the same row, keyed by climb uuid. One primary-key read per 400 climbs; a
 * climb the phone has no row for, or holds neither number for, is left out of
 * the map.
 */
export async function readClimbRevisionNumbersLocal(
  db: SqlExecutor,
  boardType: string,
  climbUuids: readonly string[],
): Promise<Map<string, LocalClimbRevisionNumbers>> {
  const numbersByClimb = new Map<string, LocalClimbRevisionNumbers>();
  for (const chunk of chunkUuids(climbUuids)) {
    const rows = await db.getAllAsync<{
      uuid: string;
      frames: string | null;
      revision_number: number | null;
      holds_revision_number: number | null;
    }>(
      `SELECT uuid, frames, revision_number, holds_revision_number
       FROM board_climbs
       WHERE board_type = ? AND uuid IN (${chunk.map(() => '?').join(', ')})
         AND (revision_number IS NOT NULL OR holds_revision_number IS NOT NULL)`,
      [boardType, ...chunk],
    );
    for (const row of rows) {
      numbersByClimb.set(row.uuid, {
        revisionNumber: positiveIntegerOrNull(row.revision_number),
        holdsRevisionNumber: positiveIntegerOrNull(row.holds_revision_number),
        frames: row.frames ?? null,
      });
    }
  }
  return numbersByClimb;
}

/**
 * Which version each of the climber's own ticks on these climbs was logged on,
 * keyed by tick uuid. Three answers, and callers must keep them apart
 * (`isTickOnCurrentHolds` in `@boardsesh/logbook`):
 *
 * - a number: the tick's version.
 * - `null`: the phone holds the tick, the server delivered it, and it has no
 *   version. That is an import or a tick older than the field, and it reads as
 *   version 1.
 * - no key: the phone cannot say. Either it holds no row for the tick (not
 *   pulled yet), or the row is this phone's own write that the server has not
 *   answered for: a tick still in the outbox has a NULL version only because
 *   the app did not know one when it was logged, not because it has none.
 *
 * `ownerUserId` is the `local_user_id` stamp, as in every other local tick
 * read (docs/offline-reads.md): rows a failed sign-out wipe left behind must
 * not answer for the next account.
 */
export async function readTickRevisionsLocal(
  db: SqlExecutor,
  boardType: string,
  climbUuids: readonly string[],
  ownerUserId: string | null,
): Promise<Map<string, number | null>> {
  const revisionByTick = new Map<string, number | null>();
  for (const chunk of chunkUuids(climbUuids)) {
    const rows = await db.getAllAsync<{ uuid: string; climb_revision: number | null }>(
      `SELECT t.uuid, t.climb_revision
       FROM boardsesh_ticks t
       WHERE t.board_type = ? AND t.climb_uuid IN (${chunk.map(() => '?').join(', ')})
         AND (t.user_id = ? OR t.user_id IS NULL)
         AND (t.climb_revision IS NOT NULL OR NOT EXISTS (
           SELECT 1 FROM pending_mutations m
           WHERE m.idempotency_key = t.uuid AND m.table_name = 'boardsesh_ticks'))`,
      [boardType, ...chunk, ownerUserId],
    );
    for (const row of rows) {
      revisionByTick.set(row.uuid, positiveIntegerOrNull(row.climb_revision));
    }
  }
  return revisionByTick;
}

type ClimbWithRevisionNumbers = {
  uuid: string;
  frames?: string | null;
  revisionNumber?: number | null;
  holdsRevisionNumber?: number | null;
};

/**
 * Fill in the revision numbers on climbs that arrived without them.
 *
 * The search, detail and queue documents are pinned by the App Store screenshot
 * fixtures and cannot select `revisionNumber` until those are recorded again,
 * so a climb read over the network carries no number. The phone's own copy of
 * the climb does, once the board is downloaded. A number the climb already
 * carries wins; a climb the phone does not hold is returned as it came.
 *
 * The two numbers are filled under different rules, because they are used for
 * different things:
 *
 * - `revisionNumber` is what a tick is stamped with, so it is filled only when
 *   the phone's row has the same frames as the climb (see
 *   `localRevisionMatchingFrames`). A network answer newer than the phone's
 *   last pull keeps no number, and its ticks are sent without one.
 * - `holdsRevisionNumber` is only ever compared against the climber's own
 *   ticks to decide whether a send still counts, and it is filled whatever the
 *   frames. The phone's value is a past value of a number that only goes up,
 *   so it is never above the true one, and a threshold that is too low can only
 *   count a tick that should have been dropped, never drop one that counts. A
 *   frames check here would swap a low threshold for none at all.
 *
 * Returns the same array when nothing changed, so a caller's memo holds.
 */
export async function fillClimbRevisionNumbersLocal<TClimb extends ClimbWithRevisionNumbers>(
  db: SqlExecutor,
  boardType: string,
  climbs: readonly TClimb[],
): Promise<readonly TClimb[]> {
  const missing = climbs.filter((climb) => climb.revisionNumber == null || climb.holdsRevisionNumber == null);
  if (missing.length === 0) return climbs;
  const numbersByClimb = await readClimbRevisionNumbersLocal(
    db,
    boardType,
    missing.map((climb) => climb.uuid),
  );
  if (numbersByClimb.size === 0) return climbs;
  let changed = false;
  const filled = climbs.map((climb) => {
    const local = numbersByClimb.get(climb.uuid);
    if (!local) return climb;
    const revisionNumber = climb.revisionNumber ?? localRevisionMatchingFrames(local, climb.frames);
    const holdsRevisionNumber = climb.holdsRevisionNumber ?? local.holdsRevisionNumber;
    if (
      revisionNumber === (climb.revisionNumber ?? null) &&
      holdsRevisionNumber === (climb.holdsRevisionNumber ?? null)
    ) {
      return climb;
    }
    changed = true;
    return { ...climb, revisionNumber, holdsRevisionNumber };
  });
  return changed ? filled : climbs;
}
