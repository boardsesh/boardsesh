import type { IncomingMessage, ServerResponse } from 'http';
import { createHash, randomUUID } from 'node:crypto';
import Busboy from 'busboy';
import sharp from 'sharp';
import { applyCorsHeaders } from './cors';
import { detectImageMimeType } from './gym-image-upload';
import { validateToken } from '../middleware/auth';
import { isS3Configured, uploadToS3 } from '../storage/s3';
import { cncArtAssetKey, createArtAsset } from '../services/cnc/art-assets';
import { looksLikeSvg, sanitiseSvg, type SvgRejectionReason } from '../services/cnc/svg-sanitiser';
import { RateLimitError } from '../utils/rate-limiter';
import { checkRateLimitRedis } from '../utils/redis-rate-limiter';
import { logger } from '../utils/logger';

/**
 * `POST /api/cnc/art` — a buyer's logo, on its way into a build pack.
 *
 * Its own handler rather than a third `createGymImageUploadHandler` config,
 * because the two uploads disagree about the one thing that matters: gym images
 * are raster-only precisely so an inline `<svg>` can never execute on the
 * kiosk, embed and gym pages that serve them back to anonymous readers. Build
 * pack artwork is the opposite — SVG is the format that routes well, and
 * nothing ever renders these bytes in a browser. They go to the private bucket
 * and come back out exactly once, to the generator, over an authenticated
 * worker route with `nosniff`.
 *
 * The order of operations is deliberate and it is the same one
 * `services/cnc/art-assets.ts` documents: sniff the type from the BYTES, clean
 * them, write the object, and only then write the row. A row with no object
 * behind it is artwork the buyer can select and the generator then cannot
 * fetch; an object with no row is an orphan a lifecycle sweep collects. The
 * second failure is the cheap one.
 *
 * Nothing here logs file contents — not a snippet, not a rejected fragment.
 * The only things that reach the log are sizes, mime types and a rejection
 * code.
 */

/** Multipart field carrying the file. */
const ART_FIELD_NAME = 'art';

/**
 * Busboy's hard cap. Above the sanitiser's own 2 MB SVG ceiling on purpose: a
 * PNG is allowed to be bigger than a drawing, and an SVG over its own limit
 * should be told which limit it broke rather than truncated by the transport.
 */
const MAX_ART_UPLOAD_BYTES = 5 * 1024 * 1024;

/**
 * Uploads per buyer per hour.
 *
 * Placing one logo takes a handful of tries — export, look at it, export again.
 * Twenty is well past that and still bounds what a single account can push into
 * the private bucket, which is the resource being protected: an upload that is
 * never bought is storage nobody paid for until the sweep collects it.
 */
const ART_UPLOADS_PER_HOUR = 20;
const ART_UPLOAD_WINDOW_MS = 60 * 60 * 1000;
const ART_UPLOAD_RATE_LIMIT_OPERATION = 'cncArtUpload';

/**
 * Raster bounds in pixels.
 *
 * The floor is what still traces into a shape rather than a blur; the ceiling
 * is the point past which the trace is slower than the whole rest of the job.
 * Both are checked on the DECODED image, not on a header the file declared.
 */
const MIN_RASTER_DIMENSION_PX = 64;
const MAX_RASTER_DIMENSION_PX = 4096;

/** What the response's `reason` can be, on top of every `SvgRejectionReason`. */
type ArtUploadReason =
  | SvgRejectionReason
  | 'no_file'
  | 'file_too_large'
  | 'unsupported_type'
  | 'unreadable_image'
  | 'image_too_small'
  | 'image_too_large'
  | 'storage_unavailable'
  | 'rate_limited'
  | 'save_failed';

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

/**
 * A refusal the buyer can act on.
 *
 * `reason` is a stable code and `error` is the English sentence behind it. The
 * web layer translates the code and keeps the sentence as context, the same
 * shape the gym uploads use — so a reason we add later degrades to readable
 * English rather than to a blank alert.
 */
