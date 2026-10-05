import { Directory, File, Paths } from 'expo-file-system';

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

export function deleteOverlayCacheEntry(uri: string): void {
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    /* A stale completion cannot fail sign-out. */
  }
}

/**
 * Confirm that a URI handed back by the native renderer still names a file.
 * Cache-pruning and OS storage pressure can remove an individual PNG after the
 * one-time directory warm-up populated JS's synchronous cache. This check is
 * intentionally made only after expo-image reports a load failure, keeping the
 * normal cache-hit path synchronous and free of filesystem I/O.
 */
export function overlayCacheEntryExists(uri: string): boolean {
  return new File(uri).exists;
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
