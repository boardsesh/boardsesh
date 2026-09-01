import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { HOLD_STATE_MAP } from '@boardsesh/board-constants/hold-states';
import {
  BoundedLru,
  MAX_RENDER_OUTPUT_PIXELS,
  buildRenderConfig,
  createSemaphore,
  getBackgroundRelPaths,
  getBoardDetailsForBoard,
  type BoardArtColorScheme,
  type OutputFormat,
  type RenderableBoardDetails,
  type WasmRenderConfig,
} from '@boardsesh/board-render';
import {
  composeOgBaseBuffer,
  renderBoardImageBuffer,
  type OgBaseResult,
  type RenderTimings,
} from '@boardsesh/board-render/pipeline';
import { createOverlayRenderer, type OverlayRenderer } from '@boardsesh/board-render/wasm';
import type { BoardName } from '@boardsesh/shared-schema';
import sharp from 'sharp';
import { logger } from '../utils/logger';

/**
 * libvips is process-global, so configure it before the renderer can initialise.
 * These conservative limits also apply to avatar, gym-photo, and beta-thumbnail
 * resizing in this backend. Those paths trade some throughput for the bounded
 * memory footprint required by full-size board renders.
 */
sharp.cache({ memory: 16, files: 4, items: 100 });
sharp.concurrency(1);

/** Default configs warmed sequentially after WASM initialisation. */
const FALLBACK_BOARD_PREVIEW_CONFIGS: Record<string, { layout_id: number; size_id: number; set_ids: number[] }> = {
  kilter: { layout_id: 1, size_id: 10, set_ids: [1, 20] },
  tension: { layout_id: 1, size_id: 10, set_ids: [1] },
  moonboard: { layout_id: 2, size_id: 1, set_ids: [2, 3, 4] },
  decoy: { layout_id: 2, size_id: 1, set_ids: [1, 2] },
  touchstone: { layout_id: 1, size_id: 1, set_ids: [1] },
  grasshopper: { layout_id: 1, size_id: 4, set_ids: [1, 2] },
  soill: { layout_id: 1, size_id: 1, set_ids: [1] },
  woods: { layout_id: 1, size_id: 2, set_ids: [1] },
};

const MIB = 1024 * 1024;
const BOARD_BASE_CACHE_MAX_BYTES = 64 * MIB;
const OG_BASE_CACHE_MAX_BYTES = 32 * MIB;
const BYTE_CACHE_MAX_BYTES = 32 * MIB;

// Exactly three process-lifetime LRUs serve both public render endpoints.
const boardBaseCache = new BoundedLru<Buffer>({
  maxEntries: 24,
  maxBytes: BOARD_BASE_CACHE_MAX_BYTES,
  sizeOf: (buffer) => buffer.length,
});
const ogBaseCache = new BoundedLru<OgBaseResult>({
  maxEntries: 8,
  maxBytes: OG_BASE_CACHE_MAX_BYTES,
  sizeOf: (value) => value.base.length,
});
const byteCache = new BoundedLru<{ buffer: Buffer; contentType: string }>({
  maxEntries: 2_000,
  maxBytes: BYTE_CACHE_MAX_BYTES,
  sizeOf: (value) => value.buffer.length,
});

// Both endpoint families share final-render and base-composition coalescing.
const inFlightRenders = new Map<string, Promise<BoardImageRenderResult>>();
const boardBaseInFlight = new Map<string, Promise<Buffer | null>>();
const ogBaseInFlight = new Map<string, Promise<OgBaseResult>>();

function positiveIntegerFromEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback;
}

const RENDER_CONCURRENCY = positiveIntegerFromEnv('BOARD_RENDER_CONCURRENCY', 2);
const renderSemaphore = createSemaphore(RENDER_CONCURRENCY);
const MAX_QUEUED_RENDERS = positiveIntegerFromEnv('BOARD_RENDER_MAX_QUEUE', 40);
const INIT_RETRY_INTERVAL_MS = 30_000;