function sendRejection(res: ServerResponse, statusCode: number, reason: ArtUploadReason, error: string): void {
  sendJson(res, statusCode, { error, reason });
}

function extractAuthTokenFromHeader(req: IncomingMessage): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

type StoredArt = {
  buffer: Buffer;
  mime: string;
  extension: string;
  widthPx: number | null;
  heightPx: number | null;
};

/**
 * Decide what these bytes are and what we would store for them.
 *
 * The multipart `Content-Type` is never consulted. It is whatever the client
 * typed, and the only reason this route can hand a mime to the worker asset
 * stream at all is that the mime is derived here, from the file itself.
 *
 * An SVG is returned RE-SERIALISED: the stored bytes are the sanitiser's
 * output, so the sha256 on the row is of the document the generator will
 * actually parse rather than of the upload it never sees.
 */
async function prepareArt(
  upload: Buffer,
): Promise<{ ok: true; art: StoredArt } | { ok: false; status: number; reason: ArtUploadReason; message: string }> {
  const rasterMime = detectImageMimeType(upload);

  if (rasterMime === 'image/png') {
    let metadata: { width?: number; height?: number };
    try {
      metadata = await sharp(upload).metadata();
    } catch {
      return { ok: false, status: 422, reason: 'unreadable_image', message: 'That PNG could not be read.' };
    }

    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (width < MIN_RASTER_DIMENSION_PX || height < MIN_RASTER_DIMENSION_PX) {
      return {
        ok: false,
        status: 422,
        reason: 'image_too_small',
        message: `That image is smaller than ${String(MIN_RASTER_DIMENSION_PX)} pixels on a side.`,
      };
    }
    if (width > MAX_RASTER_DIMENSION_PX || height > MAX_RASTER_DIMENSION_PX) {
      return {
        ok: false,
        status: 422,
        reason: 'image_too_large',
        message: `That image is bigger than ${String(MAX_RASTER_DIMENSION_PX)} pixels on a side.`,
      };
    }

    return {
      ok: true,
      art: { buffer: upload, mime: 'image/png', extension: 'png', widthPx: width, heightPx: height },
    };
  }

  // Anything else that decoded as a raster is a JPEG, GIF or WebP. Refused by
  // TYPE rather than converted: the generator traces a PNG and outlines an SVG,
  // and a silent re-encode would be us deciding what the buyer's logo looks
  // like.
  if (rasterMime !== null) {
    return {
      ok: false,
      status: 415,
      reason: 'unsupported_type',
      message: 'Build pack artwork has to be an SVG or a PNG.',
    };
  }

  if (!looksLikeSvg(upload)) {
    return {
      ok: false,
      status: 415,
      reason: 'unsupported_type',
      message: 'Build pack artwork has to be an SVG or a PNG.',
    };
  }

  const sanitised = sanitiseSvg(upload.toString('utf8'));
  if (!sanitised.ok) {
    return { ok: false, status: 422, reason: sanitised.reason, message: sanitised.message };
  }

  return {
    ok: true,
    art: {
      buffer: Buffer.from(sanitised.svg, 'utf8'),
      mime: 'image/svg+xml',
      extension: 'svg',
      // A drawing has no intrinsic pixel size. The row says so with nulls
      // rather than with the viewBox's user units, which are not pixels and
      // would read as if they were.
      widthPx: null,
      heightPx: null,
    },
  };
}

/**
 * Store the bytes, then record them.
 *
 * `private, no-store`: nothing between here and the worker may keep a copy of a
 * buyer's artwork, and the private bucket has no public URL to cache it at
 * anyway.
 */
async function storeArt(userId: string, art: StoredArt) {
  const assetId = randomUUID();
  const key = cncArtAssetKey(userId, assetId, art.extension);
  const sha256 = createHash('sha256').update(art.buffer).digest('hex');

  await uploadToS3('private', art.buffer, key, art.mime, { cacheControl: 'private, no-store' });

  await createArtAsset({
    id: assetId,
    userId,
    key,
    mime: art.mime,
    sizeBytes: art.buffer.length,
    widthPx: art.widthPx,
    heightPx: art.heightPx,
    sha256,
  });

  return { assetId, sizeBytes: art.buffer.length };
}

