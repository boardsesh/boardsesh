/**
 * Pool manager for board render Web Workers.
 *
 * Distributes render requests across a small pool of workers (2 by default,
 * tuned for mobile) using round-robin scheduling. Deduplicates in-flight
 * requests so the same board+frames combo is only rendered once.
 */

import React from 'react';
import type { RenderRequest, RenderResponse, PreloadImagesMessage } from './board-render.worker';
import type { BoardDetails } from '@/app/lib/types';
import type { HoldRenderData } from '@/app/components/board-renderer/types';
import { getImageUrl } from '@/app/components/board-renderer/util';
import { HOLD_STATE_MAP } from '@/app/components/board-renderer/types';
import { isCapacitor } from '@/app/lib/ble/capacitor-utils';

// Thumbnail width matches server-side constant
const THUMBNAIL_WIDTH = 300;

// LRU cache for rendered bitmaps
const CACHE_MAX = 150;
const bitmapCache = new Map<string, ImageBitmap>();

function cacheKey(boardDetails: BoardDetails, frames: string, mirrored: boolean, thumbnail: boolean): string {
  return `${boardDetails.board_name}:${boardDetails.layout_id}:${boardDetails.size_id}:${boardDetails.set_ids.join(',')}:${frames}:${mirrored ? 1 : 0}:${thumbnail ? 1 : 0}`;
}

function cachePut(key: string, bitmap: ImageBitmap): void {
  // Evict oldest entry if at capacity.
  // Don't call .close() on evicted bitmaps — components may still hold references
  // to them (e.g. drawn on a canvas that hasn't re-rendered). Let GC reclaim them.
  if (bitmapCache.size >= CACHE_MAX) {
    const firstKey = bitmapCache.keys().next().value;
    if (firstKey !== undefined) {
      bitmapCache.delete(firstKey);
    }
  }
  bitmapCache.set(key, bitmap);
}

// --- Worker pool ---
// Capacitor WebView is a dedicated app context — can afford more workers.
// Browser tabs share resources, so keep it lighter.
function getPoolSize(): number {
  if (typeof window === 'undefined') return 1;
  return isCapacitor() ? 5 : 3;
}

type PendingRequest = {
  resolve: (bitmap: ImageBitmap) => void;
  reject: (error: Error) => void;
};

let workers: Worker[] | null = null;
let nextWorkerIndex = 0;
let nextRequestId = 0;
const pendingRequests = new Map<number, PendingRequest>();
// Track which request IDs are assigned to which worker index
const workerRequestIds = new Map<number, Set<number>>();

// Deduplication: in-flight requests by cache key
const inflightRequests = new Map<string, Promise<ImageBitmap>>();

function getWorkerPool(): Worker[] {
  if (!workers) {
    workers = Array.from({ length: getPoolSize() }, (_, workerIdx) => {
      workerRequestIds.set(workerIdx, new Set());
      const w = new Worker(new URL('./board-render.worker.ts', import.meta.url));
      w.onmessage = (event: MessageEvent<RenderResponse>) => {
        const response = event.data;
        const pending = pendingRequests.get(response.id);
        if (!pending) return;
        pendingRequests.delete(response.id);
        workerRequestIds.get(workerIdx)?.delete(response.id);

        if ('error' in response) {
          pending.reject(new Error(response.error));
        } else {
          pending.resolve(response.bitmap);
        }
      };
      w.onerror = (event) => {
        // Only reject requests assigned to this worker, not the entire pool
        const ids = workerRequestIds.get(workerIdx);
        if (!ids) return;
        const toReject = Array.from(ids);
        ids.clear();
        for (const id of toReject) {
          const pending = pendingRequests.get(id);
          if (pending) {
            pendingRequests.delete(id);
            pending.reject(new Error(`Worker error: ${event.message}`));
          }
        }
      };
      return w;
    });
  }
  return workers;
}

function getNextWorker(): { worker: Worker; workerIdx: number } {
  const pool = getWorkerPool();
  const workerIdx = nextWorkerIndex % pool.length;
  nextWorkerIndex++;
  return { worker: pool[workerIdx], workerIdx };
}

// --- Background image pre-fetch & distribution ---
// Tracks which URLs have already been pre-loaded into the worker pool
const preloadedUrls = new Set<string>();
// In-flight pre-load fetches so we don't double-fetch
const preloadInflight = new Map<string, Promise<ImageBitmap>>();

/**
 * Fetch a background image on the main thread (leverages browser cache from SSR),
 * then send copies to every worker so they never need to fetch it themselves.
 */
async function ensureImagesPreloaded(urls: string[]): Promise<void> {
  const newUrls = urls.filter((u) => !preloadedUrls.has(u));
  if (newUrls.length === 0) return;

  // Fetch & decode each new URL once on the main thread.
  // Filter out failures — a missing background image shouldn't block rendering.
  const results = await Promise.all(
    newUrls.map(async (url) => {
      let promise = preloadInflight.get(url);
      if (!promise) {
        promise = fetch(url)
          .then((r) => r.blob())
          .then((blob) => createImageBitmap(blob));
        preloadInflight.set(url, promise);
      }
      try {
        const bitmap = await promise;
        return { url, bitmap };
      } catch (err) {
        console.warn('Failed to preload background image:', url, err);
        return null;
      } finally {
        preloadInflight.delete(url);
      }
    }),
  );
  const bitmaps = results.filter((r): r is { url: string; bitmap: ImageBitmap } => r !== null);

  // Send a copy to each worker (ImageBitmap must be transferred, so we create
  // one copy per worker via createImageBitmap on the original)
  const pool = getWorkerPool();
  for (let i = 0; i < pool.length; i++) {
    const copies = await Promise.all(
      bitmaps.map(async ({ url, bitmap }) => ({
        url,
        bitmap: await createImageBitmap(bitmap),
      })),
    );
    const msg: PreloadImagesMessage = { type: 'preload-images', images: copies };
    pool[i].postMessage(msg, { transfer: copies.map((c) => c.bitmap) });
  }

  // Close the original bitmaps we used for cloning
  for (const { bitmap } of bitmaps) {
    bitmap.close();
  }

  for (const url of newUrls) {
    preloadedUrls.add(url);
  }
}

