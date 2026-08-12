// Measuring and reclaiming the on-disk caches this app owns (issue #3647).
//
// Three of them, and they are not equally broken:
//
// 1. expo-image's disk cache. On iOS `ImageCacheConfig.maxDiskSize` defaults to
//    0 — "no cache size limit" — and nothing ever set it, so every
//    `cachePolicy="memory-disk"` surface wrote into an unbounded cache bounded
//    only by SDWebImage's 7-day age default. The ceiling now lives in
//    use-image-cache-memory-management.ts; this module measures it and clears it
//    on request. Android runs on Glide, which bounds its own disk cache.
// 2. `{cache}/board-thumbnails/*.png`. Already capped at 200 MB by the native
//    modules — but the cap is enforced once per cold launch, so a long-lived
//    foreground session grows past it unchecked.
// 3. `{cache}/board-snapshots/*.db`. The engine deletes its artifact in a
//    `finally`, so a kill mid-bootstrap leaks the whole thing (a Kilter artifact
//    is ~271 MB) until the OS reclaims it. Nothing swept it.
//
// All three live under `Paths.cache`, which the OS may reclaim on its own at any
// moment — the copy in Manage Storage says so, because a number that drops to
// zero without the user doing anything is the same "the app disagrees with the
// OS" problem this issue is about.

import { Image } from 'expo-image';
import { deleteCacheDirEntries, resolveImageCacheDirName, walkCacheDir } from './cache-dir-io';
import { invalidateCacheMeasurement, measureCacheDirBytes, recordCacheMeasurement } from './cache-size-meter';
import {
  measureOverlayCacheBytes,
  planOverlayCacheClear,
  planStaleArtifactSweep,
  SNAPSHOT_CLEAR_MIN_AGE_MS,
  SNAPSHOT_LEFTOVER_MAX_AGE_MS,
  cacheKeyForOverlayName,
} from './cache-sweep-plan';
import { clearOverlayIndex, forgetOverlays } from './overlay-index';
import { SNAPSHOT_DIR_NAME } from '../offline/snapshot-source';

/** Must match the directory the native BoardRenderer modules write PNGs into. */
export const OVERLAY_CACHE_DIR_NAME = 'board-thumbnails';

export type CachedImageMeasurement = {
  /** Rendered board art: `{cache}/board-thumbnails`. */
  artBytes: number;
  /** expo-image's disk cache, or null when its directory couldn't be located on this device. */
  photoBytes: number | null;
  /** Downloaded snapshot artifacts orphaned by a kill mid-bootstrap. */
  leftoverSnapshotBytes: number;
};

async function measureOverlayBytes(): Promise<number> {
  const bytes = await measureCacheDirBytes(OVERLAY_CACHE_DIR_NAME, async () => {
    const walk = await walkCacheDir(OVERLAY_CACHE_DIR_NAME);
    // Only finished PNGs count — in-flight temps and anything foreign are not
    // space the user can reclaim by tapping our button.
    return walk === null ? null : measureOverlayCacheBytes(walk.entries);
  });
  return bytes ?? 0;
}

async function measurePhotoBytes(): Promise<number | null> {
  const dirName = resolveImageCacheDirName();
  if (dirName === null) return null;
  return measureCacheDirBytes(dirName, async () => {
    // Recursive: SDWebImage keeps its files one level down in `default/`.
    const walk = await walkCacheDir(dirName, { recursive: true });
    return walk === null ? null : walk.totalBytes;
  });
}

async function measureSnapshotLeftoverBytes(): Promise<number> {
  const bytes = await measureCacheDirBytes(SNAPSHOT_DIR_NAME, async () => {
    const walk = await walkCacheDir(SNAPSHOT_DIR_NAME);
    return walk === null ? null : walk.totalBytes;
  });
  return bytes ?? 0;
}

/**
 * What the caches occupy right now, for Manage Storage.
 *
 * `photoBytes` is null rather than 0 when expo-image's cache directory isn't one
 * of the names we know: the screen omits the row entirely in that case. An
 * honest-looking `0 B` over a cache that plainly holds photos is exactly the
 * fake number the issue's design note warns against — the Clear button still
 * works, so the action survives even when the measurement doesn't.
 */
