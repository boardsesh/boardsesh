import type { SqlExecutor } from '@boardsesh/offline-sync';

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
 * The revision numbers the phone holds for a set of climbs, keyed by climb
 * uuid. One primary-key read per 400 climbs; a climb the phone has no row for,
 * or holds neither number for, is left out of the map.
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
      revision_number: number | null;
      holds_revision_number: number | null;
    }>(
      `SELECT uuid, revision_number, holds_revision_number
       FROM board_climbs
       WHERE board_type = ? AND uuid IN (${chunk.map(() => '?').join(', ')})
         AND (revision_number IS NOT NULL OR holds_revision_number IS NOT NULL)`,
      [boardType, ...chunk],
    );
    for (const row of rows) {
      numbersByClimb.set(row.uuid, {
        revisionNumber: positiveIntegerOrNull(row.revision_number),
        holdsRevisionNumber: positiveIntegerOrNull(row.holds_revision_number),
      });
    }
  }
  return numbersByClimb;
}

/**
 * Which version each of the climber's own ticks on these climbs was logged on,
 * keyed by tick uuid. Ticks with no known version are left out.
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
): Promise<Map<string, number>> {
  const revisionByTick = new Map<string, number>();
  for (const chunk of chunkUuids(climbUuids)) {
    const rows = await db.getAllAsync<{ uuid: string; climb_revision: number | null }>(
      `SELECT uuid, climb_revision
       FROM boardsesh_ticks
       WHERE board_type = ? AND climb_uuid IN (${chunk.map(() => '?').join(', ')})
         AND (user_id = ? OR user_id IS NULL)
         AND climb_revision IS NOT NULL`,
      [boardType, ...chunk, ownerUserId],
    );
    for (const row of rows) {
      const revision = positiveIntegerOrNull(row.climb_revision);
      if (revision !== null) revisionByTick.set(row.uuid, revision);
    }
  }
  return revisionByTick;
}

type ClimbWithRevisionNumbers = {
  uuid: string;
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
  return climbs.map((climb) => {
    const local = numbersByClimb.get(climb.uuid);
    if (!local) return climb;
    const revisionNumber = climb.revisionNumber ?? local.revisionNumber;
    const holdsRevisionNumber = climb.holdsRevisionNumber ?? local.holdsRevisionNumber;
    if (
      revisionNumber === (climb.revisionNumber ?? null) &&
      holdsRevisionNumber === (climb.holdsRevisionNumber ?? null)
    ) {
      return climb;
    }
    return { ...climb, revisionNumber, holdsRevisionNumber };
  });
}
