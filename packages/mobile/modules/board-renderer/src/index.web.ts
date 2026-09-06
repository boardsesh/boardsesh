/**
 * Web twin of the native BoardRenderer module (index.ts).
 *
 * The native module rasterises the holds-only overlay in Swift/Kotlin and
 * returns a `file://` URI. On web there is no native binary, so we drive the
 * SAME Rust core — compiled to WebAssembly at
 * packages/board-renderer/wasm/pkg — on the main thread and return a
 * `blob:` object URL that react-native-web's <Image> renders exactly like a
 * `file://` URI.
 *
 * It honours the same exported contract the hook consumes:
 *   - `boardRendererNative` — truthy so the hook's presence check passes and
 *     it proceeds to call `renderHoldsOverlay` (see getNativeModule() in
 *     use-native-climb-render.ts).
 *   - `renderHoldsOverlay(configJson, cacheKey)` — resolves to an image URL.
 *   - `MARKER_RENDERER_UNAVAILABLE_MESSAGE` — for contract parity.
 *
 * There is no marker-capability guard here any more. The committed artifact
 * used to be the overlay-only core (8-field RenderConfig, no
 * `stroke_width_multiplier` / `shape_size_multiplier` / per-hold `shape`), so
 * this module refused shape and size overrides rather than let serde drop the
 * keys and draw plain circles. That left every overlay blank once someone
 * touched those settings (issue #4495). The pkg is now rebuilt from the
 * marker-aware core and honours all three, so the refusal is gone:
 * packages/mobile/public/wasm/README.md records the toolchain the binary was
 * built with, and src/lib/__tests__/board-renderer-wasm-runtime.test.ts fails
 * if a stale artifact is ever committed again.
 *
 * MARKER_RENDERER_UNAVAILABLE_MESSAGE stays exported: index.ts still throws it
 * for native binaries that predate marker support, and the hook still matches
 * on it to degrade to a colour-only render.
 */

import {
  getRenderedObjectUrl,
  rememberObjectUrl,
  releaseAllObjectUrls,
  readOverlayFromCache,
  writeOverlayToCache,
  _overlayCacheStoreForTests,
} from './overlay-cache-store.web';

// Signals "a web renderer is available" to the hook, which only checks this for
// truthiness before calling the top-level renderHoldsOverlay wrapper. There is
// no native module object to mirror on web.
export const boardRendererNative: { readonly platform: 'web' } = { platform: 'web' };

/**
 * The browser renders through WASM on the JS thread; one render at a time is
 * all that can happen anyway. Mirrors the native wrapper's export so the JS
 * render scheduler sizes itself the same way on every platform.
 */
export function getNativeRenderConcurrency(): number {
  return 1;
}

export const MARKER_RENDERER_UNAVAILABLE_MESSAGE =
  'Marker shape, size, and brush overrides require a rebuilt BoardRenderer native binary';

export const BOARDSESH_RENDERER_UNAVAILABLE_MESSAGE =
  'The Boardsesh render mode requires a rebuilt BoardRenderer native binary';

/**
 * Shape of the wasm-bindgen glue module (packages/board-renderer/wasm/pkg,
 * copied verbatim into public/wasm — see public/wasm/README.md). `default` is
 * wasm-bindgen's `__wbg_init`, which fetches + instantiates the `.wasm` given
 * its URL; `render_overlay` returns the raw RGBA overlay prefixed with an
 * 8-byte little-endian width/height header.
 */
type WasmGlueModule = {
  default: (init: { module_or_path: string }) => Promise<unknown>;
  render_overlay: (configJson: string) => Uint8Array;
};

const WEB_APP_BASE_PATH = '/app/';
const WASM_GLUE_FILE = 'board_renderer_wasm.js';
const WASM_BINARY_FILE = 'board_renderer_wasm_bg.wasm';

function resolveWasmAssetUrl(fileName: string): string {
  if (typeof location === 'undefined') return `${WEB_APP_BASE_PATH}wasm/${fileName}`;
  const configuredBase =
    typeof document !== 'undefined' ? document.querySelector('base')?.getAttribute('href') : undefined;
  const unresolvedBasePath =
    configuredBase ?? (location.pathname === '/app' || location.pathname.startsWith('/app/') ? WEB_APP_BASE_PATH : '/');
  const basePath = unresolvedBasePath.endsWith('/') ? unresolvedBasePath : `${unresolvedBasePath}/`;
  return new URL(`wasm/${fileName}`, new URL(basePath, location.origin)).href;
}

