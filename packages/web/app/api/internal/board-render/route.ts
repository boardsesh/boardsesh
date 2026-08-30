import { type NextRequest, NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { getBoardDetailsForBoard } from '@/app/lib/board-utils';
import { HOLD_STATE_MAP, THUMBNAIL_WIDTH } from '@/app/components/board-renderer/types';
import type { BoardName } from '@/app/lib/types';
import { createOgImageHeaders } from '@/app/lib/seo/og';
import {
  boardseshRenderQuerySchema,
  buildRenderConfig,
  createSemaphore,
  isValidFramesString,
  MAX_FRAMES_LENGTH,
  MAX_RENDER_OUTPUT_PIXELS,
  normalizeOutputFormat,
  VALID_BOARD_NAMES,
  type OutputFormat,
  type BoardArtColorScheme,
  type RenderableBoardDetails,
  type WasmRenderConfig,
} from '@boardsesh/board-render';
import { createOverlayRenderer } from '@boardsesh/board-render/wasm';
import { renderBoardImageBuffer, type RenderTimings, type ResolveImagePath } from '@boardsesh/board-render/pipeline';
import { boardBaseCache, boardBaseInFlight, byteCache, ogBaseCache } from '@/app/lib/board-render-cache';
import { configureSharpForServerless } from '@/app/lib/sharp-runtime';

// Node.js runtime for reliable WASM loading via filesystem
export const runtime = 'nodejs';

// libvips defaults assume a long-lived server; shrink its cache and thread pool
// before the first render on this instance. See sharp-runtime.ts.
configureSharpForServerless();

/**
 * Renders allowed to hold libvips buffers at once. Requests past the limit
 * queue instead of each allocating their own planes, which is what turns a
 * traffic spike into an OOM kill. Two keeps a 3 GB instance comfortable;
 * BOARD_RENDER_CONCURRENCY tunes it without a deploy.
 */
const renderSemaphore = createSemaphore(Number(process.env.BOARD_RENDER_CONCURRENCY) || 2);

/**
 * How deep the render queue may get before new work is shed.
 *
 * Two renders in parallel at ~0.35–1.9s each clears roughly 30–60 queued
 * requests inside the function's 30s budget. Past that a queued request would
 * spend its whole budget waiting and then 504 — having already made everyone
 * behind it wait — and the client retries straight back into the same queue.
 * A fast 503 with `Retry-After` sheds the load instead of burning it.
 */
const MAX_QUEUED_RENDERS = 40;

/**
 * Coalesces concurrent requests for the same uncached image into one render —
 * a list page warming twelve overlays must not pay WASM + sharp twice for
 * identical bytes.
 */
const inFlightRenders = new Map<string, Promise<RenderedImage>>();

type RenderedImage = {
  buffer: Buffer;
  contentType: string;
  /**
   * Whether the board-photo base was already composed for this board.
   * `none` is an overlay-only render, which has no base to cache.
   */
  cache: 'base-hit' | 'miss' | 'none';
  wasmMs: number;
  timings: RenderTimings;
};

/**
 * Resolve the board-renderer WASM binary. Probes the candidate paths that
 * Next's file tracing / Vercel standalone builds place the file in. The render
 * pipeline itself lives in @boardsesh/board-render; only byte resolution is
 * web/Vercel-specific, so it stays here and is injected into the shared renderer.
 */
function findWasmPath(): string {
  const wasmFilename = 'board_renderer_wasm_bg.wasm';
  const candidates = [
    // Monorepo dev: cwd is packages/web, workspace deps hoisted to root
    join(process.cwd(), '..', '..', 'node_modules/@boardsesh/board-renderer-wasm/pkg', wasmFilename),
    // Vercel standalone: cwd is /var/task, node_modules at root
    join(process.cwd(), 'node_modules/@boardsesh/board-renderer-wasm/pkg', wasmFilename),
    // Vercel standalone: nested under packages/web
    join(process.cwd(), 'packages/web/node_modules/@boardsesh/board-renderer-wasm/pkg', wasmFilename),
    // Relative to __dirname (works if file tracing copies it alongside the route)
    join(process.cwd(), '.next/server', wasmFilename),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  // Log all searched paths to help debug Vercel deployment issues
  console.error(`WASM file not found. cwd=${process.cwd()}, searched:`, candidates);
  return candidates[0];
}

// Module-level overlay renderer with promise-locked init, shared across requests
// (WASM inits once). Byte loading uses the Vercel-aware findWasmPath probe.
const overlayRenderer = createOverlayRenderer(async () => {
  const wasmPath = findWasmPath();
  return readFile(wasmPath);
});

/**
 * Resolve a public/-relative path to an absolute filesystem path. Tries multiple
 * candidate directories to work across dev, monorepo root, and Vercel standalone
 * builds. Injected into the shared render pipeline as its image resolver.
 */
const findPublicImagePath: ResolveImagePath = (relPath) => {
  const candidates = [
    join(process.cwd(), 'public', relPath),
    join(process.cwd(), 'packages/web/public', relPath),
    join(process.cwd(), relPath),
    join(process.cwd(), '..', '..', 'packages/web/public', relPath),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
};

/**
 * Shape a `v` parameter must have before its response is marked immutable for a
 * year. Any well-formed version wins the immutable branch — not only the one this
 * deploy emits — because a URL minted by an earlier deploy still names a fixed set
 * of bytes; downgrading it would send every already-crawled OG card and open tab
 * back to the origin. Malformed junk gets the bounded branch, so a crawler cannot
 * mint unlimited year-long edge objects out of a query string.
 */
function isWellFormedRenderVersion(value: string | null): value is string {
  return value !== null && /^[0-9a-f]{8,64}$/.test(value);
}

/**
 * Wrap encoded image bytes in the shared cache response.
 *
 * `renderVersion` is the request's own `v` — the route used to hard-code the
 * string `'immutable'` here, which claimed a year of cache lifetime for a URL that
 * did not identify its bytes (#4773). Unversioned requests (the ESP32 firmware,
 * the iOS Live Activity widget, already-crawled URLs) fall to the bounded daily
 * tier instead of pinning a year.
 */
function imageResponse(
  buffer: Buffer,
  contentType: string,
  timingParts: string[],
  renderVersion: string | null,
): NextResponse {
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      ...createOgImageHeaders({
        contentType,
        version: renderVersion,
        unversionedTier: 'daily',
        serverTiming: timingParts.join(', '),
      }),
    },
  });
}

