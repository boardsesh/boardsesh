import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { HOLD_STATE_MAP } from '@boardsesh/board-constants/hold-states';
import { BoundedLru, buildRenderConfig, getBoardDetailsForBoard, type OutputFormat } from '@boardsesh/board-render';
import { composeOgBaseBuffer, encodeOgImage, type OgBaseResult } from '@boardsesh/board-render/pipeline';
import { createOverlayRenderer, type OverlayRenderer } from '@boardsesh/board-render/wasm';
import type { BoardName } from '@boardsesh/shared-schema';
import { logger } from '../utils/logger';

/**
 * Default board configs used to warm the OG base cache at boot. Mirrors web's
 * FALLBACK_BOARD_PREVIEW_CONFIGS (not imported — the backend must not depend
 * on packages/web) plus a MoonBoard 2016 entry so every supported board gets a
 * warm base.
 */
const FALLBACK_BOARD_PREVIEW_CONFIGS: Record<string, { layout_id: number; size_id: number; set_ids: number[] }> = {
  kilter: { layout_id: 1, size_id: 10, set_ids: [1, 20] },
  tension: { layout_id: 1, size_id: 10, set_ids: [1] },
  moonboard: { layout_id: 2, size_id: 1, set_ids: [2, 3, 4] },
  decoy: { layout_id: 2, size_id: 1, set_ids: [1, 2] },
  touchstone: { layout_id: 1, size_id: 1, set_ids: [1] },
  grasshopper: { layout_id: 1, size_id: 4, set_ids: [1, 2] },
  soill: { layout_id: 1, size_id: 1, set_ids: [1] },
};

const OG_BYTE_CACHE_MB = Number(process.env.OG_BYTE_CACHE_MB) || 32;
const OG_BASE_CACHE_ENTRIES = Number(process.env.OG_BASE_CACHE_ENTRIES) || 24;

// Final encoded bytes, keyed by the full canonical param string. Bytes-budgeted
// so a burst of unique climbs can't grow memory without bound.
const byteCache = new BoundedLru<{ buffer: Buffer; contentType: string }>({
  maxEntries: 10_000,
  maxBytes: OG_BYTE_CACHE_MB * 1024 * 1024,
  sizeOf: (value) => value.buffer.length,
});

// Pre-composited OG backdrop + board photos (raw RGBA), keyed by board config.
// Every climb on the same board reuses it, so only the cheap overlay composite
// + encode runs per climb. Entry-bounded (each base is ~3 MB raw), so no byte
// budget applies.
const baseCache = new BoundedLru<OgBaseResult>({
  maxEntries: OG_BASE_CACHE_ENTRIES,
  maxBytes: Infinity,
  sizeOf: (value) => value.base.length,
});

// Coalesces concurrent requests for the same uncached climb into one render —
// simultaneous crawler fetches (FB + Twitter + WhatsApp) must not each pay
// WASM + sharp for identical bytes.
const inFlightRenders = new Map<string, Promise<OgClimbRenderResult>>();

const INIT_RETRY_INTERVAL_MS = 30_000;

let overlayRenderer: OverlayRenderer | null = null;
let rendererAvailable = false;
let lastInitAttemptAtMs = 0;
let imagesRoot = '';

function resolveImagePath(relPath: string): string | null {
  const absolutePath = join(imagesRoot, relPath);
  return existsSync(absolutePath) ? absolutePath : null;
}

/**
 * Eagerly initialise the OG climb renderer at boot: resolve + load the WASM
 * binary, initialise the shared overlay renderer, and locate the board images
 * root. On any failure the renderer is marked unavailable (the endpoint returns
 * 503) — this never throws, so a missing asset can't crash the server.
 */
export async function initBoardRenderer(): Promise<void> {
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
        `[OGClimb] Board images directory missing at ${imagesDir} — OG cards will render without board photos. ` +
          'Set BOARD_IMAGES_ROOT to the directory that contains images/.',
      );
    }

    overlayRenderer = createOverlayRenderer(async () => readFile(wasmBinaryPath));
    await overlayRenderer.ensureInitialized();
    rendererAvailable = true;
    logger.info(`[OGClimb] Board renderer initialised (images root: ${imagesRoot})`);

    // Warm the fallback board bases in the background — never block boot.
    void warmFallbackBoardPreviews();
  } catch (error) {
    rendererAvailable = false;
    logger.error('[OGClimb] Board renderer init failed — /og/climb will return 503:', error);
  }
}

/**
 * True when the renderer is ready. When boot-time init failed (e.g. a transient
 * I/O error), re-attempts init at most once per INIT_RETRY_INTERVAL_MS so the
 * endpoint recovers without a process restart.
 */
export async function ensureBoardRendererAvailable(): Promise<boolean> {
  if (rendererAvailable) return true;
  if (Date.now() - lastInitAttemptAtMs >= INIT_RETRY_INTERVAL_MS) {
    await initBoardRenderer();
  }
  return rendererAvailable;
}

export type OgClimbRenderParams = {
  boardName: string;
  layoutId: number;
  sizeId: number;
  /** Canonical comma-separated set ids, e.g. "1,20". */
  setIds: string;
  frames: string;
  format: OutputFormat;
};

export type OgClimbRenderResult = {
  buffer: Buffer;
  contentType: string;
  cache: 'hit' | 'base-hit' | 'miss';
  timings: { wasmMs: number; baseMs: number; encodeMs: number };
};

function byteCacheKey(params: OgClimbRenderParams): string {
  return `${params.boardName}:${params.layoutId}:${params.sizeId}:${params.setIds}:${params.frames}:${params.format}`;
}

