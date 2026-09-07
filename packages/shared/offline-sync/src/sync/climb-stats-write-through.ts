// The stream's write-through into local `board_climb_stats` (issue #5227).
//
// The layout-wide `climbStatsUpdated` subscription already repairs the
// in-memory stats store, so a row that is on screen updates live. Everything
// else on a downloaded board — a list re-read, pull-to-refresh, the grade and
// ascent filters, sort-by-ascents, the count, the climb detail — reads SQLite,
// and the pull deliberately skips server rows younger than
// SYNC_STABILITY_WINDOW_SECONDS. That makes this the only prompt local writer
// for a fresh recompute, including for the tick the device itself just logged.
//
// Three properties the SQL carries, all of them load-bearing:
//
//   1. `WHERE EXISTS (board_climbs …)` — the channel is global per layout, so
//      events arrive for climbs this device never downloaded, and for climbs a
//      scope teardown removed while the event was in flight. Teardown deletes
//      stats rows by joining board_climbs and never sweeps orphans
//      (sync/scope-teardown.ts), so an unguarded upsert would leave a row no
//      later teardown can find.
//   2. `excluded.sync_seq > COALESCE(sync_seq, -1)` — strictly greater. The
//      publisher fires on every debounced pass while `sync_seq` only bumps on a
//      client-visible column change, so equal-revision republishes are normal
//      and must not rewrite a row. A local NULL (never observed in practice —
//      the server column is NOT NULL and both the pull and the snapshot carry
//      it) still loses to any valid revision.
//   3. `updated_at` epoch on INSERT, untouched on UPDATE. `updated_at` is the
//      pull cursor column, and this write does NOT advance sync state: a row
//      stamped "now" would sit ahead of the checkpoint, so a tombstone
//      (`updated_at <= ?`) and snapshot reconcile could never delete it again.
//      The epoch is older than every checkpoint, so both can.
//
// The write runs on its OWN connection (withExclusiveTransactionAsync) with a
// 250 ms immediate lock. A lost lock drops the event; the next pull heals the
// row. There is deliberately no retry ladder — a retry would only queue behind
// the same holder — and never a 5 s wait, which on the main connection would
// stall every local-first read behind it.

import type { OfflineDatabase } from '../database';
import { beginImmediateWrite } from '../db/pragmas';
import { isDatabaseLockedError } from '../db/lock-errors';

/**
 * One `ClimbStatsEvent` as this module needs it. Declared structurally rather
 * than imported: `@boardsesh/shared-schema` is only a devDependency here, and
 * the engine takes no runtime dependencies. `ClimbStatsEvent` is assignable to
 * it (asserted in the test), minus the `difficulty` label, which is a rendering
 * of `displayDifficulty` and has no local column.
 */
export type ClimbStatsWriteThroughInput = {
  boardType: string;
  layoutId: number;
  climbUuid: string;
  angle: number;
  ascensionistCount: number;
  qualityAverage: number | null;
  difficultyAverage: number | null;
  displayDifficulty: number | null;
  faUsername: string | null;
  faAt: string | null;
  syncSeq: string;
};

/**
 * Why a write did or did not land.
 *
 * `stale` covers both "the event is not newer" and "the climb vanished between
 * the size read and the write" — both end as zero changed rows, and both mean
 * the caller must not refresh anything.
 */
export type ClimbStatsWriteThroughStatus = 'applied' | 'stale' | 'climb_not_local' | 'invalid_revision' | 'lock_lost';

export type ClimbStatsWriteThroughResult = {
  status: ClimbStatsWriteThroughStatus;
  /**
   * The local climb's `compatible_size_ids`, so the caller can decide whether
   * the browsed size is affected without a second read. Null when the climb is
   * not local, or when the column is NULL / not a number array.
   */
  compatibleSizeIds: number[] | null;
};

/** Columns this write owns. Everything else on the row is the pull's business. */
export const CLIMB_STATS_WRITE_THROUGH_COLUMNS = [
  'board_type',
  'climb_uuid',
  'angle',
  'display_difficulty',
  'ascensionist_count',
  'difficulty_average',
  'quality_average',
  'sync_seq',
] as const;

/**
 * Columns the write never touches on an existing row. The event carries no
 * `benchmarkDifficulty` (the recompute never writes it), its `faAt` is raw
 * Postgres text where the pull stores an ISO string, and `updated_at` is the
 * sync cursor — see the epoch note above. Together with the written columns
 * this is exactly `TABLE_CONFIGS.board_climb_stats.localColumns` (asserted).
 */
export const CLIMB_STATS_WRITE_THROUGH_UNTOUCHED_COLUMNS = [
  'benchmark_difficulty',
  'fa_username',
  'fa_at',
  'updated_at',
] as const;

/**
 * How long the write waits for the single-writer lock before giving up. Short
 * on purpose: the event is disposable (the next pull carries the same row),
 * and a stats event must never be the reason a user-facing write waits.
 */