let overlayRenderer: OverlayRenderer | null = null;
let rendererAvailable = false;
let lastInitAttemptAtMs = 0;
let imagesRoot = '';
let initPromise: Promise<void> | null = null;
let warmupPromise: Promise<void> | null = null;
let initializationAttempts = 0;
let warmupRuns = 0;

export class RenderQueueSaturatedError extends Error {
  constructor() {
    super('Render queue is saturated');
    this.name = 'RenderQueueSaturatedError';
  }
}

export class RenderOutputTooLargeError extends Error {
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    super(`Requested render is ${width}x${height}, over the ${MAX_RENDER_OUTPUT_PIXELS}px limit`);
    this.name = 'RenderOutputTooLargeError';
  }
}

export class InvalidBoardRenderConfigError extends Error {
  constructor() {
    super('Invalid board configuration');
    this.name = 'InvalidBoardRenderConfigError';
  }
}

function resolveImagePath(relativePath: string): string | null {
  const absolutePath = join(imagesRoot, relativePath);
  return existsSync(absolutePath) ? absolutePath : null;
}

/**
 * Resolve and initialise the renderer eagerly. Failure is recorded rather than
 * thrown so the rest of the GraphQL/WebSocket service can still start.
 */
export function initBoardRenderer(): Promise<void> {
  if (rendererAvailable) return Promise.resolve();
  if (initPromise) return initPromise;

  initPromise = initializeBoardRenderer().finally(() => {
    initPromise = null;
  });
  return initPromise;
}

async function initializeBoardRenderer(): Promise<void> {
  initializationAttempts += 1;
  lastInitAttemptAtMs = Date.now();
  try {
    const require = createRequire(import.meta.url);
    const wasmJsPath = require.resolve('@boardsesh/board-renderer-wasm');
    const wasmBinaryPath = join(dirname(wasmJsPath), 'board_renderer_wasm_bg.wasm');
    if (!existsSync(wasmBinaryPath)) {
      throw new Error(`WASM binary not found at ${wasmBinaryPath}`);
    }

    imagesRoot = process.env.BOARD_IMAGES_ROOT || resolve(process.cwd(), '../web/public');
    const imagesDir = join(imagesRoot, 'images');
    if (!existsSync(imagesDir)) {
      logger.error(
        `[BoardRender] Board images directory missing at ${imagesDir} — renders will omit board photos. ` +
          'Set BOARD_IMAGES_ROOT to the directory that contains images/.',
      );
    }

    overlayRenderer = createOverlayRenderer(async () => readFile(wasmBinaryPath));
    await overlayRenderer.ensureInitialized();
    rendererAvailable = true;
    logger.info(`[BoardRender] Renderer initialised (images root: ${imagesRoot})`);

    // Warm in the background, one config at a time through the same semaphore
    // as requests. Warmups use its low-priority queue so request misses take
    // the next available slot instead of waiting behind the remaining boards.
    warmupRuns += 1;
    warmupPromise = warmFallbackBoardPreviews();
    void warmupPromise;
  } catch (error) {
    rendererAvailable = false;
    logger.error('[BoardRender] Renderer init failed — image endpoints will return 503:', error);
  }
}

export async function ensureBoardRendererAvailable(): Promise<boolean> {
  if (rendererAvailable) return true;
  if (initPromise) {
    await initPromise;
    return rendererAvailable;
  }
  if (Date.now() - lastInitAttemptAtMs >= INIT_RETRY_INTERVAL_MS) {
    await initBoardRenderer();
  }
  return rendererAvailable;
}

export type BoardImageRenderParams = {
  boardName: string;
  layoutId: number;
  sizeId: number;
  /** Query-order comma-separated set ids, preserved for compatibility. */
  setIds: string;
  frames: string;
  format: OutputFormat;
  /** "boardsesh" draws the veil + glow treatment; omitted/"classic" renders exactly as today (issue #2202). */
  renderMode?: 'classic' | 'aura';
  /** `boardsesh` mode only. Renderer defaults to "soft" when omitted. */
  glowFalloff?: 'soft' | 'plateau';
  /** `boardsesh` mode only: role glyphs inside the glow. */
  glyphs?: boolean;
  /** `boardsesh` mode only: feeds the placeholder veil color in prepareRender. */
  fieldColor?: string;
  colorScheme?: BoardArtColorScheme;
  thumbnail: boolean;
  includeBackground: boolean;
  dimBackground: number;
  isOgVariant: boolean;
};

