// The wall photograph kept for offline use (issue #5448).
//
// Every other board background is bundled inside the IPA/APK. A spray wall's is
// a photograph in the PRIVATE R2 bucket, so it has to be fetched — and a garage
// with no signal is exactly where a wall is climbed, so fetching it "when the
// board opens" is too late. `syncSprayWalls` ships a short-lived presigned URL
// alongside the wall's row, and this turns it into bytes on disk while the phone
// still has a connection.
//
// Three rules shape it.
//
//  1. **`Paths.document`, not `Paths.cache`.** The renderer's own photo cache
//     (SW-07, `spray-photo-cache.ts`) lives under `Paths.cache`, which the OS may
//     reclaim whenever it likes and which `sweep-caches.ts` prunes on a budget.
//     A photo that vanished the night before a session is the failure this slice
//     exists to prevent, so the offline copy sits in the durable directory the
//     SQLite database itself lives in, and no sweeper walks it.
//  2. **`photo_key` is the identity, never the URL.** A presigned signature is
//     different on every read and dead fifteen minutes later. The file is named
//     after the key, which is what actually decides whether two reads are the
//     same picture, and the URL is used once and forgotten.
//  3. **A partial download is never left under the real name.** Android streams
//     the response body straight into the destination, so a request that fails
//     part-way can leave a truncated JPEG behind — and a truncated JPEG under the
//     real name is worse than no file, because every later read sees `exists` and
//     hands the decoder garbage. Downloads land on `.part` and only a completed
//     one is moved into place.

import { Directory, File, Paths } from 'expo-file-system';

/** Directory under `Paths.document` holding one file per mirrored wall photo. */
export const SPRAY_PHOTO_STORE_DIR_NAME = 'spray-wall-photos';

/**
 * Whether this platform has a durable store at all. True here; the browser twin
 * says false, so the sink can tell "the download failed, retry it" apart from
 * "there is nowhere to put bytes on this platform, stop asking".
 */
export const SPRAY_PHOTO_STORE_AVAILABLE = true;

/**
 * A filesystem-safe name for an object key.
 *
 * Keys are server-generated (`sprayWallPhotoKey`) and look like
 * `spray-walls/<uuid>/<photoId>.jpg`, so they carry slashes. Flattening every
 * character outside `[A-Za-z0-9._-]` to `_` keeps the store one flat directory —
 * no nested `create` calls, nothing that can escape the directory via `..`, and
 * a name short enough for every filesystem we run on.
 *
 * Collisions are not a correctness problem the way they would be for a cache
 * key: two different keys that flatten to the same name would fight over one
 * file, and each would simply re-download. They cannot happen in practice —
 * a key's uuid and photo id are hex and hyphens.
 */
export function sprayPhotoStoreFileName(photoKey: string): string {
  return photoKey.replace(/[^A-Za-z0-9._-]/g, '_');
}

function storeDirectory(): Directory {
  return new Directory(Paths.document, SPRAY_PHOTO_STORE_DIR_NAME);
}

function storeFile(photoKey: string): File {
  return new File(storeDirectory(), sprayPhotoStoreFileName(photoKey));
}

function partialFile(photoKey: string): File {
  return new File(storeDirectory(), `${sprayPhotoStoreFileName(photoKey)}.part`);
}

function deleteQuietly(file: File): void {
  try {
    if (file.exists) file.delete();
  } catch {
    // A file we cannot remove is a file the next download overwrites.
  }
}

/**
 * The stored photo's path, or `null` when it is not on disk.
 *
 * Synchronous: the render path resolves a background without awaiting anything,
 * and `exists` is a single `stat` behind a JSI getter, not a directory walk.
 */
