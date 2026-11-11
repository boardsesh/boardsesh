import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { getWallLightness, loadBoardArtGeometry } from '@boardsesh/board-art-geometry';
import { BOARD_FIELD_COLORS } from '@boardsesh/board-look';
import { renderOgCardText, type OgCardContent } from '@boardsesh/board-render/og-card';
import {
  composeOgFamilyCard,
  ogFamilyBoardBox,
  placeOgFamilyBoard,
  renderOgFamilyPhotoLayers,
  renderOgFamilyTextLayers,
  type OgFamilyArtLayers,
  type OgFamilyCardContent,
} from '@boardsesh/board-render/og-family';
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
  composeBoardBaseBuffer,
  composeOgBaseBuffer,
  renderBoardImageBuffer,
  type OgBaseResult,
  type RenderTimings,
} from '@boardsesh/board-render/pipeline';
import { createOverlayRenderer, type OverlayRenderer } from '@boardsesh/board-render/wasm';
import { getOgBokehInput, renderFrostedBokehBuffer } from '@boardsesh/board-render/frosted-bokeh';
import type { BoardName } from '@boardsesh/shared-schema';
import sharp from 'sharp';
import { logger } from '../utils/logger';
import { FALLBACK_BOARD_PREVIEW_CONFIGS } from './board-preview-defaults';

/**
 * libvips is process-global, so configure it before the renderer can initialise.
 * These conservative limits also apply to avatar, gym-photo, and beta-thumbnail
 * resizing in this backend. Those paths trade some throughput for the bounded
 * memory footprint required by full-size board renders.
 */
sharp.cache({ memory: 16, files: 4, items: 100 });
sharp.concurrency(1);

const MIB = 1024 * 1024;
const BOARD_BASE_CACHE_MAX_BYTES = 64 * MIB;
const OG_BASE_CACHE_MAX_BYTES = 32 * MIB;
const BYTE_CACHE_MAX_BYTES = 32 * MIB;
const OG_FAMILY_PLANE_MAX_BYTES = 24 * MIB;

// Exactly four process-lifetime LRUs serve the public render endpoints: three
// shared by `/render/board` and `/og/climb`, and `ogFamilyPlaneCache` below for
// the share-card family.
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

/**
 * Board-sized folded board photos for the share-card family, one per board and
 * output size. Deliberately NOT `ogBaseCache`: that key omits the placement,
 * which it bakes into a canvas-sized plane, so a family render sharing it could
 * serve a misplaced base and evict the climb card's entries. A family plane
 * stays board-sized and is placed at composite time, so it carries no placement.
 */
const ogFamilyPlaneCache = new BoundedLru<Buffer>({
  maxEntries: 16,
  maxBytes: OG_FAMILY_PLANE_MAX_BYTES,
  sizeOf: (buffer) => buffer.length,
});

// Both endpoint families share final-render and base-composition coalescing.
const inFlightRenders = new Map<string, Promise<BoardImageRenderResult>>();
const boardBaseInFlight = new Map<string, Promise<Buffer | null>>();
const ogBaseInFlight = new Map<string, Promise<OgBaseResult>>();
const ogFamilyInFlight = new Map<string, Promise<OgFamilyRenderResult>>();

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
  /** "aura" draws the veil + glow treatment; omitted/"classic" renders exactly as today (issue #2202). */
  renderMode?: 'classic' | 'aura';
  /** `aura` mode only. The look's own default is "soft". */
  glowFalloff?: 'soft' | 'plateau';
  /** `aura` mode only: role glyphs inside the glow. */
  glyphs?: boolean;
  /**
   * `aura` mode only: the play field the veil washes the unlit wall toward.
   * Omitted means the light field, on which every board's wall is darker than
   * the field and the veil resolves to nothing.
   */
  fieldColor?: string;
  colorScheme?: BoardArtColorScheme;
  thumbnail: boolean;
  includeBackground: boolean;
  dimBackground: number;
  isOgVariant: boolean;
  /** OG-only: fit the board into this box instead of the climb card's. */
  ogBox?: { width: number; height: number };
  /** Climb identity drawn in an OG card's text column; OG renders only. */
  card?: OgCardContent;
};

