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
//    Board art (LayeredClimbImage, PlaylistBoardBackdrop) moved to
//    `cachePolicy="memory"` for issue #5187 — the overlay and background are
//    already files we own on disk, so a second SDWebImage disk copy was just
//    duplicate I/O. This disk cache is now fed only by the photo surfaces:
//    feed, beta thumbnails, avatars.
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
import { SHARED_EVENTS } from '@boardsesh/analytics';
import type { OfflineBoardScope } from '@boardsesh/offline-sync';
import { deleteCacheDirEntries, resolveImageCacheDirName, walkCacheDir } from './cache-dir-io';
import { invalidateCacheMeasurement, measureCacheDirBytes, recordCacheMeasurement } from './cache-size-meter';
import {
  measureFreedBytes,
  measureOverlayCacheBytes,
  overlayNameMatchesScope,
  planLruEviction,
  planOverlayCacheClear,
  planStaleArtifactSweep,
  OVERLAY_CACHE_TARGET_BYTES,
  SNAPSHOT_CLEAR_MIN_AGE_MS,
  SNAPSHOT_LEFTOVER_MAX_AGE_MS,
  cacheKeyForOverlayName,
} from './cache-sweep-plan';
import {
  clearOverlayIndex,
  forgetOverlays,
  getRecentlyUsedCacheKeys,
  resetOverlayWriteOdometer,
} from './overlay-index';
import { track } from './analytics';
import { SNAPSHOT_DIR_NAME } from '../offline/snapshot-paths';

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
  const deletedNames = deleteCacheDirEntries(SNAPSHOT_DIR_NAME, plan.deleteNames);
  invalidateCacheMeasurement(SNAPSHOT_DIR_NAME);
  return measureFreedBytes({ entries: walk.entries, deletedNames, countableNames: plan.deleteNames });
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
    const deletedNames = deleteCacheDirEntries(OVERLAY_CACHE_DIR_NAME, plan.deleteNames);
    filesDeleted += deletedNames.length;
    freedBytes += measureFreedBytes({ entries: walk.entries, deletedNames, countableNames: plan.pngNames });
    // Forgetting a key whose file survived the delete is the safe direction: the
    // index would otherwise keep handing out a URI for a file the next pass is
    // still trying to remove, and a forgotten key costs one re-render.
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

/** Where a sweep came from. Carried on the analytics event so the triggers can be compared. */
export type CacheSweepTrigger =
  | 'launch'
  | 'background'
  | 'write-threshold'
  | 'board-removed'
  | 'manual'
  | 'disk-pressure';

export type CacheSweepResult = {
  beforeBytes: number;
  freedBytes: number;
  filesDeleted: number;
};

const EMPTY_SWEEP: CacheSweepResult = { beforeBytes: 0, freedBytes: 0, filesDeleted: 0 };

/**
 * How long a cache key stays protected from eviction after JS last read it.
 *
 * Long enough to cover a surface that is mounted but idle (a play drawer left
 * open, a list the user stopped scrolling), short enough that the warm-up's
 * couple of hundred prior-session insertions age out of the protected set within
 * one browsing session.
 */
const RECENTLY_USED_WINDOW_MS = 120_000;

/** Minimum gap between two sweeps of the same trigger class. */
const SWEEP_RATE_LIMIT_MS = 5 * 60 * 1000;

const lastSweptAtMsByTrigger = new Map<CacheSweepTrigger, number>();

/**
 * Bring `{cache}/board-thumbnails` back under the native modules' own 200 MB cap.
 *
 * The cap already exists — what was missing is anything enforcing it during a
 * session. Both native modules prune behind a once-per-module-lifetime gate
 * (`BoardRendererModule.swift`'s `lazy var pruneOnce`, `.kt`'s `@Volatile pruned`),
 * so a foreground session that never relaunches grows unchecked. Fixing the gate
 * is a native change that could not reach store binaries over OTA, so this runs
 * the same mtime-LRU from JS against the same directory, with the same
 * file-classification rules, plus the one thing mtime can't know: which keys a
 * live surface read in the last two minutes.
 */
