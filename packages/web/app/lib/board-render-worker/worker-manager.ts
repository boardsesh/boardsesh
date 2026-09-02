/**
 * Pool manager for board render Web Workers.
 *
 * Distributes render requests across a small pool of workers (2 by default,
 * tuned for mobile) using round-robin scheduling. Deduplicates in-flight
 * requests so the same board+frames combo is only rendered once.
 */

import React from 'react';
import { BOARD_FIELD_COLORS } from '@boardsesh/board-look';
import { buildRenderConfig, type RenderMode } from '@boardsesh/board-render/render-config';
import type { RenderRequest, RenderResponse, PreloadImagesMessage } from './board-render.worker';
import { loadBoardGeometry } from './board-geometry-client';
import type { BoardDetails } from '@/app/lib/types';
import { HOLD_STATE_MAP, THUMBNAIL_WIDTH } from '@/app/components/board-renderer/types';
import { getImageUrl } from '@/app/components/board-renderer/util';
import { isCapacitor } from '@/app/lib/ble/capacitor-utils';
import { trackWorkerRenderingDisabled } from '@/app/lib/rendering-metrics';

// LRU cache for rendered bitmaps
const CACHE_MAX = 150;
const bitmapCache = new Map<string, ImageBitmap>();

/**
 * The render mode is part of the key, not an afterthought: Aura and classic draw
 * the same climb differently, and a bitmap cached under one must never be handed
 * back for the other. The field colour rides along because it decides the veil.
 */
function cacheKey(boardDetails: BoardDetails, options: Required<RenderBoardOptions>): string {
  const { frames, mirrored, thumbnail, renderMode, fieldColor } = options;
  const look = renderMode === 'aura' ? `aura:${fieldColor}` : 'classic';
  return `${boardDetails.board_name}:${boardDetails.layout_id}:${boardDetails.size_id}:${boardDetails.set_ids.join(',')}:${frames}:${mirrored ? 1 : 0}:${thumbnail ? 1 : 0}:${look}`;
}

/**
 * Compute how many pixels to crop from the top of the rendered board.
 * Uses the topmost hold position (minimum cy) minus its radius so the
 * board image starts just above the first row of holds.
 */
