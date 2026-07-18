import { Directory, Paths } from 'expo-file-system';

/**
 * A single entry from the native overlay PNG cache directory. Structurally the
 * subset of expo-file-system's `File` / `Directory` that the hook's warm-up
 * reads: `uri` (the file:// URI to reuse), `name` (to match the cache-key
 * filename), and `delete` (to reclaim stale-version PNGs).
 */
export type OverlayCacheEntry = {
  uri?: string;
  name?: string;
  delete?: () => void;
};

/**
 * List the native BoardRenderer module's on-disk PNG cache directory
 * ({cache}/<cacheDirName>). This is the ONLY filesystem I/O seam of the
 * overlay warm-up — extracted so the hook itself imports no expo-file-system
 * (which has no web build and must not evaluate on web; the .web.ts twin
 * returns null).
 *
 * Returns null when the directory doesn't exist yet (clean install, first
 * launch) so the caller skips the warm-up. Never throws for a missing
 * directory; other filesystem failures propagate to the caller's try/catch.
 */
export function listOverlayCacheEntries(cacheDirName: string): OverlayCacheEntry[] | null {
  const cacheDir = new Directory(Paths.cache, cacheDirName);
  if (!cacheDir.exists) return null;
  return cacheDir.list() as OverlayCacheEntry[];
}

/**
 * Web twin runs the handler once the async Cache API hydration resolves. Native
 * hydration is a synchronous disk list (listOverlayCacheEntries above), so there
 * is nothing to await and the handler is dropped — the hook's first synchronous
 * warm-up already sees the fully-listed directory.
 */
export function onOverlayCacheHydrated(_handler: () => void): void {
  // Intentionally a no-op on native.
}
