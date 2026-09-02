import type { IncomingMessage, ServerResponse } from 'http';
import Busboy from 'busboy';
import path from 'path';
import { randomUUID } from 'crypto';
import { mkdir, writeFile, unlink } from 'fs/promises';
import { eq, and, isNull } from 'drizzle-orm';
import { applyCorsHeaders } from './cors';
import { validateToken } from '../middleware/auth';
import { isS3Configured, uploadToS3 } from '../storage/s3';
import { MUTABLE_IMAGE_CACHE_CONTROL, writeImageVariants } from '../lib/image-resize';
import { logger } from '../utils/logger';
import { db } from '../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { userCanEditGym } from '../graphql/resolvers/social/gyms';

// Shared machinery behind the two gym image uploads — the kiosk/embed LOGO
// (gym-logos.ts) and the public-page PHOTO (gym-photos.ts). Both accept the
// same raster mime allowlist (NO svg — an inline <svg> would execute script
// when rendered on the unauthenticated kiosk/embed/gym surfaces), authorize
// through userCanEditGym, and store to S3 or local-dev disk. Everything that
// differs between them is config: the multipart field name, the storage
// prefix, the size cap, the URL builder, the response key and the (English)
// error strings.
export const GYM_IMAGE_ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/** Extensions a gym image can have been stored under, for stale-file cleanup. */
export const GYM_IMAGE_EXTENSIONS = ['jpg', 'png', 'gif', 'webp'];

/**
 * Sniff the real image type from the file's magic bytes.
 *
 * The multipart `Content-Type` is whatever the CLIENT declared, and until this
 * check existed nothing ever read the bytes — so any payload labelled
 * `image/jpeg` was stored under our key and re-served from our origin with that
 * Content-Type. `nosniff` plus the raster-only allowlist keeps that from being
 * XSS, but it still let an authenticated gym editor host arbitrary bytes on
 * boardsesh.com. Returns null when the bytes match no supported format.
 */
export function detectImageMimeType(buffer: Buffer): string | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (buffer.length >= 6) {
    const header = buffer.subarray(0, 6).toString('latin1');
    if (header === 'GIF87a' || header === 'GIF89a') {
      return 'image/gif';
    }
  }
  // RIFF....WEBP — the four-byte file size sits between the two tags.
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buffer.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/** "5MB" / "2MB" — used in the size-cap error so the number is never restated. */
function formatByteCapForMessage(maxFileSizeBytes: number): string {
  const megabytes = maxFileSizeBytes / (1024 * 1024);
  return `${Number.isInteger(megabytes) ? megabytes : megabytes.toFixed(1)}MB`;
}

// UUID validation regex for path traversal prevention (the uuid becomes the S3
// key / local filename).
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when `gymUuid` is a well-formed UUID (guards S3 keys and file names). */
export function validateGymUuid(gymUuid: string): boolean {
  return UUID_REGEX.test(gymUuid);
}

export type GymImageUploadConfig = {
  /** Multipart field name carrying the file (`logo`, `photo`). */
  fileFieldName: string;
  /** S3 key prefix AND local-dev directory name (`gym-logos`, `gym-photos`). */
  storagePrefix: string;
  /** Local-dev directory path (used when S3 is not configured). */
  localDir: string;
  /** Busboy hard cap on the uploaded file. */
  maxFileSizeBytes: number;
  /** JSON key the success response carries the stored URL under. */
  responseUrlKey: string;
  /** Builds the backend-relative `/static/...` path persisted on the gym row. */
  buildStaticUrl: (fileName: string, version: string) => string;
  /** Best-effort stale-extension cleanup in S3 (write-first, clean-after). */
  deleteStaleObjectsFromS3: (gymUuid: string, keepExt?: string) => Promise<void>;
  /**
   * Client-facing (English) error strings; the web layer localizes its own.
   * The size-cap message is NOT here — it is derived from maxFileSizeBytes so
   * raising the cap can't leave a stale number in the copy.
   */
  messages: {
    notConfigured: string;
    saveFailed: string;
    authorizeFailed: string;
  };
  /** Noun used in server-side log lines ("gym logo", "gym photo"). */
  logLabel: string;
};

/**
 * Extract auth token from Authorization header (Bearer <token>).
 */
export function extractAuthTokenFromHeader(req: IncomingMessage): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

