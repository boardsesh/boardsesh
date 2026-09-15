import type { DocumentsPulledSink, RowsDeletedSink } from '@boardsesh/offline-sync';
import {
  SPRAY_PHOTO_STORE_AVAILABLE,
  deleteStoredSprayPhoto,
  pruneStoredSprayPhotos,
  storeSprayPhoto,
} from '../lib/spray/spray-photo-store';
import { reportHandledError } from '../lib/error-reporting';
import { clearSprayPhotoPending, recordSprayPhotoFailure } from './spray-photo-retry';

/**
 * Turn a pulled `spray_walls` page into photographs on disk (issue #5448).
 *
 * `syncSprayWalls` emits `photo_url`, a 15-minute presigned signature over an
 * object in the PRIVATE bucket, as a TRANSIENT field: the pull client hands it
 * here and never writes it (`TableSyncConfig.transientColumns`). The bytes are
 * what survives — named after `photo_key`, in the durable store, out of reach of
 * the cache sweeper.
 *
 * Doing it at sync time rather than at render time is the whole point. A wall
 * lives in a garage; by the time somebody opens it there may be no signal to
 * mint a signature with, and no signature means no photograph at all.
 *
 * ## Why this is the engine's ONLY filesystem side effect
 *
 * `@boardsesh/offline-sync` has no `expo-file-system` and must not grow one — it
 * runs in node tests, in a browser and on two native platforms. The sink is the
 * seam: the engine hands over a committed page, the platform decides what a file
 * even is. On web the store is a no-op twin, so this costs a loop and nothing
 * else there.
 *
 * Bounded by construction: a page of `spray_walls` carries at most one wall (the
 * resolver answers an empty page unless the caller named a readable layout, and
 * a layout is one wall), a wall has one published photo, and a photo already on
 * disk costs a single `stat`. A reset is the only event that fetches bytes.
 */
export const sprayWallPhotoSink: DocumentsPulledSink = async ({ tableName, documents, db }) => {
  if (tableName !== 'spray_walls') return;

  for (const document of documents) {
    const photoKey = document.photo_key;
    const photoUrl = document.photo_url;
    const layoutId = typeof document.layout_id === 'number' ? document.layout_id : Number(document.layout_id);
    // A wall with no published version has neither; a backend with no private
    // bucket configured sends the key and no URL. Both are "nothing to fetch",
    // not an error — the wall still syncs its holds.
    if (typeof photoKey !== 'string' || !photoKey) continue;
    if (typeof photoUrl !== 'string' || !photoUrl) continue;

    if (await storeSprayPhoto(photoKey, photoUrl)) {
      if (Number.isFinite(layoutId)) await clearSprayPhotoPending(db, layoutId);
      continue;
    }

    // The bytes did not land. The row's cursor has already advanced, so without
    // this the wall is never offered again and the photograph is simply missing
    // — on a board the climber has been told is downloaded. `recordSprayPhotoFailure`
    // rewinds this table's cursor for this scope so the next cycle re-offers the
    // row with a FRESH signature (the one we hold is dead in fifteen minutes and
    // cannot be retried), bounded by an attempt count.
    //
    // Not on a platform with no store at all: web would otherwise rewind on
    // every cycle forever to fetch bytes it has nowhere to put.
    if (SPRAY_PHOTO_STORE_AVAILABLE && Number.isFinite(layoutId)) {
      try {
        await recordSprayPhotoFailure(db, layoutId, photoKey);
      } catch (error) {
        // The outer catch in pull-client swallows whatever escapes this sink, so
        // a database error HERE would lose the retry silently: the cursor stays
        // advanced, no marker is written, and the photograph is gone until the
        // server touches the wall. Reported rather than swallowed, because a
        // retry mechanism that has stopped working is exactly the thing nobody
        // finds out about otherwise.
        reportHandledError(error, {
          tags: { source: 'offline-sync', op: 'spray-photo-retry-write' },
          extra: { layoutId },
        });
      }
    }
  }

  // Reap the generation this page replaced. A reset mints a NEW `photo_key`, so
  // without this every reset of every wall leaves its predecessor's JPEG in the
  // durable directory forever — and `Paths.document` is not swept by anything,
  // which is exactly why the photo lives there.
  //
  // Run for any page that carried a wall, not only one that stored bytes. A
  // reset whose presign failed (no private bucket configured, a signature that
  // would not mint) still replaced the wall's `photo_key`, so the PREVIOUS
  // generation's JPEG is already orphaned — gating the prune on a successful
  // download left it in `Paths.document` with no sweeper. The cost is one
  // directory walk per page that moved a wall row, which is a reset, not a cycle.
  //
  // Keys come from the DATABASE, never from the page: a page names one wall and
  // the device may hold ten, and deleting the other nine's photographs is the
  // failure this read exists to avoid. An empty result deletes nothing
  // (`pruneStoredSprayPhotos` refuses an empty live set).
  if (documents.length === 0) return;
  const rows = await db.getAllAsync<{ photo_key: string | null }>(
    'SELECT photo_key FROM spray_walls WHERE photo_key IS NOT NULL',
  );
  pruneStoredSprayPhotos(rows.map((row) => row.photo_key).filter((key): key is string => !!key));
};

/**
 * Take a deleted wall's photograph with it (issue #5448).
 *
 * The tombstone path deletes by primary key and owns no filesystem, so the file
 * is captured through `TableSyncConfig.captureOnDelete` before the row goes —
 * afterwards nothing on the device names it. Neither of the other two reclaim
 * paths can find it either: board teardown reads a row that is gone, and the
 * prune only knows the walls the device still has, so the file would sit in
 * durable storage until sign-out.
 */
export const sprayWallDeletedSink: RowsDeletedSink = async ({ tableName, rows, db }) => {
  if (tableName !== 'spray_walls') return;

  for (const row of rows) {
    const photoKey = row.photo_key;
    if (typeof photoKey === 'string' && photoKey) deleteStoredSprayPhoto(photoKey);
    // The wall is gone, so a pending-photo marker for it describes nothing and
    // would keep rewinding a cursor for a row that will never be served again.
    const layoutId = typeof row.layout_id === 'number' ? row.layout_id : Number(row.layout_id);
    if (Number.isFinite(layoutId)) await clearSprayPhotoPending(db, layoutId);
  }
};
