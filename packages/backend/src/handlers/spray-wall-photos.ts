import type { IncomingMessage, ServerResponse } from 'http';
import { randomBytes, randomUUID } from 'crypto';
import Busboy from 'busboy';
import sharp from 'sharp';
import { and, eq, isNull } from 'drizzle-orm';
import { sprayWallPhotoMaxLongSide } from '@boardsesh/spray-wall-geometry';
import { SPRAY_WALL_ARCHIVED_CODE, SPRAY_WALL_ARCHIVED_MESSAGE } from '../services/spray-wall-archive';
import * as dbSchema from '@boardsesh/db/schema';
import { applyCorsHeaders } from './cors';
import { guardUploadFileStream } from './http-utils';
import {
  detectImageMimeType,
  extractAuthTokenFromHeader,
  formatByteCapForMessage,
  validateGymUuid as isWellFormedUuid,
} from './gym-image-upload';
import { validateToken } from '../middleware/auth';
import { deleteFromS3, isS3Configured, uploadToS3 } from '../storage/s3';
import { writeImageVariants } from '../lib/image-resize';
import { db } from '../db/client';
import { logger } from '../utils/logger';
import { markDeletedSprayWallPhotoRetry } from '../services/spray-photo-erasure-retry';

/**
 * POST /api/spray-wall-photos — the one way a photograph of somebody's wall
 * enters Boardsesh.
 *
 * Cloned from `createGymImageUploadHandler` (`handlers/gym-image-upload.ts`) and
 * then narrowed in three ways that all come from the same fact — **this is a
 * picture of the inside of someone's home**:
 *
 *  1. **The `private` bucket, never `media`.** `media` is world-readable under
 *     guessable keys (`docs/user-media-storage.md`), so a wall photo there is
 *     public the moment anyone guesses a uuid. Reads go through 15-minute
 *     presigned URLs instead (`presignGetObject`).
 *  2. **No local-dev disk fallback.** The gym handlers write to `./gym-photos`
 *     and serve it from `/static/...` when S3 is off; doing that here would put
 *     a home photo on an unauthenticated route. Without the private bucket
 *     configured this endpoint answers 501 in EVERY environment, which is the
 *     `user-data-export` precedent for the same bucket.
 *  3. **Every byte is re-encoded through sharp.** `rotate()` bakes in the EXIF
 *     orientation and then re-encoding drops the metadata block wholesale —
 *     including the GPS tags a phone camera writes, which on a home wall is the
 *     owner's street address. sharp strips metadata by default on encode; the
 *     explicit format call is what guarantees an encode actually happens.
 *
 * Multipart form data:
 *  - `photo`: the image
 *  - `wallUuid`: the wall (the `user_boards` uuid) the photo belongs to
 *
 * Two sizes are stored (#5911). The BASE is at most
 * {@link SPRAY_WALL_PHOTO_BASE_MAX_DIMENSION} px on its long side: it is what the
 * canonical frame, the hold detector and the climb view read, and its size is
 * the one the response and the object metadata carry. A source larger than that
 * also gets a FULL copy (`sprayWallFullPhotoKey`) that only the hold editor
 * loads once it zooms past the base's resolution. Its size follows the rule the
 * app uploads by (`sprayWallPhotoMaxLongSide` in `@boardsesh/spray-wall-geometry`):
 * at most 5712 px on the long side (`SPRAY_WALL_PHOTO_MAX_LONG_SIDE`), a 24 MP
 * phone photo, and at most 24.5 MP, so a square photo stops at 4946 px and a
 * decoded copy stays under the 100 MiB Android will draw.
 *
 * Returns `{ success, photoId, width, height }`. The photo sits in the bucket
 * unreferenced until `createSprayWallVersion(wallUuid, photoId)` adopts it as a
 * draft version — an abandoned upload is a stray object the SW-17 cleanup job
 * sweeps, not a row anybody can see.
 */

/**
 * 25MB. The app sends up to a 24 MP photo (5712 x 4284) at JPEG 0.92. Twenty
 * indoor-wall photos from Wikimedia Commons, resized the way the app does, came
 * to 1.2-4.0MB at libjpeg quality 92, and at most 12.3MB (scaled to the full
 * 24.5 MP) at quality 97 with full-resolution colour, the most an iPhone's
 * encoder could plausibly write. A dim, noisy gym photo compresses worse than
 * those, and pure noise at quality 92 is 20.4MB, so 15MB (the cap at 4096 px)
 * left too little room. Stored copies are re-encoded below, so the cap bounds
 * one POST's transfer and buffer, not what the bucket keeps.
 */
