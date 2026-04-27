import { type NextRequest, NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import sharp from 'sharp';
import { getBoardDetailsForBoard } from '@/app/lib/board-utils';
import { HOLD_STATE_MAP, THUMBNAIL_WIDTH } from '@/app/components/board-renderer/types';
import type { BoardName } from '@/app/lib/types';
import { createOgImageHeaders, OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH } from '@/app/lib/seo/og';

// Node.js runtime for reliable WASM loading via filesystem
export const runtime = 'nodejs';

const THUMBNAIL_WEBP_OPTIONS: sharp.WebpOptions = {
  quality: 60,
  alphaQuality: 70,
  effort: 4,
};

const DEFAULT_WEBP_OPTIONS: sharp.WebpOptions = {
  quality: 80,
};

// Level 6 is ~4x faster than level 9 with <3% size difference. All renders are
// served immutable/1-year cached, so compression speed beats marginal size gains.
const DEFAULT_PNG_OPTIONS: sharp.PngOptions = {
  compressionLevel: 6,
  adaptiveFiltering: false,
};

const OG_BOARD_PADDING_X = 48;
const OG_BOARD_PADDING_Y = 48;

// WASM module initialized once per process. Promise lock prevents thundering herd
// when multiple requests arrive before init completes.
let renderOverlay: ((configJson: string) => Uint8Array) | null = null;
let wasmInitPromise: Promise<void> | null = null;

// Concurrency limiter — at most this many renders run simultaneously.
// Excess requests queue behind a promise chain instead of all executing at once,
// preventing CPU spikes when the CDN cache clears (e.g. after a deploy).
const MAX_CONCURRENT_RENDERS = 4;
let activeRenders = 0;
let renderQueue: Array<() => void> = [];

function acquireRenderSlot(): Promise<void> {
  if (activeRenders < MAX_CONCURRENT_RENDERS) {
    activeRenders++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    renderQueue.push(resolve);
  });
}

function releaseRenderSlot(): void {
  const next = renderQueue.shift();
  if (next) {
    next();
  } else {
    activeRenders--;
  }
}

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

async function ensureWasmInitialized() {
  if (renderOverlay) return;
  if (!wasmInitPromise) {
    wasmInitPromise = (async () => {
      const wasmModule = await import('@boardsesh/board-renderer-wasm');
      const wasmPath = findWasmPath();
      const wasmBytes = await readFile(wasmPath);
      wasmModule.initSync({ module: wasmBytes });
      renderOverlay = wasmModule.render_overlay;
    })();
  }
  await wasmInitPromise;
}

const VALID_BOARD_NAMES = new Set(['kilter', 'tension', 'moonboard', 'decoy', 'touchstone', 'grasshopper']);

// Kick off WASM initialization at module load so it's warm before the first
// request arrives. The promise lock in ensureWasmInitialized prevents duplicate work.
ensureWasmInitialized().catch((err) => {
  console.error('[BoardRender] Eager WASM init failed:', err);
});

// THUMBNAIL_WIDTH imported from @/app/components/board-renderer/types
// Full: native board resolution for crisp rendering in climb drawer/card cover

// ---------------------------------------------------------------------------
// Background image helpers (for include_background=1 compositing)
// ---------------------------------------------------------------------------

/**
 * Resolve a public/-relative path to an absolute filesystem path.
 * Tries multiple candidate directories to work across dev, monorepo root,
 * and Vercel standalone builds.
 */
function findPublicImagePath(relPath: string): string | null {
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
}

/** Convert a raw image filename to its WebP equivalent, optionally as a thumbnail. */
function toWebpPath(dir: string, filename: string, isThumbnail: boolean): string {
  const webpName = filename.replace(/\.png$/, '.webp');
  if (isThumbnail) {
    const lastSlash = webpName.lastIndexOf('/');
    if (lastSlash >= 0) {
      return `${dir}/${webpName.substring(0, lastSlash)}/thumbs${webpName.substring(lastSlash)}`;
    }
    return `${dir}/thumbs/${webpName}`;
  }
  return `${dir}/${webpName}`;
}

type BoardDetailsForBg = {
  board_name: string;
  images_to_holds: Record<string, unknown>;
  layoutFolder?: string;
  holdSetImages?: string[];
};

