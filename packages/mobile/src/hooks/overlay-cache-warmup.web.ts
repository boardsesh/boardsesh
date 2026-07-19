/**
 * Web twin of overlay-cache-warmup.ts.
 *
 * The native overlay warm-up scans the BoardRenderer module's on-disk PNG cache
 * ({cache}/board-thumbnails) to surface prior-session renders synchronously. On
 * web there is no native module and no such disk cache — the web board renderer
 * (modules/board-renderer/src/index.web.ts) returns per-session `blob:` object
 * URLs — so there is nothing to warm up. Returning null makes the shared hook's
 * warm-up a no-op without importing expo-file-system (which has no web build).
 *
 * A Cache-API–backed cross-session store is a Phase 1 follow-up.
 */

// Kept in sync with the native twin so the shared hook's import resolves to the
// same shape on both platforms.
export type OverlayCacheEntry = {
  uri?: string;
  name?: string;
  delete?: () => void;
};

export function listOverlayCacheEntries(_cacheDirName: string): OverlayCacheEntry[] | null {
  return null;
}