export function tryGetStoredSprayPhotoPathSync(photoKey: string | null | undefined): string | null {
  if (!photoKey) return null;
  try {
    const file = storeFile(photoKey);
    if (!file.exists) return null;
    // The native decoders behind the board renderer want a path, not a URI —
    // matching `toFilesystemPath` in background-image-cache.ts.
    return file.uri.replace(/^file:\/\//, '');
  } catch {
    // An unreadable directory is "not stored", never a throw on the draw path.
    return null;
  }
}

/**
 * Download a wall photo into the durable store, unless it is already there.
 *
 * Returns the path on success and `null` on every failure — a dead signature, a
 * download that threw, a directory that would not create. A wall with holds and
 * no photo still renders; a sync cycle that failed because of a JPEG would not.
 *
 * Idempotent and cheap to call on every pull: a photo already on disk costs one
 * `stat`. The key changes only when the wall's published version changes, so a
 * reset fetches exactly one new file.
 */
export async function storeSprayPhoto(photoKey: string, photoUrl: string): Promise<string | null> {
  const existing = tryGetStoredSprayPhotoPathSync(photoKey);
  if (existing) return existing;

  const destination = storeFile(photoKey);
  const partial = partialFile(photoKey);
  try {
    storeDirectory().create({ intermediates: true, idempotent: true });
    // Leftovers from a download this process did not finish: a `.part` was never
    // complete, and there is no destination (the check above said so).
    deleteQuietly(partial);

    const downloaded = await File.downloadFileAsync(photoUrl, partial, { idempotent: true });
    downloaded.moveSync(destination);
    return destination.uri.replace(/^file:\/\//, '');
  } catch {
    deleteQuietly(partial);
    deleteQuietly(destination);
    return null;
  }
}

/**
 * Delete the stored photo for one object key.
 *
 * Called when a climber removes a downloaded wall: `removeBoardScopeData` deletes
 * the `spray_walls` row inside its transaction and hands the key here afterwards,
 * because the engine has no filesystem. Deleting the row alone would leave a
 * multi-megabyte JPEG in the durable directory with nothing on disk naming it —
 * unreachable, unswept, and still a photograph of somebody's wall.
 *
 * Best-effort and silent: the row is already gone, and a file we could not remove
 * must not turn a completed teardown into a failure.
 */
export function deleteStoredSprayPhoto(photoKey: string | null | undefined): void {
  if (!photoKey) return;
  deleteQuietly(storeFile(photoKey));
  deleteQuietly(partialFile(photoKey));
}

/**
 * Delete every stored photo whose key no wall on this device claims any more.
 *
 * The store is keyed by `photo_key`, and a reset mints a new one — so without
 * this, every reset of every wall leaves its predecessor's JPEG behind forever.
 * `Paths.document` is not swept by anything (that is the point of storing there,
 * see the module header), so nothing else would ever reclaim them.
 *
 * `liveKeys` is the set of keys the local `spray_walls` rows currently name; the
 * caller reads it from SQLite, because this module does not get to run queries.
 * An unrecognised `.part` goes too: a partial download is by definition not a
 * usable photo, and one left by a killed process is never resumed.
 *
 * Skipped entirely when `liveKeys` is empty — an empty set is far more likely to
 * mean "the caller could not read the rows" than "this device has no walls", and
 * the failure mode of guessing wrong is deleting every photo the device holds.
 * Sign-out's deliberate wipe is `clearStoredSprayPhotos`, which says so.
 */
export function pruneStoredSprayPhotos(liveKeys: Iterable<string>): number {
  const keepNames = new Set<string>();
  for (const key of liveKeys) keepNames.add(sprayPhotoStoreFileName(key));
  if (keepNames.size === 0) return 0;

  let deleted = 0;
  try {
    const directory = storeDirectory();
    if (!directory.exists) return 0;
    for (const entry of directory.list()) {
      const name = entry.name;
      // A `.part` is never a photo, so it is judged on the key it belongs to
      // rather than on its own name.
      const isPartial = name.endsWith('.part');
      const keyName = isPartial ? name.slice(0, -'.part'.length) : name;
      if (!isPartial && keepNames.has(keyName)) continue;
      // A `.part` for a live key is a download that may be in flight right now.
      if (isPartial && keepNames.has(keyName)) continue;
      try {
        entry.delete();
        deleted += 1;
      } catch {
        // Next prune gets it.
      }
    }
  } catch {
    // An unreadable directory is nothing to reclaim, never a throw.
  }
  return deleted;
}

/**
 * Delete every stored wall photo.
 *
 * Called on sign-out, next to the `spray_walls` row wipe. A wall photo is
 * private to the climber who could see the wall, so leaving one behind on a
 * shared phone would keep a picture of a stranger's garage decodable by the next
 * account — and it would still be there after the rows that name it are gone.
 */
export function clearStoredSprayPhotos(): void {
  try {
    const directory = storeDirectory();
    if (directory.exists) directory.delete();
  } catch {
    // Best-effort, exactly like the row wipe it accompanies: a directory we
    // cannot delete must not fail sign-out.
  }
}
