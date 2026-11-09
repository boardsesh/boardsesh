import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { ogFamilyBoardBox } from '@boardsesh/board-render/og-family';
import { IDENTITY_HOMOGRAPHY, invert, type Homography } from '@boardsesh/spray-wall-geometry';
import { fetchAllowedImage, UnsafeImageHostError } from '../../lib/safe-image-fetch';
import { staticPathToMediaRedirect, VERSION_QUERY_PARAM } from '../../lib/media-url';
import { getMediaPublicBaseUrl } from '../../storage/s3';
import { logger } from '../../utils/logger';
import {
  buildSprayOverlayMarks,
  buildSprayOverlaySvg,
  type SprayOgHold,
  type SprayOgVersionRow,
  type SprayOverlayMark,
} from '../spray-og-card';
import type { OgFamilyPhotoArt } from '../board-render';
import { isDecodableAvatarBytes } from './load-avatar';
import { PostGateCache } from './post-gate-cache';

/** A slow CDN must cost a share card a beat, not its render budget. */
const PHOTO_FETCH_TIMEOUT_MS = 2_500;
/** Above the largest gym photo and wall photo an upload can store. */
const PHOTO_MAX_BYTES = 12 * 1024 * 1024;
/** Fits the 24 MP wall photo the app may send. Refuses a decompression bomb before sharp allocates it. */
const PHOTO_MAX_INPUT_PIXELS = 25_000_000;
/** Decode work stays bounded even for a file that passes every check above. */
const PHOTO_DECODE_TIMEOUT_SECONDS = 3;
const PHOTO_JPEG_QUALITY = 88;
const GYM_PHOTO_TTL_MS = 10 * 60_000;
const GYM_PHOTO_CACHE_ENTRIES = 48;

const STATIC_GYM_PHOTO_PREFIX = '/static/gym-photos/';
/** Rows are backend-relative; this only exists to parse them. */
const ANY_ORIGIN = 'https://boardsesh.invalid';

const NO_LIT_HOLDS: OgFamilyPhotoArt['bokeh'] = { points: [], source: { w: 1200, h: 630 } };

const gymPhotoCache = new PostGateCache<OgFamilyPhotoArt | null>({
  ttlMs: GYM_PHOTO_TTL_MS,
  maxEntries: GYM_PHOTO_CACHE_ENTRIES,
});

/** Test seam: process-lifetime cache. */
export function resetPlacePhotoCache(): void {
  gymPhotoCache.clear();
}

/**
 * Where to fetch a gym's stored photo from, or null when it cannot be fetched.
 * `GymPhotoUrlSchema` only lets `/static/gym-photos/…` onto a row, so that is the
 * only shape read here; the media CDN is the object it redirects to.
 */
export function resolveGymPhotoFetchUrl(imageUrl: string, mediaBaseUrl: string | null): string | null {
  if (!mediaBaseUrl || !imageUrl.startsWith(STATIC_GYM_PHOTO_PREFIX)) return null;
  let parsed: URL;
  try {
    parsed = new URL(imageUrl, ANY_ORIGIN);
  } catch {
    return null;
  }
  const search = new URLSearchParams();
  const version = parsed.searchParams.get(VERSION_QUERY_PARAM);
  if (version) search.set(VERSION_QUERY_PARAM, version);
  return staticPathToMediaRedirect(parsed.pathname, search, mediaBaseUrl);
}

function openPhoto(bytes: Buffer): sharp.Sharp {
  return sharp(bytes, { limitInputPixels: PHOTO_MAX_INPUT_PIXELS, failOn: 'error', pages: 1 }).timeout({
    seconds: PHOTO_DECODE_TIMEOUT_SECONDS,
  });
}

function digestImage(image: Buffer): string {
  return createHash('sha256').update(image).digest('base64url').slice(0, 24);
}

/**
 * Crop fetched bytes to the art slot. Null for anything that is not one of the
 * formats allowed here, before sharp sees it.
 * @throws when sharp cannot decode the bytes or they break the pixel or time limit.
 */
export async function decodeGymPhoto(bytes: Buffer): Promise<OgFamilyPhotoArt | null> {
  if (!isDecodableAvatarBytes(bytes)) return null;
  const { width, height } = ogFamilyBoardBox('full');
  const image = await openPhoto(bytes)
    .rotate()
    .resize(width, height, { fit: 'cover' })
    .jpeg({ quality: PHOTO_JPEG_QUALITY })
    .toBuffer();
  return { image, width, height, digest: digestImage(image), bokeh: NO_LIT_HOLDS };
}