export async function sweepBoardArtCache(params: {
  trigger: CacheSweepTrigger;
  targetBytes?: number;
  nowMs?: number;
}): Promise<CacheSweepResult> {
  const nowMs = params.nowMs ?? Date.now();
  const lastSweptAtMs = lastSweptAtMsByTrigger.get(params.trigger);
  if (lastSweptAtMs !== undefined && nowMs - lastSweptAtMs < SWEEP_RATE_LIMIT_MS) return EMPTY_SWEEP;
  lastSweptAtMsByTrigger.set(params.trigger, nowMs);
  // The odometer counts growth since the LAST sweep, whatever fired it.
  resetOverlayWriteOdometer();

  const walk = await walkCacheDir(OVERLAY_CACHE_DIR_NAME);
  if (walk === null) return EMPTY_SWEEP;

  const plan = planLruEviction({
    entries: walk.entries,
    targetBytes: params.targetBytes ?? OVERLAY_CACHE_TARGET_BYTES,
    protectedNames: getRecentlyUsedCacheKeys(RECENTLY_USED_WINDOW_MS, nowMs),
    nowMs,
  });
  const deleteNames = [...plan.evictNames, ...plan.staleTempNames];
  if (deleteNames.length === 0) {
    // The walk we just paid for is the measurement Manage Storage would take.
    recordCacheMeasurement(OVERLAY_CACHE_DIR_NAME, plan.beforeBytes, nowMs);
    return { beforeBytes: plan.beforeBytes, freedBytes: 0, filesDeleted: 0 };
  }

  const deletedNames = deleteCacheDirEntries(OVERLAY_CACHE_DIR_NAME, deleteNames);
  forgetOverlays(plan.evictNames.map(cacheKeyForOverlayName));
  invalidateCacheMeasurement(OVERLAY_CACHE_DIR_NAME);

  // Not `beforeBytes - afterBytes`: that is what the plan WANTED to free. A file
  // the delete pass couldn't remove leaves the cache above its cap, and saying
  // otherwise here would put the fiction straight into `CachedImagesSwept`.
  const result = {
    beforeBytes: plan.beforeBytes,
    freedBytes: measureFreedBytes({ entries: walk.entries, deletedNames, countableNames: plan.evictNames }),
    filesDeleted: deletedNames.length,
  };
  if (result.freedBytes > 0) {
    track(SHARED_EVENTS.CachedImagesSwept, {
      trigger: params.trigger,
      beforeBytes: result.beforeBytes,
      freedBytes: result.freedBytes,
      filesDeleted: result.filesDeleted,
    });
  }
  return result;
}

/**
 * Drop the rendered art for one board scope, on removal.
 *
 * Best-effort by design: Remove is about reclaiming space, and art that survives
 * a removal is exactly the leftover this screen exists to reap. Re-browsing that
 * board online redraws every thumbnail locally in tens of milliseconds, no
 * network — which is why this is worth doing even though it is not free.
 */
export async function sweepOverlaysForScope(scope: OfflineBoardScope): Promise<CacheSweepResult> {
  const walk = await walkCacheDir(OVERLAY_CACHE_DIR_NAME);
  if (walk === null) return EMPTY_SWEEP;

  const matching = walk.entries.filter((entry) => overlayNameMatchesScope(entry.name, scope));
  if (matching.length === 0) return EMPTY_SWEEP;

  const names = matching.map((entry) => entry.name);
  const deletedNames = deleteCacheDirEntries(OVERLAY_CACHE_DIR_NAME, names);
  forgetOverlays(names.map(cacheKeyForOverlayName));
  invalidateCacheMeasurement(OVERLAY_CACHE_DIR_NAME);

  // Only the files that are actually gone — art that survived the pass is still
  // occupying the space the Remove screen just told the user it reclaimed.
  const freedBytes = measureFreedBytes({ entries: walk.entries, deletedNames, countableNames: names });
  const filesDeleted = deletedNames.length;
  const beforeBytes = measureOverlayCacheBytes(walk.entries);

  if (freedBytes > 0) {
    track(SHARED_EVENTS.CachedImagesSwept, {
      trigger: 'board-removed',
      beforeBytes,
      freedBytes,
      filesDeleted,
    });
  }
  return { beforeBytes, freedBytes, filesDeleted };
}

/** Test-only: forget the per-trigger rate limit. */
export function _resetSweepRateLimitForTests(): void {
  lastSweptAtMsByTrigger.clear();
}
