import type { IncomingMessage, ServerResponse } from 'http';
import {
  MAX_SET_IDS_LENGTH,
  createOgImageHeaders,
  normalizeOutputFormat,
  ogClimbQuerySchema,
  type OutputFormat,
} from '@boardsesh/board-render';
import { applyCorsHeaders } from './cors';
import { getPublicClientIp } from '../utils/client-ip';
import { checkRateLimitRedis } from '../utils/redis-rate-limiter';
import { RateLimitError } from '../utils/rate-limiter';
import { RenderQueueSaturatedError, ensureBoardRendererAvailable, renderOgClimb } from '../services/board-render';
import { logger } from '../utils/logger';

const RATE_LIMIT_MAX = 120;
// Secondary bucket keyed by the TCP peer: on Railway that is the edge proxy,
// so this acts as a high global ceiling that still caps abuse if the service
// is ever reached through a proxy that forwards x-forwarded-for without
// appending (which would let clients mint fresh per-IP buckets at will).
const SOCKET_RATE_LIMIT_MAX = 600;
const RATE_LIMIT_WINDOW_MS = 60_000;
const SLOW_RENDER_MS = 1000;

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

  const rawSetIds = url.searchParams.get('set_ids');
  if (rawSetIds !== null && rawSetIds.length > MAX_SET_IDS_LENGTH) {
    sendJson(res, 400, { error: 'Invalid parameters', details: ['set_ids is too large'] });
    return;
  }

  // Validate BEFORE any render work — a bad request is cheap to reject and can't
  // push this public CPU-heavy endpoint into wasted WASM/sharp renders.
  const parsed = ogClimbQuerySchema.safeParse({
    board_name: url.searchParams.get('board_name'),
    layout_id: url.searchParams.get('layout_id'),
    size_id: url.searchParams.get('size_id'),
    set_ids: rawSetIds,
    frames: url.searchParams.get('frames') ?? '',
    format: url.searchParams.get('format') ?? undefined,
    // boardsesh-mode render options (issue #2202) — see docs/og-climb.md.
    // Defaults keep this endpoint classic.
    render_mode: url.searchParams.get('render_mode') ?? undefined,
    glow_falloff: url.searchParams.get('glow_falloff') ?? undefined,
    glyphs: url.searchParams.get('glyphs') ?? undefined,
    field_color: url.searchParams.get('field_color') ?? undefined,
  });
  if (!parsed.success) {
    sendJson(res, 400, { error: 'Invalid parameters', details: parsed.error.issues.map((issue) => issue.message) });
    return;
  }

  // Per-IP rate limit plus a per-socket-peer ceiling (see SOCKET_RATE_LIMIT_MAX).
  // Fails open when Redis is unavailable (falls back to the in-memory limiter
  // inside checkRateLimitRedis).
  try {
    await checkRateLimitRedis(getPublicClientIp(req), 'og-climb', RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
    await checkRateLimitRedis(
      req.socket.remoteAddress || 'unknown',
      'og-climb-peer',
      SOCKET_RATE_LIMIT_MAX,
      RATE_LIMIT_WINDOW_MS,
    );
  } catch (error) {
    if (error instanceof RateLimitError) {
      const encoded = JSON.stringify({ error: 'Rate limit exceeded' });
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(encoded),
        'Retry-After': String(error.retryAfterSeconds),
        'Cache-Control': 'no-store',
      });
      res.end(encoded);
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
      renderMode: query.render_mode,
      glowFalloff: query.glow_falloff,
      glyphs: query.glyphs,
      fieldColor: query.field_color,
    });
    const totalMs = performance.now() - totalT0;
    const totalEncodeMs = (timings.composeMs ?? 0) + timings.encodeMs;

    const serverTiming = [
      `total;dur=${totalMs.toFixed(1)}`,
      `wasm;dur=${timings.wasmMs.toFixed(1)}`,
      `base;dur=${timings.baseMs.toFixed(1)}`,
      `encode;dur=${totalEncodeMs.toFixed(1)}`,
      `cache;desc=${cache}`,
    ].join(', ');

    // The shared helper also emits Vercel-CDN-Cache-Control for the web route;
    // that header is meaningless from this origin, so drop it.
    const { 'Vercel-CDN-Cache-Control': _vercelOnlyHeader, ...ogImageHeaders } = createOgImageHeaders({
      contentType,
      version: 'immutable',
      serverTiming,
    });
    res.writeHead(200, {
      ...ogImageHeaders,
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
      encodeMs: Math.round(totalEncodeMs),
      bytes: buffer.length,
      format,
    };
    if (totalMs > SLOW_RENDER_MS) {
      logger.warn('[OGClimb] served (slow)', logPayload);
    } else {
      logger.info('[OGClimb] served', logPayload);
    }
  } catch (error) {
    if (error instanceof RenderQueueSaturatedError) {
      res.writeHead(503, {
        'Content-Type': 'application/json',
        'Retry-After': '5',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ error: error.message }));
      return;
    }
    logger.error('[OGClimb] render failed:', error);
    sendJson(res, 500, { error: 'Render failed' });
  }
}
