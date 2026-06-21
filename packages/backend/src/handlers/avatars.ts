import type { IncomingMessage, ServerResponse } from 'http';
import Busboy from 'busboy';
import path from 'path';
import { randomUUID } from 'crypto';
import { mkdir, writeFile, unlink, access } from 'fs/promises';
import { applyCorsHeaders } from './cors';
import { validateToken } from '../middleware/auth';
import { isS3Configured, uploadToS3, deleteUserAvatarsFromS3 } from '../storage/s3';
import { logger } from '../utils/logger';
import { buildStaticAvatarUrl } from '../lib/avatar-url';

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
 * Helper to delete existing avatars for a user (all extensions)
 */
async function deleteExistingAvatars(userId: string): Promise<void> {
  const extensions = ['jpg', 'png', 'gif', 'webp'];
  for (const ext of extensions) {
    const filePath = path.join(AVATARS_DIR, `${userId}.${ext}`);
    try {
      await access(filePath);
      await unlink(filePath);
    } catch {
      // File doesn't exist, ignore
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
  const useS3 = isS3Configured();
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

      // Validate file was uploaded
      if (!fileBuffer || !mimeType) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No file uploaded' }));
        resolve();
        return;
      }

      // Determine file extension
      const ext = MIME_TO_EXT[mimeType] || 'jpg';
      const avatarFileName = `${userId}.${ext}`;
      let avatarUrl: string;

      try {
        if (useS3) {
          // Delete existing avatars from S3
          await deleteUserAvatarsFromS3(userId);

          // Upload to S3
          const s3Key = `avatars/${avatarFileName}`;
          await uploadToS3(fileBuffer, s3Key, mimeType);
          // Return backend-relative URL instead of direct S3 URL
          // This allows the backend to proxy the image, avoiding S3 public access requirements
          avatarUrl = buildStaticAvatarUrl(avatarFileName, randomUUID());
        } else {
          // Delete any existing avatars for this user (all extensions) from local storage
          await deleteExistingAvatars(userId);

          // Save to local file system
          const filePath = path.join(AVATARS_DIR, avatarFileName);
          await writeFile(filePath, fileBuffer);
          avatarUrl = buildStaticAvatarUrl(avatarFileName, randomUUID());
        }
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