export type BoardImageRenderResult = {
  buffer: Buffer;
  contentType: string;
  cache: 'hit' | 'base-hit' | 'miss' | 'none';
  timings: RenderTimings & { wasmMs: number; baseMs: number };
  queueMs: number;
};

export type OgClimbRenderParams = Pick<
  BoardImageRenderParams,
  | 'boardName'
  | 'layoutId'
  | 'sizeId'
  | 'setIds'
  | 'frames'
  | 'format'
  | 'renderMode'
  | 'glowFalloff'
  | 'glyphs'
  | 'fieldColor'
>;

export type OgClimbRenderResult = {
  buffer: Buffer;
  contentType: string;
  cache: 'hit' | 'base-hit' | 'miss';
  timings: { wasmMs: number; baseMs: number; encodeMs: number; composeMs?: number };
};

function isOgClimbRenderResult(
  rendered: BoardImageRenderResult,
): rendered is BoardImageRenderResult & OgClimbRenderResult {
  return rendered.cache !== 'none';
}

/**
 * Render-option suffix on the byte cache key, so a boardsesh render — and any
 * combination of its options — can never be served under a classic (or a
 * different boardsesh option's) key. The base cache does NOT carry it: the
 * base is the board-photo backdrop the overlay is composited onto, which no
 * overlay option can change, so one base serves every mode and the boot
 * warm-up is not wasted on the first boardsesh request.
 */
function renderOptionsCacheKeySuffix(options: {
  renderMode?: 'classic' | 'aura';
  glowFalloff?: 'soft' | 'plateau';
  glyphs?: boolean;
  fieldColor?: string;
}): string {
  // Classic ignores every other option, so a classic render keys as plain
  // `classic` whatever a caller happened to pass — an explicit `glow_falloff`
  // on a classic request must hit the same entry as the request without it.
  if (options.renderMode !== 'aura') return 'classic';
  return `boardsesh:${options.glowFalloff ?? 'soft'}:${options.glyphs ? '1' : '0'}:${options.fieldColor ?? 'unset'}`;
}

export function buildBoardRenderByteCacheKey(params: BoardImageRenderParams): string {
  // `v` intentionally is not a render param: one process has one renderer, so
  // cache-version aliases name identical bytes during a rolling deployment.
  return [
    params.boardName,
    params.layoutId,
    params.sizeId,
    params.setIds,
    params.frames,
    params.thumbnail ? '1' : '0',
    params.includeBackground ? '1' : '0',
    params.dimBackground,
    params.isOgVariant ? 'og' : 'std',
    params.format,
    renderOptionsCacheKeySuffix(params),
    params.colorScheme ?? 'light',
  ].join(':');
}

function prepareRender(params: BoardImageRenderParams): {
  boardDetails: RenderableBoardDetails;
  config: WasmRenderConfig;
} {
  const parsedSetIds = params.setIds
    .split(',')
    .map(Number)
    .filter((setId) => !Number.isNaN(setId));
  const boardStates = HOLD_STATE_MAP[params.boardName as BoardName];
  if (!boardStates) throw new Error(`No hold states defined for board ${params.boardName}`);

  let boardDetails: RenderableBoardDetails;
  try {
    boardDetails = getBoardDetailsForBoard({
      board_name: params.boardName,
      layout_id: params.layoutId,
      size_id: params.sizeId,
      set_ids: parsedSetIds,
    });
  } catch {
    throw new InvalidBoardRenderConfigError();
  }
  const { config } = buildRenderConfig({
    boardName: params.boardName,
    boardDetails,
    frames: params.frames,
    thumbnail: params.thumbnail,
    isOgVariant: params.isOgVariant,
    boardStates,
    renderMode: params.renderMode,
    glowFalloff: params.glowFalloff,
    glyphs: params.glyphs,
    // TODO(#2202): veil opacity from @boardsesh/board-art-geometry — nothing
    // computes real wall-lightness data yet, so boardsesh mode ships a no-op
    // (opacity 0) veil until that package lands.
    ...(params.renderMode === 'aura' ? { veil: { color: params.fieldColor ?? '#181225', opacity: 0 } } : {}),
  });
  const outputHeight = Math.round((config.output_width * config.board_height) / config.board_width);
  if (config.output_width * outputHeight > MAX_RENDER_OUTPUT_PIXELS) {
    throw new RenderOutputTooLargeError(config.output_width, outputHeight);
  }
  return { boardDetails, config };
}

