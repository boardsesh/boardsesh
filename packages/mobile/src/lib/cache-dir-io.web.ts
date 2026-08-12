// Browser twin of cache-dir-io.ts. There is no `Paths.cache` in a browser: the
// overlay store on web is the Cache API, already bounded by entry count
// (modules/board-renderer/src/overlay-cache-store.web.ts), and photos are held
// by the browser's own HTTP cache. Nothing here to measure, nothing to sweep —
// so every caller sees the same "directory absent" answer a clean install gives.

import type { CacheDirEntry } from './cache-sweep-plan';

export type CacheDirWalk = {
  entries: CacheDirEntry[];
  totalBytes: number;
};

export async function walkCacheDir(): Promise<CacheDirWalk | null> {
  return null;
}

export function deleteCacheDirEntries(): number {
  return 0;
}

export function resolveImageCacheDirName(): string | null {
  return null;
}