export function computeCropTop(boardDetails: BoardDetails, outputWidth: number): number {
  const holds = boardDetails.holdsData;
  if (holds.length === 0) return 0;

  // Find the topmost hold edge (cy - r) across all holds on the board
  let minTop = Infinity;
  for (const h of holds) {
    const top = h.cy - h.r;
    if (top < minTop) minTop = top;
  }

  // Scale from board coords to output pixels
  const scale = outputWidth / boardDetails.boardWidth;
  const cropPx = Math.max(0, Math.floor(minTop * scale));

  return cropPx;
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
let workerPoolDisabled = false;

// Deduplication: in-flight requests by cache key
const inflightRequests = new Map<string, Promise<ImageBitmap>>();

function getWorkerPool(): Worker[] {
  if (workerPoolDisabled) {
    throw new Error('Worker rendering is disabled after a worker load/runtime failure');
  }
  if (!workers) {
    workers = Array.from({ length: getPoolSize() }, (_, workerIdx) => {
      workerRequestIds.set(workerIdx, new Set());
      let w: Worker;
      try {
        w = new Worker(new URL('./board-render.worker.ts', import.meta.url));
      } catch (err) {
        workerPoolDisabled = true;
        markCanvasNotReady();
        trackWorkerRenderingDisabled('construct-failed');
        throw err;
      }
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
        // Prevent worker script-load/runtime errors from bubbling to
        // global window.onerror (notably in some WKWebView contexts).
        event.preventDefault();

        // Disable worker rendering for this session to avoid retry loops
        // when worker loading is broken in this runtime.
        workerPoolDisabled = true;
        markCanvasNotReady();
        trackWorkerRenderingDisabled('load-failed');

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

export type RenderBoardOptions = {
  boardDetails: BoardDetails;
  frames: string;
  mirrored: boolean;
  thumbnail?: boolean;
  /** Pre-computed crop top value. When provided, skips recomputing from holdsData.
   *  Callers that already computed cropTop for canvas sizing should pass it here
   *  to guarantee the canvas element and worker render stay in sync. */
  cropTop?: number;
  /** Which drawing. `classic` is the marker overlay; `aura` is the app's own. */
  renderMode?: RenderMode;
  /** `aura` only: the play field the veil washes the unlit wall toward. */
  fieldColor?: string;
};

/**
 * Check if the browser supports OffscreenCanvas (required for worker rendering).
 */
export function isWorkerRenderingSupported(): boolean {
  if (typeof window === 'undefined') return false;
  if (workerPoolDisabled) return false;
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

function markCanvasNotReady(): void {
  if (!globalCanvasReady) return;
  globalCanvasReady = false;
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
 * Assemble the WASM config for one render, through the same builder the backend
 * and the app use.
 *
 * The worker used to hand-roll this, and had drifted: it applied the classic
 * `displayColor ?? color` rule in every mode, which in Aura draws MoonBoard's
 * HAND a near-black blue instead of Beacon Cyan — a different hue, not a shade.
 * Going through `buildRenderConfig` also brings the glow tuning, the veil and
 * the traced silhouettes, none of which the worker could send before.
 *
 * The geometry is fetched, not bundled: `@boardsesh/board-art-geometry` is
 * 5.2 MB of shards behind an index of literal `require`s.
 */
async function buildWorkerRenderConfig(options: Required<RenderBoardOptions>) {
  const { boardDetails, frames, thumbnail, renderMode, fieldColor } = options;
  const geometry =
    renderMode === 'aura'
      ? await loadBoardGeometry({
          boardName: boardDetails.board_name,
          layoutId: boardDetails.layout_id,
          sizeId: boardDetails.size_id,
        })
      : null;

  const { config } = buildRenderConfig({
    boardName: boardDetails.board_name,
    boardDetails,
    frames,
    thumbnail,
    isOgVariant: false,
    boardStates: HOLD_STATE_MAP[boardDetails.board_name],
    thumbnailWidth: THUMBNAIL_WIDTH,
    renderMode,
    ...(renderMode === 'aura'
      ? {
          fieldColor,
          wallLightness: geometry?.wallLightness ?? null,
          ...(geometry ? { holdGeometry: geometry.holdGeometry } : {}),
        }
      : {}),
  });
  return config;
}

/**
 * Render a board image via the Web Worker.
 * Returns a cached ImageBitmap if available, otherwise queues a render request.
 */
export function renderBoard(options: RenderBoardOptions): Promise<ImageBitmap> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('renderBoard is not available during SSR'));
  }

  const { boardDetails, thumbnail = false } = options;
  const outputWidth = thumbnail ? THUMBNAIL_WIDTH : boardDetails.boardWidth;
  const resolved: Required<RenderBoardOptions> = {
    thumbnail,
    renderMode: 'classic',
    fieldColor: BOARD_FIELD_COLORS.dark,
    ...options,
    // Last, and computed rather than defaulted: a caller that already sized a
    // canvas passes its own crop, and the two must agree or the board is drawn
    // at one height into an element sized for another.
    cropTop: options.cropTop ?? (thumbnail ? 0 : computeCropTop(boardDetails, outputWidth)),
  };
  const key = cacheKey(boardDetails, resolved);

  // Check cache
  const cached = bitmapCache.get(key);
  if (cached) {
    // Move to end for LRU ordering
    bitmapCache.delete(key);
    bitmapCache.set(key, cached);
    return Promise.resolve(cached);
  }

  // Deduplicate: if the same render is already in flight, reuse its promise
  const inflight = inflightRequests.get(key);
  if (inflight) {
    return inflight;
  }

  // Build background image URLs — resolve to absolute so the Worker can fetch them
  const origin = window.location.origin;
  const backgroundUrls = Object.keys(boardDetails.images_to_holds).map((img) => {
    const url = getImageUrl(img, boardDetails.board_name, thumbnail);
    return url.startsWith('/') ? `${origin}${url}` : url;
  });

  // The config needs the traced art in Aura, which is a fetch; the background
  // images are pre-decoded into every worker in parallel with it, so a cold
  // Aura render costs one round trip, not two.
  const promise = Promise.all([buildWorkerRenderConfig(resolved), ensureImagesPreloaded(backgroundUrls)]).then(
    ([config]) =>
      new Promise<ImageBitmap>((resolve, reject) => {
        const id = nextRequestId++;
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
        const request: RenderRequest = {
          id,
          config,
          mirrored: resolved.mirrored,
          origin,
          backgroundUrls,
          cropTop: resolved.cropTop,
        };
        const { worker, workerIdx } = getNextWorker();
        workerRequestIds.get(workerIdx)?.add(id);
        worker.postMessage(request);
      }),
  );

  // A failed geometry fetch already resolves to null inside loadBoardGeometry,
  // but a thrown config build must not leave a rejected promise memoised for
  // the rest of the session.
  promise.catch(() => inflightRequests.delete(key));
  inflightRequests.set(key, promise);
  return promise;
}
