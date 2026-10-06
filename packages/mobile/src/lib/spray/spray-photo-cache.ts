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
//     `<layoutId>-v<versionId>.jpg`, which is the identity that actually decides
//     whether two reads are the same picture, and the URL is looked up from the
//     registry at fetch time.
//  2. **The sync resolver never fetches.** It answers "on disk" or "not yet", the
//     same contract `tryResolveBundledPathSync` has, so a board surface's first
//     frame is a placeholder rather than a blocked JS thread. The async pass does
//     the download.

import { Directory, File, Paths } from 'expo-file-system';
import { sprayPrivacyGeneration } from './spray-privacy-generation';
import { getSprayWall, listRegisteredSprayWalls, refreshSprayWall } from './spray-wall-registry';
import { releaseDownloadTaskAfterNativeCompletion, retainDownloadTask } from '../../offline/download-task-retention';
import {
  SPRAY_PHOTO_CACHE_DIR_NAME,
  sprayPartialPhotoFileName,
  sprayPhotoFileName,
  type SprayPhotoIdentity,
} from './spray-photo-keys';
import type { RegisteredSprayWall } from './spray-wall-registry';

// Names live in a leaf module so the render path and the sweeper can use them
// without importing `expo-file-system`; re-exported here because this is where
// callers expect to find them.
export {
  SPRAY_BACKGROUND_KEY_PREFIX,
  SPRAY_PHOTO_CACHE_DIR_NAME,
  parseSprayBackgroundKey,
  sprayBackgroundKey,
  sprayPhotoFileName,
  type SprayArtVariant,
  type SprayPhotoIdentity,
} from './spray-photo-keys';

/**
 * Filenames the sweeper must not delete: one per wall this session has
 * registered, plus its generated look when it has one.
 *
 * Deleting the photo of a wall somebody is looking at right now would blank the
 * board until the download ran again, which is the opposite of what a cache
 * sweep is for.
 */
export function liveSprayPhotoFileNames(): Set<string> {
  const names = new Set<string>();
  for (const wall of listRegisteredSprayWalls()) {
    names.add(sprayPhotoFileName({ layoutId: wall.layoutId, versionId: wall.versionId }));
    if (wall.art && wall.art.versionId === wall.versionId) {
      names.add(sprayPhotoFileName({ layoutId: wall.layoutId, versionId: wall.versionId, variant: wall.art.variant }));
    }
  }
  return names;
}

/** A presigned GET and its expiry: where a file is fetched from. */
export type SprayFileSource = { url: string; expiresAt: string };

/**
 * Where the registry says a file comes from: the photo's signature, or the
 * registered art's when the identity names a generated look of this version.
 */
function registeredSource(wall: RegisteredSprayWall, identity: SprayPhotoIdentity): SprayFileSource | null {
  if (wall.versionId !== identity.versionId) return null;
  if (!identity.variant) return { url: wall.photoUrl, expiresAt: wall.photoExpiresAt };
  const art = wall.art;
  if (!art || art.variant !== identity.variant || art.versionId !== identity.versionId) return null;
  return { url: art.url, expiresAt: art.expiresAt };
}

/** Paths we have confirmed on disk this session, so a hit costs no filesystem call. */
const resolvedPaths = new Map<string, string>();

/** In-flight downloads, so N rows on one wall fetch one photo, not N. */
const pendingDownloads = new Map<string, Promise<string | null>>();

function photoFile(identity: SprayPhotoIdentity): File {
  return new File(new Directory(Paths.cache, SPRAY_PHOTO_CACHE_DIR_NAME), sprayPhotoFileName(identity));
}

/**
 * Where a download lands before it is complete.
 *
 * `File.downloadFileAsync` streams the response body STRAIGHT INTO the
 * destination on Android, and its own docs say a partially written file may be
 * left there when the request fails part-way. A truncated JPEG under the real
 * name is worse than no file: `tryGetSprayPhotoPathSync` sees `exists`, hands it
 * to the decoder, and keeps doing so for good — there is no checksum to catch it
 * and the sync resolver never re-downloads. So the download goes to `.part` and
 * only a completed one is moved into place. iOS already stages its own temp
 * file; this makes the two platforms behave the same.
 */
