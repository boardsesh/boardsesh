import type { IncomingMessage, ServerResponse } from 'http';
import {
  MAX_SET_IDS_LENGTH,
  createOgImageHeaders,
  normalizeOutputFormat,
  ogClimbQuerySchema,
  type OutputFormat,
} from '@boardsesh/board-render';
import { MAX_CARD_NAME_PARAM_LENGTH, MAX_CARD_SETTER_PARAM_LENGTH } from '@boardsesh/board-render';
import { applyCorsHeaders } from './cors';
import { describeBoardConfig } from '../services/og-card-board-line';
import { getPublicClientIp } from '../utils/client-ip';
import { checkRateLimitRedis } from '../utils/redis-rate-limiter';
import { RateLimitError } from '../utils/rate-limiter';
import { RenderQueueSaturatedError, ensureBoardRendererAvailable, renderOgClimb } from '../services/board-render';
import { createSprayOgCardDeps, renderSprayOgCard, type SprayOgCardDeps } from '../services/spray-og-card';
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
/**
 * Family handed to Pango. The Alpine image installs Noto plus WenQuanYi Zen Hei,
 * so fontconfig's fallback chain covers the scripts the catalogue actually
 * contains — Japanese, Chinese, Hebrew, Arabic and emoji all appear in real
 * climb names. Unset elsewhere, where fontconfig picks whatever the host has.
 */
const OG_CARD_FONT_FAMILY = process.env.OG_CARD_FONT_FAMILY?.trim() || undefined;

/**
 * Kill switch for the caller-supplied text on a card, without a deploy.
 *
 * `/og/climb` is unauthenticated, so `n` and `s` let anyone put a short string
 * on an image served from our hostname. The caps and normalisation in
 * `ogClimbQuerySchema` are the bound; this is the lever if that ever proves not
 * to be enough. The board, the grade and the angle are not caller free text and
 * keep rendering either way.
 */
const cardTextEnabled = process.env.OG_CARD_TEXT_DISABLED !== '1';

