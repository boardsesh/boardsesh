import { BoundedLru } from '@boardsesh/board-render';
import type { OgBaseResult } from '@boardsesh/board-render/pipeline';

/**
 * Process-lifetime caches for `/api/internal/board-render`.
 *
 * The route used to re-decode every board photo on every request — at ~50k
 * renders/day that is the bulk of both the CPU time and the peak memory that
 * was OOM-killing the function. These mirror the pattern the long-running
 * backend OG renderer has used since #3829: one cache for the composed board
 * photos, one for the final encoded bytes.
 *
 * They live outside route.ts because an App Router route module may only export
 * handlers and route config — a test-visible reset has to hang off a sibling.
 */

/**
 * Folded board photos (raw RGBA, dim baked in) keyed by board config + size +
 * dim. Roughly 10 MB for the biggest board, so the byte budget — not the entry
 * count — is what bounds this.
 */
export const boardBaseCache = new BoundedLru<Buffer>({
  maxEntries: 24,
  maxBytes: 64 * 1024 * 1024,
  sizeOf: (buffer) => buffer.length,
});

/** OG social-card bases (backdrop + board photos, raw RGBA at 1200×630 ≈ 3 MB each). */
export const ogBaseCache = new BoundedLru<OgBaseResult>({
  maxEntries: 8,
  maxBytes: 32 * 1024 * 1024,
  sizeOf: (value) => value.base.length,
});

/**
 * Final encoded bytes, keyed by the full canonical param tuple. This absorbs
 * the list pages re-requesting the same climbs while the CDN entry is still
 * cold. Entry sizes span two orders of magnitude — a thumbnail is a few KB but
 * a full-size lossless-WebP render measured 326 KB — so 32 MB is what makes the
 * 2000-entry ceiling reachable for thumbnails while still holding ~100
 * full-size renders.
 */
export const byteCache = new BoundedLru<{ buffer: Buffer; contentType: string }>({
  maxEntries: 2000,
  maxBytes: 32 * 1024 * 1024,
  sizeOf: (value) => value.buffer.length,
});

/**
 * Test-only: drop every entry so one test's render can't serve another's
 * request. Never called in production — these caches are meant to outlive
 * requests.
 */
export function resetBoardRenderCaches(): void {
  boardBaseCache.clear();
  ogBaseCache.clear();
  byteCache.clear();
}