export const SPRAY_WALL_PHOTO_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Long-side cap for the BASE photo. The canonical frame, the detector and every
 * renderer except the zoomed hold editor read this one, and its size is what the
 * object metadata records — so every wall keeps the pixel scale it had before
 * full-resolution copies existed.
 */
export const SPRAY_WALL_PHOTO_BASE_MAX_DIMENSION = 2048;

// Per-user upload budget, copied from `handlers/feedback-screenshots.ts` and for
// the same reason: every POST here mints a NEW object (the key carries a fresh
// uuid), so without a budget one authenticated account can fill the private
// bucket with objects, and an abandoned upload is never referenced by a row
// so nothing else bounds it either. `MAX_VERSIONS_PER_WALL` does not help — it
// caps the rows, not the uploads that never become one.
//
// A fixed window per process is deliberately coarse: a spam ceiling, not a
// fairness mechanism. The real ceiling is 20 x the instance count and it resets
// on deploy, which is accepted here rather than reaching for Redis, exactly as
// the screenshot handler argues. `applyRateLimit`, the two-tier limiter the
// resolvers use, is not reachable from a REST handler — it keys off the GraphQL
// connection context.
const RATE_LIMIT_MAX_UPLOADS = 20;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
/** Prune only once the map is big enough to matter, so the common path is O(1). */
const RATE_LIMIT_PRUNE_AT_ENTRIES = 1000;

const uploadWindows = new Map<string, { count: number; windowStart: number }>();

/**
 * Clear the in-process upload counters. Test seam — the window is module state,
 * so a test that exhausts it needs this between cases.
 */
export function resetSprayWallPhotoRateLimit(): void {
  uploadWindows.clear();
}

/**
 * Record one upload attempt for `userId`, returning false once the window's
 * budget is spent. Failed uploads count too: a rejected request still costs a
 * multipart parse and a sharp decode, which is exactly what a spammer would loop
 * on.
 */
function consumeUploadBudget(userId: string): boolean {
  const now = Date.now();

  if (uploadWindows.size >= RATE_LIMIT_PRUNE_AT_ENTRIES) {
    for (const [countedUserId, expiredCandidate] of uploadWindows) {
      if (now - expiredCandidate.windowStart >= RATE_LIMIT_WINDOW_MS) uploadWindows.delete(countedUserId);
    }
  }

  const userWindow = uploadWindows.get(userId);
  if (!userWindow || now - userWindow.windowStart >= RATE_LIMIT_WINDOW_MS) {
    uploadWindows.set(userId, { count: 1, windowStart: now });
    return true;
  }
  if (userWindow.count >= RATE_LIMIT_MAX_UPLOADS) return false;
  userWindow.count += 1;
  return true;
}

/**
 * What a wall photo may arrive as.
 *
 * Deliberately narrower than `GYM_IMAGE_ALLOWED_MIME_TYPES`: GIF is dropped
 * because an animated spray wall is not a thing, and dropping it removes the
 * whole animated-re-encode question from the sharp step.
 */
export const SPRAY_WALL_PHOTO_ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * Every stored wall photo is JPEG, whatever arrived.
 *
 * Two reasons, and the second is the important one. A wall photo is a
 * photograph, so JPEG is the right encoding for it anyway — but normalising also
 * makes the object key a pure function of the photo id
 * (`spray-walls/<wallUuid>/<photoId>.jpg`). `createSprayWallVersion` then
 * resolves the key without probing a set of candidate extensions, and the
 * SW-17 cleanup job can enumerate a wall's objects by prefix with no format
 * matrix to keep in step.
 */
const STORED_CONTENT_TYPE = 'image/jpeg';
const STORED_EXTENSION = 'jpg';

/** Quality for the stored photo. High: the hold editor traces silhouettes on these pixels. */
const STORED_JPEG_QUALITY = 88;