let renderOverlayFn: ((configJson: string) => Uint8Array) | null = null;
let wasmInitPromise: Promise<(configJson: string) => Uint8Array> | null = null;

/**
 * Initialise the WASM core once and memoise the render function. On failure the
 * memoised promise is cleared so a later render can retry (e.g. after a
 * transient network error fetching the glue/binary), mirroring the Next.js
 * board-render worker.
 */
function ensureWasmInitialized(): Promise<(configJson: string) => Uint8Array> {
  if (renderOverlayFn) return Promise.resolve(renderOverlayFn);
  if (!wasmInitPromise) {
    wasmInitPromise = (async () => {
      try {
        const glueUrl = resolveWasmAssetUrl(WASM_GLUE_FILE);
        const wasmUrl = resolveWasmAssetUrl(WASM_BINARY_FILE);

        // Load the glue by URL at runtime. Metro must NOT bundle it (it is not a
        // module in the graph — it is a static file under public/), so the
        // specifier is hidden inside a Function body Metro's static analysis
        // never parses. This mirrors the Next worker's webpackIgnore'd dynamic
        // import of the same glue.
        // oxlint-disable-next-line no-new-func, typescript/no-implied-eval
        const importModule = new Function('specifier', 'return import(specifier)') as (
          specifier: string,
        ) => Promise<WasmGlueModule>;
        const glue = await importModule(glueUrl);
        // Object-form init arg avoids wasm-bindgen's deprecated-parameters warning.
        await glue.default({ module_or_path: wasmUrl });
        renderOverlayFn = glue.render_overlay;
        return renderOverlayFn;
      } catch (error) {
        wasmInitPromise = null;
        throw error;
      }
    })();
  }
  return wasmInitPromise;
}

/**
 * Encode raw RGBA pixels to a PNG Blob via a canvas. Prefers OffscreenCanvas
 * (available on the main thread in modern browsers, promise API); falls back to
 * an HTMLCanvasElement when it is not. The caller turns the Blob into an object
 * URL and persists its bytes to the Cache API — keeping both concerns on the
 * main thread (finding C2).
 */
async function encodeRgbaToPngBlob(
  // Backed by its own ArrayBuffer (not SharedArrayBuffer) — the shape
  // ImageData's ImageDataArray requires. The caller builds it from the WASM
  // bytes via the copying TypedArray constructor.
  rgba: Uint8ClampedArray<ArrayBuffer>,
  width: number,
  height: number,
): Promise<Blob> {
  if (typeof ImageData === 'undefined') throw new Error('ImageData is unavailable in this browser');
  const imageData = new ImageData(rgba, width, height);

  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Failed to get 2d context from OffscreenCanvas');
    context.putImageData(imageData, 0, 0);
    return canvas.convertToBlob({ type: 'image/png' });
  }

  if (typeof document === 'undefined') throw new Error('Canvas is unavailable outside a browser document');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Failed to get 2d context from canvas');
  context.putImageData(imageData, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('canvas.toBlob produced no PNG blob');
  return blob;
}

// ── Off-main-thread render (Worker) with a main-thread fallback ─────────────
// The WASM render + PNG encode run in a Worker served from public/wasm/ (loaded
// by runtime URL so Metro never bundles it — see board-render.worker.js). The
// worker returns the encoded PNG bytes; the object-URL + Cache-API lifecycle
// stays on the main thread. Any worker failure (unsupported, load/parse error,
// timeout) degrades transparently to the main-thread render below, which stays
// the authoritative path — so the worker is a pure latency optimisation and
// every code path (incl. jsdom tests, where Worker is absent) still renders.

type WorkerRenderMessage = { id: number; png?: ArrayBuffer; error?: string };

const workerPending = new Map<number, (message: WorkerRenderMessage | null) => void>();
let boardRenderWorker: Worker | null = null;
let workerDisabled = false;
let workerRequestId = 0;
const WORKER_RENDER_TIMEOUT_MS = 8000;

// Abandon the worker for the rest of this page's lifetime: settle every
// in-flight request so its caller falls through to the main thread, drop the
// cached instance, and flip the disable flag so getRenderWorker never hands the
// worker out again. Module-lifetime — a fresh page load re-creates the worker.
function disableRenderWorker(): void {
  workerDisabled = true;
  const worker = boardRenderWorker;
  boardRenderWorker = null;
  for (const settle of workerPending.values()) settle(null);
  workerPending.clear();
  if (worker) {
    try {
      worker.terminate();
    } catch {
      // best-effort
    }
  }
}