export type BoardImageRenderResult = {
  buffer: Buffer;
  contentType: string;
  cache: 'hit' | 'base-hit' | 'miss' | 'none';
  timings: RenderTimings & { wasmMs: number; baseMs: number };
  queueMs: number;
  /**
   * The card was drawn without its app icon because the icon could not be read.
   * Not the final drawing: it is not in the byte cache, and the response must not
   * be cacheable either.
   */
  iconMissing: boolean;
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
> & {
  /** Climb identity drawn in the card's text column. */
  card?: OgCardContent;
};

export type OgClimbRenderResult = {
  buffer: Buffer;
  contentType: string;
  cache: 'hit' | 'base-hit' | 'miss';
  timings: { wasmMs: number; baseMs: number; encodeMs: number; composeMs?: number };
  /** See `BoardImageRenderResult.iconMissing`. */
  iconMissing: boolean;
};

function isOgClimbRenderResult(
  rendered: BoardImageRenderResult,
): rendered is BoardImageRenderResult & OgClimbRenderResult {
  return rendered.cache !== 'none';
}

/**
 * Render-option suffix on the byte cache key, so an Aura render — and any
 * combination of its options — can never be served under a classic (or a
 * different Aura option's) key. The base cache does NOT carry it: the
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
  // `fieldColor` is normalised, not passed through: an unset field means the
  // light field, so a caller that names `#FFFFFF` and one that names nothing
  // draw the same pixels and must not mint two entries for them.
  const fieldColor = (options.fieldColor ?? BOARD_FIELD_COLORS.light).toLowerCase();
  return `boardsesh:${options.glowFalloff ?? 'soft'}:${options.glyphs ? '1' : '0'}:${fieldColor}`;
}

/**
 * Digest of the climb-identity text drawn on an OG card, for the byte cache key.
 *
 * A digest rather than the raw fields because the key is `':'`-joined and a
 * climb name may contain a colon — `"7a: the sequel"` with no setter would
 * otherwise key identically to a different name/setter split. Hashing the
 * NORMALISED values also collapses the slightly different URLs web and mobile
 * build for the same climb onto one entry, the way `set_ids` canonicalisation
 * and `fieldColor` normalisation already do.
 *
 * `'none'` for every non-OG render, so `/render/board` keys stay byte-identical
 * to what they were before cards carried text.
 */
function cardTextCacheKeySuffix(params: BoardImageRenderParams): string {
  const card = params.card;
  if (!params.isOgVariant || !card) return 'none';
  // `boardLine` is deliberately absent: it is derived from board_name/layout_id/
  // size_id, which the outer key already carries, so hashing it adds no
  // collision resistance and would mint a new entry for a pure label edit.
  // `fontFamily` is in the digest: it changes the pixels, and during a rolling
  // deploy that moves `OG_CARD_FONT_FAMILY` the two versions would otherwise
  // serve each other's entries.
  const fields = [card.name ?? '', card.grade ?? '', card.setter ?? '', card.angle ?? '', card.fontFamily ?? ''];
  if (fields.every((field) => field === '')) return 'none';
  return createHash('sha1').update(JSON.stringify(fields)).digest('base64url').slice(0, 16);
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
    `card:${cardTextCacheKeySuffix(params)}`,
  ].join(':');
}

/**
 * Assemble the WASM config for one request: board details, the traced art for
 * this board config, and the veil measured against the requested play field.
 * Pure — no I/O beyond the memoised shard read, and no renderer. Exported for
 * the tests that pin what an Aura request actually sends.
 */
