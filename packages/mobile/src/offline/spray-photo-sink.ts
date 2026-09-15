import type { DocumentsPulledSink } from '@boardsesh/offline-sync';
import { storeSprayPhoto } from '../lib/spray/spray-photo-store';

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
export const sprayWallPhotoSink: DocumentsPulledSink = async ({ tableName, documents }) => {
  if (tableName !== 'spray_walls') return;

  for (const document of documents) {
    const photoKey = document.photo_key;
    const photoUrl = document.photo_url;
    // A wall with no published version has neither; a backend with no private
    // bucket configured sends the key and no URL. Both are "nothing to fetch",
    // not an error — the wall still syncs its holds.
    if (typeof photoKey !== 'string' || !photoKey) continue;
    if (typeof photoUrl !== 'string' || !photoUrl) continue;
    await storeSprayPhoto(photoKey, photoUrl);
  }
};