async function readGymPhoto(imageUrl: string): Promise<OgFamilyPhotoArt | null> {
  const fetchUrl = resolveGymPhotoFetchUrl(imageUrl, getMediaPublicBaseUrl());
  if (!fetchUrl) return null;
  try {
    const bytes = await fetchAllowedImage(fetchUrl, 'place-photo', {
      timeoutMs: PHOTO_FETCH_TIMEOUT_MS,
      maxBytes: PHOTO_MAX_BYTES,
    });
    return await decodeGymPhoto(bytes);
  } catch (error) {
    // Expected for a dead link or a bad upload, and always survivable: the card
    // draws the board instead. Only the host goes in the log.
    logger.info('[OGFamily] gym photo skipped', {
      reason: error instanceof UnsafeImageHostError ? 'unsafe' : 'fetch-or-decode',
      host: new URL(fetchUrl).hostname,
    });
    return null;
  }
}

/**
 * A gym's photo ready to draw, or null for "draw the board instead". Never throws:
 * a broken photo must not fail the card. Called only after the gym's gate passed.
 * Failures are remembered too, so a dead link costs one timeout every ten minutes.
 */
export function loadGymPhoto(
  imageUrl: string | null | undefined,
  withReadCap: <T>(read: () => Promise<T>) => Promise<T>,
): Promise<OgFamilyPhotoArt | null> {
  if (!imageUrl) return Promise.resolve(null);
  return gymPhotoCache.read(imageUrl, () => withReadCap(() => readGymPhoto(imageUrl)));
}

/** A singular matrix leaves the photo without its holds rather than breaking a shared link. */
function canonicalToPhotoMatrix(version: SprayOgVersionRow): Homography | null {
  try {
    return invert(version.homography ?? IDENTITY_HOMOGRAPHY);
  } catch {
    return null;
  }
}

/**
 * Fetch and draw one wall's public photo, climb on top, sized to fit the art slot.
 *
 * `fit: 'inside'` as `spray-og-card.ts` does: a wall is photographed at whatever
 * aspect the climber's phone produced, and cropping it would cut off the wall the
 * card is meant to show. Null when the photo cannot be read or decoded: a wall has
 * no board art to fall back to, and "a wall with no usable photo" is the same
 * answer as the gates above.
 */
export async function renderSprayWallPhoto(params: {
  photoUrl: string;
  version: SprayOgVersionRow;
  holds: readonly SprayOgHold[];
  frames: string;
}): Promise<OgFamilyPhotoArt | null> {
  const { photoUrl, version, holds, frames } = params;
  const box = ogFamilyBoardBox('full');
  try {
    const bytes = await fetchAllowedImage(photoUrl, 'place-photo', {
      timeoutMs: PHOTO_FETCH_TIMEOUT_MS,
      maxBytes: PHOTO_MAX_BYTES,
    });
    if (!isDecodableAvatarBytes(bytes)) return null;

    const source = openPhoto(bytes);
    const [metadata, placed] = await Promise.all([
      source.metadata(),
      source.clone().rotate().resize({ width: box.width, height: box.height, fit: 'inside' }).toBuffer({
        resolveWithObject: true,
      }),
    ]);
    const { width, height } = placed.info;
    // The version row records the object's real pixel frame, EXIF rotation baked
    // in. The decoded size is the fallback for a row from before that column.
    const photoWidth = version.photoWidth ?? metadata.width ?? width;
    const canonicalToPhoto = canonicalToPhotoMatrix(version);
    const marks: SprayOverlayMark[] = canonicalToPhoto
      ? buildSprayOverlayMarks({
          holds,
          frames,
          canonicalToPhoto,
          photoToPlaced: photoWidth > 0 ? width / photoWidth : 1,
        })
      : [];

    const drawn = sharp(placed.data);
    if (marks.length > 0) {
      drawn.composite([{ input: Buffer.from(buildSprayOverlaySvg({ width, height, marks })), left: 0, top: 0 }]);
    }
    const image = await drawn.jpeg({ quality: PHOTO_JPEG_QUALITY }).toBuffer();
    return {
      image,
      width,
      height,
      digest: digestImage(image),
      bokeh: {
        points: marks.map((mark) => ({ x: mark.centerX, y: mark.centerY, color: mark.color })),
        source: { w: width, h: height },
      },
    };
  } catch (error) {
    logger.info('[OGFamily] wall photo skipped', {
      reason: error instanceof UnsafeImageHostError ? 'unsafe' : 'fetch-or-decode',
      host: new URL(photoUrl).hostname,
    });
    return null;
  }
}
