// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Marco de Jongh

/**
 * Cross-session persistence + object-URL lifecycle for web board-render
 * overlays.
 *
 * On native, the BoardRenderer module writes each holds-only PNG to
 * {cache}/board-thumbnails/<cacheKey>.png, so a prior session's renders survive
 * a relaunch. On web there is no native disk cache; this module gives the web
 * renderer the equivalent by persisting the rendered PNG bytes in the **Cache
 * API** keyed by cacheKey, and hydrating fresh `blob:` object URLs from it on
 * startup.
 *
 * It also owns the in-session object-URL retention map (finding C2): object URLs
 * cannot be revoked while a mounted <Image> may still reference them and the
 * renderer contract has no per-URL release signal, so URLs are retained for the
 * document lifetime and released together on a non-persisted pagehide. There is
 * deliberately **no** LRU eviction that revokes in-use URLs.
 *
 * Both the renderer (modules/board-renderer/src/index.web.ts) and the overlay
 * warm-up (src/hooks/overlay-cache-warmup.web.ts) import this single store so a
 * given cacheKey maps to exactly one live object URL — no double-minting, no
 * leaks, one release path.
 */

// Kept structurally in sync with the native overlay-cache-warmup entry so the
// shared hook's import resolves to the same shape on both platforms.
export type OverlayCacheEntry = {
  uri?: string;
  name?: string;
  delete?: () => void;
};

// Cache API bucket for rendered overlays. The stored keys are synthetic
// same-scheme URLs (never fetched — the Cache API keys purely by URL), so the
// host portion is a placeholder.
const OVERLAY_CACHE_NAME = 'boardsesh-overlay-render-v1';
const OVERLAY_KEY_URL_PREFIX = 'https://overlay.boardsesh.invalid/';

// Ceiling on how many cached overlays we hydrate into memory at startup. Cache
// API keys come back in insertion order, so the tail is the most-recently
// rendered — those are the ones worth pre-warming. Bounds startup memory for a
// heavy user with a large accumulated cache while still making recently-viewed
// climbs instant on the first paint after a reload.
const OVERLAY_HYDRATE_LIMIT = 120;

function overlayKeyUrl(cacheKey: string): string {
  return `${OVERLAY_KEY_URL_PREFIX}${encodeURIComponent(cacheKey)}`;
}

function cacheKeyFromUrl(url: string): string | null {
  if (!url.startsWith(OVERLAY_KEY_URL_PREFIX)) return null;
  try {
    return decodeURIComponent(url.slice(OVERLAY_KEY_URL_PREFIX.length));
  } catch {
    return null;
  }
}

function overlayCacheAvailable(): boolean {
  return typeof caches !== 'undefined';
}

// cacheKey → live blob object URL. Shared retention map (C2). Populated by
// render, cache hydration, and cache reads; never evicted mid-session.
const renderedObjectUrls = new Map<string, string>();

export function getRenderedObjectUrl(cacheKey: string): string | undefined {
  return renderedObjectUrls.get(cacheKey);
}

export function rememberObjectUrl(cacheKey: string, objectUrl: string): void {
  renderedObjectUrls.set(cacheKey, objectUrl);
}

export function releaseAllObjectUrls(): void {
  for (const objectUrl of renderedObjectUrls.values()) URL.revokeObjectURL(objectUrl);
  renderedObjectUrls.clear();
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', (event) => {
    // Persisted pagehide = bfcache freeze; the page may be restored with its
    // <Image>s still mounted, so keep the URLs alive. Only a real teardown
    // (persisted === false) releases them.
    if (!event.persisted) releaseAllObjectUrls();
  });
}

async function openOverlayCache(): Promise<Cache | null> {
  if (!overlayCacheAvailable()) return null;
  try {
    return await caches.open(OVERLAY_CACHE_NAME);
  } catch {
    // Storage disabled (private mode, blocked cookies) — degrade to in-memory
    // only; the renderer still works, overlays just don't survive a reload.
    return null;
  }
}

/** Persist the rendered PNG bytes so the overlay survives a reload. Best-effort. */
export async function writeOverlayToCache(cacheKey: string, pngBlob: Blob): Promise<void> {
  const cache = await openOverlayCache();
  if (!cache) return;
  try {
    await cache.put(overlayKeyUrl(cacheKey), new Response(pngBlob, { headers: { 'Content-Type': 'image/png' } }));
  } catch {
    // Quota exceeded or storage revoked mid-session — non-fatal.
  }
}

/**
 * Look up a persisted overlay and, on a hit, mint (and retain) a fresh object
 * URL for it. Returns undefined on a miss so the caller falls through to a live
 * render.
 */
export async function readOverlayFromCache(cacheKey: string): Promise<string | undefined> {
  const existing = renderedObjectUrls.get(cacheKey);
  if (existing) return existing;

  const cache = await openOverlayCache();
  if (!cache) return undefined;
  try {
    const response = await cache.match(overlayKeyUrl(cacheKey));
    if (!response) return undefined;
    const blob = await response.blob();
    // A concurrent render may have populated the map while we awaited the cache.
    const raced = renderedObjectUrls.get(cacheKey);
    if (raced) return raced;
    const objectUrl = URL.createObjectURL(blob);
    rememberObjectUrl(cacheKey, objectUrl);
    return objectUrl;
  } catch {
    return undefined;
  }
}