/**
 * `Cache-Control` for every object this handler writes.
 *
 * `uploadToS3` defaults to `public, max-age=31536000, immutable`, which is right
 * for a world-readable avatar and catastrophic here: a browser or any shared
 * cache on the path would keep serving a photograph of somebody's home for a
 * YEAR — long past the 15-minute presign that is supposed to be the access
 * control, and past the owner flipping the wall private or deleting it.
 *
 * `no-store` rather than a short max-age because there is no version of "keep a
 * copy of this for a while" that survives a privacy change. The bytes are fetched
 * once per presign; the saving a cache would buy is not worth a stale copy of
 * someone's living room.
 *
 * **The public-promotion path is the ONLY place a long lifetime may ever be set.**
 * SW-14 (#5447) copies a public wall's photo to the `media` bucket under a random
 * key; that copy is world-readable by intent and can be immutable. Anything
 * writing to `private` uses this.
 */
const PRIVATE_PHOTO_CACHE_CONTROL = 'private, no-store';

/** The object key a wall photo is stored under. The ONE place this shape is written. */
export function sprayWallPhotoKey(wallUuid: string, photoId: string): string {
  return `spray-walls/${wallUuid}/${photoId}.${STORED_EXTENSION}`;
}

const FULL_PHOTO_SUFFIX = `-full.${STORED_EXTENSION}`;

/**
 * The key of a photo's full-resolution copy, derived from the base key.
 *
 * Derived rather than stored: the version row names only the base
 * (`photo_key`), so every path that already follows the base — a
 * `sourceVersionId` copy reuses the same key, the purge deletes the wall's whole
 * prefix — follows the full copy with no new column. It sits under the same
 * `spray-walls/<wallUuid>/` prefix for exactly that reason.
 */
export function sprayWallFullPhotoKey(basePhotoKey: string): string {
  const extension = `.${STORED_EXTENSION}`;
  const stem = basePhotoKey.endsWith(extension) ? basePhotoKey.slice(0, -extension.length) : basePhotoKey;
  return `${stem}${FULL_PHOTO_SUFFIX}`;
}

/**
 * Whether a stored base of this size can have a full copy beside it.
 *
 * A full copy is only written when the source was larger than the base cap, and
 * then the base is resized to EXACTLY the cap on its long side. So any other
 * base size proves there is no full copy without asking storage. The converse
 * does not hold: a source that was already exactly the cap (every photo the app
 * compressed to 2048 px before #5911) has a base of that size and no full copy.
 */
export function sprayWallPhotoMayHaveFullCopy(width: number | null, height: number | null): boolean {
  if (width == null || height == null) return false;
  return Math.max(width, height) === SPRAY_WALL_PHOTO_BASE_MAX_DIMENSION;
}

/**
 * The key a PUBLIC wall's photo copy is stored under in the `media` bucket.
 *
 * Random, not derived: `media` is world-readable under guessable keys, so a key
 * anybody could reconstruct from the wall uuid would keep serving the photo of
 * somebody's garage after they made the wall private again — the object would be
 * gone, but the URL every cache and screenshot holds would resolve again on the
 * next promotion. 128 random bits make a demotion a real one, and a
 * re-promotion a URL nobody has seen (SW-14).
 */
export function sprayWallPublicPhotoKey(wallUuid: string): string {
  return `spray-walls/${wallUuid}/${randomBytes(16).toString('hex')}.${STORED_EXTENSION}`;
}

/** What every stored wall photo is: the upload handler re-encodes to JPEG. */
export const SPRAY_PHOTO_CONTENT_TYPE = STORED_CONTENT_TYPE;

/** Object-metadata keys carrying the decoded pixel size. Read back by `createSprayWallVersion`. */
export const SPRAY_PHOTO_WIDTH_METADATA_KEY = 'width';
export const SPRAY_PHOTO_HEIGHT_METADATA_KEY = 'height';

function respondJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

type EncodedWallPhoto = { body: Buffer; width: number; height: number };

/** Orient, shrink to fit `maxDimension` (never enlarge) and re-encode one stored size. */
async function encodeWallPhoto(input: Buffer, maxDimension: number): Promise<EncodedWallPhoto> {
  const pipeline = sharp(input)
    .rotate()
    .resize({ width: maxDimension, height: maxDimension, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: STORED_JPEG_QUALITY });
  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
  return { body: data, width: info.width, height: info.height };
}

/**
 * Normalise an uploaded photo: apply the EXIF orientation, then re-encode as
 * JPEG so no metadata block survives — for the base and, when the source is
 * larger than the base cap, for the full copy too.
 *
 * Returns the bytes and the dimensions AFTER the rotate, which is the only
 * orientation any later consumer will ever see — anchors are tapped on these
 * pixels, so a width/height read before the rotate would transpose the whole
 * canonical frame on any portrait phone photo.
 *
 * Both sizes are resized from the SOURCE, not the base from the full copy, so the
 * base the detector reads takes one JPEG generation, as it always has.
 */
