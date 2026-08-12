// Browser twin of sweep-caches.ts.
//
// None of the three caches exist here. Rendered overlays live in the Cache API,
// already bounded by entry count (modules/board-renderer/src/overlay-cache-store.web.ts);
// photos are the browser's own HTTP cache, which we neither measure nor evict;
// and the snapshot bootstrap never writes a file. `measureCachedImageBytes`
// returns null so Manage Storage omits the whole Cached-images section rather
// than rendering a live Clear button over a fabricated `0 B`.

import type { CacheSweepResult, CachedImageMeasurement, ClearCachedImagesResult } from './sweep-caches';

export type {
  CacheSweepResult,
  CacheSweepTrigger,
  CachedImageMeasurement,
  ClearCachedImagesResult,
} from './sweep-caches';

export const OVERLAY_CACHE_DIR_NAME = 'board-thumbnails';

export async function measureCachedImageBytes(): Promise<CachedImageMeasurement | null> {
  return null;
}

export async function sweepSnapshotLeftovers(): Promise<number> {
  return 0;
}

export async function clearCachedImages(): Promise<ClearCachedImagesResult> {
  return { freedBytes: 0, filesDeleted: 0, photoCacheCleared: false };
}

export async function sweepBoardArtCache(): Promise<CacheSweepResult> {
  return { beforeBytes: 0, freedBytes: 0, filesDeleted: 0 };
}

export async function sweepOverlaysForScope(): Promise<CacheSweepResult> {
  return { beforeBytes: 0, freedBytes: 0, filesDeleted: 0 };
}
