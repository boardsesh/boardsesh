import { type NextRequest, NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { getBoardDetailsForBoard } from '@/app/lib/board-utils';
import { HOLD_STATE_MAP, THUMBNAIL_WIDTH } from '@/app/components/board-renderer/types';
import type { BoardName } from '@/app/lib/types';
import { createOgImageHeaders } from '@/app/lib/seo/og';
import {
  buildRenderConfig,
  createSemaphore,
  isValidFramesString,
  MAX_FRAMES_LENGTH,
  normalizeOutputFormat,
  VALID_BOARD_NAMES,
  type OutputFormat,
  type RenderableBoardDetails,
  type WasmRenderConfig,
} from '@boardsesh/board-render';
import { createOverlayRenderer } from '@boardsesh/board-render/wasm';
import { renderBoardImageBuffer, type RenderTimings, type ResolveImagePath } from '@boardsesh/board-render/pipeline';
import { boardBaseCache, byteCache, ogBaseCache } from '@/app/lib/board-render-cache';
import { configureSharpForServerless } from '@/app/lib/sharp-runtime';

// Node.js runtime for reliable WASM loading via filesystem
export const runtime = 'nodejs';

// libvips defaults assume a long-lived server; shrink its cache and thread pool
// before the first render on this instance. See sharp-runtime.ts.
configureSharpForServerless();

/**
 * Hard ceiling on the rendered pixel count. The largest real board is Kilter's
 * 1080×2498 (~2.70 MP); anything past 3 MP is a hand-crafted request, and each
 * one costs ~4 bytes/pixel per in-flight plane. Rejected outright rather than
 * resampled — a caller asking for a size no board has is a bug, not a photo.
 */
const MAX_OUTPUT_PIXELS = 3_000_000;

/**
 * Renders allowed to hold libvips buffers at once. Requests past the limit
 * queue instead of each allocating their own planes, which is what turns a
 * traffic spike into an OOM kill. Two keeps a 3 GB instance comfortable;
 * BOARD_RENDER_CONCURRENCY tunes it without a deploy.
 */
const renderSemaphore = createSemaphore(Number(process.env.BOARD_RENDER_CONCURRENCY) || 2);

/**
 * Coalesces concurrent requests for the same uncached image into one render —
 * a list page warming twelve overlays must not pay WASM + sharp twice for
 * identical bytes.
 */
const inFlightRenders = new Map<string, Promise<RenderedImage>>();

type RenderedImage = {
  buffer: Buffer;
  contentType: string;
  /** Whether the board-photo base was already composed for this board. */
  cache: 'base-hit' | 'miss';
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

/** Wrap encoded image bytes in the shared immutable-cache response. */
function imageResponse(buffer: Buffer, contentType: string, timingParts: string[]): NextResponse {
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      ...createOgImageHeaders({
        contentType,
        version: 'immutable',
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
    boardDetails: params.boardDetails,
    resolveImagePath: findPublicImagePath,
    caches: { boardBase: boardBaseCache, ogBase: ogBaseCache },
  });

  return { buffer, contentType, cache: cache === 'hit' ? 'base-hit' : 'miss', wasmMs, timings };
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
    const format = normalizeOutputFormat(searchParams.get('format') ?? (isOgVariant ? 'png' : 'webp'));
    // Mirroring is handled client-side via CSS scaleX(-1) to maximize cache hit rate

    if (!boardName || !layoutId || !sizeId || !setIds || frames === null) {
      return NextResponse.json({ error: 'Missing required parameters' }, { status: 400 });
    }

    if (!VALID_BOARD_NAMES.has(boardName)) {
      return NextResponse.json({ error: 'Invalid board_name' }, { status: 400 });
    }

    if (format === null) {
      return NextResponse.json({ error: 'Invalid format' }, { status: 400 });
    }

    if (frames.length > MAX_FRAMES_LENGTH) {
      return NextResponse.json({ error: 'Frames string is too large' }, { status: 400 });
    }

    if (!isValidFramesString(frames)) {
      return NextResponse.json({ error: 'Invalid frames' }, { status: 400 });
    }

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
    // queue. Keyed on every param that changes a pixel.
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
    ].join(':');

    const cachedBytes = byteCache.get(byteKey);
    if (cachedBytes) {
      return imageResponse(cachedBytes.buffer, cachedBytes.contentType, ['cache;desc=hit', 'queue;dur=0.0']);
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
    });

    // Reject oversized renders before allocating anything for them.
    const outputHeight = Math.round((config.output_width * config.board_height) / config.board_width);
    if (config.output_width * outputHeight > MAX_OUTPUT_PIXELS) {
      return NextResponse.json(
        {
          error: `Requested render is ${config.output_width}x${outputHeight}, over the ${MAX_OUTPUT_PIXELS}px limit`,
        },
        { status: 400 },
      );
    }

    const queueT0 = performance.now();
    // Time spent waiting before this request's own work could start: a slot for
    // the request that renders, the whole shared render for one that coalesces.
    let queueMs = 0;
    const inFlight = inFlightRenders.get(byteKey);
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

    return imageResponse(rendered.buffer, rendered.contentType, timingParts);
  } catch (error) {
    console.error('Board render error:', error);
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: `Render failed: ${message}` }, { status: 500 });
  }
}