export function prepareRender(params: BoardImageRenderParams): {
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

  const isAura = params.renderMode === 'aura';
  const geometryQuery = {
    boardName: params.boardName as BoardName,
    layoutId: params.layoutId,
    sizeId: params.sizeId,
  };
  // The traced art for this board config, and the reading of its wall the
  // `auto` veil is bucketed from. Both are `null` for a config the tracer
  // skipped, which is a normal answer: every hold falls back to a ring at its
  // placement radius and the wall goes unwashed. The shard loader memoises per
  // board key, so a burst of climbs on one wall reads it once.
  const geometry = isAura ? loadBoardArtGeometry(geometryQuery) : null;
  const { config } = buildRenderConfig({
    boardName: params.boardName,
    boardDetails,
    frames: params.frames,
    thumbnail: params.thumbnail,
    isOgVariant: params.isOgVariant,
    ...(params.ogBox ? { ogBox: params.ogBox } : {}),
    boardStates,
    renderMode: params.renderMode,
    glowFalloff: params.glowFalloff,
    glyphs: params.glyphs,
    ...(isAura
      ? {
          fieldColor: params.fieldColor,
          wallLightness: getWallLightness(geometryQuery),
          ...(geometry
            ? {
                holdGeometry: {
                  outlines: geometry.outlines,
                  ledInner: geometry.ledInner,
                  ledBright: geometry.ledBright,
                  silhouetteLightness: geometry.silhouetteLightness,
                },
              }
            : {}),
        }
      : {}),
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
      iconMissing: false,
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
      // Degrade to the textless board rather than fail the render. Before the
      // identity column existed this endpoint had no text path at all, so a
      // Pango failure — a font missing on a non-Alpine host, a pathological
      // string — must cost the words, not the card.
      const cardText = params.isOgVariant && params.card ? await renderOgCardLayersOrNone(params.card) : undefined;
      const rendered = await renderBoardImageBuffer({
        overlayBuffer,
        cardLayers: cardText?.layers,
        ogBokeh: params.isOgVariant ? getOgBokehInput(prepared.config) : undefined,
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
        iconMissing: cardText?.iconMissing ?? false,
      };
      // A card drawn without its icon answers this request only; the next one
      // retries the read and caches the real drawing.
      if (!result.iconMissing) byteCache.set(cacheKey, { buffer: result.buffer, contentType: result.contentType });
      return result;
    })
    .finally(() => {
      inFlightRenders.delete(cacheKey);
    });
  inFlightRenders.set(cacheKey, renderPromise);
  return renderPromise;
}

/**
 * Run CPU-heavy render work under the SHARED render cap.
 *
 * `BOARD_RENDER_CONCURRENCY` is documented as the cap for "OG and board-image
 * misses" (`docs/og-climb.md`), and a spray-wall card is another miss competing
 * for the same cores — sharp decoding and compositing a phone photograph is the
 * same kind of work as the WASM overlay, so it belongs in the same queue rather
 * than in a second one that could double the real concurrency.
 *
 * Deliberately NOT `async`: the saturation check and the enqueue have to happen
 * in one synchronous step, or two requests arriving in the same tick can both
 * read a `pending` below the ceiling and both enqueue. Same reason
 * `renderBoardImage` does the check inline rather than after an `await`.
 *
 * @throws RenderQueueSaturatedError when the queue is already at its ceiling.
 */
export function runOnRenderSemaphore<T>(fn: () => Promise<T>): Promise<T> {
  if (renderSemaphore.pending >= MAX_QUEUED_RENDERS) {
    throw new RenderQueueSaturatedError();
  }
  return renderSemaphore.run(fn);
}

/** What the family renderer needs to light a board on a card. */
export type OgFamilyArtSpec = {
  boardName: string;
  layoutId: number;
  sizeId: number;
  /** Comma-separated set ids. */
  setIds: string;
  /** Lit holds; `''` is the unlit board. */
  frames: string;
};

/**
 * A real photograph in the art slot instead of a rendered board: a gym's public
 * photo, or a spray wall's with its climb already drawn on it. The loader has
 * gated it, decoded it and sized it to fit `ogFamilyBoardBox('full')`.
 */
export type OgFamilyPhotoArt = {
  /** JPEG of exactly `width` x `height`. */
  image: Buffer;
  width: number;
  height: number;
  /** Hash of `image`: what the byte cache keys on, so the bytes never reach a digest. */
  digest: string;
  bokeh: { points: { x: number; y: number; color: string }[]; source: { w: number; h: number } };
};

export type OgFamilyRenderParams = {
  /** The whole byte-cache key, from `buildOgFamilyByteKey`. Only ever read after the gate. */
  cacheKey: string;
  /** Null draws no board. With no `photo` either, `content.slot` must then be `'none'`. */
  art: OgFamilyArtSpec | null;
  /** Takes the art slot instead of `art`, which is then null. */
  photo?: OgFamilyPhotoArt | null;
  content: OgFamilyCardContent;
};

export type OgFamilyRenderResult = {
  buffer: Buffer;
  contentType: string;
  cache: 'hit' | 'plane-hit' | 'miss' | 'none';
  timings: { wasmMs: number; planeMs: number; composeMs: number };
  /** The card was drawn without its app icon, and so was not cached. */
  iconMissing: boolean;
};

/**
 * Byte-cache key for one family card: the surface plus a digest of what is drawn.
 * Namespaced, so it cannot share a slot with a `/render/board` or `/og/climb` key,
 * whose first segment is always a board name.
 */
export function buildOgFamilyByteKey(surface: string, digest: string): string {
  return `og-family:${surface}:${digest}`;
}

/** Plane-cache key: the board's art paths and the size they were folded at. */
export function buildOgFamilyPlaneKey(backgroundPaths: readonly string[], width: number, height: number): string {
  return `og-family-plane:${backgroundPaths.join('|')}:${width}x${height}`;
}

async function loadOgFamilyPlane(
  boardDetails: RenderableBoardDetails,
  width: number,
  height: number,
): Promise<{ plane: Buffer | null; hit: boolean }> {
  const key = buildOgFamilyPlaneKey(getBackgroundRelPaths(boardDetails, false), width, height);
  const cached = ogFamilyPlaneCache.get(key);
  if (cached) return { plane: cached, hit: true };
  const composed = await composeBoardBaseBuffer({
    boardDetails,
    width,
    height,
    thumbnail: false,
    dimBackground: 0,
    resolveImagePath,
  });
  if (composed) ogFamilyPlaneCache.set(key, composed);
  return { plane: composed, hit: false };
}

async function renderOgFamilyArtLayers(
  art: OgFamilyArtSpec,
  slot: 'full' | 'narrow',
): Promise<{
  layers: OgFamilyArtLayers;
  bokeh: ReturnType<typeof getOgBokehInput>;
  wasmMs: number;
  planeMs: number;
  planeHit: boolean;
}> {
  const renderer = overlayRenderer;
  if (!renderer) throw new Error('Board renderer is not initialised');
  const prepared = prepareRender({
    boardName: art.boardName,
    layoutId: art.layoutId,
    sizeId: art.sizeId,
    setIds: art.setIds,
    frames: art.frames,
    format: 'jpeg',
    renderMode: 'aura',
    fieldColor: BOARD_FIELD_COLORS.dark,
    thumbnail: false,
    includeBackground: true,
    dimBackground: 0,
    isOgVariant: true,
    ogBox: ogFamilyBoardBox(slot),
  });
  const wasmT0 = performance.now();
  const overlay = await renderer.render(JSON.stringify(prepared.config));
  const wasmMs = performance.now() - wasmT0;

  const planeT0 = performance.now();
  const { plane, hit } = await loadOgFamilyPlane(prepared.boardDetails, overlay.width, overlay.height);
  const planeMs = performance.now() - planeT0;

  const bokeh = getOgBokehInput(prepared.config);
  // Centroid of the lit holds in the rendered board's pixels, so the narrow slot
  // can centre its crop on what is actually lit.
  const pixelsPerSourceUnit = overlay.width / prepared.config.board_width;
  const litCentroidX =
    bokeh.points.length > 0
      ? (bokeh.points.reduce((sum, point) => sum + point.x, 0) / bokeh.points.length) * pixelsPerSourceUnit
      : undefined;

  return {
    layers: {
      plane,
      overlay: Buffer.from(overlay.rgba.buffer, overlay.rgba.byteOffset, overlay.rgba.byteLength),
      width: overlay.width,
      height: overlay.height,
      placement: placeOgFamilyBoard(slot, overlay.width, overlay.height, litCentroidX),
      frame: slot === 'full',
    },
    bokeh,
    wasmMs,
    planeMs,
    planeHit: hit,
  };
}

/**
 * Render one share-card family image.
 *
 * Callers run their visibility gate first; a card someone is not allowed to see
 * must never reach this function, because the byte cache is keyed on the drawn
 * data alone. Everything expensive runs under the shared render cap, and a
 * byte-cache hit or a coalesced in-flight render never takes a slot.
 *
 * @throws RenderQueueSaturatedError when the render queue is already full.
 */
export async function renderOgFamilyArt(params: OgFamilyRenderParams): Promise<OgFamilyRenderResult> {
  const cached = byteCache.get(params.cacheKey);
  if (cached) {
    return { ...cached, cache: 'hit', timings: { wasmMs: 0, planeMs: 0, composeMs: 0 }, iconMissing: false };
  }
  const alreadyRendering = ogFamilyInFlight.get(params.cacheKey);
  if (alreadyRendering) return alreadyRendering;

  const renderPromise = runOnRenderSemaphore(async () => {
    const { art, photo, content } = params;
    let wasmMs = 0;
    let planeMs = 0;
    let cache: OgFamilyRenderResult['cache'] = 'none';
    let artLayers: OgFamilyArtLayers | null = null;
    let bokeh: ReturnType<typeof getOgBokehInput> = content.fieldGlow ?? { points: [], source: { w: 1200, h: 630 } };

    if (art && content.slot !== 'none') {
      const rendered = await renderOgFamilyArtLayers(art, content.slot);
      artLayers = rendered.layers;
      bokeh = rendered.bokeh;
      wasmMs = rendered.wasmMs;
      planeMs = rendered.planeMs;
      cache = rendered.planeHit ? 'plane-hit' : 'miss';
    } else if (photo && content.slot === 'full') {
      artLayers = await renderOgFamilyPhotoLayers(photo);
      bokeh = photo.bokeh;
    }

    const composeT0 = performance.now();
    // A family card is mostly its words, so a Pango failure rejects here rather
    // than serving and caching a wordless card under this card's real key.
    const { layers: textLayers, iconError } = await renderOgFamilyTextLayers(content);
    noteOgIconState(iconError, 'family');
    const background = await renderFrostedBokehBuffer(bokeh);
    const encoded = await composeOgFamilyCard({ background, slot: content.slot, art: artLayers, textLayers });
    const composeMs = performance.now() - composeT0;

    // Without its icon the card answers this request only and is never cached.
    const iconMissing = iconError !== null;
    if (!iconMissing) byteCache.set(params.cacheKey, encoded);
    return { ...encoded, cache, timings: { wasmMs, planeMs, composeMs }, iconMissing };
  }).finally(() => {
    ogFamilyInFlight.delete(params.cacheKey);
  });
  ogFamilyInFlight.set(params.cacheKey, renderPromise);
  return renderPromise;
}

let iconWarningLogged = false;

/**
 * Warn the first time a card goes out without its app icon, then stay quiet
 * until one is drawn with it again. Every card retries the read meanwhile.
 */
export function noteOgIconState(iconError: string | null, surface: string): void {
  if (iconError === null) {
    iconWarningLogged = false;
    return;
  }
  if (iconWarningLogged) return;
  iconWarningLogged = true;
  logger.warn('[BoardRender] App icon unreadable; drawing cards without it and caching none of them', {
    surface,
    error: iconError,
  });
}

async function renderOgCardLayersOrNone(
  card: OgCardContent,
): Promise<{ layers: sharp.OverlayOptions[] | undefined; iconMissing: boolean }> {
  try {
    const { layers, iconError } = await renderOgCardText(card);
    noteOgIconState(iconError, 'climb');
    return { layers, iconMissing: iconError !== null };
  } catch (error) {
    logger.warn('[BoardRender] Card text failed to render; serving the board alone', {
      error: error instanceof Error ? error.message : String(error),
      // Enough to find the climb again. A silent fallback with no identity
      // gives no way to tell one broken card from a broken font.
      name: card.name,
      grade: card.grade,
      setter: card.setter,
      angle: card.angle,
      fontFamily: card.fontFamily,
    });
    return { layers: undefined, iconMissing: false };
  }
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
      await renderSemaphore.runLowPriority(() => warmOgFamilyPlane(boardName, config));
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

/** The board-sized plane a gym card draws on its type's default config, so its first render is a plane hit. */
async function warmOgFamilyPlane(
  boardName: string,
  fallback: { layout_id: number; size_id: number; set_ids: number[] },
): Promise<void> {
  if (!overlayRenderer) return;
  await renderOgFamilyArtLayers(
    {
      boardName,
      layoutId: fallback.layout_id,
      sizeId: fallback.size_id,
      setIds: fallback.set_ids.join(','),
      frames: '',
    },
    'full',
  );
}

/** Test-only reset for process-lifetime render state. */
export function resetBoardRenderCaches(): void {
  boardBaseCache.clear();
  ogBaseCache.clear();
  ogFamilyPlaneCache.clear();
  byteCache.clear();
  boardBaseInFlight.clear();
  ogBaseInFlight.clear();
  ogFamilyInFlight.clear();
  inFlightRenders.clear();
  iconWarningLogged = false;
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
  ogFamilyPlaneBytes: number;
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
    ogFamilyPlaneBytes: ogFamilyPlaneCache.byteSize,
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
