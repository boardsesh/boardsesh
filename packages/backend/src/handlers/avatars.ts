import type { IncomingMessage, ServerResponse } from 'http';
import Busboy from 'busboy';
import path from 'path';
import { randomUUID } from 'crypto';
import { mkdir, writeFile, unlink } from 'fs/promises';
import { applyCorsHeaders } from './cors';
import { validateToken } from '../middleware/auth';
import { isS3Configured, uploadToS3, deleteUserAvatarsFromS3 } from '../storage/s3';
import { logger } from '../utils/logger';
import { buildStaticAvatarUrl } from '../lib/avatar-url';
import { MUTABLE_IMAGE_CACHE_CONTROL, writeImageVariants } from '../lib/image-resize';

// Avatar upload configuration
const AVATARS_DIR = './avatars';
const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

// UUID validation regex for path traversal prevention
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateUserId(userId: string): boolean {
  return UUID_REGEX.test(userId);
}

// Serialize save-and-clean per user: two overlapping replacements at different
// extensions would otherwise each write their own file and then delete the
// other request's fresh one — both 200, both files gone. In-process only, which
// covers the realistic double-fire from a single client; cross-instance races
// would need a distributed lock and aren't worth it for avatars.
const userUploadChains = new Map<string, Promise<unknown>>();

function serializePerUser<T>(userId: string, task: () => Promise<T>): Promise<T> {
  const previous = userUploadChains.get(userId) ?? Promise.resolve();
  const run = previous.then(task, task);
  const chainEntry: Promise<unknown> = run
    .catch(() => {})
    .finally(() => {
      if (userUploadChains.get(userId) === chainEntry) userUploadChains.delete(userId);
    });
  userUploadChains.set(userId, chainEntry);
  return run;
}

// Track if directory has been initialized
let avatarsDirInitialized = false;

/**
 * Ensure avatars directory exists (called on first upload)
 */
async function ensureAvatarsDir(): Promise<void> {
  if (avatarsDirInitialized) return;

  try {
    await mkdir(AVATARS_DIR, { recursive: true });
    avatarsDirInitialized = true;
  } catch (error) {
    // Directory might already exist, that's ok
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      avatarsDirInitialized = true;
    } else {
      throw error;
    }
  }
}

/**
 * Extract auth token from Authorization header
 */
function extractAuthTokenFromHeader(req: IncomingMessage): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;

  // Support "Bearer <token>" format
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

/**
 * Delete a user's stale avatar files from local storage. Called AFTER the new
 * avatar is written, with `keepExt` set to the new file's extension, so a
 * failed replacement never destroys the existing avatar (write-first,
 * clean-after — same contract as deleteUserAvatarsFromS3).
 */
async function deleteExistingAvatars(userId: string, keepExt?: string): Promise<void> {
  const extensions = ['jpg', 'png', 'gif', 'webp'].filter((ext) => ext !== keepExt);
  for (const ext of extensions) {
    const filePath = path.join(AVATARS_DIR, `${userId}.${ext}`);
    try {
      await unlink(filePath);
    } catch (deleteError) {
      if ((deleteError as NodeJS.ErrnoException).code === 'ENOENT') continue; // Nothing to clean up
      // The new avatar is already saved; a leftover stale-ext file is
      // unreferenced, so log for observability and carry on.
      logger.warn(`Failed to delete stale avatar ${filePath}:`, deleteError);
    }
  }
}

/**
 * Avatar upload handler
 * POST /api/avatars
 *
 * Expects multipart form data with:
 * - avatar: the image file
 * - userId: the user ID (UUID format)
 *
 * Requires authentication via Authorization header (Bearer token).
 * Users can only upload avatars for their own userId.
 */
export async function handleAvatarUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
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

  // In production, S3 must be configured for avatar uploads
  if (isProduction && !useS3) {
    logger.error('Avatar upload attempted in production without S3 configured');
    res.writeHead(501, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'Avatar uploads are not configured. Please contact the administrator.',
      }),
    );
    return;
  }

  // Ensure avatars directory exists (only needed for local storage in development)
  if (!useS3) {
    try {
      await ensureAvatarsDir();
    } catch (error) {
      logger.error('Failed to create avatars directory:', error);
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
        limits: { fileSize: MAX_FILE_SIZE, files: 1 },
      });
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid request format' }));
      resolve();
      return;
    }

    let userId: string | undefined;
    let fileBuffer: Buffer | undefined;
    let mimeType: string | undefined;
    let fileTruncated = false;
    let invalidMimeType = false;

    busboy.on('field', (name: string, value: string) => {
      if (name === 'userId') userId = value;
    });

    busboy.on('file', (name: string, stream: NodeJS.ReadableStream, info: { mimeType: string }) => {
      if (name !== 'avatar') {
        stream.resume();
        return;
      }

      mimeType = info.mimeType;
      if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
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
        res.end(JSON.stringify({ error: 'File size must be less than 2MB' }));
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

      // Validate userId
      if (!userId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'userId is required' }));
        resolve();
        return;
      }

      if (!validateUserId(userId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid userId format' }));
        resolve();
        return;
      }

      // Authorization check: users can only upload avatars for their own userId
      if (userId !== authenticatedUserId) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'You can only upload avatars for your own user ID' }));
        resolve();
        return;
      }

      // Validate file was uploaded and is non-empty (an empty multipart part
      // would otherwise store a zero-byte avatar and return 200, so the client
      // saves an avatarUrl that serves an empty image forever)
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

      // Capture the narrowed values so the serialized closure below keeps
      // their non-null types.
      const uploadBuffer = fileBuffer;
      const uploadMimeType = mimeType;
      const uploadUserId = userId;

      // Determine file extension
      const ext = MIME_TO_EXT[uploadMimeType] || 'jpg';
      const avatarFileName = `${userId}.${ext}`;
      let avatarUrl: string;

      try {
        // Write-first, clean-after: the new avatar must be saved before any
        // stale file is deleted, so a failed upload can never destroy the
        // avatar the user's stored avatarUrl still points at.
        avatarUrl = await serializePerUser(uploadUserId, async () => {
          if (useS3) {
            const s3Key = `avatars/${avatarFileName}`;
            // Variants first, then the base: a reader that can see the new
            // avatar can always see its sizes. Direct-from-bucket serving has
            // no resizer, so a size that does not exist is a 404.
            await writeImageVariants(
              uploadBuffer,
              s3Key,
              (key, body, contentType) =>
                uploadToS3('media', body, key, contentType, { cacheControl: MUTABLE_IMAGE_CACHE_CONTROL }),
              undefined,
              uploadMimeType,
            );
            await uploadToS3('media', uploadBuffer, s3Key, uploadMimeType);
            await deleteUserAvatarsFromS3(uploadUserId, ext);
          } else {
            const filePath = path.join(AVATARS_DIR, avatarFileName);
            await writeFile(filePath, uploadBuffer);
            await deleteExistingAvatars(uploadUserId, ext);
          }
          // Backend-relative URL instead of a direct S3 URL, so the backend
          // proxies the image and S3 public access isn't needed.
          return buildStaticAvatarUrl(avatarFileName, randomUUID());
        });
      } catch (saveErr) {
        logger.error('Failed to save avatar:', saveErr);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to save avatar' }));
        resolve();
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, avatarUrl }));
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
}

/**
 * Get the avatars directory path (for static file serving)
 */
export function getAvatarsDir(): string {
  return AVATARS_DIR;
}