async function normaliseWallPhoto(input: Buffer): Promise<{ base: EncodedWallPhoto; full: EncodedWallPhoto | null }> {
  // The pixel cap depends only on the shape, so the pre-rotation header size is
  // enough: a quarter turn swaps the sides but not the ratio.
  const { width, height } = await sharp(input).metadata();
  const full = await encodeWallPhoto(input, sprayWallPhotoMaxLongSide(width ?? 0, height ?? 0));
  if (Math.max(full.width, full.height) <= SPRAY_WALL_PHOTO_BASE_MAX_DIMENSION) {
    // Already within the base cap, so the one encode IS the base. No full copy:
    // it would be the same pixels stored twice.
    return { base: full, full: null };
  }
  const base = await encodeWallPhoto(input, SPRAY_WALL_PHOTO_BASE_MAX_DIMENSION);
  return { base, full };
}

/**
 * The wall a photo is being uploaded for, when the caller owns it.
 *
 * Ownership is the whole authorization story on a spray wall (epic decision
 * 2026-09-14: users own a wall and that ownership is what grants editing), so
 * this is deliberately NOT `requireBoardEditAccess` — no gym admin and no
 * community role uploads a photograph of a stranger's living room.
 *
 * An ARCHIVED wall takes no photo: `createSprayWallVersion` would refuse the
 * version, and the upload would be a stray object nothing names. A reset's
 * clone is a separate wall and is never archived, so its wizard uploads as any
 * new wall's does.
 */
async function loadOwnedWall(
  wallUuid: string,
  userId: string,
): Promise<{ outcome: 'ok' } | { outcome: 'not-found' } | { outcome: 'forbidden' } | { outcome: 'archived' }> {
  const [row] = await db
    .select({ ownerId: dbSchema.userBoards.ownerId, archivedAt: dbSchema.sprayWalls.archivedAt })
    .from(dbSchema.sprayWalls)
    .innerJoin(dbSchema.userBoards, eq(dbSchema.userBoards.uuid, dbSchema.sprayWalls.boardUuid))
    .where(
      and(
        eq(dbSchema.sprayWalls.boardUuid, wallUuid),
        isNull(dbSchema.sprayWalls.deletedAt),
        isNull(dbSchema.userBoards.deletedAt),
      ),
    )
    .limit(1);

  if (!row) return { outcome: 'not-found' };
  if (row.ownerId !== userId) return { outcome: 'forbidden' };
  if (row.archivedAt != null) return { outcome: 'archived' };
  return { outcome: 'ok' };
}