export async function handleOgClimb(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (!applyCorsHeaders(req, res)) return;

  const rawSetIds = url.searchParams.get('set_ids');
  if (rawSetIds !== null && rawSetIds.length > MAX_SET_IDS_LENGTH) {
    sendJson(res, 400, { error: 'Invalid parameters', details: ['set_ids is too large'] });
    return;
  }

  // Byte-sized bounds on the two free-text params before zod does any
  // per-codepoint work, same reason as `set_ids` above: a hostile query string
  // must not make validation scale with its own length.
  const rawName = url.searchParams.get('n');
  const rawSetter = url.searchParams.get('s');
  if (rawName !== null && rawName.length > MAX_CARD_NAME_PARAM_LENGTH) {
    sendJson(res, 400, { error: 'Invalid parameters', details: ['n is too large'] });
    return;
  }
  if (rawSetter !== null && rawSetter.length > MAX_CARD_SETTER_PARAM_LENGTH) {
    sendJson(res, 400, { error: 'Invalid parameters', details: ['s is too large'] });
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
    // Aura render options (issue #2202) — see docs/og-climb.md. `render_mode`
    // defaults to aura, the app's own drawing; the rest default closed.
    render_mode: url.searchParams.get('render_mode') ?? undefined,
    glow_falloff: url.searchParams.get('glow_falloff') ?? undefined,
    glyphs: url.searchParams.get('glyphs') ?? undefined,
    field_color: url.searchParams.get('field_color') ?? undefined,
    // Climb identity for the card's right-hand column. All optional: a URL from
    // an already-shipped mobile binary renders the board on its own.
    n: cardTextEnabled ? (rawName ?? undefined) : undefined,
    s: cardTextEnabled ? (rawSetter ?? undefined) : undefined,
    g: cardTextEnabled ? (url.searchParams.get('g') ?? undefined) : undefined,
    angle: url.searchParams.get('angle') ?? undefined,
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

  const query = parsed.data;
  const format: OutputFormat = query.format ? (normalizeOutputFormat(query.format) ?? 'jpeg') : 'jpeg';

  // Spray walls (SW-16, #5449) are answered from the database, before the WASM
  // availability check: the card is sharp + SVG over a fetched photograph, so a
  // renderer that failed to boot has nothing to do with it and must not 503 it.
  if (query.board_name === 'spray') {
    await serveSprayOgCard(res, { layoutId: query.layout_id, frames: query.frames, format });
    return;
  }

  if (!(await ensureBoardRendererAvailable())) {
    sendJson(res, 503, { error: 'Board renderer unavailable' });
    return;
  }

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
      card: {
        name: query.n,
        grade: query.g,
        setter: query.s,
        angle: query.angle,
        // Derived here, not taken from the caller: the board and size are
        // already fully determined by the config params, so a `board_label`
        // param would be a second, forgeable source for the same fact.
        boardLine: describeBoardConfig(query.board_name, query.layout_id, query.size_id),
        fontFamily: OG_CARD_FONT_FAMILY,
      },
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

// Resolved once. The deps close over the drizzle client and the media bucket,
// neither of which changes for the life of the process.
let sprayOgCardDeps: SprayOgCardDeps | null = null;
function getSprayOgCardDeps(): SprayOgCardDeps {
  sprayOgCardDeps ??= createSprayOgCardDeps();
  return sprayOgCardDeps;
}

/**
 * A spray-wall climb's card: public walls only, everything else a 404.
 *
 * 404 rather than 403 or a generic card because this URL is guessable — layout
 * ids are sequential — and any answer other than "there is nothing here" tells a
 * stranger which ids are somebody's home wall. A private wall and a nonexistent
 * one are indistinguishable from outside.
 *
 * The 200 is daily rather than `immutable`. Unlike every other card on this
 * endpoint, the bytes are NOT determined by the query string: a reset re-points
 * the photograph and the holds under an unchanged `layout_id` + `frames`, so a
 * year-long immutable header would pin last year's wall at the edge forever.
 */
async function serveSprayOgCard(
  res: ServerResponse,
  params: { layoutId: number; frames: string; format: OutputFormat },
): Promise<void> {
  const totalT0 = performance.now();
  let result: Awaited<ReturnType<typeof renderSprayOgCard>>;
  try {
    result = await renderSprayOgCard(params, getSprayOgCardDeps());
  } catch (error) {
    // Same shape the catalogue path answers with: the spray branch shares the
    // render cap, so it saturates the same way and owes callers the same
    // backpressure rather than a 500.
    if (error instanceof RenderQueueSaturatedError) {
      res.writeHead(503, {
        'Content-Type': 'application/json',
        'Retry-After': '5',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ error: error.message }));
      return;
    }
    // What is left is a genuine server fault — a database error, a bug. An
    // unreadable photograph is NOT here: `renderSprayOgCard` degrades that to
    // `not-found` so a link somebody posted answers 404 rather than 500.
    logger.error('[OGClimb] spray render failed:', error);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: 'Render failed' }));
    return;
  }

  if (result.kind === 'not-found') {
    // Never cached: a wall its owner makes public tomorrow must not stay a 404
    // at the edge, and a cached 404 on a shareable URL is the exact failure
    // docs/og-climb.md warns about.
    res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  const totalMs = performance.now() - totalT0;
  const serverTiming = [
    `total;dur=${totalMs.toFixed(1)}`,
    `photo;dur=${result.timings.photoMs.toFixed(1)}`,
    `compose;dur=${result.timings.composeMs.toFixed(1)}`,
  ].join(', ');

  // Same spread as the catalogue path: the Vercel header is meaningless here.
  const { 'Vercel-CDN-Cache-Control': _vercelOnlyHeader, ...ogImageHeaders } = createOgImageHeaders({
    contentType: result.contentType,
    version: null,
    unversionedTier: 'daily',
    serverTiming,
  });
  res.writeHead(200, {
    ...ogImageHeaders,
    'Content-Length': result.buffer.length,
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(result.buffer);

  const logPayload = {
    boardName: 'spray',
    layoutId: params.layoutId,
    totalMs: Math.round(totalMs),
    photoMs: Math.round(result.timings.photoMs),
    composeMs: Math.round(result.timings.composeMs),
    bytes: result.buffer.length,
    format: params.format,
  };
  if (totalMs > SLOW_RENDER_MS) {
    logger.warn('[OGClimb] served spray (slow)', logPayload);
  } else {
    logger.info('[OGClimb] served spray', logPayload);
  }
}
