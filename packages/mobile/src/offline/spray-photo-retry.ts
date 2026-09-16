import { getCheckpointKey, offlineBoardKey, type OfflineDatabase } from '@boardsesh/offline-sync';
import { spraySizeIdForLayout } from '@boardsesh/board-config';

/**
 * Making a failed wall-photo download retry itself (issue #5448).
 *
 * ## The hole this closes
 *
 * The photograph is fetched from a presigned URL that arrives WITH the wall's
 * row, and `syncSprayWalls` pages on a strict `(updated_at, sync_seq) >` cursor.
 * So when the download fails — a dead signature, a full disk, a dropped
 * connection between the row landing and the bytes arriving — the cursor has
 * already advanced past the wall, the scope is marked complete, and an unchanged
 * wall is never offered again. The climber is told the board is downloaded and
 * then drives to a garage with no signal and no photograph: exactly the case
 * this whole slice exists to serve.
 *
 * ## Why rewinding the cursor is the retry
 *
 * The obvious alternative — remember the URL and try it again later — cannot
 * work: the signature is dead in fifteen minutes and the bucket is private, so a
 * retry needs a FRESH one, and only the sync page mints those. Rewinding this
 * one table's checkpoint for this one scope re-offers the row on the next cycle
 * with a new signature attached, using machinery that already exists. The cost
 * is bounded by construction: a spray scope's page carries at most one wall, so
 * a retry is one small query per cycle, and only while a photo is actually
 * missing.
 *
 * ## Why it is bounded
 *
 * A photograph that can never be stored — the object is gone from the bucket,
 * the disk is permanently full — would otherwise rewind forever. The attempt
 * count is kept per wall in `sync_meta`, capped, and reset when the wall
 * publishes a new photo (a new `photo_key` is a new problem, not the old one
 * continuing). Past the cap the marker stays so the next reset re-arms it, but
 * nothing rewinds any more.
 */

/** `sync_meta` key prefix holding one pending-photo record per wall. */
export const SPRAY_PHOTO_PENDING_PREFIX = 'spray-photo-pending:';

/**
 * How many cycles a failing photograph is allowed to rewind the wall cursor.
 *
 * Eight is roughly four minutes of a foregrounded app at the 30 s cycle, and it
 * is about transient faults: a signature that expired in flight, a write that
 * lost a race with a low-storage kill. A fault that survives eight tries is not
 * transient, and paying one query per cycle for the life of the install to keep
 * asking would be the worse bug.
 */
export const MAX_SPRAY_PHOTO_ATTEMPTS = 8;

type PendingRecord = { photoKey: string; attempts: number };

/** The scope key a wall's rows and checkpoints live under: `spray:<id>:<id>`. */
export function sprayScopeKey(layoutId: number): string {
  return offlineBoardKey({ boardType: 'spray', layoutId, sizeId: spraySizeIdForLayout(layoutId) });
}

function pendingKey(layoutId: number): string {
  return `${SPRAY_PHOTO_PENDING_PREFIX}${layoutId}`;
}

async function readPending(db: OfflineDatabase, layoutId: number): Promise<PendingRecord | null> {
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM sync_meta WHERE key = ?', [
    pendingKey(layoutId),
  ]);
  if (!row) return null;
  try {
    const parsed: unknown = JSON.parse(row.value);
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.photoKey !== 'string') return null;
    const attempts = typeof record.attempts === 'number' && Number.isFinite(record.attempts) ? record.attempts : 0;
    return { photoKey: record.photoKey, attempts };
  } catch {
    // A garbled marker reads as "no attempts yet", which costs one extra retry
    // and never strands a photo.
    return null;
  }
}

/**
 * Record that this wall's photograph did not land, and rewind its cursor so the
 * next pull offers the row again with a live signature.
 *
 * Returns whether a rewind actually happened, so the caller (and its tests) can
 * tell a retry from a give-up.
 */
export async function recordSprayPhotoFailure(
  db: OfflineDatabase,
  layoutId: number,
  photoKey: string,
): Promise<boolean> {
  const existing = await readPending(db, layoutId);
  // A different key means the wall published a new photo: the old failure is not
  // this one's, so the budget starts again.
  const attempts = existing && existing.photoKey === photoKey ? existing.attempts + 1 : 1;
  await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
    pendingKey(layoutId),
    JSON.stringify({ photoKey, attempts } satisfies PendingRecord),
  ]);

  if (attempts > MAX_SPRAY_PHOTO_ATTEMPTS) return false;

  // Deleting the checkpoint rather than rewinding it to an earlier cursor: the
  // table holds one row per scope, so "from the beginning" and "from just before
  // this wall" are the same page.
  await db.runAsync('DELETE FROM sync_meta WHERE key = ?', [getCheckpointKey('spray_walls', sprayScopeKey(layoutId))]);
  return true;
}

/** Forget a wall's pending-photo record — the bytes are on disk, or the row is gone. */
export async function clearSprayPhotoPending(db: OfflineDatabase, layoutId: number): Promise<void> {
  await db.runAsync('DELETE FROM sync_meta WHERE key = ?', [pendingKey(layoutId)]);
}