function partialPhotoFile(identity: SprayPhotoIdentity, generation: string): File {
  return new File(
    new Directory(Paths.cache, SPRAY_PHOTO_CACHE_DIR_NAME),
    `${generation}-${sprayPartialPhotoFileName(identity)}`,
  );
}

/** Delete a file if it is there, swallowing the race where it is not. */
function deleteQuietly(file: File): void {
  try {
    if (file.exists) file.delete();
  } catch {
    // A file we cannot remove is a file the next download overwrites.
  }
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
  if (typeof identity.versionId === 'string') {
    const wall = getSprayWall(identity.layoutId);
    if (!wall || wall.versionId !== identity.versionId || !wall.localPhotoPath) return null;
    try {
      return new File(`file://${wall.localPhotoPath}`).exists ? wall.localPhotoPath : null;
    } catch {
      return null;
    }
  }
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
export async function ensureSprayPhotoCached(
  identity: SprayPhotoIdentity,
  // A signature the caller already holds, for a file the registry cannot name
  // yet: the loader downloads a generated look BEFORE registering it, so the
  // switch from the photo happens only once the file is on disk.
  source?: SprayFileSource,
): Promise<string | null> {
  const generation = sprayPrivacyGeneration(identity.layoutId);
  const key = `${generation}:${sprayPhotoFileName(identity)}`;
  const alreadyOnDisk = tryGetSprayPhotoPathSync(identity);
  if (alreadyOnDisk) return alreadyOnDisk;
  // Local mirrors never download or loop on their deliberately expired URL.
  if (typeof identity.versionId === 'string') return null;

  const inFlight = pendingDownloads.get(key);
  if (inFlight) return inFlight;

  const download = downloadSprayPhoto(identity, generation, source).finally(() => {
    if (pendingDownloads.get(key) === download) pendingDownloads.delete(key);
  });
  pendingDownloads.set(key, download);
  return download;
}

async function downloadSprayPhoto(
  identity: SprayPhotoIdentity,
  generation: string,
  explicitSource: SprayFileSource | undefined,
): Promise<string | null> {
  // The registry is the only holder of a live signature. A wall that has been
  // unregistered — or whose version moved on while this was queued — has no URL
  // worth fetching, and guessing one is not possible by design.
  //
  // A caller-held signature skips that lookup: the loader fetches a generated
  // look for a wall it has not registered yet. The privacy-generation check
  // after the transfer still discards it if the wall was withdrawn meanwhile.
  const wall = getSprayWall(identity.layoutId);
  const source = explicitSource ?? (wall ? registeredSource(wall, identity) : null);
  if (!source) return null;

  // A signature that has already expired cannot be fetched with, and retrying it
  // would 403 on every pass for the rest of the session while the board showed a
  // placeholder. Ask for a fresh payload — only the render query can mint one —
  // and answer "no photo yet"; the registration that follows re-runs this with a
  // live URL.
  if (isExpired(source.expiresAt)) {
    // A caller-held signature is the caller's to renew; only a registered one
    // means the payload in hand is dead.
    if (!explicitSource) refreshSprayWall(identity.layoutId);
    return null;
  }

  const destination = photoFile(identity);
  const partial = partialPhotoFile(identity, generation);
  try {
    const directory = new Directory(Paths.cache, SPRAY_PHOTO_CACHE_DIR_NAME);
    directory.create({ intermediates: true, idempotent: true });

    // Leftovers from a download this process did not finish. Both are dead: a
    // `.part` was never complete, and a destination we are about to replace is
    // one `tryGetSprayPhotoPathSync` already declined.
    deleteQuietly(partial);
    deleteQuietly(destination);

    await runRetainedDownload(source.url, partial);
    // A withdrawal while native I/O was streaming: the wall's generation moved,
    // so this body belongs to a revoked wall and must never reach its real name.
    if (generation !== sprayPrivacyGeneration(identity.layoutId)) {
      deleteQuietly(partial);
      return null;
    }

    // Resolved BEFORE the move, so nothing can throw between a completed
    // `moveSync` and the memo write. Reading the uri afterwards would leave the
    // finished photo inside the catch's blast radius, and the catch deletes
    // `destination` — a file that is, by then, the correct one.
    const path = toPath(destination.uri);
    partial.moveSync(destination);
    resolvedPaths.set(sprayPhotoFileName(identity), path);
    return path;
  } catch {
    // Never leave a truncated body behind under either name.
    deleteQuietly(partial);
    if (generation === sprayPrivacyGeneration(identity.layoutId)) deleteQuietly(destination);
    return null;
  }
}

/**
 * Download to `destination`, holding the task handle until iOS has finished with
 * it.
 *
 * `File.downloadFileAsync` is the shorter call and the wrong one here. It hands
 * back no handle, so nothing can keep the shared object reachable from JS — and
 * `FileSystemDownloadTask.sharedObjectWillRelease()` cancels an
 * already-completing URLSessionTask with no guard, which is the EXC_BAD_ACCESS of
 * issue #5297. The window between `didFinishDownloadingTo` (which settles the
 * promise) and `didCompleteWithError` (which nils the pointer) does not depend on
 * payload size, so a three-megabyte photo sits in it exactly as a 100 MB snapshot
 * does. `download-task-retention.ts` has the whole ownership chain; this is the
 * same pattern `snapshot-source.ts` uses, for the same reason.
 */
async function runRetainedDownload(url: string, destination: File): Promise<void> {
  const task = File.createDownloadTask(url, destination, { sessionType: 'foreground' });
  retainDownloadTask(task);
  try {
    const file = await task.downloadAsync();
    // `downloadAsync` resolves null only for a paused task, which we never do.
    // Treating it as success would move a file nobody wrote.
    if (!file) throw new Error('spray photo download ended without a file');
  } finally {
    // Starts the countdown, never the release: a rejected transfer settles from
    // `didCompleteWithError`'s own reject, i.e. inside the same window.
    releaseDownloadTaskAfterNativeCompletion(task);
  }
}

/**
 * Whether a presigned signature has already lapsed.
 *
 * An unparseable stamp is treated as still valid: the server always sends an ISO
 * string, so a failure to parse one means something we do not understand rather
 * than a URL we know is dead, and refusing to fetch on that would blank a wall
 * that would have loaded.
 */
function isExpired(expiresAt: string): boolean {
  const expiryMs = Date.parse(expiresAt);
  return Number.isFinite(expiryMs) && expiryMs <= Date.now();
}

/**
 * Forget the resolved-path memo.
 *
 * Called by the cache sweeper as well as by tests: a swept photo's path is still
 * in this map, and handing it out would point the decoder at a file that is no
 * longer there. In-flight downloads are deliberately NOT dropped — one is about
 * to write the file back.
 */
export function clearSprayPhotoPathCache(): void {
  resolvedPaths.clear();
}

/** Erase every version and partial for one withdrawn wall, or all on sign-out. */
export function deleteCachedSprayPhotos(layoutId?: number): void {
  if (layoutId == null) resolvedPaths.clear();
  else for (const key of resolvedPaths.keys()) if (key.startsWith(`${layoutId}-`)) resolvedPaths.delete(key);
  try {
    const directory = new Directory(Paths.cache, SPRAY_PHOTO_CACHE_DIR_NAME);
    if (!directory.exists) return;
    if (layoutId == null) directory.delete();
    else {
      // Match version-id names (`<layoutId>-v<versionId>.jpg`), the generated
      // looks beside them (`-crop.jpg`, `-cutout.webp`), legacy version-number
      // names, and the producer's nonce/session/wall staging prefix.
      const wallPhotoPattern = new RegExp(
        `^(?:[a-z0-9]+-\\d+-\\d+-)?${layoutId}-v?\\d+(?:\\.jpg|-crop\\.jpg|-cutout\\.webp)(?:\\.part)?$`,
      );
      for (const entry of directory.list()) {
        if (wallPhotoPattern.test(entry.name)) {
          try {
            entry.delete();
          } catch {
            /* Best effort; next withdrawal retries. */
          }
        }
      }
    }
  } catch {
    /* Cleanup must not prevent sign-out. */
  }
}

/** Forget both the memo and any in-flight download. Tests only. */
export function resetSprayPhotoCacheForTests(): void {
  resolvedPaths.clear();
  pendingDownloads.clear();
}