/**
 * Render either a plain board image or an OG canvas through the shared caches,
 * in-flight maps, and concurrency limiter. Cache and coalesced hits never take
 * a semaphore slot and remain available even while the render queue is full.
 */
export async function renderBoardImage(params: BoardImageRenderParams): Promise<BoardImageRenderResult> {
  if (!overlayRenderer) throw new Error('Board renderer is not initialised');

  const cacheKey = buildBoardRenderByteCacheKey(params);
  const cached = byteCache.get(cacheKey);
  if (cached) {
    return {
      ...cached,
      cache: 'hit',
      timings: { wasmMs: 0, baseMs: 0, sharpMs: 0, composeMs: 0, encodeMs: 0, bgMs: 0 },
      queueMs: 0,
    };
  }

  const alreadyRendering = inFlightRenders.get(cacheKey);
  if (alreadyRendering) return alreadyRendering;

  // Reject before parsing board geometry or allocating a WASM config. This
  // check and the semaphore enqueue below are synchronous, so no other request
  // can interleave between them on the JS thread.
  if (renderSemaphore.pending >= MAX_QUEUED_RENDERS) {
    throw new RenderQueueSaturatedError();
  }
  const prepared = prepareRender(params);

  const queuedAt = performance.now();
  const renderPromise = renderSemaphore
    .run(async () => {
      const queueMs = performance.now() - queuedAt;
      const renderer = overlayRenderer;
      if (!renderer) throw new Error('Board renderer is not initialised');

      const wasmT0 = performance.now();
      const overlay = await renderer.render(JSON.stringify(prepared.config));
      const wasmMs = performance.now() - wasmT0;
      const overlayBuffer = Buffer.from(overlay.rgba.buffer, overlay.rgba.byteOffset, overlay.rgba.byteLength);
      const rendered = await renderBoardImageBuffer({
        overlayBuffer,
        width: overlay.width,
        height: overlay.height,
        isOgVariant: params.isOgVariant,
        format: params.format,
        thumbnail: params.thumbnail,
        includeBackground: params.includeBackground,
        dimBackground: params.dimBackground,
        boardDetails: prepared.boardDetails,
        resolveImagePath,
        colorScheme: params.colorScheme,
        caches: { boardBase: boardBaseCache, ogBase: ogBaseCache, boardBaseInFlight, ogBaseInFlight },
      });
      const cache = rendered.cache === 'hit' ? 'base-hit' : (rendered.cache ?? 'none');
      const result: BoardImageRenderResult = {
        buffer: rendered.buffer,
        contentType: rendered.contentType,
        cache,
        timings: { ...rendered.timings, wasmMs, baseMs: rendered.timings.bgMs },
        queueMs,
      };
      byteCache.set(cacheKey, { buffer: result.buffer, contentType: result.contentType });
      return result;
    })
    .finally(() => {
      inFlightRenders.delete(cacheKey);
    });
  inFlightRenders.set(cacheKey, renderPromise);
  return renderPromise;
}

