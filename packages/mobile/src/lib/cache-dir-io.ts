// The only filesystem seam the cache sweeper has (issue #3647).
//
// Everything that decides WHAT to delete is pure and lives in
// `cache-sweep-plan.ts`; everything that touches `expo-file-system` lives here,
// behind a `.web.ts` twin, so no other module in the sweep has to care that
// expo-file-system has no browser build.
//
// Deliberately absent: `Directory.size`. It reads like a cheap stat but it is a
// full recursive walk on both platforms — iOS `FileSystemDirectory.swift`
// (`subpathsOfDirectory` + `attributesOfItem` per subpath), Android
// `FileSystemDirectory.kt` (`walkTopDown().filter { isFile }.map { length }.sum()`)
// — implemented as a synchronous JSI getter, so it cannot yield. On a directory
// with thousands of PNGs that blocks the JS thread outright. The chunked walk
// below is the same work with a macrotask between every chunk, and it returns
// the per-entry data an eviction plan needs from the SAME pass, so measuring and
// sweeping never walk twice.

import { Directory, File, Paths } from 'expo-file-system';
import type { CacheDirEntry } from './cache-sweep-plan';

export type CacheDirWalk = {
  entries: CacheDirEntry[];
  totalBytes: number;
};

const DEFAULT_CHUNK_SIZE = 100;

/**
 * expo-image's default on-disk cache directories, by the underlying library.
 *
 * These are the upstream defaults, not something we configure, so they are a
 * best guess that a dependency bump could invalidate. Getting it wrong is
 * degraded, not dishonest: `measureCachedImageBytes` reports null and the UI
 * omits the row rather than printing a fabricated `0 B`. To confirm or correct
 * one on a device, load an image and read
 * `new File(await Image.getCachePathAsync(uri)).parentDirectory` — the fix is a
 * one-line change here that rides an OTA.
 */
const IMAGE_CACHE_DIR_CANDIDATES = [
  // iOS: SDWebImage's `SDImageCache` default namespace. Its PNGs live one level
  // down in `default/`, which is why the probe walk is recursive.
  'com.hackemist.SDImageCache',
  // Android: Glide's `InternalCacheDiskCacheFactory` default directory.
  'image_manager_disk_cache',
];

/** Hand the JS thread back to the runtime between chunks. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function walkDirectory(
  directory: Directory,
  chunkSize: number,
  recursive: boolean,
  collected: CacheDirEntry[],
  counter: { seen: number },
): Promise<number> {
  // `list()` throws when the directory is absent, so the existence check is not
  // an optimisation — it is the contract (see `listOverlayCacheEntries`).
  if (!directory.exists) return 0;
  let totalBytes = 0;
  for (const item of directory.list()) {
    if (item instanceof Directory) {
      if (recursive) totalBytes += await walkDirectory(item, chunkSize, recursive, collected, counter);
      continue;
    }
    // `size` is 0 and `lastModified` null for anything unreadable, which is the
    // right answer for a plan: nothing to reclaim, nothing datable to evict on.
    collected.push({ name: item.name, sizeBytes: item.size, modifiedAtMs: item.lastModified });
    totalBytes += item.size;
    counter.seen += 1;
    if (counter.seen % chunkSize === 0) await yieldToEventLoop();
  }
  return totalBytes;
}

/**
 * Walk one directory under `Paths.cache`, yielding to the runtime every
 * `chunkSize` files.
 *
 * Returns null when the directory does not exist — a clean install, or an OS
 * that already reclaimed it. Callers must treat that as "nothing here", never
 * as "zero bytes measured".
 */
export async function walkCacheDir(
  dirName: string,
  options?: { chunkSize?: number; recursive?: boolean },
): Promise<CacheDirWalk | null> {
  const directory = new Directory(Paths.cache, dirName);
  if (!directory.exists) return null;
  const entries: CacheDirEntry[] = [];
  const totalBytes = await walkDirectory(
    directory,
    options?.chunkSize ?? DEFAULT_CHUNK_SIZE,
    options?.recursive ?? false,
    entries,
    { seen: 0 },
  );
  return { entries, totalBytes };
}

/**
 * Delete named entries from a cache directory, best-effort. Returns the names it
 * actually removed.
 *
 * Per-entry try/catch because the interesting failure is a race — the OS
 * reclaimed the file, or the native pruner got there first — and a sweep that
 * rejects on the first of those frees nothing at all.
 *
 * The names rather than a count, because the callers report freed BYTES: a
 * permission failure or an unreadable volume takes one file out of the plan
 * without taking it out of a `beforeBytes - afterBytes` subtraction, so the
 * sweep would claim space it never reclaimed. Only what came back from here is
 * counted.
 */
export function deleteCacheDirEntries(dirName: string, names: readonly string[]): string[] {
  const directory = new Directory(Paths.cache, dirName);
  const deleted: string[] = [];
  for (const name of names) {
    try {
      const file = new File(directory, name);
      if (!file.exists) continue;
      file.delete();
      deleted.push(name);
    } catch {
      // Ignore: see above.
    }
  }
  return deleted;
}

/**
 * Free bytes on the volume the cache lives on, or null when the platform won't say.
 *
 * A `statfs`, not a walk — cheap enough to ask on a failed write. It exists so
 * "is this device full?" has an answer that does not depend on the language the
 * OS phrased its error in: `NSError.localizedDescription` is translated, so
 * matching English wording alone misses a full disk on every non-English phone.
 */
export function measureFreeCacheSpaceBytes(): number | null {
  try {
    const availableBytes = Paths.availableDiskSpace;
    return typeof availableBytes === 'number' && Number.isFinite(availableBytes) ? availableBytes : null;
  } catch {
    return null;
  }
}

/** The expo-image disk-cache directory on this device, or null when none of the known names exist. */
export function resolveImageCacheDirName(): string | null {
  for (const candidate of IMAGE_CACHE_DIR_CANDIDATES) {
    try {
      if (new Directory(Paths.cache, candidate).exists) return candidate;
    } catch {
      // A candidate we can't even stat is not the one.
    }
  }
  return null;
}