/** Drop a persisted overlay and release its object URL. Used to reclaim stale-version PNGs. */
export async function deleteOverlayFromCache(cacheKey: string): Promise<void> {
  const objectUrl = renderedObjectUrls.get(cacheKey);
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    renderedObjectUrls.delete(cacheKey);
  }
  const cache = await openOverlayCache();
  if (!cache) return;
  try {
    await cache.delete(overlayKeyUrl(cacheKey));
  } catch {
    // Non-fatal — the entry simply lingers until the next sweep.
  }
}

let hydratePromise: Promise<void> | null = null;

/**
 * Pre-warm the retention map from the Cache API on startup: read the most-recent
 * persisted overlays and mint object URLs for them so the shared hook's
 * synchronous warm-up can surface prior-session renders. Idempotent — the first
 * call kicks off the async hydration and later calls await the same promise.
 *
 * `currentVersionPrefix` (e.g. `v5_`) makes eviction deterministic and
 * store-owned rather than dependent on the hook's warm-up: any key whose
 * cacheKey doesn't carry the current renderer version is deleted here, so
 * stale-version PNGs never burn a hydrate slot and are always reclaimed —
 * regardless of whether the shared warm-up wins the startup race. Omit it
 * (tests, callers that don't know the version) to keep the version-agnostic
 * behaviour.
 */
export function hydrateOverlayCache(currentVersionPrefix?: string): Promise<void> {
  if (hydratePromise) return hydratePromise;
  hydratePromise = (async () => {
    const cache = await openOverlayCache();
    if (!cache) return;
    let requests: readonly Request[];
    try {
      requests = await cache.keys();
    } catch {
      return;
    }

    // Partition into current-version and stale-version keys. Stale keys are a
    // different render format the hook can never match, so they're deleted
    // outright — this is the only production eviction path for old-version
    // bulk, and it runs whether or not the warm-up races ahead of hydration.
    const currentRequests: Request[] = [];
    const staleRequests: Request[] = [];
    for (const request of requests) {
      const cacheKey = cacheKeyFromUrl(request.url);
      const isStaleVersion =
        currentVersionPrefix !== undefined && (cacheKey === null || !cacheKey.startsWith(currentVersionPrefix));
      (isStaleVersion ? staleRequests : currentRequests).push(request);
    }

    // Tail = most-recently inserted; hydrate those first, bounded by the limit.
    const recent = currentRequests.slice(-OVERLAY_HYDRATE_LIMIT);
    for (const request of recent) {
      const cacheKey = cacheKeyFromUrl(request.url);
      if (!cacheKey || renderedObjectUrls.has(cacheKey)) continue;
      try {
        const response = await cache.match(request);
        if (!response) continue;
        const blob = await response.blob();
        // A concurrent render may have minted this key while we awaited the
        // cache; re-check before creating a second URL so we never orphan the
        // one already stored (and referenced by a mounted <Image>).
        if (renderedObjectUrls.has(cacheKey)) continue;
        rememberObjectUrl(cacheKey, URL.createObjectURL(blob));
      } catch {
        // Skip an unreadable entry; the rest still hydrate.
      }
    }

    // Prune so the Cache API can't grow unbounded across sessions: evict every
    // stale-version key plus the current-version overflow older than the most
    // recent OVERLAY_HYDRATE_LIMIT (which we didn't hydrate anyway). Without
    // this, cache.put eventually throws on quota and the renderer silently
    // stops persisting.
    const currentOverflow = currentRequests.slice(0, Math.max(0, currentRequests.length - OVERLAY_HYDRATE_LIMIT));
    for (const request of [...staleRequests, ...currentOverflow]) {
      try {
        await cache.delete(request);
      } catch {
        // Non-fatal — a failed delete just leaves the entry for the next sweep.
      }
    }
  })();
  return hydratePromise;
}

/**
 * Synchronous snapshot of the currently-hydrated overlays as the entry shape the
 * shared hook consumes. `name` is `<cacheKey>.png` so the hook's version-prefix
 * match + stale-file cleanup logic works identically to the native disk twin;
 * `delete` drops the persisted PNG (used by the hook for stale-version keys).
 */
export function snapshotOverlayEntries(): OverlayCacheEntry[] {
  return Array.from(renderedObjectUrls.entries()).map(([cacheKey, uri]) => ({
    uri,
    name: `${cacheKey}.png`,
    delete: () => {
      void deleteOverlayFromCache(cacheKey);
    },
  }));
}

export const _overlayCacheStoreForTests = {
  renderedObjectUrls,
  resetHydration: () => {
    hydratePromise = null;
  },
  OVERLAY_HYDRATE_LIMIT,
  overlayKeyUrl,
  cacheKeyFromUrl,
};