export async function measureCachedImageBytes(): Promise<CachedImageMeasurement | null> {
  try {
    const [artBytes, photoBytes, leftoverSnapshotBytes] = await Promise.all([
      measureOverlayBytes(),
      // A directory we can name but not read is the same answer as one we
      // couldn't name: omit the row, keep the button.
      measurePhotoBytes().catch(() => null),
      measureSnapshotLeftoverBytes(),
    ]);
    return { artBytes, photoBytes, leftoverSnapshotBytes };
  } catch {
    // This runs inside Manage Storage's single `['offlineStorage']` query, beside
    // the database total, the free-space figure, the board list and the Remove
    // buttons. A walk that throws — `list()` on an unreadable directory, a
    // permission failure on an Android volume — would take all of that down with
    // it and render the error state on the one screen whose purpose is
    // reclaiming space. Omitting the section is the same degraded-not-dishonest
    // answer the Photos row already gives, and the same posture as
    // `measureFreeDiskSpace` (storage-usage.ts), which returns null rather than
    // a fabricated zero.
    return null;
  }
}

/**
 * Reap downloaded snapshot artifacts orphaned by a kill mid-bootstrap.
 *
 * Age-based rather than "anything from a previous launch" on purpose: a resumable
 * partial download (#4310) and a retryable bootstrap (#4313) both have a claim on
 * a recent artifact, and a leaked `.db` is currently the only durable evidence an
 * interrupted bootstrap leaves behind.
 */
export async function sweepSnapshotLeftovers(options?: { maxAgeMs?: number }): Promise<number> {
  const walk = await walkCacheDir(SNAPSHOT_DIR_NAME);
  if (walk === null || walk.entries.length === 0) return 0;
  const plan = planStaleArtifactSweep({
    entries: walk.entries,
    nowMs: Date.now(),
    maxAgeMs: options?.maxAgeMs ?? SNAPSHOT_LEFTOVER_MAX_AGE_MS,
  });
  if (plan.deleteNames.length === 0) {
    recordCacheMeasurement(SNAPSHOT_DIR_NAME, walk.totalBytes);
    return 0;
  }
  deleteCacheDirEntries(SNAPSHOT_DIR_NAME, plan.deleteNames);
  invalidateCacheMeasurement(SNAPSHOT_DIR_NAME);
  return plan.freedBytes;
}

export type ClearCachedImagesResult = {
  freedBytes: number;
  filesDeleted: number;
  /** False when expo-image declined to clear its disk cache — see below. */
  photoCacheCleared: boolean;
};

/**
 * The Clear button: drop every rendered overlay PNG, every certainly-dead temp,
 * every leaked snapshot artifact, and expo-image's disk cache.
 *
 * Never deletes the directories themselves and never touches a foreign or
 * in-flight file — the native modules are writing into the same directory, and a
 * file that vanishes mid-write surfaces as a rejected `renderHoldsOverlay`, i.e.
 * the very Sentry storm this issue also exists to stop.
 */
export async function clearCachedImages(): Promise<ClearCachedImagesResult> {
  let freedBytes = 0;
  let filesDeleted = 0;

  const walk = await walkCacheDir(OVERLAY_CACHE_DIR_NAME);
  if (walk !== null) {
    const plan = planOverlayCacheClear({ entries: walk.entries, nowMs: Date.now() });
    filesDeleted += deleteCacheDirEntries(OVERLAY_CACHE_DIR_NAME, plan.deleteNames);
    freedBytes += plan.freedBytes;
    forgetOverlays(plan.deleteNames.map(cacheKeyForOverlayName));
  }
  // Belt and braces: anything the walk missed (a race with a render that landed
  // between list and delete) must not stay in the index handing out dead URIs.
  clearOverlayIndex();

  freedBytes += await sweepSnapshotLeftovers({ maxAgeMs: SNAPSHOT_CLEAR_MIN_AGE_MS });

  // Android's `clearDiskCache` resolves FALSE — a no-op — when the module has no
  // current activity, which is why this is only ever wired to a button press and
  // never to a background trigger. A false must not read as success.
  let photoCacheCleared = false;
  try {
    photoCacheCleared = await Image.clearDiskCache();
  } catch {
    photoCacheCleared = false;
  }

  invalidateCacheMeasurement();
  return { freedBytes, filesDeleted, photoCacheCleared };
}