function getRenderWorker(): Worker | null {
  if (workerDisabled) return null;
  if (boardRenderWorker) return boardRenderWorker;
  if (typeof Worker === 'undefined') {
    workerDisabled = true;
    return null;
  }
  try {
    const worker = new Worker(resolveWasmAssetUrl('board-render.worker.js'), { type: 'module' });
    worker.onmessage = (event: MessageEvent<WorkerRenderMessage>) => {
      const settle = workerPending.get(event.data.id);
      if (settle) settle(event.data);
    };
    worker.onerror = () => {
      // The worker script failed to load/parse/run — abandon it and route every
      // in-flight and future render through the main thread.
      disableRenderWorker();
    };
    boardRenderWorker = worker;
    return worker;
  } catch {
    workerDisabled = true;
    return null;
  }
}

/** Render a PNG Blob via the worker, or null on any failure so the caller falls back. */
function tryRenderPngBlobViaWorker(configJson: string): Promise<Blob | null> {
  const worker = getRenderWorker();
  if (!worker) return Promise.resolve(null);
  return new Promise<Blob | null>((resolve) => {
    const id = ++workerRequestId;
    let done = false;
    const finish = (blob: Blob | null) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      workerPending.delete(id);
      resolve(blob);
    };
    const timeout = setTimeout(() => {
      // The worker missed the budget — treat it as stuck. Disabling it settles
      // this request (falling it through to the main thread) AND routes every
      // future cache miss straight to the main renderer, instead of each one
      // posting to the same wedged worker and eating another full timeout.
      disableRenderWorker();
    }, WORKER_RENDER_TIMEOUT_MS);
    workerPending.set(id, (message) => {
      if (message && message.png) {
        finish(new Blob([message.png], { type: 'image/png' }));
      } else {
        // A worker-reported render error (or an onerror null) falls through to
        // the main thread, which reproduces the authoritative result or error.
        finish(null);
      }
    });
    try {
      worker.postMessage({ id, configJson });
    } catch {
      finish(null);
    }
  });
}

async function renderPngBlob(configJson: string): Promise<Blob> {
  const viaWorker = await tryRenderPngBlobViaWorker(configJson);
  if (viaWorker) return viaWorker;

  const renderOverlay = await ensureWasmInitialized();
  const rawBytes = renderOverlay(configJson);
  const { rgba, width, height } = decodeRenderOutput(rawBytes);
  return encodeRgbaToPngBlob(rgba, width, height);
}

const MAX_RENDER_DIMENSION = 8192;
const MAX_RENDER_PIXELS = 32 * 1024 * 1024;

function decodeRenderOutput(rawBytes: Uint8Array): {
  rgba: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
} {
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
  return { width, height, rgba: new Uint8ClampedArray(rawBytes.subarray(8)) };
}

// ── Boardsesh capability probe (issue #2202) ───────────────────────────────
// The web twin of index.ts's probe, and it asks the identical question for the
// identical reason: RenderConfig has no `deny_unknown_fields` and every
// Boardsesh field is `#[serde(default)]`, so a wasm artifact built before the
// mode existed accepts the same config, drops every key, and returns a classic
// render with no error to notice. The committed pkg IS rebuilt from the
// Boardsesh core, so this should always answer true — running it anyway keeps
// web and native on ONE code path, and turns a stale artifact (the exact mistake
// board-renderer-wasm-runtime.test.ts exists to catch) into a refusal instead of
// a silently wrong drawing.
//
// Nothing here touches the overlay cache: it renders PNG blobs directly, below
// the cache layer renderHoldsOverlay owns, so there are no probe artifacts to
// clean up.

const PROBE_CONFIG_BASE = {
  board_width: 8,
  board_height: 8,
  output_width: 8,
  frames: '',
  thumbnail: false,
  holds: [],
  hold_state_map: {},
} as const;

const CLASSIC_PROBE_CONFIG_JSON = JSON.stringify({ ...PROBE_CONFIG_BASE, render_mode: 'classic' });
const BOARDSESH_PROBE_CONFIG_JSON = JSON.stringify({
  ...PROBE_CONFIG_BASE,
  render_mode: 'aura',
  veil: { color: '#FFFFFF', opacity: 1 },
});

/** True when the two probe PNGs are not the same image. */
async function pngBlobsDiffer(first: Blob, second: Blob): Promise<boolean> {
  if (first.size !== second.size) return true;
  const [firstBytes, secondBytes] = await Promise.all([first.arrayBuffer(), second.arrayBuffer()]);
  const firstView = new Uint8Array(firstBytes);
  const secondView = new Uint8Array(secondBytes);
  for (let index = 0; index < firstView.length; index += 1) {
    if (firstView[index] !== secondView[index]) return true;
  }
  return false;
}

