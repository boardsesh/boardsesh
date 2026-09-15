// The wall photograph on disk (issue #5440).
//
// Every other board background is a bundled asset: `background-image-cache.ts`
// resolves a manifest key to a file already inside the IPA/APK. A spray wall's
// background is a photograph in the PRIVATE R2 bucket, read through a 15-minute
// presigned URL (`docs/spray-walls.md`, "Photos and privacy"), so it has to be
// fetched once and kept.
//
// Two rules shape everything below.
//
//  1. **The URL is never the cache key.** A presigned signature changes on every
//     read and stops working fifteen minutes later. The file is named
//     `<layoutId>-<version>.jpg`, which is the identity that actually decides
//     whether two reads are the same picture, and the URL is looked up from the
//     registry at fetch time.
//  2. **The sync resolver never fetches.** It answers "on disk" or "not yet", the
//     same contract `tryResolveBundledPathSync` has, so a board surface's first
//     frame is a placeholder rather than a blocked JS thread. The async pass does
//     the download.

import { Directory, File, Paths } from 'expo-file-system';
import { getSprayWall, listRegisteredSprayWalls } from './spray-wall-registry';
import { SPRAY_PHOTO_CACHE_DIR_NAME, sprayPhotoFileName, type SprayPhotoIdentity } from './spray-photo-keys';

// Names live in a leaf module so the render path and the sweeper can use them
// without importing `expo-file-system`; re-exported here because this is where
// callers expect to find them.
export {
  SPRAY_BACKGROUND_KEY_PREFIX,
  SPRAY_PHOTO_CACHE_DIR_NAME,
  parseSprayBackgroundKey,
  sprayBackgroundKey,
  sprayPhotoFileName,
  type SprayPhotoIdentity,
} from './spray-photo-keys';

/**
 * Filenames the sweeper must not delete: one per wall this session has
 * registered.
 *
 * Deleting the photo of a wall somebody is looking at right now would blank the
 * board until the download ran again, which is the opposite of what a cache
 * sweep is for.
 */
export function liveSprayPhotoFileNames(): Set<string> {
  return new Set(
    listRegisteredSprayWalls().map((wall) => sprayPhotoFileName({ layoutId: wall.layoutId, version: wall.version })),
  );
}

/** Paths we have confirmed on disk this session, so a hit costs no filesystem call. */
const resolvedPaths = new Map<string, string>();

/** In-flight downloads, so N rows on one wall fetch one photo, not N. */
const pendingDownloads = new Map<string, Promise<string | null>>();

function photoFile(identity: SprayPhotoIdentity): File {
  return new File(new Directory(Paths.cache, SPRAY_PHOTO_CACHE_DIR_NAME), sprayPhotoFileName(identity));
}

/**
 * Strip the `file://` scheme, matching `toFilesystemPath` in
 * `background-image-cache.ts` — the native decoders behind the board renderer
 * want a path, not a URI.
 */
function toPath(uri: string): string {
  return uri.replace(/^file:\/\//, '');
}

/**
 * The photo's path if it is already on disk, otherwise `null`.
 *
 * Synchronous on purpose (see the module header). `exists` is a JSI getter over a
 * single `stat`, not a walk, so this is cheap enough for the hook's `useState`
 * initialiser.
 */
export function tryGetSprayPhotoPathSync(identity: SprayPhotoIdentity): string | null {
  const key = sprayPhotoFileName(identity);
  const cached = resolvedPaths.get(key);
  if (cached) return cached;

  try {
    const file = photoFile(identity);
    if (!file.exists) return null;
    const path = toPath(file.uri);
    resolvedPaths.set(key, path);
    return path;
  } catch {
    // An unreadable cache directory is "not yet", never a throw on the draw path.
    return null;
  }
}

/**
 * Make sure the photo is on disk, downloading it from the version's presigned URL
 * if it is not, and return its path.
 *
 * `null` on every failure — no wall registered (so no URL to sign), a download
 * that threw, a file that vanished between the write and the check. The caller
 * counts that as a missing background layer, which is the existing
 * `missingCount` contract: broken has to be visible, and there is no second
 * source to fall back to.
 */
export async function ensureSprayPhotoCached(identity: SprayPhotoIdentity): Promise<string | null> {
  const key = sprayPhotoFileName(identity);
  const alreadyOnDisk = tryGetSprayPhotoPathSync(identity);
  if (alreadyOnDisk) return alreadyOnDisk;

  const inFlight = pendingDownloads.get(key);
  if (inFlight) return inFlight;

  const download = downloadSprayPhoto(identity, key).finally(() => {
    pendingDownloads.delete(key);
  });
  pendingDownloads.set(key, download);
  return download;
}

async function downloadSprayPhoto(identity: SprayPhotoIdentity, key: string): Promise<string | null> {
  // The registry is the only holder of a live signature. A wall that has been
  // unregistered — or whose version moved on while this was queued — has no URL
  // worth fetching, and guessing one is not possible by design.
  const wall = getSprayWall(identity.layoutId);
  if (!wall || wall.version !== identity.version) return null;

  try {
    const directory = new Directory(Paths.cache, SPRAY_PHOTO_CACHE_DIR_NAME);
    directory.create({ intermediates: true, idempotent: true });

    const destination = photoFile(identity);
    // A half-written file from a killed download would otherwise be handed
    // straight to the decoder as a complete photo.
    if (destination.exists) destination.delete();

    const downloaded = await File.downloadFileAsync(wall.photoUrl, destination);
    const path = toPath(downloaded.uri);
    resolvedPaths.set(key, path);
    return path;
  } catch {
    return null;
  }
}

/** Forget the resolved-path memo. Tests only; a path on disk does not change under a running app. */
export function clearSprayPhotoPathCache(): void {
  resolvedPaths.clear();
  pendingDownloads.clear();
}
