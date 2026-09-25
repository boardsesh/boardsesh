import type { IncomingMessage, ServerResponse } from 'http';
import { randomBytes, randomUUID } from 'crypto';
import Busboy from 'busboy';
import sharp from 'sharp';
import { and, eq, isNull } from 'drizzle-orm';
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
import { isS3Configured, uploadToS3 } from '../storage/s3';
import { writeImageVariants } from '../lib/image-resize';
import { db } from '../db/client';
import { logger } from '../utils/logger';

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
 * Returns `{ success, photoId, width, height }`. The photo sits in the bucket
 * unreferenced until `createSprayWallVersion(wallUuid, photoId)` adopts it as a
 * draft version — an abandoned upload is a stray object the SW-17 cleanup job
 * sweeps, not a row anybody can see.
 */

/** 10MB. A phone photo of a wall is 2-5MB; the cap bounds what one POST can cost. */
export const SPRAY_WALL_PHOTO_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

// Per-user upload budget, copied from `handlers/feedback-screenshots.ts` and for
// the same reason: every POST here mints a NEW object (the key carries a fresh
// uuid), so without a budget one authenticated account can fill the private
// bucket with 10MB objects, and an abandoned upload is never referenced by a row
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

/**
 * Normalise an uploaded photo: apply the EXIF orientation, then re-encode as
 * JPEG so no metadata block survives.
 *
 * Returns the bytes and the dimensions AFTER the rotate, which is the only
 * orientation any later consumer will ever see — anchors are tapped on these
 * pixels, so a width/height read before the rotate would transpose the whole
 * canonical frame on any portrait phone photo.
 */
async function normaliseWallPhoto(input: Buffer): Promise<{ body: Buffer; width: number; height: number }> {
  const pipeline = sharp(input).rotate().jpeg({ quality: STORED_JPEG_QUALITY });
  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
  return { body: data, width: info.width, height: info.height };
}

/**
 * The wall a photo is being uploaded for, when the caller owns it.
 *
 * Ownership is the whole authorization story on a spray wall (epic decision
 * 2026-09-14: users own a wall and that ownership is what grants editing), so
 * this is deliberately NOT `requireBoardEditAccess` — no gym admin and no
 * community role uploads a photograph of a stranger's living room.
 */
async function loadOwnedWall(
  wallUuid: string,
  userId: string,
): Promise<{ outcome: 'ok' } | { outcome: 'not-found' } | { outcome: 'forbidden' }> {
  const [row] = await db
    .select({ ownerId: dbSchema.userBoards.ownerId })
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

        let normalised: { body: Buffer; width: number; height: number };
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
        const key = sprayWallPhotoKey(wallUuid, photoId);

        try {
          // Variants first, then the base — the avatars.ts ordering, so a reader
          // that can see the photo can always see its thumbnail. Only the
          // largest allowed size is written: these feed list rows and the reset
          // compare view, and every other size would be an object per wall per
          // version for nobody.
          await writeImageVariants(
            normalised.body,
            key,
            (variantKey, body, contentType) =>
              uploadToS3('private', body, variantKey, contentType, {
                acl: null,
                cacheControl: PRIVATE_PHOTO_CACHE_CONTROL,
              }),
            [280],
            STORED_CONTENT_TYPE,
          );
          await uploadToS3('private', normalised.body, key, STORED_CONTENT_TYPE, {
            acl: null,
            cacheControl: PRIVATE_PHOTO_CACHE_CONTROL,
            // The dimensions ride WITH the object so `createSprayWallVersion`
            // reads them off storage instead of trusting a client-sent number:
            // they define the canonical frame, and a lie about them would put
            // every hold on the wall at the wrong place.
            metadata: {
              [SPRAY_PHOTO_WIDTH_METADATA_KEY]: String(normalised.width),
              [SPRAY_PHOTO_HEIGHT_METADATA_KEY]: String(normalised.height),
            },
          });
        } catch (saveError) {
          logger.error('Failed to save spray wall photo:', saveError);
          respondJson(res, 500, { error: 'Failed to save the wall photo' });
          resolve();
          return;
        }

        respondJson(res, 200, {
          success: true,
          photoId,
          width: normalised.width,
          height: normalised.height,
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