let boardseshSupportProbe: Promise<boolean> | null = null;

async function runBoardseshSupportProbe(): Promise<boolean> {
  try {
    const classicPng = await renderPngBlob(CLASSIC_PROBE_CONFIG_JSON);
    const boardseshPng = await renderPngBlob(BOARDSESH_PROBE_CONFIG_JSON);
    return await pngBlobsDiffer(classicPng, boardseshPng);
  } catch {
    // A wasm core that can't load or render at all is not a Boardsesh-capable
    // one; the classic path surfaces the underlying failure on its own.
    return false;
  }
}

/**
 * Does the loaded wasm core actually implement the Boardsesh render mode?
 * Memoised for the page's lifetime — the artifact can't change without a reload.
 */
export function probeBoardseshRendererSupport(): Promise<boolean> {
  boardseshSupportProbe ??= runBoardseshSupportProbe();
  return boardseshSupportProbe;
}

/** Test-only handle: forget the memoised probe result so the next call re-runs it. */
export function _resetBoardseshProbeForTests(): void {
  boardseshSupportProbe = null;
}

function configRequestsBoardseshMode(configJson: string): boolean {
  try {
    const parsedConfig: unknown = JSON.parse(configJson);
    if (!parsedConfig || typeof parsedConfig !== 'object' || Array.isArray(parsedConfig)) return false;
    return (parsedConfig as Record<string, unknown>).render_mode === 'aura';
  } catch {
    return false;
  }
}

export async function renderHoldsOverlay(configJson: string, cacheKey: string): Promise<string> {
  // 0. Boardsesh gate, ahead of the caches so a stale artifact can't serve a
  //    Boardsesh overlay it never drew. Classic configs skip it entirely and
  //    never wait on the probe.
  if (configRequestsBoardseshMode(configJson) && !(await probeBoardseshRendererSupport())) {
    throw new Error(BOARDSESH_RENDERER_UNAVAILABLE_MESSAGE);
  }

  // 1. Live in-session object URL — the fast path once a climb has rendered.
  const cached = getRenderedObjectUrl(cacheKey);
  if (cached) return cached;

  // 2. Persisted overlay from a prior session (survives a reload). On a hit this
  //    mints + retains a fresh object URL without touching the WASM core.
  const persisted = await readOverlayFromCache(cacheKey);
  if (persisted) return persisted;

  // 3. Render (worker, falling back to the main thread), then encode to a PNG
  //    Blob. First 8 bytes of the WASM output are width + height as u32 LE (see
  //    wasm/src/lib.rs); the glue returns an owned copy detached from WASM
  //    memory, so the decode is safe.
  const pngBlob = await renderPngBlob(configJson);

  const objectUrl = URL.createObjectURL(pngBlob);
  rememberObjectUrl(cacheKey, objectUrl);
  // Persist the bytes so the overlay survives a reload. Fire-and-forget — a
  // storage failure must not fail the render (the object URL already works).
  void writeOverlayToCache(cacheKey, pngBlob);
  return objectUrl;
}

type WebRendererTestApi = {
  decodeRenderOutput: typeof decodeRenderOutput;
  rememberObjectUrl: typeof rememberObjectUrl;
  releaseAllObjectUrls: typeof releaseAllObjectUrls;
  resolveWasmAssetUrl: typeof resolveWasmAssetUrl;
  renderedObjectUrls: typeof _overlayCacheStoreForTests.renderedObjectUrls;
  renderPngBlob: typeof renderPngBlob;
  encodeRgbaToPngBlob: typeof encodeRgbaToPngBlob;
  resetWorker: () => void;
};

// Test-only surface. Gated on __DEV__ so bundlers dead-code-eliminate it from
// the production web bundle (vitest defines __DEV__ truthy, so it's always
// present under test); the cast keeps a stable type for the test importers.
export const _webRendererForTests: WebRendererTestApi = (
  __DEV__
    ? {
        decodeRenderOutput,
        rememberObjectUrl,
        releaseAllObjectUrls,
        resolveWasmAssetUrl,
        renderedObjectUrls: _overlayCacheStoreForTests.renderedObjectUrls,
        renderPngBlob,
        encodeRgbaToPngBlob,
        resetWorker: () => {
          if (boardRenderWorker) {
            try {
              boardRenderWorker.terminate();
            } catch {
              // best-effort
            }
          }
          boardRenderWorker = null;
          workerDisabled = false;
          workerPending.clear();
        },
      }
    : undefined
) as WebRendererTestApi;