function baseCacheKey(boardName: string, layoutId: number, sizeId: number, setIds: string): string {
  return `${boardName}:${layoutId}:${sizeId}:${setIds}`;
}

/**
 * Render a climb OG card. Serves from the final-bytes cache when possible,
 * otherwise renders the WASM overlay, composites it onto a (cached or freshly
 * built) OG base, encodes, and stores both caches.
 */
export async function renderOgClimb(params: OgClimbRenderParams): Promise<OgClimbRenderResult> {
  if (!overlayRenderer) {
    throw new Error('Board renderer is not initialised');
  }

  const cacheKey = byteCacheKey(params);
  const cached = byteCache.get(cacheKey);
  if (cached) {
    return { ...cached, cache: 'hit', timings: { wasmMs: 0, baseMs: 0, encodeMs: 0 } };
  }

  const inFlight = inFlightRenders.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const renderPromise = renderOgClimbUncached(params, cacheKey).finally(() => {
    inFlightRenders.delete(cacheKey);
  });
  inFlightRenders.set(cacheKey, renderPromise);
  return renderPromise;
}

async function renderOgClimbUncached(params: OgClimbRenderParams, cacheKey: string): Promise<OgClimbRenderResult> {
  if (!overlayRenderer) {
    throw new Error('Board renderer is not initialised');
  }

  const parsedSetIds = params.setIds
    .split(',')
    .map(Number)
    .filter((setId) => !Number.isNaN(setId));

  const boardStates = HOLD_STATE_MAP[params.boardName as BoardName];
  if (!boardStates) {
    throw new Error(`No hold states defined for board ${params.boardName}`);
  }

  const boardDetails = getBoardDetailsForBoard({
    board_name: params.boardName,
    layout_id: params.layoutId,
    size_id: params.sizeId,
    set_ids: parsedSetIds,
  });

  const { config } = buildRenderConfig({
    boardName: params.boardName,
    boardDetails,
    frames: params.frames,
    thumbnail: false,
    isOgVariant: true,
    boardStates,
  });

  const wasmT0 = performance.now();
  const overlay = await overlayRenderer.render(JSON.stringify(config));
  const wasmMs = performance.now() - wasmT0;

  const baseKey = baseCacheKey(params.boardName, params.layoutId, params.sizeId, params.setIds);
  let base = baseCache.get(baseKey);
  let cache: OgClimbRenderResult['cache'];
  let baseMs = 0;
  if (base) {
    cache = 'base-hit';
  } else {
    const baseT0 = performance.now();
    base = await composeOgBaseBuffer({
      boardDetails,
      boardWidth: overlay.width,
      boardHeight: overlay.height,
      resolveImagePath,
    });
    baseMs = performance.now() - baseT0;
    baseCache.set(baseKey, base);
    cache = 'miss';
  }

  const overlayBuffer = Buffer.from(overlay.rgba.buffer, overlay.rgba.byteOffset, overlay.rgba.byteLength);
  const encodeT0 = performance.now();
  const { buffer, contentType } = await encodeOgImage({
    base: base.base,
    overlay: { buffer: overlayBuffer, width: overlay.width, height: overlay.height, left: base.left, top: base.top },
    format: params.format,
  });
  const encodeMs = performance.now() - encodeT0;

  byteCache.set(cacheKey, { buffer, contentType });

  return { buffer, contentType, cache, timings: { wasmMs, baseMs, encodeMs } };
}

/**
 * Non-blocking warm of the fallback board bases so the first real crawler fetch
 * for a common board is a cheap base-hit. Composes bases directly into the base
 * cache — no byte-cache entries, which real requests could never hit (the
 * handler requires non-empty frames). Failures are logged, never thrown.
 */
async function warmFallbackBoardPreviews(): Promise<void> {
  await Promise.allSettled(
    Object.entries(FALLBACK_BOARD_PREVIEW_CONFIGS).map(async ([boardName, config]) => {
      try {
        await warmBoardBase(boardName, config);
      } catch (error) {
        logger.warn(`[OGClimb] Warm-up failed for ${boardName}:`, error instanceof Error ? error.message : error);
      }
    }),
  );
  logger.info('[OGClimb] Fallback board preview warm-up complete');
}

async function warmBoardBase(
  boardName: string,
  config: { layout_id: number; size_id: number; set_ids: number[] },
): Promise<void> {
  if (!overlayRenderer) return;

  const setIds = config.set_ids.join(',');
  const baseKey = baseCacheKey(boardName, config.layout_id, config.size_id, setIds);
  if (baseCache.has(baseKey)) return;

  const boardStates = HOLD_STATE_MAP[boardName as BoardName];
  if (!boardStates) return;

  const boardDetails = getBoardDetailsForBoard({
    board_name: boardName,
    layout_id: config.layout_id,
    size_id: config.size_id,
    set_ids: config.set_ids,
  });

  // An empty-frames overlay render is the cheap way to learn the board's
  // output dimensions, which the base composite is sized to.
  const { config: renderConfig } = buildRenderConfig({
    boardName,
    boardDetails,
    frames: '',
    thumbnail: false,
    isOgVariant: true,
    boardStates,
  });
  const overlay = await overlayRenderer.render(JSON.stringify(renderConfig));

  const base = await composeOgBaseBuffer({
    boardDetails,
    boardWidth: overlay.width,
    boardHeight: overlay.height,
    resolveImagePath,
  });
  baseCache.set(baseKey, base);
}
