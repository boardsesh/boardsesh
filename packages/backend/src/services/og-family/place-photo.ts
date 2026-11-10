import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { ogFamilyBoardBox } from '@boardsesh/board-render/og-family';
import { IDENTITY_HOMOGRAPHY, invert, type Homography } from '@boardsesh/spray-wall-geometry';
import { fetchAllowedImage, TransientImageFetchError, UnsafeImageHostError } from '../../lib/safe-image-fetch';
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
import { CardReadsSaturatedError, runPhotoRead } from './card-read-limit';
import { isDecodableAvatarBytes } from './load-avatar';
import { PostGateCache } from './post-gate-cache';

/** A gym has board art to fall back to, so a slow CDN costs its card a beat and no more. */
const GYM_PHOTO_FETCH_TIMEOUT_MS = 2_500;
/** A wall has nothing else to draw. The deadline the wall's climb card already uses. */
const WALL_PHOTO_FETCH_TIMEOUT_MS = 8_000;
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

/** The photo could not be read just now. Answered, never remembered: the next request tries again. */
export class PlacePhotoTemporarilyUnavailableError extends Error {
  constructor() {
    super('Photo temporarily unavailable');
    this.name = 'PlacePhotoTemporarilyUnavailableError';
  }
}

function isTransientFetchFailure(error: unknown): boolean {
  return error instanceof TransientImageFetchError || !(error instanceof UnsafeImageHostError);
}

/**
 * The photo's bytes, or null when the answer is final: a refused host, a 404, a
 * response that was not an image.
 * @throws PlacePhotoTemporarilyUnavailableError for a timeout, a dropped
 * connection or a server error.
 */
async function fetchPhotoBytes(fetchUrl: string, timeoutMs: number): Promise<Buffer | null> {
  try {
    return await fetchAllowedImage(fetchUrl, 'place-photo', { timeoutMs, maxBytes: PHOTO_MAX_BYTES });
  } catch (error) {
    // Expected for a dead link or a bad upload. Only the host goes in the log.
    logger.info('[OGFamily] place photo not fetched', {
      reason: isTransientFetchFailure(error) ? 'transient' : 'refused',
      host: new URL(fetchUrl).hostname,
    });
    if (isTransientFetchFailure(error)) throw new PlacePhotoTemporarilyUnavailableError();
    return null;
  }
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
  const bytes = await fetchPhotoBytes(fetchUrl, GYM_PHOTO_FETCH_TIMEOUT_MS);
  if (!bytes) return null;
  try {
    return await decodeGymPhoto(bytes);
  } catch {
    logger.info('[OGFamily] gym photo could not be decoded', { host: new URL(fetchUrl).hostname });
    return null;
  }
}

/**
 * A gym's photo ready to draw, or null for "draw the board instead". Never throws:
 * a broken photo must not fail the card. Called only after the gym's gate passed.
 * A photo that is final-answer bad is remembered for ten minutes. A timeout or a
 * full photo queue is not, so the gym gets its photo back on the next request.
 */
export async function loadGymPhoto(imageUrl: string | null | undefined): Promise<OgFamilyPhotoArt | null> {
  if (!imageUrl) return null;
  try {
    return await gymPhotoCache.read(imageUrl, () => runPhotoRead(() => readGymPhoto(imageUrl)));
  } catch (error) {
    if (error instanceof PlacePhotoTemporarilyUnavailableError || error instanceof CardReadsSaturatedError) return null;
    throw error;
  }
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
 * The caller runs this under the photo cap.
 *
 * `fit: 'inside'` as `spray-og-card.ts` does: a wall is photographed at whatever
 * aspect the climber's phone produced, and cropping it would cut off the wall the
 * card is meant to show. Null when the object is gone or undecodable: a wall has
 * no board art to fall back to, and "a wall with no usable photo" is the same
 * answer as the gates above.
 * @throws PlacePhotoTemporarilyUnavailableError when the photo may read fine in a moment.
 */
export async function renderSprayWallPhoto(params: {
  photoUrl: string;
  version: SprayOgVersionRow;
  holds: readonly SprayOgHold[];
  frames: string;
}): Promise<OgFamilyPhotoArt | null> {
  const { photoUrl, version, holds, frames } = params;
  const box = ogFamilyBoardBox('full');
  const bytes = await fetchPhotoBytes(photoUrl, WALL_PHOTO_FETCH_TIMEOUT_MS);
  if (!bytes || !isDecodableAvatarBytes(bytes)) return null;
  try {
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
  } catch {
    logger.info('[OGFamily] wall photo could not be decoded', { host: new URL(photoUrl).hostname });
    return null;
  }
}
