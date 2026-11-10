import type { IncomingMessage, ServerResponse } from 'node:http';
import { createPrivateOgImageHeaders } from '@boardsesh/board-render';
import { applyCorsHeaders } from './cors';
import { getPublicClientIp } from '../utils/client-ip';
import { checkRateLimitRedis } from '../utils/redis-rate-limiter';
import { RateLimitError } from '../utils/rate-limiter';
import { logger } from '../utils/logger';
import {
  RenderQueueSaturatedError,
  buildOgFamilyByteKey,
  ensureBoardRendererAvailable,
  renderOgFamilyArt,
} from '../services/board-render';
import { OgFamilyNotFoundError } from '../services/og-family/run-document';
import { CardReadsSaturatedError } from '../services/og-family/card-read-limit';
import {
  loadPlaylistCard,
  loadProfileCard,
  loadSessionJoinCard,
  loadSessionRecapCard,
  loadSetterCard,
} from '../services/og-family/load-cards';
import { loadBoardPlaceCard, loadGymPlaceCard } from '../services/og-family/load-place-cards';
import { PlacePhotoTemporarilyUnavailableError } from '../services/og-family/place-photo';
import type { LoadedOgFamilyCard } from '../services/og-family/card-model';

// The same limits as `/og/climb`: one image per crawl, and a card costs a render.
const RATE_LIMIT_MAX = 120;
const SOCKET_RATE_LIMIT_MAX = 600;
const RATE_LIMIT_WINDOW_MS = 60_000;
const SLOW_RENDER_MS = 1000;

/** `Noto Sans` for the same reason `/og/climb` names it: see `OG_CARD_FONT_FAMILY` there. */
const OG_FAMILY_FONT_FAMILY = process.env.OG_CARD_FONT_FAMILY?.trim() || 'Noto Sans';

/** A session id or playlist uuid: bounded before any database or CPU work. */
const OG_RESOURCE_ID_PATTERN = /^[A-Za-z0-9-]{1,100}$/;

/** A user id: uuid or a Better Auth id, bounded before any database or CPU work. */
const OG_USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
/** Same bound the resolver uses; a setter name can be any script, with spaces. */
const OG_SETTER_NAME_MAX_LENGTH = 100;
const CONTROL_CHARACTER = /\p{Cc}/u;

/** The same shape and bound `gymBySlug` and `boardBySlug` enforce: checked before any database or CPU work. */
const OG_PLACE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const OG_PLACE_SLUG_MAX_LENGTH = 120;

/** A setter name a database and a text renderer can both take. Any script, any spacing, no control characters. */
function isAcceptableSetterName(username: string | null): username is string {
  return !!username && username.length <= OG_SETTER_NAME_MAX_LENGTH && !CONTROL_CHARACTER.test(username);
}

/**
 * The one "no card" answer. Missing, private, ended and refused all answer this,
 * byte for byte, with `no-store`: anything else would say which ids are real.
 */
const NOT_FOUND_BODY = JSON.stringify({ error: 'Not found' });

function sendNotFound(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(404, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(NOT_FOUND_BODY),
    'Cache-Control': 'no-store',
  });
  res.end(req.method === 'HEAD' ? undefined : NOT_FOUND_BODY);
}

function sendSaturated(req: IncomingMessage, res: ServerResponse, message: string): void {
  res.writeHead(503, {
    'Content-Type': 'application/json',
    'Retry-After': '5',
    'Cache-Control': 'no-store',
  });
  res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ error: message }));
}

function sendJson(req: IncomingMessage, res: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(encoded),
    'Cache-Control': 'no-store',
  });
  res.end(req.method === 'HEAD' ? undefined : encoded);
}

/** Applies the IP and peer limits. Returns false when the response has been sent. */
async function passRateLimit(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  try {
    await checkRateLimitRedis(getPublicClientIp(req), 'og-family', RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
    await checkRateLimitRedis(
      req.socket.remoteAddress || 'unknown',
      'og-family-peer',
      SOCKET_RATE_LIMIT_MAX,
      RATE_LIMIT_WINDOW_MS,
    );
    return true;
  } catch (error) {
    if (error instanceof RateLimitError) {
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'Retry-After': String(error.retryAfterSeconds),
        'Cache-Control': 'no-store',
      });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ error: 'Rate limit exceeded' }));
      return false;
    }
    throw error;
  }
}