/**
 * The expensive half of a request: the WASM overlay render plus the sharp
 * composite + encode. Runs inside the concurrency semaphore, so everything that
 * allocates a plane is counted against the limit.
 */
async function renderImage(params: {
  config: WasmRenderConfig;
  boardDetails: RenderableBoardDetails;
  isOgVariant: boolean;
  format: OutputFormat;
  thumbnail: boolean;
  includeBackground: boolean;
  dimBackground: number;
  colorScheme: BoardArtColorScheme;
}): Promise<RenderedImage> {
  const wasmT0 = performance.now();
  const { width, height, rgba } = await overlayRenderer.render(JSON.stringify(params.config));
  const wasmMs = performance.now() - wasmT0;

  const overlayBuffer = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);

  const { buffer, contentType, timings, cache } = await renderBoardImageBuffer({
    overlayBuffer,
    width,
    height,
    isOgVariant: params.isOgVariant,
    format: params.format,
    thumbnail: params.thumbnail,
    includeBackground: params.includeBackground,
    dimBackground: params.dimBackground,
    colorScheme: params.colorScheme,
    boardDetails: params.boardDetails,
    resolveImagePath: findPublicImagePath,
    caches: { boardBase: boardBaseCache, ogBase: ogBaseCache, boardBaseInFlight },
  });

  const baseCacheState = cache === 'hit' ? 'base-hit' : (cache ?? 'none');
  return { buffer, contentType, cache: baseCacheState, wasmMs, timings };
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);

    const boardName = searchParams.get('board_name');
    const layoutId = searchParams.get('layout_id');
    const sizeId = searchParams.get('size_id');
    const setIds = searchParams.get('set_ids');
    const frames = searchParams.get('frames');
    const thumbnail = searchParams.get('thumbnail') === '1';
    const includeBackground = searchParams.get('include_background') === '1';
    const isOgVariant = searchParams.get('variant') === 'og';
    // Board art has a dark sibling on some boards (Woods today). The scheme is a request
    // param rather than something the server sniffs: these renders are cached immutably and
    // served to every viewer, so the caller decides which art it wants. OG cards never pass
    // it — a social card is read outside our theme.
    const colorSchemeParam = searchParams.get('color_scheme');
    const format = normalizeOutputFormat(searchParams.get('format') ?? (isOgVariant ? 'png' : 'webp'));
    // Mirroring is handled client-side via CSS scaleX(-1) to maximize cache hit rate

    const versionParam = searchParams.get('v');
    const renderVersion = isWellFormedRenderVersion(versionParam) ? versionParam : null;

    if (!boardName || !layoutId || !sizeId || !setIds || frames === null) {
      return NextResponse.json({ error: 'Missing required parameters' }, { status: 400 });
    }

    if (!VALID_BOARD_NAMES.has(boardName)) {
      return NextResponse.json({ error: 'Invalid board_name' }, { status: 400 });
    }

    if (format === null) {
      return NextResponse.json({ error: 'Invalid format' }, { status: 400 });
    }

    if (colorSchemeParam !== null && colorSchemeParam !== 'dark' && colorSchemeParam !== 'light') {
      return NextResponse.json({ error: 'color_scheme must be light or dark' }, { status: 400 });
    }

    // Narrowed only after the check above, so an unrecognised value can never silently
    // become a light render.
    const colorScheme: BoardArtColorScheme = colorSchemeParam === 'dark' ? 'dark' : 'light';

    if (frames.length > MAX_FRAMES_LENGTH) {
      return NextResponse.json({ error: 'Frames string is too large' }, { status: 400 });
    }

    if (!isValidFramesString(frames)) {
      return NextResponse.json({ error: 'Invalid frames' }, { status: 400 });
    }

    // boardsesh-mode render options (issue #2202). Defaults keep this route
    // classic — see docs/og-climb.md for the param contract, shared with the
    // backend's GET /og/climb.
    const boardseshOptions = boardseshRenderQuerySchema.safeParse({
      render_mode: searchParams.get('render_mode') ?? undefined,
      glow_falloff: searchParams.get('glow_falloff') ?? undefined,
      glyphs: searchParams.get('glyphs') ?? undefined,
      field_color: searchParams.get('field_color') ?? undefined,
    });
    if (!boardseshOptions.success) {
      return NextResponse.json(
        { error: 'Invalid render options', details: boardseshOptions.error.issues.map((issue) => issue.message) },
        { status: 400 },
      );
    }
    const {
      render_mode: renderMode,
      glow_falloff: glowFalloff,
      glyphs,
      field_color: fieldColor,
    } = boardseshOptions.data;

    // Optional dim scrim over the board photo (0–1 opacity), applied only with
    // include_background. Darkens the board behind the holds so the lit climb
    // reads clearly at thumbnail size — the server equivalent of the mobile climb
    // list's LayeredClimbImage `dim` (rgba(0,0,0,0.18)). The Live Activity widget
    // opts in via dim_background=0.18.
    const dimBackgroundRaw = searchParams.get('dim_background');
    const dimBackground = dimBackgroundRaw !== null ? Number(dimBackgroundRaw) : 0;
    if (dimBackgroundRaw !== null && (Number.isNaN(dimBackground) || dimBackground < 0 || dimBackground > 1)) {
      return NextResponse.json({ error: 'dim_background must be a number between 0 and 1' }, { status: 400 });
    }

    // Final-bytes cache first: a hit costs nothing and never enters the render
    // queue. Keyed on every param that changes a pixel. `v` is deliberately NOT
    // in the key: one process only ever runs one renderer, so two versions of the
    // same URL produce identical bytes and keying on it would halve the cache for
    // nothing during a rolling deploy.
    const byteKey = [
      boardName,
      layoutId,
      sizeId,
      setIds,
      frames,
      thumbnail ? '1' : '0',
      includeBackground ? '1' : '0',
      dimBackground,
      isOgVariant ? 'og' : 'std',
      format,
      // A boardsesh render must never be served under a classic key — see
      // buildRenderConfig's renderMode/glowFalloff/glyphs/veil params. Classic
      // ignores the other three, so it keys as plain `classic` whatever a
      // caller passed alongside it.
      ...(renderMode === 'boardsesh'
        ? ['boardsesh', glowFalloff, glyphs ? '1' : '0', fieldColor ?? 'unset']
        : ['classic']),
      colorScheme,
    ].join(':');

    const cachedBytes = byteCache.get(byteKey);
    if (cachedBytes) {
      return imageResponse(
        cachedBytes.buffer,
        cachedBytes.contentType,
        ['cache;desc=hit', 'queue;dur=0.0'],
        renderVersion,
      );
    }

    const parsedSetIds = setIds
      .split(',')
      .map(Number)
      .filter((setId) => !isNaN(setId));

    // Get board details (pure computation, no DB)
    const boardDetails = getBoardDetailsForBoard({
      board_name: boardName as BoardName,
      layout_id: Number(layoutId),
      size_id: Number(sizeId),
      set_ids: parsedSetIds,
    });

    const { config } = buildRenderConfig({
      boardName,
      boardDetails,
      frames,
      thumbnail,
      isOgVariant,
      boardStates: HOLD_STATE_MAP[boardName as BoardName],
      thumbnailWidth: THUMBNAIL_WIDTH,
      renderMode,
      glowFalloff,
      glyphs,
      // TODO(#2202): veil opacity from @boardsesh/board-art-geometry — nothing
      // computes real wall-lightness data yet, so boardsesh mode ships a
      // no-op (opacity 0) veil until that package lands.
      ...(renderMode === 'boardsesh' ? { veil: { color: fieldColor ?? '#181225', opacity: 0 } } : {}),
    });

    // Reject oversized renders before allocating anything for them.
    const outputHeight = Math.round((config.output_width * config.board_height) / config.board_width);
    if (config.output_width * outputHeight > MAX_RENDER_OUTPUT_PIXELS) {
      return NextResponse.json(
        {
          error: `Requested render is ${config.output_width}x${outputHeight}, over the ${MAX_RENDER_OUTPUT_PIXELS}px limit`,
        },
        { status: 400 },
      );
    }

    const queueT0 = performance.now();
    // Time spent waiting before this request's own work could start: a slot for
    // the request that renders, the whole shared render for one that coalesces.
    let queueMs = 0;
    const inFlight = inFlightRenders.get(byteKey);

    // Shed rather than queue behind more work than the budget can clear. A
    // request joining an in-flight render adds nothing to the queue, so it is
    // always let through.
    if (!inFlight && renderSemaphore.pending > MAX_QUEUED_RENDERS) {
      return NextResponse.json(
        { error: 'Render queue is saturated' },
        { status: 503, headers: { 'Retry-After': '5', 'Cache-Control': 'no-store' } },
      );
    }

    const renderPromise =
      inFlight ??
      renderSemaphore
        .run(() => {
          queueMs = performance.now() - queueT0;
          return renderImage({
            config,
            boardDetails,
            isOgVariant,
            format,
            thumbnail,
            includeBackground,
            dimBackground,
            colorScheme,
          });
        })
        .finally(() => {
          inFlightRenders.delete(byteKey);
        });
    if (!inFlight) inFlightRenders.set(byteKey, renderPromise);

    const rendered = await renderPromise;
    if (inFlight) queueMs = performance.now() - queueT0;

    byteCache.set(byteKey, { buffer: rendered.buffer, contentType: rendered.contentType });

    const timingParts = [
      `wasm;dur=${rendered.wasmMs.toFixed(1)}`,
      `sharp;dur=${rendered.timings.sharpMs.toFixed(1)}`,
      `compose;dur=${rendered.timings.composeMs.toFixed(1)}`,
      `encode;dur=${rendered.timings.encodeMs.toFixed(1)}`,
    ];
    if (rendered.timings.bgMs > 0) timingParts.push(`bg;dur=${rendered.timings.bgMs.toFixed(1)}`);
    timingParts.push(`cache;desc=${rendered.cache}`, `queue;dur=${Math.max(0, queueMs).toFixed(1)}`);

    return imageResponse(rendered.buffer, rendered.contentType, timingParts, renderVersion);
  } catch (error) {
    console.error('Board render error:', error);
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: `Render failed: ${message}` }, { status: 500 });
  }
}
