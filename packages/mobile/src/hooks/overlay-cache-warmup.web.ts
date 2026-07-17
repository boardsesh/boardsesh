/**
 * Web twin of overlay-cache-warmup.ts.
 *
 * The native overlay warm-up scans the BoardRenderer module's on-disk PNG cache
 * ({cache}/board-thumbnails) to surface prior-session renders synchronously. On
 * web the equivalent store is the Cache API (see
 * modules/board-renderer/src/overlay-cache-store.web.ts): rendered overlay PNGs
 * are persisted there keyed by cacheKey, so they survive a reload.
 *
 * The shared hook's warm-up is synchronous, but reading the Cache API is not, so
 * we kick off hydration at module load (app startup) and return whatever has
 * been hydrated so far. Anything not yet hydrated is still recovered lazily:
 * renderHoldsOverlay reads the Cache API on a miss, so a persisted overlay
 * resolves on first view even if the warm-up raced ahead of it. Entries carry a
 * `<cacheKey>.png` name + a `delete` that drops the persisted PNG, so the hook's
 * existing version-prefix match and stale-file cleanup work identically to the
 * native disk twin.
 */

import {
  hydrateOverlayCache,
  snapshotOverlayEntries,
  type OverlayCacheEntry,
} from '../../modules/board-renderer/src/overlay-cache-store.web';

export type { OverlayCacheEntry };

// Start reading the Cache API into the retention map as soon as this module is
// imported (the shared hook imports it at app startup). Fire-and-forget — the
// store owns the promise and dedups repeat calls.
void hydrateOverlayCache();

export function listOverlayCacheEntries(_cacheDirName: string): OverlayCacheEntry[] | null {
  const entries = snapshotOverlayEntries();
  return entries.length > 0 ? entries : null;
}
