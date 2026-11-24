import type { IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'node:crypto';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { GraphQLError } from 'graphql';
import Busboy from 'busboy';
import path from 'path';
import { unlink } from 'fs/promises';
import { eq, and, isNull } from 'drizzle-orm';
import { applyCorsHeaders } from './cors';
import { guardUploadFileStream } from './http-utils';
import { validateHttpAuthToken } from './auth-admission';
import { isS3Configured } from '../storage/s3';
import { detectImageMimeType } from '../lib/image-mime';
import { UndecodableImageError, reencodeUploadedImage } from '../lib/image-resize';
import { removeVersionedGymImage, storeVersionedGymImage, type GymImageKind } from '../services/gym-image-storage';
import { logger } from '../utils/logger';
import { db, runWithDatabaseTransaction } from '../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { socialGymMutations, userCanEditGym } from '../graphql/resolvers/social/gyms';

// Shared machinery behind the two gym image uploads — the kiosk/embed LOGO
// (gym-logos.ts) and the public-page PHOTO (gym-photos.ts). The pieces that are
// not gym-specific (the mime/extension map, the size-cap message,
// the bearer-token reader) are exported and also used by the feedback-screenshot
// upload; keep them free of gym assumptions. Both accept the
// same raster mime allowlist (NO svg — an inline <svg> would execute script
// when rendered on the unauthenticated kiosk/embed/gym surfaces), authorize
// through userCanEditGym, and store to S3 or local-dev disk. Everything that
// differs between them is config: the multipart field name, the storage
// prefix, the size cap, the URL builder, the response key and the (English)
// error strings.
export const GYM_IMAGE_ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

/** Extensions a gym image can have been stored under, for stale-file cleanup. */
export const GYM_IMAGE_EXTENSIONS = ['jpg', 'png', 'gif', 'webp'];

/**
 * "5MB" / "2MB" — used in the size-cap error so the number is never restated.
 * Exported so every upload handler derives its message from its own cap rather
 * than hardcoding a number that goes stale the moment the cap moves.
 */
export function formatByteCapForMessage(maxFileSizeBytes: number): string {
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
  kind: GymImageKind;
  /** Multipart field name carrying the file (`logo`, `photo`). */
  fileFieldName: string;
  /** S3 key prefix AND local-dev directory name (`gym-logos`, `gym-photos`). */
  storagePrefix: string;
  /** Busboy hard cap on the uploaded file. */
  maxFileSizeBytes: number;
  /** JSON key the success response carries the stored URL under. */
  responseUrlKey: string;
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
  return async function handleGymImageUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!applyCorsHeaders(req, res)) return;

    // Validate authentication
    const token = extractAuthTokenFromHeader(req);
    if (!token) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Authentication required' }));
      return;
    }

    const admission = await validateHttpAuthToken(token, res);
    if (!admission.available) return;
    const authResult = admission.auth;
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
        // Before every early return: busboy destroys this stream with an error
        // on any truncated part, and an unlistened one exits the process
        // (#5359).
        guardUploadFileStream(stream, { route: req.url ?? `/api/${config.storagePrefix}`, field: name });

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

        let storedUrl: string | undefined;
        let attachmentCommitted = false;
        const uploadGymUuid = gymUuid;
        // A distinct key keeps concurrent replacements independent. Attach in
        // this request so an interrupted client cannot abandon successful uploads.
        try {
          // Store sharp's re-encode, never the raw upload: a real JPEG with a
          // payload appended after its end marker passes the magic-byte check
          // AND decodes, so only re-encoding keeps that payload off our origin.
          // Same format, so the key and extension do not change. Runs before
          // the first write, so a rejection leaves the existing image alone.
          const storedBuffer = await reencodeUploadedImage(fileBuffer, mimeType);
          storedUrl = await storeVersionedGymImage(gymUuid, config.kind, storedBuffer, mimeType);
          const uploadedUrl = storedUrl;
          const savedGym = await runWithDatabaseTransaction(async (transaction) => {
            const [currentGym] = await transaction
              .select()
              .from(dbSchema.gyms)
              .where(and(eq(dbSchema.gyms.uuid, uploadGymUuid), isNull(dbSchema.gyms.deletedAt)))
              .limit(1)
              .for('update');
            if (!currentGym) throw new GraphQLError('Gym not found', { extensions: { code: 'NOT_FOUND' } });
            if (!(await userCanEditGym(currentGym, authenticatedUserId, transaction))) {
              throw new GraphQLError('You do not have permission to edit this gym', {
                extensions: { code: 'FORBIDDEN' },
              });
            }
            const context: ConnectionContext = {
              connectionId: `gym-image-${randomUUID()}`,
              transport: 'http',
              userId: authenticatedUserId,
              isAuthenticated: true,
              authCredentialProvided: true,
              isCronAuthenticated: false,
            };
            return socialGymMutations.updateGym(
              null,
              {
                input: {
                  gymUuid: uploadGymUuid,
                  ...(config.kind === 'photo' ? { imageUrl: uploadedUrl } : { logoUrl: uploadedUrl }),
                },
              },
              context,
            );
          });
          attachmentCommitted = true;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, [config.responseUrlKey]: storedUrl, gym: savedGym }));
        } catch (saveErr) {
          if (storedUrl && !attachmentCommitted) await removeVersionedGymImage(gymUuid, config.kind, storedUrl);
          if (saveErr instanceof UndecodableImageError) {
            // Also covers UPLOAD_MAX_INPUT_PIXELS: log sharp's reason so a real
            // device format that starts failing shows up.
            logger.warn(
              `Rejected ${config.logLabel} upload for gym ${gymUuid}: sharp could not decode it:`,
              saveErr.cause,
            );
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'File is not a readable image' }));
            resolve();
            return;
          }
          if (saveErr instanceof GraphQLError && ['NOT_FOUND', 'FORBIDDEN'].includes(String(saveErr.extensions.code))) {
            res.writeHead(saveErr.extensions.code === 'NOT_FOUND' ? 404 : 403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: saveErr.message }));
            resolve();
            return;
          }
          logger.error(`Failed to save ${config.logLabel}:`, saveErr);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: config.messages.saveFailed }));
          resolve();
          return;
        }

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
