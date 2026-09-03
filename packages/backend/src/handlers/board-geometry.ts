import type { IncomingMessage, ServerResponse } from 'node:http';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { getWallLightness, loadBoardArtGeometry } from '@boardsesh/board-art-geometry';
import { createOgImageHeaders, isSupportedBoardName } from '@boardsesh/board-render';
import type { BoardName } from '@boardsesh/shared-schema';
import { getPublicClientIp } from '../utils/client-ip';
import { logger } from '../utils/logger';
import { RateLimitError } from '../utils/rate-limiter';
import { checkRateLimitRedis } from '../utils/redis-rate-limiter';

/**
 * The traced board art, for renderers that run in a browser.
 *
 * The shards in `@boardsesh/board-art-geometry` are 5.2 MB across 51 files
 * behind an index of literal `require`s, so any import of them from web code
 * puts every board's polygons in the bundle — to draw one. This endpoint hands
 * over the single config a page actually needs (43 KB gzipped at the worst,
 * Kilter Original 12x12; most are a fraction of that), which the worker fetches
 * once and keeps.
 *
 * Same data the server renderer reads for its own Aura renders, so the two draw
 * the same silhouettes.
 */

// Compressing off-thread: a 40-70 KB payload is a short block, but it is a
// block on the same loop that serves every WebSocket session, and a cold
// process asked for several board configs at once pays it once per config.
const gzipAsync = promisify(gzip);

const RATE_LIMIT_MAX = 120;
// Keyed by the TCP peer, which on Railway is the edge proxy: a high global
// ceiling that still caps abuse if this is ever reached through a proxy that
// forwards x-forwarded-for without appending.
const SOCKET_RATE_LIMIT_MAX = 600;
const RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * Responses are pure functions of `(board, layout, size)` and the shipped
 * tables, so one process-lifetime cache of the encoded bytes serves every
 * request. 51 configs, ~5 MB uncompressed if every one is asked for — bounded
 * by the catalogue, not by traffic, so there is nothing to evict.
 */
type EncodedGeometry = { json: Buffer; gzip: Buffer };
const encodedCache = new Map<string, Promise<EncodedGeometry>>();

async function encodeGeometry(
  cacheKey: string,
  query: { boardName: BoardName; layoutId: number; sizeId: number },
): Promise<EncodedGeometry> {
  const geometry = loadBoardArtGeometry(query);
  const wallLightness = getWallLightness(query);
  const payload = {
    ...(geometry
      ? {
          outlines: geometry.outlines,
          ledBright: geometry.ledBright,
          silhouetteLightness: geometry.silhouetteLightness,
          ...(geometry.ledInner ? { ledInner: geometry.ledInner } : {}),
        }
      : {}),
    ...(wallLightness ? { wallLightness } : {}),
  };
  const json = Buffer.from(JSON.stringify(payload));
  const encoded: EncodedGeometry = { json, gzip: await gzipAsync(json) };
  logger.info('[BoardGeometry] encoded', {
    config: cacheKey,
    traced: geometry ? Object.keys(geometry.outlines).length : 0,
    bytes: json.length,
    gzipBytes: encoded.gzip.length,
  });
  return encoded;
}

export function isBoardGeometryPath(pathname: string): boolean {
  return pathname === '/render/geometry' || pathname === '/api/internal/board-geometry';
}

function sendJson(req: IncomingMessage, res: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(encoded),
  });
  res.end(req.method === 'HEAD' ? undefined : encoded);
}

function parseNonnegativeInteger(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** A version token names immutable bytes; malformed tokens stay on the daily tier. */
function isWellFormedRenderVersion(value: string | null): value is string {
  return value !== null && /^[0-9a-f]{8,64}$/.test(value);
}

/**
 * GET/HEAD/OPTIONS `/render/geometry` — the traced art for one board config.
 *
 * A config the tracer skipped answers `{}` with a 200, not a 404: "this board
 * has no silhouettes" is a normal answer that the renderer handles by glowing a
 * ring at each placement radius, and a 404 would make every caller special-case
 * it.
 */
export async function handleBoardGeometry(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  // Credentialless public data, identical for every caller, so `*` is both safe
  // and cache-friendly (no Origin-dependent response variants).
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const { searchParams } = url;
  const boardName = searchParams.get('board_name');
  const layoutId = parseNonnegativeInteger(searchParams.get('layout_id'));
  const sizeId = parseNonnegativeInteger(searchParams.get('size_id'));

  if (boardName === null || !isSupportedBoardName(boardName)) {
    sendJson(req, res, 400, { error: 'board_name must be a supported board' });
    return;
  }
  if (layoutId === null) {
    sendJson(req, res, 400, { error: 'layout_id must be a nonnegative integer' });
    return;
  }
  if (sizeId === null) {
    sendJson(req, res, 400, { error: 'size_id must be a nonnegative integer' });
    return;
  }

  try {
    await checkRateLimitRedis(getPublicClientIp(req), 'board-geometry', RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
    await checkRateLimitRedis(
      req.socket.remoteAddress || 'unknown',
      'board-geometry-peer',
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
      res.end(req.method === 'HEAD' ? undefined : encoded);
      return;
    }
    throw error;
  }

  const cacheKey = `${boardName}/${layoutId}-${sizeId}`;
  // Memoised on the promise, not the result: a cold process serving a list page
  // takes a burst of requests for one board config, and every one of them would
  // otherwise miss and compress the same bytes while the first was still
  // awaiting.
  //
  // A rejection evicts itself. Caching one would answer every later request for
  // that board with the same failure for the rest of the process lifetime — for
  // every client, not just the one that was unlucky — and the only way back
  // would be a restart.
  let pending = encodedCache.get(cacheKey);
  if (!pending) {
    pending = encodeGeometry(cacheKey, { boardName, layoutId, sizeId });
    encodedCache.set(cacheKey, pending);
    pending.catch(() => encodedCache.delete(cacheKey));
  }
  const encoded = await pending;

  const version = searchParams.get('v');
  const acceptsGzip = (req.headers['accept-encoding'] ?? '').includes('gzip');
  const body = acceptsGzip ? encoded.gzip : encoded.json;
  // The shared helper also emits Vercel-CDN-Cache-Control; that header is
  // meaningless from this origin, so drop it.
  const { 'Vercel-CDN-Cache-Control': _vercelOnlyHeader, ...cacheHeaders } = createOgImageHeaders({
    contentType: 'application/json; charset=utf-8',
    version: isWellFormedRenderVersion(version) ? version : null,
    unversionedTier: 'daily',
  });

  res.writeHead(200, {
    ...cacheHeaders,
    ...(acceptsGzip ? { 'Content-Encoding': 'gzip' } : {}),
    'Content-Length': body.length,
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Accept-Encoding',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

/** Tests only: forget the encoded payloads between cases. */
export function resetBoardGeometryCache(): void {
  encodedCache.clear();
}
