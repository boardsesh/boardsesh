// Board-render Web Worker (Expo-web target).
//
// Moves the WASM holds-overlay render + PNG encode off the main thread. This is
// a STATIC asset served verbatim from public/wasm/ — Metro never bundles it (it
// is not a module in the graph). The main thread constructs it with
//   new Worker(<runtime URL>, { type: 'module' })
// where the URL is computed at runtime, so the bundler's static analysis never
// sees a worker entry to bundle. See modules/board-renderer/src/index.web.ts.
//
// It intentionally mirrors the Next.js worker
// (packages/web/app/lib/board-render-worker/board-render.worker.ts): resolve the
// wasm-pack glue by absolute URL, init once, render, and hand the result back.
// This worker returns the encoded PNG bytes (not a composited ImageBitmap) —
// the object-URL + Cache-API lifecycle stays on the main thread so a single
// cacheKey maps to a single retained object URL (finding C2).

let renderOverlay = null;
let wasmInitPromise = null;

// The worker sits in the same /wasm/ directory as the glue + binary, so resolve
// them relative to the worker's own URL. This transparently honours whatever
// base path Expo serves the app under (e.g. /app/wasm/...).
function assetUrl(fileName) {
  return new URL(fileName, self.location.href).href;
}

async function ensureWasmInitialized() {
  if (renderOverlay) return renderOverlay;
  if (!wasmInitPromise) {
    wasmInitPromise = (async () => {
      try {
        const glue = await import(assetUrl('board_renderer_wasm.js'));
        await glue.default({ module_or_path: assetUrl('board_renderer_wasm_bg.wasm') });
        renderOverlay = glue.render_overlay;
        return renderOverlay;
      } catch (error) {
        // Reset so a later render can retry after a transient failure.
        wasmInitPromise = null;
        throw error;
      }
    })();
  }
  return wasmInitPromise;
}

const MAX_RENDER_DIMENSION = 8192;
const MAX_RENDER_PIXELS = 32 * 1024 * 1024;

// Mirror of index.web.ts's decodeRenderOutput: first 8 bytes are width/height as
// u32 LE, followed by RGBA pixels. Validates dimensions before allocating.
function decodeRenderOutput(rawBytes) {
  if (rawBytes.byteLength < 8) throw new Error('Board renderer returned a truncated image header');
  const header = new DataView(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);
  const width = header.getUint32(0, true);
  const height = header.getUint32(4, true);
  const pixelCount = width * height;
  if (width === 0 || height === 0 || width > MAX_RENDER_DIMENSION || height > MAX_RENDER_DIMENSION) {
    throw new Error(`Board renderer returned invalid dimensions: ${width}x${height}`);
  }
  if (!Number.isSafeInteger(pixelCount) || pixelCount > MAX_RENDER_PIXELS) {
    throw new Error(`Board renderer returned too many pixels: ${pixelCount}`);
  }
  const expectedByteLength = 8 + pixelCount * 4;
  if (rawBytes.byteLength !== expectedByteLength) {
    throw new Error(`Board renderer returned ${rawBytes.byteLength} bytes; expected ${expectedByteLength}`);
  }
  // Owned copy detached from WASM memory (which can grow/relocate).
  return { width, height, rgba: new Uint8ClampedArray(rawBytes.subarray(8)) };
}

async function encodeRgbaToPng(rgba, width, height) {
  const imageData = new ImageData(rgba, width, height);
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Failed to get 2d context from OffscreenCanvas');
  context.putImageData(imageData, 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return blob.arrayBuffer();
}

self.onmessage = async (event) => {
  const { id, configJson } = event.data ?? {};
  try {
    const render = await ensureWasmInitialized();
    const rawBytes = render(configJson);
    const { rgba, width, height } = decodeRenderOutput(rawBytes);
    const png = await encodeRgbaToPng(rgba, width, height);
    self.postMessage({ id, png }, [png]);
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
