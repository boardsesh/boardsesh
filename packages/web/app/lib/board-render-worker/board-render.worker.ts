import type { WasmRenderConfig } from '@boardsesh/board-render/render-config';

/**
 * Web Worker for board rendering using WASM.
 *
 * Composites background board images + WASM-rendered hold overlay
 * into a single ImageBitmap, returned to the main thread.
 */

// Message types shared with worker-manager.ts
export type RenderRequest = {
  type?: 'render';
  id: number;
  /**
   * The complete overlay config, exactly as `buildRenderConfig` produced it —
   * board dimensions, output width, frames, every hold, the hold-state colours
   * and, in Aura, the veil / glow / fill / silhouettes. The worker forwards it
   * to WASM unchanged rather than assembling its own, so the browser draws what
   * the server and the app draw.
   */
  config: WasmRenderConfig;
  /** Applied as a canvas transform, not a re-render — halves the cache variants. */
  mirrored: boolean;
  backgroundUrls: string[];
  /** Origin URL for resolving WASM assets (sent from main thread) */
  origin?: string;
  /** Pixels to crop from the top of the output (shifts board content up) */
  cropTop?: number;
};

/** Pre-decoded background images sent from main thread to avoid per-worker fetching */
export type PreloadImagesMessage = {
  type: 'preload-images';
  images: Array<{ url: string; bitmap: ImageBitmap }>;
};

export type WorkerMessage = RenderRequest | PreloadImagesMessage;

export type RenderResponse = { id: number; bitmap: ImageBitmap } | { id: number; error: string };

// --- WASM module state ---
let wasmRenderOverlay: ((configJson: string) => Uint8Array) | null = null;
let wasmInitPromise: Promise<void> | null = null;

// The origin is sent from the main thread on first message, or we try self.location
let baseOrigin: string | null = null;

async function ensureWasmInitialized(): Promise<void> {
  if (wasmRenderOverlay) return;
  if (!wasmInitPromise) {
    wasmInitPromise = (async () => {
      // Resolve absolute URLs for WASM assets — relative paths don't work in Workers
      // because the worker's base URL may be a blob: URL from the bundler.
      const origin = baseOrigin || self.location.origin;
      const glueUrl = `${origin}/wasm/board_renderer_wasm.js`;
      const wasmUrl = `${origin}/wasm/board_renderer_wasm_bg.wasm`;
      try {
        // Dynamic import of the wasm-pack glue code
        const wasmModule = await import(/* webpackIgnore: true */ glueUrl);
        // Object-form init arg. The positional form still works, but logs a
        // wasm-bindgen deprecation warning on every worker boot.
        await wasmModule.default({ module_or_path: wasmUrl });
        wasmRenderOverlay = wasmModule.render_overlay;
      } catch (err) {
        // Reset so the next render attempt can retry (e.g. after transient network error)
        wasmInitPromise = null;
        throw err;
      }
    })();
  }
  await wasmInitPromise;
}

// --- Image cache for background images ---
const bgImageCache = new Map<string, ImageBitmap>();

async function fetchBackgroundImage(url: string): Promise<ImageBitmap> {
  const cached = bgImageCache.get(url);
  if (cached) return cached;

  const response = await fetch(url);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  bgImageCache.set(url, bitmap);
  return bitmap;
}

// --- Main render function ---
async function renderBoard(request: RenderRequest): Promise<ImageBitmap> {
  await ensureWasmInitialized();

  const { config, mirrored, backgroundUrls, cropTop = 0 } = request;
  const { board_width: boardWidth, board_height: boardHeight, output_width: outputWidth, frames } = config;

  const fullOutputHeight = Math.round((outputWidth * boardHeight) / boardWidth);
  const outputHeight = fullOutputHeight - cropTop;

  // Fetch all background images in parallel
  const bgImages = await Promise.all(backgroundUrls.map(fetchBackgroundImage));

  // Create OffscreenCanvas at target resolution (cropped height)
  const canvas = new OffscreenCanvas(outputWidth, outputHeight);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Failed to get 2d context from OffscreenCanvas');
  }

  // Apply mirroring transform before drawing anything
  if (mirrored) {
    ctx.translate(outputWidth, 0);
    ctx.scale(-1, 1);
  }

  // Draw background images shifted up by cropTop so the top edge is cropped
  for (const bgImage of bgImages) {
    ctx.drawImage(bgImage, 0, -cropTop, outputWidth, fullOutputHeight);
  }

  // Render hold overlay via WASM. The config already carries `mirrored: false`
  // — mirroring is the canvas transform above, so both orientations share one
  // cached render.
  if (frames && wasmRenderOverlay) {
    const rawBytes = wasmRenderOverlay(JSON.stringify(config));

    // Parse dimension header: first 8 bytes are width + height as u32 LE
    const view = new DataView(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);
    const overlayWidth = view.getUint32(0, true);
    const overlayHeight = view.getUint32(4, true);
    // .slice() creates an owned copy of the pixel data, detached from WASM memory.
    // This is critical — WASM memory can grow/relocate, invalidating views into it.
    const rgbaSlice = rawBytes.slice(8);
    const rgbaData = new Uint8ClampedArray(rgbaSlice.buffer, rgbaSlice.byteOffset, rgbaSlice.byteLength);

    // Draw overlay on top of backgrounds (shifted up by cropTop to match background)
    const overlayImageData = new ImageData(rgbaData, overlayWidth, overlayHeight);
    ctx.drawImage(await createImageBitmap(overlayImageData), 0, -cropTop, outputWidth, fullOutputHeight);
  }

  // Transfer as ImageBitmap
  return canvas.transferToImageBitmap();
}

// --- Worker message handler ---
self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
  const msg = event.data;

  // Handle pre-loaded background images from main thread
  if (msg.type === 'preload-images') {
    for (const { url, bitmap } of msg.images) {
      bgImageCache.set(url, bitmap);
    }
    return;
  }

  // Render request
  const request = msg;
  if (request.origin && !baseOrigin) {
    baseOrigin = request.origin;
  }
  try {
    const bitmap = await renderBoard(request);
    const response: RenderResponse = { id: request.id, bitmap };
    self.postMessage(response, { transfer: [bitmap] });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const response: RenderResponse = { id: request.id, error };
    self.postMessage(response);
  }
};