/**
 * Build the ordered list of public/-relative paths for background images.
 * Kilter/Tension use images_to_holds keys; MoonBoard uses layoutFolder + holdSetImages.
 */
function getBackgroundRelPaths(boardDetails: BoardDetailsForBg, isThumbnail: boolean): string[] {
  const paths: string[] = [];
  const imageKeys = Object.keys(boardDetails.images_to_holds);

  if (imageKeys.length > 0) {
    // Aurora boards (Kilter, Tension): keys like "product_sizes_layouts_sets/36-1.png"
    for (const key of imageKeys) {
      paths.push(toWebpPath(`images/${boardDetails.board_name}`, key, isThumbnail));
    }
  } else if (boardDetails.layoutFolder && boardDetails.holdSetImages) {
    // MoonBoard: board background + hold set layers
    const bgFile = 'moonboard-bg.png';
    paths.push(toWebpPath('images/moonboard', bgFile, isThumbnail));
    for (const holdSetImage of boardDetails.holdSetImages) {
      paths.push(toWebpPath(`images/moonboard/${boardDetails.layoutFolder}`, holdSetImage, isThumbnail));
    }
  }

  return paths;
}

function createOgBackgroundBuffer(boardWidth: number, boardHeight: number): Buffer {
  const boardX = Math.round((OG_IMAGE_WIDTH - boardWidth) / 2);
  const boardY = Math.round((OG_IMAGE_HEIGHT - boardHeight) / 2);
  const frameX = Math.max(boardX - 16, 16);
  const frameY = Math.max(boardY - 16, 16);
  const frameWidth = Math.min(boardWidth + 32, OG_IMAGE_WIDTH - frameX * 2);
  const frameHeight = Math.min(boardHeight + 32, OG_IMAGE_HEIGHT - frameY * 2);

  return Buffer.from(
    `
      <svg width="${OG_IMAGE_WIDTH}" height="${OG_IMAGE_HEIGHT}" viewBox="0 0 ${OG_IMAGE_WIDTH} ${OG_IMAGE_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#071018" />
            <stop offset="100%" stop-color="#0D1218" />
          </linearGradient>
          <filter id="blur">
            <feGaussianBlur stdDeviation="48" />
          </filter>
        </defs>
        <rect width="${OG_IMAGE_WIDTH}" height="${OG_IMAGE_HEIGHT}" fill="url(#bg)" />
        <circle cx="212" cy="144" r="156" fill="#5fb27a" opacity="0.18" filter="url(#blur)" />
        <circle cx="984" cy="468" r="188" fill="#d65a4f" opacity="0.16" filter="url(#blur)" />
        <rect x="24" y="24" width="${OG_IMAGE_WIDTH - 48}" height="${OG_IMAGE_HEIGHT - 48}" rx="28" fill="none" stroke="rgba(255,255,255,0.08)" />
        <rect x="${frameX}" y="${frameY}" width="${frameWidth}" height="${frameHeight}" rx="22" fill="rgba(6, 10, 14, 0.55)" stroke="rgba(255,255,255,0.10)" />
      </svg>
    `,
  );
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
    const format = searchParams.get('format') ?? (isOgVariant ? 'png' : 'webp');
    // Mirroring is handled client-side via CSS scaleX(-1) to maximize cache hit rate

    if (!boardName || !layoutId || !sizeId || !setIds || frames === null) {
      return NextResponse.json({ error: 'Missing required parameters' }, { status: 400 });
    }

    if (!VALID_BOARD_NAMES.has(boardName)) {
      return NextResponse.json({ error: 'Invalid board_name' }, { status: 400 });
    }

    if (format !== 'webp' && format !== 'png') {
      return NextResponse.json({ error: 'Invalid format' }, { status: 400 });
    }

    const parsedSetIds = setIds
      .split(',')
      .map(Number)
      .filter((n) => !isNaN(n));

    // Get board details (pure computation, no DB)
    const boardDetails = getBoardDetailsForBoard({
      board_name: boardName as BoardName,
      layout_id: Number(layoutId),
      size_id: Number(sizeId),
      set_ids: parsedSetIds,
    });
    const ogScale = isOgVariant
      ? Math.min(
          (OG_IMAGE_WIDTH - OG_BOARD_PADDING_X * 2) / boardDetails.boardWidth,
          (OG_IMAGE_HEIGHT - OG_BOARD_PADDING_Y * 2) / boardDetails.boardHeight,
        )
      : null;
    const outputWidth = isOgVariant
      ? Math.max(1, Math.round(boardDetails.boardWidth * (ogScale || 1)))
      : thumbnail
        ? THUMBNAIL_WIDTH
        : boardDetails.boardWidth;

    // Build hold state map for this board
    const holdStateMap: Record<number, { color: string; renderStyle?: string }> = {};
    const boardStates = HOLD_STATE_MAP[boardName as BoardName];
    for (const [code, info] of Object.entries(boardStates)) {
      holdStateMap[Number(code)] = {
        color: info.color,
        ...(info.renderStyle ? { renderStyle: info.renderStyle } : {}),
      };
    }

    // Build the render config
    const config = {
      board_name: boardName,
      board_width: boardDetails.boardWidth,
      board_height: boardDetails.boardHeight,
      output_width: outputWidth,
      frames,
      mirrored: false,
      thumbnail,
      holds: boardDetails.holdsData.map((h) => ({
        id: h.id,
        mirroredHoldId: h.mirroredHoldId,
        cx: h.cx,
        cy: h.cy,
        r: h.r,
      })),
      hold_state_map: holdStateMap,
    };

    // Initialize WASM if needed and render
    await ensureWasmInitialized();
    if (!renderOverlay) {
      return NextResponse.json({ error: 'WASM renderer failed to initialize' }, { status: 500 });
    }

    await acquireRenderSlot();
    let wasmMs = 0;
    let rawBytes: Uint8Array;
    try {
      const wasmT0 = performance.now();
      rawBytes = renderOverlay(JSON.stringify(config));
      wasmMs = performance.now() - wasmT0;
    } finally {
      releaseRenderSlot();
    }

    // Parse dimension header: first 8 bytes are width + height as u32 LE
    const view = new DataView(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);
    const width = view.getUint32(0, true);
    const height = view.getUint32(4, true);
    const rgbaData = rawBytes.subarray(8);

    // Encode to WebP, optionally compositing background images first
    const overlayBuffer = Buffer.from(rgbaData.buffer, rgbaData.byteOffset, rgbaData.byteLength);

    const sharpT0 = performance.now();
    let imageBuffer: Buffer | null = null;
    let outputBuffer: Buffer | null = null;
    let outputContentType = 'image/png';
    let bgMs = 0;
    let composeMs = 0;
    let didCompositeBackground = false;

    if (includeBackground) {
      const bgT0 = performance.now();
      const bgRelPaths = getBackgroundRelPaths(boardDetails, thumbnail);
      const bgFsPaths = bgRelPaths.map((rp) => findPublicImagePath(rp)).filter((p): p is string => p !== null);
      bgMs = performance.now() - bgT0;

      if (bgFsPaths.length > 0) {
        // Load and resize background images, skipping any that fail
        const results = await Promise.allSettled(
          bgFsPaths.map((fsPath) => sharp(fsPath).resize(width, height, { fit: 'fill' }).toBuffer()),
        );
        const resizedBuffers = results
          .filter((r): r is PromiseFulfilledResult<Buffer> => r.status === 'fulfilled')
          .map((r) => r.value);

        const [firstBg, ...restBgs] = resizedBuffers;

        if (firstBg) {
          // Composite: first background as base → remaining backgrounds → WASM overlay on top
          const composeT0 = performance.now();
          const compositedImage = sharp(firstBg).composite([
            ...restBgs.map((buf) => ({ input: buf, blend: 'over' as const })),
            {
              input: overlayBuffer,
              raw: { width, height, channels: 4 as const },
              blend: 'over' as const,
            },
          ]);
          if (!isOgVariant && format === 'webp') {
            outputBuffer = await compositedImage
              .webp(thumbnail ? THUMBNAIL_WEBP_OPTIONS : DEFAULT_WEBP_OPTIONS)
              .toBuffer();
            outputContentType = 'image/webp';
          } else {
            imageBuffer = await compositedImage.png(DEFAULT_PNG_OPTIONS).toBuffer();
          }
          composeMs = performance.now() - composeT0;
          didCompositeBackground = true;
        } else {
          // All background loads failed — fall back to overlay-only
          const composeT0 = performance.now();
          const overlayImage = sharp(overlayBuffer, { raw: { width, height, channels: 4 } });
          if (!isOgVariant && format === 'webp') {
            outputBuffer = await overlayImage.webp(thumbnail ? THUMBNAIL_WEBP_OPTIONS : { lossless: true }).toBuffer();
            outputContentType = 'image/webp';
          } else {
            imageBuffer = await overlayImage.png(DEFAULT_PNG_OPTIONS).toBuffer();
          }
          composeMs = performance.now() - composeT0;
        }
      } else {
        // No background images found — fall back to overlay-only lossless
        const composeT0 = performance.now();
        const overlayImage = sharp(overlayBuffer, { raw: { width, height, channels: 4 } });
        if (!isOgVariant && format === 'webp') {
          outputBuffer = await overlayImage.webp(thumbnail ? THUMBNAIL_WEBP_OPTIONS : { lossless: true }).toBuffer();
          outputContentType = 'image/webp';
        } else {
          imageBuffer = await overlayImage.png(DEFAULT_PNG_OPTIONS).toBuffer();
        }
        composeMs = performance.now() - composeT0;
      }
    } else {
      // Default: overlay-only lossless WebP (25-30% smaller than PNG)
      const composeT0 = performance.now();
      const overlayImage = sharp(overlayBuffer, { raw: { width, height, channels: 4 } });
      if (!isOgVariant && format === 'webp') {
        outputBuffer = await overlayImage.webp(thumbnail ? THUMBNAIL_WEBP_OPTIONS : { lossless: true }).toBuffer();
        outputContentType = 'image/webp';
      } else {
        imageBuffer = await overlayImage.png(DEFAULT_PNG_OPTIONS).toBuffer();
      }
      composeMs = performance.now() - composeT0;
    }

    const encodeT0 = performance.now();

    if (outputBuffer === null && isOgVariant && imageBuffer) {
      outputBuffer = await sharp(createOgBackgroundBuffer(width, height))
        .composite([
          {
            input: imageBuffer,
            left: Math.round((OG_IMAGE_WIDTH - width) / 2),
            top: Math.round((OG_IMAGE_HEIGHT - height) / 2),
            blend: 'over',
          },
        ])
        .png(DEFAULT_PNG_OPTIONS)
        .toBuffer();
      outputContentType = 'image/png';
    } else if (outputBuffer === null && imageBuffer && format === 'webp') {
      outputBuffer = await sharp(imageBuffer)
        .webp(thumbnail ? THUMBNAIL_WEBP_OPTIONS : didCompositeBackground ? DEFAULT_WEBP_OPTIONS : { lossless: true })
        .toBuffer();
      outputContentType = 'image/webp';
    } else if (outputBuffer === null && imageBuffer) {
      outputBuffer = imageBuffer;
      outputContentType = 'image/png';
    }

    if (!outputBuffer) {
      return NextResponse.json({ error: 'Render failed: no output buffer generated' }, { status: 500 });
    }

    const encodeMs = performance.now() - encodeT0;
    const sharpMs = performance.now() - sharpT0;
    const totalMs = wasmMs + sharpMs;

    const timingParts = [
      `wasm;dur=${wasmMs.toFixed(1)}`,
      `sharp;dur=${sharpMs.toFixed(1)}`,
      `compose;dur=${composeMs.toFixed(1)}`,
      `encode;dur=${encodeMs.toFixed(1)}`,
    ];
    if (bgMs > 0) timingParts.push(`bg;dur=${bgMs.toFixed(1)}`);

    console.log(
      `[BoardRender] board=${boardName} variant=${isOgVariant ? 'og' : 'default'} thumb=${thumbnail} ` +
        `wasm=${wasmMs.toFixed(0)}ms sharp=${sharpMs.toFixed(0)}ms total=${totalMs.toFixed(0)}ms ` +
        `size=${outputBuffer.byteLength}B queue=${renderQueue.length}`,
    );

    return new NextResponse(new Uint8Array(outputBuffer), {
      headers: {
        ...createOgImageHeaders({
          contentType: outputContentType,
          version: 'immutable',
          serverTiming: timingParts.join(', '),
        }),
      },
    });
  } catch (error) {
    console.error('Board render error:', error);
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: `Render failed: ${message}` }, { status: 500 });
  }
}