/** `/og/climb` compatibility wrapper over the canonical renderer. */
export function renderOgClimb(params: OgClimbRenderParams): Promise<OgClimbRenderResult> {
  return renderBoardImage({
    ...params,
    thumbnail: false,
    includeBackground: true,
    dimBackground: 0,
    isOgVariant: true,
  }).then((rendered) => {
    if (!isOgClimbRenderResult(rendered)) {
      throw new Error('OG render completed without a configured base cache');
    }
    // Return the canonical result object so coalesced callers retain identity;
    // the guard above soundly narrows the OG cache outcome without a cast.
    return rendered;
  });
}

async function warmFallbackBoardPreviews(): Promise<void> {
  for (const [boardName, config] of Object.entries(FALLBACK_BOARD_PREVIEW_CONFIGS)) {
    try {
      await renderSemaphore.runLowPriority(() => warmBoardBase(boardName, config));
    } catch (error) {
      logger.warn(`[BoardRender] Warm-up failed for ${boardName}:`, error instanceof Error ? error.message : error);
    }
  }
  logger.info('[BoardRender] Fallback board preview warm-up complete');
}

async function warmBoardBase(
  boardName: string,
  fallback: { layout_id: number; size_id: number; set_ids: number[] },
): Promise<void> {
  const renderer = overlayRenderer;
  if (!renderer) return;
  const boardStates = HOLD_STATE_MAP[boardName as BoardName];
  if (!boardStates) return;

  const boardDetails = getBoardDetailsForBoard({
    board_name: boardName,
    layout_id: fallback.layout_id,
    size_id: fallback.size_id,
    set_ids: fallback.set_ids,
  });
  const { config } = buildRenderConfig({
    boardName,
    boardDetails,
    frames: '',
    thumbnail: false,
    isOgVariant: true,
    boardStates,
  });
  const overlay = await renderer.render(JSON.stringify(config));
  const ogKey = `${getBackgroundRelPaths(boardDetails, false).join('|')}:${overlay.width}x${overlay.height}:og`;
  if (ogBaseCache.has(ogKey)) return;

  const alreadyComposing = ogBaseInFlight.get(ogKey);
  const composePromise =
    alreadyComposing ??
    composeOgBaseBuffer({
      boardDetails,
      boardWidth: overlay.width,
      boardHeight: overlay.height,
      resolveImagePath,
    }).finally(() => {
      ogBaseInFlight.delete(ogKey);
    });
  if (!alreadyComposing) ogBaseInFlight.set(ogKey, composePromise);
  ogBaseCache.set(ogKey, await composePromise);
}

/** Test-only reset for process-lifetime render state. */
export function resetBoardRenderCaches(): void {
  boardBaseCache.clear();
  ogBaseCache.clear();
  byteCache.clear();
  boardBaseInFlight.clear();
  ogBaseInFlight.clear();
  inFlightRenders.clear();
}

/** Resolve after the current boot warm-up, if one exists. */
export function waitForBoardRenderWarmup(): Promise<void> {
  return warmupPromise ?? Promise.resolve();
}

export function getBoardRenderRuntimeStats(): {
  active: number;
  pending: number;
  boardBaseBytes: number;
  ogBaseBytes: number;
  byteCacheBytes: number;
  boardBaseMaxBytes: number;
  ogBaseMaxBytes: number;
  byteCacheMaxBytes: number;
  inFlightRenders: number;
  concurrency: number;
  queueLimit: number;
  initializing: boolean;
  initializationAttempts: number;
  warmupRuns: number;
} {
  return {
    active: renderSemaphore.active,
    pending: renderSemaphore.pending,
    boardBaseBytes: boardBaseCache.byteSize,
    ogBaseBytes: ogBaseCache.byteSize,
    byteCacheBytes: byteCache.byteSize,
    boardBaseMaxBytes: BOARD_BASE_CACHE_MAX_BYTES,
    ogBaseMaxBytes: OG_BASE_CACHE_MAX_BYTES,
    byteCacheMaxBytes: BYTE_CACHE_MAX_BYTES,
    inFlightRenders: inFlightRenders.size,
    concurrency: RENDER_CONCURRENCY,
    queueLimit: MAX_QUEUED_RENDERS,
    initializing: initPromise !== null,
    initializationAttempts,
    warmupRuns,
  };
}