export async function handleCncArtUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!applyCorsHeaders(req, res)) return;

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  const token = extractAuthTokenFromHeader(req);
  if (!token) {
    sendJson(res, 401, { error: 'Authentication required' });
    return;
  }

  const authResult = await validateToken(token);
  if (!authResult) {
    sendJson(res, 401, { error: 'Invalid or expired token' });
    return;
  }
  const userId = authResult.userId;

  // Checked before a byte is read. An operator who has not set the private
  // bucket up gets a 503 the buyer can retry, rather than a 500 after a 5 MB
  // upload has already crossed the wire.
  if (!isS3Configured('private')) {
    logger.error('[cnc-art] upload attempted with no private bucket configured');
    sendRejection(res, 503, 'storage_unavailable', 'Artwork uploads are not available right now. Try again shortly.');
    return;
  }

  try {
    await checkRateLimitRedis(userId, ART_UPLOAD_RATE_LIMIT_OPERATION, ART_UPLOADS_PER_HOUR, ART_UPLOAD_WINDOW_MS);
  } catch (error) {
    if (error instanceof RateLimitError) {
      res.setHeader('Retry-After', String(error.retryAfterSeconds));
      sendRejection(res, 429, 'rate_limited', 'That is a lot of uploads. Give it a few minutes and try again.');
      return;
    }
    throw error;
  }

  return new Promise<void>((resolve) => {
    let busboy: ReturnType<typeof Busboy>;
    try {
      busboy = Busboy({
        headers: req.headers as { 'content-type': string },
        limits: { fileSize: MAX_ART_UPLOAD_BYTES, files: 1 },
      });
    } catch {
      sendJson(res, 400, { error: 'Invalid request format' });
      resolve();
      return;
    }

    let fileBuffer: Buffer | undefined;
    let fileTruncated = false;

    busboy.on('file', (name: string, stream: NodeJS.ReadableStream) => {
      if (name !== ART_FIELD_NAME) {
        stream.resume();
        return;
      }

      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('limit', () => {
        fileTruncated = true;
      });
      stream.on('end', () => {
        fileBuffer = Buffer.concat(chunks);
      });
    });

    busboy.on('finish', () => {
      // The whole body is inside a try/catch: an unhandled rejection in this
      // detached async listener would escape to the process AND leave this
      // promise unsettled, so the request would hang forever.
      void (async () => {
        try {
          if (fileTruncated) {
            sendRejection(
              res,
              413,
              'file_too_large',
              `That file is bigger than ${String(MAX_ART_UPLOAD_BYTES / 1024 / 1024)}MB.`,
            );
            return;
          }
          if (!fileBuffer || fileBuffer.length === 0) {
            sendRejection(res, 400, 'no_file', 'No artwork was uploaded.');
            return;
          }

          const prepared = await prepareArt(fileBuffer);
          if (!prepared.ok) {
            logger.info('[cnc-art] refused an upload', {
              userId,
              reason: prepared.reason,
              sizeBytes: fileBuffer.length,
            });
            sendRejection(res, prepared.status, prepared.reason, prepared.message);
            return;
          }

          const stored = await storeArt(userId, prepared.art);
          sendJson(res, 200, {
            assetId: stored.assetId,
            mime: prepared.art.mime,
            widthPx: prepared.art.widthPx,
            heightPx: prepared.art.heightPx,
            sizeBytes: stored.sizeBytes,
          });
        } catch (error) {
          // Never the file, never a fragment of it: a size and the failure.
          logger.error('[cnc-art] failed to store an upload', error);
          sendRejection(res, 500, 'save_failed', 'That upload did not save. Try again.');
        } finally {
          resolve();
        }
      })();
    });

    busboy.on('error', (error: Error) => {
      logger.error('[cnc-art] multipart parse failed:', error.message);
      sendJson(res, 400, { error: 'Invalid request format' });
      resolve();
    });

    req.pipe(busboy);
  });
}