/**
 * Delete a gym's local (dev) image files. Called AFTER the new image is written,
 * with `keepExt` set to the new file's extension — so a failed replacement never
 * destroys the existing image. A missing file (ENOENT) is the expected case;
 * anything else is a real failure and gets logged (the new image is already
 * saved, so this is non-fatal).
 */
export async function deleteExistingLocalImages(
  localDir: string,
  logLabel: string,
  gymUuid: string,
  keepExt?: string,
): Promise<void> {
  const extensions = GYM_IMAGE_EXTENSIONS.filter((ext) => ext !== keepExt);
  for (const ext of extensions) {
    const filePath = path.join(localDir, `${gymUuid}.${ext}`);
    try {
      await unlink(filePath);
    } catch (unlinkError) {
      if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn(`Failed to delete stale local ${logLabel} ${filePath}:`, unlinkError);
      }
    }
  }
}

/**
 * Build the POST handler for one gym image kind.
 *
 * Expects multipart form data with:
 * - <config.fileFieldName>: the image file
 * - gymUuid: the gym UUID (UUID format)
 *
 * Requires authentication via Authorization header (Bearer token). The caller
 * must have edit access to the gym (owner, gym admin/editor, or a covering
 * community admin/leader), enforced by userCanEditGym.
 */
export function createGymImageUploadHandler(
  config: GymImageUploadConfig,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  // Track if directory has been initialized
  let localDirInitialized = false;

  /**
   * Ensure the local-dev directory exists (called on first local-dev upload).
   */
  async function ensureLocalDir(): Promise<void> {
    if (localDirInitialized) return;

    try {
      await mkdir(config.localDir, { recursive: true });
      localDirInitialized = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        localDirInitialized = true;
      } else {
        throw error;
      }
    }
  }

  return async function handleGymImageUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!applyCorsHeaders(req, res)) return;

    // Validate authentication
    const token = extractAuthTokenFromHeader(req);
    if (!token) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Authentication required' }));
      return;
    }

    const authResult = await validateToken(token);
    if (!authResult) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid or expired token' }));
      return;
    }

    const authenticatedUserId = authResult.userId;

    // Check S3 configuration
    const useS3 = isS3Configured('media');
    const isProduction = process.env.NODE_ENV === 'production';

    // In production, S3 must be configured for image uploads
    if (isProduction && !useS3) {
      logger.error(`${config.logLabel} upload attempted in production without S3 configured`);
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: config.messages.notConfigured }));
      return;
    }

    // Ensure local-dev directory exists (only needed without S3)
    if (!useS3) {
      try {
        await ensureLocalDir();
      } catch (error) {
        logger.error(`Failed to create ${config.storagePrefix} directory:`, error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Server configuration error' }));
        return;
      }
    }

    return new Promise<void>((resolve) => {
      let busboy: ReturnType<typeof Busboy>;

      try {
        busboy = Busboy({
          headers: req.headers as { 'content-type': string },
          limits: { fileSize: config.maxFileSizeBytes, files: 1 },
        });
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid request format' }));
        resolve();
        return;
      }

      let gymUuid: string | undefined;
      let fileBuffer: Buffer | undefined;
      let mimeType: string | undefined;
      let fileTruncated = false;
      let invalidMimeType = false;

      busboy.on('field', (name: string, value: string) => {
        if (name === 'gymUuid') gymUuid = value;
      });

      busboy.on('file', (name: string, stream: NodeJS.ReadableStream, info: { mimeType: string }) => {
        if (name !== config.fileFieldName) {
          stream.resume();
          return;
        }

        mimeType = info.mimeType;
        if (!GYM_IMAGE_ALLOWED_MIME_TYPES.includes(mimeType)) {
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
        // Validate file size
        if (fileTruncated) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: `File size must be less than ${formatByteCapForMessage(config.maxFileSizeBytes)}`,
            }),
          );
          resolve();
          return;
        }

        // Validate MIME type
        if (invalidMimeType) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Only JPG, PNG, GIF, and WebP images are allowed' }));
          resolve();
          return;
        }

        // Validate gymUuid
        if (!gymUuid) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'gymUuid is required' }));
          resolve();
          return;
        }

        if (!validateGymUuid(gymUuid)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid gymUuid format' }));
          resolve();
          return;
        }

        // Validate file was uploaded and is non-empty (an empty multipart part
        // would otherwise write a zero-byte image and return 200)
        if (!fileBuffer || !mimeType) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No file uploaded' }));
          resolve();
          return;
        }

        if (fileBuffer.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Uploaded file is empty' }));
          resolve();
          return;
        }

        // The declared Content-Type got us past the allowlist; the BYTES decide
        // what we actually store. Without this, any 5MB payload labelled
        // image/jpeg is written under our key and re-served from our origin as
        // a JPEG — arbitrary file hosting on boardsesh.com for anyone with edit
        // access to a gym. Checked before the DB round-trip so a junk upload
        // costs us nothing.
        if (detectImageMimeType(fileBuffer) !== mimeType) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'File contents do not match the declared image type' }));
          resolve();
          return;
        }

        // Load the gym (not deleted) and authorize: the caller must be able to edit
        // it. A missing gym is a 404; an unauthorized caller is a 403. The whole
        // block is try/caught: an unhandled rejection inside this detached async
        // listener would otherwise escape to the process level (killing the server
        // under Node's default policy) AND leave the wrapping Promise unsettled, so
        // the request would hang forever.
        try {
          const [gym] = await db
            .select()
            .from(dbSchema.gyms)
            .where(and(eq(dbSchema.gyms.uuid, gymUuid), isNull(dbSchema.gyms.deletedAt)))
            .limit(1);

          if (!gym) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Gym not found' }));
            resolve();
            return;
          }

          const canEdit = await userCanEditGym(gym, authenticatedUserId);
          if (!canEdit) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'You do not have permission to edit this gym' }));
            resolve();
            return;
          }
        } catch (authzErr) {
          logger.error(`Failed to authorize ${config.logLabel} upload:`, authzErr);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: config.messages.authorizeFailed }));
          resolve();
          return;
        }

        // Determine file extension
        const ext = MIME_TO_EXT[mimeType] || 'jpg';
        const imageFileName = `${gymUuid}.${ext}`;
        let storedUrl: string;

        // Write the new image FIRST, then clean up stale other-extension files.
        // A same-extension re-upload overwrites its key in place, so the existing
        // image is only ever removed once its replacement is durably saved — a
        // failed upload can't leave the gym image-less while the gym row still
        // points at a deleted object.
        try {
          if (useS3) {
            const s3Key = `${config.storagePrefix}/${imageFileName}`;
            // Variants first, then the base — see the note in handlers/avatars.ts.
            await writeImageVariants(
              fileBuffer,
              s3Key,
              (key, body, contentType) =>
                uploadToS3('media', body, key, contentType, { cacheControl: MUTABLE_IMAGE_CACHE_CONTROL }),
              undefined,
              mimeType,
            );
            await uploadToS3('media', fileBuffer, s3Key, mimeType);
            // Backend-relative URL — we proxy the bytes from S3 ourselves, so no
            // public-read ACL is required.
            storedUrl = config.buildStaticUrl(imageFileName, randomUUID());
          } else {
            const filePath = path.join(config.localDir, imageFileName);
            await writeFile(filePath, fileBuffer);
            storedUrl = config.buildStaticUrl(imageFileName, randomUUID());
          }
        } catch (saveErr) {
          logger.error(`Failed to save ${config.logLabel}:`, saveErr);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: config.messages.saveFailed }));
          resolve();
          return;
        }

        // Best-effort stale-extension cleanup (the helpers keep the new file and
        // log real failures). A leftover stale-ext file is unreferenced — the
        // stored URL points at the new key — so failure here is non-fatal.
        //
        // Known gap on a CROSS-EXTENSION replace: this drops the old object
        // before the client has repointed the row, so if the caller's follow-up
        // updateGym never lands, the row is left pointing at a deleted object.
        // Unreachable through either console — the logo canvas emits png/jpeg
        // per input type and the photo canvas always emits jpeg, so a re-upload
        // overwrites its own key in place — but reachable by a direct API caller
        // that switches extension and then drops the mutation.
        if (useS3) {
          await config.deleteStaleObjectsFromS3(gymUuid, ext);
        } else {
          await deleteExistingLocalImages(config.localDir, config.logLabel, gymUuid, ext);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, [config.responseUrlKey]: storedUrl }));
        resolve();
      });

      busboy.on('error', (err: Error) => {
        logger.error('Busboy error:', err);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
        resolve();
      });

      req.pipe(busboy);
    });
  };
}
