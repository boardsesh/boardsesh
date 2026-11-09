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
/** Fits a 12 MP phone photo. Refuses a decompression bomb before sharp allocates it. */
const AVATAR_MAX_INPUT_PIXELS = 13_000_000;
/** Decode work stays bounded even for a file that passes every check above. */
const AVATAR_DECODE_TIMEOUT_SECONDS = 2;
/** Twice the drawn size, so the circle stays crisp on a retina chat preview. */
const AVATAR_RASTER_PX = 160;
const AVATAR_TTL_MS = 10 * 60_000;
const AVATAR_CACHE_ENTRIES = 256;

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

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * JPEG, PNG or WebP by their first bytes. Sharp sees nothing else: it would
 * happily open SVG, which can reference other resources, and its long list of
 * decoders is more attack surface than a profile picture needs. A content type
 * proves nothing, because the server sending it chose it.
 */
export function isDecodableAvatarBytes(bytes: Buffer): boolean {
  const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isPng = bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
  const isWebp =
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP';
  return isJpeg || isPng || isWebp;
}

/**
 * Decode fetched bytes into the small square the card draws. Null for anything
 * that is not one of the formats allowed here, before sharp sees it.
 * @throws when sharp cannot decode the bytes or they break the pixel or time limit.
 */
export async function decodeCardAvatar(bytes: Buffer): Promise<CardAvatar | null> {
  if (!isDecodableAvatarBytes(bytes)) return null;
  const png = await sharp(bytes, { limitInputPixels: AVATAR_MAX_INPUT_PIXELS, failOn: 'error', pages: 1 })
    .timeout({ seconds: AVATAR_DECODE_TIMEOUT_SECONDS })
    .rotate()
    .resize(AVATAR_RASTER_PX, AVATAR_RASTER_PX, { fit: 'cover' })
    .png()
    .toBuffer();
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