export async function handleSprayWallPhotoUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!applyCorsHeaders(req, res)) return;

  const token = extractAuthTokenFromHeader(req);
  if (!token) {
    respondJson(res, 401, { error: 'Authentication required' });
    return;
  }

  const authResult = await validateToken(token);
  if (!authResult) {
    respondJson(res, 401, { error: 'Invalid or expired token' });
    return;
  }
  const authenticatedUserId = authResult.userId;

  // Before the multipart parse and the sharp decode, which are the expensive
  // halves a spammer would loop on.
  if (!consumeUploadBudget(authenticatedUserId)) {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(RATE_LIMIT_WINDOW_MS / 1000) });
    res.end(JSON.stringify({ error: 'Too many wall photo uploads. Try again in a few minutes.' }));
    return;
  }

  // No environment gets a disk fallback — see the module comment. A wall photo
  // either lands in the private bucket or it does not land.
  if (!isS3Configured('private')) {
    logger.error('Spray wall photo upload attempted with no private bucket configured');
    respondJson(res, 501, {
      error: 'Spray wall photo uploads are not configured. Please contact the administrator.',
    });
    return;
  }

  return new Promise<void>((resolve) => {
    let busboy: ReturnType<typeof Busboy>;
    try {
      busboy = Busboy({
        headers: req.headers as { 'content-type': string },
        limits: { fileSize: SPRAY_WALL_PHOTO_MAX_UPLOAD_BYTES, files: 1 },
      });
    } catch {
      respondJson(res, 400, { error: 'Invalid request format' });
      resolve();
      return;
    }

    let wallUuid: string | undefined;
    let fileBuffer: Buffer | undefined;
    let declaredMimeType: string | undefined;
    let fileTruncated = false;
    let invalidMimeType = false;

    busboy.on('field', (name: string, value: string) => {
      if (name === 'wallUuid') wallUuid = value;
    });

    busboy.on('file', (name: string, stream: NodeJS.ReadableStream, info: { mimeType: string }) => {
      // Before every early return: busboy destroys this stream with an error on
      // any truncated part, and an unlistened one exits the process (#5359).
      guardUploadFileStream(stream, { route: req.url ?? '/api/spray-wall-photos', field: name });

      if (name !== 'photo') {
        stream.resume();
        return;
      }

      declaredMimeType = info.mimeType;
      if (!SPRAY_WALL_PHOTO_ALLOWED_MIME_TYPES.includes(declaredMimeType)) {
        invalidMimeType = true;
        stream.resume();
        return;
      }

      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        fileBuffer = Buffer.concat(chunks);
      });
      stream.on('limit', () => {
        fileTruncated = true;
      });
    });

    busboy.on('finish', async () => {
      // The whole block is try/caught: an unhandled rejection inside this
      // detached async listener would escape to the process level AND leave the
      // wrapping Promise unsettled, so the request would hang forever.
      try {
        if (fileTruncated) {
          respondJson(res, 400, {
            error: `File size must be less than ${formatByteCapForMessage(SPRAY_WALL_PHOTO_MAX_UPLOAD_BYTES)}`,
          });
          resolve();
          return;
        }

        if (invalidMimeType) {
          respondJson(res, 400, { error: 'Only JPG, PNG, and WebP photos are allowed' });
          resolve();
          return;
        }

        if (!wallUuid) {
          respondJson(res, 400, { error: 'wallUuid is required' });
          resolve();
          return;
        }

        // The uuid becomes part of the S3 key, so a malformed one is a path
        // traversal, not a lookup miss.
        if (!isWellFormedUuid(wallUuid)) {
          respondJson(res, 400, { error: 'Invalid wallUuid format' });
          resolve();
          return;
        }

        if (!fileBuffer || !declaredMimeType) {
          respondJson(res, 400, { error: 'No file uploaded' });
          resolve();
          return;
        }

        if (fileBuffer.length === 0) {
          respondJson(res, 400, { error: 'Uploaded file is empty' });
          resolve();
          return;
        }

        // The declared Content-Type got past the allowlist; the BYTES decide
        // what we actually accept. Checked before the DB round-trip so a junk
        // upload costs nothing.
        if (detectImageMimeType(fileBuffer) !== declaredMimeType) {
          respondJson(res, 400, { error: 'File contents do not match the declared image type' });
          resolve();
          return;
        }

        const wall = await loadOwnedWall(wallUuid, authenticatedUserId);
        if (wall.outcome === 'not-found') {
          respondJson(res, 404, { error: 'Spray wall not found' });
          resolve();
          return;
        }
        if (wall.outcome === 'forbidden') {
          respondJson(res, 403, { error: 'You can only add photos to your own spray wall' });
          resolve();
          return;
        }
        if (wall.outcome === 'archived') {
          respondJson(res, 409, { error: SPRAY_WALL_ARCHIVED_MESSAGE, code: SPRAY_WALL_ARCHIVED_CODE });
          resolve();
          return;
        }

        let normalised: { base: EncodedWallPhoto; full: EncodedWallPhoto | null };
        try {
          normalised = await normaliseWallPhoto(fileBuffer);
        } catch (decodeError) {
          // The magic bytes said JPEG/PNG/WebP and sharp still could not decode
          // it: a truncated or crafted file. Refusing it here is what keeps a
          // version row from pointing at bytes nothing can render.
          logger.warn('Spray wall photo could not be decoded', { wallUuid }, decodeError);
          respondJson(res, 400, { error: 'That photo could not be read. Try another one.' });
          resolve();
          return;
        }

        const photoId = randomUUID();
        const uploadedWallUuid = wallUuid;
        const key = sprayWallPhotoKey(wallUuid, photoId);
        const writtenKeys: string[] = [];

        // A request may have passed ownership before account deletion committed.
        // Erase its own objects on withdrawal; retain a durable retry if storage
        // is unavailable. The purge's updated_at fence protects this retry from
        // an older prefix listing that had not seen our late upload.
        //
        // The retry only acts on a DELETED wall. When the withdrawal is an
        // archive and the erase fails, the object is left behind on purpose: it
        // is in the private bucket under a random key nothing names, and the
        // retention purge sweeps the wall's whole prefix, this object included,
        // if the archived wall is ever deleted.
        const eraseUpload = async () => {
          const erased = await Promise.allSettled(writtenKeys.map((writtenKey) => deleteFromS3('private', writtenKey)));
          if (erased.every((result) => result.status === 'fulfilled')) return;
          try {
            await markDeletedSprayWallPhotoRetry(uploadedWallUuid);
          } catch (retryError) {
            // Cleanup is best effort; a second SQL failure must not prevent
            // sending the upload's original error response.
            logger.error(
              'Failed to record withdrawn spray photo cleanup retry',
              { wallUuid: uploadedWallUuid },
              retryError,
            );
          }
        };

        const { base: basePhoto, full: fullPhoto } = normalised;

        try {
          // Variants first, then the base — the avatars.ts ordering, so a reader
          // that can see the photo can always see its thumbnail (and its full
          // copy). Only the largest allowed size is written: these feed list rows
          // and the reset compare view, and every other size would be an object
          // per wall per version for nobody. The thumbnail is cut from the base,
          // the smaller decode.
          await writeImageVariants(
            basePhoto.body,
            key,
            (variantKey, body, contentType) => {
              writtenKeys.push(variantKey);
              return uploadToS3('private', body, variantKey, contentType, {
                acl: null,
                cacheControl: PRIVATE_PHOTO_CACHE_CONTROL,
              });
            },
            [280],
            STORED_CONTENT_TYPE,
          );
          if (fullPhoto) {
            const fullKey = sprayWallFullPhotoKey(key);
            writtenKeys.push(fullKey);
            await uploadToS3('private', fullPhoto.body, fullKey, STORED_CONTENT_TYPE, {
              acl: null,
              cacheControl: PRIVATE_PHOTO_CACHE_CONTROL,
              // Informational only. Nothing reads geometry off the full copy:
              // holds live in the canonical frame, which the BASE defines.
              metadata: {
                [SPRAY_PHOTO_WIDTH_METADATA_KEY]: String(fullPhoto.width),
                [SPRAY_PHOTO_HEIGHT_METADATA_KEY]: String(fullPhoto.height),
              },
            });
          }
          writtenKeys.push(key);
          await uploadToS3('private', basePhoto.body, key, STORED_CONTENT_TYPE, {
            acl: null,
            cacheControl: PRIVATE_PHOTO_CACHE_CONTROL,
            // The dimensions ride WITH the object so `createSprayWallVersion`
            // reads them off storage instead of trusting a client-sent number:
            // they define the canonical frame, and a lie about them would put
            // every hold on the wall at the wrong place.
            metadata: {
              [SPRAY_PHOTO_WIDTH_METADATA_KEY]: String(basePhoto.width),
              [SPRAY_PHOTO_HEIGHT_METADATA_KEY]: String(basePhoto.height),
            },
          });
          // Re-checked after the bytes land: a delete or an archive may have
          // committed while they were uploading.
          const wallAfterSave = await loadOwnedWall(wallUuid, authenticatedUserId);
          if (wallAfterSave.outcome === 'archived') {
            await eraseUpload();
            respondJson(res, 409, { error: SPRAY_WALL_ARCHIVED_MESSAGE, code: SPRAY_WALL_ARCHIVED_CODE });
            resolve();
            return;
          }
          if (wallAfterSave.outcome !== 'ok') {
            await eraseUpload();
            respondJson(res, 404, { error: 'Spray wall not found' });
            resolve();
            return;
          }
        } catch (saveError) {
          await eraseUpload();
          logger.error('Failed to save spray wall photo:', saveError);
          respondJson(res, 500, { error: 'Failed to save the wall photo' });
          resolve();
          return;
        }

        respondJson(res, 200, {
          success: true,
          photoId,
          width: basePhoto.width,
          height: basePhoto.height,
        });
        resolve();
      } catch (unexpected) {
        logger.error('Spray wall photo upload failed:', unexpected);
        respondJson(res, 500, { error: 'Failed to save the wall photo' });
        resolve();
      }
    });

    busboy.on('error', (error: Error) => {
      logger.error('Busboy error on spray wall photo upload:', error);
      respondJson(res, 400, { error: error.message });
      resolve();
    });

    req.pipe(busboy);
  });
}
