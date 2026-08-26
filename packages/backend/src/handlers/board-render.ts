import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  MAX_FRAMES_LENGTH,
  MAX_SET_IDS,
  VALID_BOARD_NAMES,
  createOgImageHeaders,
  isValidFramesString,
  normalizeOutputFormat,
} from '@boardsesh/board-render';
import {
  RenderOutputTooLargeError,
  RenderQueueSaturatedError,
  ensureBoardRendererAvailable,
  renderBoardImage,
} from '../services/board-render';
import { logger } from '../utils/logger';

const SLOW_RENDER_MS = 1_000;

export function isBoardRenderPath(pathname: string): boolean {
  return pathname === '/render/board' || pathname === '/api/internal/board-render';
}

function applyPublicImageCors(req: IncomingMessage, res: ServerResponse): boolean {
  // Credentialless public image bytes are identical for every caller, so `*`
  // is both safe and cache-friendly (no Origin-dependent response variants).
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return false;
  }
  return true;
}

function sendJson(req: IncomingMessage, res: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(encoded),
  });
  res.end(req.method === 'HEAD' ? undefined : encoded);
}

/** A version token names immutable bytes; malformed tokens stay on the daily tier. */
function isWellFormedRenderVersion(value: string | null): value is string {
  return value !== null && /^[0-9a-f]{8,64}$/.test(value);
}

function parseNonnegativeInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Canonical public board image renderer: GET/HEAD/OPTIONS /render/board. */
export async function handleBoardRender(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (!applyPublicImageCors(req, res)) return;

  const { searchParams } = url;
  const boardName = searchParams.get('board_name');
  const layoutId = searchParams.get('layout_id');
  const sizeId = searchParams.get('size_id');
  const setIds = searchParams.get('set_ids');
  const frames = searchParams.get('frames');
  const thumbnail = searchParams.get('thumbnail') === '1';
  const includeBackground = searchParams.get('include_background') === '1';
  const isOgVariant = searchParams.get('variant') === 'og';
  const format = normalizeOutputFormat(searchParams.get('format') ?? (isOgVariant ? 'png' : 'webp'));
  const requestedVersion = searchParams.get('v');
  const renderVersion = isWellFormedRenderVersion(requestedVersion) ? requestedVersion : null;

  if (!boardName || !layoutId || !sizeId || !setIds || frames === null) {
    sendJson(req, res, 400, { error: 'Missing required parameters' });
    return;
  }
  if (!VALID_BOARD_NAMES.has(boardName)) {
    sendJson(req, res, 400, { error: 'Invalid board_name' });
    return;
  }
  const parsedLayoutId = parseNonnegativeInteger(layoutId);
  if (parsedLayoutId === null) {
    sendJson(req, res, 400, { error: 'layout_id must be a nonnegative integer' });
    return;
  }
  const parsedSizeId = parseNonnegativeInteger(sizeId);
  if (parsedSizeId === null) {
    sendJson(req, res, 400, { error: 'size_id must be a nonnegative integer' });
    return;
  }
  const parsedSetIds = setIds.split(',');
  if (!/^\d+(,\d+)*$/.test(setIds) || parsedSetIds.some((setId) => parseNonnegativeInteger(setId) === null)) {
    sendJson(req, res, 400, { error: 'set_ids must be a comma-separated list of integers' });
    return;
  }
  if (parsedSetIds.length > MAX_SET_IDS) {
    sendJson(req, res, 400, { error: `set_ids accepts at most ${MAX_SET_IDS} ids` });
    return;
  }
  if (format === null) {
    sendJson(req, res, 400, { error: 'Invalid format' });
    return;
  }
  if (frames.length > MAX_FRAMES_LENGTH) {
    sendJson(req, res, 400, { error: 'Frames string is too large' });
    return;
  }
  if (!isValidFramesString(frames)) {
    sendJson(req, res, 400, { error: 'Invalid frames' });
    return;
  }

  const dimBackgroundRaw = searchParams.get('dim_background');
  const dimBackground = dimBackgroundRaw !== null ? Number(dimBackgroundRaw) : 0;
  if (dimBackgroundRaw !== null && (Number.isNaN(dimBackground) || dimBackground < 0 || dimBackground > 1)) {
    sendJson(req, res, 400, { error: 'dim_background must be a number between 0 and 1' });
    return;
  }

  if (!(await ensureBoardRendererAvailable())) {
    sendJson(req, res, 503, { error: 'Board renderer unavailable' });
    return;
  }

  try {
    const totalT0 = performance.now();
    const rendered = await renderBoardImage({
      boardName,
      layoutId: parsedLayoutId,
      sizeId: parsedSizeId,
      setIds,
      frames,
      thumbnail,
      includeBackground,
      dimBackground,
      isOgVariant,
      format,
    });
    const totalMs = performance.now() - totalT0;
    const timingParts =
      rendered.cache === 'hit'
        ? ['cache;desc=hit', 'queue;dur=0.0']
        : [
            `wasm;dur=${rendered.timings.wasmMs.toFixed(1)}`,
            `sharp;dur=${rendered.timings.sharpMs.toFixed(1)}`,
            `compose;dur=${rendered.timings.composeMs.toFixed(1)}`,
            `encode;dur=${rendered.timings.encodeMs.toFixed(1)}`,
            ...(rendered.timings.bgMs > 0 ? [`bg;dur=${rendered.timings.bgMs.toFixed(1)}`] : []),
            `cache;desc=${rendered.cache}`,
            `queue;dur=${Math.max(0, rendered.queueMs).toFixed(1)}`,
          ];

    const { 'Vercel-CDN-Cache-Control': _vercelOnlyHeader, ...imageHeaders } = createOgImageHeaders({
      contentType: rendered.contentType,
      version: renderVersion,
      unversionedTier: 'daily',
      serverTiming: timingParts.join(', '),
    });
    res.writeHead(200, {
      ...imageHeaders,
      'Content-Length': rendered.buffer.length,
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : rendered.buffer);

    const logPayload = {
      boardName,
      layoutId: parsedLayoutId,
      sizeId: parsedSizeId,
      cache: rendered.cache,
      totalMs: Math.round(totalMs),
      bytes: rendered.buffer.length,
      format,
      thumbnail,
      isOgVariant,
    };
    if (totalMs > SLOW_RENDER_MS) logger.warn('[BoardRender] served (slow)', logPayload);
    else logger.info('[BoardRender] served', logPayload);
  } catch (error) {
    if (error instanceof RenderQueueSaturatedError) {
      const encoded = JSON.stringify({ error: error.message });
      res.writeHead(503, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(encoded),
        'Retry-After': '5',
        'Cache-Control': 'no-store',
      });
      res.end(req.method === 'HEAD' ? undefined : encoded);
      return;
    }
    if (error instanceof RenderOutputTooLargeError) {
      sendJson(req, res, 400, { error: error.message });
      return;
    }
    logger.error('[BoardRender] render failed:', error);
    const message = error instanceof Error ? error.message : String(error);
    sendJson(req, res, 500, { error: `Render failed: ${message}` });
  }
}