export const CLIMB_STATS_WRITE_THROUGH_LOCK_TIMEOUT_MS = 250;

/**
 * The engine's "older than every checkpoint" watermark, stamped on INSERT only.
 */
const EPOCH_UPDATED_AT = '1970-01-01T00:00:00.000Z';

const UPSERT_SQL = `INSERT INTO board_climb_stats (board_type, climb_uuid, angle, display_difficulty, ascensionist_count,
  difficulty_average, quality_average, sync_seq, updated_at)
SELECT ?, ?, ?, ?, ?, ?, ?, ?, '${EPOCH_UPDATED_AT}'
WHERE EXISTS (SELECT 1 FROM board_climbs WHERE board_type = ? AND uuid = ?)
ON CONFLICT(board_type, climb_uuid, angle) DO UPDATE SET
  display_difficulty = excluded.display_difficulty,
  ascensionist_count = excluded.ascensionist_count,
  difficulty_average = excluded.difficulty_average,
  quality_average = excluded.quality_average,
  sync_seq = excluded.sync_seq
WHERE excluded.sync_seq > COALESCE(board_climb_stats.sync_seq, -1)`;

/**
 * Decimal digits with no leading zero — the wire shape of a Postgres bigint.
 * Mirrors `validRevision` in `@boardsesh/board-react`'s climb-stats-store.ts:
 * offline-sync cannot import board-react, and the two must agree, or the store
 * and the local row would disagree about which events count as revisions.
 */
const REVISION_PATTERN = /^(0|[1-9]\d*)$/;

/**
 * `syncSeq` as the number the SQLite INTEGER column can hold, or null when the
 * string is not a revision we can compare.
 *
 * The wire type is decimal text because a Postgres bigint outruns a JS number.
 * The local column is a 64-bit SQLite INTEGER, but the bind value has to pass
 * through a JS number, so anything past `Number.MAX_SAFE_INTEGER` is rejected
 * rather than silently rounded into the wrong revision. Real `sync_seq` values
 * are a per-table sequence, nowhere near that bound; a value that reaches it is
 * a bug worth dropping the event over, and the next pull writes the row anyway.
 */
export function parseClimbStatsRevision(syncSeq: string): number | null {
  if (!REVISION_PATTERN.test(syncSeq)) return null;
  const revision = Number(syncSeq);
  return Number.isSafeInteger(revision) ? revision : null;
}

function parseCompatibleSizeIds(raw: string | null | undefined): number[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const sizeIds = parsed.filter((sizeId): sizeId is number => typeof sizeId === 'number' && Number.isFinite(sizeId));
    return sizeIds.length > 0 ? sizeIds : null;
  } catch {
    return null;
  }
}

/**
 * True for the failures that mean "another writer had the file" — contention,
 * or a database closed underneath us by a sign-out wipe or a hot reload. Both
 * are ordinary and silent: the event is dropped and the next pull heals.
 */
function isDroppableWriteFailure(error: unknown): boolean {
  if (isDatabaseLockedError(error)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /database is closed|access to closed resource/i.test(message);
}

/**
 * Write one live stats event into local `board_climb_stats`.
 *
 * Never throws for contention or a closed database; any other SQLite failure
 * propagates so the caller can report it once.
 */
export async function writeClimbStatsEvent(
  db: OfflineDatabase,
  event: ClimbStatsWriteThroughInput,
): Promise<ClimbStatsWriteThroughResult> {
  const revision = parseClimbStatsRevision(event.syncSeq);
  if (revision === null) return { status: 'invalid_revision', compatibleSizeIds: null };

  // Autocommit read on the main connection. The common case for a global
  // layout stream is a climb this device never downloaded, and that case must
  // not open a write connection at all. The write below re-checks existence
  // atomically, so this read is only the size hint.
  const climbRow = await db.getFirstAsync<{ compatible_size_ids: string | null }>(
    'SELECT compatible_size_ids FROM board_climbs WHERE board_type = ? AND uuid = ?',
    [event.boardType, event.climbUuid],
  );
  if (!climbRow) return { status: 'climb_not_local', compatibleSizeIds: null };

  const compatibleSizeIds = parseCompatibleSizeIds(climbRow.compatible_size_ids);

  let changes = 0;
  try {
    await db.withExclusiveTransactionAsync(async (txn) => {
      await beginImmediateWrite(txn, CLIMB_STATS_WRITE_THROUGH_LOCK_TIMEOUT_MS);
      const result = await txn.runAsync(UPSERT_SQL, [
        event.boardType,
        event.climbUuid,
        event.angle,
        event.displayDifficulty,
        event.ascensionistCount,
        event.difficultyAverage,
        event.qualityAverage,
        revision,
        event.boardType,
        event.climbUuid,
      ]);
      changes = result.changes;
    });
  } catch (error) {
    if (isDroppableWriteFailure(error)) return { status: 'lock_lost', compatibleSizeIds };
    throw error;
  }

  return { status: changes > 0 ? 'applied' : 'stale', compatibleSizeIds };
}
