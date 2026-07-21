import type { IncomingMessage, ServerResponse } from 'http';
import {
  createOgImageHeaders,
  normalizeOutputFormat,
  ogClimbQuerySchema,
  type OutputFormat,
} from '@boardsesh/board-render';
import { applyCorsHeaders } from './cors';
import { checkRateLimitRedis } from '../utils/redis-rate-limiter';
import { RateLimitError } from '../utils/rate-limiter';
import { ensureBoardRendererAvailable, renderOgClimb } from '../services/board-render';
import { logger } from '../utils/logger';

const RATE_LIMIT_MAX = 120;
const RATE_LIMIT_WINDOW_MS = 60_000;
const SLOW_RENDER_MS = 1000;

/**
 * Client IP for rate limiting. Uses the LAST x-forwarded-for entry: the edge
 * proxy (Railway) appends the IP it observed, while earlier entries are
 * client-supplied and spoofable — trusting the first hop would let a client
 * mint a fresh identity per request and bypass the per-IP limit.
 */
function getClientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  const forwardedChain = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;
  const lastHop = forwardedChain?.split(',').at(-1)?.trim();
  return lastHop || req.socket.remoteAddress || 'unknown';
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * GET /og/climb — render a climb's Open Graph share card. Strict validation
 * runs before any CPU-heavy work; the render is served from in-memory caches
 * when possible. Returns an immutably cacheable JPEG (default), PNG, or WebP.
 */
export async function handleOgClimb(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (!applyCorsHeaders(req, res)) return;

  // Validate BEFORE any render work — a bad request is cheap to reject and can't
  // push this public CPU-heavy endpoint into wasted WASM/sharp renders.
  const parsed = ogClimbQuerySchema.safeParse({
    board_name: url.searchParams.get('board_name'),
    layout_id: url.searchParams.get('layout_id'),
    size_id: url.searchParams.get('size_id'),
    set_ids: url.searchParams.get('set_ids'),
    frames: url.searchParams.get('frames') ?? '',
    format: url.searchParams.get('format') ?? undefined,
  });
  if (!parsed.success) {
    sendJson(res, 400, { error: 'Invalid parameters', details: parsed.error.issues.map((issue) => issue.message) });
    return;
  }

  // Per-IP rate limit. Fails open when Redis is unavailable (falls back to the
  // in-memory limiter inside checkRateLimitRedis).
  try {
    await checkRateLimitRedis(getClientIp(req), 'og-climb', RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  } catch (error) {
    if (error instanceof RateLimitError) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(error.retryAfterSeconds) });
      res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
      return;
    }
    throw error;
  }

  if (!(await ensureBoardRendererAvailable())) {
    sendJson(res, 503, { error: 'Board renderer unavailable' });
    return;
  }

  const query = parsed.data;
  const format: OutputFormat = query.format ? (normalizeOutputFormat(query.format) ?? 'jpeg') : 'jpeg';

  try {
    const totalT0 = performance.now();
    const { buffer, contentType, cache, timings } = await renderOgClimb({
      boardName: query.board_name,
      layoutId: query.layout_id,
      sizeId: query.size_id,
      setIds: query.set_ids,
      frames: query.frames,
      format,
    });
    const totalMs = performance.now() - totalT0;

    const serverTiming = [
      `total;dur=${totalMs.toFixed(1)}`,
      `wasm;dur=${timings.wasmMs.toFixed(1)}`,
      `base;dur=${timings.baseMs.toFixed(1)}`,
      `encode;dur=${timings.encodeMs.toFixed(1)}`,
      `cache;desc=${cache}`,
    ].join(', ');

    res.writeHead(200, {
      ...createOgImageHeaders({ contentType, version: 'immutable', serverTiming }),
      'Content-Length': buffer.length,
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(buffer);

    const logPayload = {
      boardName: query.board_name,
      layoutId: query.layout_id,
      sizeId: query.size_id,
      cache,
      totalMs: Math.round(totalMs),
      wasmMs: Math.round(timings.wasmMs),
      encodeMs: Math.round(timings.encodeMs),
      bytes: buffer.length,
      format,
    };
    if (totalMs > SLOW_RENDER_MS) {
      logger.warn('[OGClimb] served (slow)', logPayload);
    } else {
      logger.info('[OGClimb] served', logPayload);
    }
  } catch (error) {
    logger.error('[OGClimb] render failed:', error);
    sendJson(res, 500, { error: 'Render failed' });
  }
}
