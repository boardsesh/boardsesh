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
  isValidFramesString,
  MAX_FRAMES_LENGTH,
  normalizeOutputFormat,
  VALID_BOARD_NAMES,
} from '@boardsesh/board-render';
import { createOverlayRenderer } from '@boardsesh/board-render/wasm';
import { renderBoardImageBuffer } from '@boardsesh/board-render/pipeline';

// Node.js runtime for reliable WASM loading via filesystem
export const runtime = 'nodejs';

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

    // Initialize WASM if needed and render the overlay.
    const wasmT0 = performance.now();
    const { width, height, rgba } = await overlayRenderer.render(JSON.stringify(config));
    const wasmMs = performance.now() - wasmT0;

    const overlayBuffer = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);

    const { buffer, contentType, timings } = await renderBoardImageBuffer({
      overlayBuffer,
      width,
      height,
      isOgVariant,
      format,
      thumbnail,
      includeBackground,
      dimBackground,
      boardDetails,
      resolveImagePath: findPublicImagePath,
    });

    const timingParts = [
      `wasm;dur=${wasmMs.toFixed(1)}`,
      `sharp;dur=${timings.sharpMs.toFixed(1)}`,
      `compose;dur=${timings.composeMs.toFixed(1)}`,
      `encode;dur=${timings.encodeMs.toFixed(1)}`,
    ];
    if (timings.bgMs > 0) timingParts.push(`bg;dur=${timings.bgMs.toFixed(1)}`);

    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        ...createOgImageHeaders({
          contentType,
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