export interface RenderBoardOptions {
  boardDetails: BoardDetails;
  frames: string;
  mirrored: boolean;
  thumbnail?: boolean;
}

/**
 * Check if the browser supports OffscreenCanvas (required for worker rendering).
 */
export function isWorkerRenderingSupported(): boolean {
  if (typeof window === 'undefined') return false;
  return typeof OffscreenCanvas !== 'undefined' && typeof Worker !== 'undefined';
}

/**
 * Module-level flag so that once any component instance has confirmed the
 * canvas renderer is ready, subsequent instances (e.g. from infinite scroll)
 * can initialise with `true` immediately — avoiding a one-frame flash of
 * BoardImageLayers and the API request it triggers.
 */
let globalCanvasReady = false;
const canvasReadyListeners = new Set<() => void>();

function subscribeCanvasReady(listener: () => void): () => void {
  canvasReadyListeners.add(listener);
  return () => {
    canvasReadyListeners.delete(listener);
  };
}

function markCanvasReady(): void {
  if (globalCanvasReady) return;
  globalCanvasReady = true;
  canvasReadyListeners.forEach((listener) => listener());
}

/**
 * Hook that returns true once the Web Worker canvas renderer is ready (client-side only).
 * `useSyncExternalStore` ensures hydration always starts from the server snapshot (`false`),
 * so SSR image-layer markup matches the first client render. After the first mount marks
 * the renderer ready, later client-only mounts can read `true` immediately from the store.
 */
export function useCanvasRendererReady(): boolean {
  const ready = React.useSyncExternalStore(
    subscribeCanvasReady,
    () => globalCanvasReady && isWorkerRenderingSupported(),
    () => false,
  );

  React.useEffect(() => {
    if (isWorkerRenderingSupported()) {
      markCanvasReady();
    }
  }, []);

  return ready;
}

/**
 * Render a board image via the Web Worker.
 * Returns a cached ImageBitmap if available, otherwise queues a render request.
 */
export function renderBoard(options: RenderBoardOptions): Promise<ImageBitmap> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('renderBoard is not available during SSR'));
  }

  const { boardDetails, frames, mirrored, thumbnail = false } = options;
  const key = cacheKey(boardDetails, frames, mirrored, thumbnail);

  // Check cache
  const cached = bitmapCache.get(key);
  if (cached) {
    // Move to end for LRU ordering
    bitmapCache.delete(key);
    bitmapCache.set(key, cached);
    return Promise.resolve(cached);
  }

  const id = nextRequestId++;
  const outputWidth = thumbnail ? THUMBNAIL_WIDTH : boardDetails.boardWidth;

  // Build holds array for WASM
  const holds = boardDetails.holdsData.map((h: HoldRenderData) => ({
    id: h.id,
    mirrored_hold_id: h.mirroredHoldId,
    cx: h.cx,
    cy: h.cy,
    r: h.r,
  }));

  // Build hold state map for this board
  const holdStateMap: Record<number, { color: string }> = {};
  const boardStates = HOLD_STATE_MAP[boardDetails.board_name];
  for (const [code, info] of Object.entries(boardStates)) {
    holdStateMap[Number(code)] = { color: info.color };
  }

  // Build background image URLs — resolve to absolute so the Worker can fetch them
  const origin = window.location.origin;
  const backgroundUrls = Object.keys(boardDetails.images_to_holds).map((img) => {
    const url = getImageUrl(img, boardDetails.board_name, thumbnail);
    return url.startsWith('/') ? `${origin}${url}` : url;
  });

  const request: RenderRequest = {
    id,
    boardWidth: boardDetails.boardWidth,
    boardHeight: boardDetails.boardHeight,
    outputWidth,
    frames,
    mirrored,
    thumbnail,
    holds,
    holdStateMap,
    origin: window.location.origin,
    backgroundUrls,
  };

  // Deduplicate: if the same render is already in flight, reuse its promise
  const inflight = inflightRequests.get(key);
  if (inflight) {
    return inflight;
  }

  // Pre-load background images into all workers before dispatching the render.
  // This is fast for images already in the browser cache (from SSR).
  const promise = ensureImagesPreloaded(backgroundUrls).then(
    () =>
      new Promise<ImageBitmap>((resolve, reject) => {
        pendingRequests.set(id, {
          resolve: (bitmap) => {
            cachePut(key, bitmap);
            inflightRequests.delete(key);
            resolve(bitmap);
          },
          reject: (err) => {
            inflightRequests.delete(key);
            reject(err);
          },
        });
        const { worker, workerIdx } = getNextWorker();
        workerRequestIds.get(workerIdx)?.add(id);
        worker.postMessage(request);
      }),
  );

  inflightRequests.set(key, promise);
  return promise;
}