/** Shared path after a surface has validated its params: load, gate, render, answer. */
async function serveOgFamilyCard(
  req: IncomingMessage,
  res: ServerResponse,
  surface: 'playlist' | 'session-join' | 'session-recap' | 'profile' | 'setter' | 'place-gym' | 'place-board',
  load: () => Promise<LoadedOgFamilyCard | null>,
): Promise<void> {
  if (!(await passRateLimit(req, res))) return;

  // The gate runs here, inside the loader, before the byte cache is touched:
  // the cache is keyed on the drawn data, so a card that went private must never
  // find its old bytes. Nothing below runs for a refused request.
  let card: LoadedOgFamilyCard | null;
  try {
    card = await load();
  } catch (error) {
    if (error instanceof OgFamilyNotFoundError) {
      sendNotFound(req, res);
      return;
    }
    if (error instanceof CardReadsSaturatedError || error instanceof PlacePhotoTemporarilyUnavailableError) {
      sendSaturated(req, res, error.message);
      return;
    }
    logger.error('[OGFamily] load failed:', error);
    sendJson(req, res, 500, { error: 'Render failed' });
    return;
  }
  if (!card) {
    sendNotFound(req, res);
    return;
  }

  // A card with no board art needs no WASM, so a renderer that failed to boot
  // must not 503 it. Same reasoning as the spray branch in `/og/climb`.
  if (card.art && !(await ensureBoardRendererAvailable())) {
    sendJson(req, res, 503, { error: 'Board renderer unavailable' });
    return;
  }

  const totalT0 = performance.now();
  try {
    const { buffer, contentType, cache, timings } = await renderOgFamilyArt({
      cacheKey: buildOgFamilyByteKey(surface, card.digest),
      art: card.art,
      photo: card.photo,
      content: card.content,
    });
    const totalMs = performance.now() - totalT0;
    const serverTiming = [
      `total;dur=${totalMs.toFixed(1)}`,
      `wasm;dur=${timings.wasmMs.toFixed(1)}`,
      `plane;dur=${timings.planeMs.toFixed(1)}`,
      `compose;dur=${timings.composeMs.toFixed(1)}`,
      `cache;desc=${cache}`,
    ].join(', ');

    const { 'Vercel-CDN-Cache-Control': _vercelOnlyHeader, ...headers } = createPrivateOgImageHeaders({
      contentType,
      serverTiming,
    });
    res.writeHead(200, {
      ...headers,
      'Content-Length': buffer.length,
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : buffer);

    const logPayload = {
      surface,
      cache,
      totalMs: Math.round(totalMs),
      wasmMs: Math.round(timings.wasmMs),
      bytes: buffer.length,
    };
    if (totalMs > SLOW_RENDER_MS) logger.warn('[OGFamily] served (slow)', logPayload);
    else logger.info('[OGFamily] served', logPayload);
  } catch (error) {
    if (error instanceof RenderQueueSaturatedError) {
      sendSaturated(req, res, error.message);
      return;
    }
    logger.error('[OGFamily] render failed:', error);
    sendJson(req, res, 500, { error: 'Render failed' });
  }
}

/** GET/HEAD/OPTIONS /og/playlist?uuid=… */
export async function handleOgPlaylist(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (!applyCorsHeaders(req, res)) return;
  const playlistId = url.searchParams.get('uuid');
  if (!playlistId || !OG_RESOURCE_ID_PATTERN.test(playlistId)) {
    sendNotFound(req, res);
    return;
  }
  await serveOgFamilyCard(req, res, 'playlist', () => loadPlaylistCard(playlistId, OG_FAMILY_FONT_FAMILY));
}

/**
 * GET/HEAD/OPTIONS /og/session?sessionId=…[&variant=join]
 *
 * No variant is the recap. `variant=join` is the invite, and an invite for a
 * session that ended tells the truth by serving the recap instead of saying Join;
 * no recap to serve (nothing visible logged) is the same 404 as a missing session.
 * Any other variant is a 404, so a typo cannot be used to probe an id.
 */
export async function handleOgSession(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (!applyCorsHeaders(req, res)) return;
  const sessionId = url.searchParams.get('sessionId');
  const variant = url.searchParams.get('variant');
  if (!sessionId || !OG_RESOURCE_ID_PATTERN.test(sessionId) || (variant !== null && variant !== 'join')) {
    sendNotFound(req, res);
    return;
  }
  if (variant === 'join') {
    await serveOgFamilyCard(req, res, 'session-join', async () => {
      const invite = await loadSessionJoinCard(sessionId, OG_FAMILY_FONT_FAMILY);
      return invite ?? loadSessionRecapCard(sessionId, OG_FAMILY_FONT_FAMILY);
    });
    return;
  }
  await serveOgFamilyCard(req, res, 'session-recap', () => loadSessionRecapCard(sessionId, OG_FAMILY_FONT_FAMILY));
}

/** GET/HEAD/OPTIONS /og/profile?user_id=… */
export async function handleOgProfile(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (!applyCorsHeaders(req, res)) return;
  const userId = url.searchParams.get('user_id');
  if (!userId || !OG_USER_ID_PATTERN.test(userId)) {
    sendNotFound(req, res);
    return;
  }
  await serveOgFamilyCard(req, res, 'profile', () => loadProfileCard(userId, OG_FAMILY_FONT_FAMILY));
}

/** GET/HEAD/OPTIONS /og/setter?username=… */
export async function handleOgSetter(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (!applyCorsHeaders(req, res)) return;
  const username = url.searchParams.get('username');
  if (!isAcceptableSetterName(username)) {
    sendNotFound(req, res);
    return;
  }
  await serveOgFamilyCard(req, res, 'setter', () => loadSetterCard(username, OG_FAMILY_FONT_FAMILY));
}

/**
 * GET/HEAD/OPTIONS /og/place?kind=gym|board&slug=…
 *
 * A place is reached by its public slug and nothing else: no token or uuid is
 * accepted, so a share link never carries an invite and nothing here can log one.
 */
export async function handleOgPlace(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (!applyCorsHeaders(req, res)) return;
  const kind = url.searchParams.get('kind');
  const slug = url.searchParams.get('slug');
  if (
    (kind !== 'gym' && kind !== 'board') ||
    !slug ||
    slug.length > OG_PLACE_SLUG_MAX_LENGTH ||
    !OG_PLACE_SLUG_PATTERN.test(slug)
  ) {
    sendNotFound(req, res);
    return;
  }
  if (kind === 'gym') {
    await serveOgFamilyCard(req, res, 'place-gym', () => loadGymPlaceCard(slug, OG_FAMILY_FONT_FAMILY));
    return;
  }
  await serveOgFamilyCard(req, res, 'place-board', () => loadBoardPlaceCard(slug, OG_FAMILY_FONT_FAMILY));
}
