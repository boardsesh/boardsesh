import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { fetchAllowedImage, UnsafeImageHostError } from '../../lib/safe-image-fetch';
import { staticPathToMediaRedirect, VERSION_QUERY_PARAM } from '../../lib/media-url';
import { getMediaPublicBaseUrl } from '../../storage/s3';
import { logger } from '../../utils/logger';
import { PostGateCache } from './post-gate-cache';

/** A slow CDN must cost a share card a beat, not its render budget. */
const AVATAR_FETCH_TIMEOUT_MS = 1_500;
/** Avatar uploads are capped at 2 MB; a little headroom for the formats Google serves. */
const AVATAR_MAX_BYTES = 3 * 1024 * 1024;
/** Refuses a decompression bomb before sharp allocates it. */
const AVATAR_MAX_INPUT_PIXELS = 24_000_000;
/** Twice the drawn size, so the circle stays crisp on a retina chat preview. */
const AVATAR_RASTER_PX = 160;
const AVATAR_TTL_MS = 10 * 60_000;
const AVATAR_CACHE_ENTRIES = 256;

/** Formats sharp may decode here. SVG is out on purpose: it can reference other resources. */
const DECODABLE_AVATAR_FORMATS = new Set(['jpeg', 'png', 'webp', 'gif']);

/** The hostname this backend is reachable at, in absolute avatar URLs stored on old rows. */
const OWN_BACKEND_HOST = 'ws.boardsesh.com';
const STATIC_AVATAR_PREFIX = '/static/avatars/';

export type CardAvatar = { png: Buffer; digest: string };

const avatarCache = new PostGateCache<CardAvatar | null>({
  ttlMs: AVATAR_TTL_MS,
  maxEntries: AVATAR_CACHE_ENTRIES,
});

/** Test seam: process-lifetime cache. */
export function resetAvatarCache(): void {
  avatarCache.clear();
}

/**
 * Where to fetch a stored `avatarUrl` from, or null when it cannot be fetched.
 *
 * Rows store `/static/avatars/<file>?v=…`, backend-relative, which only ever
 * means this service's own route. That route 302s to the media CDN, so go to the
 * CDN directly instead of making a request to ourselves. Absolute URLs pass
 * through and are judged by the host allowlist.
 */
export function resolveAvatarFetchUrl(avatarUrl: string, mediaBaseUrl: string | null): string | null {
  const trimmed = avatarUrl.trim();
  if (trimmed === '') return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed, `https://${OWN_BACKEND_HOST}`);
  } catch {
    return null;
  }
  if (parsed.hostname !== OWN_BACKEND_HOST || !parsed.pathname.startsWith(STATIC_AVATAR_PREFIX)) {
    return trimmed.startsWith('/') ? null : parsed.href;
  }
  if (!mediaBaseUrl) return null;
  // Only the version is carried across: `?size=` is a backend resize instruction
  // and the original is what a share card wants to decode.
  const search = new URLSearchParams();
  const version = parsed.searchParams.get(VERSION_QUERY_PARAM);
  if (version) search.set(VERSION_QUERY_PARAM, version);
  return staticPathToMediaRedirect(parsed.pathname, search, mediaBaseUrl);
}

/**
 * Decode fetched bytes into the small square the card draws. Null for anything
 * that is not one of the formats allowed here, whatever its content type claimed.
 * @throws when sharp cannot decode the bytes.
 */
export async function decodeCardAvatar(bytes: Buffer): Promise<CardAvatar | null> {
  const image = sharp(bytes, { limitInputPixels: AVATAR_MAX_INPUT_PIXELS, failOn: 'error' });
  const metadata = await image.metadata();
  if (!metadata.format || !DECODABLE_AVATAR_FORMATS.has(metadata.format)) return null;
  const png = await image.rotate().resize(AVATAR_RASTER_PX, AVATAR_RASTER_PX, { fit: 'cover' }).png().toBuffer();
  return { png, digest: createHash('sha256').update(png).digest('base64url').slice(0, 24) };
}

async function readAvatar(avatarUrl: string): Promise<CardAvatar | null> {
  const fetchUrl = resolveAvatarFetchUrl(avatarUrl, getMediaPublicBaseUrl());
  if (!fetchUrl) return null;
  try {
    const bytes = await fetchAllowedImage(fetchUrl, 'avatar', {
      timeoutMs: AVATAR_FETCH_TIMEOUT_MS,
      maxBytes: AVATAR_MAX_BYTES,
    });
    return await decodeCardAvatar(bytes);
  } catch (error) {
    // Expected for a dead link or a bad upload, and always survivable: the card
    // draws the monogram. Only the host goes in the log.
    logger.info('[OGFamily] avatar skipped', {
      reason: error instanceof UnsafeImageHostError ? 'unsafe' : 'fetch-or-decode',
      host: new URL(fetchUrl).hostname,
    });
    return null;
  }
}

/**
 * An avatar ready to draw, or null for "draw the monogram instead". Never throws:
 * a broken picture must not fail the card. Failures are remembered too, so a slow
 * host costs one timeout per link every ten minutes rather than one per request.
 */
export function loadCardAvatar(avatarUrl: string | null | undefined): Promise<CardAvatar | null> {
  if (!avatarUrl) return Promise.resolve(null);
  return avatarCache.read(avatarUrl, () => readAvatar(avatarUrl));
}
